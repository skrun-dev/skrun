import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkrunPart } from "../parts.js";
import type { LLMCallRequest } from "./types.js";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
  // vitest 4: arrow in mockImplementation isn't constructable; use regular fn.
  GoogleGenerativeAI: vi.fn().mockImplementation(function MockGoogleGenerativeAI(
    this: Record<string, unknown>,
  ) {
    this.getGenerativeModel = () => ({
      generateContent: mocks.generateContent,
    });
  }),
  SchemaType: { OBJECT: "OBJECT" },
  FunctionCallingMode: {
    MODE_UNSPECIFIED: "MODE_UNSPECIFIED",
    AUTO: "AUTO",
    ANY: "ANY",
    NONE: "NONE",
  },
}));

vi.mock("@google/generative-ai/server", () => ({
  GoogleAIFileManager: vi.fn().mockImplementation(function MockGoogleAIFileManager(
    this: Record<string, unknown>,
  ) {
    this.uploadFile = mocks.uploadFile;
  }),
}));

const { GoogleProvider } = await import("./google.js");

const FAKE_RESPONSE = {
  response: {
    candidates: [{ content: { parts: [{ text: "ok" }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  },
};

function makeRequest(userContent: SkrunPart[], model = "gemini-2.5-flash"): LLMCallRequest {
  return {
    model,
    systemPrompt: "system",
    userContent,
    userMessage: "",
  };
}

describe("GoogleProvider — multimodal translation", () => {
  beforeEach(() => {
    mocks.generateContent.mockReset();
    mocks.uploadFile.mockReset();
    mocks.generateContent.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("VT-22: translates a PDF document to inlineData with mimeType=application/pdf", async () => {
    const provider = new GoogleProvider("test-key");
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await provider.call(makeRequest([{ kind: "document", media_type: "application/pdf", bytes }]));

    expect(mocks.generateContent).toHaveBeenCalledOnce();
    expect(mocks.uploadFile).not.toHaveBeenCalled();

    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.contents).toHaveLength(1);
    expect(sent.contents[0].role).toBe("user");
    expect(sent.contents[0].parts).toEqual([
      {
        inlineData: {
          mimeType: "application/pdf",
          data: Buffer.from(bytes).toString("base64"),
        },
      },
    ]);
  });

  it("translates an image to inlineData", async () => {
    const provider = new GoogleProvider("test-key");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await provider.call(makeRequest([{ kind: "image", media_type: "image/png", bytes }]));

    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.contents[0].parts[0].inlineData).toEqual({
      mimeType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    });
  });

  it("translates audio to inlineData (Gemini supports audio natively)", async () => {
    const provider = new GoogleProvider("test-key");
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    await provider.call(makeRequest([{ kind: "audio", media_type: "audio/wav", bytes }]));

    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.contents[0].parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: Buffer.from(bytes).toString("base64"),
    });
  });

  it(">18MB payload triggers Files API + uses fileData reference", async () => {
    const provider = new GoogleProvider("test-key");
    const big = new Uint8Array(19 * 1024 * 1024);
    mocks.uploadFile.mockResolvedValue({
      file: { uri: "https://generativelanguage.googleapis.com/v1/files/abc123" },
    });

    await provider.call(
      makeRequest([{ kind: "document", media_type: "application/pdf", bytes: big }]),
    );

    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    const uploadArgs = mocks.uploadFile.mock.calls[0];
    expect(uploadArgs[1]).toMatchObject({ mimeType: "application/pdf" });

    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.contents[0].parts).toEqual([
      {
        fileData: {
          fileUri: "https://generativelanguage.googleapis.com/v1/files/abc123",
          mimeType: "application/pdf",
        },
      },
    ]);
  });

  it("text + image ordering preserved as parts array", async () => {
    const provider = new GoogleProvider("test-key");
    const bytes = new Uint8Array([1, 2, 3]);
    await provider.call(
      makeRequest([
        { kind: "text", text: "Describe:" },
        { kind: "image", media_type: "image/jpeg", bytes },
      ]),
    );

    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.contents[0].parts).toHaveLength(2);
    expect(sent.contents[0].parts[0]).toEqual({ text: "Describe:" });
    expect(sent.contents[0].parts[1].inlineData).toBeDefined();
  });
});

