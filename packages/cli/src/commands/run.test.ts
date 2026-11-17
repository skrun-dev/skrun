import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { KNOWN_PROVIDERS } from "./llm-key.js";
import { parseRunAgentRef, readRunInput, registerRunCommand, resolveCallerKeys } from "./run.js";

// The real file functions, with `readFileSync` watched: a case can give
// standard input (`readFileSync(0)`) bytes of its own, and the test process's
// own standard input is never read.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});
const { readFileSync: realReadFileSync } =
  await vi.importActual<typeof import("node:fs")>("node:fs");

// The command reads the sign-in file of a throwaway profile — a session for
// this server, as signing in writes it — and never the file of the machine
// running the tests.
const REGISTRY = "http://registry.test";

describe("parseRunAgentRef", () => {
  it("parses <namespace>/<name>@<version>", () => {
    expect(parseRunAgentRef("ops/agent@1.0.0")).toEqual({
      namespace: "ops",
      name: "agent",
      version: "1.0.0",
    });
  });

  it("parses <namespace>/<name> (no version → resolves to latest at run time)", () => {
    expect(parseRunAgentRef("ops/agent")).toEqual({
      namespace: "ops",
      name: "agent",
    });
  });

  it("rejects malformed input", () => {
    expect(parseRunAgentRef("")).toBeNull();
    expect(parseRunAgentRef("not-an-agent")).toBeNull();
    expect(parseRunAgentRef("Ops/Agent")).toBeNull();
    expect(parseRunAgentRef("ops/agent@")).toBeNull();
  });
});

