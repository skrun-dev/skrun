import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import type { DbAdapter } from "../db/adapter.js";

const logger = createLogger("session");

/**
 * The cookie name before any prefix. Not exported: a caller that reads this
 * instead of `sessionCookieName()` would be right in exactly the configurations
 * where the prefix is off, and silently wrong in the one where it is on.
 */
const BASE_SESSION_COOKIE_NAME = "skrun_session";

const DEFAULT_SESSION_TTL_S = 604800; // 7 days

function getTtlMs(): number {
  const raw = process.env.SESSION_TTL_S;
  if (!raw) return DEFAULT_SESSION_TTL_S * 1000;
  const parsed = Number.parseInt(raw, 10);
  return (Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_SESSION_TTL_S : parsed) * 1000;
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
        {
          event: "session_sweep_failed",
          error: err instanceof Error ? err.message : String(err),
        },
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
 * browser rejects a `__Secure-` cookie that arrives without the flag.
 */
export function isSecureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The `Domain` attribute of the session cookie, normalised — or `undefined`
 * when no domain is configured, which is the default and leaves the cookie
 * host-only exactly as before.
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
 * The session cookie's name.
 *
 * `__Secure-` is added only when BOTH the `Secure` flag applies AND a domain is
 * configured, and both halves are load-bearing:
 *
 *   - without `Secure`, a browser rejects the cookie outright, so a bare prefix
 *     would break local http development for every contributor;
 *   - without a configured domain, an unconfigured self-hoster running in
 *     production would have their cookie renamed and their sessions invalidated
 *     once, for a prefix that buys them nothing — the attack it stops (a network
 *     attacker setting the cookie over http) needs a domain-scoped cookie to
 *     begin with.
 */
export function sessionCookieName(): string {
  return isSecureCookie() && sessionCookieDomain() !== undefined
    ? `__Secure-${BASE_SESSION_COOKIE_NAME}`
    : BASE_SESSION_COOKIE_NAME;
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
 * Every cookie a sign-out has to erase: each name still in play, on each scope
 * still in play. One, two or four entries — bounded by what is configured.
 *
 * Two names, because a deployment that turns the domain on inherits browsers
 * still carrying the host-only cookie under the OLD name: erasing only the new
 * one leaves that cookie authenticating for the rest of its seven days. Two
 * scopes, for the same reason on the `Domain` axis.
 *
 * `secure` is the same value the cookie was set with, so a prefixed name always
 * carries the flag it requires — which is what makes every call below legal by
 * construction rather than by everyone remembering. This is the one factory:
 * a hand-written third variant is precisely the failure this shape exists to
 * prevent, because `setCookie` THROWS on a `__Secure-` name without `secure`
 * (hono `utils/cookie.js` `_serialize`) and a sign-out would answer 500 in the
 * nominal case of a domain-configured deployment.
 */
export function sessionCookieErasures(): Array<{
  name: string;
  options: { maxAge: 0; path: "/"; secure: boolean; domain?: string };
}> {
  const secure = isSecureCookie();
  const domain = sessionCookieDomain();
  // A Set, so the unconfigured case yields one entry and not the same name twice.
  const names = new Set([BASE_SESSION_COOKIE_NAME, sessionCookieName()]);
  const scopes: Array<string | undefined> =
    domain === undefined ? [undefined] : [undefined, domain];

  const erasures: Array<{
    name: string;
    options: { maxAge: 0; path: "/"; secure: boolean; domain?: string };
  }> = [];
  for (const name of names) {
    for (const scope of scopes) {
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
