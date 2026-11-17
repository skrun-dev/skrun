import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import type { RunEvent } from "../types.js";
import type { ToolCallRequest, ToolCallResult } from "./providers/types.js";

// Every line any logger writes — the router's, each adapter's, the agent
// loop's — kept with its arguments, at every level.
const logs = vi.hoisted(() => ({ lines: [] as unknown[][] }));

vi.mock("../logger.js", () => ({
  createLogger: (name: string) => {
    const keep =
      (level: string) =>
      (...args: unknown[]) => {
        logs.lines.push([name, level, ...args]);
      };
    const logger: Record<string, unknown> = {
      trace: keep("trace"),
      debug: keep("debug"),
      info: keep("info"),
      warn: keep("warn"),
      error: keep("error"),
      fatal: keep("fatal"),
    };
    logger.child = () => logger;
    return logger;
  },
}));

const sdk = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  geminiGenerate: vi.fn(),
  openaiCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function MockAnthropic(this: Record<string, unknown>) {
    this.messages = { create: sdk.anthropicCreate };
    this.beta = { messages: { create: sdk.anthropicCreate }, files: { upload: vi.fn() } };
  }),
  toFile: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function MockGemini(
    this: Record<string, unknown>,
  ) {
    this.getGenerativeModel = () => ({ generateContent: sdk.geminiGenerate });
  }),
  SchemaType: { OBJECT: "OBJECT" },
  FunctionCallingMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE" },
}));

vi.mock("@google/generative-ai/server", () => ({
  GoogleAIFileManager: vi.fn().mockImplementation(function MockFiles() {}),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function MockOpenAI(this: Record<string, unknown>) {
    this.chat = { completions: { create: sdk.openaiCreate } };
    this.files = { create: vi.fn() };
  }),
  toFile: vi.fn(),
}));

// Imported after the mocks, so every module gets the capturing logger and the
// mocked SDKs.
const { AnthropicProvider } = await import("./providers/anthropic.js");
const { GoogleProvider } = await import("./providers/google.js");
const { createMistralProvider, createOpenAIProvider } = await import("./providers/openai.js");
const { LLMRouter, MAX_TOOL_CALLS_PER_TURN } = await import("./router.js");
const { runAgentLoop } = await import("../adapter/agent-loop.js");
const { ToolRegistry } = await import("../tools/registry.js");

/** The value every turn of the model, and every tool result, carries. */
const WITNESS = "witness-7f3c9a-conversation";

const TOOLS = [{ name: "lookup", description: "Look a value up", parameters: { type: "object" } }];

const echo = async (call: ToolCallRequest): Promise<ToolCallResult> => ({
  name: call.name,
  result: `result for ${call.id ?? call.name}: ${WITNESS}`,
  id: call.id,
});

// Three turns per provider, the witness in what the model writes: its text,
// its reasoning, its call arguments.
function anthropicTurns() {
  const reply = (content: unknown[]) => ({
    content,
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  return [
    reply([
      { type: "thinking", thinking: `I think ${WITNESS}`, signature: `sig ${WITNESS}` },
      { type: "text", text: `Looking ${WITNESS}` },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: WITNESS } },
    ]),
    reply([{ type: "tool_use", id: "toolu_2", name: "lookup", input: { q: WITNESS } }]),
    reply([{ type: "text", text: `{"result": "${WITNESS}"}` }]),
  ];
}

function geminiTurns() {
  const reply = (parts: unknown[]) => ({
    response: {
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    },
  });
  return [
    reply([
      { text: `Looking ${WITNESS}` },
      {
        functionCall: { name: "lookup", args: { q: WITNESS } },
        thoughtSignature: `sig ${WITNESS}`,
      },
    ]),
    reply([{ functionCall: { name: "lookup", args: { q: WITNESS } } }]),
    reply([{ text: `{"result": "${WITNESS}"}` }]),
  ];
}

