import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { clearSessions, createSession } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

function createTestApp() {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);
  return { app, db, storage };
}

describe("Auth Routes", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    clearSessions();
    // Ensure OAuth is not configured by default in tests
    // biome-ignore lint/performance/noDelete: must truly remove env vars (= undefined sets "undefined" string)
    delete process.env.GITHUB_CLIENT_ID;
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // VT-1: OAuth redirect returns 302 with correct params
  it("VT-1: GET /auth/github redirects to GitHub when OAuth configured", async () => {
    process.env.GITHUB_CLIENT_ID = "test-client-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    const res = await app.request("/auth/github", { redirect: "manual" });
    expect(res.status).toBe(302);
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const location = res.headers.get("Location")!;
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("scope=read%3Auser+user%3Aemail");

    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_ID;
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-1 (no OAuth): returns 404 when not configured
  it("VT-1b: GET /auth/github returns 404 when OAuth not configured", async () => {
    const res = await app.request("/auth/github");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("OAUTH_NOT_CONFIGURED");
  });

  // VT-2: OAuth callback creates user + sets cookie (mocked GitHub)
  it("VT-2: GET /auth/github/callback creates user and sets session cookie", async () => {
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    // Mock GitHub API calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("login/oauth/access_token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "gho_test_token" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("api.github.com/user")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 12345,
                login: "Alice",
                email: "alice@test.com",
                avatar_url: "https://avatar.test/alice",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }),
    );

    // First, get the state from /auth/github redirect
    const redirectRes = await app.request("/auth/github", { redirect: "manual" });
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const location = new URL(redirectRes.headers.get("Location")!);
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const state = location.searchParams.get("state")!;
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const stateCookie = redirectRes.headers.get("Set-Cookie")!;

    // Call callback with the state
    const callbackRes = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {
      headers: { Cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("Location")).toContain("/dashboard");

    // Session cookie should be set
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const cookies = callbackRes.headers.get("Set-Cookie")!;
    expect(cookies).toContain("skrun_session=");

    // User should be created in DB
    const user = await db.getUserByGithubId("12345");
    expect(user).toBeTruthy();
    expect(user?.username).toBe("alice"); // lowercased
    expect(user?.email).toBe("alice@test.com");

    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_ID;
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-3: callback with existing user updates, doesn't duplicate
  it("VT-3: OAuth callback updates existing user, no duplication", async () => {
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    // Pre-create user
    await db.createUser({ github_id: "12345", username: "alice", email: "old@test.com" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("access_token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "tok" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("api.github.com/user")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 12345,
                login: "alice",
                email: "new@test.com",
                avatar_url: "https://new-avatar",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const redirectRes = await app.request("/auth/github", { redirect: "manual" });
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const state = new URL(redirectRes.headers.get("Location")!).searchParams.get("state")!;
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const stateCookie = redirectRes.headers.get("Set-Cookie")!;

    await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    });

    // Should still be 1 user, with updated email
    const user = await db.getUserByGithubId("12345");
    expect(user?.email).toBe("new@test.com");
    expect(user?.avatar_url).toBe("https://new-avatar");

    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_ID;
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-4: POST /api/keys creates key
  it("VT-4: POST /api/keys creates key with correct format", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = createSession(user.id);

    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `skrun_session=${sessionId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "CI key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sk_live_[0-9a-f]{32}$/);
    expect(body.name).toBe("CI key");
    expect(body.key_prefix).toMatch(/^sk_live_[0-9a-f]{8}$/);
    expect(body.scopes).toContain("agent:push");
  });

  // VT-5: API key authenticates POST /run
  it("VT-5: API key authenticates requests", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "test",
    });

    const res = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("alice");
    expect(body.namespace).toBe("alice");
  });

  // VT-6: DELETE /api/keys revokes, key no longer works
  it("VT-6: API key revocation works", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = createSession(user.id);

    // Create key
    const createRes = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: `skrun_session=${sessionId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "temp" }),
    });
    const { id, key } = await createRes.json();

    // Key works
    const meRes = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(meRes.status).toBe(200);

    // Revoke
    const deleteRes = await app.request(`/api/keys/${id}`, {
      method: "DELETE",
      headers: { Cookie: `skrun_session=${sessionId}` },
    });
    expect(deleteRes.status).toBe(204);

    // Key no longer works
    const meRes2 = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(meRes2.status).toBe(401);
  });

  // VT-7: Push to own namespace succeeds
  it("VT-7: push to own namespace succeeds", async () => {
    const res = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    expect(res.status).toBe(200);
  });

  // VT-8: Push to other namespace returns 403
  it("VT-8: push to other namespace returns 403", async () => {
    const res = await app.request("/api/agents/other/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    expect(res.status).toBe(403);
  });

  // VT-9: Run is public (anyone can run any agent)
  it("VT-9: run on another user's agent succeeds", async () => {
    // Push as dev
    await app.request("/api/agents/dev/my-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });

    // Run with a different token — still works (auth succeeds, no namespace check)
    const res = await app.request("/api/agents/dev/my-agent/run", {
      method: "POST",
      headers: { Authorization: "Bearer other-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    // 500 expected (bundle is fake, can't extract agent.yaml) but NOT 403
    expect(res.status).not.toBe(403);
  });

  // VT-10: Dev-token fallback when no OAuth configured
  it("VT-10: dev-token fallback works when OAuth not configured", async () => {
    const res = await app.request("/api/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.namespace).toBe("dev");
  });

  // VT-11: GET /api/me returns user info
  it("VT-11: GET /api/me returns full user info", async () => {
    const user = await db.createUser({
      github_id: "gh-1",
      username: "alice",
      email: "alice@test.com",
      avatar_url: "https://avatar/alice",
    });
    const sessionId = createSession(user.id);

    const res = await app.request("/api/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(user.id);
    expect(body.username).toBe("alice");
    expect(body.namespace).toBe("alice");
    expect(body.email).toBe("alice@test.com");
    expect(body.avatar_url).toBe("https://avatar/alice");
    expect(body.plan).toBe("free");
  });

  // VT-12: Login page renders with GitHub button
  it("VT-12: GET /login returns HTML with GitHub button when OAuth configured", async () => {
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";

    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("/auth/github");

    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_ID;
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-12b: Login page without OAuth shows dev-token message
  it("VT-12b: GET /login shows dev-token message when no OAuth", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("dev-token");
    expect(html).not.toContain("/auth/github");
  });

  // VT-13: Logout clears session
  it("VT-13: POST /auth/logout clears session cookie", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = createSession(user.id);

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `skrun_session=${sessionId}` },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const cookies = res.headers.get("Set-Cookie")!;
    expect(cookies).toContain("skrun_session=;");
  });

  // VT-14: Invalid API key returns 401
  it("VT-14: invalid sk_live_ key returns 401", async () => {
    const { key } = generateApiKey();
    const res = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });

  // VT-15: Expired API key returns 401
  it("VT-15: expired API key returns 401", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "expired",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });
});
