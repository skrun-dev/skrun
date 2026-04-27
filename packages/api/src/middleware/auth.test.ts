import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { clearSessions, createSession } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createAuthMiddleware, getUser } from "./auth.js";

describe("Auth Middleware (createAuthMiddleware)", () => {
  let db: MemoryDb;
  let app: Hono;

  beforeEach(() => {
    db = new MemoryDb();
    app = new Hono();
    const authMw = createAuthMiddleware(db);
    app.use("/protected/*", authMw);
    app.get("/protected/me", (c) => {
      const user = getUser(c);
      return c.json(user);
    });
    clearSessions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates via session cookie", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = createSession(user.id);

    const res = await app.request("/protected/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.namespace).toBe("alice");
    expect(body.username).toBe("alice");
  });

  it("authenticates via API key (sk_live_*)", async () => {
    const user = await db.createUser({ github_id: "gh-2", username: "bob" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "CI key",
    });

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.namespace).toBe("bob");
    expect(body.username).toBe("bob");
  });

  it("authenticates via dev-token when OAuth not configured", async () => {
    // Ensure OAuth env vars are NOT set
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_ID;
    // biome-ignore lint/performance/noDelete: must truly remove env vars
    delete process.env.GITHUB_CLIENT_SECRET;

    const res = await app.request("/protected/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.namespace).toBe("dev");
  });

  it("rejects dev-token when OAuth IS configured", async () => {
    const original = { ...process.env };
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";

    try {
      const res = await app.request("/protected/me", {
        headers: { Authorization: "Bearer dev-token" },
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.GITHUB_CLIENT_ID = original.GITHUB_CLIENT_ID;
      process.env.GITHUB_CLIENT_SECRET = original.GITHUB_CLIENT_SECRET;
    }
  });

  it("returns 401 for missing Authorization header", async () => {
    const res = await app.request("/protected/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for expired API key", async () => {
    const user = await db.createUser({ github_id: "gh-3", username: "charlie" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "expired",
      expires_at: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    });

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain("expired");
  });

  it("returns 401 for invalid API key", async () => {
    // Valid format but not in DB
    const { key } = generateApiKey();
    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid session cookie", async () => {
    const res = await app.request("/protected/me", {
      headers: { Cookie: "skrun_session=nonexistent-session-id" },
    });
    // Falls through to check Bearer token, which is missing → 401
    expect(res.status).toBe(401);
  });
});
