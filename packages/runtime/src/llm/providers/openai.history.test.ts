import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition, ToolResult } from "../../tools/types.js";
import type { RunEvent, RunRequest } from "../../types.js";
import { LLMHistoryError } from "../errors.js";
import type { HistoryEntry, LLMProvider, ToolCallRequest, ToolCallResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  chatCompletionsCreate: vi.fn(),
  filesCreate: vi.fn(),
}));

vi.mock("openai", () => ({
  // A regular function, so `new OpenAI(...)` works on the mock.
  default: vi.fn().mockImplementation(function MockOpenAI(this: Record<string, unknown>) {
    this.chat = { completions: { create: mocks.chatCompletionsCreate } };
    this.files = { create: mocks.filesCreate };
  }),
  toFile: vi.fn(),
}));

// Imported after vi.mock, so the adapters and the router get the mocked SDK.
const {
  OpenAICompatibleProvider,
  createGrokProvider,
  createGroqProvider,
  createMistralProvider,
  createOpenAIProvider,
} = await import("./openai.js");
const { LLMRouter, MAX_TOOL_CALLS_PER_TURN } = await import("../router.js");
const { runAgentLoop } = await import("../../adapter/agent-loop.js");
const { ToolRegistry } = await import("../../tools/registry.js");
const { createLogger } = await import("../../logger.js");

const MODEL = { provider: "openai" as const, name: "gpt-4o" };
const INPUT = "Find the first value, then the second.";
const TOOLS = [
  {
    name: "lookup",
    description: "Look a value up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
];

// The arguments exactly as the model wrote them: spaced (a re-serialization
// would drop the space), then not JSON at all (a parse-and-stringify would
// send "{}" instead).
const ARGS_1 = '{"q": "first"}';
const ARGS_2 = '{"q": "second",}';

// What the model returns, turn by turn: it says something and calls a tool;
// it calls another with arguments that do not parse; then it answers. The
// first message also carries fields a response has and a request may refuse.
const MESSAGE_1 = {
  role: "assistant",
  content: "Looking up the first value.",
  refusal: null,
  annotations: [],
  reasoning: "witness reasoning field of a provider extension",
  tool_calls: [
    { id: "call_first", type: "function", function: { name: "lookup", arguments: ARGS_1 } },
  ],
};
const MESSAGE_2 = {
  role: "assistant",
  content: null,
  refusal: null,
  tool_calls: [
    { id: "call_second", type: "function", function: { name: "lookup", arguments: ARGS_2 } },
  ],
};
const MESSAGE_3 = { role: "assistant", content: "Both values found.", refusal: null };

// What goes back: role, content and the function tool calls, nothing else.
const SENT_1 = {
  role: "assistant",
  content: "Looking up the first value.",
  tool_calls: [
    { id: "call_first", type: "function", function: { name: "lookup", arguments: ARGS_1 } },
  ],
};
const SENT_2 = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "call_second", type: "function", function: { name: "lookup", arguments: ARGS_2 } },
  ],
};

function reply(message: Record<string, unknown>, finishReason: string) {
  return {
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

interface SentRequest {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
}

describe("OpenAI-compatible in the router's tool loop — the earlier turns go back as the model returned them", () => {
  let requests: SentRequest[];

  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
    requests = [];
    const replies = [
      reply(MESSAGE_1, "tool_calls"),
      reply(MESSAGE_2, "tool_calls"),
      reply(MESSAGE_3, "stop"),
    ];
    mocks.chatCompletionsCreate.mockImplementation(async (params: SentRequest) => {
      // Cloned when sent: an array the adapter reused from one turn to the next
      // would otherwise show its final state in every capture.
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next)
        throw new Error("the loop called the provider more often than the scenario answers");
      return structuredClone(next);
    });
  });

  it("the third request carries the input, then both assistant messages with their text and their arguments in the original string, each followed by its tool message paired by tool_call_id", async () => {
    const router = new LLMRouter();
    router.registerProvider("openai", createOpenAIProvider("test-key"));
    const onToolCall = vi.fn(
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: `value for ${call.id}`,
        id: call.id,
      }),
    );

    const result = await router.call(MODEL, "system prompt", INPUT, TOOLS, onToolCall);

    expect(result.content).toBe("Both values found.");
    expect(requests).toHaveLength(3);
    expect(requests[2].messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: [{ type: "text", text: INPUT }] },
      SENT_1,
      { role: "tool", tool_call_id: "call_first", content: "value for call_first" },
      SENT_2,
      { role: "tool", tool_call_id: "call_second", content: "value for call_second" },
    ]);
    // Byte for byte: the arguments are the model's string, never parsed and
    // re-serialized.
    expect(JSON.stringify(requests[2].messages[2])).toBe(JSON.stringify(SENT_1));
    expect(JSON.stringify(requests[2].messages[4])).toBe(JSON.stringify(SENT_2));
    // No reasoning_content in these responses, so none in what goes back.
    expect("reasoning_content" in requests[2].messages[2]).toBe(false);
    expect("reasoning_content" in requests[2].messages[4]).toBe(false);
  });
});

