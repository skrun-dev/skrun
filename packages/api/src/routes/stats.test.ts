import type { Context } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import type { Run, User } from "../db/schema.js";
import { createStatsRoutes } from "./stats.js";

/**
 * Seeds account rows under the ids the fixtures and the fake auth use. The
 * in-memory store refuses a run naming an account it does not hold, as the SQL
 * backends' foreign keys do, and its `createUser` mints its own id: the rows go
 * straight into the store.
 */
function seedAccounts(db: MemoryDb, ...ids: string[]): void {
  const store = db as unknown as {
    users: Map<string, User>;
    usersByGithubId: Map<string, string>;
  };
  const now = new Date().toISOString();
  for (const id of ids) {
    store.users.set(id, {
      id,
      github_id: `gh-${id}`,
      username: id,
      email: "",
      avatar_url: "",
      plan: "free",
      role: "user",
      created_at: now,
      updated_at: now,
    });
    store.usersByGithubId.set(`gh-${id}`, id);
  }
}

function createTestApp(userId = "test-user") {
  const db = new MemoryDb();
  seedAccounts(db, userId);
  // Synthetic auth middleware: injects a user context so getUser(c) works.
  // Real auth is exercised by integration tests in tests/e2e/.
  const fakeAuth = async (c: Context, next: () => Promise<void>) => {
    c.set("user", {
      id: userId,
      namespace: "test",
      username: "test",
      role: "user",
    });
    await next();
  };
  const app = new Hono();
  app.route("/api", createStatsRoutes(db, fakeAuth));
  return { app, db };
}

