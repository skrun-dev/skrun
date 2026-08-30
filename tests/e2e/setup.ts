/**
 * Shared E2E test setup — creates a fresh Hono app with in-memory storage for each test suite.
 * Tests use the Hono test client (no network, no real LLM, fast).
 */
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import { RegistryService } from "../../packages/api/src/services/registry.js";
import type { VerificationPolicy } from "../../packages/api/src/services/verification-policy.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";

// The Level-2 e2e suite (vitest.config.e2e.ts) has no setupFiles, so enable the
// dev-token admin shortcut here — every e2e file sends DEV_TOKEN via this helper.
// Vitest sets NODE_ENV=test (allowlisted) so the createApp dev-auth interlock won't trip.
process.env.SKRUN_DEV_AUTH ??= "1";

export function createTestApp(opts: { verificationPolicy?: VerificationPolicy } = {}) {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db, { verificationPolicy: opts.verificationPolicy });
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
    /** Raw X-LLM-Base-URL value — the caller's declaration of where their key belongs. */
    llmBaseUrlHeader?: string;
  } = {},
) {
  const {
    ns = "dev",
    name = "test-agent",
    input = {},
    token = DEV_TOKEN,
    llmKeyHeader,
    llmBaseUrlHeader,
  } = opts;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (llmKeyHeader) {
    headers["X-LLM-API-Key"] = llmKeyHeader;
  }
  if (llmBaseUrlHeader) {
    headers["X-LLM-Base-URL"] = llmBaseUrlHeader;
  }
  return app.request(`/api/agents/${ns}/${name}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });
}

/** Call POST /run with Accept: text/event-stream and parse SSE events */
export async function runAgentSSE(
  app: ReturnType<typeof createApp>,
  opts: {
    ns?: string;
    name?: string;
    input?: Record<string, unknown>;
    token?: string;
    llmKeyHeader?: string;
    webhookUrl?: string;
  } = {},
) {
  const {
    ns = "dev",
    name = "test-agent",
    input = {},
    token = DEV_TOKEN,
    llmKeyHeader,
    webhookUrl,
  } = opts;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (llmKeyHeader) {
    headers["X-LLM-API-Key"] = llmKeyHeader;
  }
  const body: Record<string, unknown> = { input };
  if (webhookUrl) {
    body.webhook_url = webhookUrl;
  }
  const res = await app.request(`/api/agents/${ns}/${name}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res;
}

/** Call POST /run with webhook_url in body */
export async function runAgentWebhook(
  app: ReturnType<typeof createApp>,
  opts: {
    ns?: string;
    name?: string;
    input?: Record<string, unknown>;
    token?: string;
    webhookUrl: string;
    llmKeyHeader?: string;
  },
) {
  const {
    ns = "dev",
    name = "test-agent",
    input = {},
    token = DEV_TOKEN,
    webhookUrl,
    llmKeyHeader,
  } = opts;
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
    body: JSON.stringify({ input, webhook_url: webhookUrl }),
  });
}

/** Parse SSE response text into array of events */
export function parseSSEEvents(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let eventName = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventName = line.slice(7);
      if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    if (eventName && dataStr) {
      try {
        events.push({ event: eventName, data: JSON.parse(dataStr) });
      } catch {
        // Skip malformed events
      }
    }
  }
  return events;
}

/**
 * Set verification flag on a specific version of an agent. Per-version
 * verification (#83) replaces the legacy per-agent flag. dev-token is auto-
 * admin (audit/001 SEC-005 part B) so this call passes the admin gate.
 */
export async function verifyVersion(
  app: ReturnType<typeof createApp>,
  opts: {
    ns?: string;
    name?: string;
    version?: string;
    verified?: boolean;
    token?: string;
  } = {},
) {
  const {
    ns = "dev",
    name = "test-agent",
    version = "1.0.0",
    verified = true,
    token = DEV_TOKEN,
  } = opts;
  return app.request(`/api/agents/${ns}/${name}/versions/${version}/verify`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verified }),
  });
}

/**
 * Create a non-admin user + a usable sk_live key. The dev/prod test tokens all
 * resolve to admin in dev-mode, so run-authorization tests that need a real
 * non-owner caller mint a key this way (the sk_live path runs before the
 * dev-token fallback).
 */
export async function seedUserKey(
  db: MemoryDb,
  username: string,
): Promise<{ id: string; key: string }> {
  const user = await db.createUser({ github_id: `gh-${username}`, username });
  const k = generateApiKey();
  await db.createApiKey({
    user_id: user.id,
    key_hash: k.keyHash,
    key_prefix: k.keyPrefix,
    name: "k",
  });
  return { id: user.id, key: k.key };
}

/** Toggle agent visibility via PATCH /api/agents/:ns/:name/visibility */
export async function setVisibility(
  app: ReturnType<typeof createApp>,
  opts: { ns?: string; name?: string; visibility: "private" | "public"; token?: string },
) {
  const { ns = "dev", name = "test-agent", visibility, token = DEV_TOKEN } = opts;
  return app.request(`/api/agents/${ns}/${name}/visibility`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ visibility }),
  });
}
