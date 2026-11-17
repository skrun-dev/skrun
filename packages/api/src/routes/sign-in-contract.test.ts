import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, hashSessionId, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  beginLogin,
  callback,
  stubGithubOk,
  stubGithubThrows,
  withEnv,
} from "./oauth-flow.shared.js";

// The sign-in contract a consumer outside this repository reads: a site that
// sends people here to sign in, and reads back where they land, which cookie
// they carry, and what the session read answers. None of its tests runs this
// code, so a change here breaks it in silence — this file is the only place
// that turns red first.
//
// What it asserts, and nothing else: statuses, `Location`, `Set-Cookie`, log
// lines, that the session read answers a JSON object (no field of it is read),
// and that no account was created. Never a message or a page text: those change
// for their own reasons, and the consumer reads none of them.

// The log lines the contract pins are written through createLogger. pino writes
// to fd 1 directly, so createLogger is mocked to capture what the code logs;
// vi.mock is hoisted, and vi.hoisted declares the spies in lock-step. Only
// createLogger is replaced — the rest of @skrun-dev/runtime is left intact.
const { logInfoSpy, logWarnSpy, logErrorSpy } = vi.hoisted(() => ({
  logInfoSpy: vi.fn(),
  logWarnSpy: vi.fn(),
  logErrorSpy: vi.fn(),
}));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  return {
    ...actual,
    createLogger: () => ({
      info: logInfoSpy,
      warn: logWarnSpy,
      error: logErrorSpy,
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      level: "info",
      child: () => ({ info: logInfoSpy, warn: logWarnSpy, error: logErrorSpy }),
    }),
  };
});

/** Carried by every assertion of this file: what a red here means. */
const CONTRACT = "An external consumer depends on this value — tell them before changing it.";

/** Every name this file sets or clears, put back after each case. */
const KEYS = [
  "NODE_ENV",
  "CORS_ORIGIN",
  "SKRUN_DEV_AUTH",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SKRUN_ALLOWED_GITHUB_USERS",
  "SKRUN_PUBLIC_URL",
  "SKRUN_SESSION_COOKIE_DOMAIN",
  "SESSION_TTL_S",
  "SKRUN_LOGIN_RETURN_PATH",
  "SKRUN_LOGIN_PAGE_URL",
  "SKRUN_TERMS_URL",
  "SKRUN_PRIVACY_URL",
  "SKRUN_DOCS_URL",
  "SKRUN_DASHBOARD",
  "SKRUN_DASHBOARD_DIR",
] as const;

/** The site in front of the API: the apex of the cookie's domain, on the canonical scheme. */
const SITE = "https://example.com";

/** One identity for every sign-in of the file. */
const GH = { id: 707070, login: "contract-reader" };

/** The test build of the dashboard, inside this package — serveStatic resolves its root from the cwd. */
const FIXTURE_WEB_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../tests/fixtures/web-dist",
);

/** A destination nobody configured, offered by the request. */
const ELSEWHERE = "https://evil.example/landing";

/** A `Set-Cookie` line, split: its name, its value, and its attributes by lower-cased name. */
function parseSetCookie(line: string): {
  name: string;
  value: string;
  attributes: Map<string, string>;
} {
  const [pair = "", ...rest] = line.split(";");
  const eq = pair.indexOf("=");
  const attributes = new Map<string, string>();
  for (const part of rest) {
    const [key = "", ...value] = part.trim().split("=");
    attributes.set(key.toLowerCase(), value.join("="));
  }
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1), attributes };
}

