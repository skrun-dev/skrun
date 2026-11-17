import { createHash } from "node:crypto";
import { existsSync, statSync, utimesSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquisitionBudgetMs,
  FLY_APP_ACTION_BURST,
  LLMRouter,
  LocalAdapter,
  McpToolProvider,
  type RunEvent,
  type RunRequest,
  seatDeadlineMarginMs,
  ToolRegistry,
} from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { bundleCache, bundleExtractionsInUse } from "../cache/bundle-cache.js";
import { sweepExpiredFiles } from "../cache/file-cache-sweep.js";
import { OUTPUT_DIR_PREFIX, outputDirHolds } from "../cache/output-cache.js";
import type { DbAdapter } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { API_KEY_DEFAULT_SCOPES, type Run } from "../db/schema.js";
import { SqliteDb } from "../db/sqlite.js";
import { createApp } from "../index.js";
import { parseQuotaEnv, type QuotaEnv } from "../quotas/thresholds.js";
import { inFlightRunIds } from "../runtime/in-flight-runs.js";
import { RegistryService } from "../services/registry.js";
import type { VerificationPolicy } from "../services/verification-policy.js";
import { MemoryStorage } from "../storage/memory.js";
import { FINAL_WRITE_RETRY_DELAYS_MS } from "./_helpers.js";
import { validBundle } from "./agent-bundle.shared.js";
import { parseSseEvents } from "./flyio-run-harness.shared.js";
import { storeVersion } from "./stored-version.shared.js";

// The run route builds its model router once, when the app is built
// (`createApp`), from the process environment: a provider this process held a
// server key for would never meet the key check. The key cases below run google
// (openai as their fallback), so neither may have one — made certain before any
// import, so before any app is built. And a webhook run started from this file
// delivers nothing.
const { deliverWebhook, logLines, stateCallbacksFault, stateCallbacksBuilt } = vi.hoisted(() => {
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return {
    deliverWebhook: vi.fn(async (_url: string, _payload: object) => {}),
    /** Every line the API's loggers write, parsed, oldest first: a case clears it. */
    logLines: [] as Array<Record<string, unknown>>,
    /** Set by a case: building a run's state callbacks throws it. */
    stateCallbacksFault: { error: undefined as unknown },
    /** How many runs had their state callbacks built — the step that builds a run's adapter. */
    stateCallbacksBuilt: { count: 0 },
  };
});

vi.mock("../utils/webhook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/webhook.js")>()),
  deliverWebhook,
}));

// The API's loggers are the runtime's, written to a destination that keeps
// each line for the cases to read, and still prints it. Nothing else of the
// runtime is replaced: its classes are the ones the cases spy on.
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const destination = {
    write(line: string) {
      logLines.push(JSON.parse(line) as Record<string, unknown>);
      process.stdout.write(line);
    },
  };
  return { ...actual, createLogger: (name: string) => actual.createLogger(name, destination) };
});

// A run's state callbacks are built with its adapter, after the run's row is
// written and before its mode runs: a fault a case sets breaks that step.
vi.mock("../services/agent-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-state.js")>();
  return {
    ...actual,
    createStateCallbacks: (...args: Parameters<typeof actual.createStateCallbacks>) => {
      stateCallbacksBuilt.count++;
      if (stateCallbacksFault.error !== undefined) throw stateCallbacksFault.error;
      return actual.createStateCallbacks(...args);
    },
  };
});

describe("POST /run — X-LLM-API-Key header parsing", () => {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);

  const authHeader = { Authorization: "Bearer dev-token" };

  // All these tests hit the header parsing step BEFORE the agent is loaded,
  // so they don't need a real agent in the registry. The 400 errors from
  // header validation come before the 404 from "agent not found".

  async function runWithHeader(headerValue: string | undefined) {
    const headers: Record<string, string> = {
      ...authHeader,
      "Content-Type": "application/json",
    };
    if (headerValue !== undefined) {
      headers["X-LLM-API-Key"] = headerValue;
    }
    return app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { text: "hello" } }),
    });
  }

  it("returns 400 for non-JSON header value", async () => {
    const res = await runWithHeader("not-json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_KEY_HEADER");
    expect(body.error.message).toContain("not valid JSON");
  });

  it("returns 400 for array header value", async () => {
    const res = await runWithHeader('["key1", "key2"]');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_KEY_HEADER");
    expect(body.error.message).toContain("JSON object");
  });

  it("returns 400 for empty object", async () => {
    const res = await runWithHeader("{}");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_KEY_HEADER");
    expect(body.error.message).toContain("at least one");
  });

  it("returns 400 for non-string values", async () => {
    const res = await runWithHeader('{"anthropic": 123}');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_KEY_HEADER");
    expect(body.error.message).toContain("must be a string");
  });

  it("proceeds past header parsing with valid header", async () => {
    // Valid header → should get past header parsing and hit "agent not found" (404)
    const res = await runWithHeader('{"anthropic": "sk-ant-test"}');
    // Not 400 = header parsing succeeded
    expect(res.status).not.toBe(400);
  });

  it("proceeds past header parsing without header", async () => {
    // No header → should get past header parsing and hit "agent not found" (404)
    const res = await runWithHeader(undefined);
    expect(res.status).not.toBe(400);
  });
});

describe("POST /run — agent verification", () => {
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;
  let service: RegistryService;

  const devAuthHeader = { Authorization: "Bearer dev-token" };
  const prodAuthHeader = { Authorization: "Bearer prod-user-token" };

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
    service = new RegistryService(storage, db);
  });

  it("non-verified version returns 403 AGENT_NOT_VERIFIED before any execution", async () => {
    // Push agent (unverified by default — agent_versions.verified=false) and
    // attempt a run with a non-dev token. The hard gate (Phase 3b in run.ts)
    // pre-empts bundle extraction, LLM allocation, and DB writes.
    const pushed = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("test-agent")),
    });
    expect(pushed.status).toBe(200);

    const res = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...prodAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "hello" } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("AGENT_NOT_VERIFIED");
    expect(body.error.message).toContain("1.0.0");
  });

  it("dev-token does NOT bypass the verified gate (uniform trust model)", async () => {
    // No escape hatch. dev-token is admin so it CAN call
    // PATCH .../versions/:v/verify to unblock the run, but the gate itself
    // does not auto-pass for dev-token — same boundary as OAuth callers.
    const pushed = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("test-agent")),
    });
    expect(pushed.status).toBe(200);

    const metadata = await service.getMetadata("dev", "test-agent");
    expect(metadata.latest_version_verified).toBe(false);

    const res = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "hello" } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_NOT_VERIFIED");
  });

  it("verified version unblocks the run gate", async () => {
    const pushed = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("test-agent")),
    });
    expect(pushed.status).toBe(200);

    // Verify via the new per-version endpoint (dev-token = admin).
    await db.setVersionVerified("dev", "test-agent", "1.0.0", true);

    const res = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "hello" } }),
    });
    // Past the verified gate now — refused downstream (no model key serves
    // the run), which is a different code path.
    expect(res.status).not.toBe(403);
  });

  it("latest_version_verified is readable in metadata", async () => {
    const pushed = await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("test-agent")),
    });
    expect(pushed.status).toBe(200);

    // Before verification — latest version is unverified
    let res = await app.request("/api/agents/dev/test-agent", { headers: devAuthHeader });
    let body = await res.json();
    expect(body.latest_version_verified).toBe(false);

    // After verification — computed flag reflects the new state
    await db.setVersionVerified("dev", "test-agent", "1.0.0", true);
    res = await app.request("/api/agents/dev/test-agent", { headers: devAuthHeader });
    body = await res.json();
    expect(body.latest_version_verified).toBe(true);
  });
});

describe("POST /run — version pinning", () => {
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;

  const authHeader = { Authorization: "Bearer dev-token", "Content-Type": "application/json" };

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  async function pushBundle(agent: string, version: string) {
    const pushed = await app.request(`/api/agents/dev/${agent}/push?version=${version}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(await validBundle(agent)),
    });
    expect(pushed.status).toBe(200);
  }

  async function runWithBody(body: Record<string, unknown>) {
    return app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: authHeader,
      body: JSON.stringify(body),
    });
  }

  // --- Format validation ---

  it('400 — rejects non-semver "1.0" with INVALID_VERSION_FORMAT', async () => {
    await pushBundle("test-agent", "1.0.0");
    const res = await runWithBody({ input: { text: "x" }, version: "1.0" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
    expect(body.error.message).toContain('"1.0"');
  });

  it('400 — rejects range "^1.0.0" with a hint about ranges', async () => {
    const res = await runWithBody({ input: { text: "x" }, version: "^1.0.0" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
    expect(body.error.message).toMatch(/ranges/i);
  });

  it('400 — rejects keyword "latest" with a hint to omit the field', async () => {
    const res = await runWithBody({ input: { text: "x" }, version: "latest" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
    expect(body.error.message).toMatch(/omit the field/i);
  });

  it('400 — rejects empty string "" with a hint to omit the field', async () => {
    const res = await runWithBody({ input: { text: "x" }, version: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
    expect(body.error.message).toMatch(/omit the field/i);
  });

  it("400 — rejects non-string `version` (number)", async () => {
    const res = await runWithBody({ input: { text: "x" }, version: 123 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
  });

  it("200/202/404 path — `version: null` treated as omitted (→ latest)", async () => {
    await pushBundle("test-agent", "1.0.0");
    await pushBundle("test-agent", "1.1.0");
    // We can't assert 200 body without running the agent (no LLM), but we can
    // assert that `version: null` did NOT trigger a 400 INVALID_VERSION_FORMAT.
    const res = await runWithBody({ input: { text: "x" }, version: null });
    expect(res.status).not.toBe(400);
  });

  // --- 404 VERSION_NOT_FOUND with available ---

  it("404 — pinned version not found returns `available` list (newest first)", async () => {
    await pushBundle("test-agent", "1.0.0");
    await pushBundle("test-agent", "1.1.0");
    await pushBundle("test-agent", "1.2.0");
    const res = await runWithBody({ input: { text: "x" }, version: "9.9.9" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("VERSION_NOT_FOUND");
    expect(body.error.message).toContain("9.9.9");
    expect(Array.isArray(body.error.available)).toBe(true);
    expect(body.error.available).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  it("404 available list is bounded to 10 most recent", async () => {
    // Seed through the DB, not HTTP push: 12 pushes in one window would trip the
    // (now actually mounted) push rate limiter, and this test is about the 404
    // available list — the bundle content never matters on that path.
    await pushBundle("test-agent", "1.0.0");
    const agent = await db.getAgent("dev", "test-agent");
    if (!agent) throw new Error("seed agent missing");
    for (let i = 1; i <= 12; i++) {
      await db.createVersion(agent.id, {
        version: `1.0.${i}`,
        size: 10,
        bundle_key: `dev/test-agent/1.0.${i}.agent`,
      });
    }
    const res = await runWithBody({ input: { text: "x" }, version: "9.9.9" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.available).toHaveLength(10);
    // newest first — 1.0.12 down to 1.0.3
    expect(body.error.available[0]).toBe("1.0.12");
  });

  // Webhook 202 body and sync 200 body assertions require a
  // real bundle to extract + execute — moved to the E2E integration tests,
  // where buildBundle() builds a valid tarball end-to-end.
});

describe("POST /run — webhook_url SSRF guard", () => {
  // The webhook_url guard is FAIL-CLOSED: private / reserved / non-HTTPS hosts
  // are rejected at intake regardless of NODE_ENV. Local testing against
  // http://localhost is accepted only when the operator opts in via
  // SKRUN_ALLOW_LOCAL_WEBHOOKS=true (the same flag utils/webhook.ts honors at
  // delivery time, which re-checks the RESOLVED IP).
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigin = process.env.CORS_ORIGIN;
  const previousAllowLocal = process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS;
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  const headers = {
    Authorization: "Bearer dev-token",
    "Content-Type": "application/json",
  };

  beforeEach(() => {
    process.env.CORS_ORIGIN = "https://example.com";
    delete process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS; // fail-closed by default
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previousCorsOrigin;
    if (previousAllowLocal === undefined) delete process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS;
    else process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS = previousAllowLocal;
  });

  async function postWithWebhook(webhookUrl: string) {
    return app.request("/api/agents/dev/any-agent/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { text: "x" }, webhook_url: webhookUrl }),
    });
  }

  it("rejects webhook_url targeting private IPv4 (192.168.x.x)", async () => {
    const res = await postWithWebhook("https://192.168.1.1/hook");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
    expect(body.error.message).toMatch(/private or reserved/);
  });

  it("rejects webhook_url targeting localhost", async () => {
    const res = await postWithWebhook("https://localhost/hook");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("rejects webhook_url targeting AWS metadata via IPv4-mapped IPv6", async () => {
    const res = await postWithWebhook("https://[::ffff:169.254.169.254]/latest/meta-data");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("rejects webhook_url targeting AWS metadata via raw IPv4", async () => {
    const res = await postWithWebhook("https://169.254.169.254/latest/meta-data");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("accepts a public HTTPS webhook_url (proceeds past validation)", async () => {
    // Public host -> validation passes; downstream returns 404 NOT_FOUND for
    // missing agent. We only assert "not 400 INVALID_WEBHOOK_URL".
    const res = await postWithWebhook("https://hooks.example.com/skrun");
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error.code).not.toBe("INVALID_WEBHOOK_URL");
    }
  });

  // Fail-closed: localhost is rejected by default, even outside production
  // (this inverts the former NODE_ENV dev-bypass, which left a self-host with
  // an unset NODE_ENV entirely unguarded).
  it("rejects http://localhost by default, even when NODE_ENV != production", async () => {
    process.env.NODE_ENV = "development";
    const res = await postWithWebhook("http://localhost:9999/callback");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  // Opt-in: SKRUN_ALLOW_LOCAL_WEBHOOKS=true relaxes the intake checks so local
  // webhook listeners (http://localhost:NNNN/callback) can be tested end to end.
  it("accepts http://localhost when SKRUN_ALLOW_LOCAL_WEBHOOKS=true", async () => {
    process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS = "true";
    const res = await postWithWebhook("http://localhost:9999/callback");
    // Webhook validation passes → not a 400 INVALID_WEBHOOK_URL (downstream
    // 404 for the missing agent is fine).
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error.code).not.toBe("INVALID_WEBHOOK_URL");
    }
  });
});

// A mechanical check — each of the 3 completed-run call sites in run.ts writes
// through finalizeRun, with its usage_cache_* fields, instead of an inline
// write. Every other final write is held to it by final-status-guard.test.ts.
describe("the completion write", () => {
  it("run.ts has 3 completion call sites through finalizeRun (SSE / webhook / sync)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const src = readFileSync(join(resolve(import.meta.dirname), "run.ts"), "utf-8");
    const matches =
      src.match(/finalizeRun\(\s*db,\s*log,\s*runId,\s*finalClaim,\s*\{\s*status: "completed"/g) ??
      [];
    expect(matches.length).toBe(3);
  });

  it("no inline 'usage_cache_savings_usd' writes left in run.ts (replaced by helper)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const src = readFileSync(join(resolve(import.meta.dirname), "run.ts"), "utf-8");
    expect(src).not.toMatch(/usage_cache_savings_usd:/);
  });
});

describe("POST /run — run-authorization + env-override", () => {
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  /** Create a non-admin user + a usable API key (role defaults to 'user'). */
  async function makeUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "test-key",
    });
    return { id: user.id, key };
  }

  /** Owner pushes a minimal valid bundle, then we mark the version verified (bypass admin). */
  async function pushVerified(ownerKey: string, namespace: string, name: string): Promise<void> {
    const pushed = await app.request(`/api/agents/${namespace}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
    expect(pushed.status).toBe(200);
    await db.setVersionVerified(namespace, name, "1.0.0", true);
  }

  function runAs(key: string, ns: string, name: string, body: Record<string, unknown> = {}) {
    return app.request(`/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, ...body }),
    });
  }

  it("owner runs their own private agent (past run-auth + verify gate)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("non-owner gets a 404 byte-identical to a genuinely-absent agent", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    // Same name, exists-but-private vs genuinely-absent → identical response
    // body (no existence leak). Compare the SAME path before/after deletion.
    const denied = await runAs(bob.key, "alice", "agent1");
    await db.deleteAgent("alice", "agent1");
    const absent = await runAs(bob.key, "alice", "agent1");
    expect(denied.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await denied.json()).toEqual(await absent.json());
  });

  it("a public agent is runnable by a non-owner (past run-auth)", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
  });

  it("admin (dev-token, self-host) runs any private agent (admin bypass)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await app.request("/api/agents/alice/agent1/run", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).not.toBe(404);
  });

  it("run-auth fires before the bundle pull (storage.get not called on the 404 path)", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    const getSpy = vi.spyOn(MemoryStorage.prototype, "get");
    getSpy.mockClear();
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).toBe(404);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("non-owner env override on a public agent → 403 ENV_OVERRIDE_FORBIDDEN", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1", {
      environment: { networking: { allowed_hosts: ["evil.example.com"] } },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "ENV_OVERRIDE_FORBIDDEN",
    );
  });

  it("owner env override is allowed (not 403 env-forbidden)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await runAs(alice.key, "alice", "agent1", {
      environment: { networking: { allowed_hosts: ["api.example.com"] } },
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body?.error?.code).not.toBe("ENV_OVERRIDE_FORBIDDEN");
  });

  /**
   * Mint a delegated key for `ownerId`, scoped to one agent and to `agent:run`
   * only. This is the credential shape the override gate could not tell apart:
   * it carries its minter's user id, so an ownership-only test sees the owner.
   */
  async function makeDelegatedKey(ownerId: string, agentId: string): Promise<string> {
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: ownerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "delegated-run-key",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agentId],
    });
    return key;
  }

  it("a delegated key minted by the owner cannot override the environment → 403", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const agent = await db.getAgent("alice", "agent1");
    expect(agent).not.toBeNull();
    const delegated = await makeDelegatedKey(alice.id, (agent as { id: string }).id);
    // The key runs this very agent, so it is past the scope gate; what it may
    // not do is widen the environment the creator declared.
    const res = await runAs(delegated, "alice", "agent1", {
      environment: { networking: { allowed_hosts: ["evil.example.com"] } },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "ENV_OVERRIDE_FORBIDDEN",
    );
  });

  it("the same delegated key still runs the agent without an override", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const agent = await db.getAgent("alice", "agent1");
    const delegated = await makeDelegatedKey(alice.id, (agent as { id: string }).id);
    const res = await runAs(delegated, "alice", "agent1");
    // Proves the 403 above comes from the override, not from the credential
    // being unable to reach the route at all.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("the owner's account-wide full key is not refused an override", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: alice.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "account-full-key",
      scopes: [...API_KEY_DEFAULT_SCOPES],
      scope_kind: "account",
    });
    const res = await runAs(key, "alice", "agent1", {
      environment: { networking: { allowed_hosts: ["api.example.com"] } },
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body?.error?.code).not.toBe("ENV_OVERRIDE_FORBIDDEN");
  });

  it("an owner's override carrying a retired field → 400 RETIRED_FIELD, before the bundle pull", async () => {
    const alice = await makeUser("alice");
    // A bundle that runs, and a caller key for its model: without the refusal,
    // the run would reach the adapter.
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(localAgentYaml("retired-override")) },
      { name: "SKILL.md", content: Buffer.from("# retired-override\n") },
    ]);
    const push = await app.request("/api/agents/alice/retired-override/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.key}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified("alice", "retired-override", "1.0.0", true);
    const execute = vi.spyOn(LocalAdapter.prototype, "execute");
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
    const getSpy = vi.spyOn(MemoryStorage.prototype, "get");
    getSpy.mockClear();
    try {
      for (const environment of [
        { sandbox: "strict" },
        { sandbox: "permissive", timeout: "600s" },
        { networking: { allowed_hosts: ["api.example.com"] }, sandbox: null },
      ]) {
        const res = await app.request("/api/agents/alice/retired-override/run", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alice.key}`,
            "Content-Type": "application/json",
            "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
          },
          body: JSON.stringify({ input: { q: "hello" }, environment }),
        });
        expect(execute).not.toHaveBeenCalled();
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("RETIRED_FIELD");
        expect(body.error.message).toMatch(/environment\.sandbox/);
      }
      expect(getSpy).not.toHaveBeenCalled();
      expect(await db.listRuns()).toEqual([]);
    } finally {
      getSpy.mockRestore();
      execute.mockRestore();
    }
  });

  it("an owner's override without a retired field is not refused for one", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await runAs(alice.key, "alice", "agent1", {
      environment: { timeout: "600s", networking: { allowed_hosts: ["api.example.com"] } },
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body?.error?.code).not.toBe("RETIRED_FIELD");
  });

  it("a non-owner's override carrying a retired field is refused for the override itself (403)", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1", { environment: { sandbox: "strict" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "ENV_OVERRIDE_FORBIDDEN",
    );
  });

  it("a public but unverified agent → 403 AGENT_NOT_VERIFIED (not a run-auth 404)", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const pushed = await app.request("/api/agents/alice/agent1/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.key}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("agent1")),
    });
    expect(pushed.status).toBe(200);
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_NOT_VERIFIED",
    );
  });

  it("a public verified agent runs for any authenticated caller", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });
});

