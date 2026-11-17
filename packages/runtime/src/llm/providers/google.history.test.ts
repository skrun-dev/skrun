import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLMHistoryError } from "../errors.js";
import type { HistoryEntry, ToolCallRequest, ToolCallResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
  // A regular function, so `new GoogleGenerativeAI(...)` works on the mock.
  GoogleGenerativeAI: vi.fn().mockImplementation(function MockGoogleGenerativeAI(
    this: Record<string, unknown>,
  ) {
    this.getGenerativeModel = () => ({ generateContent: mocks.generateContent });
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

// Imported after vi.mock, so the adapter and the router get the mocked SDK.
const { GoogleProvider } = await import("./google.js");
const { LLMRouter, MAX_TOOL_CALLS_PER_TURN } = await import("../router.js");

const MODEL = { provider: "google" as const, name: "gemini-2.5-flash" };
const INPUT = "Find the first value, then the second.";
const TOOLS = [
  {
    name: "lookup",
    description: "Look a value up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
];

// What the model returns, turn by turn: it says something and calls a tool,
// the call carrying its thought signature; it calls another, signed too; then
// it answers.
const TURN_1 = {
  role: "model",
  parts: [
    { text: "Looking up the first value." },
    {
      functionCall: { name: "lookup", args: { q: "first" } },
      thoughtSignature: "signature-of-turn-one",
    },
  ],
};
const TURN_2 = {
  role: "model",
  parts: [
    {
      functionCall: { name: "lookup", args: { q: "second" } },
      thoughtSignature: "signature-of-turn-two",
    },
  ],
};
const TURN_3 = { role: "model", parts: [{ text: "Both values found." }] };

function reply(candidate: Record<string, unknown> | undefined) {
  return {
    response: {
      candidates: candidate === undefined ? undefined : [candidate],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    },
  };
}

interface SentRequest {
  contents: Array<{ role: string; parts: unknown[] }>;
}

describe("Gemini in the router's tool loop — the earlier turns go back as the model returned them", () => {
  let requests: SentRequest[];

  beforeEach(() => {
    mocks.generateContent.mockReset();
    requests = [];
    const replies = [
      reply({ content: TURN_1, finishReason: "STOP" }),
      reply({ content: TURN_2, finishReason: "STOP" }),
      reply({ content: TURN_3, finishReason: "STOP" }),
    ];
    mocks.generateContent.mockImplementation(async (params: SentRequest) => {
      // Cloned when sent: an array the adapter reused from one turn to the next
      // would otherwise show its final state in every capture.
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next)
        throw new Error("the loop called the provider more often than the scenario answers");
      return structuredClone(next);
    });
  });

  it("the third request carries the input, then both model contents exactly as returned, thought signatures included, each followed by its function response", async () => {
    const router = new LLMRouter();
    router.registerProvider("google", new GoogleProvider("test-key"));
    const onToolCall = vi.fn(
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: `value of ${String(call.args.q)}`,
        id: call.id,
      }),
    );

    const result = await router.call(MODEL, "system prompt", INPUT, TOOLS, onToolCall);

    expect(result.content).toBe("Both values found.");
    expect(requests).toHaveLength(3);
    expect(requests[2].contents).toEqual([
      { role: "user", parts: [{ text: INPUT }] },
      TURN_1,
      {
        role: "user",
        parts: [{ functionResponse: { name: "lookup", response: { result: "value of first" } } }],
      },
      TURN_2,
      {
        role: "user",
        parts: [{ functionResponse: { name: "lookup", response: { result: "value of second" } } }],
      },
    ]);
    // Byte for byte, not only deep-equal: the key order is the model's too.
    expect(JSON.stringify(requests[2].contents[1])).toBe(JSON.stringify(TURN_1));
    expect(JSON.stringify(requests[2].contents[3])).toBe(JSON.stringify(TURN_2));
  });

  it("no request of a three-turn loop carries a role Gemini refuses: only user and model, never two contents in a row with the same role", async () => {
    // A content's role is `user` or `model`; Gemini 3 answers 400 to a
    // `function` role, from the first request that carries function responses.
    const router = new LLMRouter();
    router.registerProvider("google", new GoogleProvider("test-key"));
    const onToolCall = vi.fn(
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: `value of ${String(call.args.q)}`,
        id: call.id,
      }),
    );

    await router.call(MODEL, "system prompt", INPUT, TOOLS, onToolCall);

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const roles = request.contents.map((content) => content.role);
      expect(roles).not.toContain("function");
      for (const role of roles) expect(["user", "model"]).toContain(role);
      for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
    }
    expect(requests.map((request) => request.contents.map((content) => content.role))).toEqual([
      ["user"],
      ["user", "model", "user"],
      ["user", "model", "user", "model", "user"],
    ]);
  });
});

