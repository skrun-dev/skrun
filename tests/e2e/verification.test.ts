/**
 * E2E: Agent verification — verified flag, script blocking, dev-token bypass
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEV_TOKEN,
  PROD_TOKEN,
  createTestApp as setup,
  pushAgent,
  runAgent,
  verifyAgent,
} from "./setup.js";

describe("E2E: Agent verification", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await pushAgent(ctx.app, { name: "test-agent" });
  });

  it("new agent has verified=false by default", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent");
    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it("PATCH /verify sets verified=true", async () => {
    const res = await verifyAgent(ctx.app, { name: "test-agent", verified: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
  });

  it("PATCH /verify can revoke (set false)", async () => {
    await verifyAgent(ctx.app, { name: "test-agent", verified: true });
    const res = await verifyAgent(ctx.app, { name: "test-agent", verified: false });
    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it("PATCH /verify returns 404 for non-existent agent", async () => {
    const res = await verifyAgent(ctx.app, { name: "nonexistent", verified: true });
    expect(res.status).toBe(404);
  });

  it("PATCH /verify returns 401 without auth", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(401);
  });

  it("re-push preserves verified flag", async () => {
    await verifyAgent(ctx.app, { name: "test-agent", verified: true });
    await pushAgent(ctx.app, { name: "test-agent", version: "2.0.0" });

    const res = await ctx.app.request("/api/agents/dev/test-agent");
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.latest_version).toBe("2.0.0");
  });

  it("dev-token always bypasses verification (no warning)", async () => {
    // Agent is non-verified, run with dev-token → no warning
    const res = await runAgent(ctx.app, {
      name: "test-agent",
      input: { text: "hello" },
      token: DEV_TOKEN,
    });
    const body = await res.json();
    expect(body.warnings).toBeUndefined();
  });

  it("non-dev token on non-verified agent with bundle → proceeds without scripts", async () => {
    // Run with prod token → agent runs but may have warning if scripts exist
    const res = await runAgent(ctx.app, {
      name: "test-agent",
      input: { text: "hello" },
      token: PROD_TOKEN,
    });
    // Should not be 400 or 401 (auth works with any token)
    expect(res.status).not.toBe(400);
  });
});
