import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { parsePolicy, registerLlmKeyCommand, resolveKeyInput, splitAgent } from "./llm-key.js";

// The commands read the sign-in file of a throwaway profile — a session for
// this server, as signing in writes it, or none for a case that is logged out —
// and never the file of the machine running the tests.
const REGISTRY = "http://registry.test";

describe("llm-key CLI helpers", () => {
  describe("splitAgent", () => {
    it("splits namespace/name", () => {
      expect(splitAgent("alice/bot")).toEqual({ ns: "alice", name: "bot" });
    });
    it("rejects a missing slash or an empty side", () => {
      expect(() => splitAgent("alice")).toThrow(/namespace.*name/);
      expect(() => splitAgent("/bot")).toThrow();
      expect(() => splitAgent("alice/")).toThrow();
    });
  });

  describe("parsePolicy", () => {
    it("accepts open and creator-only / creator_only (case-insensitive)", () => {
      expect(parsePolicy("open")).toBe("open");
      expect(parsePolicy("creator-only")).toBe("creator_only");
      expect(parsePolicy("creator_only")).toBe("creator_only");
      expect(parsePolicy("Creator-Only")).toBe("creator_only");
    });
    it("rejects an invalid policy", () => {
      expect(() => parsePolicy("nope")).toThrow(/Invalid policy/);
    });
  });

  describe("resolveKeyInput — never a positional arg (shell-history safety)", () => {
    it("reads + trims from --key-env", async () => {
      const key = await resolveKeyInput(
        { keyEnv: "MY_KEY" },
        { MY_KEY: "sk-secret  " },
        async () => "",
      );
      expect(key).toBe("sk-secret");
    });
    it("errors when --key-env is unset/empty", async () => {
      await expect(resolveKeyInput({ keyEnv: "MISSING" }, {}, async () => "")).rejects.toThrow(
        /empty or unset/,
      );
    });
    it("names only a conventional variable name in that error", async () => {
      await expect(resolveKeyInput({ keyEnv: "MISSING" }, {}, async () => "")).rejects.toThrow(
        "Environment variable MISSING is empty or unset.",
      );
      const unusual = resolveKeyInput({ keyEnv: "sk-typed-here-by-mistake" }, {}, async () => "");
      await expect(unusual).rejects.toThrow(
        "The environment variable given to --key-env is empty or unset.",
      );
    });
    it("falls back to (trimmed) stdin", async () => {
      const key = await resolveKeyInput({}, {}, async () => "sk-from-stdin\n");
      expect(key).toBe("sk-from-stdin");
    });
    it("errors when stdin is empty and no --key-env", async () => {
      await expect(resolveKeyInput({}, {}, async () => "")).rejects.toThrow(/No key provided/);
    });
  });
});

/**
 * Run `skrun <args>` through the real `llm-key` command tree: fetch answers
 * with `respond`, the output is captured, and neither commander nor the
 * command may end the test process.
 */
