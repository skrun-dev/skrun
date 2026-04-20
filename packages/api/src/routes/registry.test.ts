import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

describe("Registry Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    app = createApp(storage, db);
  });

  const authHeader = { Authorization: "Bearer dev-token" };
  const bundle = Buffer.from("fake-agent-bundle-content");

  async function pushAgent(ns = "dev", name = "test-agent", version = "1.0.0") {
    return app.request(`/api/agents/${ns}/${name}/push?version=${version}`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
  }

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("POST /push succeeds with auth", async () => {
    const res = await pushAgent();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-agent");
    expect(body.namespace).toBe("dev");
    expect(body.latest_version).toBe("1.0.0");
  });

  it("POST /push returns 401 without auth", async () => {
    const res = await app.request("/api/agents/dev/agent/push?version=1.0.0", {
      method: "POST",
      body: bundle,
    });
    expect(res.status).toBe(401);
  });

  it("POST /push returns 403 for wrong namespace", async () => {
    const res = await app.request("/api/agents/other/agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
    expect(res.status).toBe(403);
  });

  it("POST /push returns 409 for duplicate version", async () => {
    await pushAgent();
    const res = await pushAgent();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("VERSION_EXISTS");
  });

  it("POST /push overwrites duplicate version when force=true", async () => {
    await pushAgent();
    const updatedBundle = Buffer.from("force-overwrite-bundle");
    const res = await app.request("/api/agents/dev/test-agent/push?version=1.0.0&force=true", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: updatedBundle,
    });

    expect(res.status).toBe(200);

    const pullRes = await app.request("/api/agents/dev/test-agent/pull/1.0.0", {
      headers: authHeader,
    });
    expect(pullRes.status).toBe(200);
    expect(Buffer.from(await pullRes.arrayBuffer())).toEqual(updatedBundle);
  });

  it("POST /push returns 400 without version param", async () => {
    const res = await app.request("/api/agents/dev/agent/push", {
      method: "POST",
      headers: authHeader,
      body: bundle,
    });
    expect(res.status).toBe(400);
  });

  it("GET /pull returns the pushed bundle", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/pull", {
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body)).toEqual(bundle);
    expect(res.headers.get("X-Agent-Version")).toBe("1.0.0");
  });

  it("GET /pull/:version returns specific version", async () => {
    await pushAgent("dev", "agent", "1.0.0");
    const v2 = Buffer.from("v2-content");
    await app.request("/api/agents/dev/agent/push?version=2.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: v2,
    });

    const res = await app.request("/api/agents/dev/agent/pull/1.0.0", {
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(Buffer.from(body)).toEqual(bundle);
  });

  it("GET /pull returns 401 without auth", async () => {
    const res = await app.request("/api/agents/dev/agent/pull");
    expect(res.status).toBe(401);
  });

  it("GET /pull returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/dev/nonexistent/pull", {
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });

  it("GET /agents lists agents (public)", async () => {
    await pushAgent("dev", "a", "1.0.0");
    await pushAgent("dev", "b", "1.0.0");

    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("GET /agents/:ns/:name returns metadata (public)", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-agent");
    expect(body.versions).toEqual(["1.0.0"]);
  });

  it("GET /agents/:ns/:name metadata includes verified=false by default", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent");
    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it("PATCH /verify sets verified=true", async () => {
    await pushAgent();
    const res = await app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
  });

  it("PATCH /verify sets verified=false (revoke)", async () => {
    await pushAgent();
    // First verify
    await app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    // Then revoke
    const res = await app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(false);
  });

  it("PATCH /verify returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/dev/nonexistent/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /verify returns 401 without auth", async () => {
    const res = await app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(401);
  });

  it("Re-push preserves verified flag", async () => {
    await pushAgent();
    // Verify the agent
    await app.request("/api/agents/dev/test-agent/verify", {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    // Re-push with new version
    await pushAgent("dev", "test-agent", "2.0.0");
    // Check verified is still true
    const res = await app.request("/api/agents/dev/test-agent");
    const body = await res.json();
    expect(body.verified).toBe(true);
  });

  it("GET /agents/:ns/:name/versions returns versions (public)", async () => {
    await pushAgent("dev", "agent", "1.0.0");
    await app.request("/api/agents/dev/agent/push?version=2.0.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/octet-stream" },
      body: Buffer.from("v2"),
    });

    const res = await app.request("/api/agents/dev/agent/versions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(2);
  });
});