describe("GET /api/stats", () => {
  let app: Hono;
  let db: MemoryDb;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
  });

  it("returns zeros when empty", async () => {
    const res = await app.request("/api/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      agents_count: 0,
      runs_today: 0,
      tokens_today: 0,
      failed_today: 0,
      runs_yesterday: 0,
      tokens_yesterday: 0,
      failed_yesterday: 0,
    });
    expect(body.daily_runs).toHaveLength(7);
    expect(body.daily_tokens).toHaveLength(7);
    expect(body.daily_failed).toHaveLength(7);
  });

  it("GET /api/runs/:id returns run when found", async () => {
    const run = await db.createRun({
      id: "run-abc",
      agent_id: null,
      agent_version: "1.0.0",
      user_id: "test-user",
      status: "completed",
    });
    await db.updateRun(run.id, { usage_total_tokens: 200, duration_ms: 1500 });

    const res = await app.request("/api/runs/run-abc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("run-abc");
    expect(body.usage_total_tokens).toBe(200);
    expect(body.duration_ms).toBe(1500);
  });

  it("omits operator-only machine_id/private_ip from GET /api/runs/:id (keeps phase_timings)", async () => {
    await db.createRun({
      id: "run-telemetry",
      agent_id: null,
      agent_version: "1.0.0",
      user_id: "test-user",
      status: "completed",
    });
    await db.updateRun("run-telemetry", {
      machine_id: "9185707b71308e",
      private_ip: "fdaa:0:1:a7b:1:2:3:4",
      phase_timings: { create_api_ms: 12, host_schedule_pull_ms: 4800 },
    });
    const res = await app.request("/api/runs/run-telemetry");
    expect(res.status).toBe(200);
    const body = await res.json();
    // N2: the runner's machine id + private IP are operator-only, never surfaced
    // to the run owner. The phase durations (public breakdown) stay.
    expect(body.machine_id).toBeUndefined();
    expect(body.private_ip).toBeUndefined();
    expect(body.phase_timings).toEqual({ create_api_ms: 12, host_schedule_pull_ms: 4800 });
  });

  it("GET /api/runs/:id returns 404 when not found", async () => {
    const res = await app.request("/api/runs/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("counts agents and today runs correctly", async () => {
    // Create 3 agents owned by the authenticated user (test-user). agents_count
    // is now per-owner (multi-tenant), matching the per-user run aggregates.
    const a1 = await db.createAgent({
      name: "a1",
      namespace: "dev",
      description: "",
      owner_id: "test-user",
    });
    await db.createAgent({ name: "a2", namespace: "dev", description: "", owner_id: "test-user" });
    await db.createAgent({
      name: "a3",
      namespace: "alice",
      description: "",
      owner_id: "test-user",
    });

    // Create 5 runs today (2 failed). Each run is owned by "test-user" so the
    // multi-tenancy filter (driven by fakeAuth) doesn't exclude them.
    for (let i = 0; i < 3; i++) {
      const run = await db.createRun({
        id: `run-${i}`,
        agent_id: a1.id,
        agent_version: "1.0.0",
        user_id: "test-user",
        status: "completed",
      });
      await db.updateRun(run.id, { usage_total_tokens: 100 });
    }
    for (let i = 3; i < 5; i++) {
      const run = await db.createRun({
        id: `run-${i}`,
        agent_id: a1.id,
        agent_version: "1.0.0",
        user_id: "test-user",
        status: "failed",
      });
      await db.updateRun(run.id, { usage_total_tokens: 50 });
    }

    const res = await app.request("/api/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      agents_count: 3,
      runs_today: 5,
      tokens_today: 400,
      failed_today: 2,
      runs_yesterday: 0,
      tokens_yesterday: 0,
      failed_yesterday: 0,
    });
    expect(body.daily_runs).toHaveLength(7);
    expect(body.daily_tokens).toHaveLength(7);
    expect(body.daily_failed).toHaveLength(7);
    // Today's runs should be in the last bucket (index 6)
    expect(body.daily_runs[6]).toBe(5);
    expect(body.daily_tokens[6]).toBe(400);
  });

  // ── Multi-tenancy ([005-cache-cost-savings-dashboard] VT-7) ────────────

  describe("multi-tenancy", () => {
    it("VT-7: User A only sees A's stats; User B only sees B's stats", async () => {
      // Build 2 separate apps with different user contexts, sharing the same DB.
      const sharedDb = new MemoryDb();
      seedAccounts(sharedDb, "user-A", "user-B");
      const buildApp = (userId: string) => {
        const fakeAuth = async (c: Context, next: () => Promise<void>) => {
          c.set("user", { id: userId, namespace: "test", username: "test", role: "user" });
          await next();
        };
        const a = new Hono();
        a.route("/api", createStatsRoutes(sharedDb, fakeAuth));
        return a;
      };
      const appA = buildApp("user-A");
      const appB = buildApp("user-B");
      const ag1 = await sharedDb.createAgent({
        name: "ag1",
        namespace: "test",
        description: "",
        owner_id: "user-A",
      });

      // User A: 2 runs $0.42 each (today)
      for (let i = 0; i < 2; i++) {
        const run = await sharedDb.createRun({
          id: `a-${i}`,
          agent_id: ag1.id,
          agent_version: "1.0.0",
          user_id: "user-A",
          status: "completed",
        });
        await sharedDb.updateRun(run.id, { usage_cache_savings_usd: 0.42 });
      }
      // User B: 3 runs $1.00 each (today)
      for (let i = 0; i < 3; i++) {
        const run = await sharedDb.createRun({
          id: `b-${i}`,
          agent_id: ag1.id,
          agent_version: "1.0.0",
          user_id: "user-B",
          status: "completed",
        });
        await sharedDb.updateRun(run.id, { usage_cache_savings_usd: 1.0 });
      }

      const resA = await appA.request("/api/stats");
      const bodyA = await resA.json();
      expect(bodyA.cache_savings_today).toBeCloseTo(0.84, 6);
      expect(bodyA.runs_today).toBe(2);

      const resB = await appB.request("/api/stats");
      const bodyB = await resB.json();
      expect(bodyB.cache_savings_today).toBeCloseTo(3.0, 6);
      expect(bodyB.runs_today).toBe(3);
    });

    it("VT-5/VT-6: GET /api/runs/:id — owner 200, non-owner gets an opaque 404", async () => {
      const sharedDb = new MemoryDb();
      seedAccounts(sharedDb, "user-A", "user-B");
      const buildApp = (userId: string) => {
        const fakeAuth = async (c: Context, next: () => Promise<void>) => {
          c.set("user", { id: userId, namespace: "test", username: "test", role: "user" });
          await next();
        };
        const a = new Hono();
        a.route("/api", createStatsRoutes(sharedDb, fakeAuth));
        return a;
      };
      const appA = buildApp("user-A");
      const appB = buildApp("user-B");
      const ag1 = await sharedDb.createAgent({
        name: "ag1",
        namespace: "test",
        description: "",
        owner_id: "user-A",
      });

      await sharedDb.createRun({
        id: "run-of-A",
        agent_id: ag1.id,
        agent_version: "1.0.0",
        user_id: "user-A",
        status: "completed",
      });

      // Owner gets 200
      const resA = await appA.request("/api/runs/run-of-A");
      expect(resA.status).toBe(200);

      // Non-owner gets an opaque 404 — identical to a non-existent run, so they
      // cannot tell "exists but not yours" from "does not exist".
      const resB = await appB.request("/api/runs/run-of-A");
      expect(resB.status).toBe(404);
      const bodyB = await resB.json();
      expect(bodyB.error.code).toBe("NOT_FOUND");
      // Opaque: same status + code as a run that truly does not exist.
      const resMissing = await appB.request("/api/runs/does-not-exist");
      expect(resMissing.status).toBe(404);
      expect((await resMissing.json()).error.code).toBe(bodyB.error.code);
    });

    // VT-14 (#80): per-agent stats — non-owner non-admin → 404 opaque.
    // Same byte-identical-body pattern as the registry GET routes.
    it("VT-14 (#80): GET /api/agents/:ns/:name/stats — non-owner gets 404 NOT_FOUND", async () => {
      const sharedDb = new MemoryDb();
      seedAccounts(sharedDb, "user-A", "user-B");
      const buildApp = (userId: string) => {
        const fakeAuth = async (c: Context, next: () => Promise<void>) => {
          c.set("user", { id: userId, namespace: "test", username: "test", role: "user" });
          await next();
        };
        const a = new Hono();
        a.route("/api", createStatsRoutes(sharedDb, fakeAuth));
        return a;
      };
      const appA = buildApp("user-A");
      const appB = buildApp("user-B");

      // user-B owns an agent + has 1 run
      const agent = await sharedDb.createAgent({
        name: "private-agent",
        namespace: "user-b",
        description: "",
        owner_id: "user-B",
      });
      await sharedDb.createRun({
        id: "run-B1",
        agent_id: agent.id,
        agent_version: "1.0.0",
        user_id: "user-B",
        status: "completed",
      });

      // Owner (user-B) reads stats → 200 with the run counted
      const resB = await appB.request("/api/agents/user-b/private-agent/stats");
      expect(resB.status).toBe(200);
      const bodyB = await resB.json();
      expect(bodyB.runs).toBe(1);

      // Non-owner (user-A) reads stats → 404 NOT_FOUND (opaque) with byte-equal
      // body shape to a genuine agent-not-found 404. No stats payload leaked.
      const resA = await appA.request("/api/agents/user-b/private-agent/stats");
      expect(resA.status).toBe(404);
      const bodyA = await resA.json();
      expect(bodyA).toEqual({
        error: { code: "NOT_FOUND", message: "Agent user-b/private-agent not found" },
      });
      // No stats fields leaked
      expect(bodyA.runs).toBeUndefined();
      expect(bodyA.tokens).toBeUndefined();
    });

    it("VT-1 (SEC-001): GET /api/runs filters by user_id — B does not see A's runs", async () => {
      const sharedDb = new MemoryDb();
      seedAccounts(sharedDb, "user-A", "user-B");
      const buildApp = (userId: string) => {
        const fakeAuth = async (c: Context, next: () => Promise<void>) => {
          c.set("user", { id: userId, namespace: "test", username: "test", role: "user" });
          await next();
        };
        const a = new Hono();
        a.route("/api", createStatsRoutes(sharedDb, fakeAuth));
        return a;
      };
      const appA = buildApp("user-A");
      const appB = buildApp("user-B");
      const ag1 = await sharedDb.createAgent({
        name: "ag1",
        namespace: "test",
        description: "",
        owner_id: "user-A",
      });

      await sharedDb.createRun({
        id: "run-A1",
        agent_id: ag1.id,
        agent_version: "1.0.0",
        user_id: "user-A",
        status: "completed",
      });
      await sharedDb.createRun({
        id: "run-B1",
        agent_id: ag1.id,
        agent_version: "1.0.0",
        user_id: "user-B",
        status: "completed",
      });

      const resA = await appA.request("/api/runs");
      const runsA: Array<{ id: string }> = await resA.json();
      expect(runsA.map((r) => r.id).sort()).toEqual(["run-A1"]);

      const resB = await appB.request("/api/runs");
      const runsB: Array<{ id: string }> = await resB.json();
      expect(runsB.map((r) => r.id).sort()).toEqual(["run-B1"]);
    });
  });
});

