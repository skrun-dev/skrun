import type { ToolCallRequest, ToolCallResult } from "../llm/providers/types.js";
import type { LLMRouter } from "../llm/router.js";
import { AuditLogger } from "../security/audit.js";
import { checkCost } from "../security/cost-checker.js";
import { parseTimeout, withTimeout } from "../security/timeout.js";
import type { StateStore } from "../state/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunRequest, RunResult } from "../types.js";
import type { RuntimeAdapter } from "./adapter.js";

export class LocalAdapter implements RuntimeAdapter {
  private audit = new AuditLogger();

  constructor(
    private router: LLMRouter,
    private tools: ToolRegistry,
    private state: StateStore,
  ) {}

  async execute(request: RunRequest): Promise<RunResult> {
    const timeoutMs = parseTimeout(request.agentConfig.runtime.timeout);
    const start = Date.now();

    this.audit.log({
      runId: request.runId,
      agentName: request.agentConfig.name,
      timestamp: new Date().toISOString(),
      action: "run_start",
      details: { input: request.input },
    });

    try {
      const result = await withTimeout(this.executeInner(request, start), timeoutMs);
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const action = (err as Error).name === "TimeoutError" ? "timeout" : "run_failed";

      this.audit.log({
        runId: request.runId,
        agentName: request.agentConfig.name,
        timestamp: new Date().toISOString(),
        action,
        details: { error: err instanceof Error ? err.message : String(err) },
      });

      return {
        runId: request.runId,
        status: "failed",
        output: {},
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeInner(request: RunRequest, start: number): Promise<RunResult> {
    const config = request.agentConfig;

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

    // 5. Call LLM with tool callback
    const onToolCall = async (call: ToolCallRequest): Promise<ToolCallResult> => {
      const result = await this.tools.callTool(call.name, call.args);

      console.log(
        `[ToolCall] ${config.name} → ${call.name}(${JSON.stringify(call.args)}) = ${result.content}${result.isError ? " [ERROR]" : ""}`,
      );

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
      // Try to extract JSON from response
      const jsonMatch = llmResponse.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Separate _state from output
        if (parsed._state) {
          newState = parsed._state;
          parsed._state = undefined;
        }
        output = parsed;
      } else {
        // Fallback: raw text as "result"
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

    return {
      runId: request.runId,
      status: "completed",
      output,
      newState,
      usage: {
        promptTokens: llmResponse.usage.promptTokens,
        completionTokens: llmResponse.usage.completionTokens,
        totalTokens: llmResponse.usage.totalTokens,
        estimatedCost: llmResponse.estimatedCost,
      },
      durationMs,
    };
  }
}
