import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { useThrowawayProfile, writeSession } from "../test-profile.shared.js";
import { CliExit } from "../utils/exit.js";
import { buildCreateKeyInput, registerKeysCommand } from "./keys.js";

// The commands read the sign-in file of a throwaway profile — a session for
// this server, as signing in writes it, or none for a case that is logged out —
// and never the file of the machine running the tests.
const REGISTRY = "http://registry.test";

describe("buildCreateKeyInput (skrun keys create flags → POST /api/keys payload)", () => {
  it("VT-26: default is an account-wide full key (no scopes)", () => {
    expect(buildCreateKeyInput({ name: "ci" })).toEqual({
      name: "ci",
      scope_kind: "account",
      agents: [],
      scopes: undefined,
    });
  });

  it("VT-26: --agent scopes the key to that one agent", () => {
    expect(buildCreateKeyInput({ name: "client-acme", agent: "dev/my-agent" })).toEqual({
      name: "client-acme",
      scope_kind: "agents",
      agents: ["dev/my-agent"],
      scopes: undefined,
    });
  });

  it("VT-26: --run-only narrows the operation scopes to agent:run", () => {
    expect(buildCreateKeyInput({ name: "runner", runOnly: true })).toEqual({
      name: "runner",
      scope_kind: "account",
      agents: [],
      scopes: ["agent:run"],
    });
  });

  it("VT-26: --agent + --run-only = a delegated run-only client key", () => {
    expect(
      buildCreateKeyInput({ name: "client-acme", agent: "dev/my-agent", runOnly: true }),
    ).toEqual({
      name: "client-acme",
      scope_kind: "agents",
      agents: ["dev/my-agent"],
      scopes: ["agent:run"],
    });
  });
});

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

describe("buildCreateKeyInput — --expires-in <days>", () => {
  it("turns --expires-in 30 into an expires_at thirty days from now", () => {
    expect(buildCreateKeyInput({ name: "ci", expiresIn: "30" }, NOW).expires_at).toBe(
      new Date(NOW + 30 * DAY_MS).toISOString(),
    );
  });

  it("accepts the upper bound, 36500 days", () => {
    expect(buildCreateKeyInput({ name: "ci", expiresIn: "36500" }, NOW).expires_at).toBe(
      new Date(NOW + 36_500 * DAY_MS).toISOString(),
    );
  });

  it.each([
    "0",
    "-1",
    "abc",
    "36501",
    "1e3",
  ])("refuses --expires-in %s with a message naming the option and its bound", (value) => {
    expect(() => buildCreateKeyInput({ name: "ci", expiresIn: value }, NOW)).toThrow(
      /--expires-in .*36500/,
    );
  });
});

interface SentRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

interface KeysRun {
  /** Everything the command printed, one entry per call, colours included. */
  lines: string[];
  requests: SentRequest[];
  /** The code the command ended with (its `CliExit`, or commander's); undefined when it succeeded. */
  exitCode: number | undefined;
  /** Whether anything called `process.exit()` — never, since commands end by throwing. */
  processExitCalled: boolean;
}

const KEY_ID = "3f5b8c1e-0d2a-4c6e-9b7a-1e2f3a4b5c6d";

/** The registry's 201 to POST /api/keys, echoing the expiry it was sent. */
function minted(request: SentRequest): Response {
  return Response.json(
    {
      id: KEY_ID,
      key: "skrun_sk_0123456789abcdef",
      name: request.body?.name,
      key_prefix: "skrun_sk_0123",
      scopes: ["agent:run"],
      scope_kind: "account",
      agents: [],
      expires_at: request.body?.expires_at ?? null,
      created_at: "2026-09-28T12:00:00.000Z",
    },
    { status: 201 },
  );
}

/**
 * Run `skrun <args>` through the real `keys` command tree: fetch is stubbed,
 * the output is captured, and neither commander nor the command may end the
 * test process.
 */
