import { createHash } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  API_KEY_PREFIX,
  hashApiKey,
  isApiKeyFormat,
  RETIRED_API_KEY_PREFIX,
} from "../auth/api-key.js";
import { isDevAuthEnabled } from "../auth/dev-auth.js";
import { isOAuthConfigured } from "../auth/github-oauth.js";
import { sessionCookieErasures, sessionCookieName, validateSession } from "../auth/session.js";
import type { DbAdapter } from "../db/adapter.js";
import type { UserContext } from "../types.js";
import { errorFields } from "../utils/error-fields.js";

const logger = createLogger("auth-middleware");
const USER_CONTEXT_KEY = "user";

/**
 * How many times a cookie NAME appears in a raw `Cookie` header.
 *
 * The raw header is the only place this is visible: a cookie parser hands back a
 * map, so the second value of a duplicated name is already gone by the time
 * anything can notice it existed.
 */
function countCookieOccurrences(rawHeader: string | null, name: string): number {
  if (!rawHeader) return 0;
  let count = 0;
  for (const pair of rawHeader.split(";")) {
    const eq = pair.indexOf("=");
    const key = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    if (key === name) count++;
  }
  return count;
}

/**
 * Whether `token` starts with `prefix`, ignoring letter case: a key typed or
 * copied in another case is still a key, never a dev token.
 */