describe("POST /run — API-key scope", () => {
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  async function makeUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "acct",
    });
    return { id: user.id, key };
  }

  /** Mint a usable API key with a specific scope, DB-direct (route-level
   *  ownership validation is not exercised here). */
  async function makeScopedKey(
    userId: string,
    opts: { scope_kind?: "account" | "agents"; operations?: string[]; agents?: string[] },
  ): Promise<{ key: string; id: string }> {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "scoped",
      scopes: opts.operations ?? ["agent:run"],
      scope_kind: opts.scope_kind ?? "agents",
      agents: opts.agents ?? [],
    });
    return { key, id: apiKey.id };
  }

  /** Owner pushes a minimal valid bundle + marks it verified; returns the agent's db id. */
  async function pushVerified(ownerKey: string, ns: string, name: string): Promise<string> {
    const pushed = await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
    expect(pushed.status).toBe(200);
    await db.setVersionVerified(ns, name, "1.0.0", true);
    const agent = await db.getAgent(ns, name);
    if (!agent) throw new Error("agent missing after push");
    return agent.id;
  }

  function runAs(key: string, ns: string, name: string, body: Record<string, unknown> = {}) {
    return app.request(`/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, ...body }),
    });
  }

  it("a key scoped to its agent runs it (past the scope gate)", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushVerified(alice.key, "alice", "agent1");
    const scoped = await makeScopedKey(alice.id, { agents: [agentId], operations: ["agent:run"] });
    const res = await runAs(scoped.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("a scoped key on another OWNED agent → 403 KEY_SCOPE_FORBIDDEN", async () => {
    const alice = await makeUser("alice");
    const agent1Id = await pushVerified(alice.key, "alice", "agent1");
    await pushVerified(alice.key, "alice", "agent2");
    const scoped = await makeScopedKey(alice.id, { agents: [agent1Id], operations: ["agent:run"] });
    const res = await runAs(scoped.key, "alice", "agent2");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_SCOPE_FORBIDDEN",
    );
  });

  it("a key lacking agent:run (push-only) → 403 KEY_SCOPE_FORBIDDEN", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const pushOnly = await makeScopedKey(alice.id, {
      scope_kind: "account",
      operations: ["agent:push"],
    });
    const res = await runAs(pushOnly.key, "alice", "agent1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_SCOPE_FORBIDDEN",
    );
  });

  it("a cross-account key → 404 (run-auth first), scope gate never reached, no pull", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const aliceAgent = await pushVerified(alice.key, "alice", "agent1");
    // Bob mints a key naming alice's agent id (he doesn't own it).
    const bobKey = await makeScopedKey(bob.id, { agents: [aliceAgent], operations: ["agent:run"] });
    const getSpy = vi.spyOn(MemoryStorage.prototype, "get");
    getSpy.mockClear();
    const res = await runAs(bobKey.key, "alice", "agent1");
    expect(res.status).toBe(404); // cross-account opaque, NOT a 403
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("the scope gate fires before the bundle pull (intra-account)", async () => {
    const alice = await makeUser("alice");
    const agent1Id = await pushVerified(alice.key, "alice", "agent1");
    await pushVerified(alice.key, "alice", "agent2");
    const scoped = await makeScopedKey(alice.id, { agents: [agent1Id], operations: ["agent:run"] });
    const getSpy = vi.spyOn(MemoryStorage.prototype, "get");
    getSpy.mockClear();
    const res = await runAs(scoped.key, "alice", "agent2");
    expect(res.status).toBe(403);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });
});

describe("POST /run — caller-key policy", () => {
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  async function makeUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "acct",
    });
    return { id: user.id, key };
  }

  async function pushVerified(ownerKey: string, ns: string, name: string): Promise<void> {
    const pushed = await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
    expect(pushed.status).toBe(200);
    await db.setVersionVerified(ns, name, "1.0.0", true);
  }

  function runAs(key: string, ns: string, name: string, llmKey?: string) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    if (llmKey) headers["X-LLM-API-Key"] = JSON.stringify({ anthropic: llmKey });
    return app.request(`/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
  }

  it("creator_only rejects a run carrying X-LLM-API-Key (403, before the pull)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setLlmKeyPolicy("alice", "agent1", "creator_only");
    const getSpy = vi.spyOn(MemoryStorage.prototype, "get");
    getSpy.mockClear();
    const res = await runAs(alice.key, "alice", "agent1", "sk-ant-caller-fake");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CALLER_KEY_NOT_ALLOWED",
    );
    expect(getSpy).not.toHaveBeenCalled(); // the gate fires before the bundle pull
    getSpy.mockRestore();
  });

  it("the default (open) policy accepts a run carrying X-LLM-API-Key (past the gate)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await runAs(alice.key, "alice", "agent1", "sk-ant-caller-fake");
    expect(res.status).not.toBe(403);
  });

  it("creator_only WITHOUT a caller key is allowed past the gate", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setLlmKeyPolicy("alice", "agent1", "creator_only");
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(403);
  });
});

describe("POST /run — an agent's creator keys, read before they are decrypted", () => {
  const KEY_ENV = "SKRUN_SECRETS_ENCRYPTION_KEY";
  const previousKey = process.env[KEY_ENV];
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    // A key its owner attaches is stored encrypted: the app reads the master key when built.
    process.env[KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
    logLines.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
  });

  /** Alice, her full-access key, and a verified agent of hers. */
  async function aliceWithAgent(): Promise<{ key: string }> {
    const user = await db.createUser({ github_id: "gh-alice", username: "alice" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "acct",
    });
    const pushed = await app.request("/api/agents/alice/agent1/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("agent1")),
    });
    expect(pushed.status).toBe(200);
    await db.setVersionVerified("alice", "agent1", "1.0.0", true);
    return { key };
  }

  const run = (key: string) =>
    app.request("/api/agents/alice/agent1/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });

  it("a read of the keys the database stopped at its bound: 503 DATABASE_TIMEOUT with its Retry-After, and the database's line", async () => {
    const { key } = await aliceWithAgent();
    vi.spyOn(db, "getAgentLlmKeySecrets").mockRejectedValue(
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    );

    const res = await run(key);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DATABASE_TIMEOUT");
    expect(logLines.filter((line) => line.event === "database_timeout")).toEqual([
      expect.objectContaining({
        cause: "statement_timeout",
        route: "/api/agents/:namespace/:name/run",
      }),
    ]);
  });

  it("any other error of that read: the server's own 500, never a key it could not decrypt", async () => {
    const { key } = await aliceWithAgent();
    vi.spyOn(db, "getAgentLlmKeySecrets").mockRejectedValue(new Error("the database refused"));

    const res = await run(key);

    expect(await res.text()).toBe("Internal Server Error");
    expect(res.status).toBe(500);
    expect(logLines.filter((line) => line.event === "unhandled_error")).toHaveLength(1);
  });

  it("a key attached under another master key: 500 CREATOR_KEY_UNREADABLE, the run refused", async () => {
    const { key } = await aliceWithAgent();
    const attach = await app.request("/api/agents/alice/agent1/llm-keys/anthropic", {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "sk-ant-creator-0123456789abcdef" }),
    });
    expect(attach.status).toBe(200);
    // The master key rotated away: the app built again reads another one.
    process.env[KEY_ENV] = Buffer.alloc(32, 9).toString("base64");
    app = createApp(storage, db);

    const res = await run(key);

    expect(await res.text()).toBe(
      JSON.stringify({
        error: {
          code: "CREATOR_KEY_UNREADABLE",
          message:
            "A creator LLM key is attached but could not be decrypted on this server (check SKRUN_SECRETS_ENCRYPTION_KEY).",
        },
      }),
    );
    expect(res.status).toBe(500);
  });
});

describe("POST /run — verification policy", () => {
  function setup(verificationPolicy: VerificationPolicy) {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const app = createApp(storage, db, { verificationPolicy });

    async function makeUser(username: string): Promise<{ id: string; key: string }> {
      const user = await db.createUser({ github_id: `gh-${username}`, username });
      const { key, keyHash, keyPrefix } = generateApiKey();
      await db.createApiKey({
        user_id: user.id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: "test-key",
      });
      return { id: user.id, key };
    }

    /** Owner pushes a minimal valid bundle; optionally mark the version verified (DB-direct). */
    async function push(
      ownerKey: string,
      ns: string,
      name: string,
      verified: boolean,
    ): Promise<void> {
      const pushed = await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(await validBundle(name)),
      });
      expect(pushed.status).toBe(200);
      if (verified) {
        await db.setVersionVerified(ns, name, "1.0.0", true);
      }
    }

    function runAs(key: string, ns: string, name: string) {
      return app.request(`/api/agents/${ns}/${name}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
    }

    return { app, db, storage, makeUser, push, runAs };
  }

  it("owner policy — owner runs their own UNVERIFIED agent (no verify gate)", async () => {
    const { makeUser, push, runAs } = setup("owner");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1", false);
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("disabled policy — an unverified agent is never gated on verification", async () => {
    const { makeUser, push, runAs } = setup("disabled");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1", false);
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(403);
  });

  it("admin policy (default) still gates an unverified agent (403 AGENT_NOT_VERIFIED)", async () => {
    const { makeUser, push, runAs } = setup("admin");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1", false);
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_NOT_VERIFIED",
    );
  });

  it("owner policy — run-auth (opaque 404) fires before the verify gate for a stranger", async () => {
    const { makeUser, push, runAs } = setup("owner");
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await push(alice.key, "alice", "agent1", false); // private + unverified
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).toBe(404); // stranger sees an opaque 404, never a verify error
  });

  it("dormant run-auth public branch — a DB-public verified agent runs for a non-owner", async () => {
    const { db, makeUser, push, runAs } = setup("admin");
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await push(alice.key, "alice", "agent1", true);
    // DB-direct public (the supported HTTP set-path is disabled) — proves the
    // dormant run-auth `public` branch still works for future reactivation.
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
  });
});

describe("POST /run — caller base-URL gate", () => {
  const DECLARED = "https://api.deepseek.com/v1";
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  async function makeUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "master-key",
    });
    return { id: user.id, key };
  }

  /**
   * A DELEGATED key — `scope_kind: "agents"`, the credential a creator hands a
   * client. It resolves to the OWNER's account (auth.ts builds the context from
   * the key's owner), which is exactly why `owner_id === user.id` alone cannot
   * distinguish it and why this gate keys on `isMasterCredential` instead.
   */
  async function makeDelegatedKey(userId: string, agentId: string): Promise<string> {
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "delegated",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agentId],
    });
    return key;
  }

  /**
   * Push a bundle whose agent.yaml can declare a `model.base_url` — this gate
   * sits after `parseAgentYaml` and reads it. The file's other helpers push
   * the minimal agent of `validBundle`, which declares none.
   */
  async function pushAgent(
    ownerKey: string,
    ns: string,
    name: string,
    opts: { baseUrl?: string } = {},
  ): Promise<string> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      ...(opts.baseUrl ? [`  base_url: ${opts.baseUrl}`] : []),
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: bundle,
    });
    await db.setVersionVerified(ns, name, "1.0.0", true);
    const agent = await db.getAgent(ns, name);
    if (!agent) throw new Error("agent missing after push");
    return agent.id;
  }

  function runAs(
    key: string,
    ns: string,
    name: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.request(`/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-caller-fake" }),
        ...headers,
      },
      body: JSON.stringify({ input: { q: "hi" } }),
    });
  }

  // Each test uses its OWN agent name, so each case's agent and bundle are its
  // own. The extracted-bundle cache was once keyed by name and version, and two
  // tests sharing a name then served each other stale bundles; it is keyed by
  // the bundle's bytes now.

  it("a delegated caller's key is refused when the agent declares a base_url", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "vt7-agent", { baseUrl: DECLARED });
    const delegated = await makeDelegatedKey(alice.id, agentId);

    const res = await runAs(delegated, "alice", "vt7-agent");
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("CALLER_BASE_URL_NOT_CONSENTED");
    // The refusal names the destination, so the caller can decide rather than guess.
    expect(body.error?.message).toContain("https://api.deepseek.com");
  });

  it("naming the same origin lets the run proceed", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "vt8-agent", { baseUrl: DECLARED });
    const delegated = await makeDelegatedKey(alice.id, agentId);

    const res = await runAs(delegated, "alice", "vt8-agent", {
      // Origin match, not string match — the caller need not echo the path.
      "X-LLM-Base-URL": JSON.stringify({ anthropic: "https://api.deepseek.com" }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe("CALLER_BASE_URL_NOT_CONSENTED");
  });

  it("naming a DIFFERENT origin is refused, and both origins are named", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "vt9-agent", { baseUrl: DECLARED });
    const delegated = await makeDelegatedKey(alice.id, agentId);

    const res = await runAs(delegated, "alice", "vt9-agent", {
      "X-LLM-Base-URL": JSON.stringify({ anthropic: "https://api.moonshot.ai/v1" }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("CALLER_BASE_URL_NOT_CONSENTED");
    expect(body.error?.message).toContain("api.deepseek.com");
    expect(body.error?.message).toContain("api.moonshot.ai");
  });

  it("declaring an endpoint the agent does not use is refused too", async () => {
    // The caller believes their key goes somewhere it will not. Same principle
    // as `creator_only`: a caller must never be wrong about their own credential.
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "vt10-agent");
    const delegated = await makeDelegatedKey(alice.id, agentId);

    const res = await runAs(delegated, "alice", "vt10-agent", {
      "X-LLM-Base-URL": JSON.stringify({ anthropic: "https://api.deepseek.com/v1" }),
    });
    const body = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("CALLER_BASE_URL_NOT_CONSENTED");
  });

  it("the owner with a master credential is exempt — no header needed", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "vt11-agent", { baseUrl: DECLARED });

    const res = await runAs(alice.key, "alice", "vt11-agent");
    const body = (await res.json()) as { error?: { code?: string } };
    // Same principal: the author of the agent.yaml and the owner of the key are
    // the same person. This is the documented docs/agent-yaml.md:66 flow and the
    // dashboard playground, both unchanged.
    expect(body.error?.code).not.toBe("CALLER_BASE_URL_NOT_CONSENTED");
  });

  it("the SAME owner account presenting a delegated key is NOT exempt", async () => {
    // The case that makes the predicate correct. `owner_id === user.id` is true
    // here — the delegated key resolves to alice — so an exemption keyed on
    // ownership alone would let this through, and the gate would never fire
    // against the only non-owner channel that exists today.
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "vt11b-agent", { baseUrl: DECLARED });
    const delegated = await makeDelegatedKey(alice.id, agentId);

    const res = await runAs(delegated, "alice", "vt11b-agent");
    const body = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("CALLER_BASE_URL_NOT_CONSENTED");
  });

  it("a caller key on an agent with NO base_url is untouched", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "rt2-agent");
    const delegated = await makeDelegatedKey(alice.id, agentId);

    const res = await runAs(delegated, "alice", "rt2-agent");
    const body = (await res.json()) as { error?: { code?: string } };
    // The overwhelmingly common path: no new header required, nothing changes.
    expect(body.error?.code).not.toBe("CALLER_BASE_URL_NOT_CONSENTED");
  });

  it("rejects a malformed X-LLM-Base-URL header before anything else", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "hdr-agent");

    for (const bad of ["not-json", '["array"]', '{"anthropic": 42}', '{"anthropic": "nope"}']) {
      const res = await runAs(alice.key, "alice", "hdr-agent", { "X-LLM-Base-URL": bad });
      const body = (await res.json()) as { error?: { code?: string } };
      expect(res.status).toBe(400);
      expect(body.error?.code).toBe("INVALID_LLM_BASE_URL_HEADER");
    }
  });
});

describe("run rate limiting", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(new MemoryStorage(), new MemoryDb());
  });

  function runReq() {
    return app.request("/api/agents/dev/rl-agent/run", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "x" } }),
    });
  }

  it("the real two-segment run route traverses the limiter (headers present)", async () => {
    // The nominal run path itself is pinned unchanged by the rest of this file;
    // what was never asserted anywhere is that the limiter sits on THIS route.
    const res = await runReq();
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
    expect(res.status).not.toBe(429);
  });

  it("the 61st run in the window is refused 429 RATE_LIMITED, told to wait until the window resets", async () => {
    // The agent does not exist: each request 404s in the handler but still
    // counts in the limiter, which runs first — that keeps the burst cheap.
    for (let i = 0; i < 60; i++) {
      expect((await runReq()).status).toBe(404);
    }
    const before = Math.floor(Date.now() / 1000);
    const res = await runReq();
    const after = Math.floor(Date.now() / 1000);
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    // The seconds from the refusal to X-RateLimit-Reset, read on either side of it.
    const reset = Number(res.headers.get("X-RateLimit-Reset"));
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(res.headers.get("Retry-After") ?? "no Retry-After").toMatch(/^\d+$/);
    expect(retryAfter).toBeGreaterThanOrEqual(Math.max(0, reset - after));
    expect(retryAfter).toBeLessThanOrEqual(Math.max(0, reset - before));
    // A window of sixty seconds, its reset rounded up to the whole second.
    expect(retryAfter).toBeLessThanOrEqual(61);
  });
});

