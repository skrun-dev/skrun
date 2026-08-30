import { describe, expect, it, vi } from "vitest";
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
