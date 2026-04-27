/**
 * E2E integration tests for dashboard API endpoints (GET /api/stats, GET /api/runs, GET /api/agents/scan).
 * Uses Hono test client — no network, no real LLM, fast.
 */
import { describe, expect, it } from "vitest";
import { createTestApp, devAuth, pushAgent } from "./setup.js";

describe("E2E: Dashboard API", () => {
  // IT-1: GET /api/stats returns correct data
  it("GET /api/stats returns zeros when empty", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/stats", { headers: devAuth });
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

  it("GET /api/stats reflects pushed agents", async () => {
    const { app } = createTestApp();
    await pushAgent(app, { name: "agent-1" });
    await pushAgent(app, { name: "agent-2" });

    const res = await app.request("/api/stats", { headers: devAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents_count).toBe(2);
  });

  it("GET /api/stats requires auth", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/stats");
    expect(res.status).toBe(401);
  });

  // GET /api/runs
  it("GET /api/runs returns empty array when no runs", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/runs?limit=10", { headers: devAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/runs requires auth", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/runs");
    expect(res.status).toBe(401);
  });

  // GET /api/agents/scan
  it("GET /api/agents/scan returns configured:false when env not set", async () => {
    const { app } = createTestApp();
    const originalEnv = process.env.SKRUN_AGENTS_DIR;
    // biome-ignore lint/performance/noDelete: Node.js requires delete to truly unset env vars
    delete process.env.SKRUN_AGENTS_DIR;

    const res = await app.request("/api/agents/scan", { headers: devAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agents: [], configured: false });

    if (originalEnv !== undefined) {
      process.env.SKRUN_AGENTS_DIR = originalEnv;
    }
  });

  it("GET /api/agents/scan requires auth", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/agents/scan");
    expect(res.status).toBe(401);
  });

  // GET /api/runs/:id
  it("GET /api/runs/:id returns 404 for nonexistent run", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/runs/nonexistent", { headers: devAuth });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("GET /api/runs/:id returns run when found", async () => {
    const { app, db } = createTestApp();
    await db.createRun({
      id: "test-run-e2e",
      agent_id: null,
      agent_version: "1.0.0",
      status: "completed",
    });

    const res = await app.request("/api/runs/test-run-e2e", { headers: devAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("test-run-e2e");
    expect(body.status).toBe("completed");
  });

  it("GET /api/runs/:id requires auth", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/runs/any-id");
    expect(res.status).toBe(401);
  });

  // VT-2: Agent list with counts
  it("GET /api/agents includes run_count and token_count", async () => {
    const { app, db } = createTestApp();
    await pushAgent(app, { name: "counted-agent" });

    // Get agent ID
    // Get internal agent ID via DB (API doesn't expose internal IDs)
    const agent = await db.getAgent("dev", "counted-agent");

    // Create runs for this agent
    const run1 = await db.createRun({
      id: "cnt-run-1",
      agent_id: agent!.id,
      agent_version: "dev/counted-agent@1.0.0",
      status: "completed",
    });
    await db.updateRun(run1.id, { usage_total_tokens: 500 });
    const run2 = await db.createRun({
      id: "cnt-run-2",
      agent_id: agent!.id,
      agent_version: "dev/counted-agent@1.0.0",
      status: "completed",
    });
    await db.updateRun(run2.id, { usage_total_tokens: 300 });

    const res = await app.request("/api/agents?page=1&limit=50", { headers: devAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.agents.find((a: { name: string }) => a.name === "counted-agent");
    expect(found).toBeDefined();
    expect(found.run_count).toBe(2);
    expect(found.token_count).toBe(800);
  });

  // VT-3: Agent stats endpoint
  it("GET /api/agents/:ns/:name/stats returns agent-level aggregates", async () => {
    const { app, db } = createTestApp();
    await pushAgent(app, { name: "stats-agent" });

    const agent = await db.getAgent("dev", "stats-agent");

    // Create runs: 3 completed, 1 failed
    for (let i = 0; i < 3; i++) {
      const run = await db.createRun({
        id: `sa-run-${i}`,
        agent_id: agent!.id,
        agent_version: "dev/stats-agent@1.0.0",
        status: "completed",
      });
      await db.updateRun(run.id, { usage_total_tokens: 100, duration_ms: 1000 });
    }
    const failedRun = await db.createRun({
      id: "sa-run-fail",
      agent_id: agent!.id,
      agent_version: "dev/stats-agent@1.0.0",
      status: "failed",
    });
    await db.updateRun(failedRun.id, { usage_total_tokens: 50, duration_ms: 200 });

    const res = await app.request("/api/agents/dev/stats-agent/stats", { headers: devAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toBe(4);
    expect(body.tokens).toBe(350);
    expect(body.failed).toBe(1);
    expect(body.avg_duration_ms).toBeGreaterThan(0);
    expect(body.daily_runs).toHaveLength(7);
    expect(body.daily_failed).toHaveLength(7);
    expect(body.daily_avg_duration_ms).toHaveLength(7);
  });

  it("GET /api/agents/:ns/:name/stats returns 404 for nonexistent agent", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/agents/dev/nonexistent/stats", { headers: devAuth });
    expect(res.status).toBe(404);
  });

  // Playground redirect
  it("GET /playground redirects to /dashboard/agents", async () => {
    const { app } = createTestApp();
    const res = await app.request("/playground", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/dashboard/agents");
  });

  it("GET /playground/examples redirects to /dashboard/agents", async () => {
    const { app } = createTestApp();
    const res = await app.request("/playground/examples", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/dashboard/agents");
  });
});
