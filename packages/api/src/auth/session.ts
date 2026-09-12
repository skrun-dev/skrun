import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import type { DbAdapter } from "../db/adapter.js";

const logger = createLogger("session");

export const SESSION_COOKIE_NAME = "skrun_session";

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
 * Cookie options for the session cookie.
 */
export function getSessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(getTtlMs() / 1000),
  };
}