describe("POST /run — a run no model key can serve, primary or fallback, is refused before the run", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
    deliverWebhook.mockClear();
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
  });

  afterEach(() => {
    executeStream.mockRestore();
    execute.mockRestore();
  });

  /**
   * Push, as the local operator, an agent whose primary model is google — with
   * a fallback (openai, or google again), or a declared endpoint, when asked —
   * and verify it. Each test pushes its own name: extracted bundles are cached
   * per process.
   */
  async function pushGoogleAgent(
    name: string,
    opts: { fallback?: boolean | "same-provider"; baseUrl?: string } = {},
  ): Promise<void> {
    const fallback =
      opts.fallback === "same-provider"
        ? ["  fallback:", "    provider: google", "    name: gemini-2.5-pro"]
        : opts.fallback
          ? ["  fallback:", "    provider: openai", "    name: gpt-4o-mini"]
          : [];
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      ...(opts.baseUrl ? [`  base_url: ${opts.baseUrl}`] : []),
      ...fallback,
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await db.setVersionVerified("dev", name, "1.0.0", true);
  }

  /**
   * A key the agent's owner hands a client: scoped to this agent and to running
   * it. It resolves to the owner's account, yet it is no account credential.
   */
  async function delegatedKeyFor(name: string): Promise<string> {
    const agent = await db.getAgent("dev", name);
    if (!agent) throw new Error("agent missing after push");
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: agent.owner_id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "delegated",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agent.id],
    });
    return key;
  }

  /** The run itself, scripted: no model is called, the decision is all that is tested. */
  function scriptCompletedRuns(): void {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      const now = new Date().toISOString();
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: now,
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: now,
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
  }

  function runAgentIn(
    mode: "sync" | "sse" | "webhook",
    name: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const body: Record<string, unknown> = { input: { q: "hello" } };
    if (mode === "webhook") body.webhook_url = "https://hooks.example.com/x";
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
        ...(mode === "sse" && { Accept: "text/event-stream" }),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  /** Everything a refusal is judged on, in one value, so a red shows all of it at once. */
  async function observe(res: Response) {
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    const body = isJson
      ? (JSON.parse(text) as { status?: string; error?: { code?: string; message?: string } })
      : undefined;
    return {
      message: body?.error?.message ?? "",
      seen: {
        status: res.status,
        code: body?.error?.code,
        result: body?.status,
        events: isJson ? [] : parseSseEvents(text).map((e) => e.event),
        adapterCalls: execute.mock.calls.length + executeStream.mock.calls.length,
        runs: (await db.listRuns()).length,
      },
    };
  }

  const REFUSED = {
    status: 400,
    code: "LLM_KEY_REQUIRED",
    result: undefined,
    events: [],
    adapterCalls: 0,
    runs: 0,
  };

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: refused with 400 LLM_KEY_REQUIRED — no adapter call, no run row", async (mode) => {
    await pushGoogleAgent(`key-none-${mode}`);

    const { seen, message } = await observe(await runAgentIn(mode, `key-none-${mode}`));

    expect(seen).toEqual(REFUSED);
    expect(deliverWebhook).not.toHaveBeenCalled();
    // Actionable for the caller: the header, then the agent's owner.
    expect(message).toContain('provider "google"');
    expect(message).toContain("X-LLM-API-Key");
    expect(message).toContain("skrun llm-key set google --agent dev/key-none-");
    // The server's variable is named as what it is: an operator's setting.
    expect(message).toMatch(/operator[^.]*GOOGLE_API_KEY/);
  });

  // A pattern, which the local runtime honours, every form no runtime does, and
  // an IPv6 literal in brackets — the form the local runtime matches.
  const LOCAL_HOSTS = [
    "*.example.com",
    "example.com:443",
    "https://x.y",
    "x.y/z",
    "[2606:4700::1111]",
  ];

  it("an allowed host the cloud sandbox cannot enforce is not refused on the local runtime: the run reaches the adapter, the list as written", async () => {
    await pushGoogleAgent("local-host-pattern");
    scriptCompletedRuns();

    const res = await app.request("/api/agents/dev/local-host-pattern/run", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: JSON.stringify({
        input: { q: "hello" },
        environment: { networking: { allowed_hosts: LOCAL_HOSTS } },
      }),
    });

    expect(res.status).toBe(200);
    expect(parseSseEvents(await res.text()).map((e) => e.event)).toEqual([
      "run_start",
      "run_complete",
    ]);
    expect(executeStream).toHaveBeenCalledOnce();
    expect(
      (executeStream.mock.calls[0]?.[0] as RunRequest).agentConfig.environment.networking
        .allowed_hosts,
    ).toEqual(LOCAL_HOSTS);
  });

  it("refused the same way when the agent declares its own endpoint and brings no key", async () => {
    await pushGoogleAgent("key-none-base-url", { baseUrl: "https://models.example/v1" });

    const { seen, message } = await observe(await runAgentIn("sync", "key-none-base-url"));

    expect(seen).toEqual(REFUSED);
    expect(message).toContain("model.base_url");
    expect(message).toContain("X-LLM-API-Key");
    // The owner on an account credential sends a key there without naming the endpoint.
    expect(message).not.toContain("X-LLM-Base-URL");
    expect(message).toMatch(/operator[^.]*SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL/);
  });

  it("under a declared endpoint, a caller who must name it is told for which key — and each way it names goes through", async () => {
    await pushGoogleAgent("key-none-endpoint-delegated", {
      baseUrl: "https://models.example/v1",
      fallback: true,
    });
    const as = { Authorization: `Bearer ${await delegatedKeyFor("key-none-endpoint-delegated")}` };

    const { seen, message } = await observe(
      await runAgentIn("sync", "key-none-endpoint-delegated", as),
    );

    expect(seen).toEqual(REFUSED);
    // Only a key for the primary model's provider goes to the agent's endpoint:
    // the message asks for that origin beside such a key, says a key for the
    // fallback's provider needs none — and takes none — and keeps the owner's way.
    expect(message).toMatch(/"google"[^.]*X-LLM-API-Key[^.]*X-LLM-Base-URL/);
    expect(message).toContain('{"google": "https://models.example"}');
    expect(message).toContain(
      'A key for "openai", the provider of its fallback model, needs no endpoint named, and naming one for it is refused',
    );
    expect(message).toContain("skrun llm-key set google --agent dev/key-none-endpoint-delegated");

    // Followed to the letter, each way goes ahead: a key for the primary with
    // the origin named beside it, and a key for the fallback's provider alone.
    scriptCompletedRuns();
    const named = await runAgentIn("sync", "key-none-endpoint-delegated", {
      ...as,
      "X-LLM-API-Key": JSON.stringify({ google: "k-caller-google" }),
      "X-LLM-Base-URL": JSON.stringify({ google: "https://models.example" }),
    });
    const fallbackKeyAlone = await runAgentIn("sync", "key-none-endpoint-delegated", {
      ...as,
      "X-LLM-API-Key": JSON.stringify({ openai: "k-caller-openai" }),
    });
    expect({
      named: named.status,
      fallbackKeyAlone: fallbackKeyAlone.status,
      adapterCalls: executeStream.mock.calls.length,
    }).toEqual({ named: 200, fallbackKeyAlone: 200, adapterCalls: 2 });
  });

  // The endpoint gate itself, for a caller it does not exempt (a key the owner
  // hands a client), read as soon as either header is sent. The router sends
  // only the key for the primary model's provider to `model.base_url`; the
  // fallback goes to its own provider's default endpoint. So the gate asks for
  // the endpoint's origin beside that key only — and a fallback on the
  // primary's provider uses that very key. Every origin the caller does name
  // must be where that provider's key goes: the endpoint's for the primary's
  // provider, and none for any other, nor on an agent with no endpoint.
  describe("for a caller the endpoint gate does not exempt: every origin named is where that provider's key goes, and a key for the primary's provider under a declared endpoint needs its own", () => {
    const ENDPOINT = "https://models.example/v1";

    // Every run scripted: a gate that let a refused key through would reach
    // the adapter here, never the network.
    beforeEach(() => {
      scriptCompletedRuns();
    });

    /** A run with these keys (none: no X-LLM-API-Key) and these origins named. */
    async function runWithKeys(
      name: string,
      keys: Record<string, string> | undefined,
      baseUrls?: Record<string, string>,
    ) {
      const as = { Authorization: `Bearer ${await delegatedKeyFor(name)}` };
      return observe(
        await runAgentIn("sync", name, {
          ...as,
          ...(keys && { "X-LLM-API-Key": JSON.stringify(keys) }),
          ...(baseUrls && { "X-LLM-Base-URL": JSON.stringify(baseUrls) }),
        }),
      );
    }

    const REFUSED_AT_THE_GATE = {
      status: 403,
      code: "CALLER_BASE_URL_NOT_CONSENTED",
      adapterCalls: 0,
    };

    it("a key for the fallback's provider alone needs no endpoint named: the run reaches the adapter", async () => {
      await pushGoogleAgent("endpoint-fallback-key", { baseUrl: ENDPOINT, fallback: true });

      const { seen } = await runWithKeys("endpoint-fallback-key", { openai: "k-caller-openai" });

      expect({ status: seen.status, code: seen.code, result: seen.result }).toEqual({
        status: 200,
        code: undefined,
        result: "completed",
      });
      expect(executeStream).toHaveBeenCalledOnce();
      expect((executeStream.mock.calls[0]?.[0] as RunRequest).callerKeys).toEqual({
        openai: "k-caller-openai",
      });
    });

    it.each([
      ["alone", "endpoint-primary-key", { google: "k-caller-google" }],
      [
        "beside one for the fallback's provider",
        "endpoint-both-keys",
        { google: "k-caller-google", openai: "k-caller-openai" },
      ],
    ] as const)("a key for the primary's provider (%s) is refused without the endpoint named — which the refusal names", async (_how, name, keys) => {
      await pushGoogleAgent(name, { baseUrl: ENDPOINT, fallback: true });

      const { seen, message } = await runWithKeys(name, keys);

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual({
        status: 403,
        code: "CALLER_BASE_URL_NOT_CONSENTED",
        adapterCalls: 0,
      });
      expect(message).toContain('{"google": "https://models.example"}');
      expect(message).toContain("Your X-LLM-API-Key would be sent there");
    });

    // A declaration is the caller's word on where a key of theirs goes: a wrong
    // one is refused whatever the keys, as for an agent with no endpoint.
    it("a key for the fallback's provider alone, with another origin named for the primary's: refused — the origin named is not the agent's, which the refusal names", async () => {
      await pushGoogleAgent("endpoint-fallback-key-wrong-origin", {
        baseUrl: ENDPOINT,
        fallback: true,
      });

      const { seen, message } = await runWithKeys(
        "endpoint-fallback-key-wrong-origin",
        { openai: "k-caller-openai" },
        { google: "https://elsewhere.example/v1" },
      );

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual({
        status: 403,
        code: "CALLER_BASE_URL_NOT_CONSENTED",
        adapterCalls: 0,
      });
      expect(message).toContain("https://elsewhere.example");
      expect(message).toContain('{"google": "https://models.example"}');
      // No key of this caller's would go there: the refusal must not say one would.
      expect(message).not.toContain("would be sent there");
    });

    it("a key for the fallback's provider alone, with the agent's origin named: the run reaches the adapter", async () => {
      await pushGoogleAgent("endpoint-fallback-key-right-origin", {
        baseUrl: ENDPOINT,
        fallback: true,
      });

      const { seen } = await runWithKeys(
        "endpoint-fallback-key-right-origin",
        { openai: "k-caller-openai" },
        { google: "https://models.example" },
      );

      expect({ status: seen.status, code: seen.code, result: seen.result }).toEqual({
        status: 200,
        code: undefined,
        result: "completed",
      });
      expect(executeStream).toHaveBeenCalledOnce();
    });

    it("a fallback on the primary's provider uses the same key: without the endpoint named, it is refused", async () => {
      await pushGoogleAgent("endpoint-same-fallback-key", {
        baseUrl: ENDPOINT,
        fallback: "same-provider",
      });

      const { seen } = await runWithKeys("endpoint-same-fallback-key", {
        google: "k-caller-google",
      });

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual({
        status: 403,
        code: "CALLER_BASE_URL_NOT_CONSENTED",
        adapterCalls: 0,
      });
    });

    // A declaration sent alone is read too: no key is needed for it to be wrong.
    it("no key at all, with another origin named for the primary's provider: refused — the origin named is not the agent's, which the refusal names", async () => {
      await pushGoogleAgent("endpoint-no-key-wrong-origin", { baseUrl: ENDPOINT, fallback: true });

      const { seen, message } = await runWithKeys("endpoint-no-key-wrong-origin", undefined, {
        google: "https://elsewhere.example/v1",
      });

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual(
        REFUSED_AT_THE_GATE,
      );
      expect(message).toContain("https://elsewhere.example");
      expect(message).toContain('{"google": "https://models.example"}');
      expect(message).not.toContain("would be sent there");
    });

    it("no key at all, with the agent's origin named: the gate lets it through — the run is then refused for want of a key", async () => {
      await pushGoogleAgent("endpoint-no-key-right-origin", { baseUrl: ENDPOINT, fallback: true });

      const { seen } = await runWithKeys("endpoint-no-key-right-origin", undefined, {
        google: "https://models.example",
      });

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual({
        status: 400,
        code: "LLM_KEY_REQUIRED",
        adapterCalls: 0,
      });
    });

    // The agent declares no endpoint for its fallback's provider (the schema
    // keeps `base_url` off the fallback): an origin named for it is wrong about
    // where that key goes, whether one is sent or not — beside the agent's
    // right origin too, since every entry is read.
    it.each([
      ["a key for it", "endpoint-fallback-origin-key", { openai: "k-caller-openai" }, {}],
      ["no key at all", "endpoint-fallback-origin-no-key", undefined, {}],
      [
        "beside the agent's origin, both keys",
        "endpoint-fallback-origin-both",
        { google: "k-caller-google", openai: "k-caller-openai" },
        { google: "https://models.example" },
      ],
    ] as const)("an origin named for the fallback's provider, %s: refused — the refusal names that provider and the one entry the agent takes", async (_how, name, keys, alongside) => {
      await pushGoogleAgent(name, { baseUrl: ENDPOINT, fallback: true });

      const { seen, message } = await runWithKeys(name, keys, {
        ...alongside,
        openai: "https://api.openai.example/v1",
      });

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual(
        REFUSED_AT_THE_GATE,
      );
      expect(message).toContain('"openai"');
      expect(message).toContain("https://api.openai.example");
      expect(message).toContain('{"google": "https://models.example"}');
      expect(message).not.toContain("would be sent there");
    });

    it("an origin named for a provider the agent does not use: refused, its key for the fallback notwithstanding", async () => {
      await pushGoogleAgent("endpoint-unused-provider-origin", {
        baseUrl: ENDPOINT,
        fallback: true,
      });

      const { seen, message } = await runWithKeys(
        "endpoint-unused-provider-origin",
        { openai: "k-caller-openai" },
        { anthropic: "https://api.anthropic.example" },
      );

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual(
        REFUSED_AT_THE_GATE,
      );
      expect(message).toContain('"anthropic"');
      expect(message).toContain("https://api.anthropic.example");
      expect(message).toContain('{"google": "https://models.example"}');
    });

    // An agent with no endpoint of its own calls every provider at its default
    // endpoint: any origin named is wrong, whatever the keys — none sent included.
    it.each([
      ["no key at all", "no-endpoint-origin-no-key", undefined, "google"],
      [
        "a key for the primary's provider, an origin for the fallback's",
        "no-endpoint-origin-fallback",
        { google: "k-caller-google" },
        "openai",
      ],
    ] as const)("an agent with no endpoint of its own, an origin named with %s: refused — the refusal names that provider and the origin", async (_how, name, keys, named) => {
      await pushGoogleAgent(name, { fallback: true });

      const { seen, message } = await runWithKeys(name, keys, {
        [named]: "https://elsewhere.example/v1",
      });

      expect({ status: seen.status, code: seen.code, adapterCalls: seen.adapterCalls }).toEqual(
        REFUSED_AT_THE_GATE,
      );
      expect(message).toContain(`"${named}"`);
      expect(message).toContain("https://elsewhere.example");
      expect(message).toContain("does not use a custom endpoint");
    });
  });

  it("a primary sent to its own endpoint and a fallback with no key: the fallback in a sentence of its own", async () => {
    await pushGoogleAgent("key-none-endpoint-fallback", {
      baseUrl: "https://models.example/v1",
      fallback: true,
    });

    const { seen, message } = await observe(await runAgentIn("sync", "key-none-endpoint-fallback"));

    expect(seen).toEqual(REFUSED);
    // Never "…does not send its own key there, nor for openai": no openai key
    // is held back — there is none.
    expect(message).not.toContain("nor for");
    expect(message).toContain(
      'No model key is available for "openai", the provider of its fallback model, either.',
    );
    expect(message).toMatch(/operator[^.]*OPENAI_API_KEY/);
  });

  it.each([
    ["key-none-same-fallback", {}],
    ["key-none-same-fallback-endpoint", { baseUrl: "https://models.example/v1" }],
  ] as const)("%s: a fallback on the primary's provider — the provider and its variable named once", async (name, opts) => {
    await pushGoogleAgent(name, { ...opts, fallback: "same-provider" });

    const { seen, message } = await observe(await runAgentIn("sync", name));

    expect(seen).toEqual(REFUSED);
    expect(message).toContain('"google"');
    expect(message).toContain("fallback");
    expect(message).not.toContain('nor for "google"');
    expect(message).not.toContain("either in");
    expect(message.match(/GOOGLE_API_KEY/g)).toHaveLength(1);
  });

  it("under creator_only, the message names the owner's way only — the caller's header would be refused", async () => {
    await pushGoogleAgent("key-none-creator-only", { fallback: true });
    await db.setLlmKeyPolicy("dev", "key-none-creator-only", "creator_only");

    const { seen, message } = await observe(await runAgentIn("sync", "key-none-creator-only"));

    expect(seen).toEqual(REFUSED);
    expect(message).not.toContain("X-LLM-API-Key");
    expect(message).toContain("skrun llm-key set google --agent dev/key-none-creator-only");
    expect(message).toMatch(/operator[^.]*GOOGLE_API_KEY[^.]*OPENAI_API_KEY/);
  });

  it("refused before the inputs are validated: a missing input does not answer first", async () => {
    await pushGoogleAgent("key-none-no-input");

    const res = await app.request("/api/agents/dev/key-none-no-input/run", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });

    expect((await observe(res)).seen).toEqual(REFUSED);
  });

  it("accepted when the caller brings a key for the primary only, the fallback having none", async () => {
    await pushGoogleAgent("key-primary-only", { fallback: true });
    // The run itself is scripted: no model is called, the decision is all that is tested.
    executeStream.mockImplementation(async function* (request: RunRequest) {
      const now = new Date().toISOString();
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: now,
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: now,
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });

    const res = await runAgentIn("sync", "key-primary-only", {
      "X-LLM-API-Key": JSON.stringify({ google: "k-caller-google" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("completed");
    expect(executeStream).toHaveBeenCalledOnce();
    expect((executeStream.mock.calls[0]?.[0] as RunRequest).callerKeys).toEqual({
      google: "k-caller-google",
    });
  });

  it("accepted when only the fallback has a key — and the fallback serves the run", async () => {
    await pushGoogleAgent("key-fallback-only", { fallback: true });
    // The whole local run is real — route, adapter, agent loop, router — save
    // the one place a provider would reach the network: its construction. The
    // primary, google, has no key at any tier and fails at its first call; the
    // router then turns to the fallback, which the caller's key serves.
    const built: Array<{ provider: string; apiKey: string }> = [];
    const createProvider = vi
      .spyOn(
        LLMRouter.prototype as unknown as {
          createProvider: (provider: string, apiKey: string) => unknown;
        },
        "createProvider",
      )
      .mockImplementation((provider: string, apiKey: string) => {
        built.push({ provider, apiKey });
        return {
          name: provider,
          call: async () => ({
            content: '{"answer":"from the fallback"}',
            usage: { promptTokens: 1, completionTokens: 1 },
          }),
        };
      });
    try {
      const res = await runAgentIn("sync", "key-fallback-only", {
        "X-LLM-API-Key": JSON.stringify({ openai: "k-caller-openai" }),
      });

      const body = (await res.json()) as { status?: string; output?: unknown };
      expect({ status: res.status, result: body.status, output: body.output }).toEqual({
        status: 200,
        result: "completed",
        output: { answer: "from the fallback" },
      });
      expect(built).toEqual([{ provider: "openai", apiKey: "k-caller-openai" }]);
    } finally {
      createProvider.mockRestore();
    }
  });

  it("refused when neither the primary nor the fallback has a key — the message names both", async () => {
    await pushGoogleAgent("key-none-with-fallback", { fallback: true });

    const { seen, message } = await observe(await runAgentIn("sync", "key-none-with-fallback"));

    expect(seen).toEqual(REFUSED);
    expect(message).toContain('provider "google"');
    expect(message).toContain('"openai"');
    expect(message).toContain("fallback");
    expect(message).toMatch(/operator[^.]*GOOGLE_API_KEY[^.]*OPENAI_API_KEY/);
  });

  // meta has no endpoint of its own: only a model.base_url serves it, which a
  // push requires. A version published before that, declaring none, is served
  // by no key — the caller's, one its owner attached, or the server's.
  describe("a meta model with no base_url, in a version published before the push refused it", () => {
    const KEY_ENV = "SKRUN_SECRETS_ENCRYPTION_KEY";
    const previousKey = process.env[KEY_ENV];
    const META_REFUSAL =
      "This agent's model is meta, which has no endpoint of its own, and this version declares no model.base_url: no key can serve it. Set model.base_url to the OpenAI-compatible endpoint that serves the model, then publish a new version.";

    beforeEach(() => {
      // A key its owner attaches is stored encrypted: the app reads the master key when built.
      process.env[KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
      app = createApp(storage, db);
    });

    afterEach(() => {
      if (previousKey === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = previousKey;
    });

    /** Write, as the local operator, a verified version with this model, as an older push stored it. */
    async function storeAgent(name: string, model: string[]): Promise<void> {
      await storeVersion({
        app,
        storage,
        db,
        token: "dev-token",
        namespace: "dev",
        name,
        version: "1.0.0",
        verified: true,
        agentYaml: [
          `name: ${name}`,
          "version: 1.0.0",
          "model:",
          ...model.map((line) => `  ${line}`),
          "inputs:",
          "  - name: q",
          "    type: string",
          "    required: true",
          "outputs:",
          "  - name: answer",
          "    type: string",
        ].join("\n"),
      });
    }

    const META = ["provider: meta", "name: llama-local"];

    it("with a key its owner attached for meta: refused 400 LLM_KEY_REQUIRED before the run — no adapter call, no run row", async () => {
      await storeAgent("meta-old-creator-key", META);
      const attach = await app.request("/api/agents/dev/meta-old-creator-key/llm-keys/meta", {
        method: "PUT",
        headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
        body: JSON.stringify({ key: "sk-meta-creator-0123456789abcdef" }),
      });
      expect(attach.status).toBe(200);

      const { seen, message } = await observe(await runAgentIn("sync", "meta-old-creator-key"));

      expect(seen).toEqual(REFUSED);
      expect(message).toBe(META_REFUSAL);
    });

    it("with the caller's key for meta: refused the same way", async () => {
      await storeAgent("meta-old-caller-key", META);

      const { seen, message } = await observe(
        await runAgentIn("sync", "meta-old-caller-key", {
          "X-LLM-API-Key": JSON.stringify({ meta: "k-caller-meta" }),
        }),
      );

      expect(seen).toEqual(REFUSED);
      expect(message).toBe(META_REFUSAL);
    });

    it("with a fallback that has no key either: what follows the refusal speaks of the fallback only, and of each way to serve it", async () => {
      await storeAgent("meta-old-fallback-none", [
        ...META,
        "fallback:",
        "  provider: openai",
        "  name: gpt-4o-mini",
      ]);

      const { seen, message } = await observe(await runAgentIn("sync", "meta-old-fallback-none"));

      expect(seen).toEqual(REFUSED);
      expect(message).toBe(
        `${META_REFUSAL} No model key is available for "openai", the provider of its fallback model, either. Send a key for "openai" in the X-LLM-API-Key header, e.g. {"openai": "<key>"}, or ask the agent's owner to attach one (skrun llm-key set openai --agent dev/meta-old-fallback-none). An operator can instead give this server its own key (OPENAI_API_KEY).`,
      );
    });

    it("with a fallback that has no key either, under creator_only: the owner's way for the fallback alone", async () => {
      await storeAgent("meta-old-fallback-creator-only", [
        ...META,
        "fallback:",
        "  provider: openai",
        "  name: gpt-4o-mini",
      ]);
      await db.setLlmKeyPolicy("dev", "meta-old-fallback-creator-only", "creator_only");

      const { seen, message } = await observe(
        await runAgentIn("sync", "meta-old-fallback-creator-only"),
      );

      expect(seen).toEqual(REFUSED);
      expect(message).toBe(
        `${META_REFUSAL} No model key is available for "openai", the provider of its fallback model, either. This agent runs on its owner's keys only: ask the agent's owner to attach one (skrun llm-key set openai --agent dev/meta-old-fallback-creator-only). An operator can instead give this server its own key (OPENAI_API_KEY).`,
      );
    });

    it("with a meta fallback too: the refusal alone, nothing of the fallback", async () => {
      await storeAgent("meta-old-both", [
        ...META,
        "fallback:",
        "  provider: meta",
        "  name: llama-local",
      ]);

      const { seen, message } = await observe(
        await runAgentIn("sync", "meta-old-both", {
          "X-LLM-API-Key": JSON.stringify({ meta: "k-caller-meta" }),
        }),
      );

      expect(seen).toEqual(REFUSED);
      expect(message).toBe(META_REFUSAL);
    });

    it("with a fallback that has a key: admitted, and the fallback serves the run", async () => {
      await storeAgent("meta-old-fallback-keyed", [
        ...META,
        "fallback:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-6",
      ]);
      // The whole local run is real save a provider's construction, the one
      // place it would reach the network.
      const built: Array<{ provider: string; apiKey: string }> = [];
      const createProvider = vi
        .spyOn(
          LLMRouter.prototype as unknown as {
            createProvider: (provider: string, apiKey: string) => unknown;
          },
          "createProvider",
        )
        .mockImplementation((provider: string, apiKey: string) => {
          built.push({ provider, apiKey });
          return {
            name: provider,
            call: async () => ({
              content: '{"answer":"from the fallback"}',
              usage: { promptTokens: 1, completionTokens: 1 },
            }),
          };
        });
      try {
        const res = await runAgentIn("sync", "meta-old-fallback-keyed", {
          "X-LLM-API-Key": JSON.stringify({ anthropic: "k-caller-anthropic" }),
        });

        const body = (await res.json()) as { status?: string; output?: unknown };
        expect({ status: res.status, result: body.status, output: body.output }).toEqual({
          status: 200,
          result: "completed",
          output: { answer: "from the fallback" },
        });
        expect(built).toEqual([{ provider: "anthropic", apiKey: "k-caller-anthropic" }]);
      } finally {
        createProvider.mockRestore();
      }
    });

    it("a meta fallback with no base_url, and no key for the primary: the refusal speaks of the agent as if it had no fallback", async () => {
      await storeAgent("meta-old-fallback-unserved", [
        "provider: google",
        "name: gemini-2.5-flash",
        "fallback:",
        "  provider: meta",
        "  name: llama-local",
      ]);

      const { seen, message } = await observe(
        await runAgentIn("sync", "meta-old-fallback-unserved", {
          "X-LLM-API-Key": JSON.stringify({ meta: "k-caller-meta" }),
        }),
      );

      expect(seen).toEqual(REFUSED);
      expect(message).toBe(
        'No model key is available for provider "google". Send a key for it in the X-LLM-API-Key header, e.g. {"google": "<key>"}, or ask the agent\'s owner to attach one (skrun llm-key set google --agent dev/meta-old-fallback-unserved). An operator can instead give this server its own key (GOOGLE_API_KEY).',
      );
    });

    it("a meta fallback with no base_url refuses nothing of a run its primary serves", async () => {
      await storeAgent("meta-old-fallback-only", [
        "provider: google",
        "name: gemini-2.5-flash",
        "fallback:",
        "  provider: meta",
        "  name: llama-local",
      ]);
      scriptCompletedRuns();

      const res = await runAgentIn("sync", "meta-old-fallback-only", {
        "X-LLM-API-Key": JSON.stringify({ google: "k-caller-google" }),
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("completed");
      expect(executeStream).toHaveBeenCalledOnce();
    });
  });
});

describe("POST /run — a failed run's error never carries a model key", () => {
  // A witness shaped like a provider key, never a real one. A provider's 4xx
  // can echo the key it was sent; the route must strip it before the error
  // leaves in a response or lands in the runs table.
  const WITNESS = "sk-witness-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;

  beforeEach(async () => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
    deliverWebhook.mockClear();
    const agentYaml = [
      "name: leaky-provider",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from("# leaky-provider\n") },
    ]);
    const push = await app.request("/api/agents/dev/leaky-provider/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified("dev", "leaky-provider", "1.0.0", true);
    // The run fails the way a provider refusing the key does: its message quotes the key.
    executeStream = vi
      .spyOn(LocalAdapter.prototype, "executeStream")
      .mockImplementation(async function* (request: RunRequest) {
        const now = new Date().toISOString();
        yield {
          type: "run_start",
          run_id: request.runId,
          timestamp: now,
          agent: request.agentConfig.name,
          agent_version: request.agent_version ?? "unknown",
        } satisfies RunEvent;
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: now,
          error: {
            code: "EXECUTION_FAILED",
            message: `Provider refused the request: API key ${WITNESS} is not valid.`,
          },
        } satisfies RunEvent;
      });
  });

  afterEach(() => {
    executeStream.mockRestore();
  });

  function run(body: Record<string, unknown>): Promise<Response> {
    return app.request("/api/agents/dev/leaky-provider/run", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: WITNESS }),
      },
      body: JSON.stringify({ input: { q: "hello" }, ...body }),
    });
  }

  /** The error of every run the table holds. */
  async function storedErrors(): Promise<string[]> {
    return (await db.listRuns()).map((r) => String(r.error));
  }

  it("sync: the failed result and the stored run hold the error without the key", async () => {
    const res = await run({});
    const text = await res.text();
    const body = JSON.parse(text) as { status?: string; error?: unknown };

    expect({ status: res.status, result: body.status }).toEqual({ status: 200, result: "failed" });
    const stored = await storedErrors();
    expect(stored).toHaveLength(1);
    // Both places at once, so a red shows each one that leaks.
    expect({
      keyInResponse: text.includes(WITNESS),
      keyInStoredRun: stored.some((error) => error.includes(WITNESS)),
    }).toEqual({ keyInResponse: false, keyInStoredRun: false });
    expect(String(body.error)).toContain("Provider refused the request");
  });

  it("webhook: the delivered payload and the stored run hold the error without the key", async () => {
    const res = await run({ webhook_url: "https://hooks.example.com/x" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());

    const payload = JSON.stringify(deliverWebhook.mock.calls[0]?.[1]);
    expect(payload).not.toContain(WITNESS);
    expect(payload).toContain("Provider refused the request");
    await vi.waitFor(async () => expect(await storedErrors()).toEqual([expect.any(String)]));
    for (const error of await storedErrors()) expect(error).not.toContain(WITNESS);
  });
});

