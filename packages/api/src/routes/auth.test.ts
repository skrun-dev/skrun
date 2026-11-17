import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY_PREFIX,
  apiKeyShapes,
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  RETIRED_API_KEY_PREFIX,
} from "../auth/api-key.js";
import { hashCode } from "../auth/device-code.js";
import { createSession, hashSessionId, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { NAMESPACE_MAX_ATTEMPTS, NamespaceUnavailableError } from "../db/namespace.js";
import { createApp } from "../index.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { readOperatorSite } from "../operator-site.js";
import { createDeletionJournal } from "../services/deletion-journal.js";
import { MemoryStorage } from "../storage/memory.js";
import { validBundle } from "./agent-bundle.shared.js";
import { createAuthRoutes, REVOCATION_JOURNAL_WAIT_MS } from "./auth.js";

// #101-VT-10 asserts the `signup_rejected` structured log, and VT-25 (#123) the
// `oauth_exchange_failed` one. pino writes to fd 1 directly (bypassing
// process.stdout.write), so createLogger is mocked to capture logger.info,
// logger.warn and logger.error. vi.mock is hoisted; vi.hoisted declares the
// spies in lock-step. Only createLogger is replaced — the rest of
// @skrun-dev/runtime is left intact.
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

function createTestApp() {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);
  return { app, db, storage };
}

