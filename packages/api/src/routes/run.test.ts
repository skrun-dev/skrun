import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { RegistryService } from "../services/registry.js";
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

describe("POST /run — webhook_url SSRF guard (SEC-007)", () => {
  // SSRF guard is production-only — in dev mode `http://localhost:NNNN/hook`
  // is the standard local test pattern, same dev-bypass policy as the HTTPS
  // check above (see run.ts webhook validation). Tests below force the prod
  // gate to exercise the reject path.
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCorsOrigin = process.env.CORS_ORIGIN;
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  const headers = {
    Authorization: "Bearer dev-token",
    "Content-Type": "application/json",
  };

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    // createApp throws in prod without CORS_ORIGIN (SEC-016); seed it.
    process.env.CORS_ORIGIN = "https://example.com";
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db);
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previousCorsOrigin;
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

  // VT-10 dev-mode bypass: localhost MUST be accepted when NODE_ENV != production
  // (live e2e tests use http://localhost:NNNN/callback to receive webhooks).
  it("VT-10 dev-bypass: accepts http://localhost/... when NODE_ENV != production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CORS_ORIGIN; // safe in dev
    const devApp = createApp(new MemoryStorage(), new MemoryDb());
    const res = await devApp.request("/api/agents/dev/any-agent/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: { text: "x" },
        webhook_url: "http://localhost:9999/callback",
      }),
    });
    // Webhook validation passed → response is NOT 400 INVALID_WEBHOOK_URL.
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
