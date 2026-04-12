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

  async function pushAndRun(token: string, verified: boolean) {
    // Push a fake agent bundle
    const bundle = Buffer.from("fake-bundle");
    await app.request("/api/agents/dev/script-agent/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: bundle,
    });

    // Set verification if needed
    if (verified) {
      db.setVerified("dev", "script-agent", true);
    }

    // Try to run
    return app.request("/api/agents/dev/script-agent/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { code: "test" } }),
    });
  }

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