// On the local runtime a run launches its scripts from the extracted bundle
// while it goes on, so the run holds the extraction until it ends: an expiry,
// a sweep or the size bound in the meantime leaves the directory where it is.
// Whatever way the run ends — a response, a refusal, an error thrown, or later,
// when the stream or the webhook task is done — the hold is given back.
describe("POST /run — a local run holds its bundle extraction and its output directory until it ends", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;
  // Holds are counted per process: each case reads its own, from where it began,
  // so a hold another case failed to give back cannot redden this one.
  let baseline = 0;
  let outputBaseline = 0;
  const held = (): number => bundleExtractionsInUse() - baseline;
  const heldOutputs = (): number => outputDirHolds() - outputBaseline;

  beforeEach(() => {
    baseline = bundleExtractionsInUse();
    outputBaseline = outputDirHolds();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { verificationPolicy: "owner", runtimeMode: "local" });
    deliverWebhook.mockClear();
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bundleCache.clear();
  });

  function agentYaml(name: string): string {
    return [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
  }

  /** Push the bundle, by the route, as the local operator; return its bytes. */
  async function push(
    name: string,
    files: Array<{ name: string; content: string }> = [
      { name: "agent.yaml", content: agentYaml(name) },
      { name: "SKILL.md", content: `# ${name}\n` },
    ],
  ): Promise<Buffer> {
    const bundle = await packAgentTar(
      files.map((f) => ({ name: f.name, content: Buffer.from(f.content) })),
    );
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    return bundle;
  }

  function runIn(mode: "sync" | "sse" | "webhook", name: string): Promise<Response> {
    const body: Record<string, unknown> = { input: { q: "hello" } };
    if (mode === "webhook") body.webhook_url = "https://hooks.example.com/x";
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
        ...(mode === "sse" && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Script the adapter: each run completes once `gate` resolves, and calls
   * `started` as it begins. No model is called.
   */
  function scriptRuns(
    gate: Promise<void> = Promise.resolve(),
    started: (request: RunRequest) => void = () => {},
  ) {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      const now = new Date().toISOString();
      started(request);
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: now,
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      await gate;
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: now,
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
    execute.mockImplementation(async (request: RunRequest) => {
      started(request);
      await gate;
      return {
        runId: request.runId,
        status: "completed",
        output: { answer: "ok" },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
        durationMs: 1,
        files: [],
      };
    });
  }

  /** Read a response to its end: a stream's run is over once its body is. */
  async function finish(mode: "sync" | "sse" | "webhook", res: Response): Promise<void> {
    await res.text();
    if (mode === "webhook") await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
  }

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: the hold is given back once the run is over", async (mode) => {
    await push(`hold-done-${mode}`);
    scriptRuns();
    const res = await runIn(mode, `hold-done-${mode}`);
    expect(res.status).toBe(mode === "webhook" ? 202 : 200);
    await finish(mode, res);
    await vi.waitFor(() => expect(held()).toBe(0));
    expect(heldOutputs()).toBe(0);
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(1);
  });

  // A caller that drops its stream does not end the run: the run goes on,
  // holding what it holds, and gives it back when it ends.
  it("sse: a caller that drops the stream mid-run leaves the run holding until it ends", async () => {
    await push("hold-sse-dropped");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let started!: (request: RunRequest) => void;
    const running = new Promise<RunRequest>((resolve) => {
      started = resolve;
    });
    scriptRuns(gate, started);

    const res = await runIn("sse", "hold-sse-dropped");
    expect(res.status).toBe(200);
    await running;
    await res.body?.cancel();
    expect(held()).toBe(1);
    expect(heldOutputs()).toBe(1);

    open();
    await vi.waitFor(() => expect(held()).toBe(0));
    expect(heldOutputs()).toBe(0);
  });

  it("a refusal after the extraction gives the hold back", async () => {
    // A version stored without agent.yaml — as a push stored one before it
    // refused such a bundle.
    await storeVersion({
      app,
      storage,
      db,
      token: "dev-token",
      namespace: "dev",
      name: "hold-no-config",
      version: "1.0.0",
      bundle: await packAgentTar([{ name: "SKILL.md", content: Buffer.from("# no config\n") }]),
    });
    const res = await runIn("sync", "hold-no-config");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MISSING_CONFIG");
    expect(held()).toBe(0);
    expect(heldOutputs()).toBe(0);
  });

  it("an error thrown while the run's tools are set up gives the hold back", async () => {
    await push("hold-tools-throw", [
      { name: "agent.yaml", content: agentYaml("hold-tools-throw") },
      { name: "SKILL.md", content: "# tools\n" },
      { name: "scripts/hello.sh", content: "echo hi\n" },
    ]);
    const addProvider = vi
      .spyOn(ToolRegistry.prototype, "addProvider")
      .mockRejectedValue(new Error("tool setup broke"));
    const res = await runIn("sync", "hold-tools-throw");
    expect(addProvider).toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(held()).toBe(0);
    expect(heldOutputs()).toBe(0);
  });

  it("a run row that cannot be written gives the hold back", async () => {
    await push("hold-row-rejects");
    const admitRun = vi.spyOn(db, "admitRun").mockRejectedValue(new Error("database down"));
    const res = await runIn("sync", "hold-row-rejects");
    expect(admitRun).toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(held()).toBe(0);
    expect(heldOutputs()).toBe(0);
  });

  it("a synchronous run whose execution throws gives the hold back", async () => {
    await push("hold-sync-throws");
    execute.mockRejectedValue(new Error("the adapter broke"));
    const res = await runIn("sync", "hold-sync-throws");
    expect(res.status).toBe(502);
    expect(held()).toBe(0);
    expect(heldOutputs()).toBe(0);
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: a run held while its extraction expires and a sweep passes keeps the directory until it ends", async (mode) => {
    const bytes = await push(`hold-long-${mode}`);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let started!: (request: RunRequest) => void;
    const running = new Promise<RunRequest>((resolve) => {
      started = resolve;
    });
    scriptRuns(gate, started);

    const pending = runIn(mode, `hold-long-${mode}`);
    const request = await running;
    // A stream or a webhook run answers while it goes on: once its response is
    // out, the handler has returned, and the run must still hold.
    const answered = mode === "sync" ? undefined : await pending;
    const key = createHash("sha256").update(bytes).digest("hex");
    const dir = bundleCache.get(key)?.dir;
    expect(dir).toBeDefined();

    // The clock is past the cache's 600 s, and the sweep passes.
    expect(bundleCache.sweep(Date.now() + 601_000)).toBe(1);
    expect(bundleCache.get(key)).toBeUndefined();
    expect(existsSync(dir as string)).toBe(true);
    expect(held()).toBe(1);

    // Its output directory, made when it started, is held too: the sweep sets
    // its time ahead, out of reach of the orphan pass of an instance sharing
    // the temp root.
    expect(heldOutputs()).toBe(1);
    const outputDir = request.outputDir as string;
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(outputDir, longAgo, longAgo);
    sweepExpiredFiles();
    expect(statSync(outputDir).mtimeMs).toBeGreaterThan(Date.now());

    open();
    await finish(mode, answered ?? (await pending));
    await vi.waitFor(() => expect(held()).toBe(0));
    expect(heldOutputs()).toBe(0);
    expect(existsSync(dir as string)).toBe(false);
  });
});

// The dev-token fallback can serve a caller whose account it could not record:
// the caller then carries an identity no account row stands behind. The run's
// row names no account — on every backend, where a foreign key, or the
// in-memory store's own check, would refuse an id that names nothing.
describe("POST /run — a dev-token run whose account could not be recorded names no account", () => {
  const backends: Array<[string, () => DbAdapter]> = [
    ["memory", () => new MemoryDb()],
    ["sqlite", () => new SqliteDb(":memory:")],
  ];
  let executeStream: MockInstance;

  beforeEach(() => {
    deliverWebhook.mockClear();
    executeStream = vi
      .spyOn(LocalAdapter.prototype, "executeStream")
      .mockImplementation(async function* (request: RunRequest) {
        const now = new Date().toISOString();
        yield {
          type: "run_start",
          run_id: request.runId,
          timestamp: now,
          agent: request.agentConfig.name,
          agent_version: request.agent_version ?? "unknown",
        } satisfies RunEvent;
        yield {
          type: "run_complete",
          run_id: request.runId,
          timestamp: now,
          output: { answer: "ok" },
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: { estimated: 0 },
          duration_ms: 1,
          files: [],
        } satisfies RunEvent;
      });
  });

  afterEach(() => {
    executeStream.mockRestore();
    vi.restoreAllMocks();
  });

  it.each(
    backends,
  )("%s: the run completes and its row carries no account", async (_label, makeDb) => {
    const db = makeDb();
    const app = createApp(new MemoryStorage(), db);
    const agentYaml = [
      "name: no-account-row",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from("# no-account-row\n") },
    ]);
    const push = await app.request("/api/agents/dev/no-account-row/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified("dev", "no-account-row", "1.0.0", true);

    // The dev-token's account is looked up, then created when absent: here
    // the lookup finds nothing and the creation fails.
    vi.spyOn(db, "getUserByGithubId").mockResolvedValue(null);
    const create = vi.spyOn(db, "createUser").mockRejectedValue(new Error("database unavailable"));

    const res = await app.request("/api/agents/dev/no-account-row/run", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-key-for-the-test" }),
      },
      body: JSON.stringify({ input: { q: "hello" } }),
    });

    expect(create).toHaveBeenCalled();
    // The body is read as text first, so a failure shows what the route said.
    const text = await res.text();
    expect({
      status: res.status,
      result: res.ok ? (JSON.parse(text) as { status?: string }).status : text,
    }).toEqual({
      status: 200,
      result: "completed",
    });
    const runs = await db.listRuns();
    expect(runs.map((r) => ({ user_id: r.user_id, status: r.status }))).toEqual([
      { user_id: null, status: "completed" },
    ]);
  });
});

// The caller learns how many of a run's output files were left out, and why, in
// whichever shape it asked for the result: the sync result, the webhook's
// payload and the stream's run_complete all carry the counts the adapter gave,
// and an empty object when nothing was left out — never absent.
describe("POST /run — every response shape says how many output files were left out, by reason", () => {
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  /** What the adapter's run_complete says was left out, per case. */
  let leftOut: Record<string, number>;

  beforeEach(async () => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
    deliverWebhook.mockClear();
    const agentYaml = [
      "name: leaves-files-out",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from("# leaves-files-out\n") },
    ]);
    const push = await app.request("/api/agents/dev/leaves-files-out/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified("dev", "leaves-files-out", "1.0.0", true);
    executeStream = vi
      .spyOn(LocalAdapter.prototype, "executeStream")
      .mockImplementation(async function* (request: RunRequest) {
        const now = new Date().toISOString();
        yield {
          type: "run_start",
          run_id: request.runId,
          timestamp: now,
          agent: request.agentConfig.name,
          agent_version: request.agent_version ?? "unknown",
        } satisfies RunEvent;
        yield {
          type: "run_complete",
          run_id: request.runId,
          timestamp: now,
          output: { answer: "done" },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: { estimated: 0 },
          duration_ms: 1,
          files: [],
          files_excluded: leftOut,
        } satisfies RunEvent;
      });
  });

  afterEach(() => {
    executeStream.mockRestore();
  });

  function run(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request("/api/agents/dev/leaves-files-out/run", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-key-for-the-test" }),
        ...headers,
      },
      body: JSON.stringify({ input: { q: "hello" }, ...body }),
    });
  }

  async function syncResult(): Promise<Record<string, unknown>> {
    const res = await run({});
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function webhookPayload(): Promise<Record<string, unknown>> {
    const res = await run({ webhook_url: "https://hooks.example.com/x" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    return deliverWebhook.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  async function streamedComplete(): Promise<Record<string, unknown>> {
    const res = await run({}, { Accept: "text/event-stream" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const complete = events.find((e) => e.event === "run_complete");
    return complete?.data as Record<string, unknown>;
  }

  it.each([
    ["the sync result", syncResult],
    ["the webhook's payload", webhookPayload],
    ["the stream's run_complete", streamedComplete],
  ])("%s carries the counts the run's end gave", async (_shape, read) => {
    leftOut = { too_large: 2, upload_budget: 1 };

    const result = await read();

    expect(result.files_excluded).toEqual({ too_large: 2, upload_budget: 1 });
  });

  it.each([
    ["the sync result", syncResult],
    ["the webhook's payload", webhookPayload],
    ["the stream's run_complete", streamedComplete],
  ])("%s carries an empty object when nothing was left out", async (_shape, read) => {
    leftOut = {};

    const result = await read();

    expect(result).toHaveProperty("files_excluded");
    expect(result.files_excluded).toEqual({});
  });

  it("the sync result of a failed run carries an empty object too, as it carries an empty file list", async () => {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: { code: "EXECUTION_FAILED", message: "the model refused" },
      } satisfies RunEvent;
    });

    const result = await syncResult();

    expect(result.status).toBe("failed");
    expect(result.files).toEqual([]);
    expect(result.files_excluded).toEqual({});
  });
});

// --- How a run ends, as the caller and the runs table see it ---

const DEV_AUTH = { Authorization: "Bearer dev-token" };

/** Push a local agent the dev token owns, by the route; `environment` goes in its agent.yaml. */
async function pushLocalAgent(
  app: ReturnType<typeof createApp>,
  name: string,
  environment: string[] = [],
): Promise<void> {
  const agentYaml = localAgentYaml(name, environment);
  const bundle = await packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYaml) },
    { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
  ]);
  const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
    method: "POST",
    headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bundle),
  });
  expect(res.status).toBe(200);
}

/**
 * Write, at 1.0.0, a local agent the dev token owns to storage directly —
 * a version published before the push refused what its `environment` declares.
 */
async function storeLocalAgent(
  app: ReturnType<typeof createApp>,
  storage: MemoryStorage,
  db: DbAdapter,
  name: string,
  environment: string[],
): Promise<void> {
  await storeVersion({
    app,
    storage,
    db,
    token: "dev-token",
    namespace: "dev",
    name,
    version: "1.0.0",
    agentYaml: localAgentYaml(name, environment),
  });
}

/** The agent.yaml of a local agent: google's model, one input, one output, `environment` as written. */
function localAgentYaml(name: string, environment: string[] = []): string {
  return [
    `name: ${name}`,
    "version: 1.0.0",
    "model:",
    "  provider: google",
    "  name: gemini-2.5-flash",
    "inputs:",
    "  - name: q",
    "    type: string",
    "outputs:",
    "  - name: answer",
    "    type: string",
    ...(environment.length > 0 ? ["environment:", ...environment.map((line) => `  ${line}`)] : []),
  ].join("\n");
}

