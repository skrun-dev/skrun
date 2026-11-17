/**
 * E2E: an agent's state is kept per caller, through POST /run.
 *
 * A stateful agent (`state.type: kv`) is pushed and verified; the model call is
 * intercepted — no network — and answers with a `_state` the run then keeps.
 * What the model is shown is recorded at the moment of each call, so a test can
 * tell which notebook a run read: the previous state is part of that prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
import { createSession, sessionCookieName } from "../../packages/api/src/auth/session.js";
import type { StatePartition } from "../../packages/api/src/db/schema.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import { DEV_TOKEN, parseSSEEvents, createTestApp as setup, verifyVersion } from "./setup.js";

/** Webhook deliveries, captured instead of sent. */
const deliveries = vi.hoisted(() => [] as Array<{ url: string; payload: Record<string, unknown> }>);
vi.mock("../../packages/api/src/utils/webhook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/api/src/utils/webhook.js")>();
  return {
    ...actual,
    deliverWebhook: async (url: string, payload: object) => {
      deliveries.push({ url, payload: payload as Record<string, unknown> });
    },
  };
});

/**
 * The server's log lines, captured instead of printed: every logger the API
 * creates writes here. A test reads the events it expects from them.
 */
const logLines = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../packages/runtime/dist/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/runtime/dist/index.js")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      actual.createLogger(name, {
        write: (line: string) => {
          logLines.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
  };
});
const logged = (event: string) => logLines.filter((line) => line.event === event);

