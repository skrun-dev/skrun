import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { SqliteDb } from "../db/sqlite.js";
import {
  createSession,
  destroySession,
  getSessionCookieOptions,
  hashSessionId,
  SESSION_SWEEP_INTERVAL_MS,
  sessionCookieDomain,
  sessionCookieErasures,
  sessionCookieName,
  startSessionSweep,
  validateSession,
} from "./session.js";

describe("Session Management", () => {
  let db: MemoryDb;

  beforeEach(() => {
    // A fresh adapter per test is the whole isolation story now: the store is
    // the database, so there is nothing module-level left to reset.
    db = new MemoryDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createSession returns a UUID session ID", async () => {
    const id = await createSession(db, "user-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("validateSession returns userId for valid session", async () => {
    const sessionId = await createSession(db, "user-42");
    expect(await validateSession(db, sessionId)).toBe("user-42");
  });

  it("validateSession returns null for unknown session", async () => {
    expect(await validateSession(db, "nonexistent-id")).toBeNull();
  });

  it("validateSession returns null for expired session", async () => {
    const sessionId = await createSession(db, "user-1");

    // Advance time past the default TTL (7 days)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 604800 * 1000 + 1000);

    expect(await validateSession(db, sessionId)).toBeNull();
  });

  it("destroySession removes the session", async () => {
    const sessionId = await createSession(db, "user-1");
    expect(await validateSession(db, sessionId)).toBe("user-1");

    await destroySession(db, sessionId);
    expect(await validateSession(db, sessionId)).toBeNull();
  });

  it("destroySession is a no-op for unknown session", async () => {
    // Should not throw
    await destroySession(db, "nonexistent-id");
  });

  // The constant of #124 became a function here, so the guard follows it rather
  // than disappearing with it: with nothing configured — the self-host default —
  // the name is still the literal that every doc, every browser session and
  // every existing test knows.
  it("the session cookie name is skrun_session when nothing is configured", () => {
    expect(sessionCookieName()).toBe("skrun_session");
  });

  // RT-4 (#124): the cookie options themselves did not change — only the value
  // maxAge derives from. The last assertions were the boundary with this
  // cross-subdomain handoff: no domain attribute, and a plain cookie name with no
  // __Host-/__Secure- prefix. That boundary is now crossed, so the guard is
  // rewritten rather than removed — a frontier whose sentry is deleted along with
  // it is a frontier everyone still believes in. It now guards BOTH sides: the
  // unconfigured deployment keeps every value #124 pinned, and the configured one
  // is the only one that gains a domain and a prefix.
  it("RT-4 (#124): unconfigured, the cookie options and name are unchanged — configured, they are not", () => {
    const previousEnv = process.env.NODE_ENV;
    const previousDomain = process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    try {
      delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;

      const opts = getSessionCookieOptions();
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe("Lax");
      expect(opts.path).toBe("/");
      expect(opts.maxAge).toBe(604800);

      // secure is conditional, and stays conditional.
      process.env.NODE_ENV = "development";
      expect(getSessionCookieOptions().secure).toBe(false);
      process.env.NODE_ENV = "production";
      expect(getSessionCookieOptions().secure).toBe(true);

      // Still true in production with nothing configured — the self-host promise.
      expect(getSessionCookieOptions()).not.toHaveProperty("domain");
      expect(sessionCookieName()).toBe("skrun_session");
      expect(sessionCookieName().startsWith("__")).toBe(false);

      // And the crossing itself, so the guard says where the frontier moved to:
      // the domain is what puts a prefix on the name and a Domain on the cookie.
      process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
      expect(getSessionCookieOptions()).toHaveProperty("domain", "example.com");
      expect(sessionCookieName()).toBe("__Secure-skrun_session");
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
      if (previousDomain === undefined) delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
      else process.env.SKRUN_SESSION_COOKIE_DOMAIN = previousDomain;
    }
  });

  // VT-10 (#124): what reaches the table is the hash, never the cookie value.
  it("VT-10 (#124): the stored identifier is the SHA-256 of the cookie value", async () => {
    const raw = await createSession(db, "user-h");

    // Present: the row keyed by the hash. Absent: any row keyed by the raw id.
    const byHash = await db.getSession(hashSessionId(raw));
    expect(byHash).not.toBeNull();
    expect(byHash?.user_id).toBe("user-h");
    expect(await db.getSession(raw)).toBeNull();

    // And the stored key really is that hash — not merely "something else".
    expect(byHash?.id_hash).not.toBe(raw);
    expect(byHash?.id_hash).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  // VT-11 (#124): expiry both refuses the session AND removes the row. The
  // second half matters on its own: a validate that answered null while
  // leaving the row would keep an expired credential on disk for ever.
  it("VT-11 (#124): an expired session is refused and its row is deleted", async () => {
    const raw = await createSession(db, "user-e");
    const idHash = hashSessionId(raw);
    expect(await db.getSession(idHash)).not.toBeNull();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 604800 * 1000 + 1000);

    expect(await validateSession(db, raw)).toBeNull();
    expect(await db.getSession(idHash)).toBeNull();
  });

  // RT-5 (#124): SESSION_TTL_S is honoured, and a missing or nonsense value
  // falls back to the default rather than producing a session that never
  // expires or expires instantly.
  it("RT-5 (#124): SESSION_TTL_S drives the expiry, invalid values fall back", async () => {
    const previous = process.env.SESSION_TTL_S;
    try {
      process.env.SESSION_TTL_S = "60";
      const before = Date.now();
      const raw = await createSession(db, "user-ttl");
      const row = await db.getSession(hashSessionId(raw));
      const ttlMs = new Date(row?.expires_at ?? 0).getTime() - before;
      expect(ttlMs).toBeGreaterThan(55_000);
      expect(ttlMs).toBeLessThan(65_000);
      expect(getSessionCookieOptions().maxAge).toBe(60);

      for (const bad of ["not-a-number", "0", "-1"]) {
        process.env.SESSION_TTL_S = bad;
        expect(getSessionCookieOptions().maxAge, `SESSION_TTL_S=${bad}`).toBe(604800);
      }

      delete process.env.SESSION_TTL_S;
      expect(getSessionCookieOptions().maxAge).toBe(604800);
    } finally {
      if (previous === undefined) delete process.env.SESSION_TTL_S;
      else process.env.SESSION_TTL_S = previous;
    }
  });
});

// The name and the Domain attribute are decided by two independent settings —
// the environment and the configured domain — so the interesting thing is the
// GRID, not any one cell. Three of its four cells must leave the cookie exactly
// as it was before this element, and only the fourth may change anything.
//
// Note on the fixtures: only SKRUN_SESSION_COOKIE_DOMAIN is read by the two
// functions under test. SKRUN_PUBLIC_URL is set alongside it because the two
// always travel together in a real deployment (the startup interlock refuses one
// without the other), and a fixture that could not exist in production is a
// fixture that proves less than it looks.
describe("the session cookie name and domain across the configuration grid (#123)", () => {
  const KEYS = ["NODE_ENV", "SKRUN_PUBLIC_URL", "SKRUN_SESSION_COOKIE_DOMAIN"] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  // VT-1 — nothing configured. The whole "self-host is untouched" promise lives
  // in this case, and it has to hold in PRODUCTION too: the published image runs
  // with NODE_ENV=production, so a prefix that followed the Secure flag alone
  // would rename the cookie of every self-hoster who configured nothing and log
  // them all out once.
  it("VT-1: with no domain configured the cookie is unchanged, in development AND in production", () => {
    for (const env of ["development", "production"]) {
      process.env.NODE_ENV = env;
      expect(sessionCookieName(), env).toBe("skrun_session");
      expect(getSessionCookieOptions(), env).not.toHaveProperty("domain");
    }
  });

  // VT-2 — the one cell that changes: a domain in production.
  it("VT-2: a configured domain in production carries the Domain attribute and the __Secure- prefix", () => {
    process.env.NODE_ENV = "production";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "Example.COM";

    const opts = getSessionCookieOptions();
    expect(opts.domain).toBe("example.com");
    expect(opts.secure).toBe(true);
    expect(sessionCookieName()).toBe("__Secure-skrun_session");
  });

  // VT-3 — a domain OUTSIDE production. The prefix must stay off: a browser
  // rejects a __Secure- cookie that arrives without the Secure flag, and over
  // plain http the flag cannot be set. A prefix that followed the domain alone
  // would break the sign-in of every contributor running the stack locally —
  // and break it silently, since nothing throws.
  it("VT-3: a configured domain outside production keeps the Domain but not the prefix", () => {
    process.env.NODE_ENV = "development";
    process.env.SKRUN_PUBLIC_URL = "http://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";

    const opts = getSessionCookieOptions();
    expect(opts.domain).toBe("example.com");
    expect(opts.secure).toBe(false);
    expect(sessionCookieName()).toBe("skrun_session");
  });

  // VT-4 — the leading dot. Older guides teach ".example.com"; the cookie spec
  // ignores the dot (RFC 6265 §5.2.3), so it is dropped rather than refused, and
  // the cookie still covers the subdomains.
  it("VT-4: a leading dot is normalised away", () => {
    process.env.NODE_ENV = "production";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = ".example.com";

    expect(getSessionCookieOptions().domain).toBe("example.com");
    expect(sessionCookieDomain()).toBe("example.com");
  });

  // The erasure factory is what a sign-out loops over, and its SIZE is the whole
  // point: it is bounded by what is configured, and every prefixed entry carries
  // the Secure flag that makes the write legal. Getting this wrong throws at
  // serialisation time, in production only — see the sign-out cases in
  // routes/auth.test.ts, which exercise it through real setCookie calls.
  it("the erasure list is one, two or four entries, and every one of them is legal", () => {
    process.env.NODE_ENV = "production";
    expect(sessionCookieErasures()).toEqual([
      { name: "skrun_session", options: { maxAge: 0, path: "/", secure: true } },
    ]);

    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";

    process.env.NODE_ENV = "development";
    const unprefixed = sessionCookieErasures();
    expect(unprefixed).toHaveLength(2);
    expect(unprefixed.every((e) => e.name === "skrun_session")).toBe(true);
    expect(unprefixed.map((e) => e.options.domain)).toEqual([undefined, "example.com"]);

    process.env.NODE_ENV = "production";
    const prefixed = sessionCookieErasures();
    expect(prefixed).toHaveLength(4);
    expect(prefixed.map((e) => `${e.name}|${e.options.domain ?? "-"}`)).toEqual([
      "skrun_session|-",
      "skrun_session|example.com",
      "__Secure-skrun_session|-",
      "__Secure-skrun_session|example.com",
    ]);
    // The half that makes every one of these calls legal rather than lucky.
    expect(prefixed.every((e) => e.options.secure === true)).toBe(true);
    expect(prefixed.every((e) => e.options.maxAge === 0 && e.options.path === "/")).toBe(true);
  });
});

// VT-9 (#124) — the case the old code could not pass, and the reason this
// element exists. It needs TWO things, and only both together prove anything:
//
//   1. Two adapter instances over the SAME sqlite file, so "created here,
//      validated there" is a real crossing rather than one object talking to
//      itself.
//   2. Two LOADS of session.ts. An ES module is a singleton per process, and
//      the store this element removed lived at module level — so two adapters
//      would have shared it, and a create-on-A / validate-on-B test would have
//      stayed green with that store in place. Re-importing the module after
//      vi.resetModules() gives the second half a module whose module-level
//      state, if any were reintroduced, is empty.
//
// Without the second load this test proves nothing at all. Keep both halves.
describe("VT-9 (#124): a session created on one instance validates on another", () => {
  let dbPath: string;

  beforeEach(() => {
    // A unique path per test: the WAL file lingers on Windows and a reused
    // name then fails with EPERM.
    dbPath = join(
      tmpdir(),
      `skrun-session-vt9-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = dbPath + ext;
      if (existsSync(p)) {
        try {
          rmSync(p, { force: true });
        } catch {
          // ignore EPERM on Windows when the DB handle hasn't released yet
        }
      }
    }
  });

  it("a raw cookie minted through one adapter is accepted through a second one", async () => {
    const a = new SqliteDb(dbPath);
    const b = new SqliteDb(dbPath);
    try {
      // The FK requires the user to exist before the session does.
      const user = await a.createUser({ github_id: "gh-vt9", username: "vt9" });

      const raw = await createSession(a, user.id); // module load no. 1

      vi.resetModules();
      const reloaded = await import("./session.js"); // module load no. 2

      expect(await reloaded.validateSession(b, raw)).toBe(user.id);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("VT-14 (#124): the recurring sweep of expired sessions", () => {
  let db: MemoryDb;

  beforeEach(() => {
    db = new MemoryDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("VT-14 (#124): one interval later, what expired is gone and what did not is intact", async () => {
    const past = (ms: number) => new Date(Date.now() - ms).toISOString();
    await db.createSession({ id_hash: "sweep-expired-1", user_id: "u-1", expires_at: past(1_000) });
    await db.createSession({
      id_hash: "sweep-expired-2",
      user_id: "u-2",
      expires_at: past(SESSION_SWEEP_INTERVAL_MS),
    });
    await db.createSession({
      id_hash: "sweep-fresh",
      user_id: "u-3",
      expires_at: new Date(Date.now() + 24 * SESSION_SWEEP_INTERVAL_MS).toISOString(),
    });

    const timer = startSessionSweep(db);
    try {
      // The first pass runs at startup, not an interval later. Were it only on
      // the interval, a process coming up shortly before a row's hour was up
      // would leave that row until an hour after boot — and a restart is the
      // ordinary case. The purge is asynchronous inside a synchronous callback,
      // so the clock has to be advanced in a way that also drains the
      // microtask; reading without that would happen before the delete and fail
      // for the wrong reason.
      await vi.advanceTimersByTimeAsync(0);

      expect(await db.getSession("sweep-expired-1")).toBeNull();
      expect(await db.getSession("sweep-expired-2")).toBeNull();
      expect(await db.getSession("sweep-fresh")).not.toBeNull();

      // And it keeps going: a row that expires after startup is gone one
      // interval later, not left for the next restart.
      await db.createSession({
        id_hash: "sweep-later",
        user_id: "u-4",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      await vi.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);

      expect(await db.getSession("sweep-later")).toBeNull();
      expect(await db.getSession("sweep-fresh")).not.toBeNull();

      // Asserted last, deliberately: a case stops at its first failing
      // assertion, and were this one first, a regression here would hide
      // whether the sweep above still worked. An unref'd timer is what keeps a
      // test run or a CLI from hanging on it, and hasRef is how that is seen.
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  // VT-14b (#124): a guard that is never wired never runs. The case above calls
  // the starter directly, so it would stay green even if nothing in the product
  // ever started a sweep — and the retention window would quietly become a
  // claim with nothing behind it. These two files are the only places that run
  // a server, so they are the two places to check.
  it("VT-14b (#124): both server entry points start the sweep", () => {
    const srcDir = join(import.meta.dirname, "..");
    for (const entry of ["server.ts", "dev.ts"]) {
      const source = readFileSync(join(srcDir, entry), "utf8");
      expect(source, entry).toContain("startSessionSweep(");
    }
  });
});
