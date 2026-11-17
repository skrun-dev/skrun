import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { createSession, sessionCookieErasures, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import type { User } from "../db/schema.js";
import { createApp } from "../index.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import { MemoryStorage } from "../storage/memory.js";

// The deletion's log lines are asserted, so the logger is captured. pino writes
// to fd 1 directly, so createLogger is replaced; the rest of the runtime package
// is left as it is.
const { logInfoSpy, logErrorSpy } = vi.hoisted(() => ({
  logInfoSpy: vi.fn(),
  logErrorSpy: vi.fn(),
}));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const logger = {
    info: logInfoSpy,
    warn: vi.fn(),
    error: logErrorSpy,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: "info",
  };
  return { ...actual, createLogger: () => ({ ...logger, child: () => logger }) };
});

const BUNDLE_KEYS = ["alice/tool/1.0.0.agent", "alice/tool/2.0.0.agent"];

interface World {
  app: ReturnType<typeof createApp>;
  db: MemoryDb;
  storage: MemoryStorage;
  alice: User;
  bob: User;
  /** A session of alice's, as the cookie value. */
  session: string;
  /** Alice's keys: account-wide with every operation, account-wide run-only, delegated. */
  fullKey: string;
  reducedKey: string;
  delegatedKey: string;
}

async function mintKey(
  db: MemoryDb,
  userId: string,
  opts: { scope_kind?: "account" | "agents"; scopes?: string[] } = {},
): Promise<string> {
  const { key, keyHash, keyPrefix } = generateApiKey();
  await db.createApiKey({
    user_id: userId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: "k",
    scope_kind: opts.scope_kind ?? "account",
    scopes: opts.scopes,
    agents: [],
  });
  return key;
}

