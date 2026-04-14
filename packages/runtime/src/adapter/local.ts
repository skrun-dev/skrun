import type { ToolCallRequest, ToolCallResult } from "../llm/providers/types.js";
import type { LLMRouter } from "../llm/router.js";
import { AuditLogger } from "../security/audit.js";
import { checkCost } from "../security/cost-checker.js";
import { parseTimeout, withTimeout } from "../security/timeout.js";
import type { StateStore } from "../state/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunEvent, RunRequest, RunResult } from "../types.js";
import type { RuntimeAdapter } from "./adapter.js";

export class LocalAdapter implements RuntimeAdapter {
  private audit = new AuditLogger();

  constructor(
    private router: LLMRouter,
    private tools: ToolRegistry,
    private state: StateStore,
  ) {}

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
        };
      } else if (event.type === "run_error") {
        lastError = event;
      }
    }

    if (lastResult) return lastResult;

    // If we got a run_error event, return a failed result
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
    const timeoutMs = parseTimeout(config.runtime.timeout);
    const start = Date.now();

    // Emit run_start
    yield {
      type: "run_start",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      agent: config.name,
    };

    this.audit.log({
      runId: request.runId,
      agentName: config.name,
      timestamp: new Date().toISOString(),
      action: "run_start",
      details: { input: request.input },
    });

    try {
      // Wrap the inner execution with timeout
      const { events, result } = await withTimeout(
        this.executeInnerStream(request, start),
        timeoutMs,
      );

      // Yield all collected intermediate events (tool_call, tool_result, llm_complete)
      for (const event of events) {
        yield event;
      }

      // Yield run_complete
      yield result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const isTimeout = (err as Error).name === "TimeoutError";
      const action = isTimeout ? "timeout" : "run_failed";

      this.audit.log({
        runId: request.runId,
        agentName: config.name,
        timestamp: new Date().toISOString(),
        action,
        details: { error: err instanceof Error ? err.message : String(err) },
      });

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

    // 1. Read state
    let currentState: Record<string, unknown> | null = null;
    if (config.state.type === "kv") {
      currentState = await this.state.get(config.name);
    }

    // 2. Build system prompt
    const systemPrompt =
      config.context_mode === "persistent" && request.agentsMdContent
        ? request.agentsMdContent
        : request.skillContent;

    // 3. Build user message
    let userMessage = `Input: ${JSON.stringify(request.input)}`;
    if (currentState) {
      userMessage += `\n\nPrevious state: ${JSON.stringify(currentState)}`;
    }
    userMessage += `\n\nRespond with a JSON object containing the output fields: ${config.outputs.map((o) => o.name).join(", ")}.`;
    if (config.state.type === "kv") {
      userMessage += `\nAlso include a "_state" field with any state to persist for future runs.`;
    }

    // 4. Get tools
    const toolDefs = await this.tools.listTools();
    console.log(
      `[LocalAdapter] ${config.name} — ${toolDefs.length} tools available: ${toolDefs.map((t) => t.name).join(", ") || "(none)"}`,
    );
    const llmTools = toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // 5. Call LLM with tool callback that collects events
    const onToolCall = async (call: ToolCallRequest): Promise<ToolCallResult> => {
      // Emit tool_call event
      events.push({
        type: "tool_call",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        tool: call.name,
        args: call.args,
      });

      const result = await this.tools.callTool(call.name, call.args);

      console.log(
        `[ToolCall] ${config.name} → ${call.name}(${JSON.stringify(call.args)}) = ${result.content}${result.isError ? " [ERROR]" : ""}`,
      );

      // Emit tool_result event
      events.push({
        type: "tool_result",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        tool: call.name,
        result: result.content,
        is_error: result.isError ?? false,
      });

      this.audit.log({
        runId: request.runId,
        agentName: config.name,
        timestamp: new Date().toISOString(),
        action: "tool_call",
        details: {
          tool: call.name,
          args: call.args,
          result: result.content,
          isError: result.isError,
        },
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

    // Emit llm_complete event
    events.push({
      type: "llm_complete",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      provider: llmResponse.provider,
      model: llmResponse.model,
      tokens: llmResponse.usage.totalTokens,
    });

    this.audit.log({
      runId: request.runId,
      agentName: config.name,
      timestamp: new Date().toISOString(),
      action: "llm_call",
      details: {
        provider: llmResponse.provider,
        model: llmResponse.model,
        tokens: llmResponse.usage.totalTokens,
        cost: llmResponse.estimatedCost,
      },
    });

    // 6. Parse output
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
      console.warn(
        `[LocalAdapter] Failed to parse JSON from LLM response for ${config.name}. Falling back to raw text.`,
      );
      output = { result: llmResponse.content };
    }

    // 7. Save state
    if (config.state.type === "kv" && newState) {
      await this.state.set(config.name, newState);
    }

    // 8. Check cost
    const costResult = checkCost(llmResponse.estimatedCost, config.runtime.max_cost);
    if (costResult.exceeded) {
      this.audit.log({
        runId: request.runId,
        agentName: config.name,
        timestamp: new Date().toISOString(),
        action: "cost_exceeded",
        details: { estimated: costResult.estimated, maxCost: config.runtime.max_cost },
      });
    }

    const durationMs = Date.now() - start;

    this.audit.log({
      runId: request.runId,
      agentName: config.name,
      timestamp: new Date().toISOString(),
      action: "run_complete",
      details: { durationMs, cost: llmResponse.estimatedCost },
    });

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
    };

    return { events, result: completeEvent };
  }
}
