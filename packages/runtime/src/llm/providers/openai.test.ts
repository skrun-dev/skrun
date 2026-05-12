import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCost } from "../cost.js";
import { LLMCapabilityError } from "../errors.js";
import type { SkrunPart } from "../parts.js";
import type { LLMCallRequest } from "./types.js";

const mocks = vi.hoisted(() => ({
  chatCompletionsCreate: vi.fn(),
  filesCreate: vi.fn(),
}));

vi.mock("openai", () => ({
  // vitest 4: arrow functions in mockImplementation can't be called with `new`.
  // Use a regular function so `new OpenAI(...)` works as a constructor mock.
  default: vi.fn().mockImplementation(function MockOpenAI(this: Record<string, unknown>) {
    this.chat = { completions: { create: mocks.chatCompletionsCreate } };
    this.files = { create: mocks.filesCreate };
  }),
  toFile: vi.fn(async (_bytes: unknown, name: string, opts?: { type?: string }) => ({
    name,
    type: opts?.type,
  })),
}));

const { OpenAICompatibleProvider, createGrokProvider, createGroqProvider, createMistralProvider } =
  await import("./openai.js");

const FAKE_RESPONSE = {
  choices: [{ message: { content: "ok", tool_calls: undefined } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function makeRequest(userContent: SkrunPart[], model = "gpt-4o-mini"): LLMCallRequest {
  return {
    model,
    systemPrompt: "system",
    userContent,
    userMessage: "",
  };
}

describe("OpenAICompatibleProvider — multimodal translation", () => {
  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
    mocks.filesCreate.mockReset();
    mocks.chatCompletionsCreate.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("VT-21: openai provider translates an image to image_url with data URI", async () => {
    const provider = new OpenAICompatibleProvider("openai", "test-key");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await provider.call(makeRequest([{ kind: "image", media_type: "image/png", bytes }]));

    expect(mocks.chatCompletionsCreate).toHaveBeenCalledOnce();
    expect(mocks.filesCreate).not.toHaveBeenCalled();

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toEqual([
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
        },
      },
    ]);
  });

  it("translates a document SkrunPart to a file content part with file_data inline", async () => {
    const provider = new OpenAICompatibleProvider("openai", "test-key");
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await provider.call(
      makeRequest([
        { kind: "document", media_type: "application/pdf", bytes, filename: "doc.pdf" },
      ]),
    );

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toEqual([
      {
        type: "file",
        file: {
          filename: "doc.pdf",
          file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
        },
      },
    ]);
  });

  it("translates audio to input_audio block (gpt-4o-audio-preview)", async () => {
    const provider = new OpenAICompatibleProvider("openai", "test-key");
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    await provider.call(
      makeRequest([{ kind: "audio", media_type: "audio/wav", bytes }], "gpt-4o-audio-preview"),
    );

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toEqual([
      {
        type: "input_audio",
        input_audio: { data: Buffer.from(bytes).toString("base64"), format: "wav" },
      },
    ]);
  });

  it("VT-23: Mistral provider rejects audio with LLMCapabilityError", async () => {
    const provider = new OpenAICompatibleProvider(
      "mistral",
      "test-key",
      "https://api.mistral.ai/v1",
    );
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    await expect(
      provider.call(makeRequest([{ kind: "audio", media_type: "audio/wav", bytes }])),
    ).rejects.toBeInstanceOf(LLMCapabilityError);
    expect(mocks.chatCompletionsCreate).not.toHaveBeenCalled();
  });

  it("Mistral provider rejects document with LLMCapabilityError", async () => {
    const provider = new OpenAICompatibleProvider(
      "mistral",
      "test-key",
      "https://api.mistral.ai/v1",
    );
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await expect(
      provider.call(makeRequest([{ kind: "document", media_type: "application/pdf", bytes }])),
    ).rejects.toBeInstanceOf(LLMCapabilityError);
  });

  it("Mistral provider accepts image (only supported media)", async () => {
    const provider = new OpenAICompatibleProvider(
      "mistral",
      "test-key",
      "https://api.mistral.ai/v1",
    );
    const bytes = new Uint8Array([1, 2, 3]);
    await provider.call(
      makeRequest([{ kind: "image", media_type: "image/jpeg", bytes }], "pixtral-large-latest"),
    );
    expect(mocks.chatCompletionsCreate).toHaveBeenCalledOnce();
  });

  it("Groq provider rejects audio with LLMCapabilityError", async () => {
    const provider = new OpenAICompatibleProvider(
      "groq",
      "test-key",
      "https://api.groq.com/openai/v1",
    );
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    await expect(
      provider.call(makeRequest([{ kind: "audio", media_type: "audio/wav", bytes }])),
    ).rejects.toBeInstanceOf(LLMCapabilityError);
  });

  it(">20MB document on openai triggers Files API pre-upload + file_id ref", async () => {
    const provider = new OpenAICompatibleProvider("openai", "test-key");
    const big = new Uint8Array(21 * 1024 * 1024);
    mocks.filesCreate.mockResolvedValue({ id: "file-uploaded-xyz" });

    await provider.call(
      makeRequest([{ kind: "document", media_type: "application/pdf", bytes: big }]),
    );

    expect(mocks.filesCreate).toHaveBeenCalledOnce();
    const uploadArgs = mocks.filesCreate.mock.calls[0][0];
    expect(uploadArgs.purpose).toBe("user_data");

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toEqual([
      {
        type: "file",
        file: { file_id: "file-uploaded-xyz" },
      },
    ]);
  });

  it("preserves text + image ordering", async () => {
    const provider = new OpenAICompatibleProvider("openai", "test-key");
    const bytes = new Uint8Array([1, 2, 3]);
    await provider.call(
      makeRequest([
        { kind: "text", text: "What's this?" },
        { kind: "image", media_type: "image/png", bytes },
      ]),
    );

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "What's this?" });
    expect(userMsg.content[1].type).toBe("image_url");
  });
});

