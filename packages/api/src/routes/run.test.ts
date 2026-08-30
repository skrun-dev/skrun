import { packAgentTar } from "@skrun-dev/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { RegistryService } from "../services/registry.js";
import type { VerificationPolicy } from "../services/verification-policy.js";
import { MemoryStorage } from "../storage/memory.js";

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
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

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
    // Per spec Q-11: no escape hatch. dev-token is admin so it CAN call
    // PATCH .../versions/:v/verify to unblock the run, but the gate itself
    // does not auto-pass for dev-token — same boundary as OAuth callers.
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

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
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    // Verify via the new per-version endpoint (dev-token = admin).
    await db.setVersionVerified("dev", "test-agent", "1.0.0", true);

    const res = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "hello" } }),
    });
    // Past the verified gate now — fails downstream at bundle extraction
    // (fake-bundle isn't a valid zip), which is a different code path.
    expect(res.status).not.toBe(403);
  });

  it("latest_version_verified is readable in metadata", async () => {
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

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

  async function pushBundle(agent: string, version: string, content = "fake-bundle") {
    const bundle = Buffer.from(`${content}-${version}`);
    await app.request(`/api/agents/dev/${agent}/push?version=${version}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });
  }

  async function runWithBody(body: Record<string, unknown>) {
    return app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: authHeader,
      body: JSON.stringify(body),
    });
  }

  // --- Format validation (EC-1..6) ---

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

  // --- 404 VERSION_NOT_FOUND with available (UAT-3) ---

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
    for (let i = 1; i <= 12; i++) {
      await pushBundle("test-agent", `1.0.${i}`);
    }
    const res = await runWithBody({ input: { text: "x" }, version: "9.9.9" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.available).toHaveLength(10);
    // newest first — 1.0.12 down to 1.0.3
    expect(body.error.available[0]).toBe("1.0.12");
  });

  // Webhook 202 body (UAT-5) and sync 200 body (UAT-1/2) assertions require a
  // real bundle to extract + execute — moved to E2E integration tests (6.4)
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

  it("VT-10: rejects webhook_url targeting private IPv4 (192.168.x.x)", async () => {
    const res = await postWithWebhook("https://192.168.1.1/hook");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
    expect(body.error.message).toMatch(/private or reserved/);
  });

  it("VT-10: rejects webhook_url targeting localhost", async () => {
    const res = await postWithWebhook("https://localhost/hook");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("VT-10: rejects webhook_url targeting AWS metadata via IPv4-mapped IPv6", async () => {
    const res = await postWithWebhook("https://[::ffff:169.254.169.254]/latest/meta-data");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("VT-10: rejects webhook_url targeting AWS metadata via raw IPv4", async () => {
    const res = await postWithWebhook("https://169.254.169.254/latest/meta-data");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("VT-10: accepts a public HTTPS webhook_url (proceeds past validation)", async () => {
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

// VT-22 (CODE-117): mechanical check — each of the 3 completed-run call sites
// in run.ts uses persistRunCompletion(...) instead of an inline db.updateRun
// for status='completed' with usage_cache_* fields. Guards the refactor from
// regressing later.
describe("CODE-117 persistRunCompletion helper", () => {
  it("VT-22: run.ts has 3 persistRunCompletion call sites (SSE / webhook / sync)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const src = readFileSync(join(resolve(import.meta.dirname), "run.ts"), "utf-8");
    const matches = src.match(/persistRunCompletion\(/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("VT-22: no inline 'usage_cache_savings_usd' writes left in run.ts (replaced by helper)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const src = readFileSync(join(resolve(import.meta.dirname), "run.ts"), "utf-8");
    expect(src).not.toMatch(/usage_cache_savings_usd:/);
  });
});

describe("POST /run — run-authorization + env-override (#81)", () => {
  let app: ReturnType<typeof createApp>;
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  /** Create a non-admin user + a usable sk_live key (role defaults to 'user'). */
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

  /** Owner pushes a fake bundle, then we mark the version verified (bypass admin). */
  async function pushVerified(ownerKey: string, namespace: string, name: string): Promise<void> {
    await app.request(`/api/agents/${namespace}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    await db.setVersionVerified(namespace, name, "1.0.0", true);
  }

  function runAs(key: string, ns: string, name: string, body: Record<string, unknown> = {}) {
    return app.request(`/api/agents/${ns}/${name}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, ...body }),
    });
  }

  it("VT-3: owner runs their own private agent (past run-auth + verify gate)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("VT-4: non-owner gets a 404 byte-identical to a genuinely-absent agent", async () => {
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

  it("VT-5: a public agent is runnable by a non-owner (past run-auth)", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
  });

  it("VT-6/6b: admin (dev-token, self-host) runs any private agent (admin bypass)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await app.request("/api/agents/alice/agent1/run", {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).not.toBe(404);
  });

  it("VT-7: run-auth fires before the bundle pull (storage.get not called on the 404 path)", async () => {
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

  it("VT-13: non-owner env override on a public agent → 403 ENV_OVERRIDE_FORBIDDEN", async () => {
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

  it("VT-14: owner env override is allowed (not 403 env-forbidden)", async () => {
    const alice = await makeUser("alice");
    await pushVerified(alice.key, "alice", "agent1");
    const res = await runAs(alice.key, "alice", "agent1", {
      environment: { networking: { allowed_hosts: ["api.example.com"] } },
    });
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body?.error?.code).not.toBe("ENV_OVERRIDE_FORBIDDEN");
  });

  it("RT-1: a public but unverified agent → 403 AGENT_NOT_VERIFIED (not a run-auth 404)", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await app.request("/api/agents/alice/agent1/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.key}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_NOT_VERIFIED",
    );
  });

  it("RT-3: a public verified agent runs for any authenticated caller", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await pushVerified(alice.key, "alice", "agent1");
    await db.setVisibility("alice", "agent1", "public");
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });
});

describe("POST /run — API-key scope (#65)", () => {
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

  /** Mint a usable sk_live key with a specific scope, DB-direct (route-level
   *  ownership validation is #65 task 4.1, not exercised here). */
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

  /** Owner pushes a fake bundle + marks it verified; returns the agent's db id. */
  async function pushVerified(ownerKey: string, ns: string, name: string): Promise<string> {
    await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
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

  it("VT-9: a key scoped to its agent runs it (past the scope gate)", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushVerified(alice.key, "alice", "agent1");
    const scoped = await makeScopedKey(alice.id, { agents: [agentId], operations: ["agent:run"] });
    const res = await runAs(scoped.key, "alice", "agent1");
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("VT-10: a scoped key on another OWNED agent → 403 KEY_SCOPE_FORBIDDEN", async () => {
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

  it("VT-11: a key lacking agent:run (push-only) → 403 KEY_SCOPE_FORBIDDEN", async () => {
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

  it("VT-12: a cross-account key → 404 (run-auth first), scope gate never reached, no pull", async () => {
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

  it("VT-13: the scope gate fires before the bundle pull (intra-account)", async () => {
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

describe("POST /run — caller-key policy (#102)", () => {
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
    await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from("fake-bundle"),
    });
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

  it("VT-18: creator_only rejects a run carrying X-LLM-API-Key (403, before the pull)", async () => {
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

  it("VT-19: the default (open) policy accepts a run carrying X-LLM-API-Key (past the gate)", async () => {
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

    /** Owner pushes a fake bundle; optionally mark the version verified (DB-direct). */
    async function push(
      ownerKey: string,
      ns: string,
      name: string,
      verified: boolean,
    ): Promise<void> {
      await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from("fake-bundle"),
      });
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

  it("VT-4: owner policy — owner runs their own UNVERIFIED agent (no verify gate)", async () => {
    const { makeUser, push, runAs } = setup("owner");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1", false);
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it("VT-7: disabled policy — an unverified agent is never gated on verification", async () => {
    const { makeUser, push, runAs } = setup("disabled");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1", false);
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).not.toBe(403);
  });

  it("RT-1: admin policy (default) still gates an unverified agent (403 AGENT_NOT_VERIFIED)", async () => {
    const { makeUser, push, runAs } = setup("admin");
    const alice = await makeUser("alice");
    await push(alice.key, "alice", "agent1", false);
    const res = await runAs(alice.key, "alice", "agent1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "AGENT_NOT_VERIFIED",
    );
  });

  it("RT-4: owner policy — run-auth (opaque 404) fires before the verify gate for a stranger", async () => {
    const { makeUser, push, runAs } = setup("owner");
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    await push(alice.key, "alice", "agent1", false); // private + unverified
    const res = await runAs(bob.key, "alice", "agent1");
    expect(res.status).toBe(404); // stranger sees an opaque 404, never a verify error
  });

  it("VT-13: dormant run-auth public branch — a DB-public verified agent runs for a non-owner", async () => {
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

describe("POST /run — caller base-URL gate (SEC-001 layer 3, audit/006)", () => {
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
   * Push a bundle that ACTUALLY PARSES. The file's other `pushVerified` helpers
   * push `Buffer.from("fake-bundle")`, which dies at BUNDLE_CORRUPT — long
   * before this gate, which sits after `parseAgentYaml`. Without a real bundle
   * these tests would pass while never reaching the code under test.
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

  // Each test uses its OWN agent name on purpose: `bundleCache` is module-scoped
  // and keyed on `namespace/name/version`, so two tests sharing a name serve each
  // other stale bundles — which silently inverted two of these assertions before
  // the names were split.

  it("VT-7: a delegated caller's key is refused when the agent declares a base_url", async () => {
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

  it("VT-8: naming the same origin lets the run proceed", async () => {
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

  it("VT-9: naming a DIFFERENT origin is refused, and both origins are named", async () => {
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

  it("VT-10: declaring an endpoint the agent does not use is refused too", async () => {
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

  it("VT-11: the owner with a master credential is exempt — no header needed", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "vt11-agent", { baseUrl: DECLARED });

    const res = await runAs(alice.key, "alice", "vt11-agent");
    const body = (await res.json()) as { error?: { code?: string } };
    // Same principal: the author of the agent.yaml and the owner of the key are
    // the same person. This is the documented docs/agent-yaml.md:66 flow and the
    // dashboard playground, both unchanged.
    expect(body.error?.code).not.toBe("CALLER_BASE_URL_NOT_CONSENTED");
  });

  it("VT-11b: the SAME owner account presenting a delegated key is NOT exempt", async () => {
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

  it("RT-2: a caller key on an agent with NO base_url is untouched", async () => {
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