/** Run the dev token's `name` in `mode`; `signal` is the caller's, to hang up with. */
function startRun(
  app: ReturnType<typeof createApp>,
  mode: "sync" | "sse" | "webhook",
  name: string,
  signal?: AbortSignal,
): Promise<Response> {
  const body: Record<string, unknown> = { input: { q: "hello" } };
  if (mode === "webhook") body.webhook_url = "https://hooks.example.com/x";
  return app.request(`/api/agents/dev/${name}/run`, {
    method: "POST",
    headers: {
      ...DEV_AUTH,
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      ...(mode === "sse" && { Accept: "text/event-stream" }),
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** A stream's events, read one at a time, each as it arrives. */
function streamedEvents(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    /** The next event, or null once the stream has ended. */
    async next(): Promise<{ event: string; data: Record<string, unknown> } | null> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const [parsed] = parseSseEvents(block);
          if (parsed) return parsed as { event: string; data: Record<string, unknown> };
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    /** The caller stops reading: it hangs up. */
    cancel: () => reader.cancel(),
  };
}

/**
 * Whether `pending` settles within a few turns of the event loop. No timer is
 * involved, so a clock the case has stopped does not move it.
 */
async function settlesSoon(pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 50 && !settled; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return settled;
}

/** The run's row as `GET /api/runs/:id` serves it. */
async function servedRun(
  app: ReturnType<typeof createApp>,
  runId: string,
): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/runs/${runId}`, { headers: DEV_AUTH });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A promise and the function that settles it. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

// A streamed run's final event leaves once the run's final status is written:
// a caller who reads run_complete, or run_error, and then asks for the run —
// or starts the next one — finds it finished. The wait has a bound, ten
// seconds: a write still going then lets the event go, and a log line says
// so. The clock is the test's from the moment the run starts, so nothing here
// waits for real, and no timer is left armed once a case is over.
describe("POST /run — a streamed run's final event follows the write of its status", () => {
  const TEN_SECONDS = 10_000;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;

  beforeEach(async () => {
    logLines.length = 0;
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    await pushLocalAgent(app, "final-event");
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    bundleCache.clear();
  });

  /**
   * The adapter's run: run_start, then its final event — run_complete or
   * run_error — once `gate` opens. The test's clock takes over as it starts.
   */
  function scriptRun(end: "completed" | "failed", gate: Promise<void>): void {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const now = new Date().toISOString();
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: now,
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      await gate;
      if (end === "completed") {
        yield {
          type: "run_complete",
          run_id: request.runId,
          timestamp: now,
          output: { answer: "ok" },
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: { estimated: 0 },
          duration_ms: 1,
          files: [],
        } satisfies RunEvent;
      } else {
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: now,
          error: { code: "EXECUTION_FAILED", message: "the model refused" },
        } satisfies RunEvent;
      }
    });
  }

  /** The final write, held: it begins, and lands only once released — or never. */
  function holdTheFinalWrite() {
    const realFinishRun = db.finishRun.bind(db);
    const begun = signal();
    const released = signal();
    const finishRun = vi.spyOn(db, "finishRun").mockImplementation(async (...args) => {
      begun.fire();
      await released.promise;
      return realFinishRun(...args);
    });
    return { begun: begun.promise, release: released.fire, finishRun };
  }

  /** Start the run, read its run_start, let it end; its final write has begun. */
  async function untilTheFinalWrite(end: "completed" | "failed") {
    const write = holdTheFinalWrite();
    const gate = signal();
    scriptRun(end, gate.promise);
    const res = await startRun(app, "sse", "final-event");
    expect(res.status).toBe(200);
    const events = streamedEvents(res);
    const start = await events.next();
    expect(start?.event).toBe("run_start");
    const runId = String(start?.data.run_id);
    gate.fire();
    await write.begun;
    return { write, events, runId };
  }

  it.each([
    ["run_complete", "completed"],
    ["run_error", "failed"],
  ] as const)("%s leaves only once the run's status is written: a caller who reads it finds the run %s", async (eventName, status) => {
    const { write, events, runId } = await untilTheFinalWrite(status);

    const final = events.next();
    expect(await settlesSoon(final)).toBe(false);
    expect((await db.getRun(runId))?.status).toBe("running");

    write.release();
    expect((await final)?.event).toBe(eventName);
    // The wait's bound was disarmed when the write landed.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(await servedRun(app, runId)).toMatchObject({ status });
    expect(write.finishRun).toHaveBeenCalledTimes(1);
    expect(logLines.filter((line) => line.event === "final_write_slow")).toEqual([]);
  });

  it.each([
    ["run_complete", "completed"],
    ["run_error", "failed"],
  ] as const)("a write that does not end holds %s ten seconds, no more: the event then goes, and a log line says so", async (eventName, status) => {
    const { events, runId } = await untilTheFinalWrite(status);

    const final = events.next();
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(await settlesSoon(final)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settlesSoon(final)).toBe(true);
    expect((await final)?.event).toBe(eventName);
    expect(logLines.filter((line) => line.event === "final_write_slow")).toEqual([
      expect.objectContaining({ run_id: runId, status, waited_ms: TEN_SECONDS }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    // The write never landed: the row is still the one admitted.
    expect((await db.getRun(runId))?.status).toBe("running");
  });

  // The final write's attempts are spaced — one second, then four more — and a
  // database that refuses slowly makes each slow: the write outlasts the bound.
  // The event goes at the bound, the stream ends, and the run is still in
  // flight until its last attempt has ended: only then has it settled, which
  // is what the server's stop waits for.
  it("a write whose spaced attempts outlast the bound: run_complete goes at ten seconds, and the run settles only once its last attempt has ended", async () => {
    const SLOW_REFUSAL_MS = 3_000;
    const [second, third] = FINAL_WRITE_RETRY_DELAYS_MS;
    const begun = signal();
    const finishRun = vi.spyOn(db, "finishRun").mockImplementation(async () => {
      begun.fire();
      await new Promise((resolve) => setTimeout(resolve, SLOW_REFUSAL_MS));
      throw Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
    });
    const gate = signal();
    scriptRun("completed", gate.promise);
    const res = await startRun(app, "sse", "final-event");
    expect(res.status).toBe(200);
    const events = streamedEvents(res);
    const start = await events.next();
    const runId = String(start?.data.run_id);
    gate.fire();
    await begun.promise;

    // Attempt 1 refused at 3 s; attempt 2 from 4 s, refused at 7 s; attempt 3
    // from 11 s, refused at 14 s. The event goes at the bound, 10 s.
    const final = events.next();
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(await settlesSoon(final)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await final)?.event).toBe("run_complete");
    expect(await events.next()).toBeNull();
    expect(finishRun).toHaveBeenCalledTimes(2);
    // The stream has ended; the run has not settled: its write goes on.
    expect(inFlightRunIds()).toContain(runId);

    const lastRefusedAt = 3 * SLOW_REFUSAL_MS + second + third;
    await vi.advanceTimersByTimeAsync(lastRefusedAt - TEN_SECONDS - 1);
    expect(finishRun).toHaveBeenCalledTimes(3);
    expect(inFlightRunIds()).toContain(runId);
    await vi.advanceTimersByTimeAsync(1);
    expect(inFlightRunIds()).not.toContain(runId);
    expect(vi.getTimerCount()).toBe(0);
    expect((await db.getRun(runId))?.status).toBe("running");
  });

  // The same when the adapter throws instead of ending on a final event: the
  // run's failure, written by the net under the stream, is its final write,
  // waited for the same way, and its spaced attempts outlast the bound as
  // well. The stream ends at the bound, without a final event; the run is
  // still in flight until the last attempt has ended.
  it("an adapter that throws, its failure's spaced attempts outlasting the bound: the stream ends at ten seconds, and the run settles only once its last attempt has ended", async () => {
    const SLOW_REFUSAL_MS = 3_000;
    const [second, third] = FINAL_WRITE_RETRY_DELAYS_MS;
    const begun = signal();
    const finishRun = vi.spyOn(db, "finishRun").mockImplementation(async () => {
      begun.fire();
      await new Promise((resolve) => setTimeout(resolve, SLOW_REFUSAL_MS));
      throw Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
    });
    const gate = signal();
    executeStream.mockImplementation(async function* (request: RunRequest) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      await gate.promise;
      throw new Error("the adapter broke");
    });
    const res = await startRun(app, "sse", "final-event");
    expect(res.status).toBe(200);
    const events = streamedEvents(res);
    const start = await events.next();
    const runId = String(start?.data.run_id);
    gate.fire();
    await begun.promise;

    // Attempt 1 refused at 3 s; attempt 2 from 4 s, refused at 7 s; attempt 3
    // from 11 s, refused at 14 s. The stream ends at the bound, 10 s.
    const end = events.next();
    await vi.advanceTimersByTimeAsync(TEN_SECONDS - 1);
    expect(await settlesSoon(end)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await end).toBeNull();
    expect(finishRun).toHaveBeenCalledTimes(2);
    expect(logLines.filter((line) => line.event === "sse_stream_failed")).toEqual([
      expect.objectContaining({ run_id: runId, error_name: "Error" }),
    ]);
    // The stream has ended; the run has not settled: its write goes on.
    expect(inFlightRunIds()).toContain(runId);

    const lastRefusedAt = 3 * SLOW_REFUSAL_MS + second + third;
    await vi.advanceTimersByTimeAsync(lastRefusedAt - TEN_SECONDS - 1);
    expect(finishRun).toHaveBeenCalledTimes(3);
    expect(inFlightRunIds()).toContain(runId);
    await vi.advanceTimersByTimeAsync(1);
    expect(inFlightRunIds()).not.toContain(runId);
    expect(vi.getTimerCount()).toBe(0);
    expect((await db.getRun(runId))?.status).toBe("running");
  });
});

// However a run ends — by an exception rather than a final event of its own,
// a caller who hangs up, its timeout, or an exception before it was handed to
// its stream or its background task — its row ends with a final status, and
// only once: what ended first stays.
describe("POST /run — a run that ends without a final event of its own still ends with a final status", () => {
  const UNEXPECTED_END = "The run ended unexpectedly.";
  const THROWN = [
    ["an Error", () => new Error("the adapter broke")],
    ["a value that is not an Error", () => "boom"],
  ] as const;
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let finishRun: MockInstance;

  beforeEach(async () => {
    logLines.length = 0;
    deliverWebhook.mockClear();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { verificationPolicy: "owner", runtimeMode: "local" });
    await pushLocalAgent(app, "ends");
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    finishRun = vi.spyOn(db, "finishRun");
  });

  afterEach(() => {
    stateCallbacksFault.error = undefined;
    vi.restoreAllMocks();
    bundleCache.clear();
  });

  /** The adapter's run: run_start, then what `rest` yields — or throws. */
  function scriptRun(rest: (request: RunRequest) => AsyncGenerator<RunEvent>): void {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      } satisfies RunEvent;
      yield* rest(request);
    });
  }

  function completion(request: RunRequest): RunEvent {
    return {
      type: "run_complete",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      output: { answer: "ok" },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 1,
      files: [],
    };
  }

  /** What the cloud adapter yields once its caller has hung up. */
  function abandoned(request: RunRequest): RunEvent {
    return {
      type: "run_error",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      error: { code: "ABORTED", message: "Run aborted by caller mid-iteration" },
    };
  }

  /** Settles once the caller has hung up. */
  function hungUp(request: RunRequest): Promise<void> {
    return new Promise((resolve) => {
      if (request.abortSignal?.aborted) resolve();
      request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /** The one run of the store. */
  async function theRun(): Promise<Run> {
    const [run, ...others] = await db.listRuns();
    expect(others).toEqual([]);
    if (!run) throw new Error("no run was recorded");
    return run;
  }

  function linesOf(event: string): Array<Record<string, unknown>> {
    return logLines.filter((line) => line.event === event);
  }

  it.each(
    THROWN,
  )("sse: an adapter that throws %s, not a run_error, ends the run failed", async (_what, thrown) => {
    // A value that is not an Error is printed by the streaming helper itself.
    vi.spyOn(console, "error").mockImplementation(() => {});
    scriptRun(async function* () {
      yield* [];
      throw thrown();
    });

    const res = await startRun(app, "sse", "ends");
    expect(res.status).toBe(200);
    await res.text();

    const run = await theRun();
    expect(run).toMatchObject({ status: "failed", error: UNEXPECTED_END });
    expect(run.completed_at).not.toBeNull();
    expect(finishRun).toHaveBeenCalledTimes(1);
    // The stream settled the run as it ended: it left the runs in flight.
    expect(inFlightRunIds()).not.toContain(run.id);
  });

  it.each(
    THROWN,
  )("webhook: a background run whose adapter throws %s ends failed", async (_what, thrown) => {
    scriptRun(async function* () {
      yield* [];
      throw thrown();
    });

    const res = await startRun(app, "webhook", "ends");
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(linesOf("webhook_bg_error")).toHaveLength(1));

    const run = await theRun();
    expect(run).toMatchObject({ status: "failed", error: UNEXPECTED_END });
    expect(run.completed_at).not.toBeNull();
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it("webhook: a delivery that throws after the run completed leaves the run completed", async () => {
    scriptRun(async function* (request) {
      yield completion(request);
    });
    deliverWebhook.mockRejectedValueOnce(new Error("the delivery broke"));

    const res = await startRun(app, "webhook", "ends");
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(linesOf("webhook_bg_error")).toHaveLength(1));

    expect(deliverWebhook).toHaveBeenCalledOnce();
    const run = await theRun();
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(linesOf("run_finalize_skipped")).toEqual([]);
    // The background task settled the run as it ended: it left the runs in flight.
    await vi.waitFor(() => expect(inFlightRunIds()).not.toContain(run.id));
  });

  it("sse: a caller who hangs up mid-run, on an adapter that stops on it as the cloud one does, ends the run failed", async () => {
    scriptRun(async function* (request) {
      await hungUp(request);
      yield abandoned(request);
    });
    const caller = new AbortController();

    const res = await startRun(app, "sse", "ends", caller.signal);
    const events = streamedEvents(res);
    expect((await events.next())?.event).toBe("run_start");
    caller.abort();
    await events.cancel();

    await vi.waitFor(async () => expect((await theRun()).status).toBe("failed"));
    expect(await theRun()).toMatchObject({ error: "Run aborted by caller mid-iteration" });
    expect(finishRun).toHaveBeenCalledTimes(1);
  });

  it("sse: a run past its timeout ends failed — the adapter's own terminus, before any model call", async () => {
    // 0s is outside the timeout range agent.yaml accepts: the version is written
    // to storage directly, as one published before that range was. It still
    // runs, and ends at once.
    await storeLocalAgent(app, storage, db, "ends-at-once", ["timeout: 0s"]);
    executeStream.mockRestore();

    const res = await startRun(app, "sse", "ends-at-once");
    const events = parseSseEvents(await res.text());

    expect(events.at(-1)).toMatchObject({
      event: "run_error",
      data: { error: { code: "TIMEOUT" } },
    });
    const run = await theRun();
    expect(run).toMatchObject({ status: "failed", error: "Execution timed out after 0s" });
    expect(run.completed_at).not.toBeNull();
    expect(finishRun).toHaveBeenCalledTimes(1);
  });

  it("sse: a caller who hangs up right after the final event leaves the run completed — its adapter, closed at that event, goes no further and nothing is written again", async () => {
    const adapterEnded = signal();
    let wentOn = false;
    scriptRun(async function* (request) {
      try {
        yield completion(request);
        // Were the cloud adapter to see its caller go after the end: the route
        // closes the adapter at its final event, so this is never reached.
        wentOn = true;
        await hungUp(request);
        yield abandoned(request);
      } finally {
        adapterEnded.fire();
      }
    });
    const caller = new AbortController();

    const res = await startRun(app, "sse", "ends", caller.signal);
    const events = streamedEvents(res);
    const start = await events.next();
    expect(start?.event).toBe("run_start");
    expect((await events.next())?.event).toBe("run_complete");
    caller.abort();
    await events.cancel();
    await adapterEnded.promise;

    expect(wentOn).toBe(false);
    const run = await theRun();
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(linesOf("run_finalize_skipped")).toEqual([]);
    await vi.waitFor(() => expect(inFlightRunIds()).not.toContain(run.id));
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an exception after the run's row is written and before its mode runs ends the run failed", async (mode) => {
    stateCallbacksFault.error = new Error("the run's adapter could not be built");

    const res = await startRun(app, mode, "ends");

    expect(res.status).toBe(500);
    const run = await theRun();
    expect(run).toMatchObject({ status: "failed", error: UNEXPECTED_END });
    expect(run.completed_at).not.toBeNull();
    expect(finishRun).toHaveBeenCalledTimes(1);
    expect(executeStream).not.toHaveBeenCalled();
    // Settled by the route's handler: no entry is left for it among the runs in flight.
    expect(inFlightRunIds()).not.toContain(run.id);
  });
});

// A run is admitted as its row is written: counted for its account, held to its
// plan's seats and compute and to the instance's cap. A pre-check reads the same
// before the bundle is pulled, so that a run with no room costs no pull; the
// admission reads it again as it writes. With no quota set, nothing is read and
// every run is written as before.
describe("POST /run — the pre-check and the admission", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let executeStream: MockInstance;
  let execute: MockInstance;

  /** The app, with these quota settings as the server would have read them. */
  function appWith(env: QuotaEnv): ReturnType<typeof createApp> {
    return createApp(storage, db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
      quotaConfig: parseQuotaEnv(env),
    });
  }

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    deliverWebhook.mockClear();
    stateCallbacksBuilt.count = 0;
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Each run completes once `gate` resolves; no model is called. */
  function scriptRuns(gate: Promise<void> = Promise.resolve()): void {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      await gate;
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
    execute.mockImplementation(async (request: RunRequest) => {
      await gate;
      return {
        runId: request.runId,
        status: "completed",
        output: { answer: "ok" },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
        durationMs: 1,
        files: [],
      };
    });
  }

  /**
   * A synchronous run of the dev token's `name`, with its own input and, when
   * given, an environment override: answered once its row is finished.
   */
  function runWith(
    app: ReturnType<typeof createApp>,
    name: string,
    body: { q: string; environment?: Record<string, unknown> },
  ): Promise<Response> {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: JSON.stringify({
        input: { q: body.q },
        ...(body.environment && { environment: body.environment }),
      }),
    });
  }

  /** How long past its creation a run's seat is held, read from its row. */
  function heldFor(run: Run): number {
    return Date.parse(String(run.deadline_at)) - Date.parse(run.created_at);
  }

  it("an account at its seat limit is refused at the pre-check — 429 CONCURRENCY_LIMIT_REACHED, before its bundle is pulled, nothing written — and admitted again once its run ends", async () => {
    const app = appWith({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" });
    await pushLocalAgent(app, "seat-full");
    const gate = signal();
    scriptRuns(gate.promise);
    const first = await startRun(app, "webhook", "seat-full");
    expect(first.status).toBe(202);

    const pulls = vi.spyOn(MemoryStorage.prototype, "get");
    const admissions = vi.spyOn(db, "admitRun");
    const second = await startRun(app, "sync", "seat-full");
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("10");
    expect(second.headers.get("X-Quota-Runs-Limit")).toBe("1");
    expect(second.headers.get("X-Quota-Runs-Remaining")).toBe("0");
    expect(await second.json()).toEqual({
      error: {
        code: "CONCURRENCY_LIMIT_REACHED",
        message: "1 run in progress on this account; your plan's limit is 1.",
      },
    });
    expect(pulls).not.toHaveBeenCalled();
    expect(admissions).not.toHaveBeenCalled();
    expect(await db.listRuns()).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();

    // Its seat frees with its final status: the next run is admitted at once.
    gate.fire();
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    const third = await startRun(app, "sync", "seat-full");
    expect(third.status).toBe(200);
    expect(await db.listRuns()).toHaveLength(2);
  });

  it("a run the pre-check let through and its admission refuses — another run took the last seat between the two — is refused 429 at its write: no row, no 202, no adapter, no output directory", async () => {
    const app = appWith({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" });
    await pushLocalAgent(app, "seat-race");
    const owner = (await db.getAgent("dev", "seat-race"))?.owner_id as string;
    scriptRuns();
    const read = db.getAccountUsage.bind(db);
    const admit = db.admitRun.bind(db);
    // The pre-check reads a free seat; before the run's admission, another
    // run of the same account is admitted and takes it.
    vi.spyOn(db, "getAccountUsage").mockImplementation(async (userId, at) => {
      const usage = await read(userId, at);
      await admit({
        run: {
          id: "run-slipped-in",
          agent_id: null,
          agent_version: "dev/seat-race@1.0.0",
          user_id: owner,
        },
        now: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
        windowStart: null,
        limits: { concurrentRuns: 1, computeMs: null, fastRunsPerHour: null, instanceCap: null },
        poolRunning: false,
      });
      return usage;
    });
    const admitted: string[] = [];
    vi.spyOn(db, "admitRun").mockImplementation(async (admission) => {
      admitted.push(admission.run.id);
      return admit(admission);
    });

    const res = await startRun(app, "webhook", "seat-race");

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "CONCURRENCY_LIMIT_REACHED" } });
    expect((await db.listRuns()).map((run) => run.id)).toEqual(["run-slipped-in"]);
    expect(admitted).toHaveLength(1);
    expect(deliverWebhook).not.toHaveBeenCalled();
    expect(stateCallbacksBuilt.count).toBe(0);
    expect(executeStream).not.toHaveBeenCalled();
    expect(inFlightRunIds()).not.toContain(admitted[0]);
    // The output directory made for it before its admission is gone.
    expect(existsSync(join(tmpdir(), `${OUTPUT_DIR_PREFIX}${admitted[0]}`))).toBe(false);
  });

  it("with no quota set, fifty runs at once are all admitted, none told any number — and a version declaring a timeout of 9999999999999 s holds its seat for a date", async () => {
    const app = appWith({});
    await pushLocalAgent(app, "no-quota");
    // Outside the timeout range agent.yaml accepts: written to storage directly,
    // as a version published before that range was.
    await storeLocalAgent(app, storage, db, "no-quota-far", ['timeout: "9999999999999s"']);
    scriptRuns();
    const reads = vi.spyOn(db, "getAccountUsage");

    const answers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => runWith(app, "no-quota", { q: `run ${i}` })),
    );
    const far = await runWith(app, "no-quota-far", { q: "far" });

    expect(answers.map((res) => res.status)).toEqual(Array.from({ length: 50 }, () => 200));
    expect(answers.every((res) => res.headers.get("X-Quota-Runs-Limit") === null)).toBe(true);
    expect(far.status).toBe(200);
    expect(reads).not.toHaveBeenCalled();
    const rows = await db.listRuns({ limit: 100 });
    expect(rows).toHaveLength(51);
    const farRow = rows.find((run) => run.input?.q === "far") as Run;
    // The timeout counts for the longest timer this process can arm, at most.
    expect(heldFor(farRow)).toBe(
      2_147_483_647 + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST }),
    );
  });

  it.each([
    ["no instance cap: the platform's burst of creations", {}, FLY_APP_ACTION_BURST],
    [
      "an instance cap of twenty: twenty creations at once",
      { SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20" },
      20,
    ],
  ] as const)("a run's seat is held from its admission's instant for its timeout plus the runtime's margin, never less than its acquisition budget — %s", async (_label, env, creations) => {
    const app = appWith(env);
    await pushLocalAgent(app, `seat-deadline-${creations}`, ['timeout: "300s"']);
    scriptRuns();
    const at = Date.parse("2026-10-16T13:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);

    const res = await runWith(app, `seat-deadline-${creations}`, { q: "deadline" });
    expect(res.status).toBe(200);

    const [row] = await db.listRuns();
    const margin = seatDeadlineMarginMs({ concurrentCreates: creations });
    expect(row?.created_at).toBe(new Date(at).toISOString());
    expect(row?.deadline_at).toBe(new Date(at + 300_000 + margin).toISOString());
    expect(heldFor(row as Run)).toBeGreaterThanOrEqual(
      300_000 + acquisitionBudgetMs({ concurrentCreates: creations }),
    );
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an admitted run's response carries the account's numbers, its own seat counted", async (mode) => {
    const app = appWith({
      SKRUN_QUOTA_CONCURRENT_RUNS: "3",
      SKRUN_QUOTA_COMPUTE_SECONDS: "3600",
      SKRUN_QUOTA_WINDOW_S: "21600",
    });
    await pushLocalAgent(app, `numbers-${mode}`);
    scriptRuns();
    const res = await startRun(app, mode, `numbers-${mode}`);
    expect(res.status).toBe(mode === "webhook" ? 202 : 200);
    await res.text();
    const windowEndS = (Math.floor(Date.now() / 21_600_000) + 1) * 21_600;
    expect({
      runsLimit: res.headers.get("X-Quota-Runs-Limit"),
      runsRemaining: res.headers.get("X-Quota-Runs-Remaining"),
      computeLimit: res.headers.get("X-Quota-Compute-Limit"),
      computeRemaining: res.headers.get("X-Quota-Compute-Remaining"),
      computeReset: res.headers.get("X-Quota-Compute-Reset"),
    }).toEqual({
      runsLimit: "3",
      runsRemaining: "2",
      computeLimit: "3600",
      computeRemaining: "3600",
      computeReset: String(windowEndS),
    });
    if (mode === "webhook") await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
  });
});

// An environment override is merged into the agent's environment and the
// result validated again, as agent.yaml's is; and a run declaring a timeout
// above the server's maximum is refused — early, from the version's recorded
// configuration, when no override could change it; for good, once merged.
describe("POST /run — the merged environment, and the longest timeout the server accepts", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function appWith(env: QuotaEnv = {}): ReturnType<typeof createApp> {
    return createApp(storage, db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
      quotaConfig: parseQuotaEnv(env),
    });
  }

  /** A synchronous run of the dev token's agent, the agent's owner on a master credential. */
  function runWithOverride(
    app: ReturnType<typeof createApp>,
    name: string,
    environment?: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: JSON.stringify({ input: { q: "hello" }, ...(environment && { environment }) }),
    });
  }

  /** The environment the run's adapter was handed. */
  function handedEnvironment(): RunRequest["agentConfig"]["environment"] | undefined {
    return (execute.mock.calls.at(-1)?.[0] as RunRequest | undefined)?.agentConfig.environment;
  }

  /** The refusal lines written since the case cleared them: the account, the bound, the plan. */
  function refusedLines(): Array<{ user_id: unknown; bound: unknown; plan: unknown }> {
    return logLines
      .filter((line) => line.event === "quota_refused")
      .map(({ user_id, bound, plan }) => ({ user_id, bound, plan }));
  }

  /** The dev token's account, as its first request recorded it. */
  async function devAccountId(): Promise<string | undefined> {
    const githubId = `dev-${createHash("sha256").update("dev-token").digest("hex").slice(0, 16)}`;
    return (await db.getUserByGithubId(githubId))?.id;
  }

  it.each([
    ["a timeout that is a number", { timeout: 5 }, "environment.timeout"],
    ["a timeout that is not in seconds", { timeout: "abc" }, "environment.timeout"],
    ["a networking that is not an object", { networking: "x" }, "environment.networking"],
    [
      "an allowed_hosts that is not a list",
      { networking: { allowed_hosts: "api.example.com" } },
      "environment.networking.allowed_hosts",
    ],
  ] as const)("an override with %s is refused 400 INVALID_ENVIRONMENT, naming the field, and nothing runs", async (_label, environment, field) => {
    const app = appWith();
    await pushLocalAgent(app, "merged-invalid");
    const res = await runWithOverride(app, "merged-invalid", environment);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_ENVIRONMENT");
    expect(body.error.message).toContain(field);
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("a valid override of the owner on a master credential widens the environment as before", async () => {
    const app = appWith();
    await pushLocalAgent(app, "merged-valid", ['timeout: "300s"']);
    const res = await runWithOverride(app, "merged-valid", {
      timeout: "600s",
      networking: { allowed_hosts: ["api.example.com"] },
    });
    expect(res.status).toBe(200);
    expect(handedEnvironment()).toMatchObject({
      timeout: "600s",
      networking: { allowed_hosts: ["api.example.com"] },
    });
  });

  it("an agent declaring more than the server's maximum is refused 400 TIMEOUT_ABOVE_LIMIT before its bundle is pulled", async () => {
    // Pushed before the maximum was set: a push past it is refused.
    await pushLocalAgent(appWith(), "too-long", ['timeout: "1800s"']);
    const app = appWith({ SKRUN_RUN_MAX_TIMEOUT_S: "900" });
    const pulls = vi.spyOn(MemoryStorage.prototype, "get");
    logLines.length = 0;

    const res = await runWithOverride(app, "too-long");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "TIMEOUT_ABOVE_LIMIT",
        message: "This agent declares 1800 s; this server accepts at most 900 s.",
      },
    });
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(pulls).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
    expect(refusedLines()).toEqual([
      { user_id: await devAccountId(), bound: "max_timeout", plan: "free" },
    ]);
  });

  it("an agent that declares no timeout runs up to the 300 s default: under a maximum of 120 it is refused, in words that claim no declared value", async () => {
    // Pushed before the maximum was set: a push past it is refused.
    await pushLocalAgent(appWith(), "no-timeout");
    const app = appWith({ SKRUN_RUN_MAX_TIMEOUT_S: "120" });

    const res = await runWithOverride(app, "no-timeout");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "TIMEOUT_ABOVE_LIMIT",
        message:
          "This agent runs up to 300 s, the default timeout of an agent that declares none; this server accepts at most 120 s.",
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("an override raising an agent's timeout above the maximum is refused once merged, after the pull", async () => {
    const app = appWith({ SKRUN_RUN_MAX_TIMEOUT_S: "900" });
    await pushLocalAgent(app, "raised-too-long", ['timeout: "300s"']);
    const pulls = vi.spyOn(MemoryStorage.prototype, "get");
    logLines.length = 0;

    const res = await runWithOverride(app, "raised-too-long", { timeout: "1800s" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "TIMEOUT_ABOVE_LIMIT",
        message:
          "This run's environment override declares 1800 s; this server accepts at most 900 s.",
      },
    });
    expect(pulls).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
    expect(refusedLines()).toEqual([
      { user_id: await devAccountId(), bound: "max_timeout", plan: "free" },
    ]);
  });

  it("at the maximum, or without one, the run goes", async () => {
    const capped = appWith({ SKRUN_RUN_MAX_TIMEOUT_S: "900" });
    await pushLocalAgent(capped, "at-the-max", ['timeout: "900s"']);
    expect((await runWithOverride(capped, "at-the-max")).status).toBe(200);
    expect((await runWithOverride(capped, "at-the-max", { timeout: "900s" })).status).toBe(200);

    const uncapped = appWith();
    await pushLocalAgent(uncapped, "no-max", ['timeout: "1800s"']);
    expect((await runWithOverride(uncapped, "no-max")).status).toBe(200);
    expect(handedEnvironment()?.timeout).toBe("1800s");
  });
});

// An environment override is judged as it is sent, before the bundle is
// pulled: a field that no code honours, or a timeout outside the range a run
// can hold, is refused by name — after a retired field, by the same function
// validation reads. What the version's own agent.yaml declares is never judged
// at run: a version published before the push refused it still runs, with an
// override or without.
describe("POST /run — the environment override, judged as sent", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let execute: MockInstance;

  const SECRETS =
    "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.";
  const TIMEOUT = (value: string) =>
    `environment.timeout "${value}" is outside the allowed range: a run's timeout is between 1s and 2147483s (about 24.8 days), e.g. "300s".`;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bundleCache.clear();
  });

  function appWith(env: QuotaEnv = {}): ReturnType<typeof createApp> {
    return createApp(storage, db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
      quotaConfig: parseQuotaEnv(env),
    });
  }

  /** A synchronous run of the dev token's agent, the agent's owner on a master credential. */
  function runWithOverride(
    app: ReturnType<typeof createApp>,
    name: string,
    environment?: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: JSON.stringify({ input: { q: "hello" }, ...(environment && { environment }) }),
    });
  }

  it.each([
    [
      "a secrets list that names a secret",
      {},
      { secrets: ["X"] },
      "UNSUPPORTED_FIELD",
      `The environment override is refused: ${SECRETS}`,
    ],
    [
      "a timeout of 0s",
      {},
      { timeout: "0s" },
      "TIMEOUT_OUT_OF_RANGE",
      `The environment override is refused: ${TIMEOUT("0s")}`,
    ],
    [
      "a timeout past the longest timer",
      {},
      { timeout: "2147484s" },
      "TIMEOUT_OUT_OF_RANGE",
      `The environment override is refused: ${TIMEOUT("2147484s")}`,
    ],
    [
      "a timeout past the range, on a server whose maximum is lower: for the range, never for the maximum",
      { SKRUN_RUN_MAX_TIMEOUT_S: "900" },
      { timeout: "3000000s" },
      "TIMEOUT_OUT_OF_RANGE",
      `The environment override is refused: ${TIMEOUT("3000000s")}`,
    ],
    [
      "both: the code of the first, every message",
      {},
      { secrets: ["X"], timeout: "0s" },
      "UNSUPPORTED_FIELD",
      `The environment override is refused: ${SECRETS} ${TIMEOUT("0s")}`,
    ],
  ] as const)("an override carrying %s is refused 400 by name, before any read of the store, and no run is written", async (_label, env, environment, code, message) => {
    const app = appWith(env);
    await pushLocalAgent(app, "judged");
    const reads = vi.spyOn(storage, "get");

    const res = await runWithOverride(app, "judged", environment);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code, message } });
    expect(reads).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("an override carrying an empty secrets list is admitted", async () => {
    const app = appWith();
    await pushLocalAgent(app, "judged");
    expect((await runWithOverride(app, "judged", { secrets: [] })).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("an override carrying environment.filesystem is refused 400 RETIRED_FIELD, naming it — before the settings no code honours", async () => {
    const app = appWith();
    await pushLocalAgent(app, "judged");
    const reads = vi.spyOn(storage, "get");

    for (const environment of [{ filesystem: "none" }, { filesystem: "none", secrets: ["X"] }]) {
      const res = await runWithOverride(app, "judged", environment);
      expect(execute).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: "RETIRED_FIELD",
          message:
            "The environment override carries a retired field (environment.filesystem): it has no effect. Remove it from the request.",
        },
      });
    }
    expect(reads).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("an override whose secrets is not a list is not judged as sent: refused once merged, 400 INVALID_ENVIRONMENT naming the field", async () => {
    const app = appWith();
    await pushLocalAgent(app, "judged");
    const res = await runWithOverride(app, "judged", { secrets: "X" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_ENVIRONMENT");
    expect(body.error.message).toContain("environment.secrets");
    expect(await db.listRuns()).toEqual([]);
  });

  it.each([
    ["a secrets list that names a secret, run without an override", ["secrets: [X]"], undefined],
    [
      "a secrets list that names a secret, and an override of its timeout",
      ["secrets: [X]"],
      { timeout: "60s" },
    ],
    [
      "a secrets list that names a secret, and an override of its cost",
      ["secrets: [X]"],
      { max_cost: 1 },
    ],
    ["a timeout of 0s, and an override of its cost", ["timeout: 0s"], { max_cost: 1 }],
  ] as const)("a version published before the push refused it — %s — runs, judged as without an override", async (_label, declared, environment) => {
    const app = appWith();
    await storeLocalAgent(app, storage, db, "published-before", [...declared]);

    const res = await runWithOverride(app, "published-before", environment && { ...environment });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await db.listRuns()).map((run) => run.status)).toEqual(["completed"]);
  });

  it("a version published before the push refused it, declaring an MCP server's auth api_key, runs: its MCP server is connected and the run reaches the adapter", async () => {
    const connect = vi.spyOn(McpToolProvider.prototype, "connect").mockResolvedValue(undefined);
    const app = appWith();
    await storeVersion({
      app,
      storage,
      db,
      token: "dev-token",
      namespace: "dev",
      name: "published-with-auth",
      version: "1.0.0",
      agentYaml: [
        localAgentYaml("published-with-auth"),
        "mcp_servers:",
        "  - name: search",
        "    url: https://mcp.published-with-auth.example.com/sse",
        "    auth: api_key",
      ].join("\n"),
    });

    const res = await runWithOverride(app, "published-with-auth");

    expect(res.status).toBe(200);
    expect(connect).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// On the local runtime, the route connects the agent's MCP servers before the
// run is written; a server that cannot be connected to is answered 502
// MCP_CONNECT_FAILED, with the error's message and details. A remote server's
// URL can carry a credential in its user-info, its path or its query: the
// answer names the server by its origin only.
describe("POST /run — an MCP server that cannot be connected to", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { verificationPolicy: "owner", runtimeMode: "local" });
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    // The connection fails at once; the bound only keeps a case from hanging.
    vi.stubEnv("MCP_CONNECT_TIMEOUT_MS", "2000");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    bundleCache.clear();
  });

  /** A port nothing listens on: taken from the system, then given back. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("answers 502 MCP_CONNECT_FAILED naming the server by its origin: no credentials, no path, no query", async () => {
    const port = await closedPort();
    const origin = `https://127.0.0.1:${port}`;
    const name = "unreachable-mcp";
    const agentYaml = [
      localAgentYaml(name, ["networking:", "  allowed_hosts:", "    - 127.0.0.1"]),
      "mcp_servers:",
      "  - name: search",
      `    url: https://u:p@127.0.0.1:${port}/sse?key=abc`,
      "    transport: sse",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const pushed = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(pushed.status).toBe(200);

    const res = await startRun(app, "sync", name);
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "MCP_CONNECT_FAILED",
        message: `MCP server "search" (sse) failed to connect: ${origin}`,
        details: { server: "search", transport: "sse", location: origin, isTimeout: false },
      },
    });
    for (const part of ["u:p", "/sse", "key=abc"]) expect(text).not.toContain(part);
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("answers 502 MCP_CONNECT_FAILED naming a server whose URL has no origin by words of the answer's own, never the log line's", async () => {
    const name = "originless-mcp";
    const label = "a URL with no origin";
    const agentYaml = [
      localAgentYaml(name),
      "mcp_servers:",
      "  - name: search",
      "    url: foo:bar",
      "    transport: sse",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const pushed = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(pushed.status).toBe(200);

    const res = await startRun(app, "sync", name);
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "MCP_CONNECT_FAILED",
        message: `MCP server "search" (sse) failed to connect: ${label}`,
        details: { server: "search", transport: "sse", location: label, isTimeout: false },
      },
    });
    for (const part of ["not logged", "foo:bar"]) expect(text).not.toContain(part);
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });
});

// What a run's row keeps of its content is bounded — the output at 32 KiB of
// JSON text, the input and the error at 8 KiB; beyond, a marker in place of the
// input or the output, the error cut and suffixed. Only the row: the run is
// handed its whole input, and its caller gets its whole output and its whole
// error, in every mode.
describe("POST /run — what a run's row keeps of its content, and what its caller gets", () => {
  const KIB = 1024;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    deliverWebhook.mockClear();
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A string of `bytes` bytes: one byte a character. */
  const text = (bytes: number) => "z".repeat(bytes);
  const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  /** Every run ends with `end`: it completes with this output, or fails with this error. */
  function scriptEnd(end: { output: Record<string, unknown> } | { error: string }): void {
    executeStream.mockImplementation(async function* (request: RunRequest) {
      const timestamp = new Date().toISOString();
      if ("error" in end) {
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp,
          error: { code: "EXECUTION_FAILED", message: end.error },
        } satisfies RunEvent;
        return;
      }
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp,
        output: end.output,
        usage,
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "error" in end ? "failed" : "completed",
      output: "error" in end ? {} : end.output,
      ...("error" in end && { error: end.error }),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  }

  /**
   * Run the dev token's `name` in `mode` with `input`: what the caller got —
   * the response's body, the stream's final event, or the delivery — and the
   * run's row once it is finished.
   */
  async function runIn(
    mode: "sync" | "sse" | "webhook",
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ told: Record<string, unknown>; row: Run }> {
    const res = await app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
        ...(mode === "sse" && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify({
        input,
        ...(mode === "webhook" && { webhook_url: "https://hooks.example.com/x" }),
      }),
    });
    let told: Record<string, unknown>;
    if (mode === "sync") {
      expect(res.status).toBe(200);
      told = (await res.json()) as Record<string, unknown>;
    } else if (mode === "sse") {
      expect(res.status).toBe(200);
      const final = parseSseEvents(await res.text())
        .filter(({ event }) => event === "run_complete" || event === "run_error")
        .at(-1);
      told = final?.data as Record<string, unknown>;
    } else {
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
      told = deliverWebhook.mock.calls[0]?.[1] as Record<string, unknown>;
    }
    const [row] = await db.listRuns();
    return { told, row: row as Run };
  }

  /** The input the run's adapter was handed. */
  function handedInput(mode: "sync" | "sse" | "webhook"): unknown {
    const spy = mode === "sync" ? execute : executeStream;
    return (spy.mock.calls.at(-1)?.[0] as RunRequest | undefined)?.input;
  }

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an input of 16 KiB and an output of 64 KiB — the row keeps both markers, the run gets all its input, the caller all its output", async (mode) => {
    await pushLocalAgent(app, `kept-large-${mode}`);
    const input = { q: text(16 * KIB) };
    const output = { answer: text(64 * KIB) };
    scriptEnd({ output });

    const { told, row } = await runIn(mode, `kept-large-${mode}`, input);

    expect(told.output).toEqual(output);
    expect(handedInput(mode)).toEqual(input);
    expect(row.status).toBe("completed");
    expect(row.input).toEqual({
      _truncated: { bytes: jsonBytes(input), preview: expect.stringMatching(/^\{"q":"zzz/) },
    });
    expect(row.output).toEqual({
      _truncated: { bytes: jsonBytes(output), preview: expect.stringMatching(/^\{"answer":"zzz/) },
    });
    expect(jsonBytes(row.input)).toBeLessThanOrEqual(8 * KIB);
    expect(jsonBytes(row.output)).toBeLessThanOrEqual(32 * KIB);
  });

  it("an output of 20 KiB is kept whole, under its 32 KiB, while an input of 20 KiB is not, over its 8 KiB", async () => {
    await pushLocalAgent(app, "kept-twenty");
    const input = { q: text(20 * KIB) };
    const output = { answer: text(20 * KIB) };
    scriptEnd({ output });

    const { told, row } = await runIn("sync", "kept-twenty", input);

    expect(told.output).toEqual(output);
    expect(row.output).toEqual(output);
    expect(row.input).toMatchObject({ _truncated: { bytes: jsonBytes(input) } });
  });

  it("an input of 1 KiB is kept as it is", async () => {
    await pushLocalAgent(app, "kept-small");
    const input = { q: text(KIB) };
    scriptEnd({ output: { answer: "ok" } });

    const { row } = await runIn("sync", "kept-small", input);

    expect(row.input).toEqual(input);
    expect(row.output).toEqual({ answer: "ok" });
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an error of 12 KiB — the row keeps it cut and suffixed, the caller gets it whole", async (mode) => {
    await pushLocalAgent(app, `kept-error-${mode}`);
    const error = text(12 * KIB);
    scriptEnd({ error });

    const { told, row } = await runIn(mode, `kept-error-${mode}`, { q: "hello" });

    const suffix = "… [truncated: 12288 bytes]";
    expect(row.status).toBe("failed");
    expect(row.error).toBe(`${text(8 * KIB - Buffer.byteLength(suffix))}${suffix}`);
    if (mode === "sync") {
      expect(told).toMatchObject({ status: "failed", error });
    } else {
      expect(told).toMatchObject({ error: { code: "EXECUTION_FAILED", message: error } });
    }
  });

  // A NUL or a lone surrogate — a model's `\u0000` escape, parsed — is what
  // Postgres refuses to store: its final write failed and the row stayed
  // running. The row's copy replaces them on every store; the run and its
  // caller keep them.
  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an input and an output carrying a NUL and a lone surrogate — the row keeps U+FFFD in their place, completed and charged; the run and its caller get them as they were", async (mode) => {
    await pushLocalAgent(app, `kept-nul-${mode}`);
    const input = { q: "ask\u0000", lone: "\ud800" };
    const output = { answer: "done\u0000", lone: "a\udc00b" };
    scriptEnd({ output });

    const { told, row } = await runIn(mode, `kept-nul-${mode}`, input);

    expect(told.output).toEqual(output);
    expect(handedInput(mode)).toEqual(input);
    expect(row).toMatchObject({
      status: "completed",
      input: { q: "ask�", lone: "�" },
      output: { answer: "done�", lone: "a�b" },
      charged_ms: expect.any(Number),
    });
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an error carrying a NUL and a lone surrogate — the row keeps U+FFFD in their place, failed and charged; the caller gets it as it was", async (mode) => {
    await pushLocalAgent(app, `kept-nul-error-${mode}`);
    const error = "Tool failed: \u0000 then \ud83d";
    scriptEnd({ error });

    const { told, row } = await runIn(mode, `kept-nul-error-${mode}`, { q: "hello" });

    expect(row).toMatchObject({
      status: "failed",
      error: "Tool failed: � then �",
      charged_ms: expect.any(Number),
    });
    if (mode === "sync") {
      expect(told).toMatchObject({ status: "failed", error });
    } else {
      expect(told).toMatchObject({ error: { code: "EXECUTION_FAILED", message: error } });
    }
  });
});

describe("POST /run — a body without input", () => {
  // The agent's input is the body's `input` field. A body that is not an
  // object, an object with no `input` — the empty object included — and an
  // `input` null are refused 400 INVALID_REQUEST, each by its own words, the
  // first thing the route does with the body it read: nothing of the agent
  // read, no quota looked at, no row written. The whole body was taken for the
  // input, and ran.
  const NOT_AN_OBJECT =
    'The request body must be a JSON object with an "input" field, e.g. {"input": {"query": "hello"}}.';
  const NO_INPUT =
    'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.';
  const INPUT_NULL =
    '"input" is null: send the agent\'s input as an object, e.g. {"input": {"query": "hello"}}.';
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    // A bound on the account: the pre-check reads its usage, and the admission
    // writes the row under it — two steps a refused body must never reach.
    app = createApp(storage, db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
      quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "5" }),
    });
    deliverWebhook.mockClear();
    // No model is called, whichever path a body reaches.
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A run of the dev token's `name`, its body given as JSON text; a stream header only when asked. */
  function postBody(name: string, bodyText: string, stream = false): Promise<Response> {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
        ...(stream && { Accept: "text/event-stream" }),
      },
      body: bodyText,
    });
  }

  /** An agent whose one input, `q`, is optional. */
  async function pushAgentWithOptionalInput(name: string): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: false",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  /** Spies on every step a refused body must never reach — set once the agent is published. */
  function stepsAfterTheBody() {
    return {
      agentReads: vi.spyOn(db, "getAgent"),
      pulls: vi.spyOn(storage, "get"),
      usageReads: vi.spyOn(db, "getAccountUsage"),
      admissions: vi.spyOn(db, "admitRun"),
    };
  }

  /** Everything the refusal is judged on, in one value, so a red shows all of it at once. */
  async function observe(res: Response, steps: ReturnType<typeof stepsAfterTheBody>) {
    return {
      status: res.status,
      body: await res.json(),
      agentReads: steps.agentReads.mock.calls.length,
      pulls: steps.pulls.mock.calls.length,
      usageReads: steps.usageReads.mock.calls.length,
      admissions: steps.admissions.mock.calls.length,
      adapterCalls: execute.mock.calls.length + executeStream.mock.calls.length,
      runs: (await db.listRuns()).length,
    };
  }

  /** The refusal, with these words: nothing of the agent read, nothing of the run written. */
  const refusedWith = (message: string) => ({
    status: 400,
    body: { error: { code: "INVALID_REQUEST", message } },
    agentReads: 0,
    pulls: 0,
    usageReads: 0,
    admissions: 0,
    adapterCalls: 0,
    runs: 0,
  });

  it.each([
    ["an object of the agent's fields, sent without input", '{"q":"x"}', NO_INPUT],
    ["an input null beside the agent's fields", '{"input":null,"q":"x"}', INPUT_NULL],
    ["a whole body that is a number", "5", NOT_AN_OBJECT],
    ["a whole body that is a string", '"abc"', NOT_AN_OBJECT],
    ["a whole body that is a boolean", "true", NOT_AN_OBJECT],
    ["a whole body that is an array", "[1]", NOT_AN_OBJECT],
    ["a whole body that is null", "null", NOT_AN_OBJECT],
  ])("for an agent with a required input, %s is refused 400 INVALID_REQUEST, the message naming input — before anything else: the agent unread, no row", async (_label, bodyText, message) => {
    await pushLocalAgent(app, "body-no-input");
    const steps = stepsAfterTheBody();

    const seen = await observe(await postBody("body-no-input", bodyText), steps);

    expect(seen).toEqual(refusedWith(message));
    expect(message).toContain('"input"');
  });

  it("for an agent with no required input, the empty object is refused the same way — it ran, as its own input", async () => {
    await pushAgentWithOptionalInput("body-empty");
    const steps = stepsAfterTheBody();

    const seen = await observe(await postBody("body-empty", "{}"), steps);

    expect(seen).toEqual(refusedWith(NO_INPUT));
  });

  it.each([
    ["the event stream", '{"q":"x"}', true],
    ["a webhook", '{"q":"x","webhook_url":"https://hooks.example.com/x"}', false],
  ])("the same body asking for %s is refused the same way, before its response mode is judged", async (_label, bodyText, stream) => {
    await pushLocalAgent(app, "body-no-input-mode");
    const steps = stepsAfterTheBody();

    const seen = await observe(await postBody("body-no-input-mode", bodyText, stream), steps);

    expect(seen).toEqual(refusedWith(NO_INPUT));
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it("the agent's input sent under input runs: 200, its row keeping the input alone", async () => {
    await pushLocalAgent(app, "body-with-input");

    const res = await postBody("body-with-input", '{"input":{"q":"x"}}');

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    const [row] = await db.listRuns();
    expect(row?.status).toBe("completed");
    expect(row?.input).toEqual({ q: "x" });
  });
});