describe("OpenAICompatibleProvider — tool_choice translation (#58)", () => {
  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
    mocks.chatCompletionsCreate.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function callWithChoice(
    toolChoice?: LLMCallRequest["toolChoice"],
    parallelTools?: boolean,
    providerName = "openai",
  ) {
    const provider = new OpenAICompatibleProvider(providerName, "test-key");
    return provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }]),
      toolChoice,
      parallelTools,
    });
  }

  it("omits tool_choice when toolChoice is undefined", async () => {
    await callWithChoice(undefined);
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.parallel_tool_calls).toBeUndefined();
  });

  it("VT-5: omits tool_choice when mode is auto", async () => {
    await callWithChoice({ mode: "auto" });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBeUndefined();
  });

  it("VT-12: maps mode 'none' to tool_choice 'none'", async () => {
    await callWithChoice({ mode: "none" });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBe("none");
  });

  it("VT-8: maps mode 'required' to tool_choice 'required'", async () => {
    await callWithChoice({ mode: "required" });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBe("required");
  });

  it("VT-11: maps mode 'specific' to {type:'function', function:{name}}", async () => {
    await callWithChoice({ mode: "specific", tool: "write_artifact" });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({
      type: "function",
      function: { name: "write_artifact" },
    });
  });

  it("VT-20: maps mode 'subset' to soft fallback 'required' (no native subset)", async () => {
    await callWithChoice({ mode: "subset", tools: ["foo", "bar"] });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBe("required");
  });

  it("VT-25: parallel_tools:false adds parallel_tool_calls:false", async () => {
    await callWithChoice({ mode: "required" }, false);
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBe("required");
    expect(sent.parallel_tool_calls).toBe(false);
  });

  it("parallel_tools:true (default) does NOT set parallel_tool_calls explicitly", async () => {
    await callWithChoice({ mode: "required" }, true);
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.parallel_tool_calls).toBeUndefined();
  });
});

