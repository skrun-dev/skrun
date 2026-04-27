import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { hashApiKey, isApiKeyFormat } from "../auth/api-key.js";
import { isOAuthConfigured } from "../auth/github-oauth.js";
import { SESSION_COOKIE_NAME, validateSession } from "../auth/session.js";
import type { DbAdapter } from "../db/adapter.js";
import type { UserContext } from "../types.js";

const USER_CONTEXT_KEY = "user";

/**
 * Create the auth middleware with DB access.
 *
 * Auth chain (checked in order):
 * 1. Session cookie → web auth (OAuth login)
 * 2. Bearer sk_live_* → API key (programmatic)
 * 3. Bearer dev-token → dev mode (only when OAuth is NOT configured)
 * 4. Otherwise → 401
 */
export function createAuthMiddleware(db: DbAdapter): MiddlewareHandler {
  return async (c, next) => {
    // --- 1. Session cookie ---
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) {
      const userId = validateSession(sessionId);
      if (userId) {
        const user = await db.getUserById(userId);
        if (user) {
          const ctx: UserContext = {
            id: user.id,
            namespace: user.username,
            username: user.username,
            email: user.email || undefined,
            avatar_url: user.avatar_url || undefined,
            plan: user.plan || undefined,
          };
          c.set(USER_CONTEXT_KEY, ctx);
          return next();
        }
      }
      // Invalid/expired session cookie — fall through to other auth methods
    }

    // --- 2 & 3. Bearer token ---
    const header = c.req.header("Authorization");
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7).trim();

      if (!token) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Empty token" } }, 401);
      }

      // --- 2. API key (sk_live_*) ---
      if (isApiKeyFormat(token)) {
        const keyHash = hashApiKey(token);
        const apiKey = await db.getApiKeyByHash(keyHash);
        if (!apiKey) {
          return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401);
        }

        // Check expiry
        if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
          return c.json({ error: { code: "UNAUTHORIZED", message: "API key has expired" } }, 401);
        }

        const user = await db.getUserById(apiKey.user_id);
        if (!user) {
          return c.json(
            { error: { code: "UNAUTHORIZED", message: "API key owner not found" } },
            401,
          );
        }

        // Update last_used_at (non-blocking)
        db.updateApiKeyLastUsed(apiKey.id).catch(() => {});

        const ctx: UserContext = {
          id: user.id,
          namespace: user.username,
          username: user.username,
          email: user.email || undefined,
          avatar_url: user.avatar_url || undefined,
          plan: user.plan || undefined,
        };
        c.set(USER_CONTEXT_KEY, ctx);
        return next();
      }

      // --- 3. Dev-token fallback ---
      if (!isOAuthConfigured()) {
        // No OAuth configured → dev mode: derive namespace from token
        const namespace = token === "dev-token" ? "dev" : token.split("-")[0] || "user";
        const devId = createHash("sha256").update(token).digest("hex").slice(0, 16);

        // Ensure dev user exists in DB (needed for API key creation/lookup)
        const githubId = `dev-${devId}`;
        let devUser = await db.getUserByGithubId(githubId);
        if (!devUser) {
          try {
            devUser = await db.createUser({
              github_id: githubId,
              username: namespace,
            });
          } catch {
            // Race condition or DB error — use synthetic user
          }
        }

        const ctx: UserContext = {
          id: devUser?.id ?? devId,
          namespace,
          username: namespace,
        };
        c.set(USER_CONTEXT_KEY, ctx);
        return next();
      }

      // OAuth IS configured but token is not an API key → reject
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid authentication. Use an API key (sk_live_*) or sign in via OAuth.",
          },
        },
        401,
      );
    }

    // --- 4. No auth ---
    const oauthMode = isOAuthConfigured();
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: oauthMode
            ? "Authentication required. Sign in via OAuth or use an API key (sk_live_*)."
            : "Missing or invalid Authorization header. Use: Bearer <token>",
          oauth: oauthMode,
        },
      },
      401,
    );
  };
}

export function getUser(c: Context): UserContext {
  return c.get(USER_CONTEXT_KEY) as UserContext;
}