describe("Auth Routes", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    // Ensure OAuth is not configured + the allowlist is unset by default in tests
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // VT-1: OAuth redirect returns 302 with correct params
  it("VT-1: GET /auth/github redirects to GitHub when OAuth configured", async () => {
    process.env.GITHUB_CLIENT_ID = "test-client-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    const res = await app.request("/auth/github", { redirect: "manual" });
    expect(res.status).toBe(302);
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const location = res.headers.get("Location")!;
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("scope=read%3Auser+user%3Aemail");

    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-1 (no OAuth): returns 404 when not configured
  it("VT-1b: GET /auth/github returns 404 when OAuth not configured", async () => {
    const res = await app.request("/auth/github");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("OAUTH_NOT_CONFIGURED");
  });

  // The pages below are searched for the whole shape of a key, current or
  // retired, not for a prefix. The witness keeps that search honest: a key of
  // either format slipped into a page is found by the same assertion.
  it("the leak search used on these pages finds a whole key of either format in a page", () => {
    const current = generateApiKey().key;
    const retired = `${RETIRED_API_KEY_PREFIX}${"0123456789abcdef".repeat(2)}`;
    for (const key of [current, retired]) {
      const page = `<body><div class="card"><p>Your key:</p><code>${key}</code></div></body>`;
      expect(apiKeyShapes(page)).toEqual([key]);
    }
  });

  // Hard-cut: a legacy CLI passes ?cli_callback= (the removed loopback flow);
  // the server shows an "update your CLI" page instead of redirecting with ?token=.
  it("outdated CLI: GET /auth/github?cli_callback=… returns an 'update your CLI' page", async () => {
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    try {
      const res = await app.request("/auth/github?cli_callback=http://127.0.0.1:1/callback", {
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Update your Skrun CLI");
      // No token, no loopback redirect.
      expect(res.headers.get("Location")).toBeNull();
      expect(apiKeyShapes(html)).toEqual([]);
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });

  describe("device flow: POST /auth/device/code", () => {
    const USER_CODE_RE =
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

    it("returns device_code, user_code, uris, interval and expires_in (seconds)", async () => {
      process.env.GITHUB_CLIENT_ID = "id";
      process.env.GITHUB_CLIENT_SECRET = "secret";
      try {
        const res = await app.request("/auth/device/code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code_challenge: "abc", code_challenge_method: "S256" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(typeof body.device_code).toBe("string");
        expect(body.user_code).toMatch(USER_CODE_RE);
        expect(body.verification_uri).toContain("/device");
        expect(body.verification_uri_complete).toContain(`user_code=${body.user_code}`);
        expect(body.interval).toBe(5);
        expect(typeof body.expires_in).toBe("number");
        expect(body.expires_in).toBeGreaterThan(0);
      } finally {
        delete process.env.GITHUB_CLIENT_ID;
        delete process.env.GITHUB_CLIENT_SECRET;
      }
    });

    it("rejects a request without code_challenge (400 invalid_request)", async () => {
      process.env.GITHUB_CLIENT_ID = "id";
      process.env.GITHUB_CLIENT_SECRET = "secret";
      try {
        const res = await app.request("/auth/device/code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe("invalid_request");
      } finally {
        delete process.env.GITHUB_CLIENT_ID;
        delete process.env.GITHUB_CLIENT_SECRET;
      }
    });

    it("returns 404 OAUTH_NOT_CONFIGURED when OAuth is unset (CLI falls back to --token)", async () => {
      const res = await app.request("/auth/device/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_challenge: "abc" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("OAUTH_NOT_CONFIGURED");
    });
  });

  describe("device flow: /device consent + CSRF", () => {
    const csrfFrom = (setCookie: string | null): string =>
      setCookie?.match(/skrun_device_csrf=([^;]+)/)?.[1] ?? "";

    it("GET /device renders the consent page with a CSRF cookie + prefilled code", async () => {
      const res = await app.request("/device?user_code=ABCD-2345");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Authorize Skrun CLI");
      expect(html).toContain("Never enter a code someone sent you");
      expect(html).toContain('value="ABCD-2345"');
      expect(csrfFrom(res.headers.get("Set-Cookie"))).not.toBe("");
    });

    it("POST /device rejects a missing/mismatched CSRF token (403)", async () => {
      const res = await app.request("/device", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "user_code=ABCD-2345&csrf=wrong",
      });
      expect(res.status).toBe(403);
    });

    it("POST /device with valid CSRF + pending code sets the device cookie and redirects to GitHub", async () => {
      const userCode = "ABCD-2345";
      await db.createDeviceCode({
        device_code_hash: hashCode(`dev-${userCode}`),
        user_code_hash: hashCode(userCode),
        code_challenge: "chal",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      const get = await app.request("/device");
      const csrf = csrfFrom(get.headers.get("Set-Cookie"));
      const res = await app.request("/device", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `skrun_device_csrf=${csrf}`,
          // An Origin header is present (as a real browser sends on a form POST);
          // it must NOT gate the request — the CSRF double-submit token is the
          // sole defense. (A top-level form-POST Origin is browser/proxy-dependent.)
          Origin: "https://browser-sent.example",
        },
        body: `user_code=${userCode}&csrf=${csrf}`,
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/github");
      expect(res.headers.get("Set-Cookie")).toContain("skrun_device_user_code=");
    });
  });

  describe("device flow: POST /auth/device/token", () => {
    const poll = (deviceCode: string, codeVerifier = "x") =>
      app.request("/auth/device/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode, code_verifier: codeVerifier }),
      });

    it("returns expired_token for an unknown device_code", async () => {
      const res = await poll("nope");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("expired_token");
    });

    it("returns authorization_pending while the code is pending", async () => {
      const dc = "dc-pending";
      await db.createDeviceCode({
        device_code_hash: hashCode(dc),
        user_code_hash: hashCode("PEND-1111"),
        code_challenge: "chal",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      expect((await (await poll(dc)).json()).error.code).toBe("authorization_pending");
    });

    it("returns slow_down on a too-fast second poll and bumps the interval", async () => {
      const dc = "dc-slow";
      await db.createDeviceCode({
        device_code_hash: hashCode(dc),
        user_code_hash: hashCode("SLOW-1111"),
        code_challenge: "chal",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      expect((await (await poll(dc)).json()).error.code).toBe("authorization_pending");
      expect((await (await poll(dc)).json()).error.code).toBe("slow_down");
      const row = await db.getDeviceCodeByDeviceHash(hashCode(dc));
      expect(row?.current_interval).toBe(10);
    });

    it("a wrong PKCE verifier does not consume the code until the 3rd attempt", async () => {
      const user = await db.createUser({ github_id: "poll-pk", username: "pk" });
      const dc = "dc-pkce";
      await db.createDeviceCode({
        device_code_hash: hashCode(dc),
        user_code_hash: hashCode("PKCE-2222"),
        code_challenge: createHash("sha256").update("right".repeat(9)).digest("base64url"),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        current_interval: 0, // disable slow_down so each poll reaches the PKCE check
      });
      await db.authorizeDeviceCode(hashCode("PKCE-2222"), user.id);
      for (let i = 0; i < 3; i++) {
        expect((await (await poll(dc, "wrong")).json()).error.code).toBe("invalid_grant");
      }
      // After 3 failures the code is consumed → expired_token.
      expect((await (await poll(dc, "wrong")).json()).error.code).toBe("expired_token");
    });

    it("authorized + correct verifier → token in the body, then the code is consumed", async () => {
      const user = await db.createUser({ github_id: "poll-ok", username: "poller" });
      const verifier = "v".repeat(43);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const dc = "dc-ok-secret";
      await db.createDeviceCode({
        device_code_hash: hashCode(dc),
        user_code_hash: hashCode("OKAY-3333"),
        code_challenge: challenge,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      await db.authorizeDeviceCode(hashCode("OKAY-3333"), user.id);

      const res = await poll(dc, verifier);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(0);
      expect(body.username).toBe("poller");
      // Consumed → a second poll fails.
      expect((await (await poll(dc, verifier)).json()).error.code).toBe("expired_token");
    });

    it("VT-15 (#116): the key minted by the login flow carries an expiry", async () => {
      const user = await db.createUser({ github_id: "poll-exp", username: "expirer" });
      const verifier = "v".repeat(43);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const dc = "dc-expiry-secret";
      await db.createDeviceCode({
        device_code_hash: hashCode(dc),
        user_code_hash: hashCode("EXPI-5555"),
        code_challenge: challenge,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      await db.authorizeDeviceCode(hashCode("EXPI-5555"), user.id);

      const res = await poll(dc, verifier);
      expect(res.status).toBe(200);
      const { token } = await res.json();
      // Read the persisted row rather than the response: the expiry is a
      // property of the credential, and the login response does not carry it.
      const stored = await db.getApiKeyByHash(hashApiKey(token));
      expect(stored?.expires_at).toBeTruthy();
      const days =
        (new Date(stored?.expires_at as string).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThan(91);
    });

    it("CODE-209: expired_token + consumes the code when the authorized user no longer exists", async () => {
      const verifier = "v".repeat(43);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const dc = "dc-deleted-user";
      await db.createDeviceCode({
        device_code_hash: hashCode(dc),
        user_code_hash: hashCode("GONE-4444"),
        code_challenge: challenge,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      // Authorize against a user id that no longer exists (deleted between
      // authorize and poll).
      await db.authorizeDeviceCode(hashCode("GONE-4444"), "deleted-user-id");

      const res = await poll(dc, verifier);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("expired_token");
      // The code was consumed → a second poll also fails (no key was minted).
      expect((await (await poll(dc, verifier)).json()).error.code).toBe("expired_token");
    });
  });

  it("device flow: the /device endpoint is rate-limited (429 past the cap)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await app.request("/device")).status);
    }
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
  });

  it("RT-1 (#116): /auth/device/token stays rate-limited after the push/run remount", async () => {
    // The push/run limiter remount must not displace the device mounts.
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      statuses.push((await app.request("/auth/device/token", { method: "POST" })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s !== 429).length).toBeGreaterThan(0);
  });

  it("device flow: multi-instance — a code authorized via the shared DB is pollable from another app instance", async () => {
    // Two createApp instances over ONE shared DbAdapter. This is a shared-adapter
    // test (one process): it proves the device state lives in the DB, not in a
    // per-app/process memory map — so the browser-callback and the CLI-poll can hit
    // different cloud instances. (A true cross-process Postgres check is the live phase.)
    const appB = createApp(new MemoryStorage(), db);
    const user = await db.createUser({ github_id: "mi-1", username: "mi" });
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const deviceCode = "mi-device-secret";
    await db.createDeviceCode({
      device_code_hash: hashCode(deviceCode),
      user_code_hash: hashCode("MULT-1234"),
      code_challenge: challenge,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    // "Authorized on instance A" (persisted to the shared DB) → poll instance B.
    await db.authorizeDeviceCode(hashCode("MULT-1234"), user.id);
    const res = await appB.request("/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode, code_verifier: verifier }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token.length).toBeGreaterThan(0);
  });

  it("device flow: the device_code, verifier, and minted token never appear in the logs", async () => {
    const user = await db.createUser({ github_id: "red-1", username: "red" });
    const verifier = "redactionverifiersecretvalue1234567890ABCDE";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const deviceCode = "device-secret-to-detect-in-logs";
    await db.createDeviceCode({
      device_code_hash: hashCode(deviceCode),
      user_code_hash: hashCode("REDA-9999"),
      code_challenge: challenge,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    await db.authorizeDeviceCode(hashCode("REDA-9999"), user.id);

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    let token = "";
    try {
      const res = await app.request("/auth/device/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode, code_verifier: verifier }),
      });
      token = (await res.json()).token;
    } finally {
      spy.mockRestore();
    }
    const logs = writes.join("");
    expect(logs).not.toContain(deviceCode);
    expect(logs).not.toContain(verifier);
    expect(token.length).toBeGreaterThan(0);
    expect(logs).not.toContain(token);
  });

  // RT-proxy (#009 follow-up): the OAuth redirect_uri honours X-Forwarded-Proto so
  // login works behind a TLS-terminating proxy (Fly/Caddy/nginx). Previously it was
  // built from the internal http request → GitHub rejected the http:// redirect_uri
  // as "Invalid Redirect URI".
  it("RT-proxy: /auth/github builds an https redirect_uri from X-Forwarded-Proto", async () => {
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    try {
      const res = await app.request("http://skrun-cloud-api-test.fly.dev/auth/github", {
        headers: { "X-Forwarded-Proto": "https" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const redirectUri = new URL(res.headers.get("Location")!).searchParams.get("redirect_uri")!;
      expect(redirectUri).toBe("https://skrun-cloud-api-test.fly.dev/auth/github/callback");
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });

  // ── #101 oauth-signup-allowlist ───────────────────────────────────────────
  describe("#101 allowlist gate", () => {
    /**
     * Mock GitHub OAuth (token + profile) and drive a full callback. `device`
     * (a user_code) makes it a device-login callback. Returns the callback Response.
     */
    async function loginViaCallback(gh: { id: number; login: string }, device?: string) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          const body = url.includes("access_token")
            ? { access_token: "tok" }
            : { id: gh.id, login: gh.login, email: null };
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
      );
      const redirect = await app.request("/auth/github", { redirect: "manual" });
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const state = new URL(redirect.headers.get("Location")!).searchParams.get("state")!;
      // biome-ignore lint/style/noNonNullAssertion: present after the redirect
      const stateCookie = redirect.headers.get("Set-Cookie")!.split(";")[0];
      const cookie = device ? `${stateCookie}; skrun_device_user_code=${device}` : stateCookie;
      return app.request(`/auth/github/callback?code=c&state=${state}`, {
        headers: { Cookie: cookie },
        redirect: "manual",
      });
    }

    beforeEach(() => {
      process.env.GITHUB_CLIENT_ID = "id";
      process.env.GITHUB_CLIENT_SECRET = "secret";
    });

    it("#101-VT-4: a listed new user is allowed (created + session + /dashboard)", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice,bob";
      const res = await loginViaCallback({ id: 1, login: "Alice" });
      expect(res.status).toBe(302);
      // Exact, not a substring: with no destination configured the callback
      // must land on /dashboard and carry NO query parameter — the unconfigured
      // branch of the return destination (#123). A `toContain` would also have
      // accepted "https://elsewhere.example/dashboard?login=failed".
      expect(res.headers.get("Location")).toBe("/dashboard");
      expect(res.headers.get("Set-Cookie")).toContain("skrun_session=");
      expect(await db.getUserByGithubId("1")).toBeTruthy();
    });

    it("#101-VT-5: an existing user NOT on the list is rejected (every-login)", async () => {
      await db.createUser({ github_id: "2", username: "carol" });
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
      const res = await loginViaCallback({ id: 2, login: "carol" });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Not authorized");
      expect(res.headers.get("Set-Cookie") ?? "").not.toContain("skrun_session=");
    });

    it("#101-VT-6: a non-listed user → generic page, no echo, no upsert", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
      const res = await loginViaCallback({ id: 90909090, login: "mallory-unlisted" });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("Not authorized");
      expect(html).not.toContain("mallory-unlisted"); // no echo of login
      expect(html).not.toContain("90909090"); // no echo of id
      expect(await db.getUserByGithubId("90909090")).toBeNull();
    });

    it("#101-VT-10: a rejected login is logged (signup_rejected)", async () => {
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
      logWarnSpy.mockClear();
      await loginViaCallback({ id: 77, login: "mallory" });
      expect(logWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: "signup_rejected", login: "mallory", id: 77 }),
      );
    });

    it("#101-RT-1: with the var unset, web login is unchanged (allowed)", async () => {
      const res = await loginViaCallback({ id: 3, login: "anyone" });
      expect(res.status).toBe(302);
      // Exact, not a substring: with no destination configured the callback
      // must land on /dashboard and carry NO query parameter — the unconfigured
      // branch of the return destination (#123). A `toContain` would also have
      // accepted "https://elsewhere.example/dashboard?login=failed".
      expect(res.headers.get("Location")).toBe("/dashboard");
    });

    async function seedDeviceCode(userCode: string) {
      await db.createDeviceCode({
        device_code_hash: hashCode(`dev-${userCode}`),
        user_code_hash: hashCode(userCode),
        code_challenge: "chal",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }

    it("#101-VT-7: a device reject consumes the code (→ expired_token) + clears the cookie", async () => {
      const userCode = "WXYZ-7777";
      await seedDeviceCode(userCode);
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
      const res = await loginViaCallback({ id: 8, login: "mallory" }, userCode);
      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie") ?? "").toContain("skrun_device_user_code=;");
      // consumed (deleted) → a subsequent poll would get expired_token
      expect(await db.getDeviceCodeByUserHash(hashCode(userCode))).toBeNull();
      expect(await db.getUserByGithubId("8")).toBeNull();
    });

    it("#101-VT-8: a listed device login authorizes the code (the device path, unchanged)", async () => {
      const userCode = "WXYZ-8888";
      await seedDeviceCode(userCode);
      process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
      const res = await loginViaCallback({ id: 9, login: "Alice" }, userCode);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("You're all set");
      expect((await db.getDeviceCodeByUserHash(hashCode(userCode)))?.status).toBe("authorized");
    });

    it("#101-VT-1 (device): unset var → a device login authorizes (no reject)", async () => {
      const userCode = "WXYZ-0000";
      await seedDeviceCode(userCode);
      // SKRUN_ALLOWED_GITHUB_USERS stays unset → open
      const res = await loginViaCallback({ id: 10, login: "anyone" }, userCode);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("You're all set");
      expect((await db.getDeviceCodeByUserHash(hashCode(userCode)))?.status).toBe("authorized");
    });
  });

  // VT-2: OAuth callback creates user + sets cookie (mocked GitHub)
  it("VT-2: GET /auth/github/callback creates user and sets session cookie", async () => {
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    // Mock GitHub API calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("login/oauth/access_token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "gho_test_token" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("api.github.com/user")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 12345,
                login: "Alice",
                email: "alice@test.com",
                avatar_url: "https://avatar.test/alice",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }),
    );

    // First, get the state from /auth/github redirect
    const redirectRes = await app.request("/auth/github", { redirect: "manual" });
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const location = new URL(redirectRes.headers.get("Location")!);
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const state = location.searchParams.get("state")!;
    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const stateCookie = redirectRes.headers.get("Set-Cookie")!;

    // Call callback with the state
    const callbackRes = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {
      headers: { Cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    });
    expect(callbackRes.status).toBe(302);
    // Exact, not a substring — see the note on #101-VT-4 above (#123).
    expect(callbackRes.headers.get("Location")).toBe("/dashboard");

    // Session cookie should be set
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const cookies = callbackRes.headers.get("Set-Cookie")!;
    expect(cookies).toContain("skrun_session=");

    // User should be created in DB
    const user = await db.getUserByGithubId("12345");
    expect(user).toBeTruthy();
    expect(user?.username).toBe("alice"); // lowercased
    expect(user?.email).toBe("alice@test.com");

    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-13 (#124): the value handed to the browser is the raw id; the database
  // holds only its hash. Asserting the row exists under the hash AND does not
  // exist under the cookie value is what separates "a session was stored" from
  // "a usable credential was stored".
  it("VT-13 (#124): the login cookie is the raw id, the row holds only its hash", async () => {
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("login/oauth/access_token")) {
            return Promise.resolve(
              new Response(JSON.stringify({ access_token: "gho_test_token" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          }
          if (url.includes("api.github.com/user")) {
            return Promise.resolve(
              new Response(JSON.stringify({ id: 424242, login: "hashy" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          }
          return Promise.resolve(new Response("Not Found", { status: 404 }));
        }),
      );

      const redirectRes = await app.request("/auth/github", { redirect: "manual" });
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const location = new URL(redirectRes.headers.get("Location")!);
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const state = location.searchParams.get("state")!;
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const stateCookie = redirectRes.headers.get("Set-Cookie")!;

      const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
        headers: { Cookie: stateCookie.split(";")[0] },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      // Exact, not a substring: with no destination configured the callback
      // must land on /dashboard and carry NO query parameter — the unconfigured
      // branch of the return destination (#123). A `toContain` would also have
      // accepted "https://elsewhere.example/dashboard?login=failed".
      expect(res.headers.get("Location")).toBe("/dashboard");

      // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
      const setCookie = res.headers.get("Set-Cookie")!;
      const raw = setCookie.match(/skrun_session=([^;]+)/)?.[1] ?? "";
      expect(raw).not.toBe("");
      // A session id that was never awaited would arrive here as the string
      // form of a promise, and every later request would simply fall through.
      expect(raw).not.toContain("Promise");

      const user = await db.getUserByGithubId("424242");
      expect(user).toBeTruthy();

      // Nothing is stored under the cookie value itself.
      expect(await db.getSession(raw)).toBeNull();
      const row = await db.getSession(hashSessionId(raw));
      expect(row?.user_id).toBe(user?.id);
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });

  it("device flow: callback with the device cookie authorizes the code, clears it, no token", async () => {
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";
    try {
      const userCode = "WXYZ-3456";
      await db.createDeviceCode({
        device_code_hash: hashCode(`dev-${userCode}`),
        user_code_hash: hashCode(userCode),
        code_challenge: "chal",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("access_token")) {
            return Promise.resolve(
              new Response(JSON.stringify({ access_token: "tok" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: 67890, login: "Dev", email: "dev@test.com" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
      );

      const redirectRes = await app.request("/auth/github", { redirect: "manual" });
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const state = new URL(redirectRes.headers.get("Location")!).searchParams.get("state")!;
      // biome-ignore lint/style/noNonNullAssertion: present after the redirect
      const stateCookie = redirectRes.headers.get("Set-Cookie")!.split(";")[0];

      const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
        headers: { Cookie: `${stateCookie}; skrun_device_user_code=${userCode}` },
        redirect: "manual",
      });

      // Device flow ends with the "all set" page — NOT a /dashboard redirect, NO token.
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("You're all set");
      expect(apiKeyShapes(html)).toEqual([]);
      expect(res.headers.get("Location")).toBeNull();
      // The device cookie is cleared.
      expect(res.headers.get("Set-Cookie")).toContain("skrun_device_user_code=;");

      // The device code is now authorized + bound to the user.
      const user = await db.getUserByGithubId("67890");
      const dc = await db.getDeviceCodeByUserHash(hashCode(userCode));
      expect(dc?.status).toBe("authorized");
      expect(dc?.user_id).toBe(user?.id);
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });

  // VT-3: callback with existing user updates, doesn't duplicate
  it("VT-3: OAuth callback updates existing user, no duplication", async () => {
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    // Pre-create user
    await db.createUser({ github_id: "12345", username: "alice", email: "old@test.com" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("access_token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "tok" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("api.github.com/user")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 12345,
                login: "alice",
                email: "new@test.com",
                avatar_url: "https://new-avatar",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const redirectRes = await app.request("/auth/github", { redirect: "manual" });
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const state = new URL(redirectRes.headers.get("Location")!).searchParams.get("state")!;
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const stateCookie = redirectRes.headers.get("Set-Cookie")!;

    await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    });

    // Should still be 1 user, with updated email
    const user = await db.getUserByGithubId("12345");
    expect(user?.email).toBe("new@test.com");
    expect(user?.avatar_url).toBe("https://new-avatar");

    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // POST /api/keys creates key
  it("POST /api/keys creates key with correct format", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = await createSession(db, user.id);

    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${sessionId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "CI key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(isApiKeyFormat(body.key)).toBe(true);
    expect(body.name).toBe("CI key");
    expect(body.key_prefix).toBe(body.key.slice(0, API_KEY_PREFIX.length + 8));
    expect(body.scopes).toContain("agent:push");
  });

  it("GET /api/keys lists a minted key with the prefix and the first 8 body characters of the key", async () => {
    const user = await db.createUser({ github_id: "gh-list-prefix", username: "alice" });
    const sessionId = await createSession(db, user.id);
    const cookie = `${sessionCookieName()}=${sessionId}`;

    const res = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "listed key" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(isApiKeyFormat(created.key)).toBe(true);

    const listRes = await app.request("/api/keys", { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as Array<{ id: string; key_prefix: string }>;
    const row = listed.find((k) => k.id === created.id);
    const body = created.key.slice(API_KEY_PREFIX.length);
    expect(row?.key_prefix).toBe(`${API_KEY_PREFIX}${body.slice(0, 8)}`);
    expect(row?.key_prefix).toHaveLength(17);
  });

  // VT-16 (#116): POST /api/keys accepts an expiry, persists it, and hands it
  // back — both on the mint response and on the list.
  it("VT-16: POST /api/keys persists an expires_at and GET /api/keys reads it back", async () => {
    const user = await db.createUser({ github_id: "gh-exp", username: "alice" });
    const sessionId = await createSession(db, user.id);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${sessionId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "client key", expires_at: expiresAt }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.expires_at).toBe(expiresAt);

    const listRes = await app.request("/api/keys", {
      headers: { Cookie: `${sessionCookieName()}=${sessionId}` },
    });
    const listed = await listRes.json();
    expect(listed.find((k: { id: string }) => k.id === created.id)?.expires_at).toBe(expiresAt);
  });

  it("VT-16b: an unparseable or past expires_at is refused 400 INVALID_REQUEST", async () => {
    const user = await db.createUser({ github_id: "gh-exp2", username: "alice" });
    const sessionId = await createSession(db, user.id);
    const mint = (expires_at: string) =>
      app.request("/api/keys", {
        method: "POST",
        headers: {
          Cookie: `${sessionCookieName()}=${sessionId}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "bad key", expires_at }),
      });

    for (const bad of ["not-a-date", new Date(Date.now() - 60_000).toISOString()]) {
      const res = await mint(bad);
      expect(res.status, `expires_at=${bad}`).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_REQUEST");
    }
  });

  it("VT-16c: no expiry is imposed when the request omits one", async () => {
    const user = await db.createUser({ github_id: "gh-exp3", username: "alice" });
    const sessionId = await createSession(db, user.id);
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${sessionId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "integration key" }),
    });
    // A key wired into someone else's integration must not acquire a lifetime
    // the caller never asked for.
    expect((await res.json()).expires_at).toBeNull();
  });

  it("VT-17: a key whose expires_at is past is refused 401", async () => {
    const user = await db.createUser({ github_id: "gh-exp4", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "stale",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.request("/api/me", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(401);
  });

  it("RT-6: an existing key with no expiry stays accepted — expiry is never retroactive", async () => {
    const user = await db.createUser({ github_id: "gh-exp5", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "legacy",
    });
    const res = await app.request("/api/me", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
  });

  // VT-5: API key authenticates POST /run
  it("VT-5: API key authenticates requests", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "test",
    });

    const res = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("alice");
    expect(body.namespace).toBe("alice");
  });

  // VT-6: DELETE /api/keys revokes, key no longer works
  it("VT-6: API key revocation works", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = await createSession(db, user.id);

    // Create key
    const createRes = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${sessionId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "temp" }),
    });
    const { id, key } = await createRes.json();

    // Key works
    const meRes = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(meRes.status).toBe(200);

    // Revoke
    const deleteRes = await app.request(`/api/keys/${id}`, {
      method: "DELETE",
      // A DELETE carrying the session cookie and no Content-Type is exactly the
      // shape the CSRF guard refuses. A browser puts Sec-Fetch-Site on it — the
      // dashboard's own delete is saved by that header and by nothing else — so
      // the request here does what a browser does, rather than the guard being
      // loosened to accommodate a test.
      headers: { Cookie: `${sessionCookieName()}=${sessionId}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(deleteRes.status).toBe(204);

    // Key no longer works
    const meRes2 = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(meRes2.status).toBe(401);
  });

  // VT-17 (#65): key management is master-credential-only (no escalation).
  async function keyFor(
    username: string,
    opts: { scope_kind?: "account" | "agents"; scopes?: string[] },
  ): Promise<string> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: username,
      scope_kind: opts.scope_kind ?? "account",
      scopes: opts.scopes,
      agents: [],
    });
    return key;
  }

  it("VT-17: a delegated (agents-scoped) key cannot mint a key → 403", async () => {
    const key = await keyFor("del", { scope_kind: "agents", scopes: ["agent:run"] });
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("KEY_SCOPE_FORBIDDEN");
  });

  it("VT-17: a run-only account key cannot mint a key → 403", async () => {
    const key = await keyFor("ro", { scope_kind: "account", scopes: ["agent:run"] });
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("VT-17: an account-full key CAN mint a key → 201", async () => {
    // No scopes → default full account = master credential.
    const key = await keyFor("full", {});
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(201);
  });

  it("VT-17: a delegated key cannot revoke a key → 403", async () => {
    const key = await keyFor("del2", { scope_kind: "agents", scopes: ["agent:run"] });
    const res = await app.request("/api/keys/any-id", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });

  // VT-2/3/4 (#65): mint with resource scope + ownership validation.
  function mintAs(session: string, payload: Record<string, unknown>) {
    return app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${session}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("VT-2: mint defaults to scope_kind 'account' + full operation scopes", async () => {
    const user = await db.createUser({ github_id: "gh-m2", username: "m2" });
    const res = await mintAs(await createSession(db, user.id), { name: "k" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scope_kind).toBe("account");
    expect(body.scopes).toEqual(["agent:run", "agent:push", "agent:verify"]);
  });

  it("VT-3: mint scope_kind 'agents' to an owned agent persists grants", async () => {
    const user = await db.createUser({ github_id: "gh-m3", username: "m3" });
    const agent = await db.createAgent({
      name: "agent1",
      namespace: "m3",
      description: "",
      owner_id: user.id,
    });
    const res = await mintAs(await createSession(db, user.id), {
      name: "scoped",
      scope_kind: "agents",
      agents: ["m3/agent1"],
      scopes: ["agent:run"],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scope_kind).toBe("agents");
    expect(body.agents).toEqual(["m3/agent1"]);
    expect(await db.getApiKeyAgentIds(body.id)).toEqual([agent.id]);
  });

  it("VT-4: mint scope_kind 'agents' to a NOT-owned agent → 403", async () => {
    const bob = await db.createUser({ github_id: "gh-bob4", username: "bob4" });
    await db.createAgent({ name: "secret", namespace: "bob4", description: "", owner_id: bob.id });
    const alice = await db.createUser({ github_id: "gh-alice4", username: "alice4" });
    const res = await mintAs(await createSession(db, alice.id), {
      name: "x",
      scope_kind: "agents",
      agents: ["bob4/secret"],
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown operation scope → 400", async () => {
    const user = await db.createUser({ github_id: "gh-m5", username: "m5" });
    const res = await mintAs(await createSession(db, user.id), {
      name: "x",
      scopes: ["agent:nuke"],
    });
    expect(res.status).toBe(400);
  });

  // VT-7: Push to own namespace succeeds
  it("VT-7: push to own namespace succeeds", async () => {
    const res = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("test-agent")),
    });
    expect(res.status).toBe(200);
  });

  // VT-8: Push to other namespace returns 403
  it("VT-8: push to other namespace returns 403", async () => {
    const res = await app.request("/api/agents/other/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("test-agent")),
    });
    expect(res.status).toBe(403);
  });

  // VT-9: Run on a verified version is public (no namespace gate at run-time)
  it("VT-9: run on another user's verified agent succeeds (no namespace gate at run-time)", async () => {
    // Push as dev (creates row with verified=false)
    const pushed = await app.request("/api/agents/dev/my-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("my-agent")),
    });
    expect(pushed.status).toBe(200);

    // Admin (dev-token = admin) verifies v1.0.0 so the hard 403 gate passes.
    await db.setVersionVerified("dev", "my-agent", "1.0.0", true);

    // Run with a different token — still works (auth succeeds, no namespace
    // check at run-time, version is verified).
    const res = await app.request("/api/agents/dev/my-agent/run", {
      method: "POST",
      headers: { Authorization: "Bearer other-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    // Past auth + verified gate now — a downstream refusal (no model key
    // serves the run) is acceptable, but the response must NOT be 403.
    expect(res.status).not.toBe(403);
  });

  // VT-10: Dev-token fallback when no OAuth configured
  it("VT-10: dev-token fallback works when OAuth not configured", async () => {
    const res = await app.request("/api/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.namespace).toBe("dev");
  });

  // VT-11: GET /api/me returns user info
  it("VT-11: GET /api/me returns full user info", async () => {
    const user = await db.createUser({
      github_id: "gh-1",
      username: "alice",
      email: "alice@test.com",
      avatar_url: "https://avatar/alice",
    });
    const sessionId = await createSession(db, user.id);

    const res = await app.request("/api/me", {
      headers: { Cookie: `${sessionCookieName()}=${sessionId}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(user.id);
    expect(body.username).toBe("alice");
    expect(body.namespace).toBe("alice");
    expect(body.email).toBe("alice@test.com");
    expect(body.avatar_url).toBe("https://avatar/alice");
    expect(body.plan).toBe("free");
    // SEC-005 F-2 fix: role exposed for dashboard conditional rendering.
    expect(body.role).toBe("user");
    // Verification policy surfaced read-only for the dashboard (default admin).
    expect(body.verification_policy).toBe("admin");
  });

  // VT-9: /api/me reflects the configured operator verification policy.
  it("VT-9: GET /api/me reflects the configured verification policy", async () => {
    const policyDb = new MemoryDb();
    const policyApp = createApp(new MemoryStorage(), policyDb, { verificationPolicy: "owner" });
    const u = await policyDb.createUser({ github_id: "gh-vp", username: "vp" });
    // This case builds its own app on its own adapter: the session has to land
    // in the adapter that app reads from, not in the suite's default one.
    const sessionId = await createSession(policyDb, u.id);

    const res = await policyApp.request("/api/me", {
      headers: { Cookie: `${sessionCookieName()}=${sessionId}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).verification_policy).toBe("owner");
  });

  // SEC-005 (4.3): /api/me surfaces role='admin' for dev-token caller (Q-11)
  it("GET /api/me returns role='admin' for dev-token caller", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const res = await app.request("/api/me", {
      headers: { Authorization: "Bearer dev-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("admin");
  });

  // VT-12: Login page renders with GitHub button
  it("VT-12: GET /login returns HTML with GitHub button when OAuth configured", async () => {
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";

    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("/auth/github");

    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });

  // VT-12b: Login page without OAuth shows dev-token message
  it("VT-12b: GET /login shows dev-token message when no OAuth", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("dev-token");
    expect(html).not.toContain("/auth/github");
  });

  // VT-8 (#93): the login logo is flag-independent — inline SVG, never a
  // /dashboard asset (which would 404 when SKRUN_DASHBOARD=off, the test default).
  it("VT-8: GET /login renders an inline SVG logo, not a /dashboard asset", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<svg");
    expect(html).not.toContain("/dashboard/logo.png");
  });

  // SC-9 (#009): /login advertises dev-token ONLY when dev-auth is enabled.
  it("SC-9: GET /login does not advertise dev-token when dev-auth is off", async () => {
    const prevDevAuth = process.env.SKRUN_DEV_AUTH;
    const prevId = process.env.GITHUB_CLIENT_ID;
    const prevSecret = process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SKRUN_DEV_AUTH;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    try {
      const res = await app.request("/login");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("dev-token");
      expect(html).toContain("API key");
    } finally {
      if (prevDevAuth === undefined) delete process.env.SKRUN_DEV_AUTH;
      else process.env.SKRUN_DEV_AUTH = prevDevAuth;
      if (prevId === undefined) delete process.env.GITHUB_CLIENT_ID;
      else process.env.GITHUB_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
      else process.env.GITHUB_CLIENT_SECRET = prevSecret;
    }
  });

  // VT-13: Logout clears session — and, since the store is the database,
  // VT-12 (#124): it must also delete the row. Clearing only the cookie would
  // leave a working credential behind for anyone who kept a copy of it.
  it("VT-13: POST /auth/logout clears session cookie and deletes the row (#124)", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = await createSession(db, user.id);
    expect(await db.getSession(hashSessionId(sessionId))).not.toBeNull();

    const res = await app.request("/auth/logout", {
      method: "POST",
      // Sec-Fetch-Site: the dashboard's sign-out is a POST with the cookie and no
      // Content-Type, and this header is the only thing that carries it past the
      // CSRF guard. Sending it here is reproducing the browser, not weakening the
      // guard.
      headers: { Cookie: `${sessionCookieName()}=${sessionId}`, "Sec-Fetch-Site": "same-origin" },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const cookies = res.headers.get("Set-Cookie")!;
    expect(cookies).toContain("skrun_session=;");

    expect(await db.getSession(hashSessionId(sessionId))).toBeNull();
  });

  // An unknown API key returns 401
  it("an unknown API key returns 401", async () => {
    const { key } = generateApiKey();
    const res = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });

  // VT-15: Expired API key returns 401
  it("VT-15: expired API key returns 401", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "expired",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
  });
});

// Sign-out on the one deployment shape where it is hard: production, with a
// cookie domain configured. Two things can go wrong there and neither shows up
// in a default test run — the erasure can miss a cookie that is still
// authenticating, or it can THROW before writing a header and turn the sign-out
// into a 500.
//
// The app is built inside the block because the startup interlock reads the
// environment once, at createApp time.
describe("POST /auth/logout under a configured cookie domain (#123)", () => {
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    // Production is not decoration here: it is what turns the Secure flag on,
    // which is what turns the prefix on, which is the only configuration where
    // hono's serialiser can throw. A case that forgot this line would exercise
    // the unprefixed path and stay green over a broken sign-out.
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com"; // required in production
    delete process.env.SKRUN_DEV_AUTH; // production + dev-auth refuses to boot
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";

    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  // The transition case, and the reason the erasure list covers every name on
  // every scope (five entries here). A browser that signed in before the domain
  // was configured carries a host-only cookie under an older name; one that signs
  // in after carries a domain-scoped cookie under the prefixed name. A sign-out
  // that erased only the second would leave the first authenticating for the
  // rest of its seven days — and the user would have been told they were signed
  // out.
  it("RT-3 (#125): sign-out covers every name and both scopes, and neither cookie signs anyone in afterwards", async () => {
    const user = await db.createUser({ github_id: "gh-two-scopes", username: "twoscopes" });
    const currentSession = await createSession(db, user.id);
    const legacySession = await createSession(db, user.id);

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `__Secure-skrun_session=${currentSession}; skrun_session=${legacySession}`,
        // As above: a cookie-borne POST with no Content-Type is refused by the
        // CSRF guard unless the browser signal is present.
        "Sec-Fetch-Site": "same-origin",
      },
      redirect: "manual",
    });
    expect(res.status).toBe(200);

    // Read as a list, not as the joined string — a single get() would hide a
    // missing header behind a comma.
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(5);
    const erased = setCookies.map((c) => {
      const name = c.slice(0, c.indexOf("="));
      const domain = /;\s*Domain=([^;]+)/i.exec(c)?.[1];
      return `${name}|${domain ?? "-"}`;
    });
    expect(new Set(erased)).toEqual(
      new Set([
        "skrun_session|-",
        "skrun_session|example.com",
        "__Host-skrun_session|-",
        "__Secure-skrun_session|-",
        "__Secure-skrun_session|example.com",
      ]),
    );

    // The session the request actually presented is gone from the store.
    expect(await db.getSession(hashSessionId(currentSession))).toBeNull();

    // And neither cookie authenticates anything now: the current one because its
    // row is gone, the legacy one because the server no longer reads that name at
    // all under this configuration — which is why erasing it in the browser is
    // the whole of the remedy.
    for (const cookie of [
      `__Secure-skrun_session=${currentSession}`,
      `skrun_session=${legacySession}`,
    ]) {
      const after = await app.request("/api/me", { headers: { Cookie: cookie } });
      expect(after.status, cookie).toBe(401);
    }
  });

  // The erasure must not THROW. hono's setCookie refuses to serialise a prefixed
  // name without secure:true, and a __Host- name WITH a Domain, and raises
  // instead — so an erasure that forgot either rule answers 500 in exactly the
  // nominal case of a domain-configured production deployment, and nothing
  // locally shows it because no name is prefixed there. Asserted through a real
  // request, never through the options object: it is the serialisation that
  // throws, not the factory.
  it("VT-4 (#125): sign-out with a cookie domain answers 200 with five legal erasures, the __Host- one without Domain", async () => {
    const user = await db.createUser({ github_id: "gh-no-throw", username: "nothrow" });
    const sessionId = await createSession(db, user.id);

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `__Secure-skrun_session=${sessionId}`,
        // Same reason as the two cases above — the browser signal, not a
        // relaxation of the guard.
        "Sec-Fetch-Site": "same-origin",
      },
      redirect: "manual",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(5);
    for (const cookie of setCookies) {
      expect(cookie, cookie).toMatch(/;\s*Max-Age=0/i);
      expect(cookie, cookie).toMatch(/;\s*Secure/i);
      expect(cookie, cookie).toMatch(/;\s*Path=\//i);
    }
    // Both scopes present — the half that makes the erasure reach the cookie an
    // older browser is still carrying.
    expect(setCookies.filter((c) => /;\s*Domain=example\.com/i.test(c))).toHaveLength(2);
    expect(setCookies.filter((c) => !/;\s*Domain=/i.test(c))).toHaveLength(3);
    // The host-locked name is erased host-only — with a Domain it would throw.
    const hostLocked = setCookies.filter((c) => c.startsWith("__Host-skrun_session="));
    expect(hostLocked).toHaveLength(1);
    expect(hostLocked[0]).not.toMatch(/;\s*Domain=/i);
  });
});

// The session cookie in production with NO cookie domain — the default of the
// published image and of the shipped compose stack, and the one configuration
// where the session cookie is host-locked. NODE_ENV is set explicitly: the file
// runs in test, where no prefix is ever applied and nothing here could fail.
//
// The app is built inside beforeEach because the startup interlock reads the
// environment once, at createApp time. Sessions are created with the app's OWN
// adapter — a second adapter would answer 401 for an unrelated reason.
describe("the session cookie in production with no cookie domain (#125)", () => {
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com"; // required in production
    delete process.env.SKRUN_DEV_AUTH; // production + dev-auth refuses to boot
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    logWarnSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  async function signedIn(username: string): Promise<{ id: string; session: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    return { id: user.id, session: await createSession(db, user.id) };
  }

  function duplicateWarnings(): unknown[] {
    return logWarnSpy.mock.calls.filter(
      ([fields]) =>
        (fields as { event?: string } | undefined)?.event === "session_cookie_duplicate",
    );
  }

  // A real sign-in, end to end: the state cookie from /auth/github is sent back
  // to a real callback, and the session cookie it writes is read off the wire.
  it("VT-2 (#125): a finished web sign-in sets __Host-skrun_session, host-only, and lands on the dashboard", async () => {
    stubGithubOk({ id: 125002, login: "hostonly" });

    const start = await app.request("/auth/github", { redirect: "manual" });
    const location = start.headers.get("Location") ?? "";
    const state = new URL(location).searchParams.get("state") ?? "";
    const stateCookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    expect(state).not.toBe("");

    const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: stateCookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");

    const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-skrun_session="));
    expect(session).toBeDefined();
    expect(session).toMatch(/;\s*Path=\/(;|$)/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    expect(session).not.toMatch(/;\s*Domain=/i);
    // No session is written under any other name.
    expect(
      res.headers.getSetCookie().filter((c) => /^(__Secure-)?skrun_session=[^;]/.test(c)),
    ).toHaveLength(0);
  });

  // Sign-out without a domain: the three names host-only, every one legal.
  it("VT-4 (#125): sign-out with no cookie domain answers 200 with three host-only erasures", async () => {
    const { session } = await signedIn("signout");

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `__Host-skrun_session=${session}`,
        // A cookie-borne POST with no Content-Type needs the browser signal to
        // pass the forgery guard.
        "Sec-Fetch-Site": "same-origin",
      },
      redirect: "manual",
    });
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.map((c) => c.slice(0, c.indexOf("=")))).toEqual([
      "skrun_session",
      "__Host-skrun_session",
      "__Secure-skrun_session",
    ]);
    for (const cookie of setCookies) {
      expect(cookie, cookie).toMatch(/;\s*Max-Age=0/i);
      expect(cookie, cookie).toMatch(/;\s*Secure/i);
      expect(cookie, cookie).toMatch(/;\s*Path=\//i);
      expect(cookie, cookie).not.toMatch(/;\s*Domain=/i);
    }
    expect(await db.getSession(hashSessionId(session))).toBeNull();
  });

  // The bare name is inert: it authenticates nobody, and it does not arm the
  // forgery guard either (the guard arms on the current name only, and it is
  // mounted BEFORE authentication — so a 403 here would mean the old cookie was
  // still treated as an ambient credential).
  it("VT-5 (#125): the bare cookie name authenticates nobody and does not arm the forgery guard", async () => {
    const { id, session } = await signedIn("oldname");
    const oldCookie = `skrun_session=${session}`;

    const me = await app.request("/api/me", { headers: { Cookie: oldCookie } });
    expect(me.status).toBe(401);

    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "script",
      scopes: ["read", "write", "admin"],
    });
    const withKey = await app.request("/api/me", {
      headers: { Cookie: oldCookie, Authorization: `Bearer ${key}` },
    });
    expect(withKey.status).toBe(200);
    expect((await withKey.json()).username).toBe("oldname");

    const formPost = (cookie: string) =>
      app.request("/api/keys", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=k",
      });

    const viaOldName = await formPost(oldCookie);
    expect(viaOldName.status).toBe(401);
    expect(await viaOldName.text()).not.toBe("Forbidden");

    // Witness: the same request under the current name IS refused by the guard,
    // so the 401 above is the old name being ignored, not the guard being absent.
    const viaCurrentName = await formPost(`__Host-skrun_session=${session}`);
    expect(viaCurrentName.status).toBe(403);
    expect(await viaCurrentName.text()).toBe("Forbidden");
  });

  // A bare cookie tossed from a sibling host, sent FIRST (the attacker's best
  // ordering): the server never reads that name, so the victim's own cookie is
  // the one that counts — and the duplicate check is not involved at all.
  it("VT-6 (#125): a tossed bare cookie sent first is ignored, the victim stays themselves", async () => {
    const attacker = await signedIn("attacker");
    const victim = await signedIn("victim");

    const res = await app.request("/api/me", {
      headers: {
        Cookie: `skrun_session=${attacker.session}; __Host-skrun_session=${victim.session}`,
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).username).toBe("victim");
    expect(duplicateWarnings()).toHaveLength(0);
  });
});

// The device-login cookies in production. NODE_ENV is set explicitly and it is
// the whole point of the block: the file runs in test, where the prefix is off
// and the code path that can raise is never taken.
//
// No cookie domain is configured here, deliberately — the cookies of the sign-in
// round-trip follow the Secure flag ALONE, while the session cookie's name also
// depends on the domain; the configured-domain half lives in the return-destination
// block further down.
describe("device-login cookies in production (#123)", () => {
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  const csrfFrom = (setCookie: string | null): string =>
    setCookie?.match(/skrun_device_csrf=([^;]+)/)?.[1] ?? "";

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    delete process.env.SKRUN_DEV_AUTH;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    process.env.GITHUB_CLIENT_ID = "test-id";
    process.env.GITHUB_CLIENT_SECRET = "test-secret";

    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  /** Mints a pending device code and returns its user_code. */
  async function pendingCode(userCode: string, challenge = "chal") {
    await db.createDeviceCode({
      device_code_hash: hashCode(`dev-${userCode}`),
      user_code_hash: hashCode(userCode),
      code_challenge: challenge,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    return userCode;
  }

  // VT-27 — the consent cookie is host-locked. __Host- is the one attribute a
  // sibling host of the domain cannot write, which is what keeps the
  // double-submit check meaningful once the session is shared across a domain.
  it("VT-27: GET /device sets __Host-skrun_device_csrf with Secure, Path=/ and no Domain", async () => {
    const res = await app.request("/device?user_code=ABCD-2345");
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    const csrfCookie = setCookies.find((c) => c.includes("skrun_device_csrf="));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toMatch(/^__Host-skrun_device_csrf=/);
    expect(csrfCookie).toMatch(/;\s*Secure/i);
    expect(csrfCookie).toMatch(/;\s*Path=\//i);
    expect(csrfCookie).not.toMatch(/;\s*Domain=/i);
    expect(csrfCookie).toMatch(/;\s*HttpOnly/i);
  });

  // The two binding cookies are host-locked in production, and their site policy
  // does NOT change. Both have to survive the round trip to GitHub; the KB page
  // for this flow warns that hardening their site policy "silently removes the
  // branch" — the CLI would poll until expiry with nothing failing anywhere. The
  // name prefix leaves the site policy alone, so SameSite=Lax is pinned here next
  // to the prefix, in the very configuration where the prefix applies.
  it("VT-7 (#125): the two binding cookies are host-locked in production, SameSite=Lax kept", async () => {
    const authRes = await app.request("/auth/github", { redirect: "manual" });
    const stateCookie = authRes.headers
      .getSetCookie()
      .find((c) => c.includes("skrun_oauth_state="));
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toMatch(/^__Host-skrun_oauth_state=[^;]/);
    expect(stateCookie).toMatch(/;\s*Secure/i);
    expect(stateCookie).toMatch(/;\s*Path=\/(;|$)/i);
    expect(stateCookie).toMatch(/;\s*HttpOnly/i);
    expect(stateCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(stateCookie).toMatch(/;\s*Max-Age=300(;|$)/i);
    expect(stateCookie).not.toMatch(/;\s*Domain=/i);

    const userCode = await pendingCode("BIND-2345");
    const get = await app.request("/device");
    const csrf = csrfFrom(get.headers.get("Set-Cookie"));
    const postRes = await app.request("/device", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-skrun_device_csrf=${csrf}`,
      },
      body: `user_code=${userCode}&csrf=${csrf}`,
      redirect: "manual",
    });
    expect(postRes.status).toBe(302);

    const bindCookie = postRes.headers
      .getSetCookie()
      .find((c) => c.includes("skrun_device_user_code="));
    expect(bindCookie).toBeDefined();
    expect(bindCookie).toMatch(/^__Host-skrun_device_user_code=[^;]/);
    expect(bindCookie).toMatch(/;\s*Secure/i);
    expect(bindCookie).toMatch(/;\s*Path=\/(;|$)/i);
    expect(bindCookie).toMatch(/;\s*HttpOnly/i);
    expect(bindCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(bindCookie).toMatch(/;\s*Max-Age=600(;|$)/i);
    expect(bindCookie).not.toMatch(/;\s*Domain=/i);
  });

  /** Starts a sign-in: the state GitHub will echo, and the cookie that holds it. */
  async function beginSignIn(): Promise<{ state: string; stateCookie: string }> {
    const res = await app.request("/auth/github", { redirect: "manual" });
    return {
      state: new URL(res.headers.get("Location") ?? "").searchParams.get("state") ?? "",
      stateCookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "",
    };
  }

  /**
   * The erasures a response carries, each checked against what the prefix
   * demands; returns their names in order so a case can say which were erased.
   */
  function legalErasures(res: Response): string[] {
    const erasures = res.headers.getSetCookie().filter((c) => /;\s*Max-Age=0(;|$)/i.test(c));
    for (const cookie of erasures) {
      expect(cookie, cookie).toMatch(/^__Host-[a-z_]+=;/);
      expect(cookie, cookie).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookie, cookie).toMatch(/;\s*Secure/i);
      expect(cookie, cookie).not.toMatch(/;\s*Domain=/i);
    }
    return erasures.map((c) => c.slice(0, c.indexOf("=")));
  }

  // The three erasures of the callback, each through a real request: under the
  // prefix hono raises on an erasure that lacks Secure, and the answer is a 500
  // (or a swallowed failure) instead of the page the visitor should see. The
  // state is always erased first, whichever branch the callback takes.
  it("VT-8 (#125) (a): a web sign-in erases the state cookie legally and lands on the dashboard", async () => {
    stubGithubOk({ id: 125081, login: "websignin" });
    const { state, stateCookie } = await beginSignIn();

    const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: stateCookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(legalErasures(res)).toEqual(["__Host-skrun_oauth_state"]);
  });

  it("VT-8 (#125) (b): a device sign-in erases both binding cookies legally and says you're all set", async () => {
    stubGithubOk({ id: 125082, login: "devicesignin" });
    const userCode = await pendingCode("ERAS-2345");
    const { state, stateCookie } = await beginSignIn();

    const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: `${stateCookie}; __Host-skrun_device_user_code=${userCode}` },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You're all set");
    expect(legalErasures(res)).toEqual([
      "__Host-skrun_oauth_state",
      "__Host-skrun_device_user_code",
    ]);
  });

  it("VT-8 (#125) (c): a device sign-in refused by the allowlist erases both legally and consumes the code", async () => {
    process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
    stubGithubOk({ id: 125083, login: "mallory-unlisted" });
    const userCode = await pendingCode("RFSD-2345");
    const { state, stateCookie } = await beginSignIn();

    const res = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: `${stateCookie}; __Host-skrun_device_user_code=${userCode}` },
      redirect: "manual",
    });
    // No cookie domain here, so the refusal is the generic page, not a redirect.
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Not authorized");
    expect(await db.getDeviceCodeByUserHash(hashCode(userCode))).toBeNull();
    expect(legalErasures(res)).toEqual([
      "__Host-skrun_oauth_state",
      "__Host-skrun_device_user_code",
    ]);
  });

  // VT-36 (device half) — the erasure of the prefixed consent cookie must not
  // throw. hono refuses to serialise a __Host- name without secure:true and
  // raises instead, so POST /device would answer 500 on EVERY production
  // instance, configured domain or not. Through a real request, since it is the
  // serialisation that raises.
  it("VT-36: POST /device does not throw, and the consent cookie is erased with Secure, Path=/ and no Domain", async () => {
    const userCode = await pendingCode("NOTH-2345");
    const get = await app.request("/device");
    const csrf = csrfFrom(get.headers.get("Set-Cookie"));

    const res = await app.request("/device", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-skrun_device_csrf=${csrf}`,
      },
      body: `user_code=${userCode}&csrf=${csrf}`,
      redirect: "manual",
    });

    expect(res.status).toBe(302); // not 500 — nothing raised
    expect(res.headers.get("Location")).toBe("/auth/github");

    const erasure = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-skrun_device_csrf="));
    expect(erasure).toBeDefined();
    expect(erasure).toMatch(/;\s*Max-Age=0/i);
    expect(erasure).toMatch(/;\s*Secure/i);
    expect(erasure).toMatch(/;\s*Path=\//i);
    expect(erasure).not.toMatch(/;\s*Domain=/i);
  });

  // The whole device journey, end to end, under the prefix — consent, the GitHub
  // leg, the callback, then the CLI's poll — with every cookie replayed from what
  // the server set. What must not change is where the token comes out: the poll
  // body, never a URL and never a page.
  it("VT-9 (#125): with no cookie domain the device journey completes, the token only in the poll body", async () => {
    stubGithubOk({ id: 424242, login: "Journey" });
    const journey = await runDeviceJourney(app, db, "JRNY-2345");

    expect(journey.consent.status).toBe(302);
    expect(journey.callback.status).toBe(200);
    expect(journey.donePage).toContain("You're all set");
    expect(apiKeyShapes(journey.donePage)).toEqual([]);
    // The binding cookies were erased on the way out; nothing of the journey is left.
    expect(journey.jar.names()).toEqual([]);

    expect(journey.poll.status).toBe(200);
    const body = await journey.poll.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    // The token the poll hands the CLI is an API key of the current format.
    expect(isApiKeyFormat(body.token)).toBe(true);
    for (const url of journey.urls) expect(url).not.toContain(body.token);
    // Lower-cased, as the namespace always has been — measured, not assumed: the
    // GitHub login here is "Journey".
    expect(body.username).toBe("journey");
  });

  it("VT-9 (#125): with no cookie domain a web sign-in in a fresh jar holds a host-locked session", async () => {
    stubGithubOk({ id: 424243, login: "webjourney" });
    const { callback, jar } = await runWebSignIn(app);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/dashboard");
    expect(jar.names()).toEqual(["__Host-skrun_session"]);
    const me = await app.request("/api/me", { headers: { Cookie: jar.header() } });
    expect(me.status).toBe(200);
    expect((await me.json()).username).toBe("webjourney");
  });
});

// ── #123 the return destination: the two worlds of the callback ────────────
//
// Two blocks, because they cannot share an app: the startup interlock reads the
// environment once, at createApp time. The second block is the one that matters
// most to a self-hoster — it says that an operator who configured nothing sees
// the callback do exactly what it did before.

/** The exception message the browser must never see, and the log must. */
const EXCHANGE_DETAIL = "upstream-detail-b7f19c-never-shown-to-a-browser";

/** A value a database error quotes: neither the browser nor a log line may carry it. */
const DB_DETAIL = "db-detail-4e7a21-never-in-a-log";

/** A database error as a driver raises it: a message that quotes a value, and a code. */
function dbFailure(): Error {
  return Object.assign(new Error(`could not write: "${DB_DETAIL}" is locked`), { code: "55P03" });
}

/** Mocks GitHub's token + profile endpoints for one successful callback. */
function stubGithubOk(gh: { id: number; login: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const body = url.includes("access_token")
        ? { access_token: "tok" }
        : { id: gh.id, login: gh.login, email: null };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

/**
 * A minimal browser cookie jar for the journey tests. It replays what the server
 * set instead of naming the cookies, so a journey tests the round trip itself:
 * whatever the server calls a cookie, the next request carries it back. The names
 * are pinned by the attribute tests, not here. `Max-Age=0` removes a cookie, as a
 * browser would; scope is ignored — every request goes to the same host.
 */
function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    take(res: Response): void {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        if (/;\s*Max-Age=0(;|$)/i.test(line)) cookies.delete(name);
        else cookies.set(name, pair.slice(eq + 1));
      }
    },
    header(): string {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    names(): string[] {
      return [...cookies.keys()];
    },
  };
}

type TestApp = ReturnType<typeof createTestApp>["app"];

/**
 * The CLI device journey as a browser and a CLI live it: consent page, consent
 * POST, the GitHub leg, the callback, then the CLI's poll. Every cookie travels
 * through one jar, and every URL the browser is sent to is collected so a case
 * can assert that the token never rides in one.
 */
async function runDeviceJourney(app: TestApp, db: MemoryDb, userCode: string) {
  const verifier = "v".repeat(43);
  await db.createDeviceCode({
    device_code_hash: hashCode(`dev-${userCode}`),
    user_code_hash: hashCode(userCode),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  const jar = cookieJar();
  const urls: string[] = [];
  const setCookies: string[] = [];
  const visit = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Cookie: jar.header() },
      redirect: "manual",
    });
    jar.take(res);
    setCookies.push(...res.headers.getSetCookie());
    const location = res.headers.get("Location");
    if (location) urls.push(location);
    return res;
  };

  const page = await visit(`/device?user_code=${userCode}`);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  const consent = await visit("/device", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `user_code=${userCode}&csrf=${csrf}`,
  });
  const out = await visit(consent.headers.get("Location") ?? "");
  const state = new URL(out.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const callback = await visit(`/auth/github/callback?code=c&state=${state}`);
  const donePage = await callback.text();

  const poll = await app.request("/auth/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: `dev-${userCode}`, code_verifier: verifier }),
  });
  return { consent, callback, donePage, poll, jar, urls, setCookies };
}

/** A web sign-in in a fresh jar: the GitHub leg out, then the callback. */
async function runWebSignIn(app: TestApp) {
  const jar = cookieJar();
  const out = await app.request("/auth/github", { redirect: "manual" });
  jar.take(out);
  const state = new URL(out.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const callback = await app.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { Cookie: jar.header() },
    redirect: "manual",
  });
  jar.take(callback);
  return { out, callback, jar };
}

/** Mocks a token exchange that throws, with a message nothing else produces. */
function stubGithubThrows() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(EXCHANGE_DETAIL)));
}

/**
 * Everything a caller could read off a response, as one string: the status, every
 * header, and the body. Asserting on this rather than on the body alone is the
 * point — a marker that named the account would most likely do it in `Location`.
 */
async function readableSurface(res: Response): Promise<string> {
  const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  return `${res.status}\n${headers}\n${await res.text()}`;
}

describe("the OAuth callback with a return destination configured (#123)", () => {
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  // The site sits at the apex of the cookie's domain, and the scheme is the
  // canonical origin's — not a literal https, which under VT-3's configuration (a
  // domain outside production) would point at an origin serving http.
  const RETURN_ORIGIN = "https://example.com";
  // One identity for every case in the block, so "no identity came back" is a
  // single pair of strings to look for rather than one per case.
  const GH = { id: 909090, login: "mallory-unlisted" };

  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    // Production, because the prefix on the session cookie is half of what VT-20
    // asserts and it is off anywhere else.
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    delete process.env.SKRUN_DEV_AUTH;
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";

    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    logErrorSpy.mockClear();
    logWarnSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  /** Starts a login and hands back the state and the cookie the browser holds. */
  async function beginLogin(): Promise<{ state: string; cookie: string }> {
    const res = await app.request("/auth/github", { redirect: "manual" });
    const location = res.headers.get("Location");
    if (!location) throw new Error("no Location on /auth/github — OAuth misconfigured?");
    return {
      state: new URL(location).searchParams.get("state") ?? "",
      cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "",
    };
  }

  async function callback(query: string, cookie: string, headers: Record<string, string> = {}) {
    return app.request(`/auth/github/callback${query}`, {
      headers: { Cookie: cookie, ...headers },
      redirect: "manual",
    });
  }

  // VT-20 — the nominal case of the whole element: the browser is sent to the
  // site, and the cookie it now carries is one the site's host will send back.
  it("VT-20: a finished login lands on the configured origin, carrying the domain-scoped cookie", async () => {
    stubGithubOk(GH);
    const { state, cookie } = await beginLogin();
    const res = await callback(`?code=c&state=${state}`, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${RETURN_ORIGIN}/`);

    const session = res.headers.getSetCookie().find((c) => c.includes("skrun_session="));
    expect(session).toBeDefined();
    expect(session).toMatch(/^__Secure-skrun_session=/);
    expect(session).toMatch(/;\s*Domain=example\.com/i);
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(await db.getUserByGithubId(String(GH.id))).toBeTruthy();
  });

  // VT-22 — the open-redirect family, asserted as an absence. Nothing here is
  // filtered; the values below are simply never read, and this is what proves it.
  it("VT-22: no query parameter and no header moves the destination", async () => {
    const hostile =
      "&return_to=https%3A%2F%2Fevil.example" +
      "&next=https%3A%2F%2Fevil.example%2Fnext" +
      "&redirect_uri=https%3A%2F%2Fevil.example%2Fcb" +
      "&returnTo=https%3A%2F%2Fevil.example";
    const hostileHeaders = {
      return_to: "https://evil.example",
      next: "https://evil.example/next",
      redirect_uri: "https://evil.example/cb",
      "X-Forwarded-Host": "evil.example",
      Referer: "https://evil.example/",
    };

    stubGithubOk(GH);
    const { state, cookie } = await beginLogin();
    const ok = await callback(`?code=c&state=${state}${hostile}`, cookie, hostileHeaders);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("Location")).toBe(`${RETURN_ORIGIN}/`);

    // The failing exit is steerable in exactly the same way — that is, not at
    // all. A guard that covered only the success path would be worth nothing.
    const failed = await callback(`?code=c&state=mismatch${hostile}`, cookie, hostileHeaders);
    expect(failed.status).toBe(302);
    expect(failed.headers.get("Location")).toBe(`${RETURN_ORIGIN}/?login=failed`);

    for (const res of [ok, failed]) {
      expect(await readableSurface(res)).not.toContain("evil.example");
    }
  });

  // VT-23 — the five ways a callback can end badly or be refused, side by side.
  // The four technical ones must be ONE answer: telling them apart tells someone
  // probing the callback which half of the handshake they got wrong, and tells a
  // support reader nothing they can act on.
  it("VT-23: four technical failures are one answer, a refusal is another, and none of the five says who", async () => {
    const technical: Array<{ name: string; res: Response }> = [];

    // 1. No state at all in the query.
    stubGithubOk(GH);
    {
      const { cookie } = await beginLogin();
      technical.push({ name: "state absent", res: await callback("?code=c", cookie) });
    }
    // 2. A state that does not match the one in the cookie.
    {
      const { cookie } = await beginLogin();
      technical.push({
        name: "state mismatched",
        res: await callback("?code=c&state=not-the-one", cookie),
      });
    }
    // 3. The visitor pressed Cancel at GitHub — it comes back with no code.
    {
      const { state, cookie } = await beginLogin();
      technical.push({
        name: "cancelled at GitHub",
        res: await callback(`?state=${state}&error=access_denied`, cookie),
      });
    }
    // 4. The token exchange throws.
    {
      const { state, cookie } = await beginLogin();
      stubGithubThrows();
      technical.push({
        name: "exchange threw",
        res: await callback(`?code=c&state=${state}`, cookie),
      });
    }

    for (const { name, res } of technical) expect(res.status, name).toBe(302);
    expect(new Set(technical.map((t) => t.res.headers.get("Location")))).toEqual(
      new Set([`${RETURN_ORIGIN}/?login=failed`]),
    );

    // 5. The signup allowlist refuses the account — a different marker, because
    // it is a different thing: nothing failed, the visitor is simply not admitted.
    process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
    stubGithubOk(GH);
    const { state: sWeb, cookie: cWeb } = await beginLogin();
    const deniedWeb = await callback(`?code=c&state=${sWeb}`, cWeb);
    expect(deniedWeb.status).toBe(302);
    expect(deniedWeb.headers.get("Location")).toBe(`${RETURN_ORIGIN}/?login=denied`);

    // 5b. The same refusal reached through a CLI device login. The branch is
    // shared, so the browser leaves by the same door — and the work that has to
    // happen before it leaves still happens: the device code is consumed, so the
    // CLI's next poll gets expired_token instead of waiting out a stale pending.
    const userCode = "DENY-2345";
    await db.createDeviceCode({
      device_code_hash: hashCode(`dev-${userCode}`),
      user_code_hash: hashCode(userCode),
      code_challenge: "chal",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const { state: sDev, cookie: cDev } = await beginLogin();
    const deniedDevice = await callback(
      `?code=c&state=${sDev}`,
      `${cDev}; __Host-skrun_device_user_code=${userCode}`,
    );
    expect(deniedDevice.status).toBe(302);
    expect(deniedDevice.headers.get("Location")).toBe(`${RETURN_ORIGIN}/?login=denied`);
    expect(await db.getDeviceCodeByUserHash(hashCode(userCode))).toBeNull();
    expect(
      deniedDevice.headers
        .getSetCookie()
        .some((c) => c.startsWith("__Host-skrun_device_user_code=;")),
    ).toBe(true);

    // None of the five names the account, its id, or what went wrong upstream.
    for (const { name, res } of [
      ...technical,
      { name: "refused (web)", res: deniedWeb },
      { name: "refused (device)", res: deniedDevice },
    ]) {
      const surface = await readableSurface(res);
      expect(surface, name).not.toContain(GH.login);
      expect(surface, name).not.toContain(String(GH.id));
      expect(surface, name).not.toContain(EXCHANGE_DETAIL);
    }

    // And a success says nothing either — no marker at all, so a page cannot be
    // told "a login just happened" by a link somebody else wrote.
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    stubGithubOk(GH);
    const { state: sOk, cookie: cOk } = await beginLogin();
    const ok = await callback(`?code=c&state=${sOk}`, cOk);
    expect(ok.headers.get("Location")).toBe(`${RETURN_ORIGIN}/`);
    expect(new URL(`${ok.headers.get("Location")}`).search).toBe("");
  });

  // VT-25 — where the detail went. Removing it from the response is only half of
  // the change; an operator who now has less to read in a support ticket must
  // have more to read in their logs.
  it("VT-25: the exchange's own message reaches the error log and never the browser", async () => {
    const { state, cookie } = await beginLogin();
    stubGithubThrows();
    const res = await callback(`?code=c&state=${state}`, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${RETURN_ORIGIN}/?login=failed`);
    expect(await readableSurface(res)).not.toContain(EXCHANGE_DETAIL);

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "oauth_exchange_failed", error: EXCHANGE_DETAIL }),
      expect.any(String),
    );
  });

  // Once GitHub has answered, a failure is this server's own: the database at
  // one of the steps that follow. It is logged under its own event, with the
  // step and the error's class and code, never under the GitHub one; and the
  // visitor meets the same answer as for a GitHub failure, measured here rather
  // than restated.
  it.each([
    {
      stage: "allowlist",
      withDeviceCookie: true,
      arm: () => {
        process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
        vi.spyOn(db, "getDeviceCodeByUserHash").mockRejectedValue(dbFailure());
      },
    },
    {
      stage: "user",
      withDeviceCookie: false,
      arm: () => {
        vi.spyOn(db, "getUserByGithubId").mockRejectedValue(dbFailure());
      },
    },
    {
      stage: "device",
      withDeviceCookie: true,
      arm: () => {
        vi.spyOn(db, "authorizeDeviceCode").mockRejectedValue(dbFailure());
      },
    },
    {
      stage: "session",
      withDeviceCookie: false,
      arm: () => {
        vi.spyOn(db, "createSession").mockRejectedValue(dbFailure());
      },
    },
  ])("a failure of this server at the $stage step is logged with its stage, and answers as a GitHub failure does", async ({
    stage,
    withDeviceCookie,
    arm,
  }) => {
    const first = await beginLogin();
    stubGithubThrows();
    const githubFailure = await callback(`?code=c&state=${first.state}`, first.cookie);
    logErrorSpy.mockClear();

    stubGithubOk(GH);
    arm();
    const { state, cookie } = await beginLogin();
    const res = await callback(
      `?code=c&state=${state}`,
      withDeviceCookie ? `${cookie}; __Host-skrun_device_user_code=STGE-2345` : cookie,
    );

    expect(logErrorSpy.mock.calls.map(([fields]) => fields)).toEqual([
      { event: "oauth_callback_failed", stage, error_name: "Error", error_code: "55P03" },
    ]);
    expect(JSON.stringify(logErrorSpy.mock.calls)).not.toContain(DB_DETAIL);
    expect(res.status).toBe(githubFailure.status);
    expect(res.headers.get("Location")).toBe(githubFailure.headers.get("Location"));
    expect(await readableSurface(res)).not.toContain(DB_DETAIL);
  });

  // The same two journeys under a configured cookie domain — the cloud's shape.
  // The session cookie is the only one that takes the domain; every cookie of the
  // sign-in round-trip stays host-only, which is what lets it be host-locked.
  it("VT-9 (#125): with a cookie domain the device journey completes, its cookies host-only", async () => {
    stubGithubOk(GH);
    const journey = await runDeviceJourney(app, db, "DOMN-2345");

    expect(journey.consent.status).toBe(302);
    expect(journey.callback.status).toBe(200);
    expect(journey.donePage).toContain("You're all set");
    expect(apiKeyShapes(journey.donePage)).toEqual([]);
    expect(journey.jar.names()).toEqual([]);
    for (const cookie of journey.setCookies) {
      expect(cookie, cookie).not.toMatch(/;\s*Domain=/i);
      expect(cookie, cookie).toMatch(/;\s*Secure/i);
    }

    expect(journey.poll.status).toBe(200);
    const body = await journey.poll.json();
    expect(body.token.length).toBeGreaterThan(0);
    for (const url of journey.urls) expect(url).not.toContain(body.token);
  });

  it("VT-9 (#125): with a cookie domain a web sign-in in a fresh jar holds the domain-scoped session", async () => {
    stubGithubOk(GH);
    const { out, callback, jar } = await runWebSignIn(app);

    for (const cookie of out.headers.getSetCookie()) {
      expect(cookie, cookie).not.toMatch(/;\s*Domain=/i);
    }
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(`${RETURN_ORIGIN}/`);
    expect(jar.names()).toEqual(["__Secure-skrun_session"]);
    const session = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Secure-skrun_session="));
    expect(session).toMatch(/;\s*Domain=example\.com/i);
    const me = await app.request("/api/me", { headers: { Cookie: jar.header() } });
    expect(me.status).toBe(200);
  });
});

// Outside production nothing is renamed: every cookie of both journeys keeps its
// bare name and carries no Secure flag, with or without a cookie domain. The
// existing blocks run in test; this one sets development explicitly, and builds
// the app per case because the startup interlock reads the environment once.
describe("cookie names outside production (#125)", () => {
  const KEYS = [
    "NODE_ENV",
    "SKRUN_DEV_AUTH",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  const CELLS = [
    { label: "development × no domain", domain: undefined, publicUrl: undefined },
    {
      label: "development × example.com",
      domain: "example.com",
      publicUrl: "http://api.example.com",
    },
  ] as const;

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    process.env.NODE_ENV = "development";
    delete process.env.SKRUN_DEV_AUTH;
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  function appFor(cell: (typeof CELLS)[number]) {
    if (cell.domain === undefined) delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    else process.env.SKRUN_SESSION_COOKIE_DOMAIN = cell.domain;
    if (cell.publicUrl === undefined) delete process.env.SKRUN_PUBLIC_URL;
    else process.env.SKRUN_PUBLIC_URL = cell.publicUrl;
    return createTestApp();
  }

  /** Every cookie written: bare name, no Secure flag. */
  function expectBare(setCookies: string[]) {
    expect(setCookies.length).toBeGreaterThan(0);
    for (const cookie of setCookies) {
      expect(cookie, cookie).toMatch(/^skrun_[a-z_]+=/);
      expect(cookie, cookie).not.toMatch(/;\s*Secure/i);
    }
  }

  for (const cell of CELLS) {
    it(`VT-10 (#125): ${cell.label} — a web sign-in writes bare names only`, async () => {
      const { app } = appFor(cell);
      stubGithubOk({ id: 125101, login: "devweb" });
      const { out, callback, jar } = await runWebSignIn(app);

      expect(out.headers.getSetCookie()[0]).toMatch(/^skrun_oauth_state=/);
      expect(callback.status).toBe(302);
      expect(jar.names()).toEqual(["skrun_session"]);
      expectBare([...out.headers.getSetCookie(), ...callback.headers.getSetCookie()]);
    });

    it(`VT-10 (#125): ${cell.label} — the device journey completes under bare names`, async () => {
      const { app, db } = appFor(cell);
      stubGithubOk({ id: 125102, login: "devdevice" });
      const journey = await runDeviceJourney(app, db, "BARE-2345");

      expect(
        journey.consent.headers.getSetCookie().some((c) => c.startsWith("skrun_device_user_code=")),
      ).toBe(true);
      expect(journey.callback.status).toBe(200);
      expect(journey.donePage).toContain("You're all set");
      expect(journey.poll.status).toBe(200);
      expectBare(journey.setCookies);
    });
  }
});

describe("the OAuth callback with nothing configured (#123)", () => {
  const KEYS = [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;

    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  async function beginLogin(): Promise<{ state: string; cookie: string }> {
    const res = await app.request("/auth/github", { redirect: "manual" });
    const location = res.headers.get("Location");
    if (!location) throw new Error("no Location on /auth/github — OAuth misconfigured?");
    return {
      state: new URL(location).searchParams.get("state") ?? "",
      cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "",
    };
  }

  async function callback(query: string, cookie: string) {
    return app.request(`/auth/github/callback${query}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
  }

  // VT-21 — the success path of every deployment that has not opted in.
  it("VT-21: a finished login still lands on /dashboard, with the cookie it always had", async () => {
    stubGithubOk({ id: 5001, login: "Selfhost" });
    const { state, cookie } = await beginLogin();
    const res = await callback(`?code=c&state=${state}`, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");

    const session = res.headers.getSetCookie().find((c) => c.includes("skrun_session="));
    expect(session).toMatch(/^skrun_session=/); // no prefix
    expect(session).not.toMatch(/;\s*Domain=/i); // host-only
  });

  // VT-24 — the four failures keep their status and their shape. One thing does
  // change and it is meant to: the 500 no longer hands the exception's message to
  // the browser. That was never part of the contract a self-hoster relies on, and
  // it is the one line an audit would flag.
  it("VT-24: the four failures keep today's status and shape, and the 500 carries no exception message", async () => {
    stubGithubOk({ id: 5002, login: "Selfhost" });

    for (const [name, query] of [
      ["state absent", "?code=c"],
      ["state mismatched", "?code=c&state=not-the-one"],
    ] as const) {
      const { cookie } = await beginLogin();
      const res = await callback(query, cookie);
      expect(res.status, name).toBe(400);
      expect((await res.json()).error.code, name).toBe("INVALID_OAUTH_CALLBACK");
    }

    {
      const { state, cookie } = await beginLogin();
      const res = await callback(`?state=${state}&error=access_denied`, cookie);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_OAUTH_CALLBACK");
    }

    {
      const { state, cookie } = await beginLogin();
      stubGithubThrows();
      const res = await callback(`?code=c&state=${state}`, cookie);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("OAUTH_FAILED");
      expect(body.error.message).toBe("OAuth authentication failed");
      expect(JSON.stringify(body)).not.toContain(EXCHANGE_DETAIL);
      // The detail is not lost, it moved: the log fires with no destination
      // configured just as it does with one.
      expect(logErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: "oauth_exchange_failed", error: EXCHANGE_DETAIL }),
        expect.any(String),
      );
    }

    // And the refusal is still the generic page, with no echo of the account.
    process.env.SKRUN_ALLOWED_GITHUB_USERS = "alice";
    stubGithubOk({ id: 5003, login: "mallory-unlisted" });
    const { state, cookie } = await beginLogin();
    const denied = await callback(`?code=c&state=${state}`, cookie);
    expect(denied.status).toBe(403);
    const html = await denied.text();
    expect(html).toContain("Not authorized");
    expect(html).not.toContain("mallory-unlisted");
  });

  // With nothing configured, a failure of this server after GitHub answered
  // gives the same 500 as a GitHub failure, and is logged with its step.
  it("a failure of this server after GitHub answered gives the same 500 as a GitHub failure, logged with its stage", async () => {
    const first = await beginLogin();
    stubGithubThrows();
    const githubFailure = await callback(`?code=c&state=${first.state}`, first.cookie);
    logErrorSpy.mockClear();

    stubGithubOk({ id: 5005, login: "Selfhost" });
    vi.spyOn(db, "getUserByGithubId").mockRejectedValue(dbFailure());
    const { state, cookie } = await beginLogin();
    const res = await callback(`?code=c&state=${state}`, cookie);

    expect(logErrorSpy.mock.calls.map(([fields]) => fields)).toEqual([
      { event: "oauth_callback_failed", stage: "user", error_name: "Error", error_code: "55P03" },
    ]);
    expect(JSON.stringify(logErrorSpy.mock.calls)).not.toContain(DB_DETAIL);
    expect(res.status).toBe(githubFailure.status);
    expect(await res.json()).toEqual(await githubFailure.json());
  });

  // RT-1 — the self-hoster's whole web journey, read as they would see it: the
  // leg out to GitHub, the cookie that comes back, the landing, and the session
  // actually authenticating afterwards. Nothing in this test knows that #123
  // happened, which is the point of it.
  it("RT-1: the unconfigured web journey is unchanged end to end", async () => {
    // The leg out still derives its redirect_uri from the request's own headers,
    // because no canonical origin is pinned here.
    const out = await app.request("http://selfhost.example/auth/github", {
      headers: { "X-Forwarded-Proto": "https" },
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    const authorize = new URL(`${out.headers.get("Location")}`);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://selfhost.example/auth/github/callback",
    );

    stubGithubOk({ id: 5004, login: "Selfhost" });
    const { state, cookie } = await beginLogin();
    const res = await callback(`?code=c&state=${state}`, cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");

    const session = res.headers.getSetCookie().find((c) => c.includes("skrun_session="));
    expect(session).toMatch(/^skrun_session=/);
    expect(session).not.toMatch(/;\s*Domain=/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*Path=\//i);

    // The name the browser was handed is the name the server reads back.
    const raw = `${session}`.match(/skrun_session=([^;]+)/)?.[1] ?? "";
    expect(raw).not.toBe("");
    const me = await app.request("/api/me", {
      headers: { Cookie: `${sessionCookieName()}=${raw}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).username).toBe("selfhost");

    // And the user really was created, under the lower-cased namespace.
    expect((await db.getUserByGithubId("5004"))?.username).toBe("selfhost");
  });
});

// A duration setting past its cap is read as the cap by the route that writes
// it: the request succeeds, and nothing refuses to boot. Every value is written
// out in digits, because Number.parseInt reads "1e13" as 1 and the case would
// exercise nothing.
describe("duration settings past their cap, at the routes that use them", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    vi.stubEnv("SKRUN_ALLOWED_GITHUB_USERS", undefined);
    vi.stubEnv("SKRUN_PUBLIC_URL", undefined);
    vi.stubEnv("SKRUN_SESSION_COOKIE_DOMAIN", undefined);
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // The session lifetime is also the session cookie's Max-Age, and hono refuses
  // to write a cookie past 400 days: that limit is the session's cap, lower than
  // the other durations'. The destination and the cookie are asserted, never the
  // status alone — with a return origin configured, a failed callback is a
  // redirect too. What the server logged rides along in the message, so a
  // failure says which step threw.
  it.each([
    ["63072000", 34_560_000],
    ["10000000000000", 34_560_000],
    ["34560001", 34_560_000],
    ["34560000", 34_560_000],
    ["34559999", 34_559_999],
  ] as const)("a web sign-in with SESSION_TTL_S=%s lands on /dashboard, its cookie and its row at %i seconds", async (configured, seconds) => {
    vi.stubEnv("SESSION_TTL_S", configured);
    stubGithubOk({ id: 9001, login: "longsession" });

    const before = Date.now();
    const { callback } = await runWebSignIn(app);
    const after = Date.now();

    const logged = JSON.stringify(logErrorSpy.mock.calls);
    expect(callback.headers.get("Location"), `logged: ${logged}`).toBe("/dashboard");

    const session = callback.headers.getSetCookie().find((c) => c.startsWith("skrun_session="));
    expect(session?.match(/;\s*Max-Age=(\d+)/i)?.[1]).toBe(String(seconds));

    const raw = session?.match(/^skrun_session=([^;]+)/)?.[1] ?? "";
    const row = await db.getSession(hashSessionId(raw));
    const expiresMs = Date.parse(row?.expires_at ?? "");
    expect(expiresMs).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + seconds * 1000);
  });

  /** The CLI login's last step: the poll of an authorized code, which mints the key. */
  async function pollAuthorizedCode(): Promise<Response> {
    const user = await db.createUser({ github_id: "9002", username: "longkey" });
    const verifier = "v".repeat(43);
    await db.createDeviceCode({
      device_code_hash: hashCode("dc-long-key"),
      user_code_hash: hashCode("LONG-2345"),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    await db.authorizeDeviceCode(hashCode("LONG-2345"), user.id);
    return app.request("/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: "dc-long-key", code_verifier: verifier }),
    });
  }

  // The key the CLI login mints takes its lifetime from SKRUN_API_KEY_TTL_DAYS.
  // Past 36 500 days — a hundred years — the setting is read as 36 500: a bound
  // on the date, not a policy.
  it.each([
    ["100000000", 36_500],
    ["36501", 36_500],
    ["36500", 36_500],
    ["36499", 36_499],
  ] as const)("a CLI login with SKRUN_API_KEY_TTL_DAYS=%s mints a key that expires %i days out", async (configured, days) => {
    vi.stubEnv("SKRUN_API_KEY_TTL_DAYS", configured);

    const before = Date.now();
    const poll = await pollAuthorizedCode();
    const after = Date.now();

    expect(poll.status, await poll.clone().text()).toBe(200);
    const { token } = (await poll.json()) as { token: string };
    const stored = await db.getApiKeyByHash(hashApiKey(token));
    expect(stored?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresMs = Date.parse(stored?.expires_at ?? "");
    expect(expiresMs).toBeGreaterThanOrEqual(before + days * 86_400_000);
    expect(expiresMs).toBeLessThanOrEqual(after + days * 86_400_000);
  });

  // The cap leaves the operator's explicit gesture alone.
  it("a CLI login with SKRUN_API_KEY_TTL_DAYS=0 still mints a key that never expires", async () => {
    vi.stubEnv("SKRUN_API_KEY_TTL_DAYS", "0");

    const poll = await pollAuthorizedCode();

    expect(poll.status, await poll.clone().text()).toBe(200);
    const { token } = (await poll.json()) as { token: string };
    const stored = await db.getApiKeyByHash(hashApiKey(token));
    expect(stored).not.toBeNull();
    expect(stored?.expires_at).toBeNull();
  });

  // A device code takes its lifetime from SKRUN_DEVICE_CODE_TTL_S. Past a
  // hundred years the setting is read as a hundred years: the code is issued,
  // and its expiry stays a date with a four-digit year.
  it.each([
    ["10000000000000", 3_153_600_000],
    ["3153600001", 3_153_600_000],
    ["3153600000", 3_153_600_000],
    ["3153599999", 3_153_599_999],
  ] as const)("a device code asked with SKRUN_DEVICE_CODE_TTL_S=%s is issued, valid %i seconds", async (configured, seconds) => {
    vi.stubEnv("SKRUN_DEVICE_CODE_TTL_S", configured);

    const before = Date.now();
    const res = await app.request("/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_challenge: "abc", code_challenge_method: "S256" }),
    });
    const after = Date.now();

    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { device_code: string; expires_in: number };
    expect(body.expires_in).toBeLessThanOrEqual(seconds);
    expect(body.expires_in).toBeGreaterThanOrEqual(seconds - 1);
    const row = await db.getDeviceCodeByDeviceHash(hashCode(body.device_code));
    expect(row?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresMs = Date.parse(row?.expires_at ?? "");
    expect(expiresMs).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + seconds * 1000);
  });
});

describe("a sign-in whose login is already taken as a namespace", () => {
  const KEYS = [
    "NODE_ENV",
    "CORS_ORIGIN",
    "SKRUN_DEV_AUTH",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "SKRUN_ALLOWED_GITHUB_USERS",
    "SKRUN_PUBLIC_URL",
    "SKRUN_SESSION_COOKIE_DOMAIN",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  // GitHub ids no other value of these cases contains, so "a log line names no
  // GitHub id" is a search for one string.
  const GH_ID_STEM = "734000";
  const GH_FIRST = 7_340_001;
  const GH_SECOND = 7_340_002;
  const GH_THIRD = 7_340_003;

  let app: ReturnType<typeof createTestApp>["app"];
  let db: MemoryDb;

  beforeEach(() => {
    for (const key of KEYS) snapshot[key] = process.env[key];
    delete process.env.SKRUN_DEV_AUTH;
    delete process.env.SKRUN_ALLOWED_GITHUB_USERS;
    delete process.env.SKRUN_PUBLIC_URL;
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
    process.env.GITHUB_CLIENT_ID = "id";
    process.env.GITHUB_CLIENT_SECRET = "secret";

    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    logInfoSpy.mockClear();
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  /** The payloads of every `namespace_derived` line logged so far. */
  function derivedLines(): unknown[] {
    return logInfoSpy.mock.calls
      .map((call) => call[0] as { event?: unknown } | undefined)
      .filter((payload) => payload?.event === "namespace_derived");
  }

  /** Who the session in this jar signs in as, as the dashboard reads it. */
  async function signedInAs(jar: { header(): string }) {
    const res = await app.request("/api/me", { headers: { Cookie: jar.header() } });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; username: string; namespace: string };
  }

  it("the web sign-in opens a session on `<login>--2`, then the CLI's poll hands out `<login>--3`", async () => {
    const first = await db.createUser({ github_id: String(GH_FIRST), username: "alice" });

    stubGithubOk({ id: GH_SECOND, login: "alice" });
    const web = await runWebSignIn(app);
    expect(web.callback.status).toBe(302);
    expect(web.callback.headers.get("Location")).toBe("/dashboard");
    const second = await signedInAs(web.jar);
    expect(second).toMatchObject({ username: "alice--2", namespace: "alice--2" });

    stubGithubOk({ id: GH_THIRD, login: "Alice" });
    const cli = await runDeviceJourney(app, db, "NAME-2345");
    expect(cli.callback.status).toBe(200);
    expect(cli.donePage).toContain("You're all set");
    expect(cli.poll.status).toBe(200);
    expect(await cli.poll.json()).toMatchObject({ username: "alice--3" });
    const third = await db.getUserByGithubId(String(GH_THIRD));
    expect(third?.username).toBe("alice--3");

    // The first account is untouched.
    expect((await db.getUserByGithubId(String(GH_FIRST)))?.id).toBe(first.id);
    expect((await db.getUserByGithubId(String(GH_FIRST)))?.username).toBe("alice");

    // One line per derived name: the account's internal id and N, nothing that
    // names the person — neither the login nor the GitHub id.
    const lines = derivedLines();
    expect(JSON.stringify(lines)).not.toContain("alice");
    expect(JSON.stringify(lines)).not.toContain(GH_ID_STEM);
    expect(lines).toEqual([
      { event: "namespace_derived", user_id: second.id, n: 2 },
      { event: "namespace_derived", user_id: third?.id, n: 3 },
    ]);
    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  it("with a return destination configured, the derived account lands on the site's root, no marker", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    ({ app, db } = createTestApp());

    await db.createUser({ github_id: String(GH_FIRST), username: "alice" });
    stubGithubOk({ id: GH_SECOND, login: "alice" });
    const { callback, jar } = await runWebSignIn(app);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("https://example.com/");
    expect(await signedInAs(jar)).toMatchObject({ username: "alice--2" });
  });

  it("when every candidate name is taken, the sign-in fails with the existing marker", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://app.example.com";
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    ({ app, db } = createTestApp());
    vi.spyOn(db, "createOAuthUser").mockRejectedValue(
      new NamespaceUnavailableError(NAMESPACE_MAX_ATTEMPTS),
    );

    stubGithubOk({ id: GH_SECOND, login: "alice" });
    const { callback } = await runWebSignIn(app);

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("https://example.com/?login=failed");
    expect(logErrorSpy).toHaveBeenCalledWith(
      {
        event: "oauth_callback_failed",
        stage: "user",
        error_name: "NamespaceUnavailableError",
        error_code: "NAMESPACE_UNAVAILABLE",
      },
      expect.any(String),
    );
  });

  it("an account whose GitHub login changed keeps the namespace it was given", async () => {
    stubGithubOk({ id: GH_FIRST, login: "alice" });
    const before = await signedInAs((await runWebSignIn(app)).jar);
    expect(before.username).toBe("alice");

    stubGithubOk({ id: GH_FIRST, login: "alice-new" });
    const after = await signedInAs((await runWebSignIn(app)).jar);
    expect(after.id).toBe(before.id);
    expect(after.username).toBe("alice");
    expect((await db.getUserByGithubId(String(GH_FIRST)))?.username).toBe("alice");

    // A login taken as is, then a returning account: nothing was derived.
    expect(derivedLines()).toEqual([]);
  });
});

describe("revoking an API key, with a deletion journal", () => {
  const NOT_FOUND = {
    error: { code: "NOT_FOUND", message: "API key not found or not owned by you" },
  };
  const JOURNAL_FAILED =
    "API key revoked, but its deletion journal record could not be written, or not in time: a database restored from an earlier copy may bring this key back";

  interface Revocations {
    app: Hono;
    db: MemoryDb;
    /** The store the journal writes to. */
    store: MemoryStorage;
    aliceId: string;
    bobId: string;
    /** Alice's account-wide key, every operation: a master credential. */
    aliceKey: string;
    /** The id of another key of Alice's, the one revoked. */
    revokedId: string;
    /** That key itself, to sign in with once it is revoked. */
    revokedKey: string;
    /** The id of a key of Bob's. */
    bobKeyId: string;
  }

  /** The auth routes alone, on their own app, given a journal on `store` — or none. */
  async function revocations(opts: { journal: boolean }): Promise<Revocations> {
    const db = new MemoryDb();
    const store = new MemoryStorage();
    const site = readOperatorSite({}, { canonicalUrl: undefined, cookieDomain: undefined });
    const app = new Hono();
    app.route(
      "",
      createAuthRoutes(
        db,
        createAuthMiddleware(db),
        "admin",
        site,
        opts.journal ? createDeletionJournal(store) : undefined,
      ),
    );
    const mint = async (userId: string, name: string) => {
      const { key, keyHash, keyPrefix } = generateApiKey();
      const row = await db.createApiKey({
        user_id: userId,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name,
      });
      return { key, id: row.id };
    };
    const alice = await db.createUser({ github_id: "gh-journal-alice", username: "alice" });
    const bob = await db.createUser({ github_id: "gh-journal-bob", username: "bob" });
    const aliceKey = (await mint(alice.id, "master")).key;
    const revoked = await mint(alice.id, "to revoke");
    return {
      app,
      db,
      store,
      aliceId: alice.id,
      bobId: bob.id,
      aliceKey,
      revokedId: revoked.id,
      revokedKey: revoked.key,
      bobKeyId: (await mint(bob.id, "bob's")).id,
    };
  }

  const revoke = (r: Revocations, id: string, token = r.aliceKey) =>
    r.app.request(`/api/keys/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

  /** The ids of every key Alice and Bob still hold. */
  const keyIds = async (r: Revocations) =>
    [...(await r.db.listApiKeys(r.aliceId)), ...(await r.db.listApiKeys(r.bobId))].map((k) => k.id);

  beforeEach(() => {
    logErrorSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the caller's own key: 204, its record written once the key is read, before its row goes", async () => {
    const r = await revocations({ journal: true });
    const read = vi.spyOn(r.db, "listApiKeys");
    const put = vi.spyOn(r.store, "put");
    const remove = vi.spyOn(r.db, "deleteApiKeyByOwner");

    const res = await revoke(r, r.revokedId);

    expect(res.status).toBe(204);
    expect(await r.store.list("_deletions/")).toEqual([`_deletions/api-key/${r.revokedId}`]);
    expect((await r.store.get(`_deletions/api-key/${r.revokedId}`))?.length).toBe(0);
    expect(await keyIds(r)).not.toContain(r.revokedId);
    const recorded = put.mock.invocationCallOrder[0] as number;
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(recorded);
    expect(recorded).toBeLessThan(remove.mock.invocationCallOrder[0] as number);
    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  it("an id in capitals names the same key: 204, the record in lower case, the key gone", async () => {
    const r = await revocations({ journal: true });

    const res = await revoke(r, r.revokedId.toUpperCase());

    expect(res.status).toBe(204);
    expect(await r.store.list("_deletions/")).toEqual([`_deletions/api-key/${r.revokedId}`]);
    expect(await keyIds(r)).not.toContain(r.revokedId);
  });

  it("another account's key: 404, nothing recorded, the key kept", async () => {
    const r = await revocations({ journal: true });

    const res = await revoke(r, r.bobKeyId);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(await r.store.list("_deletions/")).toEqual([]);
    expect(await keyIds(r)).toContain(r.bobKeyId);
  });

  it.each([
    "any-id",
    "0b6f7c2e-4d1a-4c3b-9e8f-1a2b3c4d5e6",
    "0b6f7c2e-4d1a-4c3b-9e8f-1a2b3c4d5e6fz",
  ])("an id the server could not have issued (%s): 404 before anything is read, nothing recorded", async (id) => {
    const r = await revocations({ journal: true });
    const read = vi.spyOn(r.db, "listApiKeys");
    const remove = vi.spyOn(r.db, "deleteApiKeyByOwner");

    const res = await revoke(r, id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await r.store.list("_deletions/")).toEqual([]);
  });

  it("a journal that cannot record never stops the revocation: 204, the key gone, one line at error", async () => {
    const r = await revocations({ journal: true });
    vi.spyOn(r.store, "put").mockRejectedValue(
      Object.assign(new Error(`cannot write _deletions/api-key/${r.revokedId}`), {
        name: "TimeoutError",
        code: "ETIMEDOUT",
      }),
    );

    const res = await revoke(r, r.revokedId);

    expect(res.status).toBe(204);
    expect(await keyIds(r)).not.toContain(r.revokedId);
    expect(logErrorSpy.mock.calls).toEqual([
      [
        {
          event: "api_key_revocation_journal_failed",
          key_id: r.revokedId,
          error_name: "TimeoutError",
          error_code: "ETIMEDOUT",
        },
        JOURNAL_FAILED,
      ],
    ]);
  });

  /** Another request revokes `id` once this one has read the caller's keys, before its own DELETE. */
  const revokedMeanwhile = (r: Revocations, id: string) => {
    const read = r.db.listApiKeys.bind(r.db);
    vi.spyOn(r.db, "listApiKeys").mockImplementation(async (userId) => {
      const keys = await read(userId);
      await r.db.deleteApiKeyByOwner(id, userId);
      return keys;
    });
  };

  it("a key another request revoked after this one read it: 404, today's body, no line at error", async () => {
    const r = await revocations({ journal: true });
    revokedMeanwhile(r, r.revokedId);

    const res = await revoke(r, r.revokedId);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(await keyIds(r)).not.toContain(r.revokedId);
    expect(logErrorSpy).not.toHaveBeenCalled();
    // The record this request wrote stays: a revocation of the same key writes the same object.
    expect(await r.store.list("_deletions/")).toEqual([`_deletions/api-key/${r.revokedId}`]);
  });

  it("a key another request revoked after this one read it, its record not written: 404, and no line at error", async () => {
    const r = await revocations({ journal: true });
    revokedMeanwhile(r, r.revokedId);
    vi.spyOn(r.store, "put").mockRejectedValue(
      Object.assign(new Error(`cannot write _deletions/api-key/${r.revokedId}`), {
        name: "TimeoutError",
        code: "ETIMEDOUT",
      }),
    );

    const res = await revoke(r, r.revokedId);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(logErrorSpy).not.toHaveBeenCalled();
  });

  describe("a record that does not come in time", () => {
    /** What `answer` resolved to, once it has: undefined while it is still pending. */
    const watch = (answer: Promise<Response>) => {
      const seen: { res?: Response } = {};
      void answer.then((res) => {
        seen.res = res;
      });
      return seen;
    };

    /** Lets the request run up to its first timer: every step before it is a promise. */
    const untilRecordAsked = async (put: { mock: { calls: unknown[] } }) => {
      for (let turn = 0; turn < 20 && put.mock.calls.length === 0; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(put.mock.calls).toHaveLength(1);
    };

    const timedOut = (r: Revocations) => [
      [
        {
          event: "api_key_revocation_journal_failed",
          key_id: r.revokedId,
          error_name: "RevocationJournalTimeout",
        },
        JOURNAL_FAILED,
      ],
    ];

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a store that never answers: 204 once the wait is over and not before, the key refused next, one line at error", async () => {
      const r = await revocations({ journal: true });
      const put = vi.spyOn(r.store, "put").mockReturnValue(new Promise<void>(() => {}));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      // The wait the docs and the CHANGELOG name: 5 seconds.
      expect(REVOCATION_JOURNAL_WAIT_MS).toBe(5_000);
      const answer = watch(revoke(r, r.revokedId));
      await untilRecordAsked(put);
      await vi.advanceTimersByTimeAsync(REVOCATION_JOURNAL_WAIT_MS - 1);
      expect(answer.res).toBeUndefined();
      expect(await keyIds(r)).toContain(r.revokedId);
      const timersWhileWaiting = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(1);

      expect(answer.res?.status).toBe(204);
      expect(timersWhileWaiting).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(await keyIds(r)).not.toContain(r.revokedId);
      const next = await r.app.request("/api/keys", {
        headers: { Authorization: `Bearer ${r.revokedKey}` },
      });
      expect(next.status).toBe(401);
      expect(logErrorSpy.mock.calls).toEqual(timedOut(r));
    });

    it("a record written at once leaves no timer behind", async () => {
      const r = await revocations({ journal: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const res = await revoke(r, r.revokedId);

      expect(res.status).toBe(204);
      expect(await r.store.list("_deletions/")).toEqual([`_deletions/api-key/${r.revokedId}`]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a write that fails at once leaves no timer behind", async () => {
      const r = await revocations({ journal: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(r.store, "put").mockRejectedValue(
        Object.assign(new Error(`cannot write _deletions/api-key/${r.revokedId}`), {
          name: "TimeoutError",
          code: "ETIMEDOUT",
        }),
      );

      const res = await revoke(r, r.revokedId);

      expect(res.status).toBe(204);
      expect(await keyIds(r)).not.toContain(r.revokedId);
      expect(logErrorSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a write that fails once the wait is over: 204 at the wait, then nothing — no unhandled rejection, no second line", async () => {
      const r = await revocations({ journal: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const late = Object.assign(new Error(`cannot write _deletions/api-key/${r.revokedId}`), {
        name: "TimeoutError",
        code: "ETIMEDOUT",
      });
      const put = vi.spyOn(r.store, "put").mockImplementation(
        () =>
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(late), REVOCATION_JOURNAL_WAIT_MS + 1_000);
          }),
      );
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const answer = watch(revoke(r, r.revokedId));
        await untilRecordAsked(put);
        await vi.advanceTimersByTimeAsync(REVOCATION_JOURNAL_WAIT_MS);
        expect(answer.res?.status).toBe(204);

        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        expect(logErrorSpy.mock.calls).toEqual(timedOut(r));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  it("a delegated key is refused 403 before anything is read or recorded", async () => {
    const r = await revocations({ journal: true });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await r.db.createApiKey({
      user_id: r.aliceId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "delegated",
      scope_kind: "agents",
      scopes: ["agent:run"],
      agents: [],
    });
    const read = vi.spyOn(r.db, "listApiKeys");

    const res = await revoke(r, r.revokedId, key);

    expect(res.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(await r.store.list("_deletions/")).toEqual([]);
    expect(await keyIds(r)).toContain(r.revokedId);
  });

  it("without a journal, the revocation records nothing", async () => {
    const r = await revocations({ journal: false });
    const put = vi.spyOn(r.store, "put");

    const res = await revoke(r, r.revokedId);

    expect(res.status).toBe(204);
    expect(put).not.toHaveBeenCalled();
    expect(await keyIds(r)).not.toContain(r.revokedId);
  });
});

describe("revoking an API key through the app, with SKRUN_DELETION_JOURNAL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** An app built as the server builds it, a user with two keys: one to sign in with, one to revoke. */
  async function appWithKeys(): Promise<{
    storage: MemoryStorage;
    db: MemoryDb;
    app: ReturnType<typeof createApp>;
    key: string;
    revokedId: string;
  }> {
    const { app, db, storage } = createTestApp();
    const user = await db.createUser({ github_id: "gh-journal-app", username: "alice" });
    const master = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: master.keyHash,
      key_prefix: master.keyPrefix,
      name: "master",
    });
    const other = generateApiKey();
    const revoked = await db.createApiKey({
      user_id: user.id,
      key_hash: other.keyHash,
      key_prefix: other.keyPrefix,
      name: "to revoke",
    });
    return { storage, db, app, key: master.key, revokedId: revoked.id };
  }

  it("set to true, a revocation records the key in the store the app keeps bundles in", async () => {
    vi.stubEnv("SKRUN_DELETION_JOURNAL", "true");
    const w = await appWithKeys();

    const res = await w.app.request(`/api/keys/${w.revokedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${w.key}` },
    });

    expect(res.status).toBe(204);
    expect(await w.storage.list("_deletions/")).toEqual([`_deletions/api-key/${w.revokedId}`]);
  });

  it("unset, a revocation records nothing", async () => {
    const w = await appWithKeys();
    const put = vi.spyOn(w.storage, "put");

    const res = await w.app.request(`/api/keys/${w.revokedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${w.key}` },
    });

    expect(res.status).toBe(204);
    expect(put).not.toHaveBeenCalled();
  });
});