function openaiTurns() {
  const reply = (message: Record<string, unknown>) => ({
    choices: [{ index: 0, message: { role: "assistant", ...message } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
  const call = (id: string) => ({
    id,
    type: "function",
    function: { name: "lookup", arguments: `{"q": "${WITNESS}"` },
  });
  return [
    reply({ content: `Looking ${WITNESS}`, tool_calls: [call("call_1")] }),
    reply({ content: null, tool_calls: [call("call_2")] }),
    reply({ content: `{"result": "${WITNESS}"}` }),
  ];
}

function scriptSdks() {
  const a = anthropicTurns();
  const g = geminiTurns();
  const o = openaiTurns();
  sdk.anthropicCreate.mockImplementation(async () => a.shift() ?? anthropicTurns()[2]);
  sdk.geminiGenerate.mockImplementation(async () => g.shift() ?? geminiTurns()[2]);
  sdk.openaiCreate.mockImplementation(async () => o.shift() ?? openaiTurns()[2]);
}

/**
 * A primary that fails at its first call — before any tool ran, so that the
 * fallback takes over — with an error quoting the witness.
 */
function failingPrimary() {
  return {
    name: "groq",
    call: vi.fn().mockRejectedValue(new Error(`provider refused the request: ${WITNESS}`)),
  };
}

/**
 * A primary whose first answer carries the witness — in its text, in its turn
 * as returned, and in the arguments of one call more than an answer may ask
 * for: refused before any tool ran, so that the fallback takes over.
 */
function refusedPrimary() {
  const calls = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, (_, i) => ({
    name: "lookup",
    args: { q: WITNESS },
    id: `call_${i}`,
  }));
  return {
    name: "groq",
    call: vi.fn().mockResolvedValue({
      content: `Looking ${WITNESS}`,
      toolCalls: calls,
      assistantTurn: {
        provider: "groq",
        content: {
          role: "assistant",
          content: `Looking ${WITNESS}`,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
      usage: { promptTokens: 1, completionTokens: 1 },
    }),
  };
}

function everyLine(): string {
  return JSON.stringify(logs.lines, (_key, value) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

const events = (): string[] =>
  logs.lines.map((line) => (line[2] as { event?: string } | undefined)?.event ?? "");

describe("the conversation never reaches a log line", () => {
  beforeEach(() => {
    logs.lines = [];
    sdk.anthropicCreate.mockReset();
    sdk.geminiGenerate.mockReset();
    sdk.openaiCreate.mockReset();
    scriptSdks();
  });

  const ADAPTERS = [
    ["anthropic", "claude-sonnet-4-6", () => new AnthropicProvider("k")],
    ["google", "gemini-2.5-flash", () => new GoogleProvider("k")],
    ["openai", "gpt-4o", () => createOpenAIProvider("k")],
    ["mistral", "mistral-large-latest", () => createMistralProvider("k")],
  ] as const;

  it.each(
    ADAPTERS,
  )("%s: three turns after a primary that failed, every line of every logger, at every level, holds no trace of the model's output or of a tool result", async (name, model, make) => {
    const router = new LLMRouter();
    router.registerProvider("groq", failingPrimary());
    router.registerProvider(name, make());

    const result = await router.call(
      { provider: "groq", name: "openai/gpt-oss-120b", fallback: { provider: name, name: model } },
      "system prompt",
      "find the value",
      TOOLS,
      echo,
      undefined,
      undefined,
      // A directive and a parallel setting that each adapter degrades somewhere,
      // so each writes a line of its own.
      { mode: "subset", tools: ["lookup"] },
      false,
    );

    expect(result.content).toContain(WITNESS);
    expect(JSON.stringify(result.history)).toContain(WITNESS);
    expect(events()).toContain("primary_failed");
    expect(
      logs.lines.some(([logger]) => logger === `llm:${name === "mistral" ? "openai" : name}`),
    ).toBe(true);
    expect(everyLine()).not.toContain(WITNESS);
  });

  it.each(
    ADAPTERS,
  )("%s: three turns after a primary whose first answer was refused before any tool ran, every line of every logger, at every level, holds no trace of that answer, of the model's output or of a tool result", async (name, model, make) => {
    const router = new LLMRouter();
    const primary = refusedPrimary();
    router.registerProvider("groq", primary);
    router.registerProvider(name, make());

    const result = await router.call(
      { provider: "groq", name: "openai/gpt-oss-120b", fallback: { provider: name, name: model } },
      "system prompt",
      "find the value",
      TOOLS,
      echo,
      undefined,
      undefined,
      { mode: "subset", tools: ["lookup"] },
      false,
    );

    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe(name);
    expect(result.content).toContain(WITNESS);
    expect(events()).toEqual(expect.arrayContaining(["model_bound_refused", "primary_failed"]));
    expect(everyLine()).not.toContain(WITNESS);
  });

  it("a loop stopped by its spend ceiling, then one stopped by its iteration bound: their lines name numbers, never the conversation", async () => {
    const router = new LLMRouter();
    router.registerProvider("anthropic", new AnthropicProvider("k"));
    sdk.anthropicCreate.mockReset();
    sdk.anthropicCreate.mockImplementation(async () => anthropicTurns()[0]);

    const stopped = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-6" },
      "system prompt",
      "find the value",
      TOOLS,
      echo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxCost: 0.000_001 },
    );
    const bounded = await router.call(
      { provider: "anthropic", name: "claude-sonnet-4-6" },
      "system prompt",
      "find the value",
      TOOLS,
      echo,
    );

    expect(stopped.costExceeded).toBe(true);
    expect(bounded.content).toMatch(/Max tool iterations reached/);
    expect(JSON.stringify(bounded.history)).toContain(WITNESS);
    expect(events()).toEqual(expect.arrayContaining(["tool_loop_cost_exceeded", "max_iterations"]));
    expect(everyLine()).not.toContain(WITNESS);
  });

  it("a run whose output misses its schema, repaired with its conversation: the agent loop's lines hold none of it either", async () => {
    sdk.anthropicCreate.mockReset();
    const turns = anthropicTurns();
    // The third turn misses the declared output; the repair answers it.
    turns[2] = {
      content: [{ type: "text", text: `{"other": "${WITNESS}"}` }],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    turns.push({
      content: [{ type: "text", text: `{"result": "${WITNESS}"}` }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    sdk.anthropicCreate.mockImplementation(async () => turns.shift());
    const router = new LLMRouter();
    router.registerProvider("anthropic", new AnthropicProvider("k"));
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async () => [{ name: "lookup", description: "lookup", parameters: {} }],
      callTool: async () => ({ content: `a tool result ${WITNESS}`, isError: false }),
      disconnect: async () => {},
    });
    const loopLines: unknown[][] = [];
    const keep = (...args: unknown[]) => {
      loopLines.push(args);
    };
    const logger = { info: keep, warn: keep, error: keep, debug: keep } as unknown as Logger;

    const received: RunEvent[] = [];
    for await (const event of runAgentLoop({
      request: {
        agentConfig: {
          name: "witness-agent",
          description: "d",
          version: "1.0.0",
          model: { provider: "anthropic", name: "claude-sonnet-4-6" },
          inputs: [],
          outputs: [{ name: "result", type: "string", description: "result" }],
          tools: [],
          mcp_servers: [],
          environment: {
            networking: { allowed_hosts: [] },
            secrets: [],
            timeout: "30s",
            max_cost: 1,
          },
          state: { type: "none" },
          context_mode: "skill",
          tests: [],
        },
        skillContent: "You are a test agent.",
        input: { query: "find the value" },
        runId: "run-witness",
      },
      router,
      tools,
      logger,
      startMs: Date.now(),
    })) {
      received.push(event);
    }

    expect(received.at(-1)?.type).toBe("run_complete");
    expect(sdk.anthropicCreate).toHaveBeenCalledTimes(4);
    expect(loopLines.map(([fields]) => (fields as { event?: string }).event)).toEqual(
      expect.arrayContaining([
        "llm_call",
        "tool_result",
        "output_validation_failed",
        "run_complete",
      ]),
    );
    expect(JSON.stringify(loopLines)).not.toContain(WITNESS);
    expect(everyLine()).not.toContain(WITNESS);
  });
});
