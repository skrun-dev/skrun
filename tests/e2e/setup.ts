/**
 * Shared E2E test setup — creates a fresh Hono app with in-memory storage for each test suite.
 * Tests use the Hono test client (no network, no real LLM, fast).
 */
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import { RegistryService } from "../../packages/api/src/services/registry.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";

export function createTestApp() {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);
  const service = new RegistryService(storage, db);
  return { app, storage, db, service };
}

export const DEV_TOKEN = "dev-token";
export const PROD_TOKEN = "prod-user-token";

export const devAuth = { Authorization: `Bearer ${DEV_TOKEN}` };
export const prodAuth = { Authorization: `Bearer ${PROD_TOKEN}` };

/** Push a fake agent bundle to the registry */
export async function pushAgent(
  app: ReturnType<typeof createApp>,
  opts: { ns?: string; name?: string; version?: string; token?: string } = {},
) {
  const { ns = "dev", name = "test-agent", version = "1.0.0", token = DEV_TOKEN } = opts;
  const bundle = Buffer.from("fake-agent-bundle");
  return app.request(`/api/agents/${ns}/${name}/push?version=${version}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: bundle,
  });
}

/** Call POST /run on an agent */
export async function runAgent(
  app: ReturnType<typeof createApp>,
  opts: {
    ns?: string;
    name?: string;
    input?: Record<string, unknown>;
    token?: string;
    llmKeyHeader?: string;
  } = {},
) {
  const { ns = "dev", name = "test-agent", input = {}, token = DEV_TOKEN, llmKeyHeader } = opts;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (llmKeyHeader) {
    headers["X-LLM-API-Key"] = llmKeyHeader;
  }
  return app.request(`/api/agents/${ns}/${name}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });
}

/** Set verification flag on an agent */
export async function verifyAgent(
  app: ReturnType<typeof createApp>,
  opts: { ns?: string; name?: string; verified?: boolean; token?: string } = {},
) {
  const { ns = "dev", name = "test-agent", verified = true, token = DEV_TOKEN } = opts;
  return app.request(`/api/agents/${ns}/${name}/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified }),
  });
}
