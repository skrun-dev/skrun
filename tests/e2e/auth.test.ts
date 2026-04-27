/**
 * E2E: Auth integration tests
 * Cross-feature flows: dev-token, API keys, namespace isolation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
import { clearSessions, createSession } from "../../packages/api/src/auth/session.js";
import { DEV_TOKEN, createTestApp, pushAgent } from "./setup.js";

describe("E2E: Auth", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  let db: ReturnType<typeof createTestApp>["db"];

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    clearSessions();
  });

  // --- Dev-token flow (RT-1) ---

  it("dev-token push → run → works as before", async () => {
    const pushRes = await pushAgent(app, { ns: "dev", name: "test-agent", version: "1.0.0" });
    expect(pushRes.status).toBe(200);

    // Run (will fail because fake bundle, but should not be 401 or 403)
    const runRes = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).not.toBe(401);
    expect(runRes.status).not.toBe(403);
  });

  // --- Dev-token → API key cross-path ---

  it("dev-token creates API key via endpoint → key works for auth", async () => {
    // Create key using dev-token (no pre-created user in DB)
    const createRes = await app.request("/api/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dev-key" }),
    });
    expect(createRes.status).toBe(201);
    const { key } = await createRes.json();
    expect(key).toMatch(/^sk_live_/);

    // Use the key to call /api/me — must work (user was auto-created in DB)
    const meRes = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.namespace).toBe("dev");
  });

  // --- API key flow ---

  it("create API key → use it for push + run", async () => {
    // Create a user and API key
    const user = await db.createUser({ github_id: "gh-e2e", username: "e2euser" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "e2e-key",
    });

    // Push with API key
    const pushRes = await app.request("/api/agents/e2euser/my-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    expect(pushRes.status).toBe(200);

    // Run with same API key (will fail at bundle extract, but auth passes)
    const runRes = await app.request("/api/agents/e2euser/my-agent/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).not.toBe(401);
    expect(runRes.status).not.toBe(403);
  });

  // --- Namespace isolation ---

  it("user A cannot push to user B's namespace", async () => {
    const userA = await db.createUser({ github_id: "gh-a", username: "alice" });
    const { key: keyA, keyHash: hashA, keyPrefix: prefixA } = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: hashA,
      key_prefix: prefixA,
      name: "a-key",
    });

    // Alice tries to push to bob's namespace → 403
    const res = await app.request("/api/agents/bob/my-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    expect(res.status).toBe(403);
  });

  it("user A can run user B's agent (marketplace model)", async () => {
    // Push as dev (user B equivalent)
    await pushAgent(app, { ns: "dev", name: "public-agent", version: "1.0.0" });

    // Run as a different user via API key
    const userA = await db.createUser({ github_id: "gh-runner", username: "runner" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userA.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "run-key",
    });

    const res = await app.request("/api/agents/dev/public-agent/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    // Not 401 or 403 — auth passed, namespace check not applied to run
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  // --- API key management via session ---

  it("session auth: list and revoke API keys", async () => {
    const user = await db.createUser({ github_id: "gh-mgmt", username: "keymgr" });
    const sessionId = createSession(user.id);
    const cookieHeader = `skrun_session=${sessionId}`;

    // Create 2 keys
    await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "key-1" }),
    });
    await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "key-2" }),
    });

    // List — should have 2
    const listRes = await app.request("/api/keys", {
      headers: { Cookie: cookieHeader },
    });
    expect(listRes.status).toBe(200);
    const keys = await listRes.json();
    expect(keys).toHaveLength(2);

    // Revoke first
    const deleteRes = await app.request(`/api/keys/${keys[0].id}`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader },
    });
    expect(deleteRes.status).toBe(204);

    // List — should have 1
    const listRes2 = await app.request("/api/keys", {
      headers: { Cookie: cookieHeader },
    });
    const keys2 = await listRes2.json();
    expect(keys2).toHaveLength(1);
  });

  // --- Verify namespace enforcement ---

  it("verify endpoint enforces namespace ownership", async () => {
    // Push agent as dev
    await pushAgent(app, { ns: "dev", name: "secure-agent" });

    // Create user alice
    const alice = await db.createUser({ github_id: "gh-alice", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: alice.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "alice-key",
    });

    // Alice tries to verify dev's agent → 403
    const res = await app.request("/api/agents/dev/secure-agent/verify", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(403);
  });

  // --- Delete agent endpoint ---

  it("delete endpoint enforces namespace ownership", async () => {
    await pushAgent(app, { ns: "dev", name: "to-delete" });

    // Create alice
    const alice = await db.createUser({ github_id: "gh-del", username: "alice" });
    const { key: keyA, keyHash: hashA, keyPrefix: pfxA } = generateApiKey();
    await db.createApiKey({ user_id: alice.id, key_hash: hashA, key_prefix: pfxA, name: "a" });

    // Alice can't delete dev's agent
    const res1 = await app.request("/api/agents/dev/to-delete", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(res1.status).toBe(403);

    // dev-token user can delete their own
    const res2 = await app.request("/api/agents/dev/to-delete", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
    });
    expect(res2.status).toBe(204);

    // Confirm it's gone
    const res3 = await app.request("/api/agents/dev/to-delete");
    expect(res3.status).toBe(404);
  });
});