describe("POST /run — an input that misses a required input", () => {
  // The rule and its words are the schema's, read by the server of `skrun dev`
  // too: each pinned whole here, as the API answers them.
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    // No model is called: a refused input never reaches the adapter.
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    executeStream.mockImplementation(async function* () {});
    execute.mockRejectedValue(new Error("the adapter is never reached"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["an empty object", '{"input":{}}'],
    ["an object of other fields", '{"input":{"other":"x"}}'],
    ["an array", '{"input":[1]}'],
  ])("%s as the input is refused 400 MISSING_INPUT, naming the input it misses — no adapter, no row", async (_label, bodyText) => {
    await pushLocalAgent(app, "missing-input-words");

    const res = await app.request("/api/agents/dev/missing-input-words/run", {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: bodyText,
    });

    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 400,
      body: { error: { code: "MISSING_INPUT", message: "Missing required input: q" } },
    });
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
    expect(await db.listRuns()).toEqual([]);
  });
});

describe("POST /run — each input the agent declares, judged in its order: its absence — no field of the input's own, null, or an empty list for a file input —, then its type", () => {
  // The rule and its words are the schema's, read by the server of `skrun dev`
  // too: each answer pinned whole here, as the API gives it.
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    // No model is called: a refused input never reaches the adapter.
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    executeStream.mockImplementation(async function* () {});
    execute.mockRejectedValue(new Error("the adapter is never reached"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Push, by the route, an agent the dev token owns whose inputs are these lines of agent.yaml. */
  async function pushAgentWithInputs(name: string, inputs: string[]): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      ...inputs,
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  /** The run's whole answer to this body, with the caller's model key. */
  async function answer(name: string, bodyText: string) {
    const res = await app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: bodyText,
    });
    return { status: res.status, body: await res.json() };
  }

  it("refuses the first input at fault, in the order the agent declares them — its absence, then its type — and runs nothing", async () => {
    await pushAgentWithInputs("inputs-in-order", [
      "  - name: a",
      "    type: string",
      "  - name: b",
      "    type: string",
    ]);

    for (const [bodyText, error] of [
      [
        '{"input":{"a":5}}',
        { code: "INVALID_INPUT_TYPE", message: 'Input "a" expected string, got number' },
      ],
      ['{"input":{"b":"x"}}', { code: "MISSING_INPUT", message: "Missing required input: a" }],
      ['{"input":{"a":"x"}}', { code: "MISSING_INPUT", message: "Missing required input: b" }],
    ] as const) {
      expect({ bodyText, ...(await answer("inputs-in-order", bodyText)) }).toEqual({
        bodyText,
        status: 400,
        body: { error },
      });
    }
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
    expect(await db.listRuns()).toEqual([]);
  });

  it.each([
    ["toString", "the empty object", '{"input":{}}'],
    ["constructor", "the empty object", '{"input":{}}'],
    ["filter", "an array", '{"input":[1]}'],
  ])("counts a required input named %s present only as the input's own field — %s does not carry it: 400 MISSING_INPUT", async (name, _label, bodyText) => {
    const agent = `inputs-own-${name.toLowerCase()}`;
    await pushAgentWithInputs(agent, [`  - name: ${name}`, "    type: string"]);

    expect(await answer(agent, bodyText)).toEqual({
      status: 400,
      body: { error: { code: "MISSING_INPUT", message: `Missing required input: ${name}` } },
    });
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
  });

  it("serves an agent whose optional input named toString the input does not carry as a field of its own: the run goes ahead without it", async () => {
    await pushAgentWithInputs("inputs-own-optional", [
      "  - name: toString",
      "    type: string",
      "    required: false",
    ]);
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));

    const ran = await answer("inputs-own-optional", '{"input":{}}');

    expect({ status: ran.status, runStatus: (ran.body as { status?: string }).status }).toEqual({
      status: 200,
      runStatus: "completed",
    });
    expect(execute.mock.calls.map(([request]) => (request as RunRequest).input)).toEqual([{}]);
  });

  it.each([
    ["null", "inputs-file-null", '{"input":{"doc":null}}'],
    ["an empty list", "inputs-file-empty", '{"input":{"doc":[]}}'],
  ])("refuses a required file input sent as %s 400 MISSING_INPUT, in the words of any missing input, and writes nothing of the run", async (_label, agent, bodyText) => {
    await pushAgentWithInputs(agent, ["  - name: doc", "    type: file", "    media: document"]);
    const admissions = vi.spyOn(db, "admitRun");

    expect(await answer(agent, bodyText)).toEqual({
      status: 400,
      body: { error: { code: "MISSING_INPUT", message: "Missing required input: doc" } },
    });
    expect(admissions).not.toHaveBeenCalled();
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
    expect(await db.listRuns()).toEqual([]);
  });

  it.each([
    ["string", "inputs-null-string", "string"],
    ["object", "inputs-null-object", "object"],
  ])("refuses a required %s input sent as null 400 MISSING_INPUT — null is never a wrong type — and writes nothing of the run", async (_label, agent, type) => {
    await pushAgentWithInputs(agent, ["  - name: q", `    type: ${type}`]);
    const admissions = vi.spyOn(db, "admitRun");

    expect(await answer(agent, '{"input":{"q":null}}')).toEqual({
      status: 400,
      body: { error: { code: "MISSING_INPUT", message: "Missing required input: q" } },
    });
    expect(admissions).not.toHaveBeenCalled();
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
    expect(await db.listRuns()).toEqual([]);
  });

  it("serves an optional string input sent as null: absent, its type not judged, handed on as sent", async () => {
    await pushAgentWithInputs("inputs-null-optional", [
      "  - name: q",
      "    type: string",
      "    required: false",
    ]);
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));

    const ran = await answer("inputs-null-optional", '{"input":{"q":null}}');

    expect({ status: ran.status, runStatus: (ran.body as { status?: string }).status }).toEqual({
      status: 200,
      runStatus: "completed",
    });
    expect(execute.mock.calls.map(([request]) => (request as RunRequest).input)).toEqual([
      { q: null },
    ]);
  });

  it.each([
    [
      "null, before the type of an input declared after it",
      "inputs-file-null-then-type",
      ["  - name: doc", "    type: file", "    media: document", "  - name: n", "    type: number"],
      '{"input":{"doc":null,"n":"x"}}',
      "doc",
    ],
    [
      "an empty list, before the type of an input declared after it",
      "inputs-file-empty-then-type",
      ["  - name: doc", "    type: file", "    media: document", "  - name: n", "    type: number"],
      '{"input":{"doc":[],"n":"x"}}',
      "doc",
    ],
    [
      // The source of `a` is not one, which only the reading of the files
      // judges: the null of `b`, declared after it, is refused first.
      "null, before the source of a file input declared ahead of it is read",
      "inputs-file-null-after-file",
      [
        "  - name: a",
        "    type: file",
        "    media: document",
        "  - name: b",
        "    type: file",
        "    media: document",
      ],
      '{"input":{"a":{"type":"file","source":"url","url":5},"b":null}}',
      "b",
    ],
  ])("refuses a required file input sent as %s, at its place among the inputs", async (_label, agent, inputs, bodyText, refused) => {
    await pushAgentWithInputs(agent, inputs);
    const admissions = vi.spyOn(db, "admitRun");

    expect(await answer(agent, bodyText)).toEqual({
      status: 400,
      body: {
        error: { code: "MISSING_INPUT", message: `Missing required input: ${refused}` },
      },
    });
    expect(admissions).not.toHaveBeenCalled();
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
    expect(await db.listRuns()).toEqual([]);
  });

  it.each([
    ["null", "inputs-file-optional-null", '{"input":{"doc":null}}'],
    ["an empty list", "inputs-file-optional-empty", '{"input":{"doc":[]}}'],
  ])("serves an agent whose optional file input is sent as %s: the run goes ahead without the file", async (_label, agent, bodyText) => {
    await pushAgentWithInputs(agent, [
      "  - name: doc",
      "    type: file",
      "    media: document",
      "    required: false",
    ]);
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));

    const ran = await answer(agent, bodyText);

    expect({ status: ran.status, runStatus: (ran.body as { status?: string }).status }).toEqual({
      status: 200,
      runStatus: "completed",
    });
    expect(execute).toHaveBeenCalledOnce();
    const request = execute.mock.calls[0]?.[0] as RunRequest | undefined;
    expect(request?.resolvedInputs?.has("doc") ?? false).toBe(false);
  });
});