describe("Gemini pairs each function response with the id of its call, when Gemini returns one", () => {
  let requests: SentRequest[];

  // Two calls in one turn, as Gemini 3 returns them (each with an id), or as
  // earlier models do (none).
  function twoCalls(ids: [string, string] | undefined) {
    return {
      role: "model",
      parts: [
        {
          functionCall: {
            name: "lookup",
            args: { q: "first" },
            ...(ids && { id: ids[0] }),
          },
          thoughtSignature: "signature-of-the-turn",
        },
        { functionCall: { name: "fetch", args: { q: "second" }, ...(ids && { id: ids[1] }) } },
      ],
    };
  }

  async function runLoop(turn: Record<string, unknown>) {
    mocks.generateContent.mockReset();
    requests = [];
    const replies = [
      reply({ content: turn, finishReason: "STOP" }),
      reply({ content: TURN_3, finishReason: "STOP" }),
    ];
    mocks.generateContent.mockImplementation(async (params: SentRequest) => {
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next)
        throw new Error("the loop called the provider more often than the scenario answers");
      return structuredClone(next);
    });
    const router = new LLMRouter();
    router.registerProvider("google", new GoogleProvider("test-key"));
    const onToolCall = vi.fn(
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: `value of ${String(call.args.q)}`,
        id: call.id,
      }),
    );
    await router.call(MODEL, "system prompt", INPUT, TOOLS, onToolCall);
    return onToolCall;
  }

  it("calls that carry an id: the next request carries each function response with its call's id, in the order of the calls", async () => {
    const onToolCall = await runLoop(twoCalls(["call_first", "call_second"]));

    expect(onToolCall.mock.calls.map(([call]) => call)).toEqual([
      { name: "lookup", args: { q: "first" }, id: "call_first" },
      { name: "fetch", args: { q: "second" }, id: "call_second" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1].contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call_first",
            name: "lookup",
            response: { result: "value of first" },
          },
        },
        {
          functionResponse: {
            id: "call_second",
            name: "fetch",
            response: { result: "value of second" },
          },
        },
      ],
    });
  });

  it("calls without an id: no id is sent, and the responses are paired by position", async () => {
    const onToolCall = await runLoop(twoCalls(undefined));

    for (const [call] of onToolCall.mock.calls) expect(call).not.toHaveProperty("id");
    expect(requests).toHaveLength(2);
    expect(requests[1].contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "lookup", response: { result: "value of first" } } },
        { functionResponse: { name: "fetch", response: { result: "value of second" } } },
      ],
    });
    for (const part of requests[1].contents[2].parts) {
      expect((part as { functionResponse: object }).functionResponse).not.toHaveProperty("id");
    }
  });
});

