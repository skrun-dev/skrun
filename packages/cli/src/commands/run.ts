import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { getRegistryUrl, getToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { RegistryClient } from "../utils/registry-client.js";

interface RunOptions {
  input?: string;
  file?: string;
  stdin?: boolean;
}

interface RunAgentRef {
  namespace: string;
  name: string;
  version?: string;
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
 * or `--stdin`. Returns the parsed object or exits with a clear error.
 * Security: per AC-27c, the CLI recommends `--file` or `--stdin` over `--input`
 * for secret-bearing payloads (the inline form ends up in shell history).
 */
export function readRunInput(opts: RunOptions): Record<string, unknown> {
  const sources = [opts.input, opts.file, opts.stdin].filter(Boolean).length;
  if (sources === 0) {
    format.error("Input required. Use one of -i '<json>', -f <file>, or --stdin.");
    process.exit(1);
  }
  if (sources > 1) {
    format.error("-i, -f, and --stdin are mutually exclusive — pick one.");
    process.exit(1);
  }

  let raw: string;
  if (opts.input) {
    raw = opts.input;
  } else if (opts.file) {
    try {
      raw = readFileSync(opts.file, "utf8");
    } catch (err) {
      format.error(
        `Failed to read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  } else {
    // --stdin: read all of fd 0 synchronously. Node 18+ supports readFileSync(0).
    try {
      raw = readFileSync(0, "utf8");
    } catch (err) {
      format.error(`Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    format.error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    format.error('Input must be a JSON object (e.g. {"key": "value"}).');
    process.exit(1);
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
    .action(async (agentArg: string, opts: RunOptions) => {
      const ref = parseRunAgentRef(agentArg);
      if (!ref) {
        format.error("Usage: skrun run <namespace>/<name>[@<version>]");
        process.exit(1);
      }

      const token = getToken();
      if (!token) {
        format.error("Not logged in. Run `skrun login` first.");
        process.exit(1);
      }

      const input = readRunInput(opts);

      const client = new RegistryClient(getRegistryUrl(), token);
      try {
        const result = await client.run(ref.namespace, ref.name, input, { version: ref.version });
        // Output goes to stdout for pipe-ability. Errors go to stderr (via format.error).
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (err) {
        // Security (AC-27c): print only error.code + error.message, never raw
        // response body. The throwing RegistryClient.run attaches { code, status }
        // to the Error so we can render the typed shape without exposing internals.
        const e = err as Error & { code?: string; status?: number };
        const code = e.code ?? "UNKNOWN";
        const message = e.message ?? "Unknown error";

        if (code === "AGENT_NOT_VERIFIED") {
          // AC-27 actionable error format — no stack, no JSON dump.
          format.error(
            `Agent ${ref.namespace}/${ref.name}${ref.version ? `@${ref.version}` : ""} is not verified.`,
          );
          format.error(
            `Ask an admin to verify it, or run \`skrun verify ${ref.namespace}/${ref.name}@<version>\` if you are admin.`,
          );
        } else {
          format.error(`${code}: ${message}`);
        }
        process.exit(1);
      }
    });
}
