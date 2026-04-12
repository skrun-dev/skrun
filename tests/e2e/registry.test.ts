/**
 * E2E: Registry — push, pull, list, metadata, versions, auth
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type createTestApp, createTestApp as setup, devAuth, pushAgent } from "./setup.js";

describe("E2E: Registry", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("full lifecycle: push → metadata → pull → list → versions", async () => {
    // Push
    const pushRes = await pushAgent(ctx.app, { name: "my-agent" });
    expect(pushRes.status).toBe(200);
    const pushBody = await pushRes.json();
    expect(pushBody.name).toBe("my-agent");
    expect(pushBody.verified).toBe(false);

    // Metadata
    const metaRes = await ctx.app.request("/api/agents/dev/my-agent");
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json();
    expect(meta.latest_version).toBe("1.0.0");
    expect(meta.verified).toBe(false);

    // Pull
    const pullRes = await ctx.app.request("/api/agents/dev/my-agent/pull", {
      headers: devAuth,
    });
    expect(pullRes.status).toBe(200);
    expect(pullRes.headers.get("X-Agent-Version")).toBe("1.0.0");

    // List
    const listRes = await ctx.app.request("/api/agents");
    const list = await listRes.json();
    expect(list.total).toBe(1);
    expect(list.agents[0].name).toBe("my-agent");

    // Versions
    const versionsRes = await ctx.app.request("/api/agents/dev/my-agent/versions");
    const versions = await versionsRes.json();
    expect(versions.versions).toHaveLength(1);
    expect(versions.versions[0].version).toBe("1.0.0");
  });

  it("push requires auth", async () => {
    const res = await ctx.app.request("/api/agents/dev/test/push?version=1.0.0", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("bundle"),
    });
    expect(res.status).toBe(401);
  });

  it("push rejects wrong namespace", async () => {
    const res = await ctx.app.request("/api/agents/other/test/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("bundle"),
    });
    expect(res.status).toBe(403);
  });

  it("push rejects duplicate version", async () => {
    await pushAgent(ctx.app, { name: "dup" });
    const res = await pushAgent(ctx.app, { name: "dup", version: "1.0.0" });
    expect(res.status).toBe(409);
  });

  it("pull returns 404 for non-existent agent", async () => {
    const res = await ctx.app.request("/api/agents/dev/nope/pull", { headers: devAuth });
    expect(res.status).toBe(404);
  });

  it("multi-version: push v1 + v2, pull latest returns v2", async () => {
    await pushAgent(ctx.app, { name: "multi", version: "1.0.0" });
    await pushAgent(ctx.app, { name: "multi", version: "2.0.0" });

    const res = await ctx.app.request("/api/agents/dev/multi/pull", { headers: devAuth });
    expect(res.headers.get("X-Agent-Version")).toBe("2.0.0");

    const versionsRes = await ctx.app.request("/api/agents/dev/multi/versions");
    const versions = await versionsRes.json();
    expect(versions.versions).toHaveLength(2);
    expect(versions.versions[0].version).toBe("1.0.0");
    expect(versions.versions[1].version).toBe("2.0.0");
  });
});
