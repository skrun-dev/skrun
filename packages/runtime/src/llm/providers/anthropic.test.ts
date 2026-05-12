import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMCapabilityError } from "../errors.js";
import { InMemoryProviderFileCache } from "../file-cache.js";
import type { SkrunPart } from "../parts.js";
import type { LLMCallRequest } from "./types.js";

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  betaMessagesCreate: vi.fn(),
  filesUpload: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  // vitest 4: arrow functions in mockImplementation can't be called with `new`.
  // Use a regular function so `new Anthropic(...)` works as a constructor mock.
  default: vi.fn().mockImplementation(function MockAnthropic(this: Record<string, unknown>) {
    this.messages = { create: mocks.messagesCreate };
    this.beta = {
      messages: { create: mocks.betaMessagesCreate },
      files: { upload: mocks.filesUpload },
    };
  }),
  toFile: vi.fn(async (_bytes: unknown, name: string, opts?: { type?: string }) => ({
    name,
    type: opts?.type,
  })),
}));

// Import AFTER vi.mock so the mocked constructor is used
const { AnthropicProvider } = await import("./anthropic.js");

const FAKE_RESPONSE = {
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 10, completionTokens: 5, output_tokens: 5 },
};

function makeRequest(userContent: SkrunPart[]): LLMCallRequest {
  return {
    model: "claude-3-7-sonnet",
    systemPrompt: "system",
    userContent,
    userMessage: "",
  };
}

describe("AnthropicProvider — multimodal translation", () => {
  beforeEach(() => {
    mocks.messagesCreate.mockReset();
    mocks.betaMessagesCreate.mockReset();
    mocks.filesUpload.mockReset();
    mocks.messagesCreate.mockResolvedValue(FAKE_RESPONSE);
    mocks.betaMessagesCreate.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("VT-20: translates an image SkrunPart to a base64 image content block", async () => {
    const provider = new AnthropicProvider("test-key");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await provider.call(makeRequest([{ kind: "image", media_type: "image/png", bytes }]));

    expect(mocks.messagesCreate).toHaveBeenCalledOnce();
    expect(mocks.betaMessagesCreate).not.toHaveBeenCalled();
    expect(mocks.filesUpload).not.toHaveBeenCalled();
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.messages[0].role).toBe("user");
    const blocks = sent.messages[0].content;
    expect(blocks).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(bytes).toString("base64"),
        },
      },
    ]);
  });

  it("translates a document SkrunPart to a base64 document content block", async () => {
    const provider = new AnthropicProvider("test-key");
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    await provider.call(makeRequest([{ kind: "document", media_type: "application/pdf", bytes }]));

    const sent = mocks.messagesCreate.mock.calls[0][0];
    const blocks = sent.messages[0].content;
    expect(blocks).toEqual([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from(bytes).toString("base64"),
        },
      },
    ]);
  });

  it("throws LLMCapabilityError for audio (Anthropic doesn't support audio)", async () => {
    const provider = new AnthropicProvider("test-key");
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF
    await expect(
      provider.call(makeRequest([{ kind: "audio", media_type: "audio/wav", bytes }])),
    ).rejects.toBeInstanceOf(LLMCapabilityError);
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.betaMessagesCreate).not.toHaveBeenCalled();
  });

  it("preserves text + image content block ordering", async () => {
    const provider = new AnthropicProvider("test-key");
    const imgBytes = new Uint8Array([1, 2, 3]);
    await provider.call(
      makeRequest([
        { kind: "text", text: "Describe:" },
        { kind: "image", media_type: "image/jpeg", bytes: imgBytes },
        { kind: "text", text: "in one word." },
      ]),
    );

    const sent = mocks.messagesCreate.mock.calls[0][0];
    const blocks = sent.messages[0].content;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "Describe:" });
    expect(blocks[1].type).toBe("image");
    expect(blocks[2]).toEqual({ type: "text", text: "in one word." });
  });

  it(">20MB payload triggers Files API pre-upload + uses file_id source", async () => {
    const provider = new AnthropicProvider("test-key");
    const big = new Uint8Array(21 * 1024 * 1024); // 21 MB
    mocks.filesUpload.mockResolvedValue({ id: "file_uploaded123", type: "file" });

    await provider.call(makeRequest([{ kind: "image", media_type: "image/jpeg", bytes: big }]));

    expect(mocks.filesUpload).toHaveBeenCalledOnce();
    expect(mocks.betaMessagesCreate).toHaveBeenCalledOnce();
    expect(mocks.messagesCreate).not.toHaveBeenCalled();

    const sent = mocks.betaMessagesCreate.mock.calls[0][0];
    expect(sent.betas).toEqual(["files-api-2025-04-14"]);
    const blocks = sent.messages[0].content;
    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "file", file_id: "file_uploaded123" },
      },
    ]);
  });

  it("two non-text parts under threshold both go inline (no Files API)", async () => {
    const provider = new AnthropicProvider("test-key");
    const a = new Uint8Array(5 * 1024 * 1024); // 5 MB each
    const b = new Uint8Array(5 * 1024 * 1024);

    await provider.call(
      makeRequest([
        { kind: "image", media_type: "image/jpeg", bytes: a },
        { kind: "image", media_type: "image/jpeg", bytes: b },
      ]),
    );

    expect(mocks.filesUpload).not.toHaveBeenCalled();
    expect(mocks.messagesCreate).toHaveBeenCalledOnce();
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.messages[0].content).toHaveLength(2);
  });

  it("text-only userContent does not trigger any non-text path", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call(makeRequest([{ kind: "text", text: "hello" }]));

    expect(mocks.filesUpload).not.toHaveBeenCalled();
    expect(mocks.messagesCreate).toHaveBeenCalledOnce();
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.messages[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("VT-19: provider file_id cache prevents re-upload across same-run calls", async () => {
    const provider = new AnthropicProvider("test-key");
    const big = new Uint8Array(21 * 1024 * 1024);
    mocks.filesUpload.mockResolvedValue({ id: "file_cached_123", type: "file" });

    const cache = new InMemoryProviderFileCache();
    const part: SkrunPart = { kind: "image", media_type: "image/jpeg", bytes: big };

    // First call — upload happens, cache populated
    await provider.call({ ...makeRequest([part]), _fileCache: cache });
    expect(mocks.filesUpload).toHaveBeenCalledTimes(1);

    // Second call with same bytes + same cache — cache hit, no second upload
    await provider.call({ ...makeRequest([part]), _fileCache: cache });
    expect(mocks.filesUpload).toHaveBeenCalledTimes(1);

    // Both calls used the file_id reference path
    expect(mocks.betaMessagesCreate).toHaveBeenCalledTimes(2);
    const block1 = mocks.betaMessagesCreate.mock.calls[0][0].messages[0].content[0];
    const block2 = mocks.betaMessagesCreate.mock.calls[1][0].messages[0].content[0];
    expect(block1.source).toEqual({ type: "file", file_id: "file_cached_123" });
    expect(block2.source).toEqual({ type: "file", file_id: "file_cached_123" });
  });

  it("Without file cache, repeated calls each upload (regression check)", async () => {
    const provider = new AnthropicProvider("test-key");
    const big = new Uint8Array(21 * 1024 * 1024);
    mocks.filesUpload.mockResolvedValue({ id: "file_x", type: "file" });

    const part: SkrunPart = { kind: "image", media_type: "image/jpeg", bytes: big };
    await provider.call(makeRequest([part]));
    await provider.call(makeRequest([part]));

    expect(mocks.filesUpload).toHaveBeenCalledTimes(2);
  });
});

