import { apiReference } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { MemoryDb } from "./db/memory.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { getOpenAPISchema } from "./openapi.js";
import { createFilesRoutes } from "./routes/files.js";
import { createRegistryRoutes } from "./routes/registry.js";
import { createRunRoutes } from "./routes/run.js";
import { RegistryService } from "./services/registry.js";
import type { StorageAdapter } from "./storage/adapter.js";

export function createApp(storage: StorageAdapter, db: MemoryDb) {
  const app = new Hono();
  const service = new RegistryService(storage, db);

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

  app.route("/api", createRegistryRoutes(service));
  app.route("/api", createRunRoutes(service));
  app.route("/api", createFilesRoutes());

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
export { MemoryDb } from "./db/memory.js";
export { RegistryService, RegistryError } from "./services/registry.js";
