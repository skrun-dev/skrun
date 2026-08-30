// Agent execution loop shared by LocalAdapter and FlyioAdapter.
//
// Both adapters drive the same LLM-loop logic — the only difference is the
// `ToolRegistry` they pass in (LocalAdapter wires real script + MCP
// providers; FlyioAdapter wires RPC stubs that forward to the runner
// machine). This helper centralises the loop so the two adapters cannot
// drift on prompt construction, output validation, repair retries, state
// persistence, cost tracking, or event emission ordering.
//
// `runAgentLoop` is an AsyncGenerator yielding RunEvents AS THEY HAPPEN
// (tool_call, tool_result, tool_call_error, llm_complete, run_heartbeat,
// output_validation_warning, and the terminal run_complete / run_error).
// Streaming directly via the generator — instead of collecting into an
// array — is what makes `run_heartbeat` useful: it flushes through SSE
// the moment it ticks, keeping callers + reverse proxies from declaring
// the connection idle during slow LLM / tool waits.
//
// Heartbeat cadence: every `HEARTBEAT_INTERVAL_MS` (default 30s) while
// one of the long awaits is in flight. Stages are `waiting_llm`,
// `waiting_tool`, and (cloud only) `uploading_outputs`.

import { outputsToZod } from "@skrun-dev/schema";
import type { SkrunPart } from "../llm/parts.js";
import type { ToolCallRequest, ToolCallResult } from "../llm/providers/types.js";
import type { LLMRouter } from "../llm/router.js";
import { resolveToolChoice } from "../llm/tool-choice.js";
import type { Logger } from "../logger.js";
import { checkCost } from "../security/cost-checker.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunEvent, RunHeartbeatEvent, RunRequest } from "../types.js";
import type { StateCallbacks } from "./local.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface AgentLoopOptions {
  request: RunRequest;
  router: LLMRouter;
  tools: ToolRegistry;
  stateCallbacks?: StateCallbacks;
  logger: Logger;
  /** Wall-clock timestamp at run_start; used to compute `duration_ms`. */
  startMs: number;
  /** Override the heartbeat tick interval (ms). Tests pass a smaller value. */
  heartbeatIntervalMs?: number;
}

/**
 * AsyncGenerator that drives the agent loop end-to-end and yields each
 * RunEvent as it occurs. The terminal event is always a `run_complete`
 * (with `files: []` — callers append files separately) or `run_error`.
 */