describe("createGrokProvider — xAI provider factory (#58)", () => {
  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
    mocks.chatCompletionsCreate.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates an OpenAICompatibleProvider with name 'xai'", () => {
    const provider = createGrokProvider("xai-test-key");
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe("xai");
  });

  it("VT-26: parallel_tools:false on xAI sets parallel_tool_calls:false (OpenAI compat)", async () => {
    const provider = createGrokProvider("xai-test-key");
    await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }]),
      toolChoice: { mode: "required" },
      parallelTools: false,
    });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toBe("required");
    expect(sent.parallel_tool_calls).toBe(false);
  });

  it("VT-31: tool-choice on xAI maps identically to OpenAI for specific tool", async () => {
    const provider = createGrokProvider("xai-test-key");
    await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }]),
      toolChoice: { mode: "specific", tool: "write_artifact" },
    });
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({
      type: "function",
      function: { name: "write_artifact" },
    });
  });

  it("VT-30: cost computation for grok-4.3 uses $1.25 input / $2.50 output per 1M tokens", () => {
    // 1M input + 1M output → $1.25 + $2.50 = $3.75
    const cost = estimateCost("grok-4.3", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(3.75, 5);

    // 100K input only → $0.125
    const cost2 = estimateCost("grok-4.3", 100_000, 0);
    expect(cost2).toBeCloseTo(0.125, 5);
  });

  it("xai rejects audio in isMediaSupported guard (capability matrix)", async () => {
    const provider = createGrokProvider("xai-test-key");
    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    await expect(
      provider.call(
        makeRequest([{ kind: "audio", media_type: "audio/wav", bytes: audioBytes }], "grok-4.3"),
      ),
    ).rejects.toThrow(LLMCapabilityError);
  });

  it("xai rejects document in isMediaSupported guard (capability matrix)", async () => {
    const provider = createGrokProvider("xai-test-key");
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await expect(
      provider.call(
        makeRequest(
          [{ kind: "document", media_type: "application/pdf", bytes: pdfBytes }],
          "grok-4.3",
        ),
      ),
    ).rejects.toThrow(LLMCapabilityError);
  });

  it("xai accepts image in isMediaSupported guard (capability: image=true)", async () => {
    const provider = createGrokProvider("xai-test-key");
    const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(
      provider.call(
        makeRequest([{ kind: "image", media_type: "image/png", bytes: imgBytes }], "grok-4.3"),
      ),
    ).resolves.toBeDefined();
    expect(mocks.chatCompletionsCreate).toHaveBeenCalledOnce();
  });
});

