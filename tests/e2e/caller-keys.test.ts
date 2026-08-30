/**
 * E2E: Caller-provided LLM API keys — X-LLM-API-Key header
 */
import { beforeEach, describe, expect, it } from "vitest";
import { pushAgent, runAgent, createTestApp as setup } from "./setup.js";

describe("E2E: Caller-provided LLM keys", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await pushAgent(ctx.app, { name: "my-agent" });
  });

  it("valid JSON header passes parsing (reaches agent load)", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmKeyHeader: '{"google": "fake-key"}',
    });
    // Should get past header parsing — not a 400
    expect(res.status).not.toBe(400);
  });

  it("malformed header returns 400", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmKeyHeader: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_KEY_HEADER");
  });

  it("empty object header returns 400", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmKeyHeader: "{}",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("at least one");
  });

  it("non-string values return 400", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmKeyHeader: '{"google": 123}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("must be a string");
  });

  it("no header falls back to server keys (no 400)", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
    });
    expect(res.status).not.toBe(400);
  });

  // --- X-LLM-Base-URL: the caller's declaration of where their key belongs ---
  //
  // Only the header CONTRACT is exercised here. The gate itself sits after
  // `parseAgentYaml`, and this file's shared `pushAgent` helper pushes a fake
  // bundle that never gets that far — the gate's behaviour is covered end to end
  // through the same `createApp` stack in packages/api/src/routes/run.test.ts,
  // which builds a real `packAgentTar` bundle. Duplicating it here would need a
  // real-bundle helper in the shared setup and would add no coverage.

  it("X-LLM-Base-URL: malformed JSON returns 400", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmBaseUrlHeader: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_BASE_URL_HEADER");
  });

  it("X-LLM-Base-URL: a non-URL value returns 400", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmBaseUrlHeader: '{"google": "not-a-url"}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LLM_BASE_URL_HEADER");
  });

  it("X-LLM-Base-URL: a valid declaration passes parsing", async () => {
    const res = await runAgent(ctx.app, {
      name: "my-agent",
      input: { text: "hello" },
      llmKeyHeader: '{"google": "fake-key"}',
      llmBaseUrlHeader: '{"google": "https://api.example.com/v1"}',
    });
    expect(res.status).not.toBe(400);
  });
});
