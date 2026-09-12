import { describe, expect, it, vi } from "vitest";
import { estimateCost } from "../llm/cost.js";
import type { LLMProvider } from "../llm/providers/types.js";
import { LLMRouter } from "../llm/router.js";
import { createLogger } from "../logger.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "../tools/types.js";
import type { RunEvent, RunRequest } from "../types.js";
import { runAgentLoop, withHeartbeats } from "./agent-loop.js";

function createRunRequest(overrides?: Partial<RunRequest>): RunRequest {
  return {
    agentConfig: {
      name: "test-agent",
      description: "Test agent",
      version: "1.0.0",
      model: { provider: "mock", name: "mock-model" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      tools: [],
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

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("runAgentLoop heartbeats", () => {
  it("emits multiple run_heartbeat events with stage=waiting_tool while a tool call hangs", async () => {
    // Tool that hangs 250ms — with a 50ms heartbeat interval we should
    // observe ~3-4 heartbeats during the wait. Use 2 as the lower-bound
    // assertion to keep the test robust against scheduler jitter.
    const hangingTool: ToolProvider = {
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "slow", description: "slow tool", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => {
        await new Promise((r) => setTimeout(r, 250));
        return { content: "done", isError: false };
      },
      disconnect: async () => {},
    };

    // LLM provider that returns a `slow` tool call on iter 1, then final content on iter 2.
    let iter = 0;
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => {
        iter += 1;
        if (iter === 1) {
          return {
            content: "",
            toolCalls: [{ name: "slow", args: {}, id: "call-1" }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }
        return {
          content: '{"result":"ok"}',
          usage: { promptTokens: 5, completionTokens: 3 },
        };
      }),
    };

    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const tools = new ToolRegistry();
    await tools.addProvider(hangingTool);

    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
        heartbeatIntervalMs: 50,
      }),
    );

    const heartbeats = events.filter((e) => e.type === "run_heartbeat");
    const toolHeartbeats = heartbeats.filter(
      (e) => e.type === "run_heartbeat" && e.stage === "waiting_tool",
    );
    expect(toolHeartbeats.length).toBeGreaterThanOrEqual(2);
  });

  it("emits run_heartbeat with stage=waiting_llm while the LLM call hangs", async () => {
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 250));
        return {
          content: '{"result":"ok"}',
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const tools = new ToolRegistry();

    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
        heartbeatIntervalMs: 50,
      }),
    );

    const llmHeartbeats = events.filter(
      (e) => e.type === "run_heartbeat" && e.stage === "waiting_llm",
    );
    expect(llmHeartbeats.length).toBeGreaterThanOrEqual(2);
  });

  it("emits NO heartbeats when the LLM resolves quickly (interval not exceeded)", async () => {
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => ({
        content: '{"result":"fast"}',
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const tools = new ToolRegistry();

    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
        heartbeatIntervalMs: 1_000,
      }),
    );

    const heartbeats = events.filter((e) => e.type === "run_heartbeat");
    expect(heartbeats.length).toBe(0);
  });
});

