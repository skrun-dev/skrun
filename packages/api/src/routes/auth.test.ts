import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { hashCode } from "../auth/device-code.js";
import { clearSessions, createSession } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

// #101-VT-10 asserts the `signup_rejected` structured log. pino writes to fd 1
// directly (bypassing process.stdout.write), so createLogger is mocked to capture
// logger.warn. vi.mock is hoisted; vi.hoisted declares the spy in lock-step. Only
// createLogger is replaced — the rest of @skrun-dev/runtime is left intact.
const { logWarnSpy } = vi.hoisted(() => ({ logWarnSpy: vi.fn() }));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: logWarnSpy,
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      level: "info",
      child: () => ({ info: vi.fn(), warn: logWarnSpy }),
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
    clearSessions();
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
      expect(html).not.toContain("sk_live");
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
      expect(res.headers.get("Location")).toContain("/dashboard");
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
      expect(res.headers.get("Location")).toContain("/dashboard");
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
    expect(callbackRes.headers.get("Location")).toContain("/dashboard");

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
      expect(html).not.toContain("sk_live");
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

  // VT-4: POST /api/keys creates key
  it("VT-4: POST /api/keys creates key with correct format", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = createSession(user.id);

    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: `skrun_session=${sessionId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "CI key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sk_live_[0-9a-f]{32}$/);
    expect(body.name).toBe("CI key");
    expect(body.key_prefix).toMatch(/^sk_live_[0-9a-f]{8}$/);
    expect(body.scopes).toContain("agent:push");
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
    const sessionId = createSession(user.id);

    // Create key
    const createRes = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: `skrun_session=${sessionId}`, "Content-Type": "application/json" },
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
      headers: { Cookie: `skrun_session=${sessionId}` },
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
      headers: { Cookie: `skrun_session=${session}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("VT-2: mint defaults to scope_kind 'account' + full operation scopes", async () => {
    const user = await db.createUser({ github_id: "gh-m2", username: "m2" });
    const res = await mintAs(createSession(user.id), { name: "k" });
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
    const res = await mintAs(createSession(user.id), {
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
    const res = await mintAs(createSession(alice.id), {
      name: "x",
      scope_kind: "agents",
      agents: ["bob4/secret"],
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown operation scope → 400", async () => {
    const user = await db.createUser({ github_id: "gh-m5", username: "m5" });
    const res = await mintAs(createSession(user.id), { name: "x", scopes: ["agent:nuke"] });
    expect(res.status).toBe(400);
  });

  // VT-7: Push to own namespace succeeds
  it("VT-7: push to own namespace succeeds", async () => {
    const res = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    expect(res.status).toBe(200);
  });

  // VT-8: Push to other namespace returns 403
  it("VT-8: push to other namespace returns 403", async () => {
    const res = await app.request("/api/agents/other/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    expect(res.status).toBe(403);
  });

  // VT-9: Run on a verified version is public (no namespace gate at run-time)
  it("VT-9: run on another user's verified agent succeeds (no namespace gate at run-time)", async () => {
    // Push as dev (creates row with verified=false)
    await app.request("/api/agents/dev/my-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });

    // Admin (dev-token = admin) verifies v1.0.0 so the hard 403 gate passes.
    await db.setVersionVerified("dev", "my-agent", "1.0.0", true);

    // Run with a different token — still works (auth succeeds, no namespace
    // check at run-time, version is verified).
    const res = await app.request("/api/agents/dev/my-agent/run", {
      method: "POST",
      headers: { Authorization: "Bearer other-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    // Past auth + verified gate now — downstream failure (e.g. fake bundle
    // extraction) is acceptable, but the response must NOT be 403.
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
    const sessionId = createSession(user.id);

    const res = await app.request("/api/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
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
    const sessionId = createSession(u.id);

    const res = await policyApp.request("/api/me", {
      headers: { Cookie: `skrun_session=${sessionId}` },
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

  // VT-13: Logout clears session
  it("VT-13: POST /auth/logout clears session cookie", async () => {
    const user = await db.createUser({ github_id: "gh-1", username: "alice" });
    const sessionId = createSession(user.id);

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `skrun_session=${sessionId}` },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // biome-ignore lint/style/noNonNullAssertion: test assertion — value checked by expect
    const cookies = res.headers.get("Set-Cookie")!;
    expect(cookies).toContain("skrun_session=;");
  });

  // VT-14: Invalid API key returns 401
  it("VT-14: invalid sk_live_ key returns 401", async () => {
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
