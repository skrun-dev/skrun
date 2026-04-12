import { describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
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