describe("OpenAI-compatible in the router's tool loop — a reasoning_content the response carries goes back with its turn", () => {
  // Some endpoints (DeepSeek, Kimi) return the model's reasoning in a
  // reasoning_content field beside the content, and refuse a request with
  // tools whose earlier assistant turns do not carry it back.
  const REASONING = "witness reasoning: look the value up before answering";
  const ASKING = {
    role: "assistant",
    content: "",
    reasoning_content: REASONING,
    tool_calls: [
      { id: "call_first", type: "function", function: { name: "lookup", arguments: ARGS_1 } },
    ],
  };
  const ANSWERING = {
    role: "assistant",
    content: "The value is found.",
    reasoning_content: "witness reasoning of the answer",
  };

  let requests: SentRequest[];

  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
    requests = [];
    const replies = [reply(ASKING, "tool_calls"), reply(ANSWERING, "stop")];
    mocks.chatCompletionsCreate.mockImplementation(async (params: SentRequest) => {
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next)
        throw new Error("the loop called the provider more often than the scenario answers");
      return structuredClone(next);
    });
  });

  it("at a declared base_url, the next request carries the assistant turn with its reasoning_content exactly as returned, and so does the conversation the router returns", async () => {
    const router = new LLMRouter();
    router.registerProvider(
      "openai",
      new OpenAICompatibleProvider("openai", "k", "https://models.example/v1"),
    );

    const result = await router.call(
      { provider: "openai", name: "a-reasoning-model" },
      "system prompt",
      INPUT,
      TOOLS,
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: "value of first",
        id: call.id,
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[1].messages.slice(2)).toEqual([
      ASKING,
      { role: "tool", tool_call_id: "call_first", content: "value of first" },
    ]);
    expect((requests[1].messages[2] as Record<string, unknown>).reasoning_content).toBe(REASONING);
    const turns = (result.history?.entries ?? []).flatMap((e) =>
      e.kind === "assistant" ? [e.turn.content] : [],
    );
    expect(turns).toEqual([ASKING, ANSWERING]);
  });
});

