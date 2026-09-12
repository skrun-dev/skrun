import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { createSession } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createAuthMiddleware, getUser } from "./auth.js";

// RT-3 asserts the structured log that goes with the 500. pino writes to fd 1
// directly (bypassing process.stdout.write), so the only way to observe the line
// is to replace createLogger. vi.mock is hoisted above the import of ./auth.js,
// and so runs before that module builds its logger at import time; vi.hoisted
// declares the spy in lock-step. Only createLogger is replaced — the rest of
// @skrun-dev/runtime is left intact.
const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: logErrorSpy,
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      level: "info",
      child: () => ({ info: vi.fn(), error: logErrorSpy }),
    }),
  };
});

describe("Auth Middleware (createAuthMiddleware)", () => {
  let db: MemoryDb;
  let app: Hono;

  beforeEach(() => {
    logErrorSpy.mockClear();
    db = new MemoryDb();
    app = new Hono();
    const authMw = createAuthMiddleware(db);
    app.use("/protected/*", authMw);
    app.get("/protected/me", (c) => {
      const user = getUser(c);
      return c.json(user);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates via session cookie", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = await createSession(db, user.id);

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
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const res = await app.request("/protected/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.namespace).toBe("dev");
  });

  // SEC-005 part B (4.3): role loading + dev-token=admin
  it("loads user.role from DB on session-cookie auth (default user)", async () => {
    const user = await db.createUser({ github_id: "gh-role-1", username: "carol" });
    const sessionId = await createSession(db, user.id);

    const res = await app.request("/protected/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("user");
  });

  it("loads user.role from DB on API-key auth (default user)", async () => {
    const user = await db.createUser({ github_id: "gh-role-2", username: "dan" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
    });
    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("user");
  });

  it("session-cookie auth surfaces 'admin' role when DB row is admin", async () => {
    const user = await db.createUser({ github_id: "gh-role-3", username: "erin" });
    // Promote via raw DB (no API exposes elevation by design).
    const internal = (db as unknown as { users: Map<string, { role: string }> }).users;
    const stored = internal.get(user.id);
    if (!stored) throw new Error("seed user missing");
    stored.role = "admin";
    const sessionId = await createSession(db, user.id);

    const res = await app.request("/protected/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
    });
    const body = await res.json();
    expect(body.role).toBe("admin");
  });

  it("dev-token grants admin role (Q-11)", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const res = await app.request("/protected/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
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

  // VT-6 (#65): the auth middleware attaches the key scope context.
  it("VT-6: account-wide key surfaces key context without a grant query", async () => {
    const user = await db.createUser({ github_id: "gh-sc-1", username: "scacct" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "acct",
      scopes: ["agent:run", "agent:push", "agent:verify"],
    });
    const spy = vi.spyOn(db, "getApiKeyAgentIds");
    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await res.json();
    expect(body.key).toMatchObject({
      scope_kind: "account",
      operations: ["agent:run", "agent:push", "agent:verify"],
      agent_ids: [],
    });
    // Account-wide path issues no extra query (hot path stays single-query).
    expect(spy).not.toHaveBeenCalled();
  });

  it("VT-6: agents-scoped key surfaces lazily-loaded grants", async () => {
    const user = await db.createUser({ github_id: "gh-sc-2", username: "scag" });
    const agent = await db.createAgent({
      name: "a",
      namespace: "scag",
      description: "",
      owner_id: user.id,
    });
    const { key, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "scoped",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agent.id],
    });
    const spy = vi.spyOn(db, "getApiKeyAgentIds");
    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await res.json();
    expect(body.key.scope_kind).toBe("agents");
    expect(body.key.agent_ids).toEqual([agent.id]);
    expect(spy).toHaveBeenCalledWith(apiKey.id);
  });

  // RT-2 (#124): an unknown session cookie is a non-event, not a rejection.
  // The cookie is checked first, and when it matches nothing the request must
  // carry on to the other credentials. Moving the store from memory to the
  // database changed where "matches nothing" is decided — this asserts the
  // answer did not change with it.
  it("RT-2 (#124): an unknown session cookie falls through to a valid API key", async () => {
    const user = await db.createUser({ github_id: "gh-rt2", username: "fallthrough" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "fallthrough key",
    });

    const res = await app.request("/protected/me", {
      headers: {
        Cookie: "skrun_session=00000000-0000-4000-8000-000000000000",
        Authorization: `Bearer ${key}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("fallthrough");
    // The key is what got them in — a session would have carried no key at all.
    expect(body.key).not.toBeNull();
  });

  // RT-3 (#124): the twin of the case above, and the reason the two sit side by
  // side — it was their confusion that made this decision necessary. Same
  // request, same valid key; the difference is that here the store itself
  // fails. An unknown cookie falls through. A broken store must not: were it
  // treated as "no session", the valid key would answer 200 and a sessions
  // table that had never been created would sign everyone out with nothing in
  // the logs to say why.
  it("RT-3 (#124): a failing session lookup answers 500 and logs it", async () => {
    const user = await db.createUser({ github_id: "gh-rt3", username: "loud" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "rt3 key",
    });
    vi.spyOn(db, "getSession").mockRejectedValue(new Error("connection terminated unexpectedly"));

    const res = await app.request("/protected/me", {
      headers: {
        Cookie: "skrun_session=00000000-0000-4000-8000-000000000000",
        Authorization: `Bearer ${key}`,
      },
    });

    // Neither a 401 nor a silent fall-through — the 200 the key alone would
    // have produced is exactly what must not happen here.
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Session lookup failed" },
    });

    // And it is loud: one error line, naming the event.
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy.mock.calls[0][0]).toMatchObject({ event: "session_lookup_failed" });
  });

  it("VT-6: session + dev-token carry no key (master credential)", async () => {
    const user = await db.createUser({ github_id: "gh-sc-3", username: "scsess" });
    const sessionId = await createSession(db, user.id);
    const sres = await app.request("/protected/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
    });
    expect((await sres.json()).key).toBeNull();

    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    const dres = await app.request("/protected/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect((await dres.json()).key).toBeNull();
  });
});

// VT-1 (#009): the fail-secure gate. The api test setup enables dev-auth
// globally; this describe turns it OFF (env-snapshot restore) to prove a
// dev-token (and any arbitrary bearer) is rejected when SKRUN_DEV_AUTH is unset.
describe("Auth Middleware — dev-auth gate OFF (SKRUN_DEV_AUTH unset)", () => {
  const envSnapshot = { ...process.env };
  let db: MemoryDb;
  let app: Hono;

  beforeEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SKRUN_DEV_AUTH;
    db = new MemoryDb();
    app = new Hono();
    app.use("/protected/*", createAuthMiddleware(db));
    app.get("/protected/me", (c) => c.json(getUser(c)));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("VT-1: rejects dev-token (401) when SKRUN_DEV_AUTH is off", async () => {
    const res = await app.request("/protected/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(401);
  });

  it("VT-1: rejects an arbitrary bearer (401) when SKRUN_DEV_AUTH is off", async () => {
    const res = await app.request("/protected/me", {
      headers: { Authorization: "Bearer arbitrary-xyz" },
    });
    expect(res.status).toBe(401);
  });
});
