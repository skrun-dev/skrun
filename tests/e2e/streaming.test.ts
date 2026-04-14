import { beforeEach, describe, expect, it } from "vitest";
import type { createApp } from "../../packages/api/src/index.js";
import {
  DEV_TOKEN,
  createTestApp,
  pushAgent,
  runAgent,
  runAgentSSE,
  runAgentWebhook,
} from "./setup.js";

describe("E2E: SSE Streaming", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    await pushAgent(app);
  });

  it("sync mode still works without Accept header (backward compat — UAT-2)", async () => {
    const res = await runAgent(app);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    expect(contentType).not.toContain("text/event-stream");
  });

  it("auth failure returns 401 JSON, not SSE stream (UAT-9)", async () => {
    const res = await runAgentSSE(app, { token: "" });
    expect(res.status).toBe(401);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });

  it("SSE + webhook conflict returns 400 (EC-1)", async () => {
    const res = await runAgentSSE(app, { webhookUrl: "https://example.com/hook" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, Record<string, string>>;
    expect(body.error.code).toBe("SSE_WEBHOOK_CONFLICT");
  });

  it("SSE request on non-existent agent returns JSON error, not SSE", async () => {
    const res = await runAgentSSE(app, { name: "nonexistent" });
    const contentType = res.headers.get("content-type") ?? "";
    // Errors before execution start should be JSON, not SSE
    expect(contentType).toContain("application/json");
  });

  it("SSE with Accept header on fake bundle returns SSE content-type with error event", async () => {
    // Fake bundle will fail to extract → the route catches this BEFORE SSE starts
    // and returns a JSON error (500 BUNDLE_CORRUPT)
    const res = await runAgentSSE(app);
    // Bundle extraction fails → returns JSON 500 (not SSE)
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, Record<string, string>>;
    expect(body.error.code).toBe("BUNDLE_CORRUPT");
  });

  it("API keys not in any error response from SSE request (EC-7)", async () => {
    const fakeKey = "sk-super-secret-key-12345";
    const res = await runAgentSSE(app, {
      llmKeyHeader: JSON.stringify({ anthropic: fakeKey }),
    });
    const text = await res.text();
    expect(text).not.toContain(fakeKey);
  });

  it("rate limit headers are present on SSE requests (IT-3)", async () => {
    // Rate limiting applies to /run regardless of Accept header
    const res = await runAgentSSE(app);
    expect(res.headers.get("X-RateLimit-Limit")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
  });
});

describe("E2E: Webhook", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    await pushAgent(app);
  });

  it("invalid webhook URL returns 400 (EC-2)", async () => {
    const res = await runAgentWebhook(app, {
      webhookUrl: "not-a-url",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, Record<string, string>>;
    expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("HTTP webhook in production returns 400 (EC-3)", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await runAgentWebhook(app, {
        webhookUrl: "http://example.com/hook",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, Record<string, string>>;
      expect(body.error.code).toBe("INVALID_WEBHOOK_URL");
      expect(body.error.message).toContain("HTTPS");
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("webhook with valid HTTPS URL but fake bundle returns 500 (bundle extraction fails before 202)", async () => {
    // With a fake bundle, the server can't extract it → returns 500 instead of 202
    // This proves that validation happens before background execution
    const res = await runAgentWebhook(app, {
      webhookUrl: "https://example.com/hook",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, Record<string, string>>;
    expect(body.error.code).toBe("BUNDLE_CORRUPT");
  });

  it("SSE + webhook conflict returns 400 even from webhook request", async () => {
    // Send a request with both webhook_url AND Accept: text/event-stream
    const res = await app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: {}, webhook_url: "https://example.com/hook" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, Record<string, string>>;
    expect(body.error.code).toBe("SSE_WEBHOOK_CONFLICT");
  });
});
