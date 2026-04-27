import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE_NAME,
  clearSessions,
  createSession,
  destroySession,
  getSessionCookieOptions,
  validateSession,
} from "./session.js";

describe("Session Management", () => {
  beforeEach(() => {
    clearSessions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createSession returns a UUID session ID", () => {
    const id = createSession("user-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("validateSession returns userId for valid session", () => {
    const sessionId = createSession("user-42");
    expect(validateSession(sessionId)).toBe("user-42");
  });

  it("validateSession returns null for unknown session", () => {
    expect(validateSession("nonexistent-id")).toBeNull();
  });

  it("validateSession returns null for expired session", () => {
    const sessionId = createSession("user-1");

    // Advance time past the default TTL (24h)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400 * 1000 + 1000);

    expect(validateSession(sessionId)).toBeNull();
  });

  it("destroySession removes the session", () => {
    const sessionId = createSession("user-1");
    expect(validateSession(sessionId)).toBe("user-1");

    destroySession(sessionId);
    expect(validateSession(sessionId)).toBeNull();
  });

  it("destroySession is a no-op for unknown session", () => {
    // Should not throw
    destroySession("nonexistent-id");
  });

  it("SESSION_COOKIE_NAME is skrun_session", () => {
    expect(SESSION_COOKIE_NAME).toBe("skrun_session");
  });

  it("getSessionCookieOptions returns correct defaults", () => {
    const opts = getSessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("Lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(86400);
  });
});
