import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { serveStatic } from "@hono/node-server/serve-static";
import { createLogger } from "@skrun-dev/runtime";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getDomain } from "tldts";
import { isDevAuthEnabled } from "./auth/dev-auth.js";
import { isOAuthConfigured } from "./auth/github-oauth.js";
import { sessionCookieDomain } from "./auth/session.js";
import { resolveDashboardConfig, warnDashboardDirMissing } from "./dashboard.js";
import type { DbAdapter } from "./db/adapter.js";
import { renderDocsPage, SCALAR_BUNDLE_URL } from "./docs-page.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createCsrfGuard } from "./middleware/csrf.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { getOpenAPISchema } from "./openapi.js";
import { createRateLimiterFactory } from "./ratelimit/select.js";
import { createAdminPoolRoutes } from "./routes/admin-pool.js";
import { createAgentLlmKeyRoutes } from "./routes/agent-llm-keys.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createFilesRoutes } from "./routes/files.js";
import { createRegistryRoutes } from "./routes/registry.js";
import { createRunRoutes } from "./routes/run.js";
import { createScanRoutes } from "./routes/scan.js";
import { createStatsRoutes } from "./routes/stats.js";
import {
  buildFlyioDeps,
  type FlyioRuntimeDeps,
  selectRuntimeMode,
} from "./runtime/adapter-selection.js";
import { RegistryService } from "./services/registry.js";
import { getKeyProvider } from "./services/secrets/key-provider.js";
import { readVerificationPolicy, type VerificationPolicy } from "./services/verification-policy.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { externalBaseUrl, parsePublicUrl } from "./utils/external-url.js";

// "startup" and not "api": run.ts:48 already holds "api", and two modules logging
// under one name make the filter useless for whoever is reading a boot log.
const startupLogger = createLogger("startup");