async function runKeys(
  args: string[],
  respond: (request: SentRequest) => Response = minted,
  { signedIn = true }: { signedIn?: boolean } = {},
): Promise<KeysRun> {
  const run: KeysRun = { lines: [], requests: [], exitCode: undefined, processExitCalled: false };
  const record = (...parts: unknown[]): void => {
    run.lines.push(parts.map(String).join(" "));
  };
  const profile = useThrowawayProfile();
  if (signedIn) writeSession(profile, { address: REGISTRY, token: "test-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request: SentRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      run.requests.push(request);
      return respond(request);
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    run.exitCode = Number(code ?? 0);
    run.processExitCalled = true;
    return undefined as never;
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerKeysCommand(program);
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
  return run;
}

describe("skrun keys create — expiry", () => {
  it("sends no expires_at without --expires-in, and says the key never expires", async () => {
    const run = await runKeys(["keys", "create", "--name", "ci"]);
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.body).not.toHaveProperty("expires_at");
    expect(run.lines.join("\n")).toMatch(/never expires.*--expires-in <days>/);
  });

  it("sends an expires_at thirty days ahead with --expires-in 30", async () => {
    const before = Date.now();
    const run = await runKeys(["keys", "create", "--name", "ci", "--expires-in", "30"]);
    const after = Date.now();
    const body = run.requests[0]?.body ?? {};
    expect(body).toHaveProperty("expires_at");
    const sent = Date.parse(String(body.expires_at));
    expect(sent).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(sent).toBeLessThanOrEqual(after + 30 * DAY_MS);
  });

  it("refuses an out-of-range --expires-in before sending any request", async () => {
    const run = await runKeys(["keys", "create", "--name", "ci", "--expires-in", "0"]);
    expect(run.lines.join("\n")).toMatch(/--expires-in .*36500/);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toHaveLength(0);
  });
});

const DATED_ID = "0b8e6f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const OPEN_ID = "7d9e1f3a-5b6c-4d8e-9f0a-1b2c3d4e5f6a";

/** The registry's answer to GET /api/keys: one key with an expiry, one without. */
function listed(): Response {
  const common = {
    scopes: ["agent:run"],
    last_used_at: null,
    created_at: "2026-09-28T12:00:00.000Z",
  };
  return Response.json([
    {
      ...common,
      id: DATED_ID,
      name: "ci",
      key_prefix: "skrun_sk_aaaa",
      scope_kind: "account",
      expires_at: "2026-10-28T12:00:00.000Z",
    },
    {
      ...common,
      id: OPEN_ID,
      name: "client-acme",
      key_prefix: "skrun_sk_bbbb",
      scope_kind: "agents",
      expires_at: null,
    },
  ]);
}

describe("skrun keys create and list — each key's id and expiry", () => {
  it("prints the id and the expiry of a key minted with --expires-in", async () => {
    const run = await runKeys(["keys", "create", "--name", "ci", "--expires-in", "30"]);
    const expiresAt = String(run.requests[0]?.body?.expires_at);
    const printed = run.lines.join("\n");
    expect({ id: printed.includes(KEY_ID), expiry: printed.includes(expiresAt) }).toEqual({
      id: true,
      expiry: true,
    });
  });

  it("prints the id of a key minted without an expiry, and that it never expires", async () => {
    const run = await runKeys(["keys", "create", "--name", "ci"]);
    const printed = run.lines.join("\n");
    expect({ id: printed.includes(KEY_ID), never: /never expires/.test(printed) }).toEqual({
      id: true,
      never: true,
    });
  });

  it("lists each key with its id, then its expiry or never", async () => {
    const run = await runKeys(["keys", "list"], listed);
    const dated = run.lines.find((line) => line.includes("skrun_sk_aaaa")) ?? "";
    const open = run.lines.find((line) => line.includes("skrun_sk_bbbb")) ?? "";
    expect(dated).toMatch(/0b8e6f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b.*2026-10-28T12:00:00\.000Z/);
    expect(open).toMatch(/7d9e1f3a-5b6c-4d8e-9f0a-1b2c3d4e5f6a.*never/);
  });

  it("revokes a key by the id that list prints", async () => {
    const listing = await runKeys(["keys", "list"], listed);
    const line = listing.lines.find((l) => l.includes("skrun_sk_bbbb")) ?? "";
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(line)?.[0];
    const run = await runKeys(
      ["keys", "revoke", String(id)],
      () => new Response(null, { status: 204 }),
    );
    expect(run.requests).toEqual([
      { url: `http://registry.test/api/keys/${OPEN_ID}`, method: "DELETE", body: undefined },
    ]);
  });
});

describe("skrun keys — a failure ends the command once, not the process", () => {
  it.each([
    [["keys", "create", "--name", "ci"]],
    [["keys", "list"]],
    [["keys", "revoke", KEY_ID]],
  ])("logged out, %j says so once and ends with 1", async (args) => {
    const run = await runKeys(args, minted, { signedIn: false });

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.requests).toHaveLength(0);
    // One line: the command's catch hands the exit on, it does not report it.
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toContain("Not logged in");
  });

  it("ends with 1 when the registry refuses, by throwing", async () => {
    const run = await runKeys(["keys", "list"], () =>
      Response.json({ error: { code: "INTERNAL" } }, { status: 500 }),
    );

    expect(run.processExitCalled).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.lines.join("\n")).toContain("List keys failed (500)");
  });
});
