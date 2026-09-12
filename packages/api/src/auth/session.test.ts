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
  SESSION_COOKIE_NAME,
  SESSION_SWEEP_INTERVAL_MS,
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

  it("SESSION_COOKIE_NAME is skrun_session", () => {
    expect(SESSION_COOKIE_NAME).toBe("skrun_session");
  });

  // RT-4 (#124): the cookie options themselves did not change — only the value
  // maxAge derives from. The last two assertions are the boundary with the
  // cross-subdomain handoff that comes next: no domain attribute, and a plain
  // cookie name with no __Host-/__Secure- prefix. A boundary no test guards is
  // not a boundary, and both of those would be silent to change.
  it("RT-4 (#124): the cookie options are unchanged, carry no domain and no name prefix", () => {
    const opts = getSessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("Lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(604800);

    // secure is conditional, and stays conditional.
    const previousEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      expect(getSessionCookieOptions().secure).toBe(false);
      process.env.NODE_ENV = "production";
      expect(getSessionCookieOptions().secure).toBe(true);
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }

    expect(opts).not.toHaveProperty("domain");
    expect(SESSION_COOKIE_NAME).toBe("skrun_session");
    expect(SESSION_COOKIE_NAME.startsWith("__")).toBe(false);
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