export function createApp(
  storage: StorageAdapter,
  db: DbAdapter,
  opts: {
    verificationPolicy?: VerificationPolicy;
    /**
     * Cloud-runtime dependencies. Normally built from the environment; injected
     * only by tests, which cannot let `buildFlyioDeps` read real credentials.
     */
    flyioDeps?: FlyioRuntimeDeps;
  } = {},
) {
  const app = new Hono();
  const service = new RegistryService(storage, db);
  const authMiddleware = createAuthMiddleware(db);

  // Runtime adapter selection — chosen once at startup and threaded into
  // the run routes. SKRUN_RUNTIME=flyio fails fast here if the cloud creds
  // are missing, so a misconfigured server cannot start and silently
  // mis-execute runs against the wrong backend.
  const runtimeMode = selectRuntimeMode();
  const flyioDeps = opts.flyioDeps ?? (runtimeMode === "flyio" ? buildFlyioDeps() : undefined);
  // Start the pre-warm pool's background maintenance. It is deliberately started
  // here rather than inside the pool's constructor: this is the one place that
  // knows a server is actually being run (tests build apps too), and a pool that
  // is never started is silent — every run just takes the cold path, which is
  // correct behaviour and so reports nothing. No-op when the pool is disabled,
  // which is the default.
  flyioDeps?.pool?.start();

  // Verification policy — resolved once at startup. An invalid value throws
  // here (fail-fast, like SKRUN_RUNTIME / SKRUN_DEV_AUTH) so a typo can't run
  // the server with an undefined gate. Tests pass an explicit override to skip
  // the env read.
  const verificationPolicy = opts.verificationPolicy ?? readVerificationPolicy();

  // Secrets encryption provider for creator-attached LLM keys — built once at
  // startup. getKeyProvider() throws HERE if SKRUN_SECRETS_ENCRYPTION_KEY is set
  // but malformed (fail-fast boot interlock, like SKRUN_RUNTIME above); unset =
  // unconfigured (creator-key attach is then refused, fail-closed).
  const keyProvider = getKeyProvider();

  // Session-cookie handoff — the two operator settings, resolved and validated ONCE
  // here, in the same fail-fast form as the four interlocks above.
  //
  // Why a boot interlock and not a request-time check: a cookie the browser refuses
  // produces NO error. Nothing throws, nothing 500s — the user simply is not logged
  // in, and on a mistyped shared domain the symptom is "I get signed out when I move
  // between hosts", weeks later, with no trace. This block is the only thing that
  // turns that silence into a message, so it must run on the path that cannot be
  // skipped: createApp is both the server's startup and what every test builds.
  //
  // The five rules are ONE guard and ship together — shipping a subset would let
  // through exactly the value the missing rule refuses. Their ORDER is chosen: it
  // decides which message an operator reads first, and the most useful one is
  // always the one naming the thing they can fix.
  const publicUrlRaw = process.env.SKRUN_PUBLIC_URL?.trim();
  // (1) Format. Throws by itself, naming the value and the expected shape.
  const canonicalUrl = publicUrlRaw ? parsePublicUrl(publicUrlRaw) : undefined;
  const canonicalOrigin = canonicalUrl?.origin;

  // Read and normalised by session.ts — the module that actually puts the value on
  // the cookie. Validating anything else here would mean validating a string the
  // cookie never uses: two normalisations that differ by a trim would let this
  // interlock approve a domain the browser then never sees. One normalisation, two
  // readers. (A leading dot is dropped there, as the cookie spec ignores it.)
  const cookieDomain = sessionCookieDomain();

  if (cookieDomain) {
    // (2) A domain with nothing to compare it against. The only other source for the
    // canonical host would be the `Host` header — i.e. the caller — so we refuse
    // rather than validate a domain against a value an attacker supplies.
    if (!canonicalUrl) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN is set to "${cookieDomain}" but SKRUN_PUBLIC_URL is not set. ` +
          "The cookie domain is validated against the canonical public host, so that host must be " +
          "configured — deriving it from the Host header would mean validating against the caller. " +
          "Set SKRUN_PUBLIC_URL (e.g. https://api.example.com).",
      );
    }
    // `new URL("https://[::1]").hostname` keeps the brackets; isIP() does not want them.
    const canonicalHost = canonicalUrl.hostname.replace(/^\[/, "").replace(/\]$/, "");

    // (3) A literal IP host. `Domain` has no meaning on an IP (RFC 6265 §5.1.3) and
    // browsers disagree about what to do with it. Note the boundary: an IP host with
    // NO domain configured boots fine and gets a host-only cookie — it is the domain
    // that is refused here, never the URL.
    if (isIP(canonicalHost) !== 0) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN is set to "${cookieDomain}" but the canonical host ` +
          `"${canonicalHost}" (from SKRUN_PUBLIC_URL) is a literal IP address. A cookie Domain ` +
          "attribute has no meaning on an IP address. Use a hostname, or unset " +
          "SKRUN_SESSION_COOKIE_DOMAIN to keep a host-only cookie.",
      );
    }
    // (4a) At least one dot. Catches `localhost` and other single-label values, which
    // a browser will not accept as a cookie domain.
    if (!cookieDomain.includes(".")) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN must contain at least one dot (got "${cookieDomain}"). ` +
          "A single-label domain is not a valid cookie domain — use e.g. example.com.",
      );
    }
    // (4b) A suffix at a LABEL boundary of the canonical host. A bare endsWith would
    // accept "ample.com" for host "api.example.com", which is a different domain.
    if (canonicalHost !== cookieDomain && !canonicalHost.endsWith(`.${cookieDomain}`)) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN "${cookieDomain}" is not a suffix of the canonical host ` +
          `"${canonicalHost}" (from SKRUN_PUBLIC_URL). A browser silently drops a cookie whose ` +
          "Domain the sending host does not belong to. Expected the canonical host to be the " +
          `domain itself or one of its subdomains (e.g. api.${cookieDomain}).`,
      );
    }
    // (5) Not a public suffix. This is the rule no structural check reaches: "co.uk"
    // IS a label-boundary suffix of "api.example.co.uk", and every browser refuses a
    // cookie scoped to it. `allowPrivateDomains` is load-bearing and measured, not a
    // default copied over: without it getDomain("fly.dev") returns "fly.dev", so a
    // platform subdomain like *.fly.dev — which a browser treats exactly like a
    // public suffix — would be accepted here and then silently dropped there.
    if (getDomain(cookieDomain, { allowPrivateDomains: true }) === null) {
      throw new Error(
        `SKRUN_SESSION_COOKIE_DOMAIN "${cookieDomain}" is a public suffix — no registrable domain ` +
          "sits under it. Browsers refuse a cookie scoped to a public suffix, so the session " +
          "would silently never be sent. Use the registrable domain you own (e.g. example.co.uk, " +
          "not co.uk).",
      );
    }

    // Boot accepted, and the retained domain is named. Without this line a session
    // broken by a domain the browser quietly rejects leaves no trace at all.
    startupLogger.info(
      { event: "session_cookie_domain", domain: cookieDomain, canonical_origin: canonicalOrigin },
      `Session cookie scoped to domain "${cookieDomain}" (canonical origin ${canonicalOrigin})`,
    );
  }

  // Dashboard (packages/web SPA) — served at /dashboard/* in api-server mode.
  // Gated by SKRUN_DASHBOARD (default on); root resolved from SKRUN_DASHBOARD_DIR
  // (absolute in the published image; cwd-relative "../web/dist" in dev).
  const dashboard = resolveDashboardConfig();
  const serveDashboard = dashboard.enabled && existsSync(dashboard.dir);
  if (dashboard.enabled && !serveDashboard) {
    warnDashboardDirMissing(dashboard.dir);
  }

  // Security headers — applied BEFORE CORS so they are present on every
  // response including CORS preflight.
  //   - X-Frame-Options: DENY (clickjacking defense; tighter than Hono default SAMEORIGIN)
  //   - HSTS: 2 years + preload (Cloudflare / browser-preload-list grade)
  //   - Cross-Origin-Resource-Policy: cross-origin so the dashboard can load
  //     /api/files/:id/content from a different host (cloud deployment).
  //   - CSP is scoped to the two HTML surfaces below: `/dashboard/*` (the SPA)
  //     and `/docs` (the API docs page, which loads one pinned third-party
  //     bundle). API JSON responses are intentionally left without CSP.
  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      crossOriginResourcePolicy: "cross-origin",
    }),
  );

  // CSP scoped to `/dashboard/*` — defense-in-depth against XSS in the
  // bundled React SPA. Allows the SPA's own bundle (script-src 'self') and
  // its CSS (style-src 'self'), plus 'unsafe-inline' for the rare React
  // inline-style prop (DOM-level style attribute — minor XSS risk via
  // injected style is acceptable trade-off vs the script-src protection).
  // Same-origin only for fetch / images / fonts / form actions.
  if (dashboard.enabled) {
    app.use(
      "/dashboard/*",
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
        },
      }),
    );
  }

  // CSP on `/docs` — the page itself is ours and carries no inline script; the
  // renderer is Scalar's browser bundle, the ONE remote script this policy allows,
  // by exact URL (version-pinned; `docs-page.ts` also pins its integrity hash).
  // `connect-src 'self'` keeps every "Try it" request — and the API key typed into
  // it — on this origin: Scalar's default relay through proxy.scalar.com cannot be
  // reached even if its configuration were changed. A bare CDN URL put back in the
  // page would be blocked here and the page would blank — visibly.
  app.use(
    "/docs",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", SCALAR_BUNDLE_URL],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    }),
  );

  // CORS — production-safe by default.
  //   - production: CORS_ORIGIN is REQUIRED (fail loud at startup if unset),
  //     no '*' wildcard allowed (per the CORS spec, '*' cannot be paired with
  //     credentials anyway).
  //   - dev / test: falls back to '*' so local pnpm dev:registry + dashboard
  //     stay frictionless.
  const corsOriginEnv = process.env.CORS_ORIGIN;
  if (process.env.NODE_ENV === "production" && !corsOriginEnv) {
    throw new Error(
      "CORS_ORIGIN env var is required when NODE_ENV=production. " +
        "Set it to a comma-separated list of allowed origins (e.g. https://app.example.com). " +
        "See .env.example.",
    );
  }
  app.use("*", cors({ origin: corsOriginEnv ?? "*" }));

  // CSRF on every cookie-authenticated mutation — mounted right after CORS and
  // before the rate limiters, so it runs well ahead of the routers and of
  // authMiddleware. The guard depends on no authentication decision: it only
  // looks at the shape of the request.
  //
  // Mounted on `*` and not on a route list. The selectivity already lives in the
  // guard's own predicate (no session cookie, or an Authorization header, and it
  // steps aside), so widening the path costs nothing in false positives — while a
  // list like `/api/*` + `/auth/logout` is a thing a new route silently fails to
  // join. This repo has already shipped a middleware mounted on a pattern that
  // matched no real route; a mount that cannot go stale is worth more here than
  // one that looks narrow.
  //
  // `canonicalOrigin` is the value the startup interlock above already computed —
  // createApp does not read the environment a second time.
  //
  // The OPTIONS preflight never reaches this: cors() answers it and does not call
  // on. (csrf() treats OPTIONS as safe anyway.) That is asserted, not assumed.
  app.use("*", createCsrfGuard({ canonicalOrigin }));

  // Dev-auth fail-secure interlock. SKRUN_DEV_AUTH lets any `Bearer dev-token`
  // caller act as admin, so it must never run in an untrusted context without
  // OAuth. Allowlist (not `NODE_ENV === "production"`) so an unset/garbage
  // NODE_ENV is treated as untrusted → refuse to boot. Warn (dev only) when on.
  if (isDevAuthEnabled() && !isOAuthConfigured()) {
    const nodeEnv = process.env.NODE_ENV ?? "";
    if (nodeEnv !== "development" && nodeEnv !== "test") {
      throw new Error(
        "SKRUN_DEV_AUTH is enabled without OAuth outside development/test — anyone who " +
          "reaches this server would get admin. Configure GitHub OAuth, or only enable " +
          "SKRUN_DEV_AUTH on a trusted localhost/LAN dev host (NODE_ENV=development).",
      );
    }
    if (nodeEnv === "development") {
      console.warn(
        "[skrun] ⚠️  SKRUN_DEV_AUTH is ENABLED — any caller with `Bearer dev-token` is admin. " +
          "Use only on localhost / a trusted private network, never a public host.",
      );
    }
  }

  // Rate limiting — per-IP on mutating endpoints. The backend (in-memory for
  // self-host single-instance, Upstash Redis for multi-instance cloud)
  // is env-selected once here and shared across both routes.
  //
  // The mount patterns are the EXPLICIT route shapes, deliberately:
  // - A mid-path `*` in Hono matches exactly ONE segment, so `/api/agents/*/push`
  //   never matches the real two-segment route `/:namespace/:name/push` — the
  //   limiter would exist without ever running (measured on hono 4.13.5).
  // - A trailing star (`/api/agents/*`) would run, but it is anchored to nothing:
  //   it would drag read-only GETs and any future route under /api/agents/ into
  //   thresholds sized for writes.
  // These patterns also match `POST /api/agents/scan/:name/push` (`:namespace`
  // binds to the literal "scan") — intended: it is a push, same threshold. The
  // middleware is matched by path pattern, independently of router order
  // (measured: it runs with the scan router mounted before OR after the
  // registry router). What router order does decide is WHICH handler answers a
  // scan push — the registry router would swallow it if mounted first.
  // Each mount names its counter: on the shared store the name is the key
  // namespace; without it, every mount with the same window shares one counter.
  const makeRateLimiter = createRateLimiterFactory();
  app.use(
    "/api/agents/:namespace/:name/push",
    rateLimiter({ name: "push", windowMs: 60_000, max: 10, make: makeRateLimiter }),
  );
  app.use(
    "/api/agents/:namespace/:name/run",
    rateLimiter({ name: "run", windowMs: 60_000, max: 60, make: makeRateLimiter }),
  );
  // Push body cap — server-side, applied BEFORE the handler reads the body into
  // memory (registry.ts buffers with arrayBuffer()). This bounds the COMPRESSED
  // request body; the 50 MB decompression cap in utils/bundle.ts bounds the
  // EXPANDED archive and runs after buffering — they coexist, neither replaces
  // the other. Mounted after the rate limiter: the counter is the cheaper check.
  // Same pattern as the limiter, so the local-directory push path shares it.
  const pushMaxBodyMbRaw = process.env.SKRUN_PUSH_MAX_BODY_MB ?? "50";
  const pushMaxBodyMb = Number(pushMaxBodyMbRaw);
  if (!Number.isFinite(pushMaxBodyMb) || pushMaxBodyMb <= 0) {
    throw new Error(
      `SKRUN_PUSH_MAX_BODY_MB must be a positive number (got "${pushMaxBodyMbRaw}"). ` +
        "Unset it to use the 50 MB default.",
    );
  }
  app.use(
    "/api/agents/:namespace/:name/push",
    bodyLimit({
      maxSize: pushMaxBodyMb * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "BUNDLE_TOO_LARGE",
              message:
                `Bundle exceeds the ${pushMaxBodyMb} MB request-body cap (compressed). ` +
                "Set SKRUN_PUSH_MAX_BODY_MB to adjust.",
            },
          },
          413,
        ),
    }),
  );
  // Device-login endpoints — per-IP. The poll is hit frequently by design
  // (interval ~5s) so a generous cap; the consent page + code mint get a tighter
  // one. Covers all of /auth/device/* plus the /device consent page.
  app.use(
    "/auth/device/*",
    rateLimiter({ name: "device-auth", windowMs: 60_000, max: 120, make: makeRateLimiter }),
  );
  app.use(
    "/device",
    rateLimiter({ name: "device-consent", windowMs: 60_000, max: 30, make: makeRateLimiter }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI schema + interactive docs
  app.get("/openapi.json", (c) => {
    const baseUrl = externalBaseUrl(c);
    return c.json(getOpenAPISchema(baseUrl));
  });
  app.get("/docs", (c) =>
    c.html(renderDocsPage({ specUrl: "/openapi.json", pageTitle: "Skrun API — Interactive Docs" })),
  );

  // Legacy playground redirect → dashboard (only when the dashboard is served)
  if (dashboard.enabled) {
    app.get("/playground", (c) => c.redirect("/dashboard/agents"));
    app.get("/playground/*", (c) => c.redirect("/dashboard/agents"));
  }

  app.route("", createAuthRoutes(db, authMiddleware, verificationPolicy));
  app.route("/api", createScanRoutes(db, authMiddleware, service));
  app.route("/api", createStatsRoutes(db, authMiddleware));
  app.route("/api", createRegistryRoutes(service, authMiddleware, db, verificationPolicy));
  app.route("/api", createAgentLlmKeyRoutes(db, authMiddleware, keyProvider));
  app.route(
    "/api",
    createRunRoutes(service, db, authMiddleware, {
      runtimeMode,
      flyioDeps,
      verificationPolicy,
      keyProvider,
    }),
  );
  app.route("/api", createFilesRoutes(db, authMiddleware));
  // Operator-only view of the pre-warm pool. Its state is in-process memory,
  // so this route is the only way it reaches an operator.
  app.route("/api", createAdminPoolRoutes(authMiddleware, flyioDeps?.pool));

  // Dashboard static files (served from the configured SPA dir). Mounted only
  // when enabled AND the dir exists — handing serveStatic a missing root makes
  // @hono/node-server log its own error, so we guard + warn (above) instead.
  if (serveDashboard) {
    app.use(
      "/dashboard/*",
      serveStatic({
        root: dashboard.dir,
        rewriteRequestPath: (path) => path.replace("/dashboard", ""),
      }),
    );
    app.get(
      "/dashboard/*",
      serveStatic({ root: dashboard.dir, rewriteRequestPath: () => "/index.html" }),
    );
  }

  return app;
}

export type { DbAdapter } from "./db/adapter.js";
export { MemoryDb } from "./db/memory.js";
export { SqliteDb } from "./db/sqlite.js";
export { RegistryError, RegistryService } from "./services/registry.js";
export type { StorageAdapter } from "./storage/adapter.js";
export { LocalStorage } from "./storage/local.js";
export { MemoryStorage } from "./storage/memory.js";
export type {
  AgentMetadata,
  AgentVersionInfo,
  RegistryErrorResponse,
  UserContext,
} from "./types.js";
