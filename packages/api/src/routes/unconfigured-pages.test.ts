import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, sessionCookieName } from "../auth/session.js";
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

// What a server that configures nothing of the operator's own site answers
// today, byte for byte: the sign-in page in its three variants, the device
// consent page, the session read, and the callback with and without a cookie
// domain. Those settings are inert when unset; these snapshots are what "inert"
// is compared against, so a setting that leaks into a server that did not ask
// for it turns one of them red.
//
// The only parts that differ from one run to the next are replaced by a marker
// before the comparison: the consent form's anti-forgery token, and the id of
// the signed-in account. Nothing else is normalised.

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
  "SKRUN_VERIFICATION_POLICY",
  "SKRUN_LOGIN_RETURN_PATH",
  "SKRUN_LOGIN_PAGE_URL",
  "SKRUN_TERMS_URL",
  "SKRUN_PRIVACY_URL",
  "SKRUN_DOCS_URL",
  "SKRUN_DASHBOARD",
  "SKRUN_DASHBOARD_DIR",
] as const;

/** One identity for every sign-in of the file. */
const GH = { id: 808080, login: "page-reader" };

/** `text` with every occurrence of `value` replaced by `marker`, and how many there were. */
function normalise(text: string, value: string, marker: string): { text: string; count: number } {
  const parts = text.split(value);
  return { text: parts.join(marker), count: parts.length - 1 };
}

/** The value a response sets for the named cookie. */
function cookieValue(res: Response, name: string): string | undefined {
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(";")[0];
}

describe("what a server with nothing of the operator's own site configured serves", () => {
  let db: MemoryDb;
  let restoreEnv: () => void;

  /** The app, built after the case has set its environment. */
  function app(): ReturnType<typeof createApp> {
    return createApp(new MemoryStorage(), db);
  }

  beforeEach(() => {
    restoreEnv = withEnv(KEYS);
    for (const key of KEYS) delete process.env[key];
    process.env.NODE_ENV = "test";
    process.env.SKRUN_DASHBOARD = "off";
    db = new MemoryDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  describe("the sign-in page", () => {
    it("with GitHub sign-in configured", async () => {
      process.env.GITHUB_CLIENT_ID = "id";
      process.env.GITHUB_CLIENT_SECRET = "secret";
      const res = await app().request("/login");

      expect(res.status).toBe(200);
      expect(await res.text()).toMatchSnapshot();
    });

    it("with only the development token", async () => {
      process.env.SKRUN_DEV_AUTH = "1";
      const res = await app().request("/login");

      expect(res.status).toBe(200);
      expect(await res.text()).toMatchSnapshot();
    });

    it("with neither", async () => {
      const res = await app().request("/login");

      expect(res.status).toBe(200);
      expect(await res.text()).toMatchSnapshot();
    });
  });

  it("the device consent page, for a code the user typed", async () => {
    const res = await app().request("/device?user_code=ABCD-EFGH");
    const token = cookieValue(res, "skrun_device_csrf");

    expect(res.status).toBe(200);
    expect(token).toBeTruthy();
    const page = normalise(await res.text(), token ?? "", "[anti-forgery token]");
    expect(page.count).toBe(1);
    expect(page.text).toMatchSnapshot();
  });

  it("the session read, for a signed-in account", async () => {
    const served = app();
    const user = await db.createUser({ github_id: String(GH.id), username: GH.login });
    const sessionId = await createSession(db, user.id);
    const res = await served.request("/api/me", {
      headers: { Cookie: `${sessionCookieName()}=${sessionId}` },
    });

    expect(res.status).toBe(200);
    const body = normalise(await res.text(), user.id, "[account id]");
    expect(body.count).toBe(1);
    expect(body.text).toMatchSnapshot();
  });

  // A cookie domain set: the callback sends the browser to the site at the
  // domain's apex, on the canonical scheme.
  describe("the callback, with a cookie domain", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGIN = "https://app.example.com";
      process.env.GITHUB_CLIENT_ID = "id";
      process.env.GITHUB_CLIENT_SECRET = "secret";
      process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
      process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    });

    it("a success", async () => {
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect({ status: res.status, location: res.headers.get("Location") }).toMatchSnapshot();
    });

    it("a failure", async () => {
      const served = app();
      const { cookie } = await beginLogin(served);
      const res = await callback(served, "?code=c&state=not-the-one", cookie);

      expect({ status: res.status, location: res.headers.get("Location") }).toMatchSnapshot();
    });

    it("a refusal by the signup allowlist", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "somebody-else";
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect({ status: res.status, location: res.headers.get("Location") }).toMatchSnapshot();
    });
  });

  // No cookie domain: a success goes to the dashboard this server serves, and
  // each failure answers on the spot.
  describe("the callback, without a cookie domain", () => {
    beforeEach(() => {
      process.env.GITHUB_CLIENT_ID = "id";
      process.env.GITHUB_CLIENT_SECRET = "secret";
    });

    it("a success", async () => {
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect({ status: res.status, location: res.headers.get("Location") }).toMatchSnapshot();
    });

    it("a state that does not match", async () => {
      const served = app();
      const { cookie } = await beginLogin(served);
      const res = await callback(served, "?code=c&state=not-the-one", cookie);

      expect({ status: res.status, body: await res.text() }).toMatchSnapshot();
    });

    it("a token exchange that fails", async () => {
      const served = app();
      const { state, cookie } = await beginLogin(served);
      stubGithubThrows();
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect({ status: res.status, body: await res.text() }).toMatchSnapshot();
    });

    it("a refusal by the signup allowlist", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "somebody-else";
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect({ status: res.status, body: await res.text() }).toMatchSnapshot();
    });
  });
});
