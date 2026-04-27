import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { generateApiKey } from "../auth/api-key.js";
import {
  exchangeCodeForToken,
  fetchGithubUser,
  getGithubAuthUrl,
  isOAuthConfigured,
} from "../auth/github-oauth.js";
import {
  SESSION_COOKIE_NAME,
  createSession,
  destroySession,
  getSessionCookieOptions,
} from "../auth/session.js";
import type { DbAdapter } from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";

const OAUTH_STATE_COOKIE = "skrun_oauth_state";
const CLI_CALLBACK_COOKIE = "skrun_cli_callback";

export function createAuthRoutes(db: DbAdapter, authMiddleware: MiddlewareHandler): Hono {
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

    // biome-ignore lint/style/noNonNullAssertion: checked by isOAuthConfigured()
    const clientId = process.env.GITHUB_CLIENT_ID!;
    const baseUrl = new URL(c.req.url).origin;
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

    // CLI callback: if provided, store it so the callback can redirect to the CLI local server
    const cliCallback = c.req.query("cli_callback");
    if (cliCallback) {
      setCookie(c, CLI_CALLBACK_COOKIE, encodeURIComponent(cliCallback), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Lax",
        path: "/",
        maxAge: 300,
      });
    }

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

      // Check if this is a CLI login flow
      const rawCliCallback = getCookie(c, CLI_CALLBACK_COOKIE);
      const cliCallback = rawCliCallback ? decodeURIComponent(rawCliCallback) : undefined;
      if (cliCallback) {
        // CLI flow: auto-create API key and redirect to CLI local server
        setCookie(c, CLI_CALLBACK_COOKIE, "", { maxAge: 0, path: "/" });
        const { key, keyHash, keyPrefix } = generateApiKey();
        await db.createApiKey({
          user_id: user.id,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: "CLI login",
        });
        const callbackUrl = new URL(cliCallback);
        callbackUrl.searchParams.set("token", key);
        callbackUrl.searchParams.set("username", user.username);
        return c.redirect(callbackUrl.toString());
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

  // ==================== Login Page ====================

  // GET /login — login page matching dashboard design system
  router.get("/login", (c) => {
    const oauthEnabled = isOAuthConfigured();
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
    <img src="/dashboard/logo.png" alt="Skrun" class="logo" />
    <h1>Skrun</h1>
    <p class="subtitle">Deploy any Agent Skill as an API</p>
    ${
      oauthEnabled
        ? `<a href="/auth/github" class="btn btn-github">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            Sign in with GitHub
          </a>`
        : '<p class="note">OAuth is not configured on this instance.<br>Use <code>Bearer dev-token</code> for local development.</p>'
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
    });
  });

  // ==================== API Keys CRUD ====================

  // POST /api/keys — create new API key (requires auth)
  router.post("/api/keys", authMiddleware, async (c) => {
    const user = getUser(c);

    let body: { name?: string; scopes?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }

    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "name is required" } }, 400);
    }

    const { key, keyHash, keyPrefix } = generateApiKey();
    const scopes = body.scopes ?? ["agent:push", "agent:run", "agent:verify"];

    const apiKey = await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name,
      scopes,
    });

    // Return the raw key only here — it cannot be retrieved again
    return c.json(
      {
        id: apiKey.id,
        key,
        name: apiKey.name,
        key_prefix: apiKey.key_prefix,
        scopes: apiKey.scopes,
        created_at: apiKey.created_at,
      },
      201,
    );
  });

  // GET /api/keys — list user's API keys (requires auth)
  router.get("/api/keys", authMiddleware, async (c) => {
    const user = getUser(c);
    const keys = await db.listApiKeys(user.id);

    return c.json(
      keys.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.key_prefix,
        scopes: k.scopes,
        last_used_at: k.last_used_at,
        created_at: k.created_at,
      })),
    );
  });

  // DELETE /api/keys/:id — revoke an API key (requires auth, must own the key)
  router.delete("/api/keys/:id", authMiddleware, async (c) => {
    const user = getUser(c);
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
