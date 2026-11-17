import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import type { DbAdapter } from "../db/adapter.js";
import { errorFields } from "../utils/error-fields.js";

const logger = createLogger("session");

/**
 * The cookie name before any prefix. Not exported: a caller that reads this
 * instead of `sessionCookieName()` would be right in exactly the configurations
 * where the prefix is off, and silently wrong in the one where it is on.
 */
const BASE_SESSION_COOKIE_NAME = "skrun_session";

const DEFAULT_SESSION_TTL_S = 604800; // 7 days

/**
 * The longest session `SESSION_TTL_S` can set: 400 days. The same value is the
 * session cookie's Max-Age, and hono's `setCookie` throws past 400 days — the
 * limit browsers put on a cookie's lifetime — so a longer setting would fail
 * every web sign-in. Lower than the other duration settings' cap for that
 * reason; it also keeps the stored expiry a date with a four-digit year. A
 * larger value is read as this one.
 */
const SESSION_TTL_MAX_S = 400 * 86_400;

/**
 * The session lifetime, in milliseconds, from `SESSION_TTL_S` — the one reader
 * of the setting, for the stored expiry and the cookie alike. At most
 * `SESSION_TTL_MAX_S`.
 */
function getTtlMs(): number {
  const raw = process.env.SESSION_TTL_S;
  if (!raw) return DEFAULT_SESSION_TTL_S * 1000;
  const parsed = Number.parseInt(raw, 10);
  const seconds = Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_SESSION_TTL_S : parsed;
  return Math.min(seconds, SESSION_TTL_MAX_S) * 1000;
}

/**
 * SHA-256 hex of a raw session id — what we store. The raw id lives only in
 * the browser cookie, so a read of the `sessions` table yields nothing usable
 * as a credential. Same form as the API-key and device-code hashes.
 */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/**
 * Create a new session for a user. Returns the raw session ID — the value that
 * goes in the cookie. Only its hash reaches the database.
 */
export async function createSession(db: DbAdapter, userId: string): Promise<string> {
  const sessionId = randomUUID();
  await db.createSession({
    id_hash: hashSessionId(sessionId),
    user_id: userId,
    expires_at: new Date(Date.now() + getTtlMs()).toISOString(),
  });
  return sessionId;
}

/**
 * Validate a session ID. Returns the userId if valid and not expired, null otherwise.
 *
 * The expiry decision is taken here, once, for all three backends: `getSession`
 * hands back an expired row like any other, and this is what deletes it.
 */
export async function validateSession(db: DbAdapter, sessionId: string): Promise<string | null> {
  const idHash = hashSessionId(sessionId);
  const session = await db.getSession(idHash);
  if (!session) return null;
  if (Date.now() > new Date(session.expires_at).getTime()) {
    await db.deleteSession(idHash);
    return null;
  }
  return session.user_id;
}

/**
 * Destroy a session.
 */
export async function destroySession(db: DbAdapter, sessionId: string): Promise<void> {
  await db.deleteSession(hashSessionId(sessionId));
}

/**
 * How often each instance deletes the sessions that have expired.
 *
 * Hard-coded, and it has to stay that way: the retention window is a published
 * statement, and a window an operator could widen from the environment would
 * make that statement false without anyone touching this file.
 */
export const SESSION_SWEEP_INTERVAL_MS = 3_600_000; // 1 hour

/**
 * Start the recurring sweep of expired sessions. Every instance sweeps; two
 * concurrent deletes of the same expired rows are harmless.
 *
 * Call it once a server is actually being run — never from the app factory,
 * which every test also calls.
 *
 * Returns its timer so a caller can observe it and stop it.
 */
export function startSessionSweep(db: DbAdapter): NodeJS.Timeout {
  const sweep = () => {
    // The sweep swallows its own failure into a log. That is the opposite of
    // what the request path does with a session lookup, where a database error
    // answers 500, and the asymmetry is deliberate: a request has someone
    // waiting for an answer, a background sweep has not — and a rejection from
    // a timer callback would take the whole process down, which would turn a
    // transient database blip into an outage.
    void db.purgeExpiredSessions().catch((err) => {
      logger.error(
        { event: "session_sweep_failed", ...errorFields(err) },
        "Expired-session sweep failed",
      );
    });
  };

  // Once at startup, and only then on the interval. Without this first pass the
  // window a restart opens is nearly two intervals wide: a process coming up
  // fifty-five minutes after a row expired would leave it until an hour after
  // boot. A rolling deploy is the ordinary case, not the rare one, so the
  // retention window stated to users would be wrong on an ordinary day.
  sweep();

  const timer = setInterval(sweep, SESSION_SWEEP_INTERVAL_MS);

  // Never the reason a process stays alive — a test run or a CLI must still end
  // on its own.
  timer.unref();
  return timer;
}

/**
 * Whether the cookie carries the `Secure` flag. One reader, so the name and the
 * options can never disagree about it — and the name depends on it, because a
 * browser rejects a `__Host-` or `__Secure-` cookie that arrives without the
 * flag (and hono refuses to write one).
 */
