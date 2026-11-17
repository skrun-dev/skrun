import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { normalizeRegistryUrl, RedirectRefused, Unreachable } from "../utils/auth.js";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";
import {
  CONVENTIONAL_VARIABLE_NAME,
  KNOWN_PROVIDERS,
  knownProvider,
  resolveKeyInput,
} from "./llm-key.js";

interface RunOptions {
  input?: string;
  file?: string;
  stdin?: boolean;
  /** `<provider>=<VARIABLE>`, repeatable: the key is read from that variable. */
  llmKeyEnv?: string[];
  /** `<provider>`: the key is read from standard input. */
  llmKeyStdin?: string;
  /** `<provider>=<URL>`, repeatable: the endpoint the key for that provider belongs to. */
  llmBaseUrl?: string[];
}

const STDIN_TWICE =
  "--llm-key-stdin and --stdin both read standard input — pass the input with -i or -f instead.";
/** An environment variable's name, as a POSIX shell accepts it. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The provider, lower-cased, by the rule of `skrun llm-key` (any letter case). */
function checkProvider(provider: string, option: string): string {
  const known = knownProvider(provider);
  if (!known) {
    // The value is not repeated: it may be a key typed in the wrong place.
    throw new Error(`${option} names an unknown provider. Known providers: ${KNOWN_PROVIDERS}.`);
  }
  return known;
}

/**
 * Resolve the caller's model keys from `--llm-key-env <provider>=<VARIABLE>`
 * (repeatable) and `--llm-key-stdin <provider>` — never from an argument, so a
 * key never reaches the shell history: the rule of `skrun llm-key`, whose
 * reader this reuses. Returns undefined when no key option is given. No error
 * message repeats a value that may be a key. Pure (tested).
 */
export async function resolveCallerKeys(
  opts: Pick<RunOptions, "llmKeyEnv" | "llmKeyStdin" | "stdin">,
  env: NodeJS.ProcessEnv,
  readStdin: () => Promise<string>,
): Promise<Record<string, string> | undefined> {
  const pairs = opts.llmKeyEnv ?? [];
  if (pairs.length === 0 && opts.llmKeyStdin === undefined) return undefined;
  if (opts.llmKeyStdin !== undefined && opts.stdin) throw new Error(STDIN_TWICE);

  const keys: Record<string, string> = {};
  const add = (provider: string, key: string): void => {
    if (provider in keys) throw new Error(`A key for ${provider} is given twice.`);
    keys[provider] = key;
  };

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const given = eq === -1 ? "" : pair.slice(0, eq);
    const variable = eq === -1 ? "" : pair.slice(eq + 1);
    if (!given || !VARIABLE_NAME.test(variable)) {
      throw new Error(
        "--llm-key-env expects <provider>=<VARIABLE>: the name of the environment variable that holds the key, never the key itself.",
      );
    }
    const provider = checkProvider(given, "--llm-key-env");
    if (!CONVENTIONAL_VARIABLE_NAME.test(variable) && !env[variable]?.trim()) {
      // An unusual name may be a key typed in the wrong place: not repeated.
      throw new Error(`The environment variable given for ${provider} is empty or unset.`);
    }
    add(provider, await resolveKeyInput({ keyEnv: variable }, env, readStdin));
  }

  if (opts.llmKeyStdin !== undefined) {
    const provider = checkProvider(opts.llmKeyStdin, "--llm-key-stdin");
    if (provider in keys) throw new Error(`A key for ${provider} is given twice.`);
    const key = (await readStdin()).trim();
    if (!key) {
      throw new Error(
        `No key on stdin for ${provider}. Pipe it in, or use --llm-key-env ${provider}=<VARIABLE>.`,
      );
    }
    add(provider, key);
  }
  return keys;
}

/**
 * The endpoints the caller's model keys belong to, from `--llm-base-url
 * <provider>=<URL>` (repeatable): the provider by the rule of the key options
 * (any letter case, sent lower-cased), the address checked as a server address
 * is — absolute `http://` or `https://`, no user name, password, query or
 * fragment — and sent as it was typed: the server compares origins. Returns
 * undefined when the option is not given. No error message repeats a value.
 */
function resolveBaseUrls(pairs: string[] | undefined): Record<string, string> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const urls: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const given = eq === -1 ? "" : pair.slice(0, eq);
    const url = eq === -1 ? "" : pair.slice(eq + 1);
    if (!given || !url) {
      throw new Error(
        "--llm-base-url expects <provider>=<URL>: a provider, and the address of the endpoint your key for it belongs to.",
      );
    }
    const provider = checkProvider(given, "--llm-base-url");
    // Checked, not rewritten: the address leaves as it was typed.
    normalizeRegistryUrl(url, "--llm-base-url");
    if (provider in urls) throw new Error(`A base URL for ${provider} is given twice.`);
    urls[provider] = url;
  }
  return urls;
}

/** Collect a repeatable option's values. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

interface RunAgentRef {
  namespace: string;
  name: string;
  version?: string;
}

/**
 * The text of an input read as bytes, decoded by its byte order mark — UTF-8
 * behind `ef bb bf`, UTF-16 LE behind `ff fe` (what Windows PowerShell's `>`
 * writes), UTF-16 BE behind `fe ff` — and UTF-8 without one. The decoder drops
 * the mark it recognizes.
 */
function decodeInput(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
}

const SEGMENT = /[a-z0-9-]+/;
const RUN_REF_REGEX = new RegExp(`^(${SEGMENT.source})/(${SEGMENT.source})(?:@(.+))?$`);