export async function* runAgentLoop(opts: AgentLoopOptions): AsyncGenerator<RunEvent> {
  const { request, router, tools, stateCallbacks, logger, startMs } = opts;
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const config = request.agentConfig;

  let currentState: Record<string, unknown> | null = null;
  if (config.state.type === "kv" && stateCallbacks) {
    currentState = await stateCallbacks.getState(config.name);
  }

  const systemPrompt =
    config.context_mode === "persistent" && request.agentsMdContent
      ? request.agentsMdContent
      : request.skillContent;

  // Build text portion from non-file inputs only (file fields go in userContent as SkrunParts).
  const fileFieldNames = new Set(config.inputs.filter((f) => f.type === "file").map((f) => f.name));
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

  const userContent: SkrunPart[] = [{ kind: "text", text: userMessage }];
  if (request.resolvedInputs) {
    for (const parts of request.resolvedInputs.values()) {
      userContent.push(...parts);
    }
  }

  const toolDefs = await tools.listTools();
  logger.info(
    { event: "tools_loaded", agent: config.name, tools: toolDefs.map((t) => t.name) },
    `${toolDefs.length} tools available`,
  );
  const llmTools = toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // Heartbeats during tool dispatch live on a side channel: the LLMRouter
  // calls `onToolCall` from inside its own loop, where we can't yield
  // directly into THIS generator. We accumulate events (tool_call,
  // tool_result, tool_call_error, run_heartbeat) into `pendingEvents`
  // and flush them after each LLMRouter resume. Live streaming is
  // preserved at granularity of "between LLM iterations" — heartbeats
  // fire during the in-flight LLM call AND during the tool await.
  const pendingEvents: RunEvent[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const onToolCall = async (call: ToolCallRequest): Promise<ToolCallResult> => {
    pendingEvents.push({
      type: "tool_call",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      tool: call.name,
      args: call.args,
    });

    // Heartbeat the tool wait. We push heartbeats into pendingEvents on
    // each tick so they flush out the next time the loop yields.
    const toolTimer = setInterval(() => {
      pendingEvents.push({
        type: "run_heartbeat",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        stage: "waiting_tool",
      });
    }, heartbeatMs);

    let result: import("../tools/types.js").ToolResult;
    try {
      result = await tools.callTool(call.name, call.args);
    } finally {
      clearInterval(toolTimer);
    }

    logger.info(
      { event: "tool_result", agent: config.name, tool: call.name, isError: result.isError },
      `Tool ${call.name} ${result.isError ? "failed" : "completed"}`,
    );

    if (result.isError) {
      const codeMatch = /^\[([A-Z_]+)\]\s*/.exec(result.content);
      pendingEvents.push({
        type: "tool_call_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        tool: call.name,
        message: codeMatch ? result.content.slice(codeMatch[0].length) : result.content,
        ...(codeMatch?.[1] ? { code: codeMatch[1] } : {}),
      });
    }

    pendingEvents.push({
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
  const agentContext = {
    name: config.name,
    version: request.agent_version ?? "unknown",
    environmentId: request.environmentId ?? "default",
  };

  // First LLM call (with tool dispatch). Heartbeats track the OUTER LLM
  // wait — heartbeats from in-flight tool calls are pushed to
  // pendingEvents from inside onToolCall.
  heartbeatTimer = setInterval(() => {
    pendingEvents.push({
      type: "run_heartbeat",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      stage: "waiting_llm",
    });
  }, heartbeatMs);
  let llmResponse: Awaited<ReturnType<typeof router.call>>;
  try {
    llmResponse = await router.call(
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
      request.creatorKeys,
    );
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Flush all events accumulated during the LLM + tool dispatch phase.
  // Single-call LLMs without tools yield nothing here; tool-using runs
  // yield tool_call/tool_result/heartbeats now.
  for (const event of pendingEvents) yield event;
  pendingEvents.length = 0;

  yield {
    type: "llm_complete",
    run_id: request.runId,
    timestamp: new Date().toISOString(),
    provider: llmResponse.provider,
    model: llmResponse.model,
    tokens: llmResponse.usage.totalTokens,
  };

  logger.info(
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
    logger.warn(
      { event: "json_parse_fallback", agent: config.name },
      "Failed to parse JSON from LLM response, falling back to raw text",
    );
    output = { result: llmResponse.content };
  }

  if (config.state.type === "kv" && newState && stateCallbacks) {
    await stateCallbacks.setState(config.name, newState);
  }

  let aggPromptTokens = llmResponse.usage.promptTokens;
  let aggCompletionTokens = llmResponse.usage.completionTokens;
  let aggTotalTokens = llmResponse.usage.totalTokens;
  let aggCacheReadTokens = llmResponse.usage.cacheReadTokens;
  let aggCacheWriteTokens = llmResponse.usage.cacheWriteTokens;
  let aggCost = llmResponse.estimatedCost;

  // LLM08: enforce max_cost at each cost-accumulation point (here, after the
  // main call; and after the repair retry below) — NOT post-loop — so an
  // over-budget run aborts before more work. SSE/webhook carry the terminus as
  // a run_error event (an HTTP 402 is only reachable on the sync path, which
  // the FlyioAdapter does not implement).
  if (checkCost(aggCost, config.environment.max_cost).exceeded) {
    logger.warn(
      {
        event: "cost_exceeded",
        agent: config.name,
        estimated: aggCost,
        maxCost: config.environment.max_cost,
      },
      "Run cost exceeded max_cost — aborting",
    );
    yield {
      type: "run_error",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      error: {
        code: "COST_EXCEEDED",
        message: `Run cost ($${aggCost.toFixed(4)}) exceeded the configured max_cost ($${config.environment.max_cost}).`,
      },
    };
    return;
  }

  // Post-loop output validation against the agent's declared `outputs`
  // schema with single-attempt repair retry. Same rationale as before
  // (CMA/Bedrock/Vertex industry-default permissive recovery).
  if (config.outputs.length > 0) {
    const outputSchema = outputsToZod(config.outputs);
    const validation = outputSchema.safeParse(output);
    if (!validation.success) {
      yield {
        type: "output_validation_warning",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        errors: validation.error.issues,
      };
      logger.warn(
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

      // Heartbeats during the repair LLM call.
      const retryHeartbeat = setInterval(() => {
        pendingEvents.push({
          type: "run_heartbeat",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          stage: "waiting_llm",
        });
      }, heartbeatMs);
      let retryResponse: Awaited<ReturnType<typeof router.call>>;
      try {
        retryResponse = await router.call(
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
          request.creatorKeys,
        );
      } finally {
        clearInterval(retryHeartbeat);
      }
      for (const event of pendingEvents) yield event;
      pendingEvents.length = 0;

      yield {
        type: "llm_complete",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        provider: retryResponse.provider,
        model: retryResponse.model,
        tokens: retryResponse.usage.totalTokens,
      };

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
      if (checkCost(aggCost, config.environment.max_cost).exceeded) {
        logger.warn(
          {
            event: "cost_exceeded",
            agent: config.name,
            estimated: aggCost,
            maxCost: config.environment.max_cost,
          },
          "Run cost exceeded max_cost after the repair retry — aborting",
        );
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: {
            code: "COST_EXCEEDED",
            message: `Run cost ($${aggCost.toFixed(4)}) exceeded the configured max_cost ($${config.environment.max_cost}).`,
          },
        };
        return;
      }

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
        logger.warn({ event: "output_retry_parse_failed", agent: config.name }, retryParseError);
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: { code: "OUTPUT_SCHEMA_INVALID", message: retryParseError },
        };
        return;
      }

      const retryValidation = outputSchema.safeParse(retryOutput);
      if (!retryValidation.success) {
        const message = `Output validation failed after repair retry: ${JSON.stringify(retryValidation.error.issues)}`;
        logger.warn(
          {
            event: "output_retry_validation_failed",
            agent: config.name,
            issues: retryValidation.error.issues.length,
          },
          "Repair retry output still did not match declared schema",
        );
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: { code: "OUTPUT_SCHEMA_INVALID", message },
        };
        return;
      }

      output = retryOutput;
    }
  }

  const durationMs = Date.now() - startMs;

  logger.info(
    { event: "run_complete", agent: config.name, durationMs, cost: aggCost },
    "Agent run completed",
  );

  yield {
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
}

/**
 * Helper that wraps a long-running promise and yields periodic heartbeat
 * events of the given `stage` while it's in flight. Returns the promise's
 * resolved value via the generator's `return` channel — call sites use
 * `const value = yield* withHeartbeats(...)`.
 *
 * Used by `FlyioAdapter` to surface heartbeats around the outputs sync
 * upload (`stage: "uploading_outputs"`) since that work happens AFTER
 * `runAgentLoop` returns.
 */
export async function* withHeartbeats<T>(
  promise: Promise<T>,
  stage: RunHeartbeatEvent["stage"],
  runId: string,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<RunHeartbeatEvent, T> {
  let settled = false;
  let result!: T;
  let error: unknown;
  const settledPromise = promise.then(
    (v) => {
      result = v;
      settled = true;
    },
    (err) => {
      error = err;
      settled = true;
    },
  );
  while (!settled) {
    await Promise.race([settledPromise, new Promise((resolve) => setTimeout(resolve, intervalMs))]);
    if (!settled) {
      yield {
        type: "run_heartbeat",
        run_id: runId,
        timestamp: new Date().toISOString(),
        stage,
      };
    }
  }
  if (error) throw error;
  return result;
}