function startsWithPrefix(token: string, prefix: string): boolean {
  return token.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * Create the auth middleware with DB access.
 *
 * Auth chain (checked in order):
 * 0. A `__Secure-` session cookie sent more than once → no cookie auth at all (see below)
 * 1. Session cookie → web auth (OAuth login)
 * 2. Bearer starting with the key prefix (`API_KEY_PREFIX`), in any letter case
 *    → API key (programmatic): a well-formed key (length, alphabet, checksum —
 *    the prefix in its own case) is looked up by hash; a malformed one → 401
 *    "Invalid API key" without a database read
 * 2b. Bearer starting with the retired key prefix (`RETIRED_API_KEY_PREFIX`), in
 *    any letter case → 401 "Invalid API key", without a database read, whatever
 *    the mode
 * 3. Any other bearer → dev token (only when SKRUN_DEV_AUTH is on and OAuth is
 *    NOT configured). A key-shaped bearer never gets here: 2 and 2b answer first.
 * 4. Otherwise → 401
 */
export function createAuthMiddleware(db: DbAdapter): MiddlewareHandler {
  return async (c, next) => {
    // --- 0. A duplicated session cookie authenticates nobody ---
    //
    // A sibling host of a shared domain can write a cookie on the parent domain,
    // and the browser will then send TWO cookies of the same name. The parser
    // keeps the first, and which one is first is the browser's choice — longest
    // `Path` first, then creation order (RFC 6265 §5.4) — so the attacker needs
    // no race: a narrower `Path` always goes first, and the victim browses,
    // signed in, inside the attacker's account, depositing there what they
    // believe they are depositing at home. Nothing about that is visible from a
    // parsed cookie map: the second value is gone before any code can see it.
    // Hence the raw header.
    //
    // What this catches is the DUPLICATE. A cookie planted in a browser that
    // carries none is indistinguishable from a legitimate sign-in and is not
    // detected here; that case is bounded only by the zone rule — no host under
    // the shared domain that we do not operate.
    //
    // THE REFUSAL IS THE CONTROL; THE ERASURE IS A SERVICE. A cookie planted on a
    // narrower Path is not reachable by any Set-Cookie we can write, and it stays
    // refused on every request — which is the outcome that matters. Reading the
    // erasure as the protection would be reading the courtesy as the lock.
    //
    // Only under `__Secure-`, and that condition is load-bearing: without a prefix
    // a duplicate is LEGITIMATE during the transition, since the old host-only
    // cookie and the new domain-scoped one carry the same name. Under the prefix
    // the two names differ by construction, so a duplicate is planted — or left
    // by a change of the configured domain between two valid parents of the host
    // (the boot check accepts either), the one case this refusal cannot tell
    // apart: the old-scope cookie cannot be erased from here, so cookie sign-in
    // stays refused until it expires or the user clears it. Documented for
    // operators next to the variable.
    //
    // `__Secure-` and not `__Host-`, on purpose. A browser identifies a cookie by
    // name, host and path; `__Host-` fixes the host (no `Domain`) and the path
    // (`/`), so a conforming browser holds at most one cookie of that name for
    // this host and can never send it twice. A duplicate of it can only come from
    // a client writing its own header, and there is no victim to protect there.
    // Extending the check to it would add a guard no real scenario can trip.
    const cookieName = sessionCookieName();
    const duplicated =
      cookieName.startsWith("__Secure-") &&
      countCookieOccurrences(c.req.raw.headers.get("Cookie"), cookieName) > 1;

    if (duplicated) {
      // The name, never a value: one of these two is a credential.
      logger.warn(
        { event: "session_cookie_duplicate", cookie: cookieName },
        "Session cookie sent more than once — refusing cookie authentication for this request",
      );
      // The one erasure factory, so a prefixed name always carries the `secure`
      // flag hono requires; a hand-written variant here would answer 500 in the
      // very configuration this code only runs in.
      for (const { name, options } of sessionCookieErasures()) {
        setCookie(c, name, "", options);
      }
    }

    // --- 1. Session cookie ---
    const sessionId = duplicated ? undefined : getCookie(c, cookieName);
    if (sessionId) {
      let userId: string | null;
      try {
        userId = await validateSession(db, sessionId);
      } catch (err) {
        // A database failure is NOT an absent session. Treating it as one would
        // log every signed-in user out in silence the day the sessions table is
        // missing — a fault whose only symptom is behaviour that looks correct.
        // A bare throw is not enough either: the app's error handler would log it
        // as an unhandled error under this middleware's route pattern and answer
        // a bare text 500 — neither says "the session store is down", which is
        // what this event name and this JSON answer tell apart from "nobody is
        // signed in".
        logger.error(
          { event: "session_lookup_failed", ...errorFields(err) },
          "Session lookup failed",
        );
        return c.json({ error: { code: "INTERNAL_ERROR", message: "Session lookup failed" } }, 500);
      }
      if (userId) {
        // Outside the try on purpose: this call already propagates its errors
        // and must keep doing so. Widening the block would change the behaviour
        // of a path this element does not own.
        const user = await db.getUserById(userId);
        if (user) {
          const ctx: UserContext = {
            id: user.id,
            namespace: user.username,
            username: user.username,
            email: user.email || undefined,
            avatar_url: user.avatar_url || undefined,
            plan: user.plan || undefined,
            role: user.role,
            // Session cookie = master credential (no key restriction).
            key: null,
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

      // --- 2. API key: a bearer that starts with the key prefix, in any case ---
      if (startsWithPrefix(token, API_KEY_PREFIX)) {
        // Malformed (length, alphabet, checksum, the prefix in another case):
        // no key can match, so no read.
        if (!isApiKeyFormat(token)) {
          return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401);
        }
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
        db.updateApiKeyLastUsed(apiKey.id).catch((err) =>
          logger.warn(
            { event: "last_used_update_failed", ...errorFields(err) },
            "Best-effort API-key last_used update failed (non-blocking)",
          ),
        );

        // Load agent grants only for resource-scoped keys — account-wide keys
        // (the common case) skip the extra query.
        const agentIds =
          apiKey.scope_kind === "agents" ? await db.getApiKeyAgentIds(apiKey.id) : [];

        const ctx: UserContext = {
          id: user.id,
          namespace: user.username,
          username: user.username,
          email: user.email || undefined,
          avatar_url: user.avatar_url || undefined,
          plan: user.plan || undefined,
          role: user.role,
          key: {
            id: apiKey.id,
            scope_kind: apiKey.scope_kind,
            operations: apiKey.scopes,
            agent_ids: agentIds,
          },
        };
        c.set(USER_CONTEXT_KEY, ctx);
        return next();
      }

      // --- 2b. A key of the retired format: refused like any invalid key, in
      // both modes and any letter case, before the dev-token fallback could
      // make it an account ---
      if (startsWithPrefix(token, RETIRED_API_KEY_PREFIX)) {
        return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401);
      }

      // --- 3. Dev-token fallback (fail-secure: explicit opt-in via SKRUN_DEV_AUTH) ---
      if (isDevAuthEnabled() && !isOAuthConfigured()) {
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

        // dev-token only fires when OAuth is NOT configured (self-host
        // single-user mode), so the caller IS the instance operator and
        // gets admin role unconditionally. This preserves the local-dev UX
        // for admin-gated routes (per-version verify, DELETE override).
        const ctx: UserContext = {
          id: devUser?.id ?? devId,
          namespace,
          username: namespace,
          role: "admin",
          // dev-token = master credential (self-host operator).
          key: null,
          // No users row behind the id: mark it, rather than let a reader guess
          // from the id's shape.
          ...(devUser ? {} : { syntheticAccount: true as const }),
        };
        c.set(USER_CONTEXT_KEY, ctx);
        return next();
      }

      // OAuth IS configured but token is not an API key → reject
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Invalid authentication. Use an API key (${API_KEY_PREFIX}*) or sign in via OAuth.`,
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
            ? `Authentication required. Sign in via OAuth or use an API key (${API_KEY_PREFIX}*).`
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