describe("the sign-in contract an external consumer reads", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = withEnv(KEYS);
    // Production, with a canonical origin and a cookie domain: the shape of a
    // deployment that has a site in front of its API.
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    for (const key of [
      "SKRUN_DEV_AUTH",
      "SKRUN_ALLOWED_GITHUB_USERS",
      "SESSION_TTL_S",
      "SKRUN_LOGIN_RETURN_PATH",
      "SKRUN_LOGIN_PAGE_URL",
      "SKRUN_TERMS_URL",
      "SKRUN_PRIVACY_URL",
      "SKRUN_DOCS_URL",
    ]) {
      delete process.env[key];
    }
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
    logInfoSpy.mockClear();
    logWarnSpy.mockClear();
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  describe("where a finished sign-in sends the browser", () => {
    it("a success lands on the site's root, with no query parameter", async () => {
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      const res = await callback(app, `?code=c&state=${state}`, cookie);

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/`);
    });

    it.each([
      { failure: "no state in the query", query: () => "?code=c" },
      { failure: "a state that does not match", query: () => "?code=c&state=not-the-one" },
      {
        failure: "a cancellation at GitHub (no code)",
        query: (state: string) => `?state=${state}&error=access_denied`,
      },
      {
        failure: "a token exchange that fails",
        query: (state: string) => `?code=c&state=${state}`,
        arm: stubGithubThrows,
      },
    ])("$failure lands on the site's root with login=failed", async ({ query, arm }) => {
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      arm?.();
      const res = await callback(app, query(state), cookie);

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/?login=failed`);
    });

    it("an account the signup allowlist refuses lands on the site's root with login=denied", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "somebody-else";
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      const res = await callback(app, `?code=c&state=${state}`, cookie);

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/?login=denied`);
    });

    it.each([
      "return_to",
      "next",
      "redirect_uri",
      "redirect",
    ])("a %s parameter on the callback moves neither a success nor a failure", async (param) => {
      const offered = `&${param}=${encodeURIComponent(ELSEWHERE)}`;

      stubGithubOk(GH);
      const ok = await beginLogin(app);
      const success = await callback(app, `?code=c&state=${ok.state}${offered}`, ok.cookie);
      expect(success.headers.get("Location"), CONTRACT).toBe(`${SITE}/`);

      const ko = await beginLogin(app);
      const failure = await callback(app, `?code=c&state=not-the-one${offered}`, ko.cookie);
      expect(failure.headers.get("Location"), CONTRACT).toBe(`${SITE}/?login=failed`);
    });
  });

  // The operator may set the path on the site that a sign-in returns to. The
  // consumer reads the same two markers there, and nothing on a success.
  describe("where a finished sign-in sends the browser, with a return path set", () => {
    beforeEach(() => {
      process.env.SKRUN_LOGIN_RETURN_PATH = "/signin";
      db = new MemoryDb();
      app = createApp(new MemoryStorage(), db);
    });

    it("a success lands on the path, with no query parameter", async () => {
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      const res = await callback(app, `?code=c&state=${state}`, cookie);

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/signin`);
    });

    it.each([
      { failure: "no state in the query", query: () => "?code=c" },
      { failure: "a state that does not match", query: () => "?code=c&state=not-the-one" },
      {
        failure: "a cancellation at GitHub (no code)",
        query: (state: string) => `?state=${state}&error=access_denied`,
      },
      {
        failure: "a token exchange that fails",
        query: (state: string) => `?code=c&state=${state}`,
        arm: stubGithubThrows,
      },
    ])("$failure lands on the path with login=failed", async ({ query, arm }) => {
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      arm?.();
      const res = await callback(app, query(state), cookie);

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/signin?login=failed`);
    });

    it("an account the signup allowlist refuses lands on the path with login=denied", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "somebody-else";
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      const res = await callback(app, `?code=c&state=${state}`, cookie);

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/signin?login=denied`);
    });
  });

  // The operator may set a sign-in page of their own: /login, where the
  // dashboard sends a visitor who is not signed in, redirects there. What the
  // request carries moves nothing.
  describe("where /login sends the browser, with a sign-in page set", () => {
    beforeEach(() => {
      process.env.SKRUN_LOGIN_PAGE_URL = `${SITE}/signin`;
      db = new MemoryDb();
      app = createApp(new MemoryStorage(), db);
    });

    it.each([
      "return_to",
      "next",
      "redirect_uri",
      "redirect",
    ])("a %s parameter on /login does not move the sign-in page", async (param) => {
      const res = await app.request(`/login?${param}=${encodeURIComponent(ELSEWHERE)}`, {
        redirect: "manual",
      });

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location"), CONTRACT).toBe(`${SITE}/signin`);
    });
  });

  describe("the session cookie a success sets", () => {
    it("is __Secure-skrun_session, scoped to the cookie domain, for seven days, HttpOnly, Secure, SameSite=Lax", async () => {
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      const res = await callback(app, `?code=c&state=${state}`, cookie);

      // The one cookie the success sets with a value: everything else it writes
      // is an erasure. Found by that, not by its name, so a renamed cookie is
      // caught by the name assertion below.
      const set = res.headers
        .getSetCookie()
        .map(parseSetCookie)
        .find((c) => c.value !== "");
      expect(set, CONTRACT).toBeDefined();
      expect(set?.name, CONTRACT).toBe("__Secure-skrun_session");
      expect(set?.attributes.get("domain"), CONTRACT).toBe("example.com");
      expect(set?.attributes.get("max-age"), CONTRACT).toBe("604800");
      expect(set?.attributes.get("path"), CONTRACT).toBe("/");
      expect(set?.attributes.has("httponly"), CONTRACT).toBe(true);
      expect(set?.attributes.has("secure"), CONTRACT).toBe(true);
      expect(set?.attributes.get("samesite"), CONTRACT).toBe("Lax");
    });
  });

  // The consumer reads the status of the session read, and only the status: 200
  // is signed in, 401 is not. The requests below carry the cookie under the name
  // the server reads (`sessionCookieName()`): the name itself is pinned above, so
  // a renamed cookie turns that case red, not these.
  describe("what the session read answers", () => {
    async function signedInUser(): Promise<string> {
      const user = await db.createUser({ github_id: String(GH.id), username: GH.login });
      return user.id;
    }

    async function me(cookie?: string): Promise<Response> {
      return await app.request("/api/me", cookie ? { headers: { Cookie: cookie } } : {});
    }

    it("a valid session answers 200, with a JSON object for a body", async () => {
      const sessionId = await createSession(db, await signedInUser());
      const res = await me(`${sessionCookieName()}=${sessionId}`);

      expect(res.status, CONTRACT).toBe(200);
      const body: unknown = await res.json();
      expect(typeof body === "object" && body !== null && !Array.isArray(body), CONTRACT).toBe(
        true,
      );
    });

    it("no credential at all answers 401", async () => {
      const res = await me();
      expect(res.status, CONTRACT).toBe(401);
    });

    it("a session nobody created answers 401", async () => {
      const res = await me(`${sessionCookieName()}=00000000-0000-4000-8000-000000000000`);
      expect(res.status, CONTRACT).toBe(401);
    });

    it("an expired session answers 401", async () => {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      await db.createSession({
        id_hash: hashSessionId(sessionId),
        user_id: await signedInUser(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });
      const res = await me(`${sessionCookieName()}=${sessionId}`);
      expect(res.status, CONTRACT).toBe(401);
    });

    // A store that is down is not an absent session: answering 401 would sign
    // every visitor of the site out, with nothing to say why.
    it("a session store that fails answers 500, never 401", async () => {
      const sessionId = await createSession(db, await signedInUser());
      vi.spyOn(db, "getSession").mockRejectedValue(new Error("connection terminated unexpectedly"));
      const res = await me(`${sessionCookieName()}=${sessionId}`);

      expect(res.status, CONTRACT).toBe(500);
      expect(res.status, CONTRACT).not.toBe(401);
    });
  });

  // The consumer relays every occurrence of the cookie it received. Under a
  // cookie domain, two occurrences of the session cookie mean one was planted by
  // another host of the domain: the read refuses the cookie, says so in the log
  // by the cookie's name only, and erases it on both scopes.
  describe("a session cookie sent twice", () => {
    it("authenticates nobody, logs the cookie's name and no value, and erases both scopes", async () => {
      const user = await db.createUser({ github_id: String(GH.id), username: GH.login });
      const valid = await createSession(db, user.id);
      const planted = "planted-by-another-host-of-the-domain";
      const name = sessionCookieName();

      const res = await app.request("/api/me", {
        headers: { Cookie: `${name}=${valid}; ${name}=${planted}` },
      });

      expect(res.status, CONTRACT).toBe(401);

      const lines = logWarnSpy.mock.calls.map(([fields]) => fields);
      expect(lines, CONTRACT).toContainEqual(
        expect.objectContaining({ event: "session_cookie_duplicate", cookie: name }),
      );
      expect(JSON.stringify(logWarnSpy.mock.calls), CONTRACT).not.toContain(valid);
      expect(JSON.stringify(logWarnSpy.mock.calls), CONTRACT).not.toContain(planted);

      const cookies = res.headers.getSetCookie();
      expect(cookies, CONTRACT).toContain(`${name}=; Max-Age=0; Path=/; Secure`);
      expect(cookies, CONTRACT).toContain(
        `${name}=; Max-Age=0; Domain=example.com; Path=/; Secure`,
      );
    });
  });

  // The two addresses of this server the consumer links to, exactly as it
  // writes them: the start of a GitHub sign-in, and the dashboard with no
  // trailing slash.
  describe("the two addresses the consumer links to", () => {
    it("/auth/github redirects to GitHub's authorize page", async () => {
      const res = await app.request("/auth/github", { redirect: "manual" });

      expect(res.status, CONTRACT).toBe(302);
      expect(res.headers.get("Location")?.split("?")[0], CONTRACT).toBe(
        "https://github.com/login/oauth/authorize",
      );
    });

    it("/dashboard, with no trailing slash, serves the dashboard itself — no redirect", async () => {
      process.env.SKRUN_DASHBOARD = "on";
      process.env.SKRUN_DASHBOARD_DIR = FIXTURE_WEB_DIST;
      const served = createApp(new MemoryStorage(), new MemoryDb());
      const res = await served.request("/dashboard", { redirect: "manual" });

      expect(res.status, CONTRACT).toBe(200);
      expect(res.headers.get("Location"), CONTRACT).toBeNull();
    });
  });

  // A sign-in the signup allowlist refuses: the consumer's own policy describes
  // the refusal — the log line that records it, and the account that is never
  // created, because the list is checked before anything is written.
  describe("a sign-up the allowlist refuses", () => {
    async function refusedSignIn(): Promise<void> {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "somebody-else";
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(app);
      await callback(app, `?code=c&state=${state}`, cookie);
    }

    it("is logged as signup_rejected, with the GitHub login and id", async () => {
      await refusedSignIn();

      const lines = logWarnSpy.mock.calls.map(([fields]) => fields);
      expect(lines, CONTRACT).toContainEqual(
        expect.objectContaining({ event: "signup_rejected", login: GH.login, id: GH.id }),
      );
    });

    it("creates no account", async () => {
      await refusedSignIn();

      expect(await db.getUserByGithubId(String(GH.id)), CONTRACT).toBeNull();
    });
  });
});
