import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../packages/api/src/index.js";
import { parseSseEvents } from "../../packages/api/src/routes/flyio-run-harness.shared.js";
import { storeVersion } from "../../packages/api/src/routes/stored-version.shared.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter, LocalAdapter, type RunRequest } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import {
  createTestApp,
  DEV_TOKEN,
  runAgent,
  runAgentSSE,
  runAgentWebhook,
  verifyVersion,
} from "./setup.js";

/**
 * `dev/test-agent@1.0.0`, verified, stored as a push stored a bundle that does
 * not unpack before it refused one: a run reaches its bundle extraction and
 * fails there, before any model is called. The runtime gate is exercised in
 * tests/e2e/verification.test.ts.
 */
async function storeUnpackableAgent(ctx: ReturnType<typeof createTestApp>): Promise<void> {
  await storeVersion({
    app: ctx.app,
    storage: ctx.storage,
    db: ctx.db,
    token: DEV_TOKEN,
    namespace: "dev",
    name: "test-agent",
    version: "1.0.0",
    bundle: Buffer.from("fake-bundle"),
    verified: true,
  });
}

describe("E2E: SSE Streaming", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    await storeUnpackableAgent(ctx);
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

  it("SSE with Accept header on a stored bundle that does not unpack returns a JSON error, not SSE", async () => {
    // The bundle fails to extract → the route catches this BEFORE SSE starts
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
    await storeUnpackableAgent(ctx);
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

  it("webhook with valid HTTPS URL but a stored bundle that does not unpack returns 500 (bundle extraction fails before 202)", async () => {
    // The server can't extract the stored bundle → returns 500 instead of 202
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

describe("E2E: the streamed run_complete has the shape of the sync result", () => {
  let app: ReturnType<typeof createApp>;
  /** Tokens the simulated model reports as served from its cache, per test. */
  let cacheReadTokens: number | undefined;

  beforeEach(async () => {
    app = createTestApp().app;
    cacheReadTokens = undefined;
    // The model is simulated, and reports the tokens it served from its cache:
    // the route turns them into savings with the model's price.
    vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => ({
      content: '{"answer":"ok"}',
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        ...(cacheReadTokens !== undefined && { cacheReadTokens }),
      },
      estimatedCost: 0.001,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      durationMs: 1,
    }));
    // The run leaves one output file in its output directory, as a script does;
    // the adapter itself is the real one and collects it.
    const collect = LocalAdapter.prototype.executeStream;
    vi.spyOn(LocalAdapter.prototype, "executeStream").mockImplementation(async function* (
      this: LocalAdapter,
      request: RunRequest,
    ) {
      if (request.outputDir) writeFileSync(join(request.outputDir, "report.txt"), "hello");
      yield* collect.call(this, request);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Push a runnable bundle under its own name (extracted bundles are cached per process). */
  async function pushRunnable(name: string): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-6",
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
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await verifyVersion(app, { name });
  }

  const callerKey = JSON.stringify({ anthropic: "sk-ant-fake-caller-key" });

  interface Shape {
    run_id: string;
    files: Array<Record<string, unknown>>;
    cost: { estimated: number; saved?: number };
  }

  async function streamedComplete(name: string): Promise<Shape> {
    const res = await runAgentSSE(app, { name, input: { q: "hi" }, llmKeyHeader: callerKey });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(["run_start", "llm_complete", "run_complete"]);
    return events[2]?.data as Shape;
  }

  async function syncResult(name: string): Promise<Shape> {
    const res = await runAgent(app, { name, input: { q: "hi" }, llmKeyHeader: callerKey });
    expect(res.status).toBe(200);
    return (await res.json()) as Shape;
  }

  it("carries each file with its url and file_id, and the cache savings, as the sync result does", async () => {
    await pushRunnable("stream-shape-saved");
    cacheReadTokens = 10_000;

    const streamed = await streamedComplete("stream-shape-saved");
    const sync = await syncResult("stream-shape-saved");

    expect(streamed.files).toEqual([
      {
        name: "report.txt",
        size: 5,
        url: `/api/runs/${streamed.run_id}/files/report.txt`,
        file_id: expect.stringMatching(/^fil_[0-9a-f]{32}$/),
      },
    ]);
    expect(Object.keys(streamed.files[0] ?? {}).sort()).toEqual(
      Object.keys(sync.files[0] ?? {}).sort(),
    );
    expect(sync.cost.saved).toBeGreaterThan(0);
    expect(streamed.cost).toEqual(sync.cost);
  });

  it("leaves saved out when the cache saved nothing, as the sync result does", async () => {
    await pushRunnable("stream-shape-unsaved");

    const streamed = await streamedComplete("stream-shape-unsaved");
    const sync = await syncResult("stream-shape-unsaved");

    expect(sync.cost).not.toHaveProperty("saved");
    expect(streamed.cost).toEqual(sync.cost);
    expect(streamed.files[0]?.url).toBe(`/api/runs/${streamed.run_id}/files/report.txt`);
  });
});
