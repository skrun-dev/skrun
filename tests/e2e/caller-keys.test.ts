/**
 * E2E: Caller-provided LLM API keys — X-LLM-API-Key header
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import { DEV_TOKEN, pushAgent, runAgent, createTestApp as setup, verifyVersion } from "./setup.js";

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
  // Only the header CONTRACT is exercised in this block: the shared `pushAgent`
  // helper pushes a fake bundle that never reaches the gate, which sits after
  // `parseAgentYaml`. The gate itself is exercised below, on a runnable bundle.

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

// The endpoint gate, end to end: a runnable bundle, a key the owner hands a
// client (scoped to running one agent, so not an account credential), and the
// model call intercepted — no network. Under a declared `model.base_url`, only
// a key for the primary model's provider goes to that endpoint; the fallback
// goes to its own provider's default endpoint. So the caller names the
// endpoint's origin beside a key for the primary's provider — which a fallback
// on that same provider uses too — and a key for another fallback's provider
// alone goes through. Every origin the caller names, a key sent or not, must
// be where that provider's key goes: the agent's for the primary's provider,
// none for any other, and none at all on an agent with no endpoint.
describe("E2E: the endpoint gate reads every origin named, and the key for the primary model's provider", () => {
  let ctx: ReturnType<typeof setup>;
  let modelCalls: MockInstance;

  beforeEach(() => {
    ctx = setup();
    modelCalls = vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => ({
      content: '{"answer":"ok"}',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      estimatedCost: 0,
      provider: "openai",
      model: "gpt-4o-mini",
      durationMs: 1,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Push and verify a google agent that sends its model requests to its own
   * endpoint — unless `ownEndpoint` is false — with a fallback on
   * `fallbackProvider`, or none; return a key scoped to running it. Each test
   * pushes its own name: extracted bundles are cached.
   */
  async function pushEndpointAgent(
    name: string,
    fallbackProvider: "openai" | "google" | "none",
    { ownEndpoint = true }: { ownEndpoint?: boolean } = {},
  ) {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      ...(ownEndpoint ? ["  base_url: https://models.example/v1"] : []),
      ...(fallbackProvider === "none"
        ? []
        : [
            "  fallback:",
            `    provider: ${fallbackProvider}`,
            `    name: ${fallbackProvider === "openai" ? "gpt-4o-mini" : "gemini-2.5-pro"}`,
          ]),
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
    const res = await ctx.app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await verifyVersion(ctx.app, { name });
    const agent = await ctx.db.getAgent("dev", name);
    if (!agent) throw new Error("agent missing after push");
    const { key, keyHash, keyPrefix } = generateApiKey();
    await ctx.db.createApiKey({
      user_id: agent.owner_id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "scoped",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agent.id],
    });
    return key;
  }

  /** A run with these keys (none: no X-LLM-API-Key) and these origins named. */
  async function runWithKeys(
    name: string,
    token: string,
    keys: Record<string, string> | undefined,
    baseUrls?: Record<string, string>,
  ) {
    const res = await runAgent(ctx.app, {
      name,
      token,
      input: { q: "hello" },
      ...(keys && { llmKeyHeader: JSON.stringify(keys) }),
      ...(baseUrls && { llmBaseUrlHeader: JSON.stringify(baseUrls) }),
    });
    const body = (await res.json()) as { status?: string; error?: { code?: string } };
    return {
      status: res.status,
      code: body.error?.code,
      result: body.status,
      modelCalls: modelCalls.mock.calls.length,
    };
  }

  it("a key for the fallback's provider alone, no endpoint named: the run completes", async () => {
    const token = await pushEndpointAgent("gate-fallback-key", "openai");

    expect(await runWithKeys("gate-fallback-key", token, { openai: "sk-fake-caller" })).toEqual({
      status: 200,
      code: undefined,
      result: "completed",
      modelCalls: 1,
    });
  });

  it("a key for the fallback's provider alone, another origin named for the primary's: refused with 403 before any model call", async () => {
    const token = await pushEndpointAgent("gate-fallback-key-wrong-origin", "openai");

    expect(
      await runWithKeys(
        "gate-fallback-key-wrong-origin",
        token,
        { openai: "sk-fake-caller" },
        { google: "https://elsewhere.example/v1" },
      ),
    ).toEqual({
      status: 403,
      code: "CALLER_BASE_URL_NOT_CONSENTED",
      result: undefined,
      modelCalls: 0,
    });
  });

  it("a key for the fallback's provider alone, the agent's origin named: the run completes", async () => {
    const token = await pushEndpointAgent("gate-fallback-key-right-origin", "openai");

    expect(
      await runWithKeys(
        "gate-fallback-key-right-origin",
        token,
        { openai: "sk-fake-caller" },
        { google: "https://models.example" },
      ),
    ).toEqual({
      status: 200,
      code: undefined,
      result: "completed",
      modelCalls: 1,
    });
  });

  it("a key for the primary's provider, no endpoint named: refused with 403 before any model call", async () => {
    const token = await pushEndpointAgent("gate-primary-key", "openai");

    expect(await runWithKeys("gate-primary-key", token, { google: "fake-caller" })).toEqual({
      status: 403,
      code: "CALLER_BASE_URL_NOT_CONSENTED",
      result: undefined,
      modelCalls: 0,
    });
  });

  it("a fallback on the primary's provider uses the same key: refused with 403 too", async () => {
    const token = await pushEndpointAgent("gate-same-provider-key", "google");

    expect(await runWithKeys("gate-same-provider-key", token, { google: "fake-caller" })).toEqual({
      status: 403,
      code: "CALLER_BASE_URL_NOT_CONSENTED",
      result: undefined,
      modelCalls: 0,
    });
  });

  const REFUSED_AT_THE_GATE = {
    status: 403,
    code: "CALLER_BASE_URL_NOT_CONSENTED",
    result: undefined,
    modelCalls: 0,
  };

  it("no key at all, another origin named for the primary's: refused with 403 before any model call", async () => {
    const token = await pushEndpointAgent("gate-no-key-wrong-origin", "openai");

    expect(
      await runWithKeys("gate-no-key-wrong-origin", token, undefined, {
        google: "https://elsewhere.example/v1",
      }),
    ).toEqual(REFUSED_AT_THE_GATE);
  });

  // No fallback: past the gate, no server key can serve this run — the server
  // never sends its own to an agent's endpoint — so it ends on the key check.
  it("no key at all, the agent's origin named: past the gate, refused with 400 for want of a key", async () => {
    const token = await pushEndpointAgent("gate-no-key-right-origin", "none");

    expect(
      await runWithKeys("gate-no-key-right-origin", token, undefined, {
        google: "https://models.example",
      }),
    ).toEqual({ status: 400, code: "LLM_KEY_REQUIRED", result: undefined, modelCalls: 0 });
  });

  it.each([
    ["a key for it", "gate-fallback-origin-key", { openai: "sk-fake-caller" }],
    ["no key at all", "gate-fallback-origin-no-key", undefined],
  ] as const)("an origin named for the fallback's provider, %s: refused with 403 before any model call", async (_how, name, keys) => {
    const token = await pushEndpointAgent(name, "openai");

    expect(
      await runWithKeys(name, token, keys, { openai: "https://api.openai.example/v1" }),
    ).toEqual(REFUSED_AT_THE_GATE);
  });

  it("an origin named for a provider the agent does not use: refused with 403 before any model call", async () => {
    const token = await pushEndpointAgent("gate-unused-provider-origin", "openai");

    expect(
      await runWithKeys(
        "gate-unused-provider-origin",
        token,
        { openai: "sk-fake-caller" },
        { anthropic: "https://api.anthropic.example" },
      ),
    ).toEqual(REFUSED_AT_THE_GATE);
  });

  it.each([
    ["no key at all", "gate-no-endpoint-no-key", undefined, "google"],
    [
      "a key for the primary's provider, an origin for the fallback's",
      "gate-no-endpoint-fallback-origin",
      { google: "fake-caller" },
      "openai",
    ],
  ] as const)("an agent with no endpoint of its own, an origin named with %s: refused with 403 before any model call", async (_how, name, keys, named) => {
    const token = await pushEndpointAgent(name, "openai", { ownEndpoint: false });

    expect(
      await runWithKeys(name, token, keys, { [named]: "https://elsewhere.example/v1" }),
    ).toEqual(REFUSED_AT_THE_GATE);
  });
});