describe("POST /run — a webhook_url that JavaScript reads as false asks for no webhook", () => {
  // The response mode is read once, by one rule, and the route takes the path
  // that rule names: a webhook_url JavaScript reads as false — an empty
  // string, 0, false, null — is no webhook, so the request is synchronous,
  // and the local runtime serves it in one response.
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { verificationPolicy: "owner", runtimeMode: "local" });
    deliverWebhook.mockClear();
    // No model is called, whichever path the request takes.
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["an empty string", ""],
    ["0", 0],
    ["false", false],
    ["null", null],
  ])("a webhook_url that is %s is no webhook: the run is served in one response, 200 completed — no 202, no stream", async (_label, webhookUrl) => {
    await pushLocalAgent(app, "mode-no-webhook");

    const res = await app.request("/api/agents/dev/mode-no-webhook/run", {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: JSON.stringify({ input: { q: "x" }, webhook_url: webhookUrl }),
    });

    expect({
      status: res.status,
      runStatus: ((await res.json()) as { status?: string }).status,
      execute: execute.mock.calls.length,
      executeStream: executeStream.mock.calls.length,
    }).toEqual({ status: 200, runStatus: "completed", execute: 1, executeStream: 0 });
    expect(deliverWebhook).not.toHaveBeenCalled();
  });
});

