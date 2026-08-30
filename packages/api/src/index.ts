import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { apiReference } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { isDevAuthEnabled } from "./auth/dev-auth.js";
import { isOAuthConfigured } from "./auth/github-oauth.js";
import { resolveDashboardConfig, warnDashboardDirMissing } from "./dashboard.js";
import type { DbAdapter } from "./db/adapter.js";
import { createAuthMiddleware } from "./middleware/auth.js";
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
import { externalBaseUrl } from "./utils/external-url.js";

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
  //   - CSP is scoped to `/dashboard/*` below (the only HTML surface that
  //     accepts user interaction). API JSON responses + `/docs` (Scalar,
  //     external CDN-loaded JS) are intentionally left without CSP.
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
  const makeRateLimiter = createRateLimiterFactory();
  app.use("/api/agents/*/push", rateLimiter({ windowMs: 60_000, max: 10, make: makeRateLimiter }));
  app.use("/api/agents/*/run", rateLimiter({ windowMs: 60_000, max: 60, make: makeRateLimiter }));
  // Device-login endpoints — per-IP. The poll is hit frequently by design
  // (interval ~5s) so a generous cap; the consent page + code mint get a tighter
  // one. Covers all of /auth/device/* plus the /device consent page.
  app.use("/auth/device/*", rateLimiter({ windowMs: 60_000, max: 120, make: makeRateLimiter }));
  app.use("/device", rateLimiter({ windowMs: 60_000, max: 30, make: makeRateLimiter }));

  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI schema + interactive docs
  app.get("/openapi.json", (c) => {
    const baseUrl = externalBaseUrl(c);
    return c.json(getOpenAPISchema(baseUrl));
  });
  app.get(
    "/docs",
    apiReference({
      url: "/openapi.json",
      pageTitle: "Skrun API — Interactive Docs",
    }),
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
