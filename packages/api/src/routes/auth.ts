import { randomUUID } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { generateApiKey } from "../auth/api-key.js";
import { isDevAuthEnabled } from "../auth/dev-auth.js";
import {
  computeExpiresIn,
  generateDeviceCode,
  generateUserCode,
  hashCode,
  issueCsrfToken,
  ttlSeconds,
  verifyCsrfToken,
} from "../auth/device-code.js";
import {
  exchangeCodeForToken,
  fetchGithubUser,
  getGithubAuthUrl,
  isOAuthConfigured,
} from "../auth/github-oauth.js";
import { verifyChallenge } from "../auth/pkce.js";
import {
  createSession,
  destroySession,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "../auth/session.js";
import { isGithubUserAllowed } from "../auth/signup-allowlist.js";
import type { DbAdapter } from "../db/adapter.js";
import { API_KEY_DEFAULT_SCOPES } from "../db/schema.js";
import { getUser } from "../middleware/auth.js";
import type { VerificationPolicy } from "../services/verification-policy.js";
import { externalBaseUrl } from "../utils/external-url.js";
import { requireMasterCredential } from "./_helpers.js";

const logger = createLogger("auth");

const OAUTH_STATE_COOKIE = "skrun_oauth_state";

/**
 * A legacy CLI (pre-device-flow) opened `/auth/github?cli_callback=…` and expected
 * its `sk_live` key back via the loopback URL. That flow is removed — it leaked the
 * key in the URL (browser history / Referer / logs). Tell the user to update instead
 * of failing silently.
 */
function outdatedCliPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Update Skrun CLI</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;background:#fff;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){body{background:#030712;color:#f3f4f6}code{background:#1f2937;color:#d1d5db}}
.card{max-width:440px;text-align:center;padding:40px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 12px}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,monospace}</style></head>
<body><div class="card"><h1>Update your Skrun CLI</h1>
<p>The CLI login flow has been hardened — your API key is no longer passed through the URL. Your CLI is out of date.</p>
<p>Update with <code>npm i -g @skrun-dev/cli</code>, then run <code>skrun login</code> again.</p></div></body></html>`;
}

/** Marks an in-progress CLI device-login authorization (set by POST /device). */
const DEVICE_USER_CODE_COOKIE = "skrun_device_user_code";
/** CSRF double-submit cookie for the /device consent form. */
const DEVICE_CSRF_COOKIE = "skrun_device_csrf";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The CLI device-login consent page. States what is requesting access and warns
 * against device-code phishing. The CSRF token is a double-submit value (also set
 * in a cookie) so a cross-origin page cannot forge the form POST.
 */
function devicePage(userCode: string, csrf: string): string {
  const uc = escapeHtml(userCode);
  const token = escapeHtml(csrf);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize Skrun CLI</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;background:#fff;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){body{background:#030712;color:#f3f4f6}.card{border-color:#1f2937}input{background:#0c0f15;color:#f3f4f6;border-color:#1f2937}code{background:#1f2937;color:#d1d5db}.warn{background:#3f2d0a;color:#fde68a}}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:40px;max-width:420px;width:100%;text-align:center}
h1{font-size:20px;font-weight:600;margin:0 0 4px}.sub{color:#6b7280;font-size:14px;margin:0 0 24px}
label{display:block;text-align:left;font-size:12px;color:#6b7280;margin:0 0 6px}
input[name=user_code]{width:100%;padding:10px 12px;font-size:18px;letter-spacing:2px;text-align:center;font-family:ui-monospace,monospace;border:1px solid #e5e7eb;border-radius:8px;text-transform:uppercase}
button{margin-top:16px;width:100%;padding:11px;border:none;border-radius:8px;background:#111827;color:#fff;font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#1f2937}
.warn{margin-top:20px;padding:10px 12px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:12px;line-height:1.5;text-align:left}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12px}</style></head>
<body><div class="card"><h1>Authorize Skrun CLI</h1>
<p class="sub">A Skrun CLI is requesting access to your account.</p>
<form method="POST" action="/device">
<label for="user_code">One-time code</label>
<input id="user_code" name="user_code" value="${uc}" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
<input type="hidden" name="csrf" value="${token}">
<button type="submit">Continue with GitHub</button></form>
<p class="warn">⚠️ Only continue if you just ran <code>skrun login</code> yourself. Never enter a code someone sent you.</p>
</div></body></html>`;
}