describe("POST /run — an input nested deeper than the bound", () => {
  // An input nested more than 100 levels deep — the input itself the first
  // level — is refused 400 INVALID_INPUT_TYPE, among the first things the route
  // does with the body it read: nothing of the agent read, no quota looked at, no
  // copy built, no row written. It was admitted, and its row's copy written
  // out whole for a marker — about 190 MB of heap for a body of 1 MB.
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    // A bound on the account: the pre-check reads its usage, and the admission
    // writes the row under it — two steps a refused input must never reach.
    app = createApp(storage, db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
      quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "5" }),
    });
    deliverWebhook.mockClear();
    executeStream = vi.spyOn(LocalAdapter.prototype, "executeStream");
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    executeStream.mockImplementation(async function* (request: RunRequest) {
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        output: { answer: "ok" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
      } satisfies RunEvent;
    });
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A run of the dev token's `name` in `mode`, its `input` given as JSON text. */
  function postInput(
    mode: "sync" | "sse" | "webhook",
    name: string,
    inputText: string,
  ): Promise<Response> {
    const webhook = mode === "webhook" ? ',"webhook_url":"https://hooks.example.com/x"' : "";
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
        ...(mode === "sse" && { Accept: "text/event-stream" }),
      },
      body: `{"input":${inputText}${webhook}}`,
    });
  }

  /** `{"q":"hello","deep":[[…]]}`: the input object the first level, `levels` levels in all. */
  const inputOfDepth = (levels: number) =>
    `{"q":"hello","deep":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;

  /** Spies on every step a refused input must never reach. */
  function stepsAfterTheBody() {
    return {
      pulls: vi.spyOn(storage, "get"),
      agentReads: vi.spyOn(db, "getAgent"),
      usageReads: vi.spyOn(db, "getAccountUsage"),
      admissions: vi.spyOn(db, "admitRun"),
    };
  }

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: an input nested 101 levels deep is refused 400 INVALID_INPUT_TYPE, the bound named, before anything else — and one nested 100 levels deep runs, its row keeping it whole", async (mode) => {
    const name = `deep-input-${mode}`;
    await pushLocalAgent(app, name);
    const steps = stepsAfterTheBody();

    const refused = await postInput(mode, name, inputOfDepth(101));

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: {
        code: "INVALID_INPUT_TYPE",
        message:
          "Input nested more than 100 levels deep (the input itself is the first level; each object or array inside another is one more)",
      },
    });
    expect(steps.agentReads).not.toHaveBeenCalled();
    expect(steps.pulls).not.toHaveBeenCalled();
    expect(steps.usageReads).not.toHaveBeenCalled();
    expect(steps.admissions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(executeStream).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);

    // One level less runs, through every step the refusal never reached.
    const admitted = await postInput(mode, name, inputOfDepth(100));
    expect(admitted.status).toBe(mode === "webhook" ? 202 : 200);
    if (mode === "sse") {
      const events = parseSseEvents(await admitted.text()).map(({ event }) => event);
      expect(events.at(-1)).toBe("run_complete");
    }
    if (mode === "webhook") await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    expect(steps.usageReads).toHaveBeenCalled();
    expect(steps.admissions).toHaveBeenCalledOnce();
    const [row] = await db.listRuns();
    expect(row?.status).toBe("completed");
    expect(row?.input).toEqual(JSON.parse(inputOfDepth(100)));
  });

  it("an input that is itself an array, 101 levels deep, is refused the same way; 100 levels deep, it runs", async () => {
    await pushLocalAgent(app, "deep-array-input");
    const steps = stepsAfterTheBody();

    const refused = await postInput(
      "sync",
      "deep-array-input",
      `${"[".repeat(101)}${"]".repeat(101)}`,
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_INPUT_TYPE",
    );
    expect(steps.admissions).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);

    // The agent's one input is required: an array input misses it — refused
    // later, by the check of the agent's inputs, which the deep one never met.
    const shallower = await postInput(
      "sync",
      "deep-array-input",
      `${"[".repeat(100)}${"]".repeat(100)}`,
    );
    expect(((await shallower.json()) as { error: { code: string } }).error.code).toBe(
      "MISSING_INPUT",
    );
    expect(steps.agentReads).toHaveBeenCalled();
  });

  it("a body that carries no input, nested 101 levels deep, is refused for its missing input — 400 INVALID_REQUEST, said before any depth — and 100 levels deep the same way: the bound is the input's, and the body is never the input", async () => {
    await pushLocalAgent(app, "deep-whole-body");
    const steps = stepsAfterTheBody();
    const postWholeBody = (bodyText: string) =>
      app.request("/api/agents/dev/deep-whole-body/run", {
        method: "POST",
        headers: {
          ...DEV_AUTH,
          "Content-Type": "application/json",
          "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
        },
        body: bodyText,
      });
    const missingInput = {
      error: {
        code: "INVALID_REQUEST",
        message:
          'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.',
      },
    };

    for (const levels of [101, 100]) {
      const refused = await postWholeBody(inputOfDepth(levels));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual(missingInput);
    }
    expect(steps.agentReads).not.toHaveBeenCalled();
    expect(steps.admissions).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("a body of about 1 MB nested half a million levels deep is refused at once, at no cost of its depth: the heap grows by its parse alone", async () => {
    await pushLocalAgent(app, "deep-input-large");
    const steps = stepsAfterTheBody();
    const levels = 499_000;
    const inputText = `{"q":"x","deep":${"[".repeat(levels)}${"]".repeat(levels)}}`;
    expect(inputText.length).toBeGreaterThan(990_000);

    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const res = await postInput("sync", "deep-input-large", inputText);
    const body = (await res.json()) as { error: { code: string } };
    const elapsedMs = performance.now() - started;
    const grownBytes = process.memoryUsage().heapUsed - heapBefore;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_INPUT_TYPE");
    expect(steps.admissions).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
    // Wide margins, for a slow machine. On a developer's machine, the whole
    // request takes about 65 ms and grows the heap by some 20 MB — the parse
    // of the body; writing the copy's marker of it took about 250 ms and
    // 190 MB more.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(grownBytes).toBeLessThan(96 * 1024 * 1024);
  });

  it("a body of about 4 MB, wide, with one branch nested 150 levels deep, is refused at no cost of its width: the heap grows by its parse alone", async () => {
    await pushLocalAgent(app, "wide-deep-input");
    const steps = stepsAfterTheBody();
    const width = 1_300_000;
    const inputText = `{"q":"x","wide":[${"[],".repeat(width)}${"[".repeat(150)}${"]".repeat(150)}]}`;
    expect(inputText.length).toBeGreaterThan(3_900_000);

    const heapBefore = process.memoryUsage().heapUsed;
    const res = await postInput("sync", "wide-deep-input", inputText);
    const body = (await res.json()) as { error: { code: string } };
    const grownBytes = process.memoryUsage().heapUsed - heapBefore;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_INPUT_TYPE");
    expect(steps.admissions).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
    // A wide margin, for a slow machine. On a developer's machine, the
    // request grows the heap by about 30 MB — the parse of the body; a
    // measure that held each sibling still to visit made it about 135 MB.
    expect(grownBytes).toBeLessThan(80 * 1024 * 1024);
  });
});

describe("POST /run — an input that is not an object", () => {
  // The input is an object of the agent's input fields, sent as the body's
  // `input` (a body without one is refused before, by name). One that is a
  // string, a number or a boolean is refused 400 INVALID_INPUT_TYPE, at the
  // same place as an input nested too deep: right after the body's own
  // refusals, before anything of the agent is read. It reached the
  // check of the agent's inputs, which threw on it (a 500, logged as an
  // unhandled error) — or, for an agent whose every input is an optional file,
  // ran with the value dropped. An array is not refused there: it goes on to
  // that check, as before.
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let execute: MockInstance;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    // A bound on the account: the pre-check reads its usage, a step a refused
    // input must never reach.
    app = createApp(storage, db, {
      verificationPolicy: "owner",
      runtimeMode: "local",
      quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "5" }),
    });
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A synchronous run of the dev token's `name`, its body given as JSON text. */
  function postBody(name: string, bodyText: string): Promise<Response> {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: bodyText,
    });
  }

  /** An agent whose one input is `inputLines`, as agent.yaml writes it. */
  async function pushAgentWithInput(name: string, inputLines: string[]): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      ...inputLines,
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  it.each([
    ["an input that is a number", '{"input":5}', "number"],
    ["an input that is zero", '{"input":0}', "number"],
    ["an input that is a string", '{"input":"abc"}', "string"],
    ["an input that is an empty string", '{"input":""}', "string"],
    ["an input that is a boolean", '{"input":false}', "boolean"],
  ])("%s is refused 400 INVALID_INPUT_TYPE, the type named, before anything else", async (_label, bodyText, type) => {
    await pushLocalAgent(app, "scalar-input");
    const agentReads = vi.spyOn(db, "getAgent");
    const pulls = vi.spyOn(storage, "get");
    const usageReads = vi.spyOn(db, "getAccountUsage");
    const admissions = vi.spyOn(db, "admitRun");

    const res = await postBody("scalar-input", bodyText);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "INVALID_INPUT_TYPE", message: `Input expected object, got ${type}` },
    });
    expect(agentReads).not.toHaveBeenCalled();
    expect(pulls).not.toHaveBeenCalled();
    expect(usageReads).not.toHaveBeenCalled();
    expect(admissions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("for an agent whose every input is an optional file, a number input — run before with the value dropped — is refused the same way", async () => {
    await pushAgentWithInput("optional-file", [
      "  - name: photo",
      "    type: file",
      "    media: image",
      "    required: false",
    ]);

    const res = await postBody("optional-file", '{"input":5}');

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_INPUT_TYPE",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("what is not refused there: an array input goes on to the check of the agent's inputs; an array as the whole body, a body with no input, or with an input null, is refused before, as no input at all", async () => {
    await pushLocalAgent(app, "input-shapes");

    // The agent's one input is required: an array `input` misses it — refused
    // later, by the check of the agent's inputs.
    const arrayInput = await postBody("input-shapes", '{"input":["hello"]}');
    expect(arrayInput.status).toBe(400);
    expect(((await arrayInput.json()) as { error: { code: string } }).error.code).toBe(
      "MISSING_INPUT",
    );

    // No input sent at all: the body is never taken for it.
    const agentReads = vi.spyOn(db, "getAgent");
    for (const bodyText of ['["hello"]', '{"q":"hello"}', '{"input":null,"q":"hello"}']) {
      const res = await postBody("input-shapes", bodyText);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "INVALID_REQUEST",
      );
    }
    expect(agentReads).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("an array input runs for an agent whose inputs are all optional, its row keeping it", async () => {
    await pushAgentWithInput("optional-input", [
      "  - name: q",
      "    type: string",
      "    required: false",
    ]);

    const res = await postBody("optional-input", '{"input":["hello"]}');

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    const [row] = await db.listRuns();
    expect(row?.status).toBe("completed");
    expect(row?.input).toEqual(["hello"]);
  });
});

describe("POST /run — a file input whose element is not a file source", () => {
  // A file input takes source descriptors — `{ type: "file", source: "id" |
  // "data" | "url", … }`, one or a list of them. An element that is not one (a
  // number, null, an empty object, an unknown source, a url that is not a
  // string) threw out of the input's resolution: a 500, and an unhandled error
  // in the server's log. It is the caller's mistake, refused as one: 400
  // INVALID_INPUT_TYPE, the message naming the field, the element when the
  // field is a list, and what is wrong with it — never the value sent. The
  // resolution comes before the admission: nothing of the run is written.
  const PNG = { type: "file", source: "data", media_type: "image/png", data: "aGk=" };
  const NOT_A_SOURCE = "Invalid discriminator value. Expected 'id' | 'data' | 'url'";

  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let execute: MockInstance;

  beforeEach(async () => {
    logLines.length = 0;
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    execute = vi.spyOn(LocalAdapter.prototype, "execute");
    execute.mockImplementation(async (request: RunRequest) => ({
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    }));
    await pushPhotoAgent("optional-photo", ["    required: false", "    max_count: 2"]);
    await pushPhotoAgent("required-photo", []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An agent whose one input is the image file `photo`, with `extraLines` added to it. */
  async function pushPhotoAgent(name: string, extraLines: string[]): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: photo",
      "    type: file",
      "    media: image",
      ...extraLines,
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  /** A synchronous run of the dev token's `name`, its input written as JSON text. */
  function postInput(name: string, inputText: string): Promise<Response> {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
      },
      body: `{"input":${inputText}}`,
    });
  }

  const unhandledLines = () => logLines.filter((line) => line.event === "unhandled_error");

  it.each([
    [
      "a number",
      "optional-photo",
      '{"photo":5}',
      "Input 'photo' is not a file source (Invalid input: expected object, received number)",
    ],
    [
      "a string",
      "optional-photo",
      '{"photo":"x"}',
      "Input 'photo' is not a file source (Invalid input: expected object, received string)",
    ],
    [
      "an empty object",
      "optional-photo",
      '{"photo":{}}',
      `Input 'photo' is not a file source (source: ${NOT_A_SOURCE})`,
    ],
    [
      "a list holding null",
      "optional-photo",
      '{"photo":[null]}',
      "Input 'photo' item 0 is not a file source (Invalid input: expected object, received null)",
    ],
    [
      "a list holding an empty object",
      "optional-photo",
      '{"photo":[{}]}',
      `Input 'photo' item 0 is not a file source (source: ${NOT_A_SOURCE})`,
    ],
    [
      "a list holding a list",
      "optional-photo",
      '{"photo":[[]]}',
      "Input 'photo' item 0 is not a file source (Invalid input: expected object, received array)",
    ],
    [
      "an unknown source",
      "optional-photo",
      '{"photo":[{"type":"file","source":"__proto__"}]}',
      `Input 'photo' item 0 is not a file source (source: ${NOT_A_SOURCE})`,
    ],
    [
      "a url that is not a string",
      "optional-photo",
      '{"photo":[{"type":"file","source":"url","url":5}]}',
      "Input 'photo' item 0 is not a file source (url: Invalid input: expected string, received number)",
    ],
    [
      "a source without its type",
      "optional-photo",
      '{"photo":[{"source":"url","url":5}]}',
      `Input 'photo' item 0 is not a file source (type: Invalid input: expected "file")`,
    ],
    [
      "a second element whose file id is empty",
      "optional-photo",
      `{"photo":[${JSON.stringify(PNG)},{"type":"file","source":"id","file_id":""}]}`,
      "Input 'photo' item 1 is not a file source (file_id: Too small: expected string to have >=1 characters)",
    ],
    [
      "an object that looks like a list, for a required input",
      "required-photo",
      '{"photo":{"length":1}}',
      `Input 'photo' is not a file source (source: ${NOT_A_SOURCE})`,
    ],
  ])("%s is refused 400 INVALID_INPUT_TYPE, the field and the element named, nothing written and nothing logged as unhandled", async (_label, agent, inputText, message) => {
    const admissions = vi.spyOn(db, "admitRun");

    const res = await postInput(agent, inputText);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "INVALID_INPUT_TYPE", message } });
    expect(unhandledLines()).toEqual([]);
    expect(admissions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.listRuns()).toEqual([]);
  });

  it("the refusal never carries the value sent, and no log line does", async () => {
    const WITNESS = "jane-doe-7f3a";
    for (const element of [
      { type: "file", source: "url", url: `not a url ${WITNESS}` },
      { type: "file", source: WITNESS },
      { type: WITNESS, source: "id", file_id: "fil_1" },
    ]) {
      const res = await postInput("optional-photo", JSON.stringify({ photo: [element] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_INPUT_TYPE");
      expect(body.error.message).toMatch(/^Input 'photo' item 0 is not a file source \(/);
      expect(body.error.message).not.toContain(WITNESS);
    }
    expect(JSON.stringify(logLines)).not.toContain(WITNESS);
    expect(await db.listRuns()).toEqual([]);
  });

  it("a file source still runs: one alone, a list of one, a list of two", async () => {
    for (const photo of [PNG, [PNG], [PNG, PNG]]) {
      const res = await postInput("optional-photo", JSON.stringify({ photo }));
      expect(res.status).toBe(200);
    }

    const parts = execute.mock.calls.map(
      ([request]) => (request as RunRequest).resolvedInputs?.get("photo")?.length,
    );
    expect(parts).toEqual([1, 1, 2]);
    const rows = await db.listRuns();
    expect(rows.map((row) => row.status)).toEqual(["completed", "completed", "completed"]);
    expect(unhandledLines()).toEqual([]);
  });
});

describe("POST /run — an output nested deeper than the bound", () => {
  // The whole local run is real — route, adapter, agent loop, router — save the
  // provider, whose construction is replaced: it answers an output nested ten
  // thousand levels deep, as an endpoint an agent declares (`model.base_url`)
  // may. The schema of an `object` output accepts any shape inside: the output
  // passed the loop, the row finished, and writing it to the caller overflowed
  // the stack — a 502 in sync, a stream cut before its final event, no
  // delivery. The loop now refuses it as an invalid output, and the caller and
  // the row say the same failure.
  const DEEP_ANSWER = `{"answer":${'{"n":'.repeat(9_999)}1${"}".repeat(9_999)}}`;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let calls: number;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    deliverWebhook.mockClear();
    calls = 0;
    vi.spyOn(
      LLMRouter.prototype as unknown as {
        createProvider: (provider: string, apiKey: string) => unknown;
      },
      "createProvider",
    ).mockImplementation((provider: string) => ({
      name: provider,
      call: async () => {
        calls++;
        return { content: DEEP_ANSWER, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Push a local agent whose one output is an `object`, any shape inside. */
  async function pushObjectAgent(name: string): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: object",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...DEV_AUTH, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: the run fails OUTPUT_SCHEMA_INVALID, the bound named, after its one repair — its caller told so, its row failed with the same error and charged", async (mode) => {
    // The case's premise: the model's answer, parsed, cannot be written back as JSON.
    expect(() => JSON.stringify(JSON.parse(DEEP_ANSWER))).toThrow(RangeError);
    const name = `deep-output-${mode}`;
    await pushObjectAgent(name);

    const res = await startRun(app, mode, name);

    let told: Record<string, unknown>;
    if (mode === "sync") {
      expect(res.status).toBe(200);
      told = (await res.json()) as Record<string, unknown>;
    } else if (mode === "sse") {
      expect(res.status).toBe(200);
      const events = parseSseEvents(await res.text());
      expect(events.map(({ event }) => event)).toEqual([
        "run_start",
        "llm_complete",
        "output_validation_warning",
        "llm_complete",
        "run_error",
      ]);
      told = events.at(-1)?.data as Record<string, unknown>;
    } else {
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
      told = deliverWebhook.mock.calls[0]?.[1] as Record<string, unknown>;
    }

    expect(calls).toBe(2);
    const message = expect.stringMatching(
      /^Output validation failed after repair retry: .*nested more than 100 levels deep/,
    );
    if (mode === "sync") {
      expect(told).toMatchObject({ status: "failed", error: message });
    } else {
      expect(told).toMatchObject({ error: { code: "OUTPUT_SCHEMA_INVALID", message } });
    }
    const [row] = await db.listRuns();
    expect(row).toMatchObject({
      status: "failed",
      error: message,
      output: null,
      charged_ms: expect.any(Number),
    });
  });
});

describe("POST /run — a tool call whose arguments are nested deeper than the bound", () => {
  // The whole local run is real — route, adapter, agent loop, router — save
  // the provider, whose construction is replaced, and the run's one tool: the
  // model asks for it with arguments nested ten thousand levels deep, as an
  // endpoint an agent declares (`model.base_url`) may, then answers. The
  // tool_call event carried the arguments as they were: writing it to the
  // stream failed, the caller received run_start alone, and the row ended
  // failed, "The run ended unexpectedly.". The tool is now not called, the
  // model reads an error result, and the event carries a mention instead.
  const DEEP_ARGS = `{"q":${'{"n":'.repeat(9_999)}1${"}".repeat(9_999)}}`;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let calls: number;
  let callTool: MockInstance;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    calls = 0;
    vi.spyOn(
      LLMRouter.prototype as unknown as {
        createProvider: (provider: string, apiKey: string) => unknown;
      },
      "createProvider",
    ).mockImplementation((provider: string) => ({
      name: provider,
      call: async () => {
        calls++;
        return calls === 1
          ? {
              content: "",
              toolCalls: [{ name: "lookup", args: JSON.parse(DEEP_ARGS), id: "call-1" }],
              usage: { promptTokens: 1, completionTokens: 1 },
            }
          : { content: '{"answer":"ok"}', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    }));
    vi.spyOn(ToolRegistry.prototype, "listTools").mockResolvedValue([
      { name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } },
    ]);
    callTool = vi
      .spyOn(ToolRegistry.prototype, "callTool")
      .mockResolvedValue({ content: "found", isError: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streamed: the caller receives every event to run_complete, the tool is never called, and the row ends completed", async () => {
    // The case's premise: the model's arguments, parsed, cannot be written back as JSON.
    expect(() => JSON.stringify(JSON.parse(DEEP_ARGS))).toThrow(RangeError);
    await pushLocalAgent(app, "deep-tool-args");

    const res = await startRun(app, "sse", "deep-tool-args");

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.map(({ event }) => event)).toEqual([
      "run_start",
      "tool_call",
      "tool_call_error",
      "tool_result",
      "llm_complete",
      "run_complete",
    ]);
    const notCalled = expect.stringMatching(
      /^Arguments nested more than 100 levels deep .*: the tool was not called$/,
    );
    expect(events[1]?.data).toMatchObject({ tool: "lookup", args: { _omitted: notCalled } });
    expect(events[2]?.data).toMatchObject({ tool: "lookup", message: notCalled });
    expect(events[5]?.data).toMatchObject({ output: { answer: "ok" } });
    expect(callTool).not.toHaveBeenCalled();
    expect(calls).toBe(2);
    const [row] = await db.listRuns();
    expect(row).toMatchObject({ status: "completed", output: { answer: "ok" }, error: null });
  });
});

describe("POST /run — a run whose model reports a usage no column holds", () => {
  // The whole local run is real — route, adapter, agent loop, router — save
  // the provider, whose construction is replaced: it answers with the usage an
  // endpoint an agent declares may report — a count past an integer, a
  // fraction. Postgres refused such a number, and with it the run's final
  // write: its row stayed running, its caller served, its account charged
  // nothing once its deadline had passed. The row now keeps them bounded.
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db, { verificationPolicy: "owner", runtimeMode: "local" });
    deliverWebhook.mockClear();
    vi.spyOn(
      LLMRouter.prototype as unknown as {
        createProvider: (provider: string, apiKey: string) => unknown;
      },
      "createProvider",
    ).mockImplementation((provider: string) => ({
      name: provider,
      call: async () => ({
        content: '{"answer":"done"}',
        usage: { promptTokens: 1.5, completionTokens: 1e12, cacheReadTokens: 3e9 },
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: the run completes, its caller told the usage as the run counted it; its row finished and charged, each number bounded to what its column holds", async (mode) => {
    const name = `usage-unbounded-${mode}`;
    await pushLocalAgent(app, name);

    const res = await app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        ...DEV_AUTH,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
        ...(mode === "sse" && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify({
        input: { q: "hello" },
        ...(mode === "webhook" && { webhook_url: "https://hooks.example.com/x" }),
      }),
    });
    let told: Record<string, unknown>;
    if (mode === "sync") {
      expect(res.status).toBe(200);
      told = (await res.json()) as Record<string, unknown>;
    } else if (mode === "sse") {
      expect(res.status).toBe(200);
      told = parseSseEvents(await res.text()).find(({ event }) => event === "run_complete")
        ?.data as Record<string, unknown>;
    } else {
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
      told = deliverWebhook.mock.calls[0]?.[1] as Record<string, unknown>;
    }

    expect(told).toMatchObject({
      output: { answer: "done" },
      usage: { prompt_tokens: 1.5, completion_tokens: 1e12, cache_read_tokens: 3e9 },
    });
    const [row] = await db.listRuns();
    expect(row).toMatchObject({
      status: "completed",
      output: { answer: "done" },
      charged_ms: expect.any(Number),
      usage_prompt_tokens: 2,
      usage_completion_tokens: 2_147_483_647,
      usage_total_tokens: 2_147_483_647,
      usage_cache_read_tokens: 2_147_483_647,
      usage_cache_write_tokens: 0,
      usage_estimated_cost: 9_999.999999,
    });
  });
});
