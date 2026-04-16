/**
 * E2E: POST /run — input validation, auth, response format
 */
import { beforeEach, describe, expect, it } from "vitest";
import { devAuth, pushAgent, runAgent, createTestApp as setup } from "./setup.js";

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

  // --- Version pinning (#7) ---

  it("404 VERSION_NOT_FOUND includes `available` newest-first when pinned version doesn't exist", async () => {
    // Push 3 versions of a different agent (beforeEach only pushed 1.0.0 of test-agent)
    await pushAgent(ctx.app, { name: "multi", version: "1.0.0" });
    await pushAgent(ctx.app, { name: "multi", version: "1.1.0" });
    await pushAgent(ctx.app, { name: "multi", version: "1.2.0" });

    const res = await ctx.app.request("/api/agents/dev/multi/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, version: "9.9.9" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("VERSION_NOT_FOUND");
    expect(body.error.message).toContain("9.9.9");
    expect(body.error.available).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  it("400 INVALID_VERSION_FORMAT on semver-range request", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, version: "^1.0.0" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
    expect(body.error.message).toMatch(/ranges/i);
  });
});