/** Shown when a submitted user_code is unknown, expired, or already used. */
function deviceErrorPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Code invalid</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;background:#fff;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){body{background:#030712;color:#f3f4f6}code{background:#1f2937;color:#d1d5db}}
.card{max-width:420px;text-align:center;padding:40px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{color:#6b7280;font-size:14px;line-height:1.6;margin:0}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-family:ui-monospace,monospace;font-size:13px}</style></head>
<body><div class="card"><h1>Code expired or invalid</h1>
<p>That one-time code is no longer valid. Return to your terminal and run <code>skrun login</code> again.</p></div></body></html>`;
}

/** Shown after a successful device-login authorization — no token in the page. */
function deviceDonePage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>All set</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;background:#fff;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){body{background:#030712;color:#f3f4f6}}
.card{max-width:420px;text-align:center;padding:40px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{color:#6b7280;font-size:14px;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>✓ You're all set</h1>
<p>Authentication complete — return to your terminal.</p></div></body></html>`;
}

/**
 * Shown when a GitHub account is not on this instance's signup allowlist.
 * Generic on purpose — it never echoes the rejected login/id (no enumeration oracle).
 */
function notAuthorizedPage(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Not authorized</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;background:#fff;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){body{background:#030712;color:#f3f4f6}}
.card{max-width:440px;text-align:center;padding:40px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{color:#6b7280;font-size:14px;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>Not authorized</h1>
<p>This GitHub account is not authorized to access this instance. If you think this is a mistake, contact the instance operator.</p></div></body></html>`;
}

export function createAuthRoutes(
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  verificationPolicy: VerificationPolicy = "admin",
): Hono {
  const router = new Hono();

  // ==================== OAuth Routes ====================

  // GET /auth/github — redirect to GitHub authorize
  router.get("/auth/github", (c) => {
    if (!isOAuthConfigured()) {
      return c.json(
        {
          error: {
            code: "OAUTH_NOT_CONFIGURED",
            message: "GitHub OAuth is not configured on this instance",
          },
        },
        404,
      );
    }

    // A legacy CLI passes ?cli_callback= (the removed loopback flow). Refuse it
    // with a clear "update your CLI" page instead of proceeding silently.
    if (c.req.query("cli_callback")) {
      return c.html(outdatedCliPage(), 400);
    }

    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const clientId = process.env.GITHUB_CLIENT_ID!;
    const baseUrl = externalBaseUrl(c);
    const redirectUri = `${baseUrl}/auth/github/callback`;
    const state = randomUUID();

    // Store state in a short-lived cookie for CSRF protection
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 300, // 5 minutes
    });

    const url = getGithubAuthUrl(clientId, redirectUri, state);
    return c.redirect(url);
  });

  // GET /auth/github/callback — exchange code, create/update user, set session
  router.get("/auth/github/callback", async (c) => {
    if (!isOAuthConfigured()) {
      return c.json(
        { error: { code: "OAUTH_NOT_CONFIGURED", message: "GitHub OAuth is not configured" } },
        404,
      );
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, OAUTH_STATE_COOKIE);

    if (!code || !state || state !== storedState) {
      return c.json(
        { error: { code: "INVALID_OAUTH_CALLBACK", message: "Invalid or missing OAuth state" } },
        400,
      );
    }

    // Clear the state cookie
    setCookie(c, OAUTH_STATE_COOKIE, "", { maxAge: 0, path: "/" });

    try {
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const clientId = process.env.GITHUB_CLIENT_ID!;
      // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
      const clientSecret = process.env.GITHUB_CLIENT_SECRET!;

      const accessToken = await exchangeCodeForToken(clientId, clientSecret, code);
      const ghUser = await fetchGithubUser(accessToken);

      // Signup allowlist: when SKRUN_ALLOWED_GITHUB_USERS is set, only listed GitHub
      // accounts may create an account / log in (web + device). Unset = open. Runs
      // before the upsert so a rejected login leaves no user behind.
      if (!isGithubUserAllowed(ghUser)) {
        logger.warn({ event: "signup_rejected", login: ghUser.login, id: ghUser.id });
        // A device-login reject: terminate the bound device code so the CLI's next
        // poll gets `expired_token` (an existing state) instead of a stale `pending`,
        // and clear the binding cookie. The cookie holds the user_code; consume runs
        // on the device_code_hash, so look the row up first.
        const deviceUserCode = getCookie(c, DEVICE_USER_CODE_COOKIE);
        if (deviceUserCode) {
          const dc = await db.getDeviceCodeByUserHash(hashCode(deviceUserCode.toUpperCase()));
          if (dc) await db.consumeDeviceCode(dc.device_code_hash);
          setCookie(c, DEVICE_USER_CODE_COOKIE, "", { maxAge: 0, path: "/" });
        }
        return c.html(notAuthorizedPage(), 403);
      }

      // Upsert user in DB
      let user = await db.getUserByGithubId(String(ghUser.id));
      if (user) {
        // Update profile info
        await db.updateUser(user.id, {
          email: ghUser.email ?? user.email,
          avatar_url: ghUser.avatar_url ?? user.avatar_url,
        });
        // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
        user = (await db.getUserById(user.id))!;
      } else {
        user = await db.createUser({
          github_id: String(ghUser.id),
          username: ghUser.login.toLowerCase(),
          email: ghUser.email ?? undefined,
          avatar_url: ghUser.avatar_url ?? undefined,
        });
      }

      // Device-login flow: if this browser is completing a CLI device
      // authorization, bind the device code to the now-authenticated user and
      // stop here — the CLI receives the token by polling, never via a URL.
      const deviceUserCode = getCookie(c, DEVICE_USER_CODE_COOKIE);
      if (deviceUserCode) {
        setCookie(c, DEVICE_USER_CODE_COOKIE, "", { maxAge: 0, path: "/" });
        const ok = await db.authorizeDeviceCode(hashCode(deviceUserCode.toUpperCase()), user.id);
        return ok ? c.html(deviceDonePage()) : c.html(deviceErrorPage(), 400);
      }

      // Web flow: create session cookie
      const sessionId = createSession(user.id);
      const cookieOpts = getSessionCookieOptions();
      setCookie(c, SESSION_COOKIE_NAME, sessionId, cookieOpts);

      // Redirect to dashboard
      return c.redirect("/dashboard");
    } catch (err) {
      return c.json(
        {
          error: {
            code: "OAUTH_FAILED",
            message: err instanceof Error ? err.message : "OAuth authentication failed",
          },
        },
        500,
      );
    }
  });

  // ==================== Device Authorization Grant (RFC 8628) ====================

  // POST /auth/device/code — the CLI requests a device_code + user_code (+ PKCE).
  // The token is delivered later via the poll body, never a URL.
  router.post("/auth/device/code", async (c) => {
    if (!isOAuthConfigured()) {
      // Self-host without OAuth: the CLI falls back to the --token prompt.
      return c.json(
        { error: { code: "OAUTH_NOT_CONFIGURED", message: "GitHub OAuth is not configured" } },
        404,
      );
    }

    let body: { code_challenge?: string; code_challenge_method?: string };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const codeChallenge = body.code_challenge?.trim();
    // PKCE (RFC 7636) is required; we only support S256.
    if (!codeChallenge || (body.code_challenge_method && body.code_challenge_method !== "S256")) {
      return c.json(
        {
          error: { code: "invalid_request", message: "code_challenge (PKCE S256) is required" },
        },
        400,
      );
    }

    // Opportunistic sweep of expired codes — no background job needed.
    await db.purgeExpiredDeviceCodes();

    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + ttlSeconds() * 1000).toISOString();
    await db.createDeviceCode({
      device_code_hash: hashCode(deviceCode),
      user_code_hash: hashCode(userCode),
      code_challenge: codeChallenge,
      expires_at: expiresAt,
    });

    const baseUrl = externalBaseUrl(c);
    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${baseUrl}/device`,
      verification_uri_complete: `${baseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
      expires_in: computeExpiresIn(expiresAt),
      interval: 5,
    });
  });

  // GET /device — the human consent page (reachable at /device?user_code=...).
  router.get("/device", (c) => {
    const userCode = c.req.query("user_code") ?? "";
    const csrf = issueCsrfToken();
    setCookie(c, DEVICE_CSRF_COOKIE, csrf, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    return c.html(devicePage(userCode, csrf));
  });

  // POST /device — confirm the user_code, bind it to this browser, run GitHub OAuth.
  router.post("/device", async (c) => {
    const body = await c.req.parseBody();
    // CSRF: a double-submit token — the form field must equal the cookie value,
    // which a cross-origin page can neither read (httpOnly + same-origin policy)
    // nor set (host-only cookie). This is the complete CSRF defense. We do NOT
    // also check the `Origin` header: for a top-level form-POST navigation its
    // presence/value is browser- and proxy-dependent (it can be the origin,
    // `null`, or absent), so gating the login critical path on it would reject
    // legitimate submissions — a fragility surfaced by the cloud browser test.
    const formCsrf = typeof body.csrf === "string" ? body.csrf : undefined;
    if (!verifyCsrfToken(getCookie(c, DEVICE_CSRF_COOKIE), formCsrf)) {
      return c.json({ error: { code: "CSRF_FAILED", message: "Invalid CSRF token" } }, 403);
    }

    const userCode = (typeof body.user_code === "string" ? body.user_code : "")
      .trim()
      .toUpperCase();
    const dc = userCode ? await db.getDeviceCodeByUserHash(hashCode(userCode)) : null;
    const expired = dc ? new Date(dc.expires_at).getTime() < Date.now() : true;
    if (!dc || expired || dc.status !== "pending") {
      return c.html(deviceErrorPage(), 400);
    }

    // Bind the in-progress authorization to this browser (survives the GitHub
    // round-trip via SameSite=Lax), then hand off to the existing OAuth leg.
    setCookie(c, DEVICE_USER_CODE_COOKIE, userCode, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    setCookie(c, DEVICE_CSRF_COOKIE, "", { maxAge: 0, path: "/" });
    return c.redirect("/auth/github");
  });

  // POST /auth/device/token — the CLI polls here; on success the sk_live is in the
  // response body (minted at poll-success), never a URL.
  router.post("/auth/device/token", async (c) => {
    let body: { device_code?: string; code_verifier?: string };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const deviceCode = body.device_code;
    const codeVerifier = body.code_verifier ?? "";
    if (!deviceCode) {
      return c.json(
        { error: { code: "invalid_request", message: "device_code is required" } },
        400,
      );
    }

    const hash = hashCode(deviceCode);
    const dc = await db.getDeviceCodeByDeviceHash(hash);
    const expired = dc ? new Date(dc.expires_at).getTime() < Date.now() : true;
    if (!dc || expired) {
      await db.purgeExpiredDeviceCodes();
      return c.json(
        { error: { code: "expired_token", message: "The device code has expired" } },
        400,
      );
    }

    // RFC 8628 §3.5 back-off. The first poll (last_polled_at NULL) is always allowed
    // — never compute `now - null`.
    if (dc.last_polled_at) {
      const since = Date.now() - new Date(dc.last_polled_at).getTime();
      if (since < dc.current_interval * 1000) {
        await db.recordDeviceCodePoll(hash, true); // sets last_polled_at + interval += 5
        return c.json({ error: { code: "slow_down", message: "Polling too fast" } }, 400);
      }
    }
    await db.recordDeviceCodePoll(hash, false);

    if (dc.status !== "authorized") {
      return c.json(
        { error: { code: "authorization_pending", message: "Not yet authorized" } },
        400,
      );
    }

    // PKCE — a wrong verifier does NOT consume the code (a legit retry survives),
    // but attempts are capped to stop verifier grinding.
    if (!verifyChallenge(codeVerifier, dc.code_challenge)) {
      const attempts = await db.incrementDeviceCodeAttempts(hash);
      if (attempts >= 3) await db.consumeDeviceCode(hash);
      return c.json({ error: { code: "invalid_grant", message: "PKCE verification failed" } }, 400);
    }

    // Authorized + PKCE ok → mint the sk_live now and consume the code.
    // biome-ignore lint/style/noNonNullAssertion: an authorized code always has a user_id
    const userId = dc.user_id!;
    const user = await db.getUserById(userId);
    if (!user) {
      // The authorized account was deleted between authorize and poll — don't
      // mint a key for a non-existent user; consume the code + report expiry.
      await db.consumeDeviceCode(hash);
      return c.json(
        { error: { code: "expired_token", message: "The device code has expired" } },
        400,
      );
    }
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "CLI login",
    });
    await db.consumeDeviceCode(hash);
    return c.json({ token: key, username: user.username });
  });

  // ==================== Login Page ====================

  // GET /login — login page matching dashboard design system
  router.get("/login", (c) => {
    const oauthEnabled = isOAuthConfigured();
    const devAuthEnabled = isDevAuthEnabled();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Skrun</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
      background: #fff;
      color: #111827;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #030712; color: #f3f4f6; }
      .card { background: rgba(3,7,18,0.4); border-color: #1f2937; }
      .btn-github { background: #f3f4f6; color: #111827; }
      .btn-github:hover { background: #fff; }
      .note { color: #6b7280; }
      code { background: #1f2937; color: #d1d5db; }
      .divider { border-color: #1f2937; }
    }
    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 48px 40px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .logo { width: 48px; height: 48px; margin: 0 auto 16px; }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
    .subtitle { color: #6b7280; font-size: 13px; margin-bottom: 32px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 10px 28px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: background-color 0.15s, box-shadow 0.15s;
    }
    .btn-github {
      background: #111827;
      color: #fff;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.12);
    }
    .btn-github:hover { background: #1f2937; }
    .btn-github svg { width: 18px; height: 18px; }
    .divider { border-top: 1px solid #e5e7eb; margin: 24px 0; }
    .note { color: #9ca3af; font-size: 12px; line-height: 1.5; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-family: ui-monospace, monospace; }
    .footer { margin-top: 24px; font-size: 11px; color: #9ca3af; }
    .footer a { color: #0ea5e9; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <svg class="logo" role="img" aria-label="Skrun" viewBox="0 0 852.21191 456.36682" xmlns="http://www.w3.org/2000/svg">
      <defs><clipPath id="clip0"><rect x="236" y="243" width="521" height="279" /></clipPath></defs>
      <g transform="translate(-113.89405,-311.81659)">
        <g clip-path="url(#clip0)" transform="matrix(1.6357234,0,0,1.6357234,-272.13667,-85.6642)">
          <path d="m 583,288 h 63.529 L 757,383 646.529,478 H 583 l 110.471,-95 z" fill="#00aeff" fill-rule="evenodd" />
          <path d="M 0,0 H 63.5291 L 174,95 63.5291,190 H 0 L 110.471,95 Z" fill="#00aeff" fill-rule="evenodd" transform="matrix(-1,0,0,1,410,288)" />
          <path d="M 427,243 652,382.5 427,522 Z" fill="#00aeff" fill-rule="evenodd" />
          <path d="M 634.472,372 652,382.841 427,522 v -79.655 z" fill="#0070da" fill-rule="evenodd" />
          <path d="M 693.471,383 H 757 v 0 L 646.529,478 H 583 Z" fill="#017be3" fill-rule="evenodd" />
          <path d="M 174,0 H 110.471 V 2.09279e-4 L 0,95 H 63.5292 L 174,2.09279e-4 Z" fill="#017be3" fill-rule="evenodd" transform="matrix(-1,0,0,1,410,383)" />
        </g>
      </g>
    </svg>
    <h1>Skrun</h1>
    <p class="subtitle">Deploy any Agent Skill as an API</p>
    ${
      oauthEnabled
        ? `<a href="/auth/github" class="btn btn-github">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            Sign in with GitHub
          </a>`
        : devAuthEnabled
          ? '<p class="note">OAuth is not configured on this instance.<br>Use <code>Bearer dev-token</code> for local development.</p>'
          : '<p class="note">This instance requires authentication.<br>Configure GitHub OAuth, or use an API key (<code>sk_live_*</code>).</p>'
    }
    <div class="footer">
      <a href="/docs" target="_blank">API Docs</a>
    </div>
  </div>
</body>
</html>`;
    return c.html(html);
  });

  // ==================== Logout ====================

  // POST /auth/logout — clear session
  router.post("/auth/logout", (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) {
      destroySession(sessionId);
    }
    setCookie(c, SESSION_COOKIE_NAME, "", { maxAge: 0, path: "/" });
    return c.json({ ok: true });
  });

  // ==================== /api/me ====================

  // GET /api/me — return current user info (requires auth)
  router.get("/api/me", authMiddleware, (c) => {
    const user = getUser(c);
    return c.json({
      id: user.id,
      username: user.username,
      namespace: user.namespace,
      email: user.email ?? null,
      avatar_url: user.avatar_url ?? null,
      plan: user.plan ?? "free",
      // Dashboard needs `role` to conditionally render admin-only UI
      // (e.g. the <verify-button>).
      role: user.role,
      // The operator verification policy gates who may attest a version, so the
      // dashboard reads it (read-only — config, not a runtime-settable value) to
      // render the verify control correctly.
      verification_policy: verificationPolicy,
    });
  });

  // ==================== API Keys CRUD ====================

  // POST /api/keys — create new API key (requires auth)
  router.post("/api/keys", authMiddleware, async (c) => {
    const user = getUser(c);

    // Key management is account-administration: a delegated or operation-limited
    // key cannot mint another key (no privilege escalation). Master credential
    // = a session, a dev-token, or an account-wide + full sk_live key.
    const denied = requireMasterCredential(c);
    if (denied) return denied;

    let body: {
      name?: string;
      scopes?: string[];
      scope_kind?: string;
      agents?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }

    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "name is required" } }, 400);
    }

    // Operation scopes: default to a full key; reject unknown operations.
    const scopes = body.scopes ?? [...API_KEY_DEFAULT_SCOPES];
    const unknownScope = scopes.find((s) => !API_KEY_DEFAULT_SCOPES.includes(s));
    if (unknownScope) {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: `Unknown scope '${unknownScope}'. Allowed: ${API_KEY_DEFAULT_SCOPES.join(", ")}.`,
          },
        },
        400,
      );
    }

    // Resource scope: `account` (default) or `agents` (a list of ns/name the
    // minter owns). A creator can only scope a key to their own agents.
    const scopeKind = body.scope_kind ?? "account";
    if (scopeKind !== "account" && scopeKind !== "agents") {
      return c.json(
        {
          error: { code: "INVALID_REQUEST", message: 'scope_kind must be "account" or "agents".' },
        },
        400,
      );
    }
    const agentRefs = body.agents ?? [];
    const agentIds: string[] = [];
    if (scopeKind === "agents") {
      if (agentRefs.length === 0) {
        return c.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message:
                "scope_kind 'agents' requires a non-empty agents list of \"namespace/name\".",
            },
          },
          400,
        );
      }
      for (const ref of agentRefs) {
        const [ns, agentName] = ref.split("/");
        const agent = ns && agentName ? await db.getAgent(ns, agentName) : null;
        // A not-owned or absent agent both → 403 (no existence oracle).
        if (!agent || agent.owner_id !== user.id) {
          return c.json(
            {
              error: {
                code: "FORBIDDEN",
                message: `You can only scope a key to agents you own (${ref}).`,
              },
            },
            403,
          );
        }
        agentIds.push(agent.id);
      }
    }

    const { key, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name,
      scopes,
      scope_kind: scopeKind,
      agents: agentIds,
    });

    // Return the raw key only here — it cannot be retrieved again
    return c.json(
      {
        id: apiKey.id,
        key,
        name: apiKey.name,
        key_prefix: apiKey.key_prefix,
        scopes: apiKey.scopes,
        scope_kind: apiKey.scope_kind,
        agents: scopeKind === "agents" ? agentRefs : [],
        created_at: apiKey.created_at,
      },
      201,
    );
  });

  // GET /api/keys — list user's API keys (requires auth)
  router.get("/api/keys", authMiddleware, async (c) => {
    const user = getUser(c);
    const denied = requireMasterCredential(c);
    if (denied) return denied;
    const keys = await db.listApiKeys(user.id);

    return c.json(
      keys.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.key_prefix,
        scopes: k.scopes,
        scope_kind: k.scope_kind,
        last_used_at: k.last_used_at,
        created_at: k.created_at,
      })),
    );
  });

  // DELETE /api/keys/:id — revoke an API key (requires auth, must own the key)
  router.delete("/api/keys/:id", authMiddleware, async (c) => {
    const user = getUser(c);
    const denied = requireMasterCredential(c);
    if (denied) return denied;
    const keyId = c.req.param("id");

    const deleted = await db.deleteApiKeyByOwner(keyId, user.id);
    if (!deleted) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "API key not found or not owned by you" } },
        404,
      );
    }

    return c.body(null, 204);
  });

  return router;
}