/** Alice, with an agent of two versions (an object each) and her credentials; Bob, untouched. */
async function world(): Promise<World> {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);
  const alice = await db.createUser({ github_id: "gh-alice-77", username: "alice" });
  const bob = await db.createUser({ github_id: "gh-bob-78", username: "bob" });
  const tool = await db.createAgent({
    name: "tool",
    namespace: "alice",
    description: "",
    owner_id: alice.id,
  });
  for (const [i, key] of BUNDLE_KEYS.entries()) {
    await db.createVersion(tool.id, { version: `${i + 1}.0.0`, size: 1, bundle_key: key });
    await storage.put(key, Buffer.from(`bundle ${i + 1}`));
  }
  const bobTool = await db.createAgent({
    name: "tool",
    namespace: "bob",
    description: "",
    owner_id: bob.id,
  });
  await db.createVersion(bobTool.id, {
    version: "1.0.0",
    size: 1,
    bundle_key: "bob/tool/1.0.0.agent",
  });
  await storage.put("bob/tool/1.0.0.agent", Buffer.from("bob's bundle"));
  return {
    app,
    db,
    storage,
    alice,
    bob,
    session: await createSession(db, alice.id),
    fullKey: await mintKey(db, alice.id),
    reducedKey: await mintKey(db, alice.id, { scopes: ["agent:run"] }),
    delegatedKey: await mintKey(db, alice.id, { scope_kind: "agents" }),
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const cookie = (session: string) => ({ Cookie: `${sessionCookieName()}=${session}` });
/**
 * The cookie as a browser sends it from the page itself: the same-origin
 * signal is what carries a request with no JSON body past the CSRF guard, so
 * the route, not the guard, answers it.
 */
const fromPage = (session: string) => ({ ...cookie(session), "Sec-Fetch-Site": "same-origin" });

function deleteAccount(
  app: World["app"],
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.request("/api/account", {
    method: "DELETE",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

/** Alice's account and every one of her rows and objects are gone; Bob's are all there. */
async function expectAliceGone(w: World): Promise<void> {
  expect(await w.db.getUserById(w.alice.id)).toBeNull();
  expect(await w.db.getAgent("alice", "tool")).toBeNull();
  expect(await w.db.listApiKeys(w.alice.id)).toEqual([]);
  for (const key of BUNDLE_KEYS) expect(await w.storage.exists(key)).toBe(false);
  await expectBobIntact(w);
}

async function expectBobIntact(w: World): Promise<void> {
  expect(await w.db.getUserById(w.bob.id)).not.toBeNull();
  expect(await w.db.getAgent("bob", "tool")).not.toBeNull();
  expect(await w.storage.exists("bob/tool/1.0.0.agent")).toBe(true);
}

/** Alice's account and every one of her rows and objects are where they were. */
async function expectAliceIntact(w: World): Promise<void> {
  expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
  expect(await w.db.getAgent("alice", "tool")).not.toBeNull();
  expect(await w.db.listApiKeys(w.alice.id)).toHaveLength(3);
  for (const key of BUNDLE_KEYS) expect(await w.storage.exists(key)).toBe(true);
}

beforeEach(() => {
  // The dev-token path is open only while no OAuth app is configured.
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  logInfoSpy.mockClear();
  logErrorSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/account — who may delete their account", () => {
  it("a session, the account's full key and a dev token delete the account", async () => {
    const bySession = await world();
    const res = await deleteAccount(bySession.app, cookie(bySession.session), { confirm: "alice" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    await expectAliceGone(bySession);

    const byKey = await world();
    const keyRes = await deleteAccount(byKey.app, bearer(byKey.fullKey), { confirm: "alice" });
    expect(keyRes.status).toBe(200);
    await expectAliceGone(byKey);

    const byDevToken = await world();
    const first = await byDevToken.app.request("/api/me", { headers: bearer("dev-token") });
    const devId = (await first.json()).id as string;
    const devRes = await deleteAccount(byDevToken.app, bearer("dev-token"), { confirm: "dev" });
    expect(devRes.status).toBe(200);
    expect(await byDevToken.db.getUserById(devId)).toBeNull();
    await expectBobIntact(byDevToken);
  });

  it("a key with fewer operations and a delegated key are refused, and nothing is touched", async () => {
    const w = await world();
    for (const key of [w.reducedKey, w.delegatedKey]) {
      const res = await deleteAccount(w.app, bearer(key), { confirm: "alice" });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("KEY_SCOPE_FORBIDDEN");
    }
    await expectAliceIntact(w);
  });

  it("no credential at all is a 401", async () => {
    const w = await world();
    const res = await deleteAccount(w.app, {}, { confirm: "alice" });
    expect(res.status).toBe(401);
    await expectAliceIntact(w);
  });
});

describe("DELETE /api/account — the confirmation", () => {
  it("no body, a body that is not JSON, the wrong name and a name that is not a string are refused; the username deletes", async () => {
    const w = await world();
    const noBody = await deleteAccount(w.app, bearer(w.fullKey));
    expect(noBody.status, "no body").toBe(400);
    expect((await noBody.json()).error.code).toBe("CONFIRMATION_MISMATCH");
    for (const body of ["not json", { confirm: "bob" }, { confirm: "Alice" }, { confirm: 1 }, {}]) {
      const res = await deleteAccount(w.app, bearer(w.fullKey), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe("CONFIRMATION_MISMATCH");
    }
    await expectAliceIntact(w);

    const res = await deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" });
    expect(res.status).toBe(200);
    await expectAliceGone(w);
  });
});

describe("DELETE /api/account — the session cookie and what signs in afterwards", () => {
  it("erases every name of the session cookie, and neither the session nor a key signs in afterwards", async () => {
    const w = await world();
    const res = await deleteAccount(w.app, cookie(w.session), { confirm: "alice" });
    expect(res.status).toBe(200);

    // Read as a list: one get() would hide a missing header behind a comma.
    const erased = res.headers.getSetCookie().map((c) => c.slice(0, c.indexOf("=")));
    const expected = sessionCookieErasures().map((e) => e.name);
    expect(expected.length).toBeGreaterThan(0);
    expect(erased.sort()).toEqual([...expected].sort());
    for (const line of res.headers.getSetCookie()) expect(line).toMatch(/Max-Age=0/i);

    expect((await w.app.request("/api/me", { headers: cookie(w.session) })).status).toBe(401);
    expect((await w.app.request("/api/me", { headers: bearer(w.fullKey) })).status).toBe(401);
  });

  it("with a dev token, the next request records a new, empty account under another id", async () => {
    const w = await world();
    const before = await (await w.app.request("/api/me", { headers: bearer("dev-token") })).json();
    expect((await deleteAccount(w.app, bearer("dev-token"), { confirm: "dev" })).status).toBe(200);

    const after = await w.app.request("/api/me", { headers: bearer("dev-token") });
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.username).toBe("dev");
    expect(body.id).not.toBe(before.id);
  });
});

// Production with a shared cookie domain: the one configuration where the
// session cookie can be carried under several names and on two scopes, all of
// which the answer erases.
describe("DELETE /api/account — under a configured cookie domain", () => {
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    delete process.env.SKRUN_DEV_AUTH;
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  it("erases every name on both scopes, as the sign-out does", async () => {
    const w = await world();
    const res = await w.app.request("/api/account", {
      method: "DELETE",
      headers: {
        Cookie: `__Secure-skrun_session=${w.session}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "alice" }),
    });
    expect(res.status).toBe(200);
    const erased = res.headers.getSetCookie().map((c) => {
      const name = c.slice(0, c.indexOf("="));
      const domain = /;\s*Domain=([^;]+)/i.exec(c)?.[1];
      return `${name}|${domain ?? "-"}`;
    });
    expect(new Set(erased)).toEqual(
      new Set([
        "skrun_session|-",
        "skrun_session|example.com",
        "__Host-skrun_session|-",
        "__Secure-skrun_session|-",
        "__Secure-skrun_session|example.com",
      ]),
    );
    expect(erased).toHaveLength(5);
    const after = await w.app.request("/api/me", {
      headers: { Cookie: `__Secure-skrun_session=${w.session}` },
    });
    expect(after.status).toBe(401);
  });
});

describe("DELETE /api/account — a mutation carried by the session cookie alone", () => {
  it("is refused by the CSRF guard without a content type, and reaches the route with JSON", async () => {
    const w = await world();
    // No Authorization and no Origin: the cookie is the only credential.
    const bare = await w.app.request("/api/account", {
      method: "DELETE",
      headers: cookie(w.session),
    });
    expect(bare.status).toBe(403);
    expect(await bare.text()).toBe("Forbidden");
    await expectAliceIntact(w);

    const withJson = await w.app.request("/api/account", {
      method: "DELETE",
      headers: { ...cookie(w.session), "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "alice" }),
    });
    expect(withJson.status).toBe(200);
    await expectAliceGone(w);
  });
});

describe("DELETE /api/account — the dev token", () => {
  it("deletes the token's account; the next request records an empty one", async () => {
    const w = await world();
    const pushed = await w.app.request("/api/me", { headers: bearer("del-token") });
    const first = (await pushed.json()) as { id: string; username: string };
    expect(first.username).toBe("del");
    const agent = await w.db.createAgent({
      name: "kept",
      namespace: "del",
      description: "",
      owner_id: first.id,
    });
    expect(agent).toBeDefined();

    const res = await deleteAccount(w.app, bearer("del-token"), { confirm: "del" });
    expect(res.status).toBe(200);
    expect(await w.db.getUserById(first.id)).toBeNull();
    expect(await w.db.getAgent("del", "kept")).toBeNull();

    const again = await (await w.app.request("/api/me", { headers: bearer("del-token") })).json();
    expect(again.id).not.toBe(first.id);
    expect(again.username).toBe("del");
    const { agents } = await w.db.listAgents({ page: 1, limit: 50, userId: again.id });
    expect(agents).toEqual([]);
  });

  // Its id is derived from the token and is no UUID: read by Postgres, it would
  // fail with an error rather than find nothing. So nothing is read at all.
  it("a dev token whose account could not be recorded has nothing to delete: 404, before any read", async () => {
    const w = await world();
    vi.spyOn(w.db, "createUser").mockRejectedValue(new Error("database is locked"));
    const plan = vi.spyOn(w.db, "planUserDeletion");
    const res = await deleteAccount(w.app, bearer("orphan-token"), { confirm: "orphan" });
    expect(res.status).toBe(404);
    // Its own message, not the one of an account gone meanwhile.
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "This account has no record." },
    });
    expect(plan).not.toHaveBeenCalled();
    await expectAliceIntact(w);
    await expectBobIntact(w);
  });
});

describe("DELETE /api/account — two deletions at once", () => {
  it("one deletes, the other finds nothing; never a 500, and the end state is that of one deletion", async () => {
    const w = await world();
    const [a, b] = await Promise.all([
      deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" }),
      deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    for (const status of statuses) expect([200, 401, 404]).toContain(status);
    await expectAliceGone(w);
  });
});

describe("DELETE /api/account — an object store that fails", () => {
  it("answers 503 and leaves the account; a version whose object went first no longer pulls; the same request finishes", async () => {
    const w = await world();
    const realDelete = w.storage.delete.bind(w.storage);
    let calls = 0;
    vi.spyOn(w.storage, "delete").mockImplementation(async (key) => {
      calls++;
      if (calls === 2) throw new Error("store unreachable");
      return realDelete(key);
    });

    const res = await deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("STORAGE_UNAVAILABLE");
    // The account and its credentials still work: the retry needs them.
    expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
    expect((await w.app.request("/api/me", { headers: bearer(w.fullKey) })).status).toBe(200);
    // The first object is gone, the version that names it is still listed.
    const [goneKey, keptKey] = BUNDLE_KEYS as [string, string];
    expect(await w.storage.exists(goneKey)).toBe(false);
    expect(await w.storage.exists(keptKey)).toBe(true);
    const pull = await w.app.request("/api/agents/alice/tool/pull/1.0.0", {
      headers: bearer(w.fullKey),
    });
    expect(pull.status).toBe(500);
    expect((await pull.json()).error.code).toBe("BUNDLE_NOT_FOUND");

    const retry = await deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" });
    expect(retry.status).toBe(200);
    await expectAliceGone(w);
  });
});

describe("DELETE /api/account — what the log says", () => {
  it("one line of counts and the route, nothing that names the account", async () => {
    const w = await world();
    const res = await deleteAccount(w.app, cookie(w.session), { confirm: "alice" });
    expect(res.status).toBe(200);

    const lines = logInfoSpy.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "account_deleted");
    expect(lines).toEqual([
      {
        event: "account_deleted",
        route: "self",
        agents: 1,
        versions: 2,
        api_keys: 3,
        runs_cleared: 0,
        objects_deleted: 2,
      },
    ]);
    const all = JSON.stringify([...logInfoSpy.mock.calls, ...logErrorSpy.mock.calls]);
    for (const secret of ["alice", w.alice.id, "gh-alice-77", ...BUNDLE_KEYS]) {
      expect(all).not.toContain(secret);
    }
  });
});

// ── DELETE /api/admin/accounts/:id ─────────────────────────────────────

interface AdminWorld extends World {
  /** An instance administrator, with a session and two keys that are not master. */
  admin: User;
  adminSession: string;
  adminReducedKey: string;
  adminDelegatedKey: string;
  /** A session of Bob's: signed in, not an administrator. */
  bobSession: string;
}

async function adminWorld(): Promise<AdminWorld> {
  const w = await world();
  const admin = await w.db.createUser({ github_id: "gh-carol-79", username: "carol" });
  // The promotion is an SQL statement on a real deployment; the in-memory store
  // hands back the very row it keeps.
  admin.role = "admin";
  return {
    ...w,
    admin,
    adminSession: await createSession(w.db, admin.id),
    adminReducedKey: await mintKey(w.db, admin.id, { scopes: ["agent:run"] }),
    adminDelegatedKey: await mintKey(w.db, admin.id, { scope_kind: "agents" }),
    bobSession: await createSession(w.db, w.bob.id),
  };
}

function deleteOther(
  app: World["app"],
  id: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.request(`/api/admin/accounts/${id}`, {
    method: "DELETE",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Status, content type and body, as one comparable value. */
async function answer(
  res: Response,
): Promise<{ status: number; type: string | null; body: string }> {
  return { status: res.status, type: res.headers.get("Content-Type"), body: await res.text() };
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const NOT_FOUND_BODY = { error: { code: "NOT_FOUND", message: "Not found" } };

describe("DELETE /api/admin/accounts/:id — who may delete another account", () => {
  it("an administrator's session deletes the account the id and the name designate, and only it", async () => {
    const w = await adminWorld();
    const res = await deleteOther(w.app, w.alice.id, cookie(w.adminSession), { confirm: "alice" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    // The caller is someone else: its cookie is left alone.
    expect(res.headers.getSetCookie()).toEqual([]);
    await expectAliceGone(w);
    expect(await w.db.getUserById(w.admin.id)).not.toBeNull();
    expect((await w.app.request("/api/me", { headers: cookie(w.adminSession) })).status).toBe(200);
  });

  it("a caller who is not an administrator, or holds a delegated key, gets the admin routes' opaque 404, whatever it sends", async () => {
    const w = await adminWorld();
    const callers: Array<[string, Record<string, string>]> = [
      ["a signed-in user", fromPage(w.bobSession)],
      ["an administrator's delegated key", bearer(w.adminDelegatedKey)],
    ];
    const requests: Array<[string, unknown]> = [
      [w.alice.id, { confirm: "alice" }],
      [w.alice.id, undefined],
      ["not-a-uuid", { confirm: "alice" }],
      [UNKNOWN_ID, { confirm: "nobody" }],
    ];
    for (const [label, headers] of callers) {
      const pool = await answer(await w.app.request("/api/admin/pool", { headers }));
      expect(pool.status, label).toBe(404);
      // The target, a malformed id, an unknown one; with and without a body:
      // one answer, so the caller learns neither the route nor what it expects.
      for (const [id, body] of requests) {
        const res = await answer(await deleteOther(w.app, id, headers, body));
        expect(res, `${label}: ${id} ${JSON.stringify(body)}`).toEqual(pool);
      }
    }
    await expectAliceIntact(w);
  });

  it("an administrator's key with fewer operations is refused with 403, and nothing is touched", async () => {
    const w = await adminWorld();
    const res = await deleteOther(w.app, w.alice.id, bearer(w.adminReducedKey), {
      confirm: "alice",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("KEY_SCOPE_FORBIDDEN");
    await expectAliceIntact(w);
  });

  it("an administrator deleting their own account by its id — the last one, here — loses the session cookie, as on the self route", async () => {
    const w = await adminWorld();
    const res = await deleteOther(w.app, w.admin.id, cookie(w.adminSession), { confirm: "carol" });
    expect(res.status).toBe(200);

    const erased = res.headers.getSetCookie().map((c) => c.slice(0, c.indexOf("=")));
    expect(erased.sort()).toEqual(
      sessionCookieErasures()
        .map((e) => e.name)
        .sort(),
    );
    for (const line of res.headers.getSetCookie()) expect(line).toMatch(/Max-Age=0/i);
    expect(await w.db.getUserById(w.admin.id)).toBeNull();
    expect((await w.app.request("/api/me", { headers: cookie(w.adminSession) })).status).toBe(401);
    await expectAliceIntact(w);
  });

  it("the dev token carries the administrator role: it deletes another account", async () => {
    const w = await adminWorld();
    const res = await deleteOther(w.app, w.alice.id, bearer("dev-token"), { confirm: "alice" });
    expect(res.status).toBe(200);
    await expectAliceGone(w);
  });
});

describe("DELETE /api/admin/accounts/:id — the target", () => {
  it("a malformed id is a 404 before anything is read; an id no account has, a 404 too", async () => {
    const w = await adminWorld();
    const plan = vi.spyOn(w.db, "planUserDeletion");
    for (const id of ["not-a-uuid", "1", `${w.alice.id}x`]) {
      const res = await deleteOther(w.app, id, cookie(w.adminSession), { confirm: "alice" });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND_BODY);
    }
    expect(plan).not.toHaveBeenCalled();

    const unknown = await deleteOther(w.app, UNKNOWN_ID, cookie(w.adminSession), {
      confirm: "alice",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(NOT_FOUND_BODY);
    await expectAliceIntact(w);
  });

  it("an id and a name that designate two accounts delete neither", async () => {
    const w = await adminWorld();
    for (const [id, confirm] of [
      [w.alice.id, "bob"],
      [w.bob.id, "alice"],
    ] as const) {
      const res = await deleteOther(w.app, id, cookie(w.adminSession), { confirm });
      expect(res.status, confirm).toBe(400);
      expect((await res.json()).error.code).toBe("CONFIRMATION_MISMATCH");
    }
    await expectAliceIntact(w);
    await expectBobIntact(w);
  });

  it("no body and the wrong name are refused; the target's username deletes", async () => {
    const w = await adminWorld();
    const noBody = await deleteOther(w.app, w.alice.id, fromPage(w.adminSession));
    expect(noBody.status, "no body").toBe(400);
    expect((await noBody.json()).error.code).toBe("CONFIRMATION_MISMATCH");
    const ownName = await deleteOther(w.app, w.alice.id, cookie(w.adminSession), {
      confirm: "carol",
    });
    expect(ownName.status, "the caller's own name").toBe(400);
    await expectAliceIntact(w);

    const res = await deleteOther(w.app, w.alice.id, cookie(w.adminSession), { confirm: "alice" });
    expect(res.status).toBe(200);
    await expectAliceGone(w);
  });

  it("an object store that fails answers 503 and leaves the account", async () => {
    const w = await adminWorld();
    vi.spyOn(w.storage, "delete").mockRejectedValueOnce(new Error("store unreachable"));
    const res = await deleteOther(w.app, w.alice.id, cookie(w.adminSession), { confirm: "alice" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("STORAGE_UNAVAILABLE");
    expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
  });
});

describe("DELETE /api/admin/accounts/:id — what the log says", () => {
  it("one line of counts and the admin route, nothing that names either account", async () => {
    const w = await adminWorld();
    const res = await deleteOther(w.app, w.alice.id, cookie(w.adminSession), { confirm: "alice" });
    expect(res.status).toBe(200);
    const lines = logInfoSpy.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "account_deleted");
    expect(lines).toEqual([
      {
        event: "account_deleted",
        route: "admin",
        agents: 1,
        versions: 2,
        api_keys: 3,
        runs_cleared: 0,
        objects_deleted: 2,
      },
    ]);
    const all = JSON.stringify([...logInfoSpy.mock.calls, ...logErrorSpy.mock.calls]);
    for (const secret of ["alice", w.alice.id, "carol", w.admin.id, ...BUNDLE_KEYS]) {
      expect(all).not.toContain(secret);
    }
  });
});

// ── PUT /api/admin/accounts/:id/plan ──────────────────────────────────

/**
 * The administrators' world, served by an app whose quota settings name these
 * plans — `free` and `pro` unless a case says otherwise.
 */
async function planWorld(seats = "free=2,pro=5"): Promise<AdminWorld> {
  const w = await adminWorld();
  const app = createApp(w.storage, w.db, {
    quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: seats }),
  });
  return { ...w, app };
}

function assignPlan(
  app: World["app"],
  id: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.request(`/api/admin/accounts/${id}/plan`, {
    method: "PUT",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("deleting an account with SKRUN_DELETION_JOURNAL", () => {
  // The file's own afterEach restores the spies.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("set to true, the self route records the account in the app's store: one empty object, kept once the account is gone", async () => {
    vi.stubEnv("SKRUN_DELETION_JOURNAL", "true");
    const w = await world();

    const res = await deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" });

    expect(res.status).toBe(200);
    expect(await w.storage.list("_deletions/")).toEqual([`_deletions/account/${w.alice.id}`]);
    expect((await w.storage.get(`_deletions/account/${w.alice.id}`))?.length).toBe(0);
    await expectAliceGone(w);
  });

  it("set to true, the admin route records the account it deletes, and only it", async () => {
    vi.stubEnv("SKRUN_DELETION_JOURNAL", "true");
    const w = await adminWorld();

    const res = await deleteOther(w.app, w.alice.id, cookie(w.adminSession), { confirm: "alice" });

    expect(res.status).toBe(200);
    expect(await w.storage.list("_deletions/")).toEqual([`_deletions/account/${w.alice.id}`]);
  });

  it("set to true, a record the store cannot write refuses the deletion with today's 503, and touches nothing", async () => {
    vi.stubEnv("SKRUN_DELETION_JOURNAL", "true");
    const w = await world();
    vi.spyOn(w.storage, "put").mockRejectedValue(new Error("store unreachable"));
    const deletes = vi.spyOn(w.storage, "delete");

    const res = await deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "STORAGE_UNAVAILABLE",
        message:
          "Object storage could not be reached. The account still exists, and some of its " +
          "stored objects may already be deleted; send the same request again to finish.",
      },
    });
    expect(deletes).not.toHaveBeenCalled();
    await expectAliceIntact(w);
  });

  it.each([
    ["unset", undefined],
    ["set to false", "false"],
  ])("%s, a deletion records nothing", async (_label, value) => {
    if (value !== undefined) vi.stubEnv("SKRUN_DELETION_JOURNAL", value);
    const w = await world();
    const puts = vi.spyOn(w.storage, "put");

    const res = await deleteAccount(w.app, bearer(w.fullKey), { confirm: "alice" });

    expect(res.status).toBe(200);
    expect(puts).not.toHaveBeenCalled();
    expect(await w.storage.list("_deletions/")).toEqual([]);
  });

  it("set to anything but true or false, the app refuses to be built, naming the variable", () => {
    vi.stubEnv("SKRUN_DELETION_JOURNAL", "maybe");

    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      'SKRUN_DELETION_JOURNAL must be true or false (got "maybe"). Unset it to keep no deletion journal.',
    );
  });
});

/** Which of `ids` a spied account lookup was asked for. */
function targetsRead(reads: { mock: { calls: unknown[][] } }, ids: string[]): string[] {
  return reads.mock.calls.map(([id]) => String(id)).filter((id) => ids.includes(id));
}

/** The `account_plan_changed` lines written so far. */
function planLines(): Array<Record<string, unknown>> {
  return logInfoSpy.mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((fields) => fields?.event === "account_plan_changed");
}

describe("PUT /api/admin/accounts/:id/plan — who may assign a plan", () => {
  it("an administrator on a master credential assigns it: 200, the plan written, one line with the two internal ids and both plans", async () => {
    const w = await planWorld();
    const res = await assignPlan(w.app, w.alice.id, cookie(w.adminSession), { plan: "pro" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: w.alice.id, plan: "pro" });
    expect((await w.db.getUserById(w.alice.id))?.plan).toBe("pro");
    expect(planLines()).toEqual([
      {
        event: "account_plan_changed",
        actor_id: w.admin.id,
        user_id: w.alice.id,
        from: "free",
        to: "pro",
      },
    ]);
    // Internal ids only: neither username is in any line.
    const all = JSON.stringify(logInfoSpy.mock.calls);
    for (const name of ["alice", "carol"]) expect(all).not.toContain(name);
  });

  it("a caller who is not an administrator, or holds an administrator's delegated key, gets the admin routes' opaque 404, whatever it sends", async () => {
    const w = await planWorld();
    const callers: Array<[string, Record<string, string>]> = [
      ["a signed-in user", fromPage(w.bobSession)],
      ["a user's key with every operation", bearer(w.fullKey)],
      ["an administrator's delegated key", bearer(w.adminDelegatedKey)],
    ];
    const requests: Array<[string, unknown]> = [
      [w.alice.id, { plan: "pro" }],
      [w.alice.id, { plan: "ghost" }],
      [w.alice.id, undefined],
      ["not-a-uuid", { plan: "pro" }],
      [UNKNOWN_ID, { plan: "pro" }],
    ];
    for (const [label, headers] of callers) {
      const pool = await answer(await w.app.request("/api/admin/pool", { headers }));
      expect(pool.status, label).toBe(404);
      for (const [id, body] of requests) {
        const res = await answer(await assignPlan(w.app, id, headers, body));
        expect(res, `${label}: ${id} ${JSON.stringify(body)}`).toEqual(pool);
      }
    }
    expect((await w.db.getUserById(w.alice.id))?.plan).toBe("free");
    expect(planLines()).toEqual([]);
  });

  it("an administrator's key with fewer operations is refused 403 — after the id's shape, before the plan", async () => {
    const w = await planWorld();
    const refused = await assignPlan(w.app, w.alice.id, bearer(w.adminReducedKey), {
      plan: "ghost",
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("KEY_SCOPE_FORBIDDEN");
    // A malformed id is judged first: the same key gets the opaque 404.
    const malformed = await assignPlan(w.app, "not-a-uuid", bearer(w.adminReducedKey), {
      plan: "pro",
    });
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual(NOT_FOUND_BODY);
    expect((await w.db.getUserById(w.alice.id))?.plan).toBe("free");
  });
});

describe("PUT /api/admin/accounts/:id/plan — the plan and the target", () => {
  it("a plan the settings do not name is refused 400 UNKNOWN_PLAN, which names the known plans — an absent one too, and before the account is looked for", async () => {
    const w = await planWorld();
    const reads = vi.spyOn(w.db, "getUserById");
    const cases: Array<[string, unknown, string]> = [
      [w.alice.id, { plan: "ghost" }, 'Unknown plan "ghost". Known plans: free, pro.'],
      [w.alice.id, { plan: "" }, 'Unknown plan "". Known plans: free, pro.'],
      [
        w.alice.id,
        { plan: 5 },
        'Send {"plan": "<name>"} as the JSON body. Known plans: free, pro.',
      ],
      [w.alice.id, {}, 'Send {"plan": "<name>"} as the JSON body. Known plans: free, pro.'],
      [UNKNOWN_ID, { plan: "ghost" }, 'Unknown plan "ghost". Known plans: free, pro.'],
    ];
    for (const [id, body, message] of cases) {
      const res = await assignPlan(w.app, id, cookie(w.adminSession), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "UNKNOWN_PLAN", message } });
    }
    // The session is looked up; neither target ever is.
    expect(targetsRead(reads, [w.alice.id, UNKNOWN_ID])).toEqual([]);
    expect((await w.db.getUserById(w.alice.id))?.plan).toBe("free");
    expect(planLines()).toEqual([]);
  });

  it("a plan sent in capitals is written in lower case", async () => {
    const w = await planWorld();
    const res = await assignPlan(w.app, w.alice.id, cookie(w.adminSession), { plan: " PRO " });
    expect(res.status).toBe(200);
    expect((await w.db.getUserById(w.alice.id))?.plan).toBe("pro");
    expect(planLines()).toMatchObject([{ from: "free", to: "pro" }]);
  });

  it("a malformed id is a 404 before anything is read; a well-formed id no account has, a 404 once the plan is known", async () => {
    const w = await planWorld();
    const reads = vi.spyOn(w.db, "getUserById");
    for (const id of ["not-a-uuid", "1", `${w.alice.id}x`]) {
      const res = await assignPlan(w.app, id, cookie(w.adminSession), { plan: "pro" });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND_BODY);
    }
    // The session is looked up; no malformed id ever is.
    expect(targetsRead(reads, ["not-a-uuid", "1", `${w.alice.id}x`])).toEqual([]);

    const unknown = await assignPlan(w.app, UNKNOWN_ID, cookie(w.adminSession), { plan: "pro" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(NOT_FOUND_BODY);
    expect(planLines()).toEqual([]);
  });

  it("with three plans set, the third is assignable — a plan more takes no code", async () => {
    const w = await planWorld("free=2,pro=5,team=10");
    const res = await assignPlan(w.app, w.bob.id, cookie(w.adminSession), { plan: "team" });
    expect(res.status).toBe(200);
    expect((await w.db.getUserById(w.bob.id))?.plan).toBe("team");

    const refused = await assignPlan(w.app, w.bob.id, cookie(w.adminSession), { plan: "ghost" });
    expect(await refused.json()).toMatchObject({
      error: { message: 'Unknown plan "ghost". Known plans: free, pro, team.' },
    });
  });

  it("with no plan set, only the default one is assignable", async () => {
    const w = await adminWorld();
    const app = createApp(w.storage, w.db, { quotaConfig: parseQuotaEnv({}) });
    const refused = await assignPlan(app, w.alice.id, cookie(w.adminSession), { plan: "pro" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: { code: "UNKNOWN_PLAN", message: 'Unknown plan "pro". Known plans: free.' },
    });
    const res = await assignPlan(app, w.alice.id, cookie(w.adminSession), { plan: "free" });
    expect(res.status).toBe(200);
  });
});