describe("runAgentLoop max_cost (LLM08)", () => {
  it("aborts with run_error COST_EXCEEDED (no run_complete) when the aggregate cost exceeds max_cost", async () => {
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => ({
        content: '{"result":"ok"}',
        // High token counts on a priced model → cost well above max_cost.
        usage: { promptTokens: 1_000_000, completionTokens: 100_000 },
      })),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const req = createRunRequest();
    req.agentConfig.model = { provider: "mock", name: "claude-sonnet-4-6" };
    req.agentConfig.environment.max_cost = 0.01;

    const events = await collect(
      runAgentLoop({
        request: req,
        router,
        tools: new ToolRegistry(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );

    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") {
      expect(last.error.code).toBe("COST_EXCEEDED");
    }
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
  });
});

describe("runAgentLoop max_cost inside the tool loop (#116)", () => {
  /**
   * Mirrors `MAX_TOOL_ITERATIONS` in llm/router.ts. It is the whole point of
   * these two cases: an over-budget run ended on the same cost error before and
   * after this change — what tells the two apart is HOW MANY provider calls it
   * paid for on the way there.
   */
  const MAX_TOOL_ITERATIONS = 10;
  const PROMPT_TOKENS = 1_000;
  const COMPLETION_TOKENS = 200;
  const MODEL = "claude-sonnet-4-6";

  /** A provider that asks for a tool on EVERY iteration, so only a bound can stop the loop. */
  function alwaysAsksForATool() {
    const call = vi.fn(async () => ({
      content: "",
      toolCalls: [{ name: "search", args: {}, id: "call-1" }],
      usage: { promptTokens: PROMPT_TOKENS, completionTokens: COMPLETION_TOKENS },
    }));
    const provider: LLMProvider = { name: "mock", call };
    return { provider, call };
  }

  /** A tool registry whose single tool counts its own dispatches. */
  async function registryCountingDispatches(counter: { n: number }): Promise<ToolRegistry> {
    const provider: ToolProvider = {
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "search", description: "search", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => {
        counter.n += 1;
        return { content: "results", isError: false };
      },
      disconnect: async () => {},
    };
    const tools = new ToolRegistry();
    await tools.addProvider(provider);
    return tools;
  }

  it("VT-12 (#116): an over-budget tool loop stops inside the loop and ends on COST_EXCEEDED", async () => {
    const { provider, call } = alwaysAsksForATool();
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const dispatches = { n: 0 };
    const tools = await registryCountingDispatches(dispatches);

    const req = createRunRequest();
    req.agentConfig.model = { provider: "mock", name: MODEL };
    // Ceiling between the 2nd and 3rd iteration's cumulative spend, derived from
    // the price table so a repricing moves the scenario rather than voiding it.
    req.agentConfig.environment.max_cost =
      estimateCost(MODEL, PROMPT_TOKENS, COMPLETION_TOKENS) * 2.5;

    const events = await collect(
      runAgentLoop({
        request: req,
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );

    // Same terminus as before this change: same code, same event shape, same
    // message template — the run error the loop already owned.
    const last = events[events.length - 1];
    expect(last.type).toBe("run_error");
    if (last.type === "run_error") {
      expect(last.error.code).toBe("COST_EXCEEDED");
      expect(last.error.message).toMatch(/exceeded the configured max_cost/);
      expect(last.run_id).toBe("test-run-id");
    }
    expect(events.some((e) => e.type === "run_complete")).toBe(false);

    // The load-bearing assertion: it stopped WHILE looping, not after.
    expect(call.mock.calls.length).toBeLessThan(MAX_TOOL_ITERATIONS);
    expect(call).toHaveBeenCalledTimes(3);
    // And no tool was dispatched for the iteration that tipped over.
    expect(dispatches.n).toBe(2);
  });

  it("RT-9 (#116): with no max_cost the tool loop is bounded only by its iteration count", async () => {
    const { provider, call } = alwaysAsksForATool();
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const dispatches = { n: 0 };
    const tools = await registryCountingDispatches(dispatches);

    const req = createRunRequest();
    req.agentConfig.model = { provider: "mock", name: MODEL };
    req.agentConfig.environment.max_cost = undefined;

    const events = await collect(
      runAgentLoop({
        request: req,
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );

    expect(call).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    expect(dispatches.n).toBe(MAX_TOOL_ITERATIONS);
    expect(events.some((e) => e.type === "run_error")).toBe(false);
    expect(events.some((e) => e.type === "run_complete")).toBe(true);
  });
});

describe("withHeartbeats helper", () => {
  it("yields periodic heartbeats then returns the resolved value", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("done"), 220));
    const gen = withHeartbeats(slow, "uploading_outputs", "run-1", 50);

    const events: unknown[] = [];
    let result: string | undefined;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(result).toBe("done");
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect((e as { type: string }).type).toBe("run_heartbeat");
      expect((e as { stage: string }).stage).toBe("uploading_outputs");
    }
  });

  it("propagates a rejected promise as a thrown error", async () => {
    const failing = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("upload failed")), 50),
    );
    const gen = withHeartbeats(failing, "uploading_outputs", "run-1", 20);
    await expect(collectStringValues(gen)).rejects.toThrow("upload failed");
  });
});

async function collectStringValues<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}