export function isSecureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The `Domain` attribute of the session cookie, normalised — or `undefined`
 * when no domain is configured, which is the default and leaves the cookie
 * host-only. The scope is the same as before a domain existed; in production
 * the name is not (see `sessionCookieName()`).
 *
 * This is THE normalisation of `SKRUN_SESSION_COOKIE_DOMAIN`, and the startup
 * interlock in `index.ts` validates the value it returns. That is the point: the
 * value that is *validated* at boot and the value that is *written* on the
 * cookie are the same string, so a `trim` on one side and not the other cannot
 * let the interlock approve a domain the cookie will never use.
 *
 * A leading dot is what older guides teach and what the cookie spec ignores
 * (RFC 6265 §5.2.3), so it is dropped rather than refused.
 */
export function sessionCookieDomain(): string | undefined {
  const raw = process.env.SKRUN_SESSION_COOKIE_DOMAIN?.trim();
  if (!raw) return undefined;
  return raw.toLowerCase().replace(/^\.+/, "") || undefined;
}

/**
 * The session cookie's name — three states, decided by two facts:
 *
 *   - outside production (no `Secure` flag): the bare name. A browser rejects a
 *     prefixed cookie that arrives without `Secure`, so any prefix here would
 *     break local http development for every contributor;
 *   - in production with no cookie domain: `__Host-`. The prefix pins the cookie
 *     to this exact host and to `Path=/`, so another host of the same DNS zone
 *     can set that name only for itself — never for this API. The bare name it
 *     CAN still set on the parent domain is no longer read here, so planting a
 *     session through a sibling host is impossible rather than refused;
 *   - in production with a cookie domain: `__Secure-`. `__Host-` forbids a
 *     `Domain` attribute, and the configured domain is the whole point of that
 *     deployment, so the transport prefix is the strongest one it can carry.
 *
 * Production is therefore always prefixed; the domain only chooses WHICH prefix.
 */
export function sessionCookieName(): string {
  if (!isSecureCookie()) return BASE_SESSION_COOKIE_NAME;
  return sessionCookieDomain() === undefined
    ? `__Host-${BASE_SESSION_COOKIE_NAME}`
    : `__Secure-${BASE_SESSION_COOKIE_NAME}`;
}

/**
 * Cookie options for the session cookie.
 *
 * `domain` is present only when one is configured — never `domain: undefined`,
 * which serialises badly and which the boundary case in session.test.ts checks.
 */
export function getSessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  path: string;
  maxAge: number;
  domain?: string;
} {
  const domain = sessionCookieDomain();
  return {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(getTtlMs() / 1000),
    ...(domain === undefined ? {} : { domain }),
  };
}

/**
 * Whether hono will serialise this cookie at all — the library's own rule,
 * restated so the erasure list can leave out what it would refuse. `setCookie`
 * THROWS (hono `utils/cookie.js` `_serialize`) on a prefixed name without
 * `secure`, and on a `__Host-` name that carries a `domain`. (Its other rule,
 * `__Host-` needs `path: "/"`, holds for every erasure by construction.)
 */
function isWritableCookie(name: string, secure: boolean, domain: string | undefined): boolean {
  const prefixed = name.startsWith("__Secure-") || name.startsWith("__Host-");
  if (prefixed && !secure) return false;
  if (name.startsWith("__Host-") && domain !== undefined) return false;
  return true;
}

/**
 * Every cookie a sign-out has to erase: every name the session cookie can carry
 * — bare, `__Host-`, `__Secure-` — on every scope still addressable — host-only,
 * and the configured domain if there is one — minus the combinations hono
 * refuses to write. One, two, three or five entries: one outside production
 * with no domain, two outside production with one (the prefixed names need the
 * `Secure` flag), three in production with no domain, five in production with
 * one (`__Host-` never takes the domain).
 *
 * The rule is uniform on purpose, and depends on no fact of history about which
 * name was ever set where: a deployment that changes its configuration inherits
 * browsers still carrying the cookie under an OLD name or scope, and erasing only
 * the current one leaves that cookie authenticating for the rest of its seven
 * days. An entry for a cookie this server never set is one inert header.
 *
 * The residue it cannot reach: a `__Secure-` cookie set under a domain that has
 * since been removed from the configuration. That domain is no longer readable,
 * so no entry can address it; it stays until its own `Max-Age`.
 *
 * `secure` is the same value the cookie was set with, so every entry that
 * survives the filter is legal by construction rather than by everyone
 * remembering. This is the one factory: a hand-written variant is precisely the
 * failure this shape exists to prevent, because a refused write THROWS and a
 * sign-out would answer 500.
 */
export function sessionCookieErasures(): Array<{
  name: string;
  options: { maxAge: 0; path: "/"; secure: boolean; domain?: string };
}> {
  const secure = isSecureCookie();
  const domain = sessionCookieDomain();
  const names = [
    BASE_SESSION_COOKIE_NAME,
    `__Host-${BASE_SESSION_COOKIE_NAME}`,
    `__Secure-${BASE_SESSION_COOKIE_NAME}`,
  ];
  const scopes: Array<string | undefined> =
    domain === undefined ? [undefined] : [undefined, domain];

  const erasures: Array<{
    name: string;
    options: { maxAge: 0; path: "/"; secure: boolean; domain?: string };
  }> = [];
  for (const name of names) {
    for (const scope of scopes) {
      if (!isWritableCookie(name, secure, scope)) continue;
      erasures.push({
        name,
        options: {
          maxAge: 0,
          path: "/",
          secure,
          ...(scope === undefined ? {} : { domain: scope }),
        },
      });
    }
  }
  return erasures;
}
