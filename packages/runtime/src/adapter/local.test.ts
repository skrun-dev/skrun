import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_RESPONSE_MAX_BYTES, TOOL_RESULT_TRUNCATION_MARKER } from "../files/output-rules.js";
import type {
  HistoryEntry,
  LLMCallRequest,
  LLMCallResponse,
  LLMProvider,
} from "../llm/providers/types.js";
import { LLMRouter } from "../llm/router.js";
import type { Logger } from "../logger.js";
import type { StateCallbacks } from "./local.js";

/**
 * The output collector the adapter calls — the one that also counts what it
 * leaves out — observed: each call is noted in `order`, and `failWith` makes
 * the next call throw — a collection that fails.
 */
const collector = vi.hoisted(() => ({
  order: [] as string[],
  failWith: null as Error | null,
}));
vi.mock("../files/output-collector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../files/output-collector.js")>();
  return {
    ...actual,
    collectOutputFilesWithExclusions: (
      ...args: Parameters<typeof actual.collectOutputFilesWithExclusions>
    ) => {
      collector.order.push("collect");
      if (collector.failWith) throw collector.failWith;
      return actual.collectOutputFilesWithExclusions(...args);
    },
  };
});

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

import { McpToolProvider } from "../tools/mcp-provider.js";
import { ToolRegistry } from "../tools/registry.js";
import { ScriptToolProvider } from "../tools/script-provider.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { RunEvent, RunRequest } from "../types.js";
import { LocalAdapter } from "./local.js";
import { RUN_TOOL_RESULTS_MAX_BYTES, TOOL_RESULT_NOT_KEPT_MARKER } from "./tool-results-budget.js";

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

  it("emits no runner_spawned event (cold-start telemetry is flyio-only)", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const events = await collectEvents(adapter.executeStream(createRunRequest()));
    expect(events.some((e) => e.type === "runner_spawned")).toBe(false);
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

  // The local engine has no pool: whether the run may take a pooled machine
  // changes nothing of what it does.
  it("runs a request not entitled to the pool as any other", async () => {
    router.registerProvider("mock", createMockProvider());
    const adapter = new LocalAdapter(router, tools, state);
    const plain = await collectEvents(adapter.executeStream(createRunRequest()));
    const notEntitled = await collectEvents(
      adapter.executeStream(createRunRequest({ poolEligible: false })),
    );

    expect(notEntitled.map((e) => e.type)).toEqual(plain.map((e) => e.type));
    expect(notEntitled.at(-1)?.type).toBe("run_complete");
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

  // Prompt caching — the run_complete event surfaces cache_read_tokens
  // + cache_write_tokens in snake_case wire format when the provider returned
  // them. RunResult similarly exposes them in camelCase. Asserts the
  // adapter's plumbing from LLMRouterResponse through RunCompleteEvent and
  // RunResult.usage. Together with the response-builder change in
  // packages/api/src/routes/run.ts, this proves cache fields propagate
  // end-to-end into the POST /run JSON response.
  it("run_complete surfaces cache_read_tokens + cache_write_tokens (snake_case)", async () => {
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

  // When no cache activity, fields are absent from both shapes.
  it("run_complete omits cache fields when provider reports no cache activity", async () => {
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

  // agentContext is built from agent name + version + environmentId
  // and threaded into the router. Verifies the plumbing from RunRequest
  // through to LLMProvider.call() receives a properly-derived cacheKey.
  it("adapter passes agentContext to router → provider receives cacheKey", async () => {
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

  // When a tool returns isError, the runtime emits a
  // visibility-only `tool_call_error` event BEFORE the existing `tool_result`.
  // The tool_result still flows back to the LLM normally — permissive default
  // contract (aligned with CMA/Bedrock/Vertex).
  describe("tool_call_error visibility event", () => {
    it("emits tool_call_error before tool_result when isError is true (script tool)", async () => {
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

    it("does NOT emit tool_call_error when isError is false", async () => {
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

    it("emits tool_call_error for MCP tool failures (same emit path)", async () => {
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

  describe("post-loop output validation", () => {
    it("does not emit output_validation_warning when the final output matches the declared schema", async () => {
      router.registerProvider("mock", createMockProvider('{"result": "hello"}'));
      const adapter = new LocalAdapter(router, tools, state);
      const events = await collectEvents(adapter.executeStream(createRunRequest()));

      const warning = events.find((e) => e.type === "output_validation_warning");
      expect(warning).toBeUndefined();
      expect(events[events.length - 1]?.type).toBe("run_complete");
    });

    it("emits output_validation_warning + repair retry succeeds with summed usage", async () => {
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

    it("repair retry still invalid → run_error OUTPUT_SCHEMA_INVALID", async () => {
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

    it("repair retry returns non-JSON → run_error OUTPUT_SCHEMA_INVALID", async () => {
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

// The local runtime runs inside the API's process, so its log lines land in the
// API's log store: a failed run is logged by the error's class, code and status,
// never its message. The caller's run_error still says the message.
describe("LocalAdapter — a failure is logged by the error's class, never its message", () => {
  it("logs a failed run by the provider error's class and status, and still tells the caller its message", async () => {
    const router = new LLMRouter();
    router.registerProvider("mock", {
      name: "mock",
      call: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("rate limited for key witness-3e5d"), { status: 429 }),
        ),
    });
    const lines: unknown[][] = [];
    const keep = (...args: unknown[]) => {
      lines.push(args);
    };
    const logger = { error: keep, warn: keep, info: keep, debug: keep } as unknown as Logger;
    const adapter = new LocalAdapter(router, new ToolRegistry(), createMemoryState(), logger);

    const events = await collectEvents(adapter.executeStream(createRunRequest()));

    const failed = lines.find(
      ([fields]) => (fields as { event?: string } | undefined)?.event === "run_failed",
    );
    expect(JSON.stringify(failed)).not.toContain("witness-3e5d");
    expect(failed?.[0]).toMatchObject({ error_name: "Error", error_status: "429" });
    expect(failed?.[0]).not.toHaveProperty("error");
    const last = events[events.length - 1];
    expect(last?.type === "run_error" && last.error.message).toBe(
      "rate limited for key witness-3e5d",
    );
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

describe("LocalAdapter — the state is written once the output files are collected", () => {
  beforeEach(() => {
    collector.order = [];
    collector.failWith = null;
  });

  async function statefulRun() {
    const router = new LLMRouter();
    router.registerProvider("mock", createMockProvider('{"result": "ok", "_state": {"step": 1}}'));
    const writes: Array<Record<string, unknown>> = [];
    const state: StateCallbacks = {
      getState: async () => null,
      setState: async (_name, s) => {
        collector.order.push("setState");
        writes.push(s);
      },
    };
    const request = createRunRequest({ outputDir: "/nonexistent-output-dir-for-test" });
    request.agentConfig.state = { type: "kv", scope: "per_caller", ttl: "30d" };
    const adapter = new LocalAdapter(router, new ToolRegistry(), state);
    const events = await collectEvents(adapter.executeStream(request));
    return { events, writes };
  }

  it("a run whose files are collected writes its state once, after the collection", async () => {
    const { events, writes } = await statefulRun();

    expect(events.at(-1)?.type).toBe("run_complete");
    expect(writes).toEqual([{ step: 1 }]);
    expect(collector.order).toEqual(["collect", "setState"]);
  });

  it("a run whose file collection fails ends on run_error and writes no state", async () => {
    collector.failWith = new Error("disk unreadable");

    const { events, writes } = await statefulRun();

    const last = events.at(-1);
    expect(last?.type === "run_error" && last.error.code).toBe("EXECUTION_FAILED");
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
    expect(writes).toEqual([]);
  });

  it("a state write that fails after the collection ends the run on run_error", async () => {
    const router = new LLMRouter();
    router.registerProvider("mock", createMockProvider('{"result": "ok", "_state": {"step": 1}}'));
    const state: StateCallbacks = {
      getState: async () => null,
      setState: async () => {
        throw new Error("database unreachable");
      },
    };
    const request = createRunRequest({ outputDir: "/nonexistent-output-dir-for-test" });
    request.agentConfig.state = { type: "kv", scope: "per_caller", ttl: "30d" };
    const events = await collectEvents(
      new LocalAdapter(router, new ToolRegistry(), state).executeStream(request),
    );

    const last = events.at(-1);
    expect(last?.type === "run_error" && last.error).toEqual({
      code: "EXECUTION_FAILED",
      message: "database unreachable",
    });
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
  });
});

describe("LocalAdapter — a run ends on one terminal event, whatever the deadline does after the loop", () => {
  const terminal = (events: RunEvent[]) =>
    events
      .filter((e) => e.type === "run_complete" || e.type === "run_error")
      .map((e) => (e.type === "run_error" ? `run_error:${e.error.code}` : e.type));

  function statefulAdapter(writeMs: number, llmMs = 0) {
    const router = new LLMRouter();
    router.registerProvider("mock", {
      name: "mock",
      call: vi.fn(async () => {
        if (llmMs > 0) await new Promise((r) => setTimeout(r, llmMs));
        return {
          content: '{"result": "ok", "_state": {"step": 1}}',
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }),
    });
    const writes: Array<Record<string, unknown>> = [];
    const state: StateCallbacks = {
      getState: async () => null,
      setState: async (_name, s) => {
        await new Promise((r) => setTimeout(r, writeMs));
        writes.push(s);
      },
    };
    const request = createRunRequest();
    request.agentConfig.environment.timeout = "1s";
    request.agentConfig.state = { type: "kv", scope: "per_caller", ttl: "30d" };
    return { adapter: new LocalAdapter(router, new ToolRegistry(), state), request, writes };
  }

  it("a state write that ends past the deadline: the run completes, once, with its state kept", async () => {
    const { adapter, request, writes } = statefulAdapter(1_200);

    const events = await collectEvents(adapter.executeStream(request));

    expect(terminal(events)).toEqual(["run_complete"]);
    expect(writes).toEqual([{ step: 1 }]);
  });

  it("a consumer that holds run_complete past the deadline gets no run_error after it", async () => {
    const { adapter, request, writes } = statefulAdapter(0);

    const events: RunEvent[] = [];
    for await (const event of adapter.executeStream(request)) {
      events.push(event);
      if (event.type === "run_complete") await new Promise((r) => setTimeout(r, 1_200));
    }

    expect(terminal(events)).toEqual(["run_complete"]);
    expect(writes).toEqual([{ step: 1 }]);
  });

  it("a run the deadline stops inside the loop ends on one run_error TIMEOUT and writes no state", async () => {
    const { adapter, request, writes } = statefulAdapter(0, 1_200);

    const events = await collectEvents(adapter.executeStream(request));

    expect(terminal(events)).toEqual(["run_error:TIMEOUT"]);
    expect(writes).toEqual([]);
  });
});

// The caller learns how many of a run's output files were left out, and why:
// the run's end counts them by reason, on the stream and on the one-shot result.
// Counts only — a file's name is the agent's, and never leaves in them.
describe("LocalAdapter — the run's end counts the output files it left out, by reason, and names none", () => {
  const saved = { size: process.env.FILES_MAX_SIZE_MB, count: process.env.FILES_MAX_COUNT };
  let dir: string;

  beforeEach(() => {
    collector.order = [];
    collector.failWith = null;
    dir = mkdtempSync(join(tmpdir(), "skrun-local-left-out-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of [
      ["FILES_MAX_SIZE_MB", saved.size],
      ["FILES_MAX_COUNT", saved.count],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function adapter(): LocalAdapter {
    const router = new LLMRouter();
    router.registerProvider("mock", createMockProvider());
    return new LocalAdapter(router, new ToolRegistry());
  }

  /** Four files: one past a 1 MiB limit, and three small ones for a count of two. */
  function writeOneTooLargeAndOneTooMany(): void {
    process.env.FILES_MAX_SIZE_MB = "1";
    process.env.FILES_MAX_COUNT = "2";
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
    writeFileSync(join(dir, "c.txt"), "c");
    writeFileSync(join(dir, "d.txt"), "d");
  }

  it("counts a file past the size limit and one past the count on its run_complete", async () => {
    writeOneTooLargeAndOneTooMany();

    const events = await collectEvents(
      adapter().executeStream(createRunRequest({ outputDir: dir })),
    );

    const last = events.at(-1);
    if (last?.type !== "run_complete") throw new Error(`the run ended on ${last?.type}`);
    expect(last.files.map((file) => file.name)).toEqual(["a.txt", "c.txt"]);
    expect(last.files_excluded).toEqual({ too_large: 1, over_count: 1 });
    const told = JSON.stringify({ ...last, files: undefined });
    expect(told).not.toContain("big.bin");
    expect(told).not.toContain("d.txt");
  });

  it("counts them on its one-shot result too", async () => {
    writeOneTooLargeAndOneTooMany();

    const result = await adapter().execute(createRunRequest({ outputDir: dir }));

    expect(result.status).toBe("completed");
    expect(result.files?.map((file) => file.name)).toEqual(["a.txt", "c.txt"]);
    expect(result.filesExcluded).toEqual({ too_large: 1, over_count: 1 });
  });

  it("counts nothing when every file is kept: an empty object, never absent", async () => {
    writeFileSync(join(dir, "a.txt"), "a");

    const events = await collectEvents(
      adapter().executeStream(createRunRequest({ outputDir: dir })),
    );
    const result = await adapter().execute(createRunRequest({ outputDir: dir }));

    const last = events.at(-1);
    expect(last?.type === "run_complete" && last.files_excluded).toEqual({});
    expect(result.filesExcluded).toEqual({});
  });

  it("counts nothing when the run writes no file", async () => {
    const events = await collectEvents(
      adapter().executeStream(createRunRequest({ outputDir: dir })),
    );

    const last = events.at(-1);
    expect(last?.type === "run_complete" && last.files).toEqual([]);
    expect(last?.type === "run_complete" && last.files_excluded).toEqual({});
  });
});

describe("LocalAdapter — a run's tool results are bounded as on the cloud runtime", () => {
  const MIB = 1024 * 1024;
  const bytesOf = (content: string): number => Buffer.byteLength(content, "utf8");
  /** Bytes of UTF-8 of the JSON a sandbox answers a tool call with. */
  const answerBytes = (result: string, isError = false): number =>
    Buffer.byteLength(JSON.stringify({ content: result, isError }), "utf8");

  /**
   * A model that asks, at each of its first turns, for the calls `turns` lists,
   * then answers; the history of each request it receives is kept as sent.
   */
  function modelAsking(turns: Array<Array<{ name: string; args: Record<string, unknown> }>>) {
    const histories: HistoryEntry[][] = [];
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
        histories.push(request.history ?? []);
        const calls = turns[histories.length - 1];
        if (!calls) {
          return {
            content: '{"result":"done"}',
            assistantTurn: { provider: "mock", content: { answers: true } },
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          content: "",
          toolCalls: calls.map((c, i) => ({ ...c, id: `call-${histories.length}-${i}` })),
          assistantTurn: { provider: "mock", content: { asks: histories.length } },
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }),
    };
    return { provider, histories };
  }

  const resultsIn = (history: HistoryEntry[] | undefined): string[] =>
    (history ?? []).flatMap((entry) =>
      entry.kind === "tool_results" ? entry.results.map((r) => r.result) : [],
    );

  const toolResultsOf = (events: RunEvent[]) =>
    events.flatMap((e) => (e.type === "tool_result" ? [e] : []));

  it("a model that asks for 1 MiB results at every turn: past 8 MiB each result is replaced by the marker, and the run completes", async () => {
    const { provider, histories } = modelAsking(
      Array.from({ length: 4 }, () => Array(3).fill({ name: "big", args: {} })),
    );
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "big", description: "big", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => ({ content: "b".repeat(MIB), isError: false }),
      disconnect: async () => {},
    });

    const events = await collectEvents(
      new LocalAdapter(router, tools, createMemoryState()).executeStream(createRunRequest()),
    );

    const results = toolResultsOf(events).map((e) => e.result);
    expect(results).toHaveLength(12);
    const kept = results.slice(0, 8);
    for (const result of kept) {
      expect(result.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
      expect(answerBytes(result)).toBeLessThanOrEqual(TOOL_RESPONSE_MAX_BYTES);
    }
    expect(results.slice(8)).toEqual(Array(4).fill(TOOL_RESULT_NOT_KEPT_MARKER));
    // What the model read last is what the events carried, the results kept within the bound.
    const last = resultsIn(histories.at(-1));
    expect(last).toEqual(results);
    expect(kept.reduce((sum, r) => sum + bytesOf(r), 0)).toBeLessThanOrEqual(
      RUN_TOOL_RESULTS_MAX_BYTES,
    );
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "done" } });
  });

  describe("a script's and a local MCP server's result over 1 MiB", () => {
    const SERVER = resolve(import.meta.dirname, "../../tests/fixtures/big-answer-mcp-server.js");
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "skrun-local-cut-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("cuts each to 1 MiB with the marker, as the sandbox does, and the run completes", async () => {
      // A script that writes 3 MB, under the 5 MB it may write.
      const scripts = join(dir, "scripts");
      mkdirSync(scripts);
      writeFileSync(
        join(scripts, "script_big.js"),
        'process.stdout.write("s".repeat(3_000_000));\n',
      );
      const script = new ScriptToolProvider(scripts, [
        {
          name: "script_big",
          description: "Writes 3 MB",
          input_schema: { type: "object", properties: {} },
        },
      ]);
      // A local MCP server that answers 2 MiB, under the 10 MiB of a message.
      const counter = join(dir, "calls.txt");
      writeFileSync(counter, "");
      const mcp = new McpToolProvider({
        name: "big-answer",
        transport: "stdio",
        command: process.execPath,
        args: [SERVER, counter],
        auth: "none",
      });
      const tools = new ToolRegistry();
      try {
        await tools.addProvider(script);
        await tools.addProvider(mcp);
        const { provider, histories } = modelAsking([
          [
            { name: "script_big", args: {} },
            { name: "big", args: { mib: 2 } },
          ],
        ]);
        const router = new LLMRouter();
        router.registerProvider("mock", provider);

        const events = await collectEvents(
          new LocalAdapter(router, tools, createMemoryState()).executeStream(createRunRequest()),
        );

        const [fromScript, fromMcp] = toolResultsOf(events);
        expect(fromScript).toMatchObject({ tool: "script_big", is_error: false });
        expect(fromMcp).toMatchObject({ tool: "big", is_error: false });
        for (const [result, letter] of [
          [fromScript.result, "s"],
          [fromMcp.result, "x"],
        ] as const) {
          expect(result.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
          expect(result.startsWith(letter.repeat(1000))).toBe(true);
          expect(answerBytes(result)).toBeLessThanOrEqual(TOOL_RESPONSE_MAX_BYTES);
          // Cut as close to the bound as the answer allows, not shorter.
          expect(answerBytes(result)).toBeGreaterThan(TOOL_RESPONSE_MAX_BYTES - 16);
        }
        // The model read the results cut, not whole.
        expect(resultsIn(histories.at(-1))).toEqual([fromScript.result, fromMcp.result]);
        expect(events.at(-1)?.type).toBe("run_complete");
      } finally {
        await mcp.disconnect();
      }
    }, 30_000);
  });
});
