import { serveStatic } from "@hono/node-server/serve-static";
import { apiReference } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { DbAdapter } from "./db/adapter.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { getOpenAPISchema } from "./openapi.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createFilesRoutes } from "./routes/files.js";
import { createRegistryRoutes } from "./routes/registry.js";
import { createRunRoutes } from "./routes/run.js";
import { createScanRoutes } from "./routes/scan.js";
import { createStatsRoutes } from "./routes/stats.js";
import { RegistryService } from "./services/registry.js";
import type { StorageAdapter } from "./storage/adapter.js";

export function createApp(storage: StorageAdapter, db: DbAdapter) {
  const app = new Hono();
  const service = new RegistryService(storage, db);
  const authMiddleware = createAuthMiddleware(db);

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

  // Rate limiting — 60 requests per minute per IP on mutating endpoints
  app.use("/api/agents/*/push", rateLimiter({ windowMs: 60_000, max: 10 }));
  app.use("/api/agents/*/run", rateLimiter({ windowMs: 60_000, max: 60 }));

  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI schema + interactive docs
  app.get("/openapi.json", (c) => {
    const baseUrl = new URL(c.req.url).origin;
    return c.json(getOpenAPISchema(baseUrl));
  });
  app.get(
    "/docs",
    apiReference({
      url: "/openapi.json",
      pageTitle: "Skrun API — Interactive Docs",
    }),
  );

  // Legacy playground redirect → dashboard
  app.get("/playground", (c) => c.redirect("/dashboard/agents"));
  app.get("/playground/*", (c) => c.redirect("/dashboard/agents"));

  app.route("", createAuthRoutes(db, authMiddleware));
  app.route("/api", createScanRoutes(db, authMiddleware, service));
  app.route("/api", createStatsRoutes(db, authMiddleware));
  app.route("/api", createRegistryRoutes(service, authMiddleware, db));
  app.route("/api", createRunRoutes(service, db, authMiddleware));
  app.route("/api", createFilesRoutes(db, authMiddleware));

  // Dashboard static files (served from packages/web/dist/)
  app.use(
    "/dashboard/*",
    serveStatic({
      root: "../web/dist",
      rewriteRequestPath: (path) => path.replace("/dashboard", ""),
    }),
  );
  app.get(
    "/dashboard/*",
    serveStatic({ root: "../web/dist", rewriteRequestPath: () => "/index.html" }),
  );

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
