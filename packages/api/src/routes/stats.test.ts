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

  it("GET /api/runs/:id returns 404 when not found", async () => {
    const res = await app.request("/api/runs/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("counts agents and today runs correctly", async () => {
    // Create 3 agents
    await db.createAgent({ name: "a1", namespace: "dev", description: "", owner_id: "u1" });
    await db.createAgent({ name: "a2", namespace: "dev", description: "", owner_id: "u1" });
    await db.createAgent({ name: "a3", namespace: "alice", description: "", owner_id: "u2" });

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
          c.set("user", { id: userId, namespace: "test", username: "test" });
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
  });
});