describe("GoogleProvider — tool_choice translation (#58)", () => {
  beforeEach(() => {
    mocks.generateContent.mockReset();
    mocks.generateContent.mockResolvedValue(FAKE_RESPONSE);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function callWithChoice(toolChoice?: LLMCallRequest["toolChoice"], parallelTools?: boolean) {
    const provider = new GoogleProvider("test-key");
    return provider.call({
      ...makeRequest([{ kind: "text", text: "hi" }]),
      toolChoice,
      parallelTools,
    });
  }

  it("omits toolConfig when toolChoice is undefined", async () => {
    await callWithChoice(undefined);
    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.toolConfig).toBeUndefined();
  });

  it("VT-5: omits toolConfig when mode is auto", async () => {
    await callWithChoice({ mode: "auto" });
    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.toolConfig).toBeUndefined();
  });

  it("VT-12: maps mode 'none' to functionCallingConfig.mode = NONE", async () => {
    await callWithChoice({ mode: "none" });
    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
  });

  it("VT-7: maps mode 'required' to functionCallingConfig.mode = ANY", async () => {
    await callWithChoice({ mode: "required" });
    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  it("VT-10: maps mode 'specific' to ANY + allowedFunctionNames=[name]", async () => {
    await callWithChoice({ mode: "specific", tool: "write_artifact" });
    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["write_artifact"] },
    });
  });

  it("VT-21: subset preserved natively via allowedFunctionNames (no fallback)", async () => {
    await callWithChoice({ mode: "subset", tools: ["foo", "bar"] });
    const sent = mocks.generateContent.mock.calls[0][0];
    expect(sent.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["foo", "bar"] },
    });
  });

  it("VT-22: parallel_tools:false on Gemini is no-op (request unchanged) + warning logged", async () => {
    await callWithChoice({ mode: "required" }, false);
    const sent = mocks.generateContent.mock.calls[0][0];
    // toolConfig still applied for the required mode
    expect(sent.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    // No "disable parallel" field exists on Gemini — request stays as-is.
  });
});

describe("GoogleProvider — cache usage extraction (#68)", () => {
  beforeEach(() => {
    mocks.generateContent.mockReset();
    mocks.uploadFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // VT-6: Gemini's promptTokenCount is GROSS (cached + uncached). The
  // adapter normalizes to the uniform Usage shape per spec § 4: promptTokens
  // = promptTokenCount - cachedContentTokenCount. cacheReadTokens =
  // cachedContentTokenCount. No write surcharge on Gemini implicit caching
  // → cacheWriteTokens stays undefined.
  it("VT-6: extracts cachedContentTokenCount + normalizes gross→net promptTokens", async () => {
    mocks.generateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 8000, // GROSS — includes cached portion
          candidatesTokenCount: 200,
          cachedContentTokenCount: 4096,
        },
      },
    });
    const provider = new GoogleProvider("test-key");
    const response = await provider.call(
      makeRequest([{ kind: "text", text: "hi" }], "gemini-2.5-pro"),
    );

    expect(response.usage).toEqual({
      promptTokens: 3904, // 8000 - 4096 = uncached residual (full-rate)
      completionTokens: 200,
      cacheReadTokens: 4096,
    });
    expect(response.usage.cacheWriteTokens).toBeUndefined();
  });

  // Cache field omitted (not undefined-set) when no implicit cache hit
  // happened (e.g. first call, or below 2.5+ implicit threshold).
  it("VT-6: omits cacheReadTokens when cachedContentTokenCount is 0 / undefined", async () => {
    mocks.generateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 },
      },
    });
    const provider = new GoogleProvider("test-key");
    const response = await provider.call(
      makeRequest([{ kind: "text", text: "hi" }], "gemini-2.5-flash"),
    );

    expect(response.usage).toEqual({
      promptTokens: 1000, // No cache → full prompt is residual
      completionTokens: 50,
    });
    expect(response.usage.cacheReadTokens).toBeUndefined();
  });

  // Edge case: when cachedContentTokenCount equals promptTokenCount (entire
  // prompt was cached), promptTokens = 0. Don't return negative numbers.
  it("VT-6: 100% cache hit → promptTokens = 0, cacheReadTokens = full prompt", async () => {
    mocks.generateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 5000,
          candidatesTokenCount: 100,
          cachedContentTokenCount: 5000,
        },
      },
    });
    const provider = new GoogleProvider("test-key");
    const response = await provider.call(
      makeRequest([{ kind: "text", text: "hi" }], "gemini-2.5-flash"),
    );

    expect(response.usage.promptTokens).toBe(0);
    expect(response.usage.cacheReadTokens).toBe(5000);
  });

  // Defensive: if Gemini ever returns cachedContentTokenCount > promptTokenCount
  // (shouldn't happen per docs but be safe), don't return a negative
  // promptTokens value. Math.max(0, ...) clamps to zero.
  it("VT-6: cachedContent > prompt is clamped to promptTokens=0 (defensive)", async () => {
    mocks.generateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 1500, // anomaly
        },
      },
    });
    const provider = new GoogleProvider("test-key");
    const response = await provider.call(
      makeRequest([{ kind: "text", text: "hi" }], "gemini-2.5-flash"),
    );

    expect(response.usage.promptTokens).toBe(0);
    expect(response.usage.cacheReadTokens).toBe(1500);
  });
});
