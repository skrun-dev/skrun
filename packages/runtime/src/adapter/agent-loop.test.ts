import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_RESPONSE_MAX_BYTES, TOOL_RESULT_TRUNCATION_MARKER } from "../files/output-rules.js";
import { estimateCost } from "../llm/cost.js";
import type {
  HistoryEntry,
  LLMCallRequest,
  LLMCallResponse,
  LLMProvider,
} from "../llm/providers/types.js";
import { LLMRouter, type LLMRouterResponse } from "../llm/router.js";
import { createLogger, type Logger } from "../logger.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "../tools/types.js";
import type { RunEvent, RunRequest } from "../types.js";
import { runAgentLoop, withHeartbeats } from "./agent-loop.js";
import { RUN_TOOL_RESULTS_MAX_BYTES, TOOL_RESULT_NOT_KEPT_MARKER } from "./tool-results-budget.js";

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

describe("runAgentLoop — events leave while the model call is in flight", () => {
  /**
   * Drive the loop and note, for each event, whether `pending()` held when the
   * event reached the consumer — the moment of reception, not a count taken
   * once the run is over.
   */
  async function receive(
    router: LLMRouter,
    tools: ToolRegistry,
    pending: () => boolean,
  ): Promise<Array<{ type: string; stage?: string; whilePending: boolean }>> {
    const received: Array<{ type: string; stage?: string; whilePending: boolean }> = [];
    for await (const event of runAgentLoop({
      request: createRunRequest(),
      router,
      tools,
      logger: createLogger("test"),
      startMs: Date.now(),
      heartbeatIntervalMs: 40,
    })) {
      received.push({
        type: event.type,
        ...(event.type === "run_heartbeat" && { stage: event.stage }),
        whilePending: pending(),
      });
    }
    return received;
  }

  it("a waiting_llm heartbeat reaches the consumer before the model call returns", async () => {
    let callPending = false;
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => {
        callPending = true;
        await new Promise((r) => setTimeout(r, 300));
        callPending = false;
        return { content: '{"result":"ok"}', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);

    const received = await receive(router, new ToolRegistry(), () => callPending);

    const beats = received.filter((e) => e.type === "run_heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.filter((e) => e.whilePending).length).toBeGreaterThanOrEqual(1);
    expect(received.at(-1)?.type).toBe("run_complete");
  });

  it("tool_call reaches the consumer while the tool still runs, and the order is kept", async () => {
    let toolRunning = false;
    const slowTool: ToolProvider = {
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "slow", description: "slow tool", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => {
        toolRunning = true;
        await new Promise((r) => setTimeout(r, 250));
        toolRunning = false;
        return { content: "done", isError: false };
      },
      disconnect: async () => {},
    };
    let iteration = 0;
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => {
        iteration += 1;
        if (iteration === 1) {
          return {
            content: "",
            toolCalls: [{ name: "slow", args: {}, id: "call-1" }],
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return { content: '{"result":"ok"}', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const tools = new ToolRegistry();
    await tools.addProvider(slowTool);

    const received = await receive(router, tools, () => toolRunning);

    expect(received.find((e) => e.type === "tool_call")?.whilePending).toBe(true);
    expect(
      received.some(
        (e) => e.type === "run_heartbeat" && e.stage === "waiting_tool" && e.whilePending,
      ),
    ).toBe(true);
    const order = received.map((e) => e.type).filter((t) => t !== "run_heartbeat");
    expect(order).toEqual(["tool_call", "tool_result", "llm_complete", "run_complete"]);
  });

  it("a heartbeat reaches the consumer before the repair call returns", async () => {
    let repairPending = false;
    let call = 0;
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async () => {
        call += 1;
        // The first answer misses the declared output: the loop asks for a repair.
        if (call === 1) {
          return { content: '{"other":1}', usage: { promptTokens: 1, completionTokens: 1 } };
        }
        repairPending = true;
        await new Promise((r) => setTimeout(r, 300));
        repairPending = false;
        return { content: '{"result":"ok"}', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);

    const received = await receive(router, new ToolRegistry(), () => repairPending);

    expect(received.some((e) => e.type === "output_validation_warning")).toBe(true);
    expect(
      received.filter((e) => e.type === "run_heartbeat" && e.whilePending).length,
    ).toBeGreaterThanOrEqual(1);
    expect(received.at(-1)?.type).toBe("run_complete");
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

// The parser's message quotes the start of the text it choked on — here, the
// model's output. The log line says a fixed reason and the error's class; the
// caller's run_error keeps the message, as it always has.
describe("runAgentLoop — a repair retry that cannot be parsed", () => {
  function retryRun(retryContent: string) {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"other": "value"}',
        usage: { promptTokens: 1, completionTokens: 1 },
      })
      .mockResolvedValueOnce({
        content: retryContent,
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const lines: unknown[][] = [];
    const keep = (...args: unknown[]) => {
      lines.push(args);
    };
    const logger = { error: keep, warn: keep, info: keep, debug: keep } as unknown as Logger;
    const events = collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools: new ToolRegistry(),
        logger,
        startMs: Date.now(),
      }),
    );
    const line = () =>
      lines.find(
        ([fields]) =>
          (fields as { event?: string } | undefined)?.event === "output_retry_parse_failed",
      );
    return { events, line };
  }

  it("logs no character of the model's output, and still tells the caller the parser's message", async () => {
    // Short, and where parsing stops: the parser quotes a few characters around
    // that point, so the witness is whole in its message.
    const output = '{"result": wit7c3a}';
    const parserMessage = (() => {
      try {
        JSON.parse(output);
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(parserMessage).toContain("wit7c3a");
    const { events, line } = retryRun(output);

    const last = (await events).at(-1);

    expect(JSON.stringify(line())).not.toContain("wit7c3a");
    expect(line()).toEqual([
      { event: "output_retry_parse_failed", agent: "test-agent", error_name: "SyntaxError" },
      "Retry output was not valid JSON",
    ]);
    expect(last?.type === "run_error" && last.error.message).toBe(
      `Retry output was not valid JSON: ${parserMessage}`,
    );
  });

  it("says a fixed reason, and no error class, when the output holds no JSON object", async () => {
    const { events, line } = retryRun("Sorry, I cannot comply.");

    await events;

    expect(line()).toEqual([
      { event: "output_retry_parse_failed", agent: "test-agent" },
      "Retry output did not contain a JSON object",
    ]);
  });
});

describe("runAgentLoop — the JSON object of an answer is found in linear time, at both sites", () => {
  // 128 KiB of "{" and no "}": a pattern that tries each "{" as a start and runs
  // to the end from each takes seconds on it, holding the process the while.
  const BRACES = "{".repeat(128 * 1024);

  function run(...contents: string[]) {
    const call = vi.fn();
    for (const content of contents) {
      call.mockResolvedValueOnce({ content, usage: { promptTokens: 1, completionTokens: 1 } });
    }
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const quiet = () => {};
    const logger = { error: quiet, warn: quiet, info: quiet, debug: quiet } as unknown as Logger;
    const events = collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools: new ToolRegistry(),
        logger,
        startMs: Date.now(),
      }),
    );
    return { call, events };
  }

  it("a first answer of 128 KiB of '{' and no '}' ends the run in under 300 ms", async () => {
    const started = performance.now();
    const { call, events } = run(BRACES);
    const last = (await events).at(-1);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(300);
    expect(call).toHaveBeenCalledTimes(1);
    expect(last?.type).toBe("run_complete");
  }, 30_000);

  it("a repair answer of 128 KiB of '{' and no '}' ends the run in under 300 ms", async () => {
    // The first answer misses the declared output `result`: the repair is asked for.
    const started = performance.now();
    const { call, events } = run('{"other": "value"}', BRACES);
    const last = (await events).at(-1);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(300);
    expect(call).toHaveBeenCalledTimes(2);
    expect(last?.type === "run_error" && last.error.code).toBe("OUTPUT_SCHEMA_INVALID");
  }, 30_000);
});

describe("runAgentLoop — a call the router stopped on a bound ends the run on its code, before its answer is read", () => {
  const STOP = {
    code: "TOO_MANY_TOOL_CALLS" as const,
    message:
      "The model asked for 129 tool calls in one turn; a turn may ask for at most 128. None of them was run.",
  };
  // A stopped answer comes with an empty content; this one carries a valid
  // output as well, so that reading the answer before the stop would show:
  // the text would be parsed, and the run would complete.
  const WITNESS = '{"a":1}';

  const routerAnswer = (overrides: Partial<LLMRouterResponse>): LLMRouterResponse => ({
    content: "",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    estimatedCost: 0,
    provider: "mock",
    model: "mock-model",
    durationMs: 1,
    ...overrides,
  });

  /** A run of a `kv` agent whose one output is `a` (a number), on a router that answers from a script. */
  async function run(...answers: LLMRouterResponse[]) {
    const router = new LLMRouter();
    const call = vi.spyOn(router, "call");
    for (const answer of answers) call.mockResolvedValueOnce(answer);
    const request = createRunRequest();
    request.agentConfig.outputs = [{ name: "a", type: "number", description: "a" }];
    request.agentConfig.state = { type: "kv" };
    const setState = vi.fn(async () => {});
    const parse = vi.spyOn(JSON, "parse");
    try {
      const events = await collect(
        runAgentLoop({
          request,
          router,
          tools: new ToolRegistry(),
          stateCallbacks: { getState: async () => null, setState },
          logger: createLogger("test"),
          startMs: Date.now(),
        }),
      );
      const parsedWitness = parse.mock.calls.some(([text]) => text === WITNESS);
      return { events, call, setState, parsedWitness };
    } finally {
      parse.mockRestore();
    }
  }

  it("the first call: llm_complete, then run_error with the stop's code and message — its text never parsed, no usage, no state handed over", async () => {
    const { events, call, setState, parsedWitness } = await run(
      routerAnswer({ content: WITNESS, stopped: STOP }),
    );

    expect(events.map((e) => e.type)).toEqual(["llm_complete", "run_error"]);
    expect(parsedWitness).toBe(false);
    expect(events[0]).toMatchObject({ type: "llm_complete", provider: "mock", tokens: 15 });
    expect(events[1]).toEqual({
      type: "run_error",
      run_id: "test-run-id",
      timestamp: expect.any(String),
      error: STOP,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(setState).not.toHaveBeenCalled();
  });

  it("the repair call: llm_complete, then run_error with the stop's code and message — its text never parsed, the first answer's state not handed over", async () => {
    const { events, call, setState, parsedWitness } = await run(
      // A first answer whose `a` is not a number: the repair is asked for.
      routerAnswer({ content: '{"a":"one","_state":{"k":1}}' }),
      routerAnswer({ content: WITNESS, stopped: STOP }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "llm_complete",
      "output_validation_warning",
      "llm_complete",
      "run_error",
    ]);
    expect(parsedWitness).toBe(false);
    expect(events[3]).toEqual({
      type: "run_error",
      run_id: "test-run-id",
      timestamp: expect.any(String),
      error: STOP,
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(setState).not.toHaveBeenCalled();
  });

  it("a repair, which runs no tool, whose answer asks for 129 tool calls ends the run on TOO_MANY_TOOL_CALLS, its valid output not read", async () => {
    // A real router: the repair hands it no handler, and the bound holds all the same.
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"other": "value"}',
        usage: { promptTokens: 1, completionTokens: 1 },
      })
      .mockResolvedValueOnce({
        content: '{"result": "ok"}',
        toolCalls: Array.from({ length: 129 }, (_, i) => ({
          name: "lookup",
          args: {},
          id: `call-${i}`,
        })),
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });

    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools: new ToolRegistry(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );

    expect(call).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.type)).toEqual([
      "llm_complete",
      "output_validation_warning",
      "llm_complete",
      "run_error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_error",
      error: {
        code: "TOO_MANY_TOOL_CALLS",
        message:
          "The model asked for 129 tool calls in one turn; a turn may ask for at most 128. None of them was run.",
      },
    });
  });
});

describe("runAgentLoop — each call of the model is handed the run's deadline", () => {
  it("an agent of timeout 7s: the first call and the repair each receive the instant 7 s after the loop's first step, not after the run's start", async () => {
    const NOW = 1_000_000;
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const router = new LLMRouter();
      const call = vi.spyOn(router, "call");
      const answer = (content: string): LLMRouterResponse => ({
        content,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        estimatedCost: 0,
        provider: "mock",
        model: "mock-model",
        durationMs: 1,
      });
      // A first answer whose `result` is not a string: the repair is asked for.
      call.mockResolvedValueOnce(answer('{"result":5}'));
      call.mockResolvedValueOnce(answer('{"result":"ok"}'));
      const request = createRunRequest();
      request.agentConfig.environment.timeout = "7s";

      const events = await collect(
        runAgentLoop({
          request,
          router,
          tools: new ToolRegistry(),
          logger: createLogger("test"),
          // The run started a minute before its loop: on Fly, the machine is
          // acquired in between, and the run's timeout is armed after it.
          startMs: NOW - 60_000,
        }),
      );

      expect(events.map((e) => e.type)).toEqual([
        "llm_complete",
        "output_validation_warning",
        "llm_complete",
        "run_complete",
      ]);
      const deadlines = call.mock.calls.map(
        (args) => (args[11] as { deadline?: number } | undefined)?.deadline,
      );
      expect(deadlines).toEqual([expect.any(Number), expect.any(Number)]);
      for (const deadline of deadlines as number[]) {
        expect(Math.abs(deadline - (NOW + 7_000))).toBeLessThanOrEqual(50);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// The JSON object of a final answer — from its first "{" to its last "}" — is
// held to 1 MiB of UTF-8 before it is parsed, at both sites: the first answer
// and the repair's. Past it nothing is parsed. A text that holds no such
// object is kept as text, whatever its length.
describe("runAgentLoop — the JSON object of the final answer weighs at most 1 MiB before it is parsed, at both sites", () => {
  const MIB = 1024 * 1024;
  const TOO_LARGE = {
    code: "OUTPUT_TOO_LARGE",
    message:
      "The JSON object of the model's final answer is larger than 1 MiB (1048576 bytes), the most an output may weigh before it is parsed. It was not parsed.",
  };

  /**
   * A valid output, `{"result":"…"}`, weighing exactly `bytes` bytes of UTF-8:
   * its padding in "é" (two bytes each, one UTF-16 unit) when `wide`, then
   * plain letters.
   */
  function outputOf(bytes: number, wide = false): string {
    const room = bytes - Buffer.byteLength('{"result":""}');
    const pad = wide ? "é".repeat(Math.floor(room / 2)) + "a".repeat(room % 2) : "a".repeat(room);
    const text = `{"result":"${pad}"}`;
    expect(Buffer.byteLength(text)).toBe(bytes);
    return text;
  }

  /** A run on a real router whose model answers each content in turn; `JSON.parse` watched. */
  async function run(...contents: string[]) {
    const call = vi.fn();
    for (const content of contents) {
      call.mockResolvedValueOnce({ content, usage: { promptTokens: 1, completionTokens: 1 } });
    }
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    // A logger that keeps the fields of every line.
    const logged: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      logged.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    const parse = vi.spyOn(JSON, "parse");
    try {
      const events = await collect(
        runAgentLoop({
          request: createRunRequest(),
          router,
          tools: new ToolRegistry(),
          logger,
          startMs: Date.now(),
        }),
      );
      // Read before the spy is restored: restoring it clears its calls.
      const parsedTexts = parse.mock.calls.map(([arg]) => arg);
      const parsed = (text: string) => parsedTexts.includes(text);
      const refusals = logged.filter((line) => line.event === "model_bound_refused");
      return { events, call, parsed, refusals };
    } finally {
      parse.mockRestore();
    }
  }

  /** The one line a refusal writes: the bound and the object's weight, never a content. */
  const refusalLine = (bytes: number) => ({
    event: "model_bound_refused",
    agent: "test-agent",
    provider: "mock",
    model: "mock-model",
    code: "OUTPUT_TOO_LARGE",
    limit: MIB,
    kept_bytes: bytes,
  });

  it("a first answer whose object weighs 1 MiB exactly, the bound: parsed, and the run's output", async () => {
    const text = outputOf(MIB);
    const { events, parsed, refusals } = await run(text);

    expect(parsed(text)).toBe(true);
    expect(refusals).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["llm_complete", "run_complete"]);
    const last = events.at(-1);
    expect(last?.type === "run_complete" && String(last.output.result).length).toBe(MIB - 13);
  });

  it.each([
    ["in plain letters", false],
    ["in characters of two bytes, under 1 MiB in UTF-16 units", true],
  ])("a first answer whose object weighs 1 MiB + 1 byte, %s: run_error OUTPUT_TOO_LARGE, the object never parsed", async (_what, wide) => {
    const text = outputOf(MIB + 1, wide);
    const { events, parsed, refusals } = await run(text);

    expect(parsed(text)).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["llm_complete", "run_error"]);
    expect(events[1]).toEqual({
      type: "run_error",
      run_id: "test-run-id",
      timestamp: expect.any(String),
      error: TOO_LARGE,
    });
    expect(refusals).toEqual([refusalLine(MIB + 1)]);
  });

  it("a repair whose object weighs 1 MiB exactly: parsed, and the run's output", async () => {
    const text = outputOf(MIB);
    // A first answer that misses the declared output `result`: the repair is asked for.
    const { events, call, parsed } = await run('{"other": "value"}', text);

    expect(call).toHaveBeenCalledTimes(2);
    expect(parsed(text)).toBe(true);
    expect(events.at(-1)?.type).toBe("run_complete");
  });

  it("a repair whose object weighs 1 MiB + 1 byte: run_error OUTPUT_TOO_LARGE, in place of OUTPUT_SCHEMA_INVALID, the object never parsed", async () => {
    const text = outputOf(MIB + 1);
    const { events, call, parsed, refusals } = await run('{"other": "value"}', text);

    expect(call).toHaveBeenCalledTimes(2);
    expect(parsed(text)).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "llm_complete",
      "output_validation_warning",
      "llm_complete",
      "run_error",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run_error", error: TOO_LARGE });
    expect(refusals).toEqual([refusalLine(MIB + 1)]);
  });

  it("a repair whose object weighs 1 MiB + 1 byte in characters of two bytes, under 1 MiB in UTF-16 units: run_error OUTPUT_TOO_LARGE, the object never parsed — the bound counts bytes of UTF-8", async () => {
    const text = outputOf(MIB + 1, true);
    expect(text.length).toBeLessThan(MIB);
    const { events, call, parsed, refusals } = await run('{"other": "value"}', text);

    expect(call).toHaveBeenCalledTimes(2);
    expect(parsed(text)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_error", error: TOO_LARGE });
    expect(refusals).toEqual([refusalLine(MIB + 1)]);
  });

  it("a first answer of 2 MiB of prose and no JSON object: kept as text, whatever its length — the bound is the object's", async () => {
    const prose = "a".repeat(2 * MIB);
    const { events } = await run(prose);

    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: prose } });
  });

  it("2 MiB of prose around an object of 1 MiB exactly: the object alone is weighed, and parsed", async () => {
    const text = outputOf(MIB);
    const { events, parsed } = await run(`${"a".repeat(MIB)}${text}${"z".repeat(MIB)}`);

    expect(parsed(text)).toBe(true);
    expect(events.at(-1)?.type).toBe("run_complete");
  });
});

// One budget per run, handed to the first call and to the repair: what the run
// keeps of its model's answers is held to 4 MiB over both. Each answer weighs
// its turn as the provider returned it, as JSON, in bytes of UTF-8.
describe("runAgentLoop — the model's answers a run keeps weigh at most 4 MiB, the repair included", () => {
  const MIB = 1024 * 1024;
  const BUDGET_MESSAGE =
    "The model's answers in this run weigh more than 4 MiB (4194304 bytes), the most a run keeps of them — each answer counted as the conversation keeps it, as the provider returned it: its text, its reasoning and its tool calls.";
  // 3 MiB of prose and no JSON object: kept as `{ result: <the prose> }`, which
  // the agent below refuses (its `result` is a number) — the repair is asked for.
  const PROSE = "a".repeat(3 * MIB);
  /** A repair answer: `padBytes` bytes of prose, then a valid output. */
  const repairAnswer = (padBytes: number) => `${"b".repeat(padBytes)} {"result": 5}`;

  /** A provider answering each text in turn, the turn carrying the text. */
  function answering(name: string, texts: string[]) {
    const call = vi.fn();
    for (const text of texts) {
      call.mockResolvedValueOnce({
        content: text,
        assistantTurn: { provider: name, content: text },
        usage: { promptTokens: 1, completionTokens: 1 },
      } satisfies LLMCallResponse);
    }
    return call;
  }

  async function run(primaryTexts: string[], withFallback = false) {
    const primary = answering("mock", primaryTexts);
    const fallback = answering("other", ['{"result": 1}', '{"result": 2}']);
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call: primary });
    router.registerProvider("other", { name: "other", call: fallback });
    const request = createRunRequest();
    request.agentConfig.outputs = [{ name: "result", type: "number", description: "result" }];
    if (withFallback) {
      request.agentConfig.model = {
        provider: "mock",
        name: "mock-model",
        fallback: { provider: "other", name: "other-model" },
      } as RunRequest["agentConfig"]["model"];
    }
    const events = await collect(
      runAgentLoop({
        request,
        router,
        tools: new ToolRegistry(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );
    return { events, primary, fallback };
  }

  it("a first answer of 3 MiB, then a repair of 1.5 MiB: the repair is counted on the same budget, and the run ends on MODEL_OUTPUT_BUDGET_EXCEEDED", async () => {
    const { events, primary } = await run([PROSE, repairAnswer(1.5 * MIB)]);

    expect(primary).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.type)).toEqual([
      "llm_complete",
      "output_validation_warning",
      "llm_complete",
      "run_error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_error",
      error: { code: "MODEL_OUTPUT_BUDGET_EXCEEDED", message: BUDGET_MESSAGE },
    });
  });

  it("a first answer of 3 MiB, then a repair of 0.5 MiB: under the bound in all, the repaired output is the run's", async () => {
    const { events, primary } = await run([PROSE, repairAnswer(0.5 * MIB)]);

    expect(primary).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: 5 } });
  });

  it("a repair on a primary that declares a fallback, refused for the budget: the run fails, the fallback never called — the answers come from the model itself", async () => {
    const { events, primary, fallback } = await run([PROSE, repairAnswer(1.5 * MIB)], true);

    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "run_error",
      error: { code: "MODEL_OUTPUT_BUDGET_EXCEEDED", message: BUDGET_MESSAGE },
    });
  });
});

describe("runAgentLoop — the repair retry sends the conversation it asks to fix", () => {
  type Step = Partial<LLMCallResponse> | Error;

  /**
   * A provider that answers from a script, returns each answer as its own
   * native turn, and keeps every request as it was when sent (a clone: the
   * router appending a turn afterwards must not show in an earlier capture).
   */
  function scripted(name: string, steps: Step[]) {
    const requests: LLMCallRequest[] = [];
    let index = 0;
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      requests.push(structuredClone(request));
      const step = steps[index++];
      if (step === undefined) throw new Error(`${name}: called more often than scripted`);
      if (step instanceof Error) throw step;
      return {
        content: step.content ?? "",
        toolCalls: step.toolCalls,
        assistantTurn: step.assistantTurn ?? { provider: name, content: { answer: index } },
        usage: step.usage ?? { promptTokens: 1, completionTokens: 1 },
      };
    });
    const provider: LLMProvider = { name, call };
    return { provider, requests, call };
  }

  /** A registry with one tool, `search`, that answers "results". */
  async function searchTool(): Promise<ToolRegistry> {
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "search", description: "search", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => ({ content: "results", isError: false }),
      disconnect: async () => {},
    });
    return tools;
  }

  function run(router: LLMRouter, tools: ToolRegistry, model = { provider: "mock", name: "m" }) {
    const request = createRunRequest();
    request.agentConfig.model = model;
    return collect(
      runAgentLoop({ request, router, tools, logger: createLogger("test"), startMs: Date.now() }),
    );
  }

  const isRepairMessage = (entry: HistoryEntry | undefined) =>
    entry?.kind === "user" &&
    entry.parts.length === 1 &&
    entry.parts[0].kind === "text" &&
    entry.parts[0].text.startsWith("Your previous JSON output did not match");

  it("the repair request carries the first call's input, every turn with its results, the output to fix, then the repair message; the tools are declared and none may run", async () => {
    const asked = { provider: "mock", content: { label: "asks for a search" } };
    const missed = { provider: "mock", content: { label: "an output that misses the schema" } };
    const { provider, requests } = scripted("mock", [
      {
        toolCalls: [{ name: "search", args: { q: "x" }, id: "call-1" }],
        assistantTurn: asked,
      },
      { content: '{"other": 1}', assistantTurn: missed },
      { content: '{"result": "ok"}' },
    ]);
    const router = new LLMRouter();
    router.registerProvider("mock", provider);

    const events = await run(router, await searchTool());

    expect(requests).toHaveLength(3);
    const repair = requests[2];
    expect(repair.userContent).toEqual(requests[0].userContent);
    expect(repair.history?.slice(0, 3)).toEqual([
      { kind: "assistant", turn: asked },
      { kind: "tool_results", results: [{ name: "search", result: "results", id: "call-1" }] },
      { kind: "assistant", turn: missed },
    ]);
    expect(repair.history).toHaveLength(4);
    expect(isRepairMessage(repair.history?.[3])).toBe(true);
    expect(repair.tools?.map((t) => t.name)).toEqual(["search"]);
    expect(repair.toolChoice).toEqual({ mode: "none" });
    expect(events.at(-1)?.type).toBe("run_complete");
  });

  it("a conversation without a tool turn goes back with no tool declared, though the agent has tools", async () => {
    const { provider, requests } = scripted("mock", [
      { content: '{"other": 1}' },
      { content: '{"result": "ok"}' },
    ]);
    const router = new LLMRouter();
    router.registerProvider("mock", provider);

    await run(router, await searchTool());

    expect(requests[0].tools?.map((t) => t.name)).toEqual(["search"]);

    expect(requests).toHaveLength(2);
    expect(requests[1].history).toHaveLength(2);
    expect(requests[1].history?.[0].kind).toBe("assistant");
    expect(isRepairMessage(requests[1].history?.[1])).toBe(true);
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].toolChoice).toBeUndefined();
  });

  // The repair is asked of the model whose answer it fixes — the primary, or
  // the fallback when it held the first call —, with that model's
  // conversation, and never of a fallback: a fallback would start from the
  // repair message alone, without the input nor the tools' results, and guess.
  const withFallback = {
    provider: "mock",
    name: "m",
    fallback: { provider: "other", name: "f" },
  } as RunRequest["agentConfig"]["model"];

  it("a first call the fallback served, the primary down: the repair is asked of the fallback, with its conversation, never of the primary", async () => {
    const primary = scripted("mock", [new Error("the primary failed")]);
    const asked = { provider: "other", content: { label: "fallback asks" } };
    const missed = { provider: "other", content: { label: "an output that misses the schema" } };
    const fallback = scripted("other", [
      { toolCalls: [{ name: "search", args: {}, id: "call-1" }], assistantTurn: asked },
      { content: '{"other": 1}', assistantTurn: missed },
      { content: '{"result": "ok"}' },
    ]);
    const router = new LLMRouter();
    router.registerProvider("mock", primary.provider);
    router.registerProvider("other", fallback.provider);

    const events = await run(router, await searchTool(), withFallback);

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(3);
    const repair = fallback.requests[2];
    expect(repair.userContent).toEqual(fallback.requests[0].userContent);
    expect(repair.history?.slice(0, 3)).toEqual([
      { kind: "assistant", turn: asked },
      { kind: "tool_results", results: [{ name: "search", result: "results", id: "call-1" }] },
      { kind: "assistant", turn: missed },
    ]);
    expect(isRepairMessage(repair.history?.[3])).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "ok" } });
  });

  it("the primary answered, its tools ran, and its repair fails: the run fails on that error, the fallback never called", async () => {
    const primary = scripted("mock", [
      { toolCalls: [{ name: "search", args: {}, id: "call-1" }] },
      { content: '{"other": 1}' },
      new Error("the primary's repair failed"),
    ]);
    const fallback = scripted("other", [{ content: '{"result": "a guess of the fallback"}' }]);
    const router = new LLMRouter();
    router.registerProvider("mock", primary.provider);
    router.registerProvider("other", fallback.provider);

    await expect(run(router, await searchTool(), withFallback)).rejects.toThrow(
      "the primary's repair failed",
    );
    expect(primary.requests).toHaveLength(3);
    expect(fallback.requests).toHaveLength(0);
  });

  it("the primary answered without a tool, and its repair fails: the run fails on that error, the fallback never called", async () => {
    const primary = scripted("mock", [
      { content: '{"other": 1}' },
      new Error("the primary's repair failed"),
    ]);
    const fallback = scripted("other", [{ content: '{"result": "a guess of the fallback"}' }]);
    const router = new LLMRouter();
    router.registerProvider("mock", primary.provider);
    router.registerProvider("other", fallback.provider);

    await expect(run(router, await searchTool(), withFallback)).rejects.toThrow(
      "the primary's repair failed",
    );
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(0);
  });

  describe("the model a repair is asked of, beside a primary behind a base_url", () => {
    // A fallback of the same provider and model as a primary behind the
    // agent's `base_url`: only the destination the conversation was held with
    // tells which of the two answered.
    const model = {
      provider: "openai",
      name: "same-model",
      base_url: "http://127.0.0.1:9/v1",
      fallback: { provider: "openai", name: "same-model" },
    } as RunRequest["agentConfig"]["model"];

    async function repairModelAfter(baseUrl: string | undefined) {
      const router = new LLMRouter();
      const call = vi.spyOn(router, "call");
      const answer = (content: string): LLMRouterResponse => ({
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCost: 0,
        provider: "openai",
        model: "same-model",
        durationMs: 1,
        history: {
          provider: "openai",
          model: "same-model",
          ...(baseUrl !== undefined && { baseUrl }),
          input: [{ kind: "text", text: "Input: {}" }],
          entries: [],
        },
      });
      call.mockResolvedValueOnce(answer('{"other": 1}'));
      call.mockResolvedValueOnce(answer('{"result": "ok"}'));
      const request = createRunRequest();
      request.agentConfig.model = model;
      const events = await collect(
        runAgentLoop({
          request,
          router,
          tools: new ToolRegistry(),
          logger: createLogger("test"),
          startMs: Date.now(),
        }),
      );
      expect(events.at(-1)?.type).toBe("run_complete");
      expect(call).toHaveBeenCalledTimes(2);
      return call.mock.calls[1][0];
    }

    it("the fallback answered: the repair goes to its provider's own API — no base_url —, with no fallback", async () => {
      const repairModel = await repairModelAfter(undefined);
      expect(repairModel).toMatchObject({ provider: "openai", name: "same-model" });
      expect(repairModel).not.toHaveProperty("base_url");
      expect(repairModel).not.toHaveProperty("fallback");
    });

    it("the primary answered: the repair goes to its base_url, with no fallback", async () => {
      const repairModel = await repairModelAfter("http://127.0.0.1:9/v1");
      expect(repairModel).toMatchObject({
        provider: "openai",
        name: "same-model",
        base_url: "http://127.0.0.1:9/v1",
      });
      expect(repairModel).not.toHaveProperty("fallback");
    });
  });

  it("a conversation the iteration bound ended on tool results: the repair message comes after them", async () => {
    const steps: Step[] = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ name: "search", args: {}, id: `call-${i}` }],
    }));
    steps.push({ content: '{"result": "ok"}' });
    const { provider, requests } = scripted("mock", steps);
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const request = createRunRequest();
    request.agentConfig.model = { provider: "mock", name: "m" };
    // An output the placeholder text cannot satisfy, so the bound leads to a repair.
    request.agentConfig.outputs = [{ name: "count", type: "number", description: "count" }];

    await collect(
      runAgentLoop({
        request,
        router,
        tools: await searchTool(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );

    expect(requests).toHaveLength(11);
    const history = requests[10].history ?? [];
    expect(history).toHaveLength(21);
    expect(history.at(-2)?.kind).toBe("tool_results");
    expect(isRepairMessage(history.at(-1))).toBe(true);
    expect(requests[10].toolChoice).toEqual({ mode: "none" });
  });
});

