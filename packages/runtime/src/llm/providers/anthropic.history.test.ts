import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLMHistoryError } from "../errors.js";
import type { ToolCallRequest, ToolCallResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  betaMessagesCreate: vi.fn(),
  filesUpload: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  // A regular function, so `new Anthropic(...)` works on the mock.
  default: vi.fn().mockImplementation(function MockAnthropic(this: Record<string, unknown>) {
    this.messages = { create: mocks.messagesCreate };
    this.beta = {
      messages: { create: mocks.betaMessagesCreate },
      files: { upload: mocks.filesUpload },
    };
  }),
  toFile: vi.fn(),
}));

// Imported after vi.mock, so the adapter and the router get the mocked SDK.
const { AnthropicProvider } = await import("./anthropic.js");
const { LLMRouter, MAX_TOOL_CALLS_PER_TURN } = await import("../router.js");

const MODEL = { provider: "anthropic" as const, name: "claude-sonnet-4-6" };
const INPUT = "Find the first value, then the second.";
const TOOLS = [
  {
    name: "lookup",
    description: "Look a value up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
];

// What the model returns, turn by turn: it thinks, says something and calls a
// tool; it thinks again and calls another; then it answers.
const TURN_1 = [
  {
    type: "thinking",
    thinking: "Two values are needed; the first one comes first.",
    signature: "signature-of-turn-one",
  },
  { type: "text", text: "Looking up the first value." },
  { type: "tool_use", id: "toolu_first", name: "lookup", input: { q: "first" } },
];
const TURN_2 = [
  {
    type: "thinking",
    thinking: "The first value is back; now the second.",
    signature: "signature-of-turn-two",
  },
  { type: "tool_use", id: "toolu_second", name: "lookup", input: { q: "second" } },
];
const TURN_3 = [{ type: "text", text: "Both values found." }];

function reply(content: unknown[], stopReason: string) {
  return {
    id: "msg_witness",
    type: "message",
    role: "assistant",
    model: MODEL.name,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

interface SentRequest {
  messages: Array<{ role: string; content: unknown }>;
}

describe("Anthropic in the router's tool loop — the earlier turns go back as the model returned them", () => {
  let requests: SentRequest[];

  beforeEach(() => {
    mocks.messagesCreate.mockReset();
    requests = [];
    const replies = [
      reply(TURN_1, "tool_use"),
      reply(TURN_2, "tool_use"),
      reply(TURN_3, "end_turn"),
    ];
    mocks.messagesCreate.mockImplementation(async (params: SentRequest) => {
      // Cloned when sent: an array the adapter reused from one turn to the next
      // would otherwise show its final state in every capture.
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next)
        throw new Error("the loop called the provider more often than the scenario answers");
      return structuredClone(next);
    });
  });

  it("the third request carries the input, then both assistant turns exactly as returned, thinking and signatures included, each followed by its result paired by tool_use_id", async () => {
    const router = new LLMRouter();
    router.registerProvider("anthropic", new AnthropicProvider("test-key"));
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
    expect(requests[2].messages).toEqual([
      { role: "user", content: [{ type: "text", text: INPUT }] },
      { role: "assistant", content: TURN_1 },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_first", content: "value of first" }],
      },
      { role: "assistant", content: TURN_2 },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_second", content: "value of second" }],
      },
    ]);
    // Byte for byte, not only deep-equal: the key order is the model's too.
    expect(JSON.stringify(requests[2].messages[1].content)).toBe(JSON.stringify(TURN_1));
    expect(JSON.stringify(requests[2].messages[3].content)).toBe(JSON.stringify(TURN_2));
  });
});

describe("Anthropic renders the conversation it is given", () => {
  let requests: SentRequest[];

  beforeEach(() => {
    mocks.messagesCreate.mockReset();
    requests = [];
    mocks.messagesCreate.mockImplementation(async (params: SentRequest) => {
      requests.push(structuredClone(params));
      return reply(TURN_3, "end_turn");
    });
  });

  it("a user message that follows tool results joins their message, after them", async () => {
    const provider = new AnthropicProvider("test-key");

    await provider.call({
      model: MODEL.name,
      systemPrompt: "system prompt",
      userContent: [{ kind: "text", text: INPUT }],
      userMessage: INPUT,
      history: [
        { kind: "assistant", turn: { provider: "anthropic", content: TURN_1 } },
        {
          kind: "tool_results",
          results: [{ name: "lookup", result: "value of first", id: "toolu_first" }],
        },
        { kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] },
      ],
    });

    expect(requests[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: INPUT }] },
      { role: "assistant", content: TURN_1 },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_first", content: "value of first" },
          { type: "text", text: "Now answer in JSON." },
        ],
      },
    ]);
  });

  it("an empty turn is left out, and the message after it joins the user turn before it: Anthropic refuses an empty assistant message", async () => {
    const provider = new AnthropicProvider("test-key");

    await provider.call({
      model: MODEL.name,
      systemPrompt: "system prompt",
      userContent: [{ kind: "text", text: INPUT }],
      userMessage: INPUT,
      history: [
        { kind: "assistant", turn: { provider: "anthropic", content: TURN_1 } },
        {
          kind: "tool_results",
          results: [{ name: "lookup", result: "value of first", id: "toolu_first" }],
        },
        { kind: "assistant", turn: { provider: "anthropic", content: [] } },
        { kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] },
      ],
    });

    expect(requests[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: INPUT }] },
      { role: "assistant", content: TURN_1 },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_first", content: "value of first" },
          { type: "text", text: "Now answer in JSON." },
        ],
      },
    ]);
  });

  it("a turn another provider produced throws a named error naming both providers, never the turn's content", async () => {
    const provider = new AnthropicProvider("test-key");
    const foreign = { role: "model", parts: [{ text: "witness output of another model" }] };

    const call = provider.call({
      model: MODEL.name,
      systemPrompt: "system prompt",
      userContent: [{ kind: "text", text: INPUT }],
      userMessage: INPUT,
      history: [{ kind: "assistant", turn: { provider: "google", content: foreign } }],
    });

    await expect(call).rejects.toBeInstanceOf(LLMHistoryError);
    await expect(call).rejects.toMatchObject({
      expectedProvider: "anthropic",
      receivedProvider: "google",
    });
    const error = await call.catch((e: unknown) => e as Error);
    expect(error.message).toContain("'google'");
    expect(error.message).toContain("'anthropic'");
    expect(error.message).not.toContain("witness output");
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
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
    router.registerProvider("anthropic", new AnthropicProvider("test-key"));
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
    expect(result.provider).toBe("anthropic");
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: INPUT }] },
    ]);
  });
});