describe("stats/runs — API-key scope (#65)", () => {
  function appWithDelegatedKey(): Hono {
    const db = new MemoryDb();
    const delegatedAuth = async (c: Context, next: () => Promise<void>) => {
      c.set("user", {
        id: "u1",
        namespace: "test",
        username: "test",
        role: "user",
        key: { id: "k1", scope_kind: "agents", operations: ["agent:run"], agent_ids: [] },
      });
      await next();
    };
    const app = new Hono();
    app.route("/api", createStatsRoutes(db, delegatedAuth));
    return app;
  }

  it("a delegated key cannot list runs, read stats, or read a run → 403", async () => {
    const app = appWithDelegatedKey();
    expect((await app.request("/api/runs")).status).toBe(403);
    expect((await app.request("/api/stats")).status).toBe(403);
    expect((await app.request("/api/runs/some-id")).status).toBe(403);
  });
});

// Run history and usage stats belong to a full-access credential. A key that
// carries fewer than every operation — the "run-only" key a creator hands out —
// reads none of them; a session, the dev token and a full account key read them
// as before.
describe("stats/runs — reads that take full access", () => {
  const OWNER = "owner-1";
  const FULL_ACCESS_MESSAGE =
    "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.";

  type Credential = {
    label: string;
    role: "admin" | "user";
    key?: {
      id: string;
      scope_kind: "account" | "agents";
      operations: string[];
      agent_ids: string[];
    };
  };

  const REDUCED: Credential[] = [
    {
      label: "an account key that may only run agents",
      role: "user",
      key: { id: "k-run", scope_kind: "account", operations: ["agent:run"], agent_ids: [] },
    },
    {
      label: "an account key with no operation",
      role: "user",
      key: { id: "k-none", scope_kind: "account", operations: [], agent_ids: [] },
    },
  ];

  const MASTER: Credential[] = [
    { label: "a session", role: "user" },
    { label: "the dev token", role: "admin" },
    {
      label: "a full account key",
      role: "user",
      key: {
        id: "k-full",
        scope_kind: "account",
        operations: ["agent:run", "agent:push", "agent:verify"],
        agent_ids: [],
      },
    },
  ];

  async function world(credential: Credential): Promise<Hono> {
    const db = new MemoryDb();
    seedAccounts(db, OWNER);
    const agent = await db.createAgent({
      name: "my-agent",
      namespace: "owner",
      description: "",
      owner_id: OWNER,
    });
    await db.createRun({
      id: "run-1",
      agent_id: agent.id,
      agent_version: "1.0.0",
      user_id: OWNER,
      api_key_id: (
        await db.createApiKey({
          user_id: OWNER,
          key_hash: "other-key-hash",
          key_prefix: "skrun_sk_othr",
          name: "another client",
        })
      ).id,
      status: "completed",
      input: { q: "a client's question" },
    });
    await db.updateRun("run-1", { output: { answer: "a client's answer" } });
    const auth = async (c: Context, next: () => Promise<void>) => {
      c.set("user", {
        id: OWNER,
        namespace: "owner",
        username: "owner",
        role: credential.role,
        ...(credential.key && { key: credential.key }),
      });
      await next();
    };
    const app = new Hono();
    app.route("/api", createStatsRoutes(db, auth));
    return app;
  }

  async function expectFullAccessRefusal(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "KEY_SCOPE_FORBIDDEN", message: FULL_ACCESS_MESSAGE },
    });
  }

  describe("GET /api/runs", () => {
    it.each(REDUCED)("refuses $label", async (credential) => {
      await expectFullAccessRefusal(await (await world(credential)).request("/api/runs"));
    });
    it.each(MASTER)("lists the account's runs to $label", async (credential) => {
      const res = await (await world(credential)).request("/api/runs");
      expect(res.status).toBe(200);
      const runs: Array<{ id: string; output: unknown }> = await res.json();
      expect(runs.map((r) => [r.id, r.output])).toEqual([
        ["run-1", { answer: "a client's answer" }],
      ]);
    });
  });

  describe("GET /api/runs/:id", () => {
    it.each(REDUCED)("refuses $label", async (credential) => {
      await expectFullAccessRefusal(await (await world(credential)).request("/api/runs/run-1"));
    });
    it.each(MASTER)("returns the run to $label", async (credential) => {
      const res = await (await world(credential)).request("/api/runs/run-1");
      expect(res.status).toBe(200);
      const run = await res.json();
      expect([run.id, run.input]).toEqual(["run-1", { q: "a client's question" }]);
    });
  });

  describe("GET /api/stats", () => {
    it.each(REDUCED)("refuses $label", async (credential) => {
      await expectFullAccessRefusal(await (await world(credential)).request("/api/stats"));
    });
    it.each(MASTER)("returns the account's aggregates to $label", async (credential) => {
      const res = await (await world(credential)).request("/api/stats");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ agents_count: 1, runs_today: 1 });
    });
  });

  describe("GET /api/agents/:namespace/:name/stats", () => {
    it.each(REDUCED)("refuses $label", async (credential) => {
      await expectFullAccessRefusal(
        await (await world(credential)).request("/api/agents/owner/my-agent/stats"),
      );
    });
    it.each(MASTER)("returns the agent's aggregates to $label", async (credential) => {
      const res = await (await world(credential)).request("/api/agents/owner/my-agent/stats");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ runs: 1 });
    });
  });

  it("a delegated key keeps its own refusal on all four", async () => {
    const app = await world({
      label: "a delegated key",
      role: "user",
      key: { id: "k-del", scope_kind: "agents", operations: ["agent:run"], agent_ids: [] },
    });
    for (const path of [
      "/api/runs",
      "/api/runs/run-1",
      "/api/stats",
      "/api/agents/owner/my-agent/stats",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: "KEY_SCOPE_FORBIDDEN",
          message: "This endpoint is not available to a resource-scoped API key.",
        },
      });
    }
  });
});

