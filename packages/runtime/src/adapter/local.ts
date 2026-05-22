import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputsToZod } from "@skrun-dev/schema";
import { collectOutputFiles } from "../files/output-collector.js";
import type { SkrunPart } from "../llm/parts.js";
import type { ToolCallRequest, ToolCallResult } from "../llm/providers/types.js";
import type { LLMRouter } from "../llm/router.js";
import { resolveToolChoice } from "../llm/tool-choice.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
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
            ...(event.usage.cache_read_tokens !== undefined && {
              cacheReadTokens: event.usage.cache_read_tokens,
            }),
            ...(event.usage.cache_write_tokens !== undefined && {
              cacheWriteTokens: event.usage.cache_write_tokens,
            }),
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

    // Build text portion from non-file inputs only (file fields go in userContent as SkrunParts).
    const fileFieldNames = new Set(
      config.inputs.filter((f) => f.type === "file").map((f) => f.name),
    );
    const textOnlyInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(request.input)) {
      if (!fileFieldNames.has(k)) textOnlyInput[k] = v;
    }
    let userMessage = `Input: ${JSON.stringify(textOnlyInput)}`;
    if (currentState) {
      userMessage += `\n\nPrevious state: ${JSON.stringify(currentState)}`;
    }
    userMessage += `\n\nRespond with a JSON object containing the output fields: ${config.outputs.map((o) => o.name).join(", ")}.`;
    if (config.state.type === "kv") {
      userMessage += `\nAlso include a "_state" field with any state to persist for future runs.`;
    }

    // Build SkrunPart[]: single text part + file parts from resolvedInputs.
    const userContent: SkrunPart[] = [{ kind: "text", text: userMessage }];
    if (request.resolvedInputs) {
      for (const parts of request.resolvedInputs.values()) {
        userContent.push(...parts);
      }
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

      // Emit a visibility-only `tool_call_error` event BEFORE the existing
      // `tool_result` when the tool returned isError. The tool_result still
      // flows back to the LLM normally — the LLM decides what to do (retry,
      // fallback, graceful failure). This event exists so failures are
      // visible in the SSE stream + dashboard event timeline (rendered in
      // red) without changing the recovery contract. Same emit path covers
      // both script tools and MCP tools (this.tools is the unified
      // ToolRegistry).
      if (result.isError) {
        // Extract optional structured code from the script-provider's
        // `[CODE] message` content prefix (e.g. `[SCRIPT_DEPS_INSTALL_FAILED] ...`)
        // for machine-readable consumers; falls back to undefined for
        // free-form error strings.
        const codeMatch = /^\[([A-Z_]+)\]\s*/.exec(result.content);
        events.push({
          type: "tool_call_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          tool: call.name,
          message: codeMatch ? result.content.slice(codeMatch[0].length) : result.content,
          ...(codeMatch?.[1] ? { code: codeMatch[1] } : {}),
        });
      }

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

    const toolChoice = resolveToolChoice(config);

    // Build agentContext for prompt-cache routing. Agent name + version
    // come from the resolved config + request; environmentId defaults to
    // "default" when not provided (caching is then per agent+version only).
    const agentContext = {
      name: config.name,
      version: request.agent_version ?? "unknown",
      environmentId: request.environmentId ?? "default",
    };

    const llmResponse = await this.router.call(
      config.model,
      systemPrompt,
      userContent,
      llmTools.length > 0 ? llmTools : undefined,
      llmTools.length > 0 ? onToolCall : undefined,
      config.model.temperature,
      request.callerKeys,
      toolChoice,
      config.parallel_tools,
      agentContext,
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

    // Track aggregate usage so a follow-up retry call can add to the same
    // accumulators without duplicating the run_complete construction below.
    let aggPromptTokens = llmResponse.usage.promptTokens;
    let aggCompletionTokens = llmResponse.usage.completionTokens;
    let aggTotalTokens = llmResponse.usage.totalTokens;
    let aggCacheReadTokens = llmResponse.usage.cacheReadTokens;
    let aggCacheWriteTokens = llmResponse.usage.cacheWriteTokens;
    let aggCost = llmResponse.estimatedCost;

    // Post-loop output validation against the agent's declared `outputs`
    // schema. On success the run proceeds unchanged. On failure we emit an
    // `output_validation_warning` and issue a SINGLE isolated repair LLM
    // call (no tools, no agentic loop). Retry success → `run_complete`
    // with the corrected output + summed usage. Retry failure (JSON parse
    // or schema mismatch) → `run_error` with code `OUTPUT_SCHEMA_INVALID`.
    if (config.outputs.length > 0) {
      const outputSchema = outputsToZod(config.outputs);
      const validation = outputSchema.safeParse(output);
      if (!validation.success) {
        events.push({
          type: "output_validation_warning",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          errors: validation.error.issues,
        });
        this.logger.warn(
          {
            event: "output_validation_failed",
            agent: config.name,
            issues: validation.error.issues.length,
          },
          "Final output did not match declared outputs schema — issuing repair retry",
        );

        const schemaDescription = config.outputs
          .map((o) => `  - ${o.name} (${o.type})${o.description ? `: ${o.description}` : ""}`)
          .join("\n");
        const repairPrompt = `Your previous JSON output did not match the agent's declared output schema.

Validation errors:
${JSON.stringify(validation.error.issues, null, 2)}

Required top-level fields (all required; extra keys allowed):
${schemaDescription}

Re-emit the output as a single JSON object matching this schema. Output only the JSON object, no commentary.`;

        const retryResponse = await this.router.call(
          config.model,
          systemPrompt,
          [{ kind: "text", text: repairPrompt }],
          undefined,
          undefined,
          config.model.temperature,
          request.callerKeys,
          undefined,
          undefined,
          agentContext,
        );

        events.push({
          type: "llm_complete",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          provider: retryResponse.provider,
          model: retryResponse.model,
          tokens: retryResponse.usage.totalTokens,
        });

        aggPromptTokens += retryResponse.usage.promptTokens;
        aggCompletionTokens += retryResponse.usage.completionTokens;
        aggTotalTokens += retryResponse.usage.totalTokens;
        if (retryResponse.usage.cacheReadTokens !== undefined) {
          aggCacheReadTokens = (aggCacheReadTokens ?? 0) + retryResponse.usage.cacheReadTokens;
        }
        if (retryResponse.usage.cacheWriteTokens !== undefined) {
          aggCacheWriteTokens = (aggCacheWriteTokens ?? 0) + retryResponse.usage.cacheWriteTokens;
        }
        aggCost += retryResponse.estimatedCost;

        let retryParseError: string | null = null;
        let retryOutput: Record<string, unknown> = {};
        try {
          const jsonMatch = retryResponse.content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed._state !== undefined) parsed._state = undefined;
            retryOutput = parsed;
          } else {
            retryParseError = "Retry output did not contain a JSON object";
          }
        } catch (err) {
          retryParseError = `Retry output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (retryParseError) {
          this.logger.warn(
            { event: "output_retry_parse_failed", agent: config.name },
            retryParseError,
          );
          return {
            events,
            result: {
              type: "run_error",
              run_id: request.runId,
              timestamp: new Date().toISOString(),
              error: { code: "OUTPUT_SCHEMA_INVALID", message: retryParseError },
            },
          };
        }

        const retryValidation = outputSchema.safeParse(retryOutput);
        if (!retryValidation.success) {
          const message = `Output validation failed after repair retry: ${JSON.stringify(retryValidation.error.issues)}`;
          this.logger.warn(
            {
              event: "output_retry_validation_failed",
              agent: config.name,
              issues: retryValidation.error.issues.length,
            },
            "Repair retry output still did not match declared schema",
          );
          return {
            events,
            result: {
              type: "run_error",
              run_id: request.runId,
              timestamp: new Date().toISOString(),
              error: { code: "OUTPUT_SCHEMA_INVALID", message },
            },
          };
        }

        output = retryOutput;
      }
    }

    const costResult = checkCost(aggCost, config.environment.max_cost);
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
      { event: "run_complete", agent: config.name, durationMs, cost: aggCost },
      "Agent run completed",
    );

    const completeEvent: RunEvent = {
      type: "run_complete",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      output,
      usage: {
        prompt_tokens: aggPromptTokens,
        completion_tokens: aggCompletionTokens,
        total_tokens: aggTotalTokens,
        ...(aggCacheReadTokens !== undefined && { cache_read_tokens: aggCacheReadTokens }),
        ...(aggCacheWriteTokens !== undefined && { cache_write_tokens: aggCacheWriteTokens }),
      },
      cost: { estimated: aggCost },
      duration_ms: durationMs,
      files: [],
    };

    return { events, result: completeEvent };
  }
}
