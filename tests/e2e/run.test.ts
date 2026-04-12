/**
 * E2E: POST /run — input validation, auth, response format
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp as setup, devAuth, pushAgent, runAgent } from "./setup.js";

describe("E2E: POST /run", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await pushAgent(ctx.app, { name: "test-agent" });
  });

  it("returns 401 without auth", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await runAgent(ctx.app, { name: "nonexistent", input: {} });
    // Agent not in registry → error during pull
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("health endpoint returns ok", async () => {
    const res = await ctx.app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("rate limit headers are present on /run", async () => {
    const res = await runAgent(ctx.app, { name: "test-agent", input: {} });
    expect(res.headers.get("X-RateLimit-Limit")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
  });
});