describe("AnthropicProvider — tool_choice translation (#58)", () => {
  beforeEach(() => {
    mocks.messagesCreate.mockReset();
    mocks.messagesCreate.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function callWithChoice(toolChoice?: LLMCallRequest["toolChoice"], parallelTools?: boolean) {
    const provider = new AnthropicProvider("test-key");
    return provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }]),
      toolChoice,
      parallelTools,
    });
  }

  it("VT-5: omits tool_choice when mode is auto and parallelTools default", async () => {
    await callWithChoice({ mode: "auto" });
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBeUndefined();
  });

  it("omits tool_choice entirely when toolChoice is undefined", async () => {
    await callWithChoice(undefined);
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBeUndefined();
  });

  it("VT-6: maps mode 'required' to tool_choice {type:'any'}", async () => {
    await callWithChoice({ mode: "required" });
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: "any" });
  });

  it("VT-12: maps mode 'none' to tool_choice {type:'none'}", async () => {
    await callWithChoice({ mode: "none" });
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: "none" });
  });

  it("VT-9: maps mode 'specific' to tool_choice {type:'tool', name}", async () => {
    await callWithChoice({ mode: "specific", tool: "write_artifact" });
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: "tool", name: "write_artifact" });
  });

  it("VT-19: maps mode 'subset' to soft fallback {type:'any'} (no native subset)", async () => {
    await callWithChoice({ mode: "subset", tools: ["foo", "bar"] });
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: "any" });
  });

  it("VT-23: parallel_tools:false adds disable_parallel_tool_use to tool_choice", async () => {
    await callWithChoice({ mode: "required" }, false);
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
  });

  it("VT-23: parallel_tools:false on auto mode emits {type:'auto', disable_parallel_tool_use:true}", async () => {
    await callWithChoice({ mode: "auto" }, false);
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("VT-23: parallel_tools:false on specific mode adds disable flag to specific tool", async () => {
    await callWithChoice({ mode: "specific", tool: "foo" }, false);
    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({
      type: "tool",
      name: "foo",
      disable_parallel_tool_use: true,
    });
  });
});