async function runLlmKey(
  args: string[],
  respond: () => Response,
  { signedIn = true }: { signedIn?: boolean } = {},
): Promise<{ lines: string[]; requests: number; exitCode?: number; processExitCalled: boolean }> {
  const run = { lines: [] as string[], requests: 0, exitCode: undefined as number | undefined };
  let processExitCalled = false;
  const record = (...parts: unknown[]): void => {
    run.lines.push(parts.map(String).join(" "));
  };
  const profile = useThrowawayProfile();
  if (signedIn) writeSession(profile, { address: REGISTRY, token: "test-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      run.requests++;
      return respond();
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    processExitCalled = true;
    run.exitCode = Number(code ?? 0);
    return undefined as never;
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerLlmKeyCommand(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) run.exitCode = err.code;
    else if (err instanceof CommanderError) run.exitCode = err.exitCode;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
    vi.unstubAllGlobals();
  }
  return { ...run, processExitCalled };
}

describe("skrun llm-key — a failure ends the command once, not the process", () => {
  const listed = (): Response => Response.json({ policy: "open", keys: [] });

  it.each([
    [["llm-key", "list", "--agent", "dev/agent"]],
    [["llm-key", "rm", "google", "--agent", "dev/agent"]],
    [["llm-key", "policy", "open", "--agent", "dev/agent"]],
    [["llm-key", "set", "google", "--agent", "dev/agent", "--key-env", "SKRUN_TEST_LLM_KEY"]],
  ])("logged out, %j says so once and ends with 1", async (args) => {
    vi.stubEnv("SKRUN_TEST_LLM_KEY", "key-value-under-test");
    try {
      const run = await runLlmKey(args, listed, { signedIn: false });

      expect(run.processExitCalled).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.requests).toBe(0);
      // One line: the command's catch hands the exit on, it does not report it.
      expect(run.lines).toHaveLength(1);
      expect(run.lines[0]).toContain("Not logged in");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ends with 1 when the registry refuses, by throwing", async () => {
    const run = await runLlmKey(["llm-key", "list", "--agent", "dev/agent"], () =>
      Response.json({ error: { code: "INTERNAL" } }, { status: 500 }),
    );

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.lines.join("\n")).toContain("List LLM keys failed (500)");
  });
});

describe("skrun llm-key — no message repeats a value that may be a key", () => {
  // A witness shaped like a real key (never a real one). An author who types
  // their key where a variable name, a provider or a policy is expected must
  // not see it echoed on a terminal or in a CI log.
  const WITNESS = "gsk_witnessKey0f1e2d3c4b5a69788796WITNESS";
  // The registry quotes an unknown provider in its refusal
  // (INVALID_LLM_PROVIDER): the simulated one answers the same way.
  const refusesProvider = (): Response =>
    Response.json(
      {
        error: {
          code: "INVALID_LLM_PROVIDER",
          message: `Unsupported LLM provider '${WITNESS}'. Supported: anthropic, google, groq, meta, mistral, openai, xai.`,
        },
      },
      { status: 400 },
    );
  // The registry answers 204 to a removal, whatever the provider.
  const removed = (): Response => new Response(null, { status: 204 });

  it.each([
    ["a key given to --key-env", ["set", "google", "--key-env", WITNESS], removed],
    [
      "a key in place of the provider of set",
      ["set", WITNESS, "--key-env", "SKRUN_TEST_LLM_KEY"],
      refusesProvider,
    ],
    ["a key in place of the provider of rm", ["rm", WITNESS], removed],
    ["a key in place of the policy", ["policy", WITNESS], removed],
  ])("%s is refused, and never printed", async (_case, args, respond) => {
    vi.stubEnv("SKRUN_TEST_LLM_KEY", "key-value-under-test");
    try {
      const run = await runLlmKey(["llm-key", ...args, "--agent", "dev/agent"], respond);

      expect(run.lines.join("\n")).not.toContain(WITNESS);
      expect(run.exitCode).toBe(1);
      expect(run.requests).toBe(0);
      expect(run.processExitCalled).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still names a variable written the conventional way", async () => {
    const run = await runLlmKey(
      ["llm-key", "set", "google", "--agent", "dev/agent", "--key-env", "SKRUN_TEST_ABSENT_VAR"],
      removed,
    );

    expect(run.exitCode).toBe(1);
    expect(run.lines.join("\n")).toContain(
      "Environment variable SKRUN_TEST_ABSENT_VAR is empty or unset.",
    );
  });

  it("still sends a known provider, in any letter case", async () => {
    vi.stubEnv("SKRUN_TEST_LLM_KEY", "key-value-under-test");
    try {
      const run = await runLlmKey(
        ["llm-key", "set", "Google", "--agent", "dev/agent", "--key-env", "SKRUN_TEST_LLM_KEY"],
        () => Response.json({ provider: "google", last4: "test" }),
      );

      expect(run.exitCode).toBeUndefined();
      expect(run.requests).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
