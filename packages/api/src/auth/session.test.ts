import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
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
    vi.unstubAllEnvs();
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
  // maxAge derives from. The last assertions were the boundary with the
  // cross-subdomain handoff: no domain attribute, and a plain cookie name. The
  // name half of that boundary has moved twice since, so the guard is rewritten
  // rather than removed — a frontier whose sentry is deleted along with it is a
  // frontier everyone still believes in. Unconfigured production keeps every
  // OPTION #124 pinned and no domain, but its name is now host-locked; the
  // configured one gains a domain and the transport prefix instead.
  it("RT-4 (#124): unconfigured, the cookie options are unchanged and the name is host-locked — configured, it takes the domain", () => {
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

      // Production with nothing configured: still host-only, and the name is the
      // host-locking one — the prefix a sibling host of the zone cannot set here.
      expect(getSessionCookieOptions()).not.toHaveProperty("domain");
      expect(sessionCookieName()).toBe("__Host-skrun_session");

      // And the crossing itself, so the guard says where the frontier moved to:
      // the domain is what puts a Domain on the cookie, and it swaps the prefix
      // for the one that allows a Domain.
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

  // The session lifetime is also the cookie's Max-Age, which hono refuses to
  // write past 400 days, and far enough out the stored expiry is no date at all.
  // Past 400 days the setting is read as 400 days, by both of its readers: the
  // value at the cap is taken as it is, the next one is capped. The huge value is
  // written in digits — Number.parseInt reads "1e13" as 1.
  it.each([
    ["34559999", 34_559_999],
    ["34560000", 34_560_000],
    ["34560001", 34_560_000],
    ["63072000", 34_560_000],
    ["10000000000000", 34_560_000],
  ] as const)("SESSION_TTL_S=%s is read as %i seconds, by the stored expiry and by the cookie", async (configured, seconds) => {
    vi.stubEnv("SESSION_TTL_S", configured);

    const before = Date.now();
    const created = createSession(db, "user-cap");
    await expect(created).resolves.toEqual(expect.any(String));
    const after = Date.now();

    expect(getSessionCookieOptions().maxAge).toBe(seconds);

    const row = await db.getSession(hashSessionId(await created));
    const expiresMs = Date.parse(row?.expires_at ?? "");
    expect(expiresMs).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + seconds * 1000);
  });
});

// The name and the Domain attribute are decided by two independent settings —
// the environment and the configured domain — so the interesting thing is the
// GRID, not any one cell. Only the domain cells may carry a Domain attribute,
// and only the production cells may carry a prefix.
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

  // The name over the whole grid, one label per cell. Outside production there
  // is no Secure flag, so no prefix is possible. In production the name is
  // always prefixed, and the domain only chooses which prefix: host-locking
  // without one (a sibling host of the zone can no longer plant the cookie),
  // the transport prefix with one (host-locking forbids a Domain attribute).
  it("VT-1 (#125): the name across the four cells of environment × domain", () => {
    const cells: Array<[string, string | undefined, string]> = [
      ["development", undefined, "skrun_session"],
      ["development", "example.com", "skrun_session"],
      ["production", undefined, "__Host-skrun_session"],
      ["production", "example.com", "__Secure-skrun_session"],
    ];
    for (const [env, domain, expected] of cells) {
      process.env.NODE_ENV = env;
      if (domain === undefined) {
        delete process.env.SKRUN_PUBLIC_URL;
        delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
      } else {
        process.env.SKRUN_PUBLIC_URL =
          env === "production" ? "https://api.example.com" : "http://api.example.com";
        process.env.SKRUN_SESSION_COOKIE_DOMAIN = domain;
      }
      const label = `${env} × ${domain ?? "no domain"}`;
      expect(sessionCookieName(), label).toBe(expected);
      if (domain === undefined) {
        expect(getSessionCookieOptions(), label).not.toHaveProperty("domain");
      }
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

  // The erasure factory is what a sign-out loops over. Its rule is uniform —
  // every name the cookie can carry × every addressable scope — and its filter is
  // what makes it legal: hono throws on a prefixed name without Secure and on a
  // __Host- name with a Domain, in production only. The exact list per cell is
  // pinned, order included; the sign-out cases in routes/auth.test.ts exercise it
  // through real setCookie calls.
  it("VT-3 (#125): the erasure list is one, two, three or five entries, and every one of them is legal", () => {
    const cells: Array<[string, string | undefined, string[]]> = [
      ["development", undefined, ["skrun_session|-"]],
      ["development", "example.com", ["skrun_session|-", "skrun_session|example.com"]],
      [
        "production",
        undefined,
        ["skrun_session|-", "__Host-skrun_session|-", "__Secure-skrun_session|-"],
      ],
      [
        "production",
        "example.com",
        [
          "skrun_session|-",
          "skrun_session|example.com",
          "__Host-skrun_session|-",
          "__Secure-skrun_session|-",
          "__Secure-skrun_session|example.com",
        ],
      ],
    ];
    for (const [env, domain, expected] of cells) {
      process.env.NODE_ENV = env;
      if (domain === undefined) {
        delete process.env.SKRUN_PUBLIC_URL;
        delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
      } else {
        process.env.SKRUN_PUBLIC_URL =
          env === "production" ? "https://api.example.com" : "http://api.example.com";
        process.env.SKRUN_SESSION_COOKIE_DOMAIN = domain;
      }
      const label = `${env} × ${domain ?? "no domain"}`;
      const erasures = sessionCookieErasures();
      expect(
        erasures.map((e) => `${e.name}|${e.options.domain ?? "-"}`),
        label,
      ).toEqual(expected);
      // The half that makes every one of these calls legal rather than lucky.
      for (const e of erasures) {
        expect(e.options.secure, `${label} ${e.name}`).toBe(env === "production");
        expect(e.options.maxAge, `${label} ${e.name}`).toBe(0);
        expect(e.options.path, `${label} ${e.name}`).toBe("/");
        if (e.name.startsWith("__Host-")) {
          expect(e.options, `${label} ${e.name}`).not.toHaveProperty("domain");
        }
      }
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
      // Read as a syntax tree: a call commented out is no call, and a comment
      // holding `/*` cannot hide the code after it.
      const file = ts.createSourceFile(
        entry,
        readFileSync(join(srcDir, entry), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      let calls = false;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "startSessionSweep"
        ) {
          calls = true;
        }
        if (!calls) ts.forEachChild(node, visit);
      };
      visit(file);
      expect(calls, entry).toBe(true);
    }
  });
});