describe("OpenAICompatibleProvider — prompt caching (#68)", () => {
  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // VT-5a: OpenAI factory variant — passes prompt_cache_key body field +
  // extracts cached_tokens from Chat Completions usage shape + applies
  // gross→net normalization on promptTokens.
  it("VT-5a: OpenAI Chat Completions — passes prompt_cache_key + extracts cached_tokens + gross→net", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok", tool_calls: undefined } }],
      usage: {
        prompt_tokens: 10_000, // GROSS — includes cached
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 2048 },
      },
    });
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("test-key");
    const response = await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }], "gpt-5.5"),
      cacheKey: "abc-hashed-key-fake-hex",
    });

    // Body has prompt_cache_key set to whatever the router gave us.
    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.prompt_cache_key).toBe("abc-hashed-key-fake-hex");

    // Usage normalized: promptTokens = 10000 - 2048 = 7952 (residual full-rate).
    expect(response.usage).toEqual({
      promptTokens: 7952,
      completionTokens: 200,
      cacheReadTokens: 2048,
    });
    expect(response.usage.cacheWriteTokens).toBeUndefined();
  });

  // VT-5b: Responses API shape — `input_tokens_details.cached_tokens` instead
  // of `prompt_tokens_details`. Adapter falls back to this path when the
  // first one is undefined. Forward-compat for when the runtime adds Responses.
  it("VT-5b: Responses API shape — adapter extracts via input_tokens_details fallback path", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok", tool_calls: undefined } }],
      usage: {
        prompt_tokens: 8000,
        completion_tokens: 150,
        // No prompt_tokens_details (the Chat shape)
        // Responses-shape field present instead
        input_tokens_details: { cached_tokens: 4096 },
      },
    });
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("test-key");
    const response = await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }], "gpt-5.5"),
      cacheKey: "k",
    });

    expect(response.usage).toEqual({
      promptTokens: 3904, // 8000 - 4096
      completionTokens: 150,
      cacheReadTokens: 4096,
    });
  });

  // VT-5d: special chars in cacheKey input. The router pre-hashes via
  // hashCacheKey() in Phase 4.1 — by the time the adapter sees it, it's
  // already a hex digest. This test confirms the adapter passes the cacheKey
  // verbatim (no further transformation), and that a hex value is safe in
  // the body field.
  it("VT-5d: cacheKey is passed verbatim as prompt_cache_key body field", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const hexKey = "a5c5838c616f8b19a96730d15b97c46fb962d29834f4f09306099aaa120f974c";
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("test-key");
    await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }], "gpt-5.5"),
      cacheKey: hexKey,
    });

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.prompt_cache_key).toBe(hexKey);
    // No / @ + . - chars in body field — alphanumeric-only.
    expect(sent.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
  });

  // No cacheKey from router → no prompt_cache_key in request body. Adapter
  // doesn't fabricate a key.
  it("OpenAI: no cacheKey provided → no prompt_cache_key in request body", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("test-key");
    await provider.call(makeRequest([{ kind: "text", text: "hi" }], "gpt-5.5"));

    const sent = mocks.chatCompletionsCreate.mock.calls[0][0];
    expect(sent.prompt_cache_key).toBeUndefined();
  });

  // No cache_tokens in response → no cacheReadTokens in returned Usage.
  it("OpenAI: no cached_tokens in response → cacheReadTokens omitted, promptTokens=gross", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50 },
    });
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("test-key");
    const response = await provider.call(makeRequest([{ kind: "text", text: "hi" }], "gpt-5.5"));

    expect(response.usage).toEqual({ promptTokens: 1000, completionTokens: 50 });
    expect(response.usage.cacheReadTokens).toBeUndefined();
  });

  // VT-7: xAI Grok factory variant — sets x-grok-conv-id HTTP header on
  // Chat Completions (NOT body field). Same extraction shape as OpenAI.
  // Per docs.x.ai: prompt_cache_key body is for Responses API only; we use
  // Chat Completions, so the header is the right transport.
  it("VT-7: xAI Grok Chat Completions sets x-grok-conv-id HEADER + extracts cached_tokens", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 5000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    });
    const provider = createGrokProvider("test-key");
    const response = await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }], "grok-4.3"),
      cacheKey: "abc-hashed-key-fake-hex",
    });

    // 2nd argument to chat.completions.create is the request options
    // (where headers go).
    const callArgs = mocks.chatCompletionsCreate.mock.calls[0];
    const requestBody = callArgs[0];
    const requestOptions = callArgs[1];

    // Header set (Grok-specific transport).
    expect(requestOptions?.headers).toEqual({
      "x-grok-conv-id": "abc-hashed-key-fake-hex",
    });
    // Body field NOT set (Grok uses header, not body, on Chat Completions).
    expect(requestBody.prompt_cache_key).toBeUndefined();

    // Extraction works (mirrors OpenAI shape).
    expect(response.usage).toEqual({
      promptTokens: 3976, // 5000 - 1024
      completionTokens: 200,
      cacheReadTokens: 1024,
    });
  });

  // VT-7: no cacheKey from router → no header set (Grok adapter doesn't
  // fabricate one).
  it("VT-7: xAI Grok no cacheKey → no x-grok-conv-id header", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const provider = createGrokProvider("test-key");
    await provider.call(makeRequest([{ kind: "text", text: "hi" }], "grok-4.3"));

    const callArgs = mocks.chatCompletionsCreate.mock.calls[0];
    const requestOptions = callArgs[1];
    // Either no headers at all, or no x-grok-conv-id header — both acceptable.
    expect(requestOptions?.headers?.["x-grok-conv-id"]).toBeUndefined();
  });

  // Explicit 0 cached_tokens (no hit) is treated like undefined — omitted.
  it("OpenAI: cached_tokens=0 → cacheReadTokens omitted (consistent with undefined)", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    const { createOpenAIProvider } = await import("./openai.js");
    const provider = createOpenAIProvider("test-key");
    const response = await provider.call(makeRequest([{ kind: "text", text: "hi" }], "gpt-5.5"));

    expect(response.usage.cacheReadTokens).toBeUndefined();
  });

  // VT-8: Groq factory variant — implicit only (no body field, no header).
  // Extracts cached_tokens from response since the openai/gpt-oss-* family
  // returns it implicitly. Other Groq models return undefined → no cache.
  it("VT-8: Groq extracts cached_tokens (implicit only, no request-side primitive)", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 3000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    });
    const provider = createGroqProvider("test-key");
    const response = await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }], "openai/gpt-oss-120b"),
      cacheKey: "would-be-passed-but-shouldnt",
    });

    // No body field, no header — Groq is implicit on stable prefix only.
    const callArgs = mocks.chatCompletionsCreate.mock.calls[0];
    expect(callArgs[0].prompt_cache_key).toBeUndefined();
    expect(callArgs[1]?.headers?.["x-grok-conv-id"]).toBeUndefined();

    // Extraction works the same as OpenAI / xAI Chat Completions shape.
    expect(response.usage).toEqual({
      promptTokens: 1976, // 3000 - 1024
      completionTokens: 100,
      cacheReadTokens: 1024,
    });
  });

  // VT-8: Groq Llama / Qwen models return no cached_tokens → no field surfaced.
  it("VT-8: Groq Llama (no caching support) returns no cacheReadTokens", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50 }, // no prompt_tokens_details
    });
    const provider = createGroqProvider("test-key");
    const response = await provider.call(
      makeRequest([{ kind: "text", text: "hi" }], "llama-3.3-70b-versatile"),
    );

    expect(response.usage.cacheReadTokens).toBeUndefined();
    expect(response.usage.promptTokens).toBe(1000); // gross = residual
  });

  // VT-9: Mistral factory variant — skipCaching=true. NO cache primitives
  // sent (no prompt_cache_key body, no x-grok-conv-id header) and NO cache
  // fields extracted (cacheReadTokens undefined even if response somehow
  // has them — defensive). Also emits a structured `cache_skipped` log;
  // visible in test output but not asserted programmatically (peer-review
  // N2: assertion on the log message string is brittle, the BEHAVIOR is
  // the test).
  it("VT-9: Mistral no-op — no cache primitives sent, no extraction", async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      // Response shouldn't have cache fields for Mistral, but if it ever does
      // (Mistral could add caching later without us bumping the flag), the
      // skipCaching path defensively ignores them.
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 500 }, // shouldn't affect output
      },
    });
    const provider = createMistralProvider("test-key");
    const response = await provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }], "mistral-large-3"),
      cacheKey: "should-be-ignored",
    });

    // No cache primitives passed.
    const callArgs = mocks.chatCompletionsCreate.mock.calls[0];
    expect(callArgs[0].prompt_cache_key).toBeUndefined();
    expect(callArgs[1]?.headers?.["x-grok-conv-id"]).toBeUndefined();

    // Cache fields NOT extracted — even when response has them, skipCaching
    // overrides extractCachedTokens. promptTokens stays GROSS (no subtraction).
    expect(response.usage).toEqual({
      promptTokens: 1000, // not normalized — Mistral has no caching, so no subtraction
      completionTokens: 50,
    });
    expect(response.usage.cacheReadTokens).toBeUndefined();
    expect(response.usage.cacheWriteTokens).toBeUndefined();
  });
});
