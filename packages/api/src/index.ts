import { serveStatic } from "@hono/node-server/serve-static";
import { apiReference } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
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

  // CORS — configurable origins (default: all for dev, restrict via CORS_ORIGIN in production)
  app.use("*", cors({ origin: process.env.CORS_ORIGIN ?? "*" }));

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
  app.route("/api", createRegistryRoutes(service, authMiddleware));
  app.route("/api", createRunRoutes(service, db, authMiddleware));
  app.route("/api", createFilesRoutes());

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

export type {
  AgentMetadata,
  AgentVersionInfo,
  RegistryErrorResponse,
  UserContext,
} from "./types.js";
export type { StorageAdapter } from "./storage/adapter.js";
export { MemoryStorage } from "./storage/memory.js";
export { LocalStorage } from "./storage/local.js";
export type { DbAdapter } from "./db/adapter.js";
export { MemoryDb } from "./db/memory.js";
export { SqliteDb } from "./db/sqlite.js";
export { RegistryService, RegistryError } from "./services/registry.js";
