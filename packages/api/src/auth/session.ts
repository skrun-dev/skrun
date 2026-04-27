import { randomUUID } from "node:crypto";

export const SESSION_COOKIE_NAME = "skrun_session";

const DEFAULT_SESSION_TTL_S = 86400; // 24 hours

interface SessionEntry {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/** In-memory session store. Clears on restart — same lifecycle as MemoryDb. */
const sessions = new Map<string, SessionEntry>();

function getTtlMs(): number {
  const raw = process.env.SESSION_TTL_S;
  if (!raw) return DEFAULT_SESSION_TTL_S * 1000;
  const parsed = Number.parseInt(raw, 10);
  return (Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_SESSION_TTL_S : parsed) * 1000;
}

/**
 * Create a new session for a user. Returns the session ID.
 */
export function createSession(userId: string): string {
  const sessionId = randomUUID();
  const now = Date.now();
  sessions.set(sessionId, {
    userId,
    createdAt: now,
    expiresAt: now + getTtlMs(),
  });
  return sessionId;
}

/**
 * Validate a session ID. Returns the userId if valid and not expired, null otherwise.
 */
export function validateSession(sessionId: string): string | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return entry.userId;
}

/**
 * Destroy a session.
 */
export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
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

/**
 * Clear all sessions. Used in tests.
 */
export function clearSessions(): void {
  sessions.clear();
}