describe("Gemini renders the conversation it is given", () => {
  let requests: SentRequest[];

  beforeEach(() => {
    mocks.generateContent.mockReset();
    requests = [];
    mocks.generateContent.mockImplementation(async (params: SentRequest) => {
      requests.push(structuredClone(params));
      return reply({ content: TURN_3, finishReason: "STOP" });
    });
  });

  function callWith(history: HistoryEntry[]) {
    return new GoogleProvider("test-key").call({
      model: MODEL.name,
      systemPrompt: "system prompt",
      userContent: [{ kind: "text", text: INPUT }],
      userMessage: INPUT,
      history,
    });
  }

  it("the results of parallel calls go back in one content, in the order of the calls", async () => {
    const parallel = {
      role: "model",
      parts: [
        {
          functionCall: { name: "lookup", args: { q: "first" } },
          thoughtSignature: "signature-of-the-turn",
        },
        { functionCall: { name: "fetch", args: { q: "second" } } },
      ],
    };

    await callWith([
      { kind: "assistant", turn: { provider: "google", content: parallel } },
      {
        kind: "tool_results",
        results: [
          { name: "lookup", result: "value of first" },
          { name: "fetch", result: "value of second" },
        ],
      },
    ]);

    expect(requests[0].contents).toEqual([
      { role: "user", parts: [{ text: INPUT }] },
      parallel,
      {
        role: "user",
        parts: [
          { functionResponse: { name: "lookup", response: { result: "value of first" } } },
          { functionResponse: { name: "fetch", response: { result: "value of second" } } },
        ],
      },
    ]);
  });

  it("a later user message joins the user content of the function responses, after them, and joins a user content before it", async () => {
    await callWith([
      { kind: "assistant", turn: { provider: "google", content: TURN_1 } },
      { kind: "tool_results", results: [{ name: "lookup", result: "value of first" }] },
      { kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] },
    ]);
    await callWith([{ kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] }]);

    expect(requests[0].contents).toEqual([
      { role: "user", parts: [{ text: INPUT }] },
      TURN_1,
      {
        role: "user",
        parts: [
          { functionResponse: { name: "lookup", response: { result: "value of first" } } },
          { text: "Now answer in JSON." },
        ],
      },
    ]);
    expect(requests[1].contents).toEqual([
      { role: "user", parts: [{ text: INPUT }, { text: "Now answer in JSON." }] },
    ]);
  });

  it("a turn another provider produced throws a named error naming both providers, never the turn's content", async () => {
    const foreign = [{ type: "text", text: "witness output of another model" }];

    const call = callWith([
      { kind: "assistant", turn: { provider: "anthropic", content: foreign } },
    ]);

    await expect(call).rejects.toBeInstanceOf(LLMHistoryError);
    await expect(call).rejects.toMatchObject({
      expectedProvider: "google",
      receivedProvider: "anthropic",
    });
    const error = await call.catch((e: unknown) => e as Error);
    expect(error.message).toContain("'anthropic'");
    expect(error.message).toContain("'google'");
    expect(error.message).not.toContain("witness output");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("a response without content returns an empty model turn, and that turn is left out when the conversation goes back: Gemini refuses a content without parts", async () => {
    mocks.generateContent.mockReset();
    mocks.generateContent
      .mockImplementationOnce(async () => reply({ finishReason: "SAFETY" }))
      .mockImplementationOnce(async () => reply(undefined))
      .mockImplementation(async (params: SentRequest) => {
        requests.push(structuredClone(params));
        return reply({ content: TURN_3, finishReason: "STOP" });
      });

    const blocked = await callWith([]);
    const empty = await callWith([]);
    expect(blocked.content).toBe("");
    expect(blocked.toolCalls).toBeUndefined();
    expect(blocked.assistantTurn).toEqual({
      provider: "google",
      content: { role: "model", parts: [] },
    });
    expect(empty.assistantTurn).toEqual({
      provider: "google",
      content: { role: "model", parts: [] },
    });

    await callWith([
      { kind: "assistant", turn: blocked.assistantTurn },
      { kind: "user", parts: [{ kind: "text", text: "Try again." }] },
    ]);
    await callWith([
      { kind: "assistant", turn: { provider: "google", content: TURN_1 } },
      { kind: "tool_results", results: [{ name: "lookup", result: "value of first" }] },
      { kind: "assistant", turn: { provider: "google", content: { role: "model" } } },
    ]);

    expect(requests[0].contents).toEqual([
      { role: "user", parts: [{ text: INPUT }, { text: "Try again." }] },
    ]);
    expect(requests[1].contents).toEqual([
      { role: "user", parts: [{ text: INPUT }] },
      TURN_1,
      {
        role: "user",
        parts: [{ functionResponse: { name: "lookup", response: { result: "value of first" } } }],
      },
    ]);
    for (const request of requests) {
      for (const content of request.contents) expect(content.parts.length).toBeGreaterThan(0);
    }
  });

  it("served as the fallback of another provider whose first answer was refused before any tool ran, it starts from the input alone", async () => {
    // One call more than an answer may ask for: none runs, and the fallback
    // takes over from the primary's first turn.
    const primaryCall = vi.fn().mockResolvedValueOnce({
      content: "",
      toolCalls: Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, (_, i) => ({
        name: "lookup",
        args: { q: "first" },
        id: `call_${i}`,
      })),
      assistantTurn: {
        provider: "openai",
        content: { role: "assistant", content: "witness output of another model" },
      },
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const router = new LLMRouter();
    router.registerProvider("openai", { name: "openai", call: primaryCall });
    router.registerProvider("google", new GoogleProvider("test-key"));
    const onToolCall = vi.fn(
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: "value of first",
        id: call.id,
      }),
    );

    const result = await router.call(
      { provider: "openai", name: "gpt-4o", fallback: MODEL },
      "system prompt",
      INPUT,
      TOOLS,
      onToolCall,
    );

    expect(primaryCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.provider).toBe("google");
    expect(requests).toHaveLength(1);
    expect(requests[0].contents).toEqual([{ role: "user", parts: [{ text: INPUT }] }]);
  });
});
