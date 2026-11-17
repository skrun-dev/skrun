/**
 * E2E: a three-turn run carries its earlier turns.
 *
 * `LocalAdapter` drives the real agent loop and the real `LLMRouter`; a
 * witness provider, registered under the agent's provider name, plays three
 * turns — two calls of a real script tool from the tool registry, then the
 * output — and records the conversation each request carried. The third
 * request carries both earlier assistant turns as the provider returned them,
 * each followed by the results of its calls, paired by id; the run's events
 * keep their order and their shape.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalAdapter } from "../../packages/runtime/src/adapter/local.js";
import type {
  HistoryEntry,
  LLMCallRequest,
  LLMCallResponse,
  LLMProvider,
} from "../../packages/runtime/src/llm/providers/types.js";
import { LLMRouter } from "../../packages/runtime/src/llm/router.js";
import { ToolRegistry } from "../../packages/runtime/src/tools/registry.js";
import { ScriptToolProvider } from "../../packages/runtime/src/tools/script-provider.js";
import type { RunEvent, RunRequest } from "../../packages/runtime/src/types.js";
import type { ToolConfig } from "../../packages/schema/src/index.js";

/** A tool the registry runs as a real script: it prints the arguments it was given. */
const ECHO_TOOL: ToolConfig = {
  name: "echo",
  description: "Echo the arguments back",
  input_schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  required: false,
};

/**
 * Plays three turns — a call of `echo`, another, then the output — and keeps
 * a copy of the conversation each request carried. Each turn it returns is
 * opaque to the router: an object only this provider reads.
 */
class WitnessProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly carried: HistoryEntry[][] = [];

  async call(request: LLMCallRequest): Promise<LLMCallResponse> {
    this.carried.push(structuredClone(request.history ?? []));
    const turn = this.carried.length;
    const assistantTurn = { provider: this.name, content: { witnessTurn: turn } };
    const usage = { promptTokens: 10, completionTokens: 5 };
    if (turn <= 2) {
      return {
        content: "",
        toolCalls: [{ name: "echo", args: { message: `step ${turn}` }, id: `call-${turn}` }],
        assistantTurn,
        usage,
      };
    }
    return { content: '{"result":"done"}', assistantTurn, usage };
  }
}

function runRequest(): RunRequest {
  return {
    agentConfig: {
      name: "tool-loop-agent",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-witness" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      tools: [ECHO_TOOL],
      tool_choice: "auto",
      parallel_tools: true,
      mcp_servers: [],
      environment: {
        networking: { allowed_hosts: [] },
        secrets: [],
        timeout: "30s",
        max_cost: 1.0,
      },
      state: { type: "none", ttl: "30d" },
      context_mode: "skill",
      tests: [],
    },
    skillContent: "Call echo twice, then answer.",
    input: { task: "three turns" },
    runId: "run-tool-loop",
    agent_version: "1.0.0",
    bundleKey: "dev/tool-loop-agent/1.0.0.agent",
  };
}

describe("a run whose model calls tools over three turns", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-tool-loop-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "scripts", "echo.js"),
      `let data=""; process.stdin.on("data",c=>data+=c); process.stdin.on("end",()=>{process.stdout.write(data);});`,
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the third request with both earlier turns, each followed by its results, and keeps its events in order", async () => {
    const witness = new WitnessProvider();
    const router = new LLMRouter();
    router.registerProvider("anthropic", witness);
    const tools = new ToolRegistry();
    await tools.addProvider(new ScriptToolProvider(join(dir, "scripts"), [ECHO_TOOL]));

    const events: RunEvent[] = [];
    for await (const event of new LocalAdapter(router, tools).executeStream(runRequest())) {
      events.push(event);
    }

    // Three requests: the first carries no earlier turn, the third carries both.
    expect(witness.carried).toHaveLength(3);
    expect(witness.carried[0]).toEqual([]);
    const third = witness.carried[2] ?? [];
    expect(third.map((e) => e.kind)).toEqual([
      "assistant",
      "tool_results",
      "assistant",
      "tool_results",
    ]);
    expect(third[0]).toEqual({
      kind: "assistant",
      turn: { provider: "anthropic", content: { witnessTurn: 1 } },
    });
    expect(third[2]).toEqual({
      kind: "assistant",
      turn: { provider: "anthropic", content: { witnessTurn: 2 } },
    });
    for (const [index, step] of [
      [1, 1],
      [3, 2],
    ] as const) {
      const entry = third[index];
      expect(entry?.kind).toBe("tool_results");
      const results = entry?.kind === "tool_results" ? entry.results : [];
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(`call-${step}`);
      expect(results[0]?.name).toBe("echo");
      // The script's own output: the arguments the model gave the call.
      expect(JSON.parse(results[0]?.result ?? "{}")).toEqual({ message: `step ${step}` });
    }

    // The events, in the order they happened, with the shape they always had.
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "llm_complete",
      "run_complete",
    ]);
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => (e.type === "tool_call" ? e.args : undefined))).toEqual([
      { message: "step 1" },
      { message: "step 2" },
    ]);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => (e.type === "tool_result" ? e.is_error : undefined))).toEqual([
      false,
      false,
    ]);
    const complete = events.at(-1);
    expect(complete?.type === "run_complete" ? complete.output : undefined).toEqual({
      result: "done",
    });
    // Each turn's usage counted once.
    expect(complete?.type === "run_complete" ? complete.usage.prompt_tokens : undefined).toBe(30);
  });
});
