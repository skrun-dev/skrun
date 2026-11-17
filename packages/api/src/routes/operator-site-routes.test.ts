import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  beginLogin,
  callback,
  GITHUB_EXCHANGE_FAILURE,
  sessionCookieFrom,
  stubGithubOk,
  stubGithubThrows,
  withEnv,
} from "./oauth-flow.shared.js";

// What the sign-in routes serve once the operator has set their own site. The
// settings are read once, when the app is built: each case sets its environment
// first and builds the app after — and a case that changes the environment of an
// app already built shows that the app does not read it again.

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
const GH = { id: 909090, login: "site-visitor" };

/** The notice under the sign-in button, as the page carries it, or `undefined`. */
function noticeOf(html: string): string | undefined {
  return /<p class="consent">[\s\S]*?<\/p>/.exec(html)?.[0];
}

/** What an attribute or a text node says once the five escapes are read back. */
function unescaped(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text a reader sees in `fragment`: its tags dropped, its escapes read back. */
function textOf(fragment: string): string {
  return unescaped(fragment.replace(/<[^>]*>/g, ""));
}

/** Each anchor of `fragment`, with the attributes a link to another site is judged by. */
function anchorsOf(fragment: string): Array<{
  href: string | undefined;
  target: string | undefined;
  rel: string | undefined;
  label: string | undefined;
}> {
  return [...fragment.matchAll(/<a\s([^>]*)>/g)].map(([, attrs = ""]) => {
    const attr = (name: string) => {
      const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
      return value === undefined ? undefined : unescaped(value);
    };
    return {
      href: attr("href"),
      target: attr("target"),
      rel: attr("rel"),
      label: attr("aria-label"),
    };
  });
}

/** The consent page a CLI sign-in opens. */
const DEVICE = "/device?user_code=ABCD-EFGH";

/** The phishing warning of the consent page, which the notice must leave as it is. */
const DEVICE_WARNING =
  '<p class="warn">⚠️ Only continue if you just ran <code>skrun login</code> yourself. Never enter a code someone sent you.</p>';

describe("the sign-in routes, with the operator's own site set", () => {
  let db: MemoryDb;
  let restoreEnv: () => void;

  /** The app, built after the case has set its environment. */
  function app(): ReturnType<typeof createApp> {
    return createApp(new MemoryStorage(), db);
  }

  beforeEach(() => {
    restoreEnv = withEnv(KEYS);
    for (const key of KEYS) delete process.env[key];
    // Production, with a canonical origin and a cookie domain: the shape of a
    // deployment that has a site in front of its API.
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    process.env.SKRUN_DASHBOARD = "off";
    db = new MemoryDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  describe("a finished sign-in, with a return path set", () => {
    beforeEach(() => {
      process.env.SKRUN_LOGIN_RETURN_PATH = "/signin";
    });

    it("a success lands on the path on the site's origin, with no query parameter, signed in", async () => {
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${SITE}/signin`);
      const session = sessionCookieFrom(res);
      expect(session).toMatch(/^__Secure-skrun_session=/);
      expect(session).toContain("; Domain=example.com;");
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
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      arm?.();
      const res = await callback(served, query(state), cookie);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${SITE}/signin?login=failed`);
      expect(sessionCookieFrom(res)).toBeUndefined();
    });

    // GitHub's own message belongs in the operator's log, and only there: no
    // header and no byte of the answer carries it.
    it("a token exchange that fails shows the browser nothing of GitHub's message", async () => {
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      stubGithubThrows();
      const res = await callback(served, `?code=c&state=${state}`, cookie);
      const answer = [
        ...[...res.headers].map(([name, value]) => `${name}: ${value}`),
        await res.text(),
      ].join("\n");

      expect(res.status).toBe(302);
      expect(answer).not.toContain(GITHUB_EXCHANGE_FAILURE);
    });

    it("an account the signup allowlist refuses lands on the path with login=denied", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "somebody-else";
      const served = app();
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${SITE}/signin?login=denied`);
      expect(sessionCookieFrom(res)).toBeUndefined();
    });

    // The site is reached on the canonical URL's scheme, whatever it is: a
    // deployment served over plain http — outside production, where the start
    // accepts an http canonical URL with a cookie domain — is sent to an http
    // site, never to an https origin that does not answer.
    it("a sign-in on an http canonical URL lands on the site over http — success, failure and refusal", async () => {
      process.env.NODE_ENV = "development";
      process.env.SKRUN_PUBLIC_URL = "http://api.example.test";
      process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.test";
      process.env.SKRUN_ALLOWED_GITHUB_USERS = GH.login;
      const served = app();

      stubGithubOk(GH);
      const ok = await beginLogin(served);
      const success = await callback(served, `?code=c&state=${ok.state}`, ok.cookie);
      expect(success.status).toBe(302);
      expect(success.headers.get("Location")).toBe("http://example.test/signin");

      const failed = await callback(served, "?code=c", ok.cookie);
      expect(failed.status).toBe(302);
      expect(failed.headers.get("Location")).toBe("http://example.test/signin?login=failed");

      stubGithubOk({ id: 818181, login: "not-on-the-list" });
      const refused = await beginLogin(served);
      const denied = await callback(served, `?code=c&state=${refused.state}`, refused.cookie);
      expect(denied.status).toBe(302);
      expect(denied.headers.get("Location")).toBe("http://example.test/signin?login=denied");
    });

    // The destination is resolved when the app is built. An environment changed
    // afterwards — by a test, or by anything else in the process — does not move
    // it: what the start validated is what every callback serves.
    it("a cookie domain changed after the start does not move where a sign-in lands", async () => {
      const served = app();
      process.env.SKRUN_SESSION_COOKIE_DOMAIN = "other.example";
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${SITE}/signin`);
    });

    it("a return path changed after the start does not move where a sign-in lands", async () => {
      const served = app();
      process.env.SKRUN_LOGIN_RETURN_PATH = "/elsewhere";
      stubGithubOk(GH);
      const { state, cookie } = await beginLogin(served);
      const res = await callback(served, `?code=c&state=${state}`, cookie);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${SITE}/signin`);
    });
  });

  describe("the sign-in page, with the operator's own page set", () => {
    it("/login answers a temporary redirect to that page, and keeps nothing of the request", async () => {
      process.env.SKRUN_LOGIN_PAGE_URL = `${SITE}/signin`;
      const served = app();

      const plain = await served.request("/login", { redirect: "manual" });
      expect(plain.status).toBe(302);
      expect(plain.headers.get("Location")).toBe(`${SITE}/signin`);

      const offered = await served.request(
        `/login?next=${encodeURIComponent("https://evil.example")}`,
        { redirect: "manual" },
      );
      expect(offered.status).toBe(302);
      expect(offered.headers.get("Location")).toBe(`${SITE}/signin`);
    });

    // What is served is the form the start normalised, never the string as it
    // was written: a scheme in capitals is served in lower case, and a host
    // written with a non-ASCII letter is served in its ASCII form.
    it.each([
      { written: `${SITE}/signin`, served: `${SITE}/signin` },
      { written: "HTTPS://x/", served: "https://x/" },
      { written: "https://exämple.com/", served: "https://xn--exmple-cua.com/" },
    ])("a page written $written is served as $served", async ({ written, served }) => {
      process.env.SKRUN_LOGIN_PAGE_URL = written;
      const res = await app().request("/login", { redirect: "manual" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(served);
    });

    it("/login redirects even where GitHub sign-in is not configured", async () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      process.env.SKRUN_LOGIN_PAGE_URL = `${SITE}/signin`;
      const res = await app().request("/login", { redirect: "manual" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`${SITE}/signin`);
    });
  });

  describe("the notice naming the operator's terms and privacy policy", () => {
    const TERMS = `${SITE}/legal/terms`;
    const PRIVACY = `${SITE}/legal/privacy`;

    it("the consent page shows it under its button, above the warning, with both links", async () => {
      process.env.SKRUN_TERMS_URL = TERMS;
      process.env.SKRUN_PRIVACY_URL = PRIVACY;
      const res = await app().request(DEVICE);
      const html = await res.text();
      const notice = noticeOf(html);

      expect(res.status).toBe(200);
      expect(notice).toBeDefined();
      expect(textOf(notice ?? "")).toBe(
        "By continuing, you agree to the Terms and acknowledge the Privacy Policy.",
      );
      expect(anchorsOf(notice ?? "")).toEqual([
        {
          href: TERMS,
          target: "_blank",
          rel: "noopener noreferrer",
          label: "Terms (opens in a new tab)",
        },
        {
          href: PRIVACY,
          target: "_blank",
          rel: "noopener noreferrer",
          label: "Privacy Policy (opens in a new tab)",
        },
      ]);
      // Under the button, immediately above the warning, which is unchanged.
      expect(html.indexOf(notice ?? "")).toBeGreaterThan(html.indexOf("</form>"));
      expect(html).toContain(`${notice}\n${DEVICE_WARNING}`);
      // The page's address carries the one-time code: no referrer leaves it.
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    });

    it("/login shows it under the GitHub button, with both links", async () => {
      process.env.SKRUN_TERMS_URL = TERMS;
      process.env.SKRUN_PRIVACY_URL = PRIVACY;
      const res = await app().request("/login");
      const html = await res.text();
      const notice = noticeOf(html);

      expect(res.status).toBe(200);
      expect(notice).toBeDefined();
      expect(textOf(notice ?? "")).toBe(
        "By continuing, you agree to the Terms and acknowledge the Privacy Policy.",
      );
      expect(
        anchorsOf(notice ?? "").map(({ href, target, rel }) => ({ href, target, rel })),
      ).toEqual([
        { href: TERMS, target: "_blank", rel: "noopener noreferrer" },
        { href: PRIVACY, target: "_blank", rel: "noopener noreferrer" },
      ]);
      const button = html.indexOf('<a href="/auth/github" class="btn btn-github">');
      expect(button).toBeGreaterThan(-1);
      expect(html.indexOf(notice ?? "")).toBeGreaterThan(button);
      expect(html.indexOf(notice ?? "")).toBeLessThan(html.indexOf('<div class="footer">'));
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    });

    it.each([
      {
        set: "the terms alone",
        env: { SKRUN_TERMS_URL: TERMS },
        text: "By continuing, you agree to the Terms.",
        href: TERMS,
      },
      {
        set: "the privacy policy alone",
        env: { SKRUN_PRIVACY_URL: PRIVACY },
        text: "By continuing, you acknowledge the Privacy Policy.",
        href: PRIVACY,
      },
    ])("with $set, the consent page names it alone, with one link", async ({ env, text, href }) => {
      Object.assign(process.env, env);
      const notice = noticeOf(await (await app().request(DEVICE)).text());

      expect(textOf(notice ?? "")).toBe(text);
      expect(anchorsOf(notice ?? "").map((a) => a.href)).toEqual([href]);
    });

    // Without the GitHub button there is nothing to continue with: /login keeps
    // the page it has today, notice-free.
    it.each([
      {
        page: "neither GitHub sign-in nor the dev token",
        nodeEnv: "production",
        devAuth: undefined,
      },
      { page: "the dev token only", nodeEnv: "development", devAuth: "1" },
    ])("/login with $page shows no notice", async ({ nodeEnv, devAuth }) => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      process.env.NODE_ENV = nodeEnv;
      if (devAuth !== undefined) process.env.SKRUN_DEV_AUTH = devAuth;
      process.env.SKRUN_TERMS_URL = TERMS;
      process.env.SKRUN_PRIVACY_URL = PRIVACY;
      const res = await app().request("/login");
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain('<p class="note">');
      expect(noticeOf(html)).toBeUndefined();
      expect(html).not.toContain("By continuing");
      expect(html).not.toContain(TERMS);
    });

    // A value is inserted into the page escaped, whatever the start let through:
    // an absolute address reaches the page in its normalised form, where only `&`
    // is left to escape; a path on this site is served as written, quotes and
    // angle brackets included.
    it.each([
      {
        written: "https://x/t?a=1&b='",
        served: "https://x/t?a=1&b=%27",
        inPage: 'href="https://x/t?a=1&amp;b=%27"',
      },
      {
        written: `/t?a=1&b='"<x>`,
        served: `/t?a=1&b='"<x>`,
        inPage: 'href="/t?a=1&amp;b=&#39;&quot;&lt;x&gt;"',
      },
    ])("a terms address written $written is escaped in the page", async ({
      written,
      served,
      inPage,
    }) => {
      process.env.SKRUN_TERMS_URL = written;
      const notice = noticeOf(await (await app().request(DEVICE)).text());

      expect(notice).toContain(inPage);
      expect(anchorsOf(notice ?? "").map((a) => a.href)).toEqual([served]);
      expect(textOf(notice ?? "")).toBe("By continuing, you agree to the Terms.");
    });

    // The docs address is the dashboard's: /login's own "API Docs" stays on the
    // API reference this server serves.
    it("/login keeps its API Docs link on /docs when a docs address is set", async () => {
      process.env.SKRUN_DOCS_URL = "https://docs.example.com/";
      const html = await (await app().request("/login")).text();

      expect(html).toContain('<a href="/docs" target="_blank">API Docs</a>');
      expect(html).not.toContain("docs.example.com");
      expect(noticeOf(html)).toBeUndefined();
    });
  });
});