describe("AnthropicProvider — cache_control injection (#68)", () => {
  beforeEach(() => {
    mocks.messagesCreate.mockReset();
    mocks.messagesCreate.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper: construct a tool with N chars of payload to control its token estimate.
  // Heuristic is JSON.stringify(prefix).length / 4, so chars * 0.25 ≈ token count.
  function bigTool(name: string, payloadChars: number) {
    const big = "x".repeat(payloadChars);
    return {
      name,
      description: `Tool ${name}`,
      parameters: {
        type: "object",
        properties: { payload: { type: "string", description: big } },
      },
    };
  }

  // Sonnet 4.6 has threshold 2048 → need > 8192 chars of JSON.stringify output
  // for prefix to exceed threshold.
  const SONNET_46 = "claude-sonnet-4-6";

  // Above-threshold system prompt (~12_000 chars JSON-stringified → ~3000 tokens > 2048)
  const BIG_SYSTEM = "Detailed system instructions: ".concat("y".repeat(12_000));

  // Above-threshold tool (single tool, ~10_000 chars JSON-stringified → ~2500 tokens > 2048)
  const BIG_TOOL_A = bigTool("read_file", 10_000);

  // Below-threshold tool (~200 chars → ~50 tokens)
  const SMALL_TOOL = bigTool("ping", 50);

  // Below-threshold system (~50 chars → ~12 tokens)
  const SMALL_SYSTEM = "Be helpful.";

  it("VT-3a: both prefixes above threshold → cache_control injected on last tool AND on system", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: SONNET_46,
      systemPrompt: BIG_SYSTEM,
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
      tools: [bigTool("a", 6_000), BIG_TOOL_A], // last tool is BIG_TOOL_A
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    // System must be converted to array form with cache_control on it.
    expect(Array.isArray(sent.system)).toBe(true);
    expect(sent.system).toEqual([
      {
        type: "text",
        text: BIG_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ]);
    // Last tool has cache_control.
    expect(sent.tools).toHaveLength(2);
    expect(sent.tools[0].cache_control).toBeUndefined();
    expect(sent.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("VT-3b: both prefixes below threshold → NO cache_control injected anywhere", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: SONNET_46,
      systemPrompt: SMALL_SYSTEM,
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
      tools: [SMALL_TOOL],
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    // System stays as plain string (not converted to array).
    expect(sent.system).toBe(SMALL_SYSTEM);
    // No tool has cache_control. Confirms peer-review B2 fix: paying 1.25×
    // write surcharge below threshold has zero hit potential — strictly worse
    // than no injection.
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0].cache_control).toBeUndefined();
  });

  it("VT-3c: system above threshold + tools below → cache_control on system only", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: SONNET_46,
      systemPrompt: BIG_SYSTEM,
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
      tools: [SMALL_TOOL],
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    // System converted to array with cache_control.
    expect(Array.isArray(sent.system)).toBe(true);
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    // Tool below threshold — no cache_control.
    expect(sent.tools[0].cache_control).toBeUndefined();
  });

  it("VT-3d: empty system + tools above threshold → cache_control on last tool only, system stays empty", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: SONNET_46,
      systemPrompt: "",
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
      tools: [bigTool("a", 5_000), BIG_TOOL_A],
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    // Empty system stays empty string (no conversion needed; no error thrown).
    expect(sent.system).toBe("");
    // Last tool has cache_control.
    expect(sent.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(sent.tools[0].cache_control).toBeUndefined();
  });

  it("VT-3: respects per-model threshold (Opus 4.7 = 4096; same big system below threshold)", async () => {
    // BIG_SYSTEM is ~12_000 chars / 4 ≈ 3000 tokens. Above Sonnet 4.6 (2048)
    // but BELOW Opus 4.7 (4096) — same input, different model = different
    // injection decision. Locks in the per-model threshold lookup.
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: "claude-opus-4-7",
      systemPrompt: BIG_SYSTEM,
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
      tools: [SMALL_TOOL],
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    // BIG_SYSTEM is ~3000 tokens, threshold 4096 → no injection.
    expect(sent.system).toBe(BIG_SYSTEM);
    expect(sent.tools[0].cache_control).toBeUndefined();
  });

  it("VT-3: snapshot ID resolves to base via prefix-match (claude-opus-4-7-20260416)", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: "claude-opus-4-7-20260416",
      systemPrompt: BIG_SYSTEM,
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    // Snapshot resolves to claude-opus-4-7 (threshold 4096) — same outcome as
    // the parent test: ~3000 tokens < 4096 → no injection.
    expect(sent.system).toBe(BIG_SYSTEM);
  });

  it("VT-3: undefined tools array → no error, no injection on tools", async () => {
    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: SONNET_46,
      systemPrompt: BIG_SYSTEM,
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
      // tools intentionally undefined
    });

    const sent = mocks.messagesCreate.mock.calls[0][0];
    expect(sent.tools).toBeUndefined();
    // System still gets cache_control because it's above threshold.
    expect(Array.isArray(sent.system)).toBe(true);
  });
});

