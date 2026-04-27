import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createStatsRoutes } from "./stats.js";

function createTestApp() {
  const db = new MemoryDb();
  const noAuth = async (_c: unknown, next: () => Promise<void>) => next();
  const app = new Hono();
  app.route("/api", createStatsRoutes(db, noAuth as never));
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

    // Create 5 runs today (2 failed)
    for (let i = 0; i < 3; i++) {
      const run = await db.createRun({
        id: `run-${i}`,
        agent_id: "a1",
        agent_version: "1.0.0",
        status: "completed",
      });
      await db.updateRun(run.id, { usage_total_tokens: 100 });
    }
    for (let i = 3; i < 5; i++) {
      const run = await db.createRun({
        id: `run-${i}`,
        agent_id: "a1",
        agent_version: "1.0.0",
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
});