describe("runAgentLoop — run events keep their order and their shape over a multi-turn run", () => {
  it("two tool turns, an output repaired with the conversation: tool_call, tool_result, llm_complete and the heartbeats come out as before, each with its own keys", async () => {
    const pause = () => new Promise((r) => setTimeout(r, 120));
    let turn = 0;
    const provider: LLMProvider = {
      name: "mock",
      call: vi.fn(async (): Promise<LLMCallResponse> => {
        turn += 1;
        await pause();
        const usage = { promptTokens: 1, completionTokens: 1 };
        const assistantTurn = { provider: "mock", content: { turn } };
        if (turn <= 2) {
          return {
            content: "",
            toolCalls: [{ name: "slow", args: { n: turn }, id: `call-${turn}` }],
            assistantTurn,
            usage,
          };
        }
        // The third answer misses the declared output; the repair (fourth) fits.
        return {
          content: turn === 3 ? '{"other": 1}' : '{"result": "ok"}',
          assistantTurn,
          usage,
        };
      }),
    };
    const router = new LLMRouter();
    router.registerProvider("mock", provider);
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "slow", description: "slow", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => {
        await pause();
        return { content: "done", isError: false };
      },
      disconnect: async () => {},
    });

    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
        heartbeatIntervalMs: 40,
      }),
    );

    expect(events.filter((e) => e.type !== "run_heartbeat").map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "llm_complete",
      "output_validation_warning",
      "llm_complete",
      "run_complete",
    ]);
    const keys = (type: string) =>
      events.filter((e) => e.type === type).map((e) => Object.keys(e).sort());
    expect(keys("tool_call")).toEqual(
      Array(2).fill(["args", "run_id", "timestamp", "tool", "type"]),
    );
    expect(keys("tool_result")).toEqual(
      Array(2).fill(["is_error", "result", "run_id", "timestamp", "tool", "type"]),
    );
    expect(keys("llm_complete")).toEqual(
      Array(2).fill(["model", "provider", "run_id", "timestamp", "tokens", "type"]),
    );
    expect(events.filter((e) => e.type === "tool_call")).toMatchObject([
      { tool: "slow", args: { n: 1 } },
      { tool: "slow", args: { n: 2 } },
    ]);

    // Heartbeats: their four keys; a tool's beats only inside its call, between
    // the tool_call and its tool_result (the model's beats run all along the
    // outer call, tools included).
    const beats = events.filter((e) => e.type === "run_heartbeat");
    expect(beats.length).toBeGreaterThan(0);
    for (const beat of beats) {
      expect(Object.keys(beat).sort()).toEqual(["run_id", "stage", "timestamp", "type"]);
    }
    let inTool = false;
    for (const e of events) {
      if (e.type === "tool_call") inTool = true;
      if (e.type === "tool_result") inTool = false;
      if (e.type === "run_heartbeat" && e.stage === "waiting_tool") expect(inTool).toBe(true);
    }
    expect(beats.some((e) => e.type === "run_heartbeat" && e.stage === "waiting_tool")).toBe(true);
    expect(beats.some((e) => e.type === "run_heartbeat" && e.stage === "waiting_llm")).toBe(true);
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

  it("yields each heartbeat while the promise is still pending, not once it settles", async () => {
    let pending = true;
    const slow = new Promise<string>((r) =>
      setTimeout(() => {
        pending = false;
        r("done");
      }, 220),
    );
    const gen = withHeartbeats(slow, "acquiring_runner", "run-1", 50);

    const whilePending: boolean[] = [];
    while (!(await gen.next()).done) whilePending.push(pending);

    expect(whilePending.filter(Boolean).length).toBeGreaterThanOrEqual(2);
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

// `JSON.parse` makes a key named `__proto__` a field of its own; assigned to a
// copy, that key sets the copy's prototype instead, and the field leaves the
// prompt. The loop's copy of the input defines each key, so it stays one.
describe("runAgentLoop — an input field named __proto__ reaches the prompt as any other", () => {
  /** The first message the model is sent, for `input` and the agent's declared `inputs`. */
  async function firstMessage(
    input: Record<string, unknown>,
    inputs: RunRequest["agentConfig"]["inputs"] = [],
  ): Promise<string> {
    const sent: string[] = [];
    const router = new LLMRouter();
    router.registerProvider("mock", {
      name: "mock",
      call: vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
        const first = request.userContent[0];
        sent.push(first?.kind === "text" ? first.text : "");
        return { content: '{"result":"ok"}', usage: { promptTokens: 1, completionTokens: 1 } };
      }),
    });
    const request = createRunRequest({ input });
    request.agentConfig.inputs = inputs;
    const events = await collect(
      runAgentLoop({
        request,
        router,
        tools: new ToolRegistry(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );
    expect(events.at(-1)?.type).toBe("run_complete");
    return sent[0]?.split("\n")[0] ?? "";
  }

  it("an input read from JSON that carries a __proto__ field the agent does not declare: the prompt carries it, with its value", async () => {
    const input = JSON.parse('{"q":"hi","__proto__":{"k":1},"p2":"x"}');
    // The case's premise: the field is the input's own.
    expect(Object.hasOwn(input, "__proto__")).toBe(true);

    expect(await firstMessage(input)).toBe('Input: {"q":"hi","__proto__":{"k":1},"p2":"x"}');
  });

  it("a required input the agent declares as __proto__: the prompt carries it, with its value", async () => {
    const input = JSON.parse('{"__proto__":{"k":1}}');

    expect(await firstMessage(input, [{ name: "__proto__", type: "object", required: true }])).toBe(
      'Input: {"__proto__":{"k":1}}',
    );
  });
});

describe("runAgentLoop — the state is written only by a run that succeeds", () => {
  const PRICED_MODEL = "claude-sonnet-4-6";
  const CHEAP = { promptTokens: 1, completionTokens: 1 };
  const COSTLY = { promptTokens: 1_000_000, completionTokens: 100_000 };

  /**
   * A stateful run whose model answers from `answers`, one per call. Each write
   * the loop makes is recorded, with the type of the last event the consumer had
   * received when it happened.
   */
  async function statefulRun(
    answers: Array<{ content: string; usage?: { promptTokens: number; completionTokens: number } }>,
    { maxCost = 1.0 }: { maxCost?: number } = {},
  ) {
    const call = vi.fn();
    for (const answer of answers) {
      call.mockResolvedValueOnce({ content: answer.content, usage: answer.usage ?? CHEAP });
    }
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const req = createRunRequest();
    req.agentConfig.model = { provider: "mock", name: PRICED_MODEL };
    req.agentConfig.environment.max_cost = maxCost;
    req.agentConfig.state = { type: "kv", scope: "per_caller", ttl: "30d" };

    const events: RunEvent[] = [];
    const writes: Array<{ state: Record<string, unknown>; afterEvent: string | undefined }> = [];
    const stateCallbacks = {
      getState: vi.fn(async () => ({ previous: true })),
      setState: vi.fn(async (_name: string, state: Record<string, unknown>) => {
        writes.push({ state, afterEvent: events.at(-1)?.type });
      }),
    };
    for await (const event of runAgentLoop({
      request: req,
      router,
      tools: new ToolRegistry(),
      stateCallbacks,
      logger: createLogger("test"),
      startMs: Date.now(),
    })) {
      events.push(event);
    }
    return { events, writes, last: events.at(-1) };
  }

  it("a run that completes writes the state of its answer, before run_complete leaves", async () => {
    const { writes, last } = await statefulRun([
      { content: '{"result":"ok","_state":{"step":1}}' },
    ]);

    expect(last?.type).toBe("run_complete");
    expect(writes).toEqual([{ state: { step: 1 }, afterEvent: "llm_complete" }]);
    // The state is never part of the output.
    expect(last?.type === "run_complete" && JSON.stringify(last.output)).toBe('{"result":"ok"}');
  });

  it("a run over its max_cost after the first answer writes nothing", async () => {
    const { writes, last } = await statefulRun(
      [{ content: '{"result":"ok","_state":{"step":1}}', usage: COSTLY }],
      { maxCost: 0.01 },
    );

    expect(last?.type === "run_error" && last.error.code).toBe("COST_EXCEEDED");
    expect(writes).toEqual([]);
  });

  it("a run over its max_cost after the repair writes nothing", async () => {
    const { writes, last } = await statefulRun(
      [
        { content: '{"other":1,"_state":{"from":"first"}}' },
        { content: '{"result":"ok","_state":{"from":"repair"}}', usage: COSTLY },
      ],
      { maxCost: 0.01 },
    );

    expect(last?.type === "run_error" && last.error.code).toBe("COST_EXCEEDED");
    expect(writes).toEqual([]);
  });

  it("a run whose repaired output still misses the schema writes nothing", async () => {
    const { writes, last } = await statefulRun([
      { content: '{"other":1,"_state":{"from":"first"}}' },
      { content: '{"still":"wrong","_state":{"from":"repair"}}' },
    ]);

    expect(last?.type === "run_error" && last.error.code).toBe("OUTPUT_SCHEMA_INVALID");
    expect(writes).toEqual([]);
  });

  it("a run whose repair is not JSON writes nothing", async () => {
    const { writes, last } = await statefulRun([
      { content: '{"other":1,"_state":{"from":"first"}}' },
      { content: "Sorry, I cannot comply." },
    ]);

    expect(last?.type === "run_error" && last.error.code).toBe("OUTPUT_SCHEMA_INVALID");
    expect(writes).toEqual([]);
  });

  it("a repaired run writes the state of the repaired answer, not of the refused one", async () => {
    const { writes, last } = await statefulRun([
      { content: '{"other":1,"_state":{"from":"first"}}' },
      { content: '{"result":"ok","_state":{"from":"repair"}}' },
    ]);

    expect(last?.type).toBe("run_complete");
    expect(writes).toEqual([{ state: { from: "repair" }, afterEvent: "llm_complete" }]);
    expect(last?.type === "run_complete" && JSON.stringify(last.output)).toBe('{"result":"ok"}');
  });

  it("a repaired run whose repaired answer carries no state keeps the state of the first answer", async () => {
    // The repair fixes the output's format; the run succeeded, and the state the
    // model gave in its first answer is still the run's.
    const { writes, last } = await statefulRun([
      { content: '{"other":1,"_state":{"from":"first"}}' },
      { content: '{"result":"ok"}' },
    ]);

    expect(last?.type).toBe("run_complete");
    expect(writes).toEqual([{ state: { from: "first" }, afterEvent: "llm_complete" }]);
  });
});

// The `_state` an answer carries is set aside from its output, always. The one a
// run would hand over — an agent of type kv, run with its state callbacks — is
// judged with that output, one validation of what the model returned: a JSON
// object nested at most 100 levels deep, or no state (absent, null, "", 0,
// false). Anything else is an issue of the output: the warning, the one repair,
// then OUTPUT_SCHEMA_INVALID, and nothing handed over. Any other agent sets its
// `_state` aside, whatever it is.
describe("runAgentLoop — the state a run hands over is an object of at most 100 levels, judged with its output", () => {
  /** `{"n":{"n":…1}}`, `levels` levels deep, the state itself the first. */
  const stateOfDepth = (levels: number) => `${'{"n":'.repeat(levels)}1${"}".repeat(levels)}`;
  /** An answer whose output is valid, carrying `state` (raw JSON) as its `_state`. */
  const answer = (state: string, output = '"result":"x"') => `{${output},"_state":${state}}`;

  const TOO_DEEP =
    '"_state" is nested more than 100 levels deep (the state itself is the first level; each object or array inside another is one more).';
  const notAnObject = (got: string) =>
    `"_state" must be a JSON object of keys and values, or null for no state — got ${got}.`;
  const REPAIR_RULE =
    'The "_state" field must be a JSON object of keys and values, nested at most 100 levels deep, or null to save no state.';

  /**
   * A run whose model answers from `answers`, one per call: an agent of type
   * kv run with its state callbacks, unless told otherwise. A call past them —
   * a repair the case does not expect — gets a valid answer that carries no
   * state, so that a case fails on its own assertions (the calls made, the
   * run's end), never on an answer missing from its script.
   */
  async function stateRun(
    answers: string[],
    {
      kind = "kv",
      callbacks = true,
      outputs,
    }: {
      kind?: "kv" | "none";
      callbacks?: boolean;
      outputs?: RunRequest["agentConfig"]["outputs"];
    } = {},
  ) {
    const call = vi.fn();
    for (const content of answers) {
      call.mockResolvedValueOnce({ content, usage: { promptTokens: 1, completionTokens: 1 } });
    }
    call.mockResolvedValue({
      content: '{"result":"x"}',
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const request = createRunRequest();
    request.agentConfig.state =
      kind === "kv" ? { type: "kv", scope: "per_caller", ttl: "30d" } : { type: "none" };
    if (outputs) request.agentConfig.outputs = outputs;
    const setState = vi.fn(async (_name: string, _state: Record<string, unknown>) => {});
    const events = await collect(
      runAgentLoop({
        request,
        router,
        tools: new ToolRegistry(),
        ...(callbacks ? { stateCallbacks: { getState: async () => null, setState } } : {}),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );
    return { events, call, setState, last: events.at(-1) };
  }

  /** The repair message the model was sent, on its second call. */
  function repairMessage(call: ReturnType<typeof vi.fn>): string {
    const request = call.mock.calls[1]?.[0] as LLMCallRequest | undefined;
    const parts = [
      ...(request?.userContent ?? []),
      ...(request?.history ?? []).flatMap((entry) => (entry.kind === "user" ? entry.parts : [])),
    ];
    const texts = parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
    return texts.find((text) => text.startsWith("Your previous JSON output")) ?? "";
  }

  const warnings = (events: RunEvent[]) =>
    events.filter((e) => e.type === "output_validation_warning");

  /** The output `run_complete` carries, or `undefined`. */
  const outputOf = (last: RunEvent | undefined) =>
    last?.type === "run_complete" ? last.output : undefined;

  it("a state 100 levels deep, the bound: handed over as it is, no repair, and not part of the output", async () => {
    const { events, call, setState, last } = await stateRun([answer(stateOfDepth(100))]);

    expect(call).toHaveBeenCalledOnce();
    expect(warnings(events)).toEqual([]);
    expect(last?.type).toBe("run_complete");
    expect(setState).toHaveBeenCalledOnce();
    expect(setState.mock.calls[0]?.[1]).toEqual(JSON.parse(stateOfDepth(100)));
    expect(outputOf(last)).toEqual({ result: "x" });
    expect(Object.hasOwn(outputOf(last) ?? {}, "_state")).toBe(false);
  });

  it("a state 101 levels deep: the warning and the repair name the state and the bound, the repair still that deep ends on OUTPUT_SCHEMA_INVALID, and nothing is handed over", async () => {
    const { events, call, setState, last } = await stateRun([
      answer(stateOfDepth(101)),
      answer(stateOfDepth(101)),
    ]);

    expect(warnings(events)).toEqual([
      expect.objectContaining({
        errors: [{ code: "custom", path: ["_state"], message: TOO_DEEP }],
      }),
    ]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(repairMessage(call)).toContain(JSON.stringify(TOO_DEEP));
    expect(repairMessage(call)).toContain(REPAIR_RULE);
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
    expect(last).toMatchObject({
      type: "run_error",
      error: {
        code: "OUTPUT_SCHEMA_INVALID",
        message: expect.stringMatching(
          /^Output validation failed after repair retry: .*_state.*nested more than 100 levels deep/,
        ),
      },
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("a state 10,000 levels deep — past what JSON.stringify writes — is refused the same way, and nothing throws", async () => {
    // The case's premise: the state, parsed, cannot be written back as JSON here.
    expect(() => JSON.stringify(JSON.parse(stateOfDepth(10_000)))).toThrow(RangeError);

    const { events, call, setState, last } = await stateRun([
      answer(stateOfDepth(10_000)),
      answer(stateOfDepth(10_000)),
    ]);

    expect(call).toHaveBeenCalledTimes(2);
    expect(warnings(events)).toEqual([
      expect.objectContaining({
        errors: [{ code: "custom", path: ["_state"], message: TOO_DEEP }],
      }),
    ]);
    expect(last).toMatchObject({
      type: "run_error",
      error: { code: "OUTPUT_SCHEMA_INVALID", message: expect.stringContaining("100 levels") },
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("a state 101 levels deep, then a repair that carries no state: refused — the state to hand over would be the first answer's", async () => {
    const { call, setState, last } = await stateRun([answer(stateOfDepth(101)), '{"result":"x"}']);

    expect(call).toHaveBeenCalledTimes(2);
    expect(last).toMatchObject({
      type: "run_error",
      error: { code: "OUTPUT_SCHEMA_INVALID", message: expect.stringContaining("_state") },
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it.each([
    ["null"],
    ['""'],
    ["0"],
    ["false"],
  ])("a state that is not an object, then a repair whose _state is %s: the repair's no state replaces it — run_complete, nothing handed over", async (state) => {
    const { call, setState, last } = await stateRun([answer('"abc"'), answer(state)]);

    expect(call).toHaveBeenCalledTimes(2);
    expect(repairMessage(call)).toContain(REPAIR_RULE);
    expect(last?.type).toBe("run_complete");
    expect(setState).not.toHaveBeenCalled();
    expect(outputOf(last)).toEqual({ result: "x" });
  });

  it("a state that is not an object, then a repair that carries no _state key: the first answer's state stays the one to hand over, and the run ends on OUTPUT_SCHEMA_INVALID", async () => {
    const { call, setState, last } = await stateRun([answer('"abc"'), '{"result":"x"}']);

    expect(call).toHaveBeenCalledTimes(2);
    expect(last).toMatchObject({
      type: "run_error",
      error: { code: "OUTPUT_SCHEMA_INVALID", message: expect.stringContaining("got a string") },
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("a state 100 levels deep on an output that misses the schema, then a repair whose state is 101 levels deep: refused — the state to hand over is the repair's", async () => {
    const { events, call, setState, last } = await stateRun([
      answer(stateOfDepth(100), '"other":1'),
      answer(stateOfDepth(101)),
    ]);

    expect(call).toHaveBeenCalledTimes(2);
    // The first answer's state is not at fault: the warning is the output's alone.
    expect(warnings(events)).toHaveLength(1);
    expect(JSON.stringify(warnings(events))).not.toContain("_state");
    expect(last).toMatchObject({
      type: "run_error",
      error: {
        code: "OUTPUT_SCHEMA_INVALID",
        message: expect.stringContaining(JSON.stringify(TOO_DEEP)),
      },
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("a state 101 levels deep, then a repair whose state is 100 levels deep: the repaired state is handed over, and neither is part of the output", async () => {
    const { call, setState, last } = await stateRun([
      answer(stateOfDepth(101)),
      answer(stateOfDepth(100)),
    ]);

    expect(call).toHaveBeenCalledTimes(2);
    expect(last?.type).toBe("run_complete");
    expect(setState).toHaveBeenCalledOnce();
    expect(setState.mock.calls[0]?.[1]).toEqual(JSON.parse(stateOfDepth(100)));
    expect(outputOf(last)).toEqual({ result: "x" });
    expect(Object.hasOwn(outputOf(last) ?? {}, "_state")).toBe(false);
  });

  it("an agent of type none whose answer carries a state 101 levels deep: run_complete as before, the state set aside, never judged nor handed over", async () => {
    const { events, call, setState, last } = await stateRun([answer(stateOfDepth(101))], {
      kind: "none",
    });

    expect(call).toHaveBeenCalledOnce();
    expect(warnings(events)).toEqual([]);
    expect(last?.type).toBe("run_complete");
    expect(setState).not.toHaveBeenCalled();
    expect(Object.hasOwn(outputOf(last) ?? {}, "_state")).toBe(false);
  });

  it("an agent of type kv run without state callbacks: a state 101 levels deep is set aside, never judged", async () => {
    const { events, call, last } = await stateRun([answer(stateOfDepth(101))], {
      callbacks: false,
    });

    expect(call).toHaveBeenCalledOnce();
    expect(warnings(events)).toEqual([]);
    expect(last?.type).toBe("run_complete");
    expect(Object.hasOwn(outputOf(last) ?? {}, "_state")).toBe(false);
  });

  it.each([
    ['"abc"', "a string"],
    ["[1,2]", "an array"],
    ["[]", "an array"],
    ["5", "a number"],
    ["true", "a boolean"],
  ])("a state that is not an object, %s: the warning and the repair name its shape, the repair still so ends on OUTPUT_SCHEMA_INVALID, and nothing is handed over", async (state, got) => {
    const { events, call, setState, last } = await stateRun([answer(state), answer(state)]);

    expect(warnings(events)).toEqual([
      expect.objectContaining({
        errors: [{ code: "custom", path: ["_state"], message: notAnObject(got) }],
      }),
    ]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(repairMessage(call)).toContain(REPAIR_RULE);
    expect(last).toMatchObject({
      type: "run_error",
      error: { code: "OUTPUT_SCHEMA_INVALID", message: expect.stringContaining(`got ${got}`) },
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it.each([
    ['""'],
    ["0"],
    ["false"],
    ["null"],
  ])("a state that is an empty value, %s: no state — run_complete, nothing handed over, and the output without it", async (state) => {
    const { events, call, setState, last } = await stateRun([answer(state)]);

    expect(call).toHaveBeenCalledOnce();
    expect(warnings(events)).toEqual([]);
    expect(last?.type).toBe("run_complete");
    expect(setState).not.toHaveBeenCalled();
    expect(outputOf(last)).toEqual({ result: "x" });
    expect(Object.hasOwn(outputOf(last) ?? {}, "_state")).toBe(false);
  });

  it("an answer that carries no state: run_complete, nothing handed over", async () => {
    const { call, setState, last } = await stateRun(['{"result":"x"}']);

    expect(call).toHaveBeenCalledOnce();
    expect(last?.type).toBe("run_complete");
    expect(setState).not.toHaveBeenCalled();
    expect(outputOf(last)).toEqual({ result: "x" });
  });

  it("a loop handed no declared output: a state 101 levels deep takes the same path, and ends on OUTPUT_SCHEMA_INVALID", async () => {
    const { events, call, setState, last } = await stateRun(
      [answer(stateOfDepth(101), '"any":1'), answer(stateOfDepth(101), '"any":1')],
      { outputs: [] },
    );

    expect(warnings(events)).toEqual([
      expect.objectContaining({
        errors: [{ code: "custom", path: ["_state"], message: TOO_DEEP }],
      }),
    ]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(last).toMatchObject({ type: "run_error", error: { code: "OUTPUT_SCHEMA_INVALID" } });
    expect(setState).not.toHaveBeenCalled();
  });

  it("a loop handed no declared output: a state 100 levels deep is handed over, and the output is the answer's", async () => {
    const { call, setState, last } = await stateRun([answer(stateOfDepth(100), '"any":1')], {
      outputs: [],
    });

    expect(call).toHaveBeenCalledOnce();
    expect(last?.type).toBe("run_complete");
    expect(setState).toHaveBeenCalledOnce();
    expect(outputOf(last)).toEqual({ any: 1 });
  });
});

// The schema of an `object` output accepts any shape inside, and JSON.parse any
// depth: an output nested deeper than the bound is refused as an invalid output
// is — the warning, the one repair, then OUTPUT_SCHEMA_INVALID —, its depth
// measured without recursion, so that no output makes the loop throw.
describe("runAgentLoop — an output nested deeper than the bound is an invalid output", () => {
  /** The model's answer: `{"answer":{"n":{"n":…1}}}`, `levels` levels deep, the output itself the first. */
  const nestedAnswer = (levels: number) =>
    `{"answer":${'{"n":'.repeat(levels - 1)}1${"}".repeat(levels - 1)}}`;

  /** A run of an agent whose one output is an `object`, its model answering from `answers`, one per call. */
  async function deepRun(answers: string[]) {
    const call = vi.fn();
    for (const content of answers) {
      call.mockResolvedValueOnce({ content, usage: { promptTokens: 1, completionTokens: 1 } });
    }
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const request = createRunRequest();
    request.agentConfig.outputs = [{ name: "answer", type: "object" }];
    const events = await collect(
      runAgentLoop({
        request,
        router,
        tools: new ToolRegistry(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );
    return { events, call, last: events.at(-1) };
  }

  const DEPTH_ISSUE = {
    code: "custom",
    path: [],
    message: expect.stringContaining("nested more than 100 levels deep"),
  };

  it("an output 100 levels deep is accepted as it is: run_complete carries it, no repair", async () => {
    const { events, call, last } = await deepRun([nestedAnswer(100)]);

    expect(call).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === "output_validation_warning")).toBe(false);
    expect(last?.type).toBe("run_complete");
    expect(last?.type === "run_complete" && last.output).toEqual(JSON.parse(nestedAnswer(100)));
  });

  it("an output 101 levels deep is refused: the warning and the repair name the bound, and the repair still that deep ends on OUTPUT_SCHEMA_INVALID, whose message names it too", async () => {
    const { events, call, last } = await deepRun([nestedAnswer(101), nestedAnswer(101)]);

    expect(events.filter((e) => e.type === "output_validation_warning")).toEqual([
      expect.objectContaining({ errors: [DEPTH_ISSUE] }),
    ]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(call.mock.calls[1]?.[0])).toContain("nested more than 100 levels deep");
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
    expect(last).toMatchObject({
      type: "run_error",
      error: {
        code: "OUTPUT_SCHEMA_INVALID",
        message: expect.stringMatching(
          /^Output validation failed after repair retry: .*nested more than 100 levels deep/,
        ),
      },
    });
  });

  it("an output 101 levels deep whose repair passes: run_complete carries the repaired output", async () => {
    const { events, call, last } = await deepRun([nestedAnswer(101), '{"answer":{"n":1}}']);

    expect(call).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "output_validation_warning")).toHaveLength(1);
    expect(last?.type === "run_complete" && last.output).toEqual({ answer: { n: 1 } });
  });

  it("an output 10,000 levels deep — past what JSON.stringify writes — is refused the same way, and nothing throws", async () => {
    // The case's premise: the model's answer, parsed, cannot be written back as JSON here.
    expect(() => JSON.stringify(JSON.parse(nestedAnswer(10_000)))).toThrow(RangeError);

    const { events, call, last } = await deepRun([nestedAnswer(10_000), nestedAnswer(10_000)]);

    expect(call).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "output_validation_warning")).toEqual([
      expect.objectContaining({ errors: [DEPTH_ISSUE] }),
    ]);
    expect(last).toMatchObject({
      type: "run_error",
      error: { code: "OUTPUT_SCHEMA_INVALID", message: expect.stringContaining("100 levels") },
    });
  });
});

// A model's tool arguments are parsed at any depth, and an endpoint an agent
// declares answers what it likes: arguments nested thousands of levels deep
// went to the tool as they were, and the tool_call event that carried them
// could not be written to a stream. Past the bound, the tool is not called,
// the model gets an error result — the path of any tool error — and the event
// carries a mention in place of the arguments.
describe("runAgentLoop — a tool call whose arguments are nested deeper than the bound", () => {
  /** Arguments `{"q":[[…]]}`, `levels` levels deep, the arguments themselves the first. */
  const argsOfDepth = (levels: number): Record<string, unknown> =>
    JSON.parse(`{"q":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`);

  /**
   * A run whose model first asks for `lookup` with `args`, then answers;
   * every request the model receives kept as it was sent.
   */
  async function toolRun(args: Record<string, unknown>) {
    const requests: LLMCallRequest[] = [];
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? {
            content: "",
            toolCalls: [{ name: "lookup", args, id: "call-1" }],
            assistantTurn: { provider: "mock", content: { asks: "lookup" } },
            usage: { promptTokens: 1, completionTokens: 1 },
          }
        : {
            content: '{"result":"ok"}',
            assistantTurn: { provider: "mock", content: { answers: true } },
            usage: { promptTokens: 1, completionTokens: 1 },
          };
    });
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const callTool = vi.fn(async (): Promise<ToolResult> => ({ content: "found", isError: false }));
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "lookup", description: "lookup", parameters: {} },
      ],
      callTool,
      disconnect: async () => {},
    });
    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );
    return { events, requests, callTool };
  }

  const TOO_DEEP = expect.stringMatching(
    /^Arguments nested more than 100 levels deep .*: the tool was not called$/,
  );

  it("arguments 100 levels deep go to the tool as they are, and the event carries them", async () => {
    const args = argsOfDepth(100);
    const { events, callTool } = await toolRun(args);

    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool.mock.calls[0]).toEqual(["lookup", args]);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ tool: "lookup", args });
    expect(events.some((e) => e.type === "tool_call_error")).toBe(false);
    expect(events.at(-1)?.type).toBe("run_complete");
  });

  it("arguments 101 levels deep are not run: the tool is never called, the model reads an error result naming the bound, the event carries the mention in place of the arguments, and the run goes on", async () => {
    const { events, requests, callTool } = await toolRun(argsOfDepth(101));

    expect(callTool).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      tool: "lookup",
      args: { _omitted: TOO_DEEP },
    });
    expect(events.find((e) => e.type === "tool_call_error")).toMatchObject({
      tool: "lookup",
      message: TOO_DEEP,
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: TOO_DEEP,
      is_error: true,
    });
    // The model's next request carries the error as the call's result.
    expect(requests).toHaveLength(2);
    expect(requests[1].history?.at(-1)).toEqual({
      kind: "tool_results",
      results: [{ name: "lookup", result: TOO_DEEP, id: "call-1" }],
    });
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "ok" } });
  });

  it("arguments 10,000 levels deep — past what JSON.stringify writes — are refused the same way, and every event of the run can be written as JSON", async () => {
    const args = argsOfDepth(10_000);
    // The case's premise: these arguments cannot be written back as JSON here.
    expect(() => JSON.stringify(args)).toThrow(RangeError);

    const { events, callTool } = await toolRun(args);

    expect(callTool).not.toHaveBeenCalled();
    // Its keys alone: comparing arguments this deep would overflow the comparison itself.
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall?.type === "tool_call" && Object.keys(toolCall.args)).toEqual(["_omitted"]);
    expect(() => events.map((e) => JSON.stringify(e))).not.toThrow();
    expect(events.at(-1)?.type).toBe("run_complete");
  });
});

describe("runAgentLoop — a run keeps at most 8 MiB of tool results", () => {
  const MIB = 1024 * 1024;
  const bytesOf = (content: string): number => Buffer.byteLength(content, "utf8");

  /**
   * A run whose model asks, at each of `turns` turns, for `callsPerTurn` calls of
   * `big`, then answers; the tool answers `content(i)` to its i-th call (from 0).
   * The history of each request the model receives is kept as it was sent — the
   * router hands each request a copy of its list, and never changes an entry.
   */
  async function bigResultsRun(options: {
    turns: number;
    callsPerTurn: number;
    content: (call: number) => string;
    isError?: boolean;
  }) {
    const histories: HistoryEntry[][] = [];
    let turn = 0;
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      histories.push(request.history ?? []);
      turn += 1;
      if (turn > options.turns) {
        return {
          content: '{"result":"done"}',
          assistantTurn: { provider: "mock", content: { answers: true } },
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }
      return {
        content: "",
        toolCalls: Array.from({ length: options.callsPerTurn }, (_, i) => ({
          name: "big",
          args: {},
          id: `call-${turn}-${i}`,
        })),
        assistantTurn: { provider: "mock", content: { asks: turn } },
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    let calls = 0;
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "big", description: "big", parameters: {} },
      ],
      callTool: async (): Promise<ToolResult> => ({
        content: options.content(calls++),
        isError: options.isError ?? false,
      }),
      disconnect: async () => {},
    });
    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );
    return { events, histories, calls: () => calls };
  }

  /** The results a history holds, in order. */
  const resultsIn = (history: HistoryEntry[]): string[] =>
    history.flatMap((entry) =>
      entry.kind === "tool_results" ? entry.results.map((r) => r.result) : [],
    );

  it("a model that asks for 1 MiB results at every turn: past 8 MiB each result is replaced by the marker, what was kept is never rewritten, and the run completes", async () => {
    const { events, histories, calls } = await bigResultsRun({
      turns: 4,
      callsPerTurn: 3,
      content: (i) => String(i % 10).repeat(MIB),
    });

    expect(calls()).toBe(12);
    // What the model read last: twelve results, eight kept — each cut to fit
    // 1 MiB, the marker of the cut at its end — and four replaced.
    const last = resultsIn(histories.at(-1) ?? []);
    expect(last).toHaveLength(12);
    const kept = last.filter((r) => r !== TOOL_RESULT_NOT_KEPT_MARKER);
    expect(kept).toHaveLength(8);
    for (const [i, result] of kept.entries()) {
      expect(result.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
      expect(result.startsWith(String(i % 10).repeat(1000))).toBe(true);
      expect(bytesOf(result)).toBeLessThan(TOOL_RESPONSE_MAX_BYTES);
    }
    expect(last.slice(8)).toEqual(Array(4).fill(TOOL_RESULT_NOT_KEPT_MARKER));
    // The results kept stay within the bound; each replaced one costs the fixed marker.
    const keptBytes = kept.reduce((sum, r) => sum + bytesOf(r), 0);
    expect(keptBytes).toBeLessThanOrEqual(RUN_TOOL_RESULTS_MAX_BYTES);
    expect(last.reduce((sum, r) => sum + bytesOf(r), 0)).toBe(
      keptBytes + 4 * bytesOf(TOOL_RESULT_NOT_KEPT_MARKER),
    );
    // Never rewritten: each request's history starts with the one before it.
    for (let i = 1; i < histories.length; i++) {
      const before = histories[i - 1];
      expect(histories[i].slice(0, before.length)).toEqual(before);
    }
    // The events carry what the model read, in the same order.
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.map((e) => (e.type === "tool_result" ? e.result : undefined))).toEqual(last);
    expect(toolResults.every((e) => e.type === "tool_result" && !e.is_error)).toBe(true);
    expect(events.some((e) => e.type === "tool_call_error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "done" } });
  });

  it("replaces the first result that would pass the bound, the ninth of 1 MiB, within a turn", async () => {
    const { events } = await bigResultsRun({
      turns: 3,
      callsPerTurn: 3,
      content: () => "m".repeat(MIB),
    });

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(9);
    expect(
      results.map((e) => e.type === "tool_result" && e.result === TOOL_RESULT_NOT_KEPT_MARKER),
    ).toEqual([...Array(8).fill(false), true]);
    expect(events.at(-1)?.type).toBe("run_complete");
  });

  it("counts error results too: a failing tool's large errors are replaced past 8 MiB, and stay errors", async () => {
    const { events, histories } = await bigResultsRun({
      turns: 4,
      callsPerTurn: 3,
      content: () => "e".repeat(MIB),
      isError: true,
    });

    const last = resultsIn(histories.at(-1) ?? []);
    expect(last.filter((r) => r === TOOL_RESULT_NOT_KEPT_MARKER)).toHaveLength(4);
    const kept = last.filter((r) => r !== TOOL_RESULT_NOT_KEPT_MARKER);
    expect(kept.reduce((sum, r) => sum + bytesOf(r), 0)).toBeLessThanOrEqual(
      RUN_TOOL_RESULTS_MAX_BYTES,
    );
    const errors = events.filter((e) => e.type === "tool_call_error");
    expect(errors).toHaveLength(12);
    expect(errors.slice(8)).toEqual(
      Array(4).fill(expect.objectContaining({ message: TOOL_RESULT_NOT_KEPT_MARKER })),
    );
    expect(events.filter((e) => e.type === "tool_result" && e.is_error)).toHaveLength(12);
    expect(events.at(-1)?.type).toBe("run_complete");
  });

  it("keeps a small result that comes after one was replaced", async () => {
    // Eight results just under 1 MiB, one of 1 MiB that no longer fits, then a
    // small one: two calls a turn, the model's last request within its iterations.
    const sizes = [...Array(8).fill(MIB - 1024), MIB, 10];
    const { histories } = await bigResultsRun({
      turns: 5,
      callsPerTurn: 2,
      content: (i) => "s".repeat(sizes[i] ?? 0),
    });

    const last = resultsIn(histories.at(-1) ?? []);
    expect(last).toHaveLength(10);
    expect(last[8]).toBe(TOOL_RESULT_NOT_KEPT_MARKER);
    expect(last[9]).toBe("s".repeat(10));
  });

  it("cuts a result over 1 MiB before the model reads it, on the path both runtimes share", async () => {
    const { events, histories } = await bigResultsRun({
      turns: 1,
      callsPerTurn: 1,
      content: () => "c".repeat(3 * MIB),
    });

    const [result] = resultsIn(histories.at(-1) ?? []);
    expect(result.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify({ content: result, isError: false })),
    ).toBeLessThanOrEqual(TOOL_RESPONSE_MAX_BYTES);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result });
    expect(events.at(-1)?.type).toBe("run_complete");
  });
});

describe("runAgentLoop — a run whose tool results are near their bound", () => {
  const MIB = 1024 * 1024;

  /** Arguments `{"q":[[…]]}`, `levels` levels deep, the arguments themselves the first. */
  const argsOfDepth = (levels: number): Record<string, unknown> =>
    JSON.parse(`{"q":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`);

  /** Calls of `fill` that leave `room` bytes before the bound: eight just under 1 MiB, then the rest. */
  const fillTo = (room: number) => [
    ...Array.from({ length: 8 }, () => ({ name: "fill", args: { bytes: MIB - 1024 } })),
    { name: "fill", args: { bytes: 8 * 1024 - room } },
  ];

  /**
   * A run whose model asks, at its turn i, for the calls `turns[i]`, then answers. `fill` answers
   * `args.bytes` bytes; `fail` answers an error of `args.content`; any other name is unknown to
   * the run. Each request the model receives, and each line the run logs, is kept.
   */
  async function scriptedRun(turns: { name: string; args?: Record<string, unknown> }[][]) {
    const requests: LLMCallRequest[] = [];
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      requests.push(request);
      const calls = turns[requests.length - 1];
      if (!calls) {
        return {
          content: '{"result":"done"}',
          assistantTurn: { provider: "mock", content: { answers: true } },
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }
      return {
        content: "",
        toolCalls: calls.map((c, i) => ({
          name: c.name,
          args: c.args ?? {},
          id: `call-${requests.length}-${i}`,
        })),
        assistantTurn: { provider: "mock", content: { asks: requests.length } },
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });
    const router = new LLMRouter();
    router.registerProvider("mock", { name: "mock", call });
    const callTool = vi.fn(
      async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
        name === "fill"
          ? { content: "f".repeat(args.bytes as number), isError: false }
          : { content: args.content as string, isError: true },
    );
    const tools = new ToolRegistry();
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "fill", description: "fill", parameters: {} },
        { name: "fail", description: "fail", parameters: {} },
      ],
      callTool,
      disconnect: async () => {},
    });
    const lines: Record<string, unknown>[] = [];
    const keep = (fields: unknown) => {
      if (fields && typeof fields === "object") lines.push(fields as Record<string, unknown>);
    };
    const logger = { error: keep, warn: keep, info: keep, debug: keep } as unknown as Logger;
    const events = await collect(
      runAgentLoop({
        request: createRunRequest(),
        router,
        tools,
        logger,
        startMs: Date.now(),
      }),
    );
    const read = (requests.at(-1)?.history ?? []).flatMap((entry) =>
      entry.kind === "tool_results" ? entry.results.map((r) => r.result) : [],
    );
    return { events, read, callTool, lines };
  }

  it("arguments nested too deep, with no room left: the model still reads why the tool was not called, and an unknown tool's error reads the marker", async () => {
    const { events, read, callTool } = await scriptedRun([
      fillTo(10),
      [{ name: "lookup", args: argsOfDepth(101) }, { name: "missing" }],
    ]);

    expect(callTool).toHaveBeenCalledTimes(9);
    expect(read).toHaveLength(11);
    expect(read[9]).toMatch(
      /^Arguments nested more than 100 levels deep .*: the tool was not called$/,
    );
    expect(read[10]).toBe(TOOL_RESULT_NOT_KEPT_MARKER);
    const errors = events.filter((e) => e.type === "tool_call_error");
    expect(errors.map((e) => e.type === "tool_call_error" && e.message)).toEqual([
      read[9],
      read[10],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run_complete", output: { result: "done" } });
  });

  it("says, on the tool_result line it logs for each call, what the run kept of the result: whole, cut, or replaced", async () => {
    // A small result, one cut, seven just under 1 MiB — then one larger than the
    // room left, and the loop's own result for arguments nested too deep.
    const { lines } = await scriptedRun([
      [
        { name: "fill", args: { bytes: 10 } },
        { name: "fill", args: { bytes: 3 * MIB } },
        ...Array.from({ length: 7 }, () => ({ name: "fill", args: { bytes: MIB - 1024 } })),
        { name: "fill", args: { bytes: 8000 } },
        { name: "lookup", args: argsOfDepth(101) },
      ],
    ]);

    const toolResultLines = lines.filter((line) => line.event === "tool_result");
    expect(toolResultLines.map((line) => line.kept)).toEqual([
      "whole",
      "cut",
      ...Array(7).fill("whole"),
      "replaced",
      "whole",
    ]);
    // The line says what was kept, never the result itself.
    expect(toolResultLines.every((line) => !JSON.stringify(line).includes("ffff"))).toBe(true);
  });

  const CODE_64 = "A_".repeat(32);
  const CODE_65 = `${CODE_64}B`;

  it("an error replaced by the marker keeps its code: the model reads it in front of the marker, and tool_call_error carries it", async () => {
    const { events, read } = await scriptedRun([
      fillTo(10),
      [
        { name: "fail", args: { content: "[SCRIPT_DEPS_INSTALL_FAILED] npm install failed" } },
        { name: "fail", args: { content: `[${CODE_65}] no code this long` } },
        // A bracket of nearly 1 MiB of capitals, whole within the cut: no code, the marker alone.
        { name: "fail", args: { content: `[${"A".repeat(MIB - 1024)}] x` } },
      ],
    ]);

    expect(read.slice(9)).toEqual([
      `[SCRIPT_DEPS_INSTALL_FAILED] ${TOOL_RESULT_NOT_KEPT_MARKER}`,
      TOOL_RESULT_NOT_KEPT_MARKER,
      TOOL_RESULT_NOT_KEPT_MARKER,
    ]);
    const errors = events.filter((e) => e.type === "tool_call_error");
    expect(errors).toEqual([
      expect.objectContaining({
        code: "SCRIPT_DEPS_INSTALL_FAILED",
        message: TOOL_RESULT_NOT_KEPT_MARKER,
      }),
      expect.not.objectContaining({ code: expect.anything() }),
      expect.not.objectContaining({ code: expect.anything() }),
    ]);
    expect(errors[1]).toMatchObject({ message: TOOL_RESULT_NOT_KEPT_MARKER });
    expect(errors[2]).toMatchObject({ message: TOOL_RESULT_NOT_KEPT_MARKER });
  });

  it("reads a code of up to 64 capitals and underscores in tool_call_error: past them, the bracket stays in the message", async () => {
    const { events } = await scriptedRun([
      [
        { name: "fail", args: { content: `[${CODE_64}] the longest code` } },
        { name: "fail", args: { content: `[${CODE_65}] one too long` } },
      ],
    ]);

    const errors = events.filter((e) => e.type === "tool_call_error");
    expect(errors[0]).toMatchObject({ code: CODE_64, message: "the longest code" });
    expect(errors[1]).toMatchObject({ message: `[${CODE_65}] one too long` });
    expect(errors[1]).not.toHaveProperty("code");
  });
});

// The router hands a run to its fallback only before any tool of the primary
// ran: the fallback would start again from the input and run the same tools
// again. A primary that fails once its tools ran fails the run.
describe("runAgentLoop — a run's tools and the router's attempts", () => {
  const MIB = 1024 * 1024;
  /** A result just under 1 MiB, which needs no cut. */
  const NEARLY_MIB = MIB - 64;

  /** A model that asks, at its turn i, for `turns[i]` calls of `fill`; `throws` at its turn of that index. */
  function scriptedModel(name: string, turns: number[], throwsAt?: number) {
    const requests: LLMCallRequest[] = [];
    const call = vi.fn(async (request: LLMCallRequest): Promise<LLMCallResponse> => {
      requests.push(request);
      const turn = requests.length - 1;
      if (turn === throwsAt) throw new Error(`${name}: the provider answered 503`);
      const calls = turns[turn];
      if (calls === undefined) {
        return {
          content: '{"result":"done"}',
          assistantTurn: { provider: name, content: { answers: true } },
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }
      return {
        content: "",
        toolCalls: Array.from({ length: calls }, (_, i) => ({
          name: "fill",
          args: { from: name },
          id: `${name}-${turn}-${i}`,
        })),
        assistantTurn: { provider: name, content: { asks: turn } },
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });
    return { provider: { name, call }, requests };
  }

  it("a primary that fails once its tools ran fails the run: its fallback is never called, and each tool ran once", async () => {
    // The primary keeps seven results just under 1 MiB, then fails.
    const primary = scriptedModel("primary", [7], 1);
    const fallback = scriptedModel("fallback", [2]);
    const router = new LLMRouter();
    router.registerProvider("primary", primary.provider);
    router.registerProvider("fallback", fallback.provider);
    const tools = new ToolRegistry();
    const callTool = vi.fn(
      async (_name: string, args: Record<string, unknown>): Promise<ToolResult> => ({
        content: String(args.from)[0].repeat(NEARLY_MIB),
        isError: false,
      }),
    );
    await tools.addProvider({
      listTools: async (): Promise<ToolDefinition[]> => [
        { name: "fill", description: "fill", parameters: {} },
      ],
      callTool,
      disconnect: async () => {},
    });
    const request = createRunRequest();
    request.agentConfig.model = {
      provider: "primary",
      name: "primary-model",
      fallback: { provider: "fallback", name: "fallback-model" },
    };

    const events: RunEvent[] = [];
    let outcome: unknown = "the run ended";
    try {
      for await (const event of runAgentLoop({
        request,
        router,
        tools,
        logger: createLogger("test"),
        startMs: Date.now(),
      })) {
        events.push(event);
      }
    } catch (err) {
      outcome = err;
    }

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("primary: the provider answered 503");
    expect(fallback.requests).toHaveLength(0);
    expect(callTool).toHaveBeenCalledTimes(7);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(7);
    expect(events.some((e) => e.type === "run_complete")).toBe(false);
  });

  it("a primary whose first answer, refused for 129 tool calls, alone spent more than the whole max_cost: the fallback is never called, and the run ends on TOO_MANY_TOOL_CALLS, as without a fallback, its tokens the refused answer's", async () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 100_000 };
    const primary = vi.fn(
      async (): Promise<LLMCallResponse> => ({
        content: "",
        toolCalls: Array.from({ length: 129 }, (_, i) => ({
          name: "fill",
          args: {},
          id: `primary-${i}`,
        })),
        assistantTurn: { provider: "anthropic", content: { asks: 129 } },
        usage,
      }),
    );
    const fallback = vi.fn(
      async (): Promise<LLMCallResponse> => ({
        content: '{"result":"a guess of the fallback"}',
        assistantTurn: { provider: "openai", content: { answers: true } },
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    );
    const router = new LLMRouter();
    router.registerProvider("anthropic", { name: "anthropic", call: primary });
    router.registerProvider("openai", { name: "openai", call: fallback });
    const request = createRunRequest();
    request.agentConfig.model = {
      provider: "anthropic",
      name: "claude-sonnet-4-6",
      fallback: { provider: "openai", name: "gpt-4o" },
    };
    request.agentConfig.environment.max_cost = 0.01;
    const cost = estimateCost("claude-sonnet-4-6", usage.promptTokens, usage.completionTokens);
    // The case's premise: the refused answer alone passes the ceiling.
    expect(cost).toBeGreaterThan(0.01);

    const events = await collect(
      runAgentLoop({
        request,
        router,
        tools: new ToolRegistry(),
        logger: createLogger("test"),
        startMs: Date.now(),
      }),
    );

    expect(fallback).not.toHaveBeenCalled();
    expect(primary).toHaveBeenCalledOnce();
    expect(events.map((e) => e.type)).toEqual(["llm_complete", "run_error"]);
    expect(events[0]).toMatchObject({
      provider: "anthropic",
      tokens: usage.promptTokens + usage.completionTokens,
    });
    // The bound is read before the cost: the run ends on its code, as an agent
    // without a fallback does.
    expect(events[1]).toMatchObject({
      error: {
        code: "TOO_MANY_TOOL_CALLS",
        message:
          "The model asked for 129 tool calls in one turn; a turn may ask for at most 128. None of them was run.",
      },
    });
  });
});

// The lines a refusal on a bound of what the model may make the process keep
// writes — and the one an attempt abandoned on its failover delay writes —
// behind an endpoint the agent declares with a path and a token in its
// address: counts, bounds, a class; never the address, never what the model
// answered (a sentinel in every answer, looked for in every line). The text of
// each refusal, which the run's events carry, names no address either. The
// real loop and router, the real SDK and guard, a local server for the endpoint.
describe("runAgentLoop — the lines of a model's bounds name counts and bounds, never an address or a content", () => {
  const MIB = 1024 * 1024;
  const SENTINEL = "sentinel-b81e-what-the-model-said";
  const CASE = { timeout: 20_000 };

  type Answer = (res: ServerResponse) => void;
  let script: Answer[] = [];
  let requests = 0;
  let server: Server;
  let port = 0;

  /** A 200 carrying `body`, sent `delayMs` after the request ends. */
  const answer =
    (body: string, delayMs = 0): Answer =>
    (res) => {
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    };
  /** A chat completion carrying `message`. */
  const completion = (message: Record<string, unknown>): string =>
    JSON.stringify({
      id: "completion",
      object: "chat.completion",
      created: 0,
      model: "endpoint-model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: null, ...message },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  /** `bytes` bytes of prose that carries the sentinel and no `{`. */
  const prose = (bytes: number): string => `${SENTINEL} ${"x".repeat(bytes - SENTINEL.length - 1)}`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.on("error", () => undefined);
      req.resume();
      req.on("end", () => {
        const next = script[requests] ?? script[script.length - 1];
        requests += 1;
        next?.(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    script = [];
    requests = 0;
    vi.stubEnv("SKRUN_ALLOW_LOCAL_MODEL_HOSTS", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every line the loop and the router write, at every level: its fields, then its message. */
  function capture() {
    const lines: Array<{ level: string; fields: Record<string, unknown>; message: unknown }> = [];
    const keep =
      (level: string) =>
      (fields: Record<string, unknown>, message?: unknown): void => {
        lines.push({ level, fields, message });
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
    return { logger: logger as unknown as Logger, lines };
  }

  /** What, in `value` once written out, says the address or what the model answered. */
  const traces = (value: unknown): string[] => {
    const text = JSON.stringify(value);
    return [SENTINEL, "secret-path", "token=abc", `127.0.0.1:${port}`].filter((part) =>
      text.includes(part),
    );
  };

  async function run(opts: { outputType?: "number"; withFallback?: boolean; failoverMs?: number }) {
    const { logger, lines } = capture();
    const router = new LLMRouter(logger, { primaryFailoverMs: opts.failoverMs ?? 45_000 });
    if (opts.withFallback) {
      router.registerProvider("anthropic", {
        name: "anthropic",
        call: vi.fn(async () => ({
          content: '{"result": "from the fallback"}',
          usage: { promptTokens: 1, completionTokens: 1 },
        })),
      });
    }
    const request = createRunRequest({ callerKeys: { openai: "sk-caller" } });
    request.agentConfig.model = {
      provider: "openai",
      name: "endpoint-model",
      base_url: `http://127.0.0.1:${port}/v1/secret-path?token=abc`,
      ...(opts.withFallback && { fallback: { provider: "anthropic", name: "claude-sonnet-4-6" } }),
    };
    if (opts.outputType === "number") {
      request.agentConfig.outputs = [{ name: "result", type: "number", description: "result" }];
    }
    const events = await collect(
      runAgentLoop({ request, router, tools: new ToolRegistry(), logger, startMs: Date.now() }),
    );
    return { events, lines };
  }

  const refusals = (lines: Array<{ fields: Record<string, unknown> }>) =>
    lines.filter((line) => line.fields.event === "model_bound_refused").map((line) => line.fields);

  it(
    "an answer asking for 129 tool calls: the call bound's line says the bound and the count",
    CASE,
    async () => {
      const calls = Array.from({ length: 129 }, (_, i) => ({
        id: `call_${i}`,
        type: "function",
        function: { name: "lookup", arguments: JSON.stringify({ q: SENTINEL }) },
      }));
      script = [answer(completion({ content: SENTINEL, tool_calls: calls }))];

      const { events, lines } = await run({});

      expect(events.at(-1)).toMatchObject({
        type: "run_error",
        error: { code: "TOO_MANY_TOOL_CALLS" },
      });
      expect(refusals(lines)).toEqual([
        {
          event: "model_bound_refused",
          provider: "openai",
          model: "endpoint-model",
          code: "TOO_MANY_TOOL_CALLS",
          limit: 128,
          calls: 129,
        },
      ]);
      expect(traces(lines)).toEqual([]);
      expect(traces(events)).toEqual([]);
    },
  );

  it("a response past 4 MiB: the body bound's line says the bound alone", CASE, async () => {
    script = [answer(completion({ content: prose(4 * MIB + 1) }))];

    const { events, lines } = await run({});

    expect(events.at(-1)).toMatchObject({
      type: "run_error",
      error: { code: "MODEL_RESPONSE_TOO_LARGE" },
    });
    expect(refusals(lines)).toEqual([
      {
        event: "model_bound_refused",
        provider: "openai",
        model: "endpoint-model",
        code: "MODEL_RESPONSE_TOO_LARGE",
        limit: 4 * MIB,
      },
    ]);
    expect(traces(lines)).toEqual([]);
    expect(traces(events)).toEqual([]);
  });

  it(
    "answers past 4 MiB in all, the repair included: the budget's line says the bound and the bytes kept",
    CASE,
    async () => {
      // A first answer with no JSON object, which an output of type number
      // refuses; then a repair that takes the run past its budget.
      script = [
        answer(completion({ content: prose(3 * MIB) })),
        answer(completion({ content: prose(1.5 * MIB) })),
      ];

      const { events, lines } = await run({ outputType: "number" });

      expect(events.at(-1)).toMatchObject({
        type: "run_error",
        error: { code: "MODEL_OUTPUT_BUDGET_EXCEEDED" },
      });
      const [line] = refusals(lines);
      expect(Object.keys(line ?? {}).sort()).toEqual(
        ["code", "event", "kept_bytes", "limit", "model", "provider"].sort(),
      );
      expect(line).toMatchObject({
        provider: "openai",
        model: "endpoint-model",
        code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
        limit: 4 * MIB,
      });
      expect(line?.kept_bytes).toBeGreaterThan(4 * MIB);
      expect(traces(lines)).toEqual([]);
      expect(traces(events)).toEqual([]);
    },
  );

  it(
    "a final answer whose JSON object weighs past 1 MiB: the output bound's line says the bound and the object's bytes",
    CASE,
    async () => {
      const object = `{"result": "${SENTINEL}${"y".repeat(MIB)}"}`;
      script = [answer(completion({ content: object }))];

      const { events, lines } = await run({});

      expect(events.at(-1)).toMatchObject({
        type: "run_error",
        error: { code: "OUTPUT_TOO_LARGE" },
      });
      expect(refusals(lines)).toEqual([
        {
          event: "model_bound_refused",
          agent: "test-agent",
          provider: "openai",
          model: "endpoint-model",
          code: "OUTPUT_TOO_LARGE",
          limit: MIB,
          kept_bytes: Buffer.byteLength(object),
        },
      ]);
      expect(traces(lines)).toEqual([]);
      expect(traces(events)).toEqual([]);
    },
  );

  it(
    "a primary abandoned on its failover delay, its answer arriving after the fallback's: its lines say the delay and a class",
    CASE,
    async () => {
      script = [answer(completion({ content: `{"result": "${SENTINEL}"}` }), 600)];

      const { events, lines } = await run({ withFallback: true, failoverMs: 200 });
      // The abandoned call's answer arrives, and the attempt ends on it.
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(events.at(-1)).toMatchObject({
        type: "run_complete",
        output: { result: "from the fallback" },
      });
      expect(
        lines
          .filter((line) => line.fields.event === "primary_abandoned")
          .map((line) => line.fields),
      ).toEqual([
        {
          event: "primary_abandoned",
          provider: "openai",
          model: "endpoint-model",
          failover_ms: 200,
        },
      ]);
      expect(
        lines.filter((line) => line.fields.event === "primary_failed").map((line) => line.fields),
      ).toEqual([
        {
          event: "primary_failed",
          provider: "openai",
          model: "endpoint-model",
          tools_served: 0,
          fallback: true,
          error_name: "PrimaryFailoverTimeout",
        },
      ]);
      expect(requests).toBe(1);
      expect(traces(lines)).toEqual([]);
      expect(traces(events)).toEqual([]);
    },
  );
});
