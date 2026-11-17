import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { registerPushCommand } from "./push.js";

// The command reads the sign-in file of a throwaway profile — a session for
// this server, with its namespace, as signing in writes it — and never the
// file of the machine running the tests.
const REGISTRY = "http://registry.test";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "skrun-push-test-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function writeIn(relativePath: string, content: string): void {
  const full = join(agentDir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A valid agent that draws two warnings: a retired field in its agent.yaml,
 * and a script importing a package with no manifest to resolve it. Its bundle
 * is already built: push sends it as it is.
 */
function writeWarningAgent(): void {
  writeIn("SKILL.md", "---\nname: warn-fixture\ndescription: Draws two warnings.\n---\n\n# W\n");
  writeIn(
    "agent.yaml",
    [
      "name: warn-fixture",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      "  sandbox: strict",
      "",
    ].join("\n"),
  );
  writeIn("scripts/fetch.py", "import requests\n");
  writeIn("warn-fixture-1.0.0.agent", "bundle-bytes");
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface PushCall {
  printed: string;
  /** The code the command ended with (its `CliExit`, or commander's); undefined when it succeeded. */
  exitCode: number | undefined;
  /** Whether anything called `process.exit()` — never, since commands end by throwing. */
  processExitCalled: boolean;
  requests: Array<{ url: string; method: string }>;
}

/**
 * Run `skrun push <args>` through the real command, from `agentDir`: fetch
 * answers with `respond`, every output is captured, and neither commander nor
 * the command may end the test process.
 */
async function skrunPush(
  args: string[],
  respond: (url: string, method: string) => Response,
): Promise<PushCall> {
  const call: PushCall = {
    printed: "",
    exitCode: undefined,
    processExitCalled: false,
    requests: [],
  };
  const lines: string[] = [];
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(" "));
  };
  writeSession(useThrowawayProfile(), { address: REGISTRY, token: "test-token", username: "dev" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      call.requests.push({ url, method });
      return respond(url, method);
    }),
  );
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(agentDir);
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerPushCommand(program);
  try {
    await program.parseAsync(["push", ...args], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) call.exitCode = err.code;
    else if (err instanceof ExitCalled) {
      call.exitCode = err.code;
      call.processExitCalled = true;
    } else if (err instanceof CommanderError) call.exitCode = err.exitCode;
    else throw err;
  } finally {
    cwd.mockRestore();
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  call.printed = lines.join("\n");
  return call;
}

/** The registry's answer to a push: the agent's metadata, one version. */
function pushed(): Response {
  return Response.json({ name: "warn-fixture", versions: ["1.0.0"] });
}

describe("skrun push — validation warnings are printed", () => {
  it("prints both warnings, by code, and still pushes", async () => {
    writeWarningAgent();

    const call = await skrunPush([], () => pushed());

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).toContain("RETIRED_FIELD");
    expect(call.printed).toContain("environment.sandbox");
    expect(call.printed).toContain("SCRIPTS_NO_MANIFEST");
    expect(call.requests.some((r) => r.method === "POST" && r.url.includes("/push"))).toBe(true);
    expect(call.printed).toContain("Pushed dev/warn-fixture@1.0.0");
  });
});

