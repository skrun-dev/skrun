import type { Context } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createStatsRoutes } from "./stats.js";

function createTestApp(userId = "test-user") {
  const db = new MemoryDb();
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
    await db.createAgent({ name: "a1", namespace: "dev", description: "", owner_id: "test-user" });
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
        agent_id: "a1",
        agent_version: "1.0.0",
        user_id: "test-user",
        status: "completed",
      });
      await db.updateRun(run.id, { usage_total_tokens: 100 });
    }
    for (let i = 3; i < 5; i++) {
      const run = await db.createRun({
        id: `run-${i}`,
        agent_id: "a1",
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

      // User A: 2 runs $0.42 each (today)
      for (let i = 0; i < 2; i++) {
        const run = await sharedDb.createRun({
          id: `a-${i}`,
          agent_id: "ag1",
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
          agent_id: "ag1",
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

      await sharedDb.createRun({
        id: "run-of-A",
        agent_id: "ag1",
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

      await sharedDb.createRun({
        id: "run-A1",
        agent_id: "ag1",
        agent_version: "1.0.0",
        user_id: "user-A",
        status: "completed",
      });
      await sharedDb.createRun({
        id: "run-B1",
        agent_id: "ag1",
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