describe("readRunInput (AC-27c — input flag handling)", () => {
  // A validation failure ends the command by throwing a CliExit; process.exit
  // is never called — replaced here by a throw of another kind, so a call would
  // fail the `toThrow(CliExit)` assertions instead of aborting the runner.
  const originalExit = process.exit;
  beforeEach(() => {
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code}) was called`);
    }) as never;
  });
  afterEach(() => {
    process.exit = originalExit;
  });

  it("-i '<inline-json>' parses JSON object", () => {
    const result = readRunInput({ input: '{"foo":"bar","count":3}' });
    expect(result).toEqual({ foo: "bar", count: 3 });
  });

  it("-f <filepath> reads and parses JSON from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-run-test-"));
    const filePath = join(dir, "input.json");
    writeFileSync(filePath, JSON.stringify({ from: "file" }));

    const result = readRunInput({ file: filePath });
    expect(result).toEqual({ from: "file" });

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects when no input source is provided", () => {
    expect(() => readRunInput({})).toThrow(CliExit);
  });

  it("rejects when both -i and -f are provided (mutually exclusive)", () => {
    expect(() => readRunInput({ input: "{}", file: "/tmp/x.json" })).toThrow(CliExit);
  });

  it("rejects when -i and --stdin are both provided", () => {
    expect(() => readRunInput({ input: "{}", stdin: true })).toThrow(CliExit);
  });

  it("rejects invalid JSON in -i", () => {
    expect(() => readRunInput({ input: "{not valid json" })).toThrow(CliExit);
  });

  it("rejects JSON arrays (input must be a JSON object)", () => {
    expect(() => readRunInput({ input: "[1,2,3]" })).toThrow(CliExit);
  });

  it("rejects JSON primitives (input must be a JSON object)", () => {
    expect(() => readRunInput({ input: '"just a string"' })).toThrow(CliExit);
    expect(() => readRunInput({ input: "42" })).toThrow(CliExit);
    expect(() => readRunInput({ input: "null" })).toThrow(CliExit);
  });

  it("rejects missing file path (clear error, no stack)", () => {
    expect(() => readRunInput({ file: "/this/path/does/not/exist.json" })).toThrow(CliExit);
  });

  // Smoke: --stdin reads from fd 0. We can't easily inject stdin in a unit
  // test, so we just verify the validation path (mutual exclusivity) — the
  // actual read is exercised by the live tests, when the binary is piped.
  it("rejects -f + --stdin combo", () => {
    expect(() => readRunInput({ file: "/tmp/x.json", stdin: true })).toThrow(CliExit);
  });
});

describe("readRunInput (AC-27c — security hygiene)", () => {
  it("does not write anything to stdout (silent on successful parse)", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    readRunInput({ input: '{"k":"v"}' });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe("readRunInput — a file or a pipe, whatever byte order mark it starts with", () => {
  // The input as Windows PowerShell 5.1 writes it: a line ending in CRLF, a
  // letter outside ASCII. `>` and Out-File write UTF-16 LE behind ff fe,
  // Set-Content -Encoding UTF8 a UTF-8 BOM, -Encoding BigEndianUnicode UTF-16
  // BE behind fe ff; without a mark, UTF-8 as it is.
  const TEXT = '{"query": "café"}\r\n';
  const ENTRIES: Array<[string, Buffer]> = [
    ["UTF-8, no byte order mark", Buffer.from(TEXT, "utf8")],
    [
      "UTF-8 behind its byte order mark",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, "utf8")]),
    ],
    [
      "UTF-16 LE behind ff fe",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, "utf16le")]),
    ],
    [
      "UTF-16 BE behind fe ff",
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(TEXT, "utf16le").swap16()]),
    ],
  ];
  const INVALID = Buffer.from('{"query": ', "utf8");

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-run-input-"));
  });
  afterEach(() => {
    vi.mocked(readFileSync).mockImplementation(realReadFileSync);
    rmSync(dir, { recursive: true, force: true });
  });

  /** A file holding `bytes`, as its path. */
  function fileHolding(bytes: Buffer): string {
    const path = join(dir, "input.json");
    writeFileSync(path, bytes);
    return path;
  }

  /** Standard input holding `bytes`, read as `readFileSync(0)` reads it — with an encoding, decoded by it. */
  function stdinHolding(bytes: Buffer): void {
    vi.mocked(readFileSync).mockImplementation(((path: unknown, options?: unknown) => {
      if (path !== 0) return (realReadFileSync as (...args: unknown[]) => unknown)(path, options);
      const encoding =
        typeof options === "string"
          ? options
          : (options as { encoding?: BufferEncoding } | undefined)?.encoding;
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    }) as typeof readFileSync);
  }

  /** What readRunInput makes of `opts`: the input it read, or what it printed and the code it ended with. */
  function outcome(
    opts: Parameters<typeof readRunInput>[0],
  ): { input: Record<string, unknown> } | { refused: string; exit: number } {
    const printed: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      printed.push(stripVTControlCharacters(parts.map(String).join(" ")));
    });
    try {
      return { input: readRunInput(opts) };
    } catch (err) {
      if (err instanceof CliExit) return { refused: printed.join("\n"), exit: err.code };
      throw err;
    } finally {
      error.mockRestore();
    }
  }

  it.each(ENTRIES)("-f reads a file in %s", (_form, bytes) => {
    expect(outcome({ file: fileHolding(bytes) })).toEqual({ input: { query: "café" } });
  });

  it.each(ENTRIES)("--stdin reads a pipe in %s", (_form, bytes) => {
    stdinHolding(bytes);
    expect(outcome({ stdin: true })).toEqual({ input: { query: "café" } });
  });

  it("-f refuses a file that is not JSON, as before", () => {
    expect(outcome({ file: fileHolding(INVALID) })).toEqual({
      refused: expect.stringMatching(/^✗ Input is not valid JSON: /),
      exit: 1,
    });
  });

  it("--stdin refuses a pipe that is not JSON, as before", () => {
    stdinHolding(INVALID);
    expect(outcome({ stdin: true })).toEqual({
      refused: expect.stringMatching(/^✗ Input is not valid JSON: /),
      exit: 1,
    });
  });
});

/** The registry's answer to a streamed POST /run: a run that completes. */
function streamedRun(): Response {
  const events = [
    { type: "run_start", run_id: "r1", timestamp: "t", agent: "dev/agent", agent_version: "1.0.0" },
    {
      type: "run_complete",
      run_id: "r1",
      timestamp: "t",
      output: { answer: "ok" },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: { estimated: 0 },
      duration_ms: 3,
      files: [],
      files_excluded: { too_large: 1 },
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface SkrunRunCall {
  /** What the command printed through the console and commander, colours included. */
  lines: string[];
  /** What it wrote to stdout directly: the result's JSON. */
  stdout: string;
  requests: Array<{ url: string; headers: Record<string, string> }>;
  /** The code the command ended with (its `CliExit`, or commander's); undefined when it succeeded. */
  exitCode: number | undefined;
  /** Whether anything called `process.exit()` — never, since commands end by throwing. */
  processExitCalled: boolean;
}

/**
 * Run `skrun run <args>` through the real command: fetch is stubbed (by
 * default, the stream of a run that completes), every output is captured, and
 * neither commander nor the command may end the test process.
 */
async function skrunRun(
  args: string[],
  respond: () => Response = streamedRun,
): Promise<SkrunRunCall> {
  const call: SkrunRunCall = {
    lines: [],
    stdout: "",
    requests: [],
    exitCode: undefined,
    processExitCalled: false,
  };
  const record = (...parts: unknown[]): void => {
    call.lines.push(parts.map(String).join(" "));
  };
  writeSession(useThrowawayProfile(), { address: REGISTRY, token: "test-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      call.requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return respond();
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    call.stdout += String(chunk);
    return true;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerRunCommand(program);
  try {
    await program.parseAsync(["run", ...args], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) call.exitCode = err.code;
    else if (err instanceof ExitCalled) {
      call.exitCode = err.code;
      call.processExitCalled = true;
    } else if (err instanceof CommanderError) call.exitCode = err.exitCode;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
    exit.mockRestore();
    vi.unstubAllGlobals();
  }
  return call;
}

describe("skrun run — a caller key, never on the command line", () => {
  const GOOGLE_KEY = "google-key-value-under-test";
  const OPENAI_KEY = "openai-key-value-under-test";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function printed(call: SkrunRunCall): string {
    return [...call.lines, call.stdout].join("\n");
  }

  it("sends the key read from --llm-key-env in X-LLM-API-Key, and never prints it", async () => {
    vi.stubEnv("SKRUN_TEST_GOOGLE_KEY", GOOGLE_KEY);

    const call = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      "--llm-key-env",
      "google=SKRUN_TEST_GOOGLE_KEY",
    ]);

    expect(call.exitCode).toBeUndefined();
    expect(call.requests).toHaveLength(1);
    expect(call.requests[0]?.headers["X-LLM-API-Key"]).toBe(JSON.stringify({ google: GOOGLE_KEY }));
    expect(call.requests[0]?.headers.Accept).toBe("text/event-stream");
    expect(JSON.parse(call.stdout)).toMatchObject({
      run_id: "r1",
      status: "completed",
      files_excluded: { too_large: 1 },
    });
    expect(printed(call)).not.toContain(GOOGLE_KEY);
  });

  it("sends one key per provider when --llm-key-env is repeated", async () => {
    vi.stubEnv("SKRUN_TEST_GOOGLE_KEY", GOOGLE_KEY);
    vi.stubEnv("SKRUN_TEST_OPENAI_KEY", OPENAI_KEY);

    const call = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      "--llm-key-env",
      "google=SKRUN_TEST_GOOGLE_KEY",
      "--llm-key-env",
      "openai=SKRUN_TEST_OPENAI_KEY",
    ]);

    expect(call.requests).toHaveLength(1);
    expect(JSON.parse(call.requests[0]?.headers["X-LLM-API-Key"] ?? "null")).toEqual({
      google: GOOGLE_KEY,
      openai: OPENAI_KEY,
    });
    expect(printed(call)).not.toContain(GOOGLE_KEY);
    expect(printed(call)).not.toContain(OPENAI_KEY);
  });

  it("refuses an empty variable before sending anything, with llm-key's message", async () => {
    vi.stubEnv("SKRUN_TEST_EMPTY_KEY", "  ");

    const call = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      "--llm-key-env",
      "google=SKRUN_TEST_EMPTY_KEY",
    ]);

    expect(call.exitCode).toBe(1);
    expect(call.processExitCalled).toBe(false);
    expect(call.requests).toHaveLength(0);
    expect(printed(call)).toContain("Environment variable SKRUN_TEST_EMPTY_KEY is empty or unset.");
  });

  it("refuses --llm-key-stdin with --stdin: standard input carries one thing", async () => {
    const call = await skrunRun(["dev/agent", "--stdin", "--llm-key-stdin", "google"]);

    expect(call.exitCode).toBe(1);
    expect(call.requests).toHaveLength(0);
    expect(printed(call)).toMatch(/--llm-key-stdin.*--stdin/);
  });

  it("sends no key header without a key option, as before", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"]);

    expect(call.requests).toHaveLength(1);
    expect(call.requests[0]?.headers).not.toHaveProperty("X-LLM-API-Key");
  });

  it("never echoes what may be a key typed where a name was expected", async () => {
    const lookalike = "gsk_0123456789abcdef";
    const byName = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      "--llm-key-env",
      `google=${lookalike}`,
    ]);
    const byProvider = await skrunRun(["dev/agent", "-i", "{}", "--llm-key-stdin", lookalike]);
    const noVariable = await skrunRun(["dev/agent", "-i", "{}", "--llm-key-env", lookalike]);

    for (const call of [byName, byProvider, noVariable]) {
      expect(call.exitCode).toBe(1);
      expect(call.processExitCalled).toBe(false);
      expect(call.requests).toHaveLength(0);
      expect(printed(call)).not.toContain(lookalike);
    }
  });
});

describe("skrun run — the endpoint a model key belongs to, in X-LLM-Base-URL", () => {
  const ANTHROPIC_KEY = "anthropic-key-value-under-test";
  /** What the command printed, colours left out. */
  const plain = (call: SkrunRunCall): string[] => call.lines.map(stripVTControlCharacters);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends --llm-base-url in X-LLM-Base-URL, a JSON object of provider to address, with no key option", async () => {
    const call = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      "--llm-base-url",
      "anthropic=https://x.example",
    ]);

    expect(call.exitCode).toBeUndefined();
    expect(call.requests).toHaveLength(1);
    expect(call.requests[0]?.headers["X-LLM-Base-URL"]).toBe(
      JSON.stringify({ anthropic: "https://x.example" }),
    );
    expect(call.requests[0]?.headers).not.toHaveProperty("X-LLM-API-Key");
  });

  it("sends one endpoint per provider when --llm-base-url is repeated, each address as it was typed, beside the keys", async () => {
    vi.stubEnv("SKRUN_TEST_ANTHROPIC_KEY", ANTHROPIC_KEY);

    const call = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      "--llm-base-url",
      "anthropic=https://x.example/v1/",
      "--llm-base-url",
      "OpenAI=HTTPS://Y.example:443/api",
      "--llm-key-env",
      "anthropic=SKRUN_TEST_ANTHROPIC_KEY",
    ]);

    expect(call.exitCode).toBeUndefined();
    expect(call.requests).toHaveLength(1);
    expect(JSON.parse(call.requests[0]?.headers["X-LLM-Base-URL"] ?? "null")).toEqual({
      anthropic: "https://x.example/v1/",
      openai: "HTTPS://Y.example:443/api",
    });
    expect(call.requests[0]?.headers["X-LLM-API-Key"]).toBe(
      JSON.stringify({ anthropic: ANTHROPIC_KEY }),
    );
  });

  it("sends no endpoint header without --llm-base-url, as before", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"]);

    expect(call.requests).toHaveLength(1);
    expect(call.requests[0]?.headers).not.toHaveProperty("X-LLM-Base-URL");
  });

  const ADDRESS_FORM =
    "--llm-base-url must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com";
  it.each([
    [
      "a provider with no address",
      ["anthropic"],
      "--llm-base-url expects <provider>=<URL>: a provider, and the address of the endpoint your key for it belongs to.",
    ],
    [
      "a provider this CLI does not know",
      ["foo=https://x"],
      `--llm-base-url names an unknown provider. Known providers: ${KNOWN_PROVIDERS}.`,
    ],
    ["an address that is not http:// or https://", ["anthropic=ftp://x"], ADDRESS_FORM],
    [
      "an address that carries a user name and a password",
      ["anthropic=https://u:p@x"],
      ADDRESS_FORM,
    ],
    [
      "the same pair twice",
      ["anthropic=https://x", "anthropic=https://x"],
      "A base URL for anthropic is given twice.",
    ],
  ])("refuses %s before sending anything, in one line that names the option and repeats no value", async (_case, pairs, message) => {
    const call = await skrunRun([
      "dev/agent",
      "-i",
      "{}",
      ...pairs.flatMap((pair) => ["--llm-base-url", pair]),
    ]);

    expect(plain(call)).toEqual([`✗ ${message}`]);
    expect(call.exitCode).toBe(1);
    expect(call.processExitCalled).toBe(false);
    expect(call.requests).toHaveLength(0);
  });
});

/** The registry's answer to a streamed POST /run: a run that starts, then fails. */
function streamedFailedRun(): Response {
  const events = [
    { type: "run_start", run_id: "r2", timestamp: "t", agent: "dev/agent", agent_version: "1.0.0" },
    {
      type: "run_error",
      run_id: "r2",
      timestamp: "t",
      error: { code: "OUTPUT_SCHEMA_INVALID", message: "Output validation failed" },
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe("skrun run — the exit code follows the result", () => {
  it("prints the failed result's JSON and ends with 1, by throwing", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"], streamedFailedRun);

    expect(JSON.parse(call.stdout)).toMatchObject({
      run_id: "r2",
      status: "failed",
      error: "Output validation failed",
    });
    expect({ exitCode: call.exitCode, processExitCalled: call.processExitCalled }).toEqual({
      exitCode: 1,
      processExitCalled: false,
    });
  });

  it("ends with 0 on a completed result, as before", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"]);

    expect(JSON.parse(call.stdout)).toMatchObject({ status: "completed" });
    expect(call.exitCode).toBeUndefined();
  });
});

describe("skrun run — a version that is not verified", () => {
  /** The registry's refusal of an unverified version, as the run route words it. */
  const notVerified = (): Response =>
    Response.json(
      {
        error: {
          code: "AGENT_NOT_VERIFIED",
          message: "Agent dev/agent version 1.2.3 must be verified by an admin before it can run.",
        },
      },
      { status: 403 },
    );

  it("names the pinned version in the command it suggests", async () => {
    const call = await skrunRun(["dev/agent@1.2.3", "-i", "{}"], notVerified);
    const printed = call.lines.join("\n");

    expect(call.exitCode).toBe(1);
    expect(printed).toContain("skrun verify dev/agent@1.2.3");
    expect(printed).not.toContain("<version>");
  });

  it("without a pin, prints the server's message, which names the version it resolved", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"], notVerified);
    const printed = call.lines.join("\n");

    expect(call.exitCode).toBe(1);
    expect(printed).toContain("version 1.2.3 must be verified");
    expect(printed).not.toContain("<version>");
  });
});

describe("skrun run — a failure to reach the server is printed as it is", () => {
  /** What the command printed, colours left out. */
  const plain = (call: SkrunRunCall): string[] => call.lines.map(stripVTControlCharacters);

  it("a server that cannot be reached: one line, that names it and the cause, no error code before it; exit 1", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"], () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });

    expect(plain(call)).toEqual([`✗ Could not reach ${REGISTRY} (ECONNREFUSED).`]);
    expect(call.exitCode).toBe(1);
  });

  it("a server that answers with a redirect: one line, that says it is not followed and names the target, no error code before it; exit 1", async () => {
    const call = await skrunRun(
      ["dev/agent", "-i", "{}"],
      () =>
        new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/run" } }),
    );

    expect(plain(call)).toEqual([
      `✗ The server at ${REGISTRY} answered with a redirect to https://elsewhere.example, which the CLI does not follow.`,
    ]);
    expect(call.exitCode).toBe(1);
  });

  it("an error the server sends keeps its code before its message, as before", async () => {
    const call = await skrunRun(["dev/agent", "-i", "{}"], () =>
      Response.json(
        { error: { code: "LLM_KEY_REQUIRED", message: "No model key can serve this run." } },
        { status: 400 },
      ),
    );

    expect(plain(call)).toEqual(["✗ LLM_KEY_REQUIRED: No model key can serve this run."]);
    expect(call.exitCode).toBe(1);
  });
});