/** The registry: the push succeeds, and `GET /api/me` answers with `me()`. */
function registry(me: () => Response): (url: string, method: string) => Response {
  return (url, method) => {
    if (method === "POST" && url.includes("/push")) return pushed();
    if (method === "GET" && url.endsWith("/api/me")) return me();
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
}

/** The profile `GET /api/me` returns, with the server's verification policy. */
function me(verification_policy: string, role: string): Response {
  return Response.json({ id: "u1", username: "dev", namespace: "dev", role, verification_policy });
}

/** What the CLI said after a first push before it read the policy — the admin step, always. */
const ADMIN_STEP_ALWAYS =
  "New agents start unverified. Run `skrun verify dev/warn-fixture@1.0.0` (admin only) before it can be called.";

describe("skrun push — the note after a push follows the server's verification policy", () => {
  it("under owner: the version can be called now, and verifying it is optional", async () => {
    writeWarningAgent();

    const call = await skrunPush(
      [],
      registry(() => me("owner", "user")),
    );

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).not.toContain("(admin only)");
    expect(call.printed).not.toContain("before it can be called");
    expect(call.printed).toContain("dev/warn-fixture@1.0.0 can be called now");
    expect(call.printed).toContain("optional");
    expect(call.printed).toContain("skrun verify dev/warn-fixture@1.0.0");
  });

  it("under disabled: the version can be called now, and the server does not use verification", async () => {
    writeWarningAgent();

    const call = await skrunPush(
      [],
      registry(() => me("disabled", "user")),
    );

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).not.toContain("(admin only)");
    expect(call.printed).not.toContain("before it can be called");
    expect(call.printed).toContain("dev/warn-fixture@1.0.0 can be called now");
    expect(call.printed).toContain("does not gate runs on verification");
  });

  it("under admin, for an admin: verification is required, and the caller can run it", async () => {
    writeWarningAgent();

    const call = await skrunPush(
      [],
      registry(() => me("admin", "admin")),
    );

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).not.toContain("(admin only)");
    expect(call.printed).toContain(
      "New agents start unverified. Run `skrun verify dev/warn-fixture@1.0.0` before it can be called — you are an admin on this server.",
    );
  });

  it("under admin, for anyone else: an admin of the server must verify it", async () => {
    writeWarningAgent();

    const call = await skrunPush(
      [],
      registry(() => me("admin", "user")),
    );

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).not.toContain("(admin only)");
    expect(call.printed).toContain(
      "New agents start unverified. An admin of this server must run `skrun verify dev/warn-fixture@1.0.0` before it can be called.",
    );
  });

  it.each([
    [
      "a profile without the policy (an older server)",
      () => Response.json({ id: "u1", role: "user" }),
    ],
    ["a refusal", () => Response.json({ error: { code: "INTERNAL" } }, { status: 500 })],
    [
      "a network failure",
      (): Response => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("says what it said before when the server tells nothing of its policy: %s", async (_, answer) => {
    writeWarningAgent();

    const call = await skrunPush([], registry(answer));

    expect(call.exitCode).toBeUndefined();
    expect(call.printed).toContain("Pushed dev/warn-fixture@1.0.0");
    expect(call.requests.some((r) => r.method === "GET" && r.url.endsWith("/api/me"))).toBe(true);
    expect(call.printed).toContain(ADMIN_STEP_ALWAYS);
  });

  it("names the step for a later version, and the pinned versions it leaves alone", async () => {
    writeWarningAgent();
    const later = (url: string, method: string): Response =>
      method === "POST"
        ? Response.json({ name: "warn-fixture", versions: ["0.9.0", "1.0.0"] })
        : registry(() => me("admin", "user"))(url, method);

    const call = await skrunPush([], later);

    expect(call.printed).toContain(
      "Version 1.0.0 is not yet verified. An admin of this server must run `skrun verify dev/warn-fixture@1.0.0` before it can be called.",
    );
    expect(call.printed).toContain(
      "Previously verified versions of this agent remain runnable for callers pinning them.",
    );
  });
});

describe("skrun push — a refused push ends the command, not the process", () => {
  it("ends with 1 after a 409, by throwing, and never calls process.exit", async () => {
    writeWarningAgent();
    const refused = (): Response =>
      Response.json(
        { error: { code: "VERSION_EXISTS", message: "Version 1.0.0 already exists" } },
        { status: 409 },
      );

    const call = await skrunPush([], refused);

    expect(call.processExitCalled).toBe(false);
    expect(call.exitCode).toBe(1);
    expect(call.printed).toContain("Push failed (409): Version 1.0.0 already exists");
  });

  it("ends with 1 on an invalid note, before any request", async () => {
    writeWarningAgent();

    const call = await skrunPush(["-m", "x".repeat(501)], () => pushed());

    expect(call.processExitCalled).toBe(false);
    expect(call.exitCode).toBe(1);
    expect(call.requests).toEqual([]);
  });
});