describe("AnthropicProvider — cache usage extraction (#68)", () => {
  beforeEach(() => {
    mocks.messagesCreate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // VT-4: Anthropic returns cache_read_input_tokens + cache_creation_input_tokens
  // → adapter maps to cacheReadTokens + cacheWriteTokens uniformly. input_tokens
  // is already post-breakpoint residual (Anthropic's native shape is non-
  // overlapping) → maps directly to promptTokens with no subtraction needed.
  it("VT-4: extracts cache_read + cache_creation into uniform Usage shape", async () => {
    mocks.messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 4_000,
      },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "system",
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });

    expect(response.usage).toEqual({
      promptTokens: 500,
      completionTokens: 200,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 4_000,
    });
  });

  // Cache fields are OMITTED (not 0, not undefined-set) when no cache activity
  // happened. Lets consumer code distinguish "no cache" from "0 hit" cleanly.
  it("VT-4: omits cache fields when Anthropic returns 0 / undefined", async () => {
    mocks.messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        // No cache_read / cache_creation fields (typical pre-cache_control call).
      },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "small",
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });

    expect(response.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(response.usage.cacheReadTokens).toBeUndefined();
    expect(response.usage.cacheWriteTokens).toBeUndefined();
  });

  // Anthropic explicitly returning 0 for cache fields (no hit, no write) is
  // treated identically to undefined — we omit them.
  it("VT-4: explicit 0 cache fields are omitted from Usage shape", async () => {
    mocks.messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "small",
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });

    expect(response.usage.cacheReadTokens).toBeUndefined();
    expect(response.usage.cacheWriteTokens).toBeUndefined();
  });

  // Mixed: only read, no write (e.g. 2nd call where cache hit but no new
  // content was added → cache_creation = 0).
  it("VT-4: handles cache_read > 0 and cache_creation = 0 (read-only iteration)", async () => {
    mocks.messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 50,
        output_tokens: 200,
        cache_read_input_tokens: 8_000,
        cache_creation_input_tokens: 0,
      },
    });
    const provider = new AnthropicProvider("test-key");
    const response = await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "system",
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });

    expect(response.usage.cacheReadTokens).toBe(8_000);
    expect(response.usage.cacheWriteTokens).toBeUndefined();
  });

  // VT-14 (#68 invalidation regression): when system content changes between
  // calls, Anthropic invalidates the cache and reports cache_read = 0 on the
  // 2nd call (despite the same `cache_control` being set). Confirms the
  // adapter correctly surfaces "no hit" rather than reusing stale state.
  it("VT-14: invalidation — system change → cacheReadTokens=0 on 2nd call (omitted)", async () => {
    const provider = new AnthropicProvider("test-key");

    // Call 1: cache miss + write (would happen on first invocation with a new prefix).
    mocks.messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "first" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5_000,
      },
    });
    const r1 = await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "X".repeat(12_000),
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });
    expect(r1.usage.cacheReadTokens).toBeUndefined();
    expect(r1.usage.cacheWriteTokens).toBe(5_000);

    // Call 2: system content changed → Anthropic invalidates → cache_read_input_tokens
    // is 0 again. Despite the adapter setting cache_control, no cache hit.
    mocks.messagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "second" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5_000, // re-wrote with the new content
      },
    });
    const r2 = await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "Y".repeat(12_000), // CHANGED from X to Y
      userContent: [{ kind: "text", text: "hi" }],
      userMessage: "hi",
    });
    // Confirms our adapter doesn't fake a cache hit when Anthropic reports 0.
    expect(r2.usage.cacheReadTokens).toBeUndefined();
    expect(r2.usage.cacheWriteTokens).toBe(5_000);
  });
});
