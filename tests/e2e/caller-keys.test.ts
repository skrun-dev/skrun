/**
 * E2E: Caller-provided LLM API keys — X-LLM-API-Key header
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp as setup, pushAgent, runAgent } from "./setup.js";

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
});