/**
 * The keys a run response carries, sorted. Written out here rather than imported
 * from the route: a test that read the route's own list would move with it, and
 * could never see a field dropped from the response or one added to it.
 */
const PUBLIC_RUN_KEYS = [
  "agent_id",
  "agent_version",
  "api_key_id",
  "completed_at",
  "created_at",
  "duration_ms",
  "environment_id",
  "error",
  "files",
  "id",
  "input",
  "model",
  "output",
  "phase_timings",
  "status",
  "usage_cache_read_tokens",
  "usage_cache_savings_usd",
  "usage_cache_write_tokens",
  "usage_completion_tokens",
  "usage_estimated_cost",
  "usage_prompt_tokens",
  "usage_total_tokens",
  "user_id",
];

describe("run responses — an explicit set of public fields (#127)", () => {
  /** A run with every column filled, so a key missing from a response was withheld, not empty. */
  async function seedFullRun(db: MemoryDb): Promise<Run> {
    const agent = await db.createAgent({
      name: "full",
      namespace: "test",
      description: "",
      owner_id: "test-user",
    });
    const key = await db.createApiKey({
      user_id: "test-user",
      key_hash: "full-key-hash",
      key_prefix: "skrun_sk_full",
      name: "full",
    });
    await db.createRun({
      id: "run-full",
      agent_id: agent.id,
      agent_version: "1.0.0",
      model: "anthropic/claude-x",
      environment_id: "env-1",
      user_id: "test-user",
      api_key_id: key.id,
      status: "running",
      input: { q: "hello" },
    });
    await db.updateRun("run-full", {
      status: "completed",
      output: { answer: 42 },
      error: "warning kept for the test",
      usage_prompt_tokens: 10,
      usage_completion_tokens: 20,
      usage_total_tokens: 30,
      usage_estimated_cost: 0.01,
      usage_cache_read_tokens: 5,
      usage_cache_write_tokens: 6,
      usage_cache_savings_usd: 0.002,
      duration_ms: 1500,
      machine_id: "9185707b71308e",
      private_ip: "fdaa:0:1:a7b:1:2:3:4",
      phase_timings: { create_api_ms: 12 },
      files: [{ name: "a.txt", size: 1 }],
      completed_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // The purge mark has its own writer (updateRun does not take it).
    await db.markRunOutputsPurged("run-full", new Date().toISOString());
    // So has the cleared mark — an account deletion, which would also empty the
    // run. Set on the stored row, so that only the mark is filled in.
    const row = await db.getRun("run-full");
    if (!row) throw new Error("seeded run not found");
    row.content_cleared_at = new Date().toISOString();
    // And what the run holds of its account's quotas: the admission writes the
    // deadline and the right to the pool, the final write the charged time.
    row.deadline_at = new Date(Date.now() + 600_000).toISOString();
    row.charged_ms = 1500;
    row.pool_entitled = true;
    const stored = await db.getRun("run-full");
    if (!stored) throw new Error("seeded run not found");
    // Precondition: no column is left empty, the internal ones included.
    expect(
      Object.entries(stored).filter(([, value]) => value === null || value === undefined),
    ).toEqual([]);
    return stored;
  }

  it("VT-15 (#127): GET /api/runs/:id and each GET /api/runs element carry exactly the public keys", async () => {
    const { app, db } = createTestApp();
    await seedFullRun(db);

    const res = await app.request("/api/runs/run-full");
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(PUBLIC_RUN_KEYS);

    const listRes = await app.request("/api/runs");
    expect(listRes.status).toBe(200);
    const list: Record<string, unknown>[] = await listRes.json();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(PUBLIC_RUN_KEYS);
  });

  it("a run's seat deadline, charged time and right to the pool stay out of both responses", async () => {
    const { app, db } = createTestApp();
    const stored = await seedFullRun(db);
    // Precondition: the store holds all three for this run.
    expect(stored).toMatchObject({ charged_ms: 1500, pool_entitled: true });
    expect(stored.deadline_at).not.toBeNull();

    const one = await (await app.request("/api/runs/run-full")).json();
    const list: Record<string, unknown>[] = await (await app.request("/api/runs")).json();
    expect(one.id).toBe("run-full");
    expect(list.map((run) => run.id)).toEqual(["run-full"]);
    for (const body of [one, list[0]]) {
      expect(body).not.toHaveProperty("deadline_at");
      expect(body).not.toHaveProperty("charged_ms");
      expect(body).not.toHaveProperty("pool_entitled");
    }
  });

  it("a run cleared by the deletion of its agent's account carries exactly the public keys, the mark not among them", async () => {
    // Bob ran Alice's agent; Alice deletes her account. Bob's run stays his,
    // detached from the agent, emptied and marked — and he can still read it.
    const { app, db } = createTestApp("bob");
    seedAccounts(db, "alice");
    const agent = await db.createAgent({
      name: "tool",
      namespace: "alice",
      description: "",
      owner_id: "alice",
    });
    await db.createRun({
      id: "run-on-alices-agent",
      agent_id: agent.id,
      agent_version: "alice/tool@1.0.0",
      user_id: "bob",
      status: "running",
      input: { q: "hello" },
    });
    await db.updateRun("run-on-alices-agent", {
      status: "completed",
      output: { answer: 42 },
      completed_at: new Date().toISOString(),
    });
    expect(
      await db.deleteUser("alice", { purged_output_run_ids: [], at: new Date().toISOString() }),
    ).not.toBeNull();
    const stored = await db.getRun("run-on-alices-agent");
    expect(stored?.content_cleared_at).not.toBeNull();

    const one = await app.request("/api/runs/run-on-alices-agent");
    expect(one.status).toBe(200);
    const body = await one.json();
    expect(Object.keys(body).sort()).toEqual(PUBLIC_RUN_KEYS);
    expect(body).toMatchObject({ output: null, input: null, agent_id: null, user_id: "bob" });

    const list: Record<string, unknown>[] = await (await app.request("/api/runs")).json();
    expect(list.map((run) => run.id)).toEqual(["run-on-alices-agent"]);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(PUBLIC_RUN_KEYS);
  });

  it("VT-16 (#127): a column the store returns but the list does not name stays out of both responses", async () => {
    const { app, db } = createTestApp();
    await seedFullRun(db);
    const realGetRun = db.getRun.bind(db);
    const realListRuns = db.listRuns.bind(db);
    const getRunSpy = vi.spyOn(db, "getRun").mockImplementation(async (id) => {
      const run = await realGetRun(id);
      return run ? ({ ...run, future_internal: "operator-only" } as Run) : null;
    });
    const listRunsSpy = vi
      .spyOn(db, "listRuns")
      .mockImplementation(async (filters) =>
        (await realListRuns(filters)).map(
          (run) => ({ ...run, future_internal: "operator-only" }) as Run,
        ),
      );

    const one = await (await app.request("/api/runs/run-full")).json();
    const list: Record<string, unknown>[] = await (await app.request("/api/runs")).json();

    // The doctored rows were the ones served: both reads went through the spies.
    expect(getRunSpy).toHaveBeenCalledWith("run-full");
    expect(listRunsSpy).toHaveBeenCalledTimes(1);
    expect(one.id).toBe("run-full");
    expect(list[0]?.id).toBe("run-full");

    expect(one).not.toHaveProperty("future_internal");
    expect(list[0]).not.toHaveProperty("future_internal");
  });
});

describe("GET /api/runs returns 100 runs at most, whatever its limit", () => {
  // 120 runs of the account: more than the most the listing returns.
  async function appWith120Runs(): Promise<Hono> {
    const { app, db } = createTestApp();
    const start = Date.parse("2026-11-01T00:00:00.000Z");
    for (let i = 0; i < 120; i++) {
      await db.createRun({
        id: `listed-${i}`,
        agent_id: null,
        agent_version: "test/listed@1.0.0",
        user_id: "test-user",
        status: "completed",
        created_at: new Date(start + i * 1000).toISOString(),
      });
    }
    return app;
  }

  it.each([
    ["absent", "/api/runs", 50],
    ["0", "/api/runs?limit=0", 50],
    ["-5", "/api/runs?limit=-5", 50],
    ["abc", "/api/runs?limit=abc", 50],
    ["1.5", "/api/runs?limit=1.5", 50],
    ["1", "/api/runs?limit=1", 1],
    ["100", "/api/runs?limit=100", 100],
    ["500", "/api/runs?limit=500", 100],
  ])("limit %s (%s): %i runs, newest first", async (_label, path, expected) => {
    const app = await appWith120Runs();
    const res = await app.request(path);
    expect(res.status).toBe(200);
    const runs: Array<{ id: string }> = await res.json();
    expect(runs).toHaveLength(expected);
    expect(runs[0]?.id).toBe("listed-119");
  });
});