describe("OpenAI-compatible adapters render the conversation they are given", () => {
  let requests: SentRequest[];

  beforeEach(() => {
    mocks.chatCompletionsCreate.mockReset();
    requests = [];
    mocks.chatCompletionsCreate.mockImplementation(async (params: SentRequest) => {
      requests.push(structuredClone(params));
      return reply(MESSAGE_3, "stop");
    });
  });

  function callWith(provider: LLMProvider, history: HistoryEntry[]) {
    return provider.call({
      model: "a-model",
      systemPrompt: "system prompt",
      userContent: [{ kind: "text", text: INPUT }],
      userMessage: INPUT,
      history,
    });
  }

  // Every OpenAI-compatible provider is the same class, built by a factory that
  // only sets its name, its endpoint and its cache behaviour; an agent-declared
  // base_url builds one under the agent's provider name.
  const ADAPTERS: Array<[string, string, () => LLMProvider]> = [
    ["openai", "openai", () => createOpenAIProvider("test-key")],
    ["mistral", "mistral", () => createMistralProvider("test-key")],
    ["groq", "groq", () => createGroqProvider("test-key")],
    ["xai", "xai", () => createGrokProvider("test-key")],
    [
      "a declared base_url",
      "openai",
      () => new OpenAICompatibleProvider("openai", "k", "https://models.example/v1"),
    ],
  ];

  it.each(
    ADAPTERS,
  )("%s renders the same conversation the same way, parallel calls answered in their order", async (_label, name, make) => {
    const parallel = {
      role: "assistant",
      content: "Two lookups.",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "lookup", arguments: ARGS_1 } },
        { id: "call_b", type: "function", function: { name: "fetch", arguments: ARGS_2 } },
      ],
    };

    await callWith(make(), [
      { kind: "assistant", turn: { provider: name, content: parallel } },
      {
        kind: "tool_results",
        results: [
          { name: "lookup", result: "value a", id: "call_a" },
          { name: "fetch", result: "value b", id: "call_b" },
        ],
      },
    ]);

    expect(requests[0].messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: [{ type: "text", text: INPUT }] },
      parallel,
      { role: "tool", tool_call_id: "call_a", content: "value a" },
      { role: "tool", tool_call_id: "call_b", content: "value b" },
    ]);
  });

  it("a content returned as a list of chunks, reasoning included, goes back as that list", async () => {
    const chunked = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: [{ type: "text", text: "witness reasoning chunk" }] },
        { type: "text", text: "witness answer" },
      ],
    };

    await callWith(createMistralProvider("test-key"), [
      { kind: "assistant", turn: { provider: "mistral", content: chunked } },
      { kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] },
    ]);

    expect(JSON.stringify(requests[0].messages[2])).toBe(JSON.stringify(chunked));
  });

  it("a later user message follows the tool messages in a message of its own, and joins a user message before it", async () => {
    await callWith(createOpenAIProvider("test-key"), [
      { kind: "assistant", turn: { provider: "openai", content: SENT_1 } },
      { kind: "tool_results", results: [{ name: "lookup", result: "value", id: "call_first" }] },
      { kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] },
    ]);
    await callWith(createOpenAIProvider("test-key"), [
      { kind: "user", parts: [{ kind: "text", text: "Now answer in JSON." }] },
    ]);

    expect(requests[0].messages.slice(2)).toEqual([
      SENT_1,
      { role: "tool", tool_call_id: "call_first", content: "value" },
      { role: "user", content: [{ type: "text", text: "Now answer in JSON." }] },
    ]);
    expect(requests[1].messages).toEqual([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: INPUT },
          { type: "text", text: "Now answer in JSON." },
        ],
      },
    ]);
  });

  it("an assistant message with neither text nor a call is left out: Chat Completions requires one or the other", async () => {
    await callWith(createOpenAIProvider("test-key"), [
      { kind: "assistant", turn: { provider: "openai", content: SENT_1 } },
      { kind: "tool_results", results: [{ name: "lookup", result: "value", id: "call_first" }] },
      {
        kind: "assistant",
        turn: { provider: "openai", content: { role: "assistant", content: null } },
      },
      { kind: "user", parts: [{ kind: "text", text: "Try again." }] },
    ]);
    await callWith(createOpenAIProvider("test-key"), [
      {
        kind: "assistant",
        turn: { provider: "openai", content: { role: "assistant", content: "" } },
      },
    ]);

    expect(requests[0].messages.slice(2)).toEqual([
      SENT_1,
      { role: "tool", tool_call_id: "call_first", content: "value" },
      { role: "user", content: [{ type: "text", text: "Try again." }] },
    ]);
    expect(requests[1].messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: [{ type: "text", text: INPUT }] },
    ]);
  });

  it("a turn another provider produced throws a named error naming both providers, never the turn's content — another OpenAI-compatible provider included", async () => {
    const foreign = { role: "assistant", content: "witness output of another model" };

    for (const [adapter, from] of [
      [createOpenAIProvider("test-key"), "anthropic"],
      [createGroqProvider("test-key"), "mistral"],
    ] as const) {
      const call = callWith(adapter, [
        { kind: "assistant", turn: { provider: from, content: foreign } },
      ]);

      await expect(call).rejects.toBeInstanceOf(LLMHistoryError);
      await expect(call).rejects.toMatchObject({
        expectedProvider: adapter.name,
        receivedProvider: from,
      });
      const error = await call.catch((e: unknown) => e as Error);
      expect(error.message).toContain(`'${from}'`);
      expect(error.message).toContain(`'${adapter.name}'`);
      expect(error.message).not.toContain("witness output");
    }
    expect(mocks.chatCompletionsCreate).not.toHaveBeenCalled();
  });

  it("served as the fallback of another provider whose first answer was refused before any tool ran, it starts from the input alone", async () => {
    // One call more than an answer may ask for: none runs, and the fallback
    // takes over from the primary's first turn.
    const primaryCall = vi.fn().mockResolvedValueOnce({
      content: "",
      toolCalls: Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, (_, i) => ({
        name: "lookup",
        args: { q: "first" },
        id: `toolu_${i}`,
      })),
      assistantTurn: {
        provider: "anthropic",
        content: [{ type: "text", text: "witness output of another model" }],
      },
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const router = new LLMRouter();
    router.registerProvider("anthropic", { name: "anthropic", call: primaryCall });
    router.registerProvider("openai", createOpenAIProvider("test-key"));
    const onToolCall = vi.fn(
      async (call: ToolCallRequest): Promise<ToolCallResult> => ({
        name: call.name,
        result: "value of first",
        id: call.id,
      }),
    );

    const result = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-6", fallback: MODEL },
      "system prompt",
      INPUT,
      TOOLS,
      onToolCall,
    );

    expect(primaryCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.provider).toBe("openai");
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: [{ type: "text", text: INPUT }] },
    ]);
  });
});

