import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../llm/providers/types.js";
import { LLMRouter } from "../llm/router.js";
import type { StateCallbacks } from "./local.js";

function createMemoryState(): StateCallbacks {
  const store = new Map<string, Record<string, unknown>>();
  return {
    getState: async (name) => {
      const s = store.get(name);
      return s ? structuredClone(s) : null;
    },
    setState: async (name, s) => {
      store.set(name, structuredClone(s));
    },
  };
}

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

/** Mock provider that returns a different content on each successive call. Useful for retry tests. */
function createScriptedProvider(
  contents: string[],
  perCallTokens = { promptTokens: 100, completionTokens: 50 },
): LLMProvider {
  const fn = vi.fn();
  for (const content of contents) {
    fn.mockResolvedValueOnce({ content, usage: perCallTokens });
  }
  return { name: "mock", call: fn };
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
      name: "test-agent",
      description: "Test agent",
      version: "1.0.0",
      model: { provider: "mock", name: "mock-model" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      mcp_servers: [],
      environment: {
        networking: { allowed_hosts: [] },
        filesystem: "read-only",
        secrets: [],
        timeout: "30s",
        max_cost: 1.0,
        sandbox: "strict",
      },
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
  let state: StateCallbacks;

  beforeEach(() => {
    router = new LLMRouter();
    tools = new ToolRegistry();
    state = createMemoryState();
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
    expect(llmEvent?.type).toBe("llm_complete");
    if (llmEvent?.type === "llm_complete") {
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

  // VT-10 (#68 prompt-caching) — run_complete event surfaces cache_read_tokens
  // + cache_write_tokens in snake_case wire format when the provider returned
  // them. RunResult similarly exposes them in camelCase. Asserts the
  // adapter's plumbing from LLMRouterResponse through RunCompleteEvent and
  // RunResult.usage. Together with the response-builder change in
  // packages/api/src/routes/run.ts, this proves cache fields propagate
  // end-to-end into the POST /run JSON response.
  it("VT-10: run_complete surfaces cache_read_tokens + cache_write_tokens (snake_case)", async () => {
    const cachingProvider: LLMProvider = {
      name: "mock",
      call: vi.fn().mockResolvedValue({
        content: '{"result": "cached output"}',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          cacheReadTokens: 2048,
          cacheWriteTokens: 1024,
        },
      }),
    };
    router.registerProvider("mock", cachingProvider);
    const adapter = new LocalAdapter(router, tools, state);

    // Stream path: RunCompleteEvent has snake_case cache fields.
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    const complete = events.find((e) => e.type === "run_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "run_complete") {
      expect(complete.usage.cache_read_tokens).toBe(2048);
      expect(complete.usage.cache_write_tokens).toBe(1024);
    }

    // execute() path: RunResult has camelCase cache fields.
    const result = await adapter.execute(createRunRequest());
    expect(result.usage.cacheReadTokens).toBe(2048);
    expect(result.usage.cacheWriteTokens).toBe(1024);
  });

  // VT-10 — when no cache activity, fields are absent from both shapes.
  it("VT-10: run_complete omits cache fields when provider reports no cache activity", async () => {
    router.registerProvider("mock", createMockProvider('{"result": "no cache"}'));
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const complete = events.find((e) => e.type === "run_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "run_complete") {
      expect(complete.usage.cache_read_tokens).toBeUndefined();
      expect(complete.usage.cache_write_tokens).toBeUndefined();
    }

    const result = await adapter.execute(createRunRequest());
    expect(result.usage.cacheReadTokens).toBeUndefined();
    expect(result.usage.cacheWriteTokens).toBeUndefined();
  });

  // VT-10 — agentContext is built from agent name + version + environmentId
  // and threaded into the router. Verifies the plumbing from RunRequest
  // through to LLMProvider.call() receives a properly-derived cacheKey.
  it("VT-10: adapter passes agentContext to router → provider receives cacheKey", async () => {
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn().mockResolvedValue({
        content: '{"result": "ok"}',
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
    };
    router.registerProvider("mock", provider);
    const adapter = new LocalAdapter(router, tools, state);
    await adapter.execute(createRunRequest({ agent_version: "1.2.3", environmentId: "prod-us" }));

    const callArgs = (provider.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // cacheKey is hashed → 64-char hex digest of `${name}@${version}+${envId}`.
    expect(callArgs.cacheKey).toBeDefined();
    expect(callArgs.cacheKey).toMatch(/^[0-9a-f]{64}$/);
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

  // Bug C (audit/002): when a tool returns isError, the runtime emits a
  // visibility-only `tool_call_error` event BEFORE the existing `tool_result`.
  // The tool_result still flows back to the LLM normally — permissive default
  // contract (aligned with CMA/Bedrock/Vertex).
  describe("Bug C: tool_call_error visibility event", () => {
    it("SC-3 — emits tool_call_error before tool_result when isError is true (script tool)", async () => {
      const toolCallResponse = {
        content: "",
        toolCalls: [{ name: "failing_tool", args: { key: "value" }, id: "tc-1" }],
        usage: { promptTokens: 50, completionTokens: 20 },
      };
      const finalResponse = {
        content: '{"result": "recovered"}',
        usage: { promptTokens: 50, completionTokens: 30 },
      };
      const provider: LLMProvider = {
        name: "mock",
        call: vi.fn().mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(finalResponse),
      };
      router.registerProvider("mock", provider);

      tools.addProvider({
        name: "test",
        async listTools() {
          return [{ name: "failing_tool", description: "Fails on purpose", parameters: {} }];
        },
        async callTool() {
          return { content: "[BOOM] something went wrong", isError: true };
        },
        async disconnect() {},
      });

      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const errorEvent = events.find((e) => e.type === "tool_call_error");
      const resultEvent = events.find((e) => e.type === "tool_result");

      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "tool_call_error") {
        expect(errorEvent.tool).toBe("failing_tool");
        // Bracketed prefix `[BOOM]` is extracted as the structured `code`
        // field; the remainder becomes the `message`.
        expect(errorEvent.code).toBe("BOOM");
        expect(errorEvent.message).toBe("something went wrong");
      }

      // Ordering: tool_call → tool_call_error → tool_result
      const errorIdx = events.findIndex((e) => e.type === "tool_call_error");
      const resultIdx = events.findIndex((e) => e.type === "tool_result");
      expect(errorIdx).toBeGreaterThan(-1);
      expect(resultIdx).toBeGreaterThan(errorIdx);

      // The LLM still receives the tool_result content (permissive default).
      // We verify by asserting the run reached `run_complete` (the LLM produced
      // a final output after seeing the tool_result).
      expect(resultEvent?.type).toBe("tool_result");
      const runComplete = events.find((e) => e.type === "run_complete");
      expect(runComplete).toBeDefined();
    });

    it("SC-3 (regression) — does NOT emit tool_call_error when isError is false", async () => {
      const toolCallResponse = {
        content: "",
        toolCalls: [{ name: "ok_tool", args: {}, id: "tc-1" }],
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

      tools.addProvider({
        name: "test",
        async listTools() {
          return [{ name: "ok_tool", description: "Succeeds", parameters: {} }];
        },
        async callTool() {
          return { content: "all good", isError: false };
        },
        async disconnect() {},
      });

      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      expect(events.find((e) => e.type === "tool_call_error")).toBeUndefined();
      expect(events.find((e) => e.type === "tool_result")).toBeDefined();
    });

    it("SC-4 — emits tool_call_error for MCP tool failures (same emit path)", async () => {
      // MCP tools flow through the same ToolRegistry.callTool() path as
      // script tools — the test fixture is identical, just labelled "mcp" to
      // confirm the contract holds regardless of provider type.
      const toolCallResponse = {
        content: "",
        toolCalls: [{ name: "mcp_failing", args: { url: "https://broken" }, id: "tc-1" }],
        usage: { promptTokens: 50, completionTokens: 20 },
      };
      const finalResponse = {
        content: '{"result": "fallback"}',
        usage: { promptTokens: 50, completionTokens: 30 },
      };
      const provider: LLMProvider = {
        name: "mock",
        call: vi.fn().mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(finalResponse),
      };
      router.registerProvider("mock", provider);

      tools.addProvider({
        name: "mcp-fetch", // labelled as MCP, but behavior is identical
        async listTools() {
          return [{ name: "mcp_failing", description: "MCP tool that fails", parameters: {} }];
        },
        async callTool() {
          return { content: "Connection refused", isError: true };
        },
        async disconnect() {},
      });

      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const errorEvent = events.find((e) => e.type === "tool_call_error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "tool_call_error") {
        expect(errorEvent.tool).toBe("mcp_failing");
        // No bracketed prefix → no `code` field, full content as message.
        expect(errorEvent.code).toBeUndefined();
        expect(errorEvent.message).toBe("Connection refused");
      }
    });
  });

  describe("Bug E: post-loop output validation", () => {
    it("does not emit output_validation_warning when the final output matches the declared schema (SC-6)", async () => {
      router.registerProvider("mock", createMockProvider('{"result": "hello"}'));
      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const warning = events.find((e) => e.type === "output_validation_warning");
      expect(warning).toBeUndefined();
      expect(events[events.length - 1]?.type).toBe("run_complete");
    });

    it("emits output_validation_warning + repair retry succeeds with summed usage (SC-7)", async () => {
      // 1st call: missing required `result` key → triggers retry
      // 2nd call (repair): valid output → run_complete
      router.registerProvider(
        "mock",
        createScriptedProvider(['{"other": "value"}', '{"result": "fixed"}']),
      );
      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const warning = events.find((e) => e.type === "output_validation_warning");
      expect(warning).toBeDefined();
      if (warning?.type === "output_validation_warning") {
        expect(warning.errors.length).toBeGreaterThan(0);
      }

      const llmCompletes = events.filter((e) => e.type === "llm_complete");
      expect(llmCompletes).toHaveLength(2);

      const last = events[events.length - 1];
      expect(last?.type).toBe("run_complete");
      if (last?.type === "run_complete") {
        expect(last.output).toEqual({ result: "fixed" });
        // Summed: 2 calls × {prompt: 100, completion: 50}
        expect(last.usage.prompt_tokens).toBe(200);
        expect(last.usage.completion_tokens).toBe(100);
        expect(last.usage.total_tokens).toBe(300);
      }
    });

    it("repair retry still invalid → run_error OUTPUT_SCHEMA_INVALID (SC-8)", async () => {
      // Both calls return invalid output → retry exhausted
      router.registerProvider(
        "mock",
        createScriptedProvider(['{"other": "value"}', '{"still": "wrong"}']),
      );
      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const warning = events.find((e) => e.type === "output_validation_warning");
      expect(warning).toBeDefined();

      const llmCompletes = events.filter((e) => e.type === "llm_complete");
      expect(llmCompletes).toHaveLength(2);

      const last = events[events.length - 1];
      expect(last?.type).toBe("run_error");
      if (last?.type === "run_error") {
        expect(last.error.code).toBe("OUTPUT_SCHEMA_INVALID");
        expect(last.error.message).toContain("repair retry");
      }
    });

    it("repair retry returns non-JSON → run_error OUTPUT_SCHEMA_INVALID (SC-8b)", async () => {
      // 1st call: invalid output, 2nd call: no JSON object at all
      router.registerProvider(
        "mock",
        createScriptedProvider(['{"other": "value"}', "Sorry, I cannot comply."]),
      );
      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const last = events[events.length - 1];
      expect(last?.type).toBe("run_error");
      if (last?.type === "run_error") {
        expect(last.error.code).toBe("OUTPUT_SCHEMA_INVALID");
        expect(last.error.message).toMatch(/not valid JSON|did not contain a JSON object/);
      }
    });

    it("skips validation entirely when the agent declares no outputs", async () => {
      router.registerProvider("mock", createMockProvider('{"result": "hello"}'));
      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(
        adapter.executeStream(
          createRunRequest({
            agentConfig: {
              ...createRunRequest().agentConfig,
              outputs: [],
            },
          }),
        ),
      );

      const warning = events.find((e) => e.type === "output_validation_warning");
      expect(warning).toBeUndefined();
    });
  });
});

describe("LocalAdapter.execute (backward compat)", () => {
  it("returns RunResult from executeStream events", async () => {
    const router = new LLMRouter();
    const tools = new ToolRegistry();
    const state = createMemoryState();

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
    const state = createMemoryState();

    router.registerProvider("mock", createFailingProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const result = await adapter.execute(createRunRequest());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("LLM provider error");
  });
});
