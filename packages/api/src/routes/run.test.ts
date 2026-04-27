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

  it("non-verified agent: response does not crash (scripts skipped gracefully)", async () => {
    // Push agent (non-verified by default) and run with non-dev token
    // The run will fail at LLM call (no API key) but should NOT fail at verification
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
    // Should not be 400 or 500 from verification — it reaches the execution phase
    expect(res.status).not.toBe(400);
  });

  it("dev-token always bypasses verification", async () => {
    // Push agent (non-verified) and run with dev-token
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    const metadata = await service.getMetadata("dev", "test-agent");
    expect(metadata.verified).toBe(false);

    // Run with dev-token — should proceed past verification (no warning about scripts)
    const res = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text: "hello" } }),
    });
    expect(res.status).not.toBe(400);
  });

  it("verified flag is readable in metadata", async () => {
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/test-agent/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuthHeader, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    // Before verification
    let res = await app.request("/api/agents/dev/test-agent");
    let body = await res.json();
    expect(body.verified).toBe(false);

    // After verification
    db.setVerified("dev", "test-agent", true);
    res = await app.request("/api/agents/dev/test-agent");
    body = await res.json();
    expect(body.verified).toBe(true);
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