describe("resolveCallerKeys (the key options → the X-LLM-API-Key map)", () => {
  const noStdin = async (): Promise<string> => {
    throw new Error("stdin must not be read");
  };

  it("returns undefined without a key option", async () => {
    expect(await resolveCallerKeys({}, {}, noStdin)).toBeUndefined();
  });

  it("reads --llm-key-stdin's key from standard input, trimmed", async () => {
    const keys = await resolveCallerKeys(
      { llmKeyStdin: "anthropic" },
      {},
      async () => "  the-key-from-stdin\n",
    );
    expect(keys).toEqual({ anthropic: "the-key-from-stdin" });
  });

  it("refuses an empty standard input", async () => {
    await expect(
      resolveCallerKeys({ llmKeyStdin: "anthropic" }, {}, async () => "\n"),
    ).rejects.toThrow(/No key on stdin for anthropic/);
  });

  it("refuses the same provider twice", async () => {
    await expect(
      resolveCallerKeys(
        { llmKeyEnv: ["google=A"], llmKeyStdin: "google" },
        { A: "one" },
        async () => "two",
      ),
    ).rejects.toThrow(/google.*twice/);
  });

  it("takes the provider in any letter case, as skrun llm-key does, and sends it lower-cased", async () => {
    // The run route compares the header's provider names to the letter.
    await expect(
      resolveCallerKeys(
        { llmKeyEnv: ["Google=A"], llmKeyStdin: "OpenAI" },
        { A: "one" },
        async () => "two",
      ),
    ).resolves.toEqual({ google: "one", openai: "two" });
  });

  it("refuses a provider this CLI does not know, naming the ones it does", async () => {
    await expect(
      resolveCallerKeys({ llmKeyEnv: ["gogle=A"] }, { A: "k" }, noStdin),
    ).rejects.toThrow(/anthropic.*google/);
  });
});
