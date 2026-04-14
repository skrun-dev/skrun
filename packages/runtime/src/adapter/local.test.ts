import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../llm/providers/types.js";
import { LLMRouter } from "../llm/router.js";
import { MemoryStateStore } from "../state/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import type { RunEvent, RunRequest } from "../types.js";
import { LocalAdapter } from "./local.js";

function createMockProvider(content = '{"result": "hello"}'): LLMProvider {
  return {
    name: "mock",
    call: vi.fn().mockResolvedValue({
      content,
      usage: { promptTokens: 100, completionTokens: 50 },
    }),
  };
}

function createFailingProvider(): LLMProvider {
  return {
    name: "mock",
    call: vi.fn().mockRejectedValue(new Error("LLM provider error")),
  };
}

function createRunRequest(overrides?: Partial<RunRequest>): RunRequest {
  return {
    agentConfig: {
      name: "test/agent",
      description: "Test agent",
      version: "1.0.0",
      model: { provider: "mock", name: "mock-model" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      mcp_servers: [],
      permissions: { network: false, filesystem: false, secrets: [] },
      runtime: { timeout: "30s", max_cost: 1.0, sandbox: true },
      state: { type: "none" },
      context_mode: "skill",
      tests: [],
    },
    skillContent: "You are a test agent.",
    input: { query: "hello" },
    runId: "test-run-id",
    ...overrides,
  };
}

async function collectEvents(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("LocalAdapter.executeStream", () => {
  let router: LLMRouter;
  let tools: ToolRegistry;
  let state: MemoryStateStore;

  beforeEach(() => {
    router = new LLMRouter();
    tools = new ToolRegistry();
    state = new MemoryStateStore();
  });

  it("yields run_start as first event", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    expect(events[0].type).toBe("run_start");
    expect(events[0].run_id).toBe("test-run-id");
  });

  it("yields run_complete as last event", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const last = events[events.length - 1];
    expect(last.type).toBe("run_complete");
  });

  it("yields llm_complete event with provider and model info", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const llmEvent = events.find((e) => e.type === "llm_complete");
    expect(llmEvent).toBeDefined();
    expect(llmEvent!.type).toBe("llm_complete");
    if (llmEvent!.type === "llm_complete") {
      expect(llmEvent.provider).toBe("mock");
      expect(llmEvent.model).toBe("mock-model");
      expect(llmEvent.tokens).toBe(150);
    }
  });

  it("all events have run_id, type, and timestamp", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    for (const event of events) {
      expect(event.run_id).toBe("test-run-id");
      expect(event.type).toBeDefined();
      expect(event.timestamp).toBeDefined();
      // Verify timestamp is valid ISO string
      expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    }
  });

  it("run_complete contains output, usage, cost, and duration_ms", async () => {
    router.registerProvider("mock", createMockProvider('{"result": "test output"}'));
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const complete = events.find((e) => e.type === "run_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "run_complete") {
      expect(complete.output).toBeDefined();
      expect(complete.usage.prompt_tokens).toBe(100);
      expect(complete.usage.completion_tokens).toBe(50);
      expect(complete.usage.total_tokens).toBe(150);
      expect(complete.cost.estimated).toBeGreaterThanOrEqual(0);
      expect(complete.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("yields run_error on LLM failure", async () => {
    router.registerProvider("mock", createFailingProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const errorEvent = events.find((e) => e.type === "run_error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "run_error") {
      expect(errorEvent.error.code).toBe("EXECUTION_FAILED");
      expect(errorEvent.error.message).toContain("LLM provider error");
    }
    // No run_complete event
    expect(events.find((e) => e.type === "run_complete")).toBeUndefined();
  });

  it("yields tool_call and tool_result events when tools are used", async () => {
    const toolCallResponse = {
      content: "",
      toolCalls: [{ name: "test_tool", args: { key: "value" }, id: "tc-1" }],
      usage: { promptTokens: 50, completionTokens: 20 },
    };
    const finalResponse = {
      content: '{"result": "done"}',
      usage: { promptTokens: 50, completionTokens: 30 },
    };

    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn().mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(finalResponse),
    };
    router.registerProvider("mock", provider);

    // Add a simple tool provider
    tools.addProvider({
      name: "test",
      async listTools() {
        return [{ name: "test_tool", description: "A test tool", parameters: {} }];
      },
      async callTool(_name: string, _args: Record<string, unknown>) {
        return { content: "tool result value", isError: false };
      },
      async disconnect() {},
    });

    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.tool).toBe("test_tool");
      expect(toolCall.args).toEqual({ key: "value" });
    }

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.tool).toBe("test_tool");
      expect(toolResult.result).toBe("tool result value");
      expect(toolResult.is_error).toBe(false);
    }
  });

  it("event order is: run_start → [tool_call, tool_result]* → llm_complete → run_complete", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types[types.length - 1]).toBe("run_complete");
    expect(types[types.length - 2]).toBe("llm_complete");
  });
});

describe("LocalAdapter.execute (backward compat)", () => {
  it("returns RunResult from executeStream events", async () => {
    const router = new LLMRouter();
    const tools = new ToolRegistry();
    const state = new MemoryStateStore();

    router.registerProvider("mock", createMockProvider('{"result": "test"}'));
    const adapter = new LocalAdapter(router, tools, state);
    const result = await adapter.execute(createRunRequest());

    expect(result.runId).toBe("test-run-id");
    expect(result.status).toBe("completed");
    expect(result.output).toHaveProperty("result");
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns failed result on error", async () => {
    const router = new LLMRouter();
    const tools = new ToolRegistry();
    const state = new MemoryStateStore();

    router.registerProvider("mock", createFailingProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const result = await adapter.execute(createRunRequest());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("LLM provider error");
  });
});