export function parseRunAgentRef(arg: string): RunAgentRef | null {
  const match = arg.match(RUN_REF_REGEX);
  if (!match) return null;
  const [, namespace, name, version] = match;
  if (!namespace || !name) return null;
  return version ? { namespace, name, version } : { namespace, name };
}

/**
 * Read the input JSON from exactly one of: `--input '<json>'`, `--file <path>`,
 * or `--stdin`. Returns the parsed object, or prints a clear error and ends the
 * command (`exitWith`).
 * Security: per AC-27c, the CLI recommends `--file` or `--stdin` over `--input`
 * for secret-bearing payloads (the inline form ends up in shell history).
 */
export function readRunInput(opts: RunOptions): Record<string, unknown> {
  const sources = [opts.input, opts.file, opts.stdin].filter(Boolean).length;
  if (sources === 0) {
    format.error("Input required. Use one of -i '<json>', -f <file>, or --stdin.");
    exitWith(1);
  }
  if (sources > 1) {
    format.error("-i, -f, and --stdin are mutually exclusive — pick one.");
    exitWith(1);
  }

  let raw: string;
  if (opts.input) {
    raw = opts.input;
  } else if (opts.file) {
    try {
      raw = decodeInput(readFileSync(opts.file));
    } catch (err) {
      format.error(
        `Failed to read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      exitWith(1);
    }
  } else {
    // --stdin: read all of fd 0 synchronously. Node 18+ supports readFileSync(0).
    try {
      raw = decodeInput(readFileSync(0));
    } catch (err) {
      format.error(`Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`);
      exitWith(1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    format.error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    exitWith(1);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    format.error('Input must be a JSON object (e.g. {"key": "value"}).');
    exitWith(1);
  }

  return parsed as Record<string, unknown>;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <agent>")
    .description(
      "Run an agent. Usage: skrun run <namespace>/<name>[@<version>] -i '<json>' | -f <file> | --stdin",
    )
    .option("-i, --input <json>", "Inline JSON input — beware shell history for secrets")
    .option("-f, --file <path>", "Read JSON input from a file (recommended for secrets)")
    .option("--stdin", "Read JSON input from stdin pipe")
    .option(
      "--llm-key-env <provider=VARIABLE>",
      "Send your model key for <provider>, read from the environment variable VARIABLE (repeatable)",
      collect,
    )
    .option(
      "--llm-key-stdin <provider>",
      "Send your model key for <provider>, read from stdin (not with --stdin)",
    )
    .option(
      "--llm-base-url <provider=URL>",
      "The endpoint your key for <provider> belongs to, sent in X-LLM-Base-URL (repeatable)",
      collect,
    )
    .action(async (agentArg: string, opts: RunOptions) => {
      const ref = parseRunAgentRef(agentArg);
      if (!ref) {
        format.error("Usage: skrun run <namespace>/<name>[@<version>]");
        exitWith(1);
      }

      // The server this run goes to, and its session
      const client = connect();

      // Standard input carries one thing: refused before anything is read from it.
      if (opts.llmKeyStdin !== undefined && opts.stdin) {
        format.error(STDIN_TWICE);
        exitWith(1);
      }

      // The endpoints the keys belong to: refused before anything is read or sent.
      let llmBaseUrls: Record<string, string> | undefined;
      try {
        llmBaseUrls = resolveBaseUrls(opts.llmBaseUrl);
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }

      const input = readRunInput(opts);

      let llmKeys: Record<string, string> | undefined;
      try {
        llmKeys = await resolveCallerKeys(opts, process.env, async () => readFileSync(0, "utf8"));
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }

      let failed = false;
      try {
        const result = await client.run(ref.namespace, ref.name, input, {
          version: ref.version,
          llmKeys,
          llmBaseUrls,
        });
        // Output goes to stdout for pipe-ability. Errors go to stderr (via format.error).
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        // A run that started and failed is printed whole, like any result, and
        // the command still fails: a script sees it in the exit code.
        failed = result.status === "failed";
      } catch (err) {
        // No answer, or a redirect not followed: the message names the server
        // and says what happened — printed as it is, with no code before it.
        if (err instanceof Unreachable || err instanceof RedirectRefused) {
          format.error(err.message);
          exitWith(1);
        }
        // Security (AC-27c): print only error.code + error.message, never raw
        // response body. The throwing RegistryClient.run attaches { code, status }
        // to the Error so we can render the typed shape without exposing internals.
        const e = err as Error & { code?: string; status?: number };
        const code = e.code ?? "UNKNOWN";
        const message = e.message ?? "Unknown error";

        if (code === "AGENT_NOT_VERIFIED" && ref.version) {
          // AC-27 actionable error format — no stack, no JSON dump. The command
          // names the version the caller pinned.
          const pinned = `${ref.namespace}/${ref.name}@${ref.version}`;
          format.error(`Agent ${pinned} is not verified.`);
          format.error(
            `Ask an admin to verify it, or run \`skrun verify ${pinned}\` if you are admin.`,
          );
        } else if (code === "AGENT_NOT_VERIFIED") {
          // No pin: the server resolved the version, and its message names it.
          format.error(message);
          format.error(
            "Ask an admin to verify that version, or verify it with `skrun verify` if you are admin.",
          );
        } else {
          format.error(`${code}: ${message}`);
        }
        exitWith(1);
      }
      if (failed) exitWith(1);
    });
}