describe("OpenAI-compatible in the agent loop — a tool call whose arguments are nested deeper than the bound", () => {
  // The one path by which arguments thousands of levels deep reach a run: an
  // agent that declares model.base_url is served by this adapter alone, and
  // the endpoint writes what it wants. The loop refuses the call; the adapter
  // keeps the arguments in the model's own string, never parsed and
  // re-serialized, so the next request goes out whole.
  it("at a declared base_url, arguments 10,000 levels deep: the tool is never called, the next request carries them as written and ends with the tool message naming the bound, and the run completes", async () => {
    const deepArgs = `{"q":${"[".repeat(9_999)}${"]".repeat(9_999)}}`;
    // The case's premise: these arguments cannot be written back as JSON here.
    expect(() => JSON.stringify(JSON.parse(deepArgs))).toThrow(RangeError);

    mocks.chatCompletionsCreate.mockReset();
    const requests: SentRequest[] = [];
    const replies = [
      reply(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_deep",
              type: "function",
              function: { name: "lookup", arguments: deepArgs },
            },
          ],
        },
        "tool_calls",
      ),
      reply({ role: "assistant", content: '{"result":"ok"}' }, "stop"),
    ];
    mocks.chatCompletionsCreate.mockImplementation(async (params: SentRequest) => {
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next)
        throw new Error("the loop called the provider more often than the scenario answers");
      return structuredClone(next);
    });

    const callTool = vi.fn(async (): Promise<ToolResult> => ({ content: "found", isError: false }));
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "lookup", description: "lookup", parameters: {} },
      ],
      callTool,
      disconnect: async () => {},
    });
    const request: RunRequest = {
      agentConfig: {
        name: "test-agent",
        description: "Test agent",
        version: "1.0.0",
        model: { provider: "openai", name: "a-model", base_url: "https://models.example/v1" },
        inputs: [],
        outputs: [{ name: "result", type: "string", description: "result" }],
        tools: [],
        mcp_servers: [],
        environment: {
          networking: { allowed_hosts: [] },
          secrets: [],
          timeout: "30s",
          max_cost: 1.0,
        },
        state: { type: "none" },
        context_mode: "skill",
        tests: [],
      },
      skillContent: "You are a test agent.",
      input: { query: "hello" },
      runId: "test-run-id",
      callerKeys: { openai: "caller-key" },
    };

    const events: RunEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of runAgentLoop({
        request,
        router: new LLMRouter(),
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
      })) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    // Nothing on the way re-writes the arguments: the run does not throw.
    expect(thrown).toBeUndefined();
    expect(callTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    const [asking, answer] = requests[1].messages.slice(-2) as Array<Record<string, unknown>>;
    expect(asking).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_deep" }] });
    const written = (asking.tool_calls as Array<{ function: { arguments: string } }>)[0];
    expect(written.function.arguments === deepArgs).toBe(true);
    expect(answer).toEqual({
      role: "tool",
      tool_call_id: "call_deep",
      content: expect.stringMatching(
        /^Arguments nested more than 100 levels deep .*: the tool was not called$/,
      ),
    });
    expect(events.map((e) => e.type).filter((type) => type !== "run_heartbeat")).toEqual([
      "tool_call",
      "tool_call_error",
      "tool_result",
      "llm_complete",
      "run_complete",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "ok" } });
  });
});
