import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOutputFiles } from "../files/output-collector.js";
import type { ToolCallRequest, ToolCallResult } from "../llm/providers/types.js";
import type { LLMRouter } from "../llm/router.js";
import { createLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import { checkCost } from "../security/cost-checker.js";
import { parseTimeout, withTimeout } from "../security/timeout.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunEvent, RunRequest, RunResult } from "../types.js";
import type { RuntimeAdapter } from "./adapter.js";

export interface StateCallbacks {
  getState: (agentName: string) => Promise<Record<string, unknown> | null>;
  setState: (agentName: string, state: Record<string, unknown>) => Promise<void>;
}

export class LocalAdapter implements RuntimeAdapter {
  private logger: Logger;

  constructor(
    private router: LLMRouter,
    private tools: ToolRegistry,
    private stateCallbacks?: StateCallbacks,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger("runtime");
  }

  async execute(request: RunRequest): Promise<RunResult> {
    let lastResult: RunResult | undefined;
    let lastError: RunEvent | undefined;

    for await (const event of this.executeStream(request)) {
      if (event.type === "run_complete") {
        lastResult = {
          runId: request.runId,
          status: "completed",
          output: event.output,
          usage: {
            promptTokens: event.usage.prompt_tokens,
            completionTokens: event.usage.completion_tokens,
            totalTokens: event.usage.total_tokens,
            estimatedCost: event.cost.estimated,
          },
          durationMs: event.duration_ms,
          files: event.files,
        };
      } else if (event.type === "run_error") {
        lastError = event;
      }
    }

    if (lastResult) return lastResult;

    const errorEvent = lastError as Extract<RunEvent, { type: "run_error" }> | undefined;
    return {
      runId: request.runId,
      status: "failed",
      output: {},
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 0,
      error: errorEvent?.error.message ?? "Unknown error",
    };
  }

  async *executeStream(request: RunRequest): AsyncGenerator<RunEvent> {
    const config = request.agentConfig;
    const timeoutMs = parseTimeout(config.environment.timeout);
    const start = Date.now();

    // Create output dir for file deliverables
    if (!request.outputDir) {
      const outputDir = join(tmpdir(), `skrun-outputs-${request.runId}`);
      mkdirSync(outputDir, { recursive: true });
      request.outputDir = outputDir;
    }

    yield {
      type: "run_start",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      agent: config.name,
      agent_version: request.agent_version ?? "unknown",
    };

    this.logger.info(
      {
        event: "run_start",
        run_id: request.runId,
        agent: config.name,
        agent_version: request.agent_version,
      },
      "Agent run started",
    );

    try {
      const { events, result } = await withTimeout(
        this.executeInnerStream(request, start),
        timeoutMs,
      );

      for (const event of events) {
        yield event;
      }

      // Scan output dir for produced files
      if (result.type === "run_complete" && request.outputDir) {
        const files = collectOutputFiles(request.outputDir);
        yield { ...result, files };
      } else {
        yield result;
      }
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError";
      const action = isTimeout ? "timeout" : "run_failed";

      this.logger.error(
        {
          event: action,
          run_id: request.runId,
          agent: config.name,
          error: err instanceof Error ? err.message : String(err),
        },
        `Agent run ${action}`,
      );

      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: {
          code: isTimeout ? "TIMEOUT" : "EXECUTION_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async executeInnerStream(
    request: RunRequest,
    start: number,
  ): Promise<{ events: RunEvent[]; result: RunEvent }> {
    const config = request.agentConfig;
    const events: RunEvent[] = [];

    let currentState: Record<string, unknown> | null = null;
    if (config.state.type === "kv" && this.stateCallbacks) {
      currentState = await this.stateCallbacks.getState(config.name);
    }

    const systemPrompt =
      config.context_mode === "persistent" && request.agentsMdContent
        ? request.agentsMdContent
        : request.skillContent;

    let userMessage = `Input: ${JSON.stringify(request.input)}`;
    if (currentState) {
      userMessage += `\n\nPrevious state: ${JSON.stringify(currentState)}`;
    }
    userMessage += `\n\nRespond with a JSON object containing the output fields: ${config.outputs.map((o) => o.name).join(", ")}.`;
    if (config.state.type === "kv") {
      userMessage += `\nAlso include a "_state" field with any state to persist for future runs.`;
    }

    const toolDefs = await this.tools.listTools();
    this.logger.info(
      { event: "tools_loaded", agent: config.name, tools: toolDefs.map((t) => t.name) },
      `${toolDefs.length} tools available`,
    );
    const llmTools = toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const onToolCall = async (call: ToolCallRequest): Promise<ToolCallResult> => {
      events.push({
        type: "tool_call",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        tool: call.name,
        args: call.args,
      });

      const result = await this.tools.callTool(call.name, call.args);

      this.logger.info(
        { event: "tool_result", agent: config.name, tool: call.name, isError: result.isError },
        `Tool ${call.name} ${result.isError ? "failed" : "completed"}`,
      );

      events.push({
        type: "tool_result",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        tool: call.name,
        result: result.content,
        is_error: result.isError ?? false,
      });

      return { name: call.name, result: result.content, id: call.id };
    };

    const llmResponse = await this.router.call(
      config.model,
      systemPrompt,
      userMessage,
      llmTools.length > 0 ? llmTools : undefined,
      llmTools.length > 0 ? onToolCall : undefined,
      config.model.temperature,
      request.callerKeys,
    );

    events.push({
      type: "llm_complete",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      provider: llmResponse.provider,
      model: llmResponse.model,
      tokens: llmResponse.usage.totalTokens,
    });

    this.logger.info(
      {
        event: "llm_call",
        agent: config.name,
        provider: llmResponse.provider,
        model: llmResponse.model,
        tokens: llmResponse.usage.totalTokens,
        cost: llmResponse.estimatedCost,
      },
      "LLM call completed",
    );

    let output: Record<string, unknown> = {};
    let newState: Record<string, unknown> | undefined;

    try {
      const jsonMatch = llmResponse.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed._state) {
          newState = parsed._state;
          parsed._state = undefined;
        }
        output = parsed;
      } else {
        output = { result: llmResponse.content };
      }
    } catch (_parseErr) {
      this.logger.warn(
        { event: "json_parse_fallback", agent: config.name },
        "Failed to parse JSON from LLM response, falling back to raw text",
      );
      output = { result: llmResponse.content };
    }

    if (config.state.type === "kv" && newState && this.stateCallbacks) {
      await this.stateCallbacks.setState(config.name, newState);
    }

    const costResult = checkCost(llmResponse.estimatedCost, config.environment.max_cost);
    if (costResult.exceeded) {
      this.logger.warn(
        {
          event: "cost_exceeded",
          agent: config.name,
          estimated: costResult.estimated,
          maxCost: config.environment.max_cost,
        },
        "Run cost exceeded max_cost",
      );
    }

    const durationMs = Date.now() - start;

    this.logger.info(
      { event: "run_complete", agent: config.name, durationMs, cost: llmResponse.estimatedCost },
      "Agent run completed",
    );

    const completeEvent: RunEvent = {
      type: "run_complete",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      output,
      usage: {
        prompt_tokens: llmResponse.usage.promptTokens,
        completion_tokens: llmResponse.usage.completionTokens,
        total_tokens: llmResponse.usage.totalTokens,
      },
      cost: { estimated: llmResponse.estimatedCost },
      duration_ms: durationMs,
      files: [],
    };

    return { events, result: completeEvent };
  }
}