/** A caller's own model key: the run is servable without any server key. */
const LLM_KEY = JSON.stringify({ google: "fake-caller-key" });

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("E2E: one notebook per caller", () => {
  let ctx: ReturnType<typeof setup>;
  /** Every prompt the model was shown, serialised when it was shown. */
  let prompts: string[];
  /** The `_state` the model answers with on its next call (none when `undefined`). */
  let nextState: Record<string, unknown> | undefined;
  /** Something to do while the model is answering, before its answer returns. */
  let duringModelCall: (() => Promise<unknown>) | null;

  beforeEach(() => {
    ctx = setup();
    prompts = [];
    nextState = {};
    duringModelCall = null;
    deliveries.length = 0;
    logLines.length = 0;
    vi.spyOn(LLMRouter.prototype, "call").mockImplementation(
      async (_model, _system, userContent) => {
        prompts.push(JSON.stringify(userContent));
        if (duringModelCall) await duringModelCall();
        return {
          content: JSON.stringify({ answer: "ok", _state: nextState }),
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          estimatedCost: 0,
          provider: "google",
          model: "gemini-2.5-flash",
          durationMs: 1,
        };
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Push and verify an agent under the dev namespace, stateful unless `type`
   * says `none`. `scope` absent: the agent says nothing and gets the default.
   * Each test pushes its own name: extracted bundles are cached.
   */
  async function pushStatefulAgent(
    name: string,
    {
      scope,
      type = "kv",
      ttl,
    }: { scope?: "shared" | "per_caller"; type?: "kv" | "none"; ttl?: string } = {},
  ) {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "state:",
      `  type: ${type}`,
      ...(scope ? [`  scope: ${scope}`] : []),
      ...(ttl ? [`  ttl: ${ttl}`] : []),
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await ctx.app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...bearer(DEV_TOKEN), "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await verifyVersion(ctx.app, { name });
    const agent = await ctx.db.getAgent("dev", name);
    if (!agent) throw new Error("agent missing after push");
    return agent;
  }

  /** A key the agent's owner hands a client: delegated to running this one agent. */
  async function delegatedKey(agent: { id: string; owner_id: string }, label: string) {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const row = await ctx.db.createApiKey({
      user_id: agent.owner_id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: label,
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agent.id],
    });
    return { id: row.id, token: key };
  }

  /**
   * One run of `name`, authenticated by `auth`, whose model answers with
   * `writes` as its new state: the response, and what the model was shown.
   */
  async function runAndRead(
    name: string,
    auth: Record<string, string>,
    writes: Record<string, unknown> | undefined,
    extra: { headers?: Record<string, string>; body?: Record<string, unknown> } = {},
  ) {
    nextState = writes;
    const before = prompts.length;
    const res = await ctx.app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-LLM-API-Key": LLM_KEY,
        ...extra.headers,
      },
      body: JSON.stringify({ input: { q: "hello" }, ...extra.body }),
    });
    const body = (await res.json()) as { status?: string; output?: Record<string, unknown> };
    return { httpStatus: res.status, body, prompt: prompts.slice(before).join("\n") };
  }

  /** The same, for a run that must complete: returns what the model was shown. */
  async function run(
    name: string,
    auth: Record<string, string>,
    writes: Record<string, unknown> | undefined,
    extra: { headers?: Record<string, string>; body?: Record<string, unknown> } = {},
  ): Promise<string> {
    const { httpStatus, body, prompt } = await runAndRead(name, auth, writes, extra);
    expect(httpStatus).toBe(200);
    expect(body.status).toBe("completed");
    return prompt;
  }

  const asKey = (keyId: string): StatePartition => ({ kind: "key", keyId });
  const asAccount = (userId: string): StatePartition => ({ kind: "account", userId });

  it("two clients of the same agent each read only their own notebook", async () => {
    const agent = await pushStatefulAgent("isolated-notebooks");
    const a = await delegatedKey(agent, "client a");
    const b = await delegatedKey(agent, "client b");

    await run("isolated-notebooks", bearer(a.token), { secret: "alpha-secret" });
    const seenByB = await run("isolated-notebooks", bearer(b.token), { secret: "bravo-secret" });
    expect(seenByB).not.toContain("alpha-secret");

    // A runs again and reads back what A wrote — and nothing of B's.
    const seenByA = await run("isolated-notebooks", bearer(a.token), { secret: "alpha-again" });
    expect(seenByA).toContain("alpha-secret");
    expect(seenByA).not.toContain("bravo-secret");
  });

  it("an agent that declares a shared notebook shows every caller what the last one wrote", async () => {
    const agent = await pushStatefulAgent("shared-notebook", { scope: "shared" });
    const a = await delegatedKey(agent, "client a");
    const b = await delegatedKey(agent, "client b");

    await run("shared-notebook", bearer(a.token), { secret: "alpha-secret" });
    const seenByB = await run("shared-notebook", bearer(b.token), { secret: "bravo-secret" });
    expect(seenByB).toContain("alpha-secret");
  });

  it("a header or a body field that claims to name the caller has no effect", async () => {
    const agent = await pushStatefulAgent("caller-not-chosen");
    const a = await delegatedKey(agent, "client a");
    const b = await delegatedKey(agent, "client b");
    await run("caller-not-chosen", bearer(a.token), { secret: "alpha-secret" });

    // B names A — in a header and in the body — and is still B.
    const seenByB = await run(
      "caller-not-chosen",
      bearer(b.token),
      { secret: "bravo-secret" },
      {
        headers: { "X-Skrun-Caller": a.id },
        body: { caller: a.id },
      },
    );
    expect(seenByB).not.toContain("alpha-secret");
    expect((await ctx.db.getState(agent.id, asKey(a.id)))?.state).toEqual({
      secret: "alpha-secret",
    });
    expect((await ctx.db.getState(agent.id, asKey(b.id)))?.state).toEqual({
      secret: "bravo-secret",
    });
  });

  it("the owner keeps one notebook, signed in or with either of two full keys", async () => {
    const agent = await pushStatefulAgent("owner-notebook");
    const signedIn = {
      Cookie: `${sessionCookieName()}=${await createSession(ctx.db, agent.owner_id)}`,
    };
    // Two keys with every right on the account, as `skrun login` mints on two machines.
    const loginKey = async (label: string) => {
      const { key, keyHash, keyPrefix } = generateApiKey();
      await ctx.db.createApiKey({
        user_id: agent.owner_id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: label,
      });
      return key;
    };
    const laptop = await loginKey("laptop");
    const desktop = await loginKey("desktop");

    await run("owner-notebook", signedIn, { secret: "signed-in" });
    expect(await run("owner-notebook", bearer(laptop), { secret: "from-laptop" })).toContain(
      "signed-in",
    );
    expect(await run("owner-notebook", bearer(desktop), { secret: "from-desktop" })).toContain(
      "from-laptop",
    );
    expect((await ctx.db.getState(agent.id, asAccount(agent.owner_id)))?.state).toEqual({
      secret: "from-desktop",
    });
  });

  it("an agent deleted and published again under the same name starts from an empty notebook", async () => {
    const first = await pushStatefulAgent("republished");
    await run("republished", bearer(DEV_TOKEN), { secret: "first-life" });
    // The notebook is kept while the agent lives: the next run reads it.
    expect(await run("republished", bearer(DEV_TOKEN), { secret: "first-life" })).toContain(
      "first-life",
    );

    const deleted = await ctx.app.request("/api/agents/dev/republished", {
      method: "DELETE",
      headers: bearer(DEV_TOKEN),
    });
    expect(deleted.status).toBe(204);
    const second = await pushStatefulAgent("republished");
    expect(second.id).not.toBe(first.id);

    expect(await run("republished", bearer(DEV_TOKEN), { secret: "second-life" })).not.toContain(
      "first-life",
    );
  });

  it("an agent without state reads and writes none, and the model is not asked for any", async () => {
    const agent = await pushStatefulAgent("stateless", { type: "none" });
    const reads = vi.spyOn(ctx.db, "getState");
    const writes = vi.spyOn(ctx.db, "setState");

    const seen = await run("stateless", bearer(DEV_TOKEN), { secret: "offered-anyway" });

    expect(seen).not.toContain("_state");
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(await ctx.db.getState(agent.id, asAccount(agent.owner_id))).toBeNull();
  });

  it("a caller's sync, streamed and webhook runs share that caller's one notebook", async () => {
    const agent = await pushStatefulAgent("three-modes");
    const a = await delegatedKey(agent, "client a");
    const headers = {
      ...bearer(a.token),
      "Content-Type": "application/json",
      "X-LLM-API-Key": LLM_KEY,
    };

    await run("three-modes", bearer(a.token), { secret: "from-sync" });

    // Streamed: reads what the sync run wrote, writes its own.
    nextState = { secret: "from-stream" };
    const beforeStream = prompts.length;
    const streamed = await ctx.app.request("/api/agents/dev/three-modes/run", {
      method: "POST",
      headers: { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify({ input: { q: "hello" } }),
    });
    expect(streamed.status).toBe(200);
    expect(parseSSEEvents(await streamed.text()).map((e) => e.event)).toContain("run_complete");
    expect(prompts.slice(beforeStream).join("\n")).toContain("from-sync");

    // Webhook: reads what the streamed run wrote, writes its own.
    nextState = { secret: "from-webhook" };
    const beforeHook = prompts.length;
    const accepted = await ctx.app.request("/api/agents/dev/three-modes/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { q: "hello" }, webhook_url: "https://hooks.example/run" }),
    });
    expect(accepted.status).toBe(202);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    expect(deliveries[0].payload.status).toBe("completed");
    expect(prompts.slice(beforeHook).join("\n")).toContain("from-stream");

    expect((await ctx.db.getState(agent.id, asKey(a.id)))?.state).toEqual({
      secret: "from-webhook",
    });
  });

  it("a dev-token run whose account could not be recorded reads and writes no per-caller state, and completes", async () => {
    const agent = await pushStatefulAgent("no-account-row");
    // The dev-token's account is looked up, then created when absent: here
    // the lookup finds nothing and the creation fails.
    const lookup = vi.spyOn(ctx.db, "getUserByGithubId").mockResolvedValue(null);
    const create = vi
      .spyOn(ctx.db, "createUser")
      .mockRejectedValue(new Error("database unavailable"));
    const reads = vi.spyOn(ctx.db, "getState");
    const writes = vi.spyOn(ctx.db, "setState");

    await run("no-account-row", bearer(DEV_TOKEN), { secret: "nowhere-to-keep-it" });

    expect(create).toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(logged("state_skipped")).toEqual([
      expect.objectContaining({ reason: "no_account_row" }),
    ]);

    // The ordinary dev-token has its account, and keeps its notebook there.
    lookup.mockRestore();
    create.mockRestore();
    await run("no-account-row", bearer(DEV_TOKEN), { secret: "kept" });
    expect((await ctx.db.getState(agent.id, asAccount(agent.owner_id)))?.state).toEqual({
      secret: "kept",
    });
  });

  describe("a state write refused at the end of the run leaves the run its result", () => {
    /**
     * What goes away while the model is answering: the agent itself, or the
     * key the run was started with. Either makes the final state write fail.
     */
    async function setUp(name: string, goesAway: "agent" | "key") {
      const agent = await pushStatefulAgent(name);
      const key = await delegatedKey(agent, "client");
      duringModelCall =
        goesAway === "agent"
          ? () => ctx.db.deleteAgent("dev", name)
          : () => ctx.db.deleteApiKey(key.id);
      return { agent, key };
    }

    it.each([
      "agent",
      "key",
    ] as const)("the %s gone during a sync run: the run completes and returns its output", async (goesAway) => {
      const name = `gone-sync-${goesAway}`;
      const { key } = await setUp(name, goesAway);

      const { httpStatus, body } = await runAndRead(name, bearer(key.token), {
        secret: "too-late",
      });

      expect(httpStatus).toBe(200);
      expect(body.status).toBe("completed");
      expect(body.output).toEqual({ answer: "ok" });
      expect(logged("state_write_failed")).toHaveLength(1);
    });

    it.each([
      "agent",
      "key",
    ] as const)("the %s gone during a webhook run: the delivery reports the run completed", async (goesAway) => {
      const name = `gone-webhook-${goesAway}`;
      const { key } = await setUp(name, goesAway);
      nextState = { secret: "too-late" };

      const accepted = await ctx.app.request(`/api/agents/dev/${name}/run`, {
        method: "POST",
        headers: {
          ...bearer(key.token),
          "Content-Type": "application/json",
          "X-LLM-API-Key": LLM_KEY,
        },
        body: JSON.stringify({ input: { q: "hello" }, webhook_url: "https://hooks.example/run" }),
      });

      expect(accepted.status).toBe(202);
      await vi.waitFor(() => expect(deliveries).toHaveLength(1));
      expect(deliveries[0].payload).toMatchObject({
        status: "completed",
        output: { answer: "ok" },
      });
      expect(logged("state_write_failed")).toHaveLength(1);
    });
  });

  it("a state write that fails for any other reason fails the run", async () => {
    const name = "write-fails-otherwise";
    await pushStatefulAgent(name);
    vi.spyOn(ctx.db, "setState").mockRejectedValue(new Error("connection lost"));

    const { httpStatus, body } = await runAndRead(name, bearer(DEV_TOKEN), {
      secret: "not-kept",
    });

    expect(httpStatus).toBe(200);
    expect(body.status).toBe("failed");
    // The caller is told the write failed, never what the database said.
    expect((body as { error?: unknown }).error).toBe("State write failed");
    expect(logged("state_write_failed")).toEqual([
      expect.objectContaining({ absorbed: false, error_name: "Error" }),
    ]);
  });

  describe("a notebook is kept for its ttl from its last write", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const start = new Date("2026-10-06T12:00:00.000Z").getTime();
    const at = (days: number) => vi.setSystemTime(new Date(start + days * DAY_MS));

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a run that writes the notebook again keeps it past the first deadline", async () => {
      await pushStatefulAgent("ttl-slides", { ttl: "2d" });
      at(0);
      await run("ttl-slides", bearer(DEV_TOKEN), { note: "day-zero" });
      at(1);
      expect(await run("ttl-slides", bearer(DEV_TOKEN), { note: "day-one" })).toContain("day-zero");
      // Two days after the first write, one and a half after the last.
      at(2.5);
      expect(await run("ttl-slides", bearer(DEV_TOKEN), { note: "later" })).toContain("day-one");
    });

    it("a run that only reads the notebook does not keep it: it expires two days after its write", async () => {
      const agent = await pushStatefulAgent("ttl-read-only", { ttl: "2d" });
      at(0);
      await run("ttl-read-only", bearer(DEV_TOKEN), { note: "day-zero" });
      at(1);
      // The model answers without a `_state`: nothing is written.
      expect(await run("ttl-read-only", bearer(DEV_TOKEN), undefined)).toContain("day-zero");
      at(2.5);
      // The row is still there, not yet swept: the run reads it as absent.
      expect((await ctx.db.getState(agent.id, asAccount(agent.owner_id)))?.state).toEqual({
        note: "day-zero",
      });
      expect(await run("ttl-read-only", bearer(DEV_TOKEN), { note: "later" })).not.toContain(
        "day-zero",
      );
    });
  });

  it.each([
    ["99999999999d", 365],
    ["0d", 1],
  ] as const)("a version published with ttl %s runs, and its notebook is kept %i day(s)", async (ttl, days) => {
    const now = new Date("2026-10-06T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      // Pushed as is: publishing does not validate, so a version with an
      // out-of-range ttl can exist on the server.
      const agent = await pushStatefulAgent(`ttl-${days}`, { ttl });

      await run(`ttl-${days}`, bearer(DEV_TOKEN), { kept: true });

      expect((await ctx.db.getState(agent.id, asAccount(agent.owner_id)))?.expires_at).toBe(
        new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
