// Agent execution loop shared by LocalAdapter and FlyioAdapter.
//
// Both adapters drive the same LLM-loop logic. Inside the loop, the only
// difference is the `ToolRegistry` they pass in (LocalAdapter wires real
// script + MCP providers; FlyioAdapter wires RPC stubs that forward to the
// runner machine). This helper centralises the loop so the two adapters cannot
// drift on prompt construction, output validation, repair retries, cost
// tracking, the tool results a run keeps, or event emission ordering. What
// follows the loop is each adapter's own: handling the output files, then
// committing the state write the loop handed over (see deferred-state.ts) —
// written once per adapter.
//
// `runAgentLoop` is an AsyncGenerator yielding RunEvents AS THEY HAPPEN
// (tool_call, tool_result, tool_call_error, llm_complete, run_heartbeat,
// output_validation_warning, and the terminal run_complete / run_error).
// Streaming directly via the generator — instead of collecting into an
// array — is what makes `run_heartbeat` useful: it flushes through SSE
// the moment it ticks, keeping callers + reverse proxies from declaring
// the connection idle during slow LLM / tool waits. The events a router
// call produces — tool dispatch, heartbeats — leave while the call is in
// flight (`whileAwaiting`), not when it returns.
//
// Heartbeat cadence: every `DEFAULT_HEARTBEAT_INTERVAL_MS` (30s) while
// one of the long awaits is in flight. Stages are `waiting_llm`,
// `waiting_tool`, and (cloud only, emitted by the adapter around this loop)
// `acquiring_runner` before it and `uploading_outputs` after it.

import { type ModelConfig, outputsToZod } from "@skrun-dev/schema";
import type { SkrunPart } from "../llm/parts.js";
import type { ToolCallRequest, ToolCallResult } from "../llm/providers/types.js";
import type { LLMRouter, LLMRouterResponse } from "../llm/router.js";
import { resolveToolChoice } from "../llm/tool-choice.js";
import type { Logger } from "../logger.js";
import { checkCost } from "../security/cost-checker.js";
import { parseTimeout } from "../security/timeout.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RunEvent, RunHeartbeatEvent, RunRequest } from "../types.js";
import { type ErrorFields, errorFields } from "../utils/error-fields.js";
import { exceedsNestingDepth, MAX_JSON_NESTING_DEPTH } from "../utils/json-depth.js";
import { jsonObjectSlice } from "../utils/json-slice.js";
import type { StateCallbacks } from "./local.js";
import { TOOL_ERROR_CODE, type ToolResultKept, ToolResultsBudget } from "./tool-results-budget.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The most bytes of UTF-8 the JSON object of a final answer — from its first
 * "{" to its last "}" (`jsonObjectSlice`) — may weigh before it is parsed, at
 * both sites: the first answer and the repair's. A larger one is not parsed:
 * the run ends on `OUTPUT_TOO_LARGE`. `JSON.parse` builds a tree many times the
 * text's size, which the run then keeps until it ends; an endpoint an agent
 * declares (`model.base_url`) answers what it likes. A text that holds no
 * such object is never parsed, and is kept as text. A constant: no setting
 * changes it.
 */
export const OUTPUT_PARSE_MAX_BYTES = 1024 * 1024;

/** What `OUTPUT_TOO_LARGE` says: the bound, never a content. */
const OUTPUT_TOO_LARGE_MESSAGE = `The JSON object of the model's final answer is larger than ${OUTPUT_PARSE_MAX_BYTES / (1024 * 1024)} MiB (${OUTPUT_PARSE_MAX_BYTES} bytes), the most an output may weigh before it is parsed. It was not parsed.`;

/**
 * What an output nested deeper than `MAX_JSON_NESTING_DEPTH` is told, as the
 * one issue of its validation. The schema of an `object` or `array` output
 * accepts any shape inside, and `JSON.parse` any depth: without this bound, an
 * output nested thousands of levels deep — an endpoint an agent declares
 * (`model.base_url`) answers what it likes — passed the loop, and writing it
 * to the caller then overflowed the stack.
 */
const OUTPUT_TOO_DEEP = `Output nested more than ${MAX_JSON_NESTING_DEPTH} levels deep (each object or array inside another is one more level)`;

/**
 * Why a tool call whose arguments nest deeper than `MAX_JSON_NESTING_DEPTH`
 * was not run, as the model reads it — an error result, the path of any
 * tool error — and as the run's `tool_call` event carries it in place of the
 * arguments. A model's arguments are parsed at any depth, and an endpoint an
 * agent declares (`model.base_url`) answers what it likes: arguments nested
 * thousands of levels deep broke the event's serialization, and the stream
 * stopped there.
 */
const TOOL_ARGS_TOO_DEEP = `Arguments nested more than ${MAX_JSON_NESTING_DEPTH} levels deep (the arguments themselves are the first level; each object or array inside another is one more): the tool was not called`;

/**
 * What a `_state` the run would hand over is told, as an issue of its output's
 * validation, when it nests deeper than `MAX_JSON_NESTING_DEPTH` — the bound
 * of every value a run is handed or returns. A notebook keeps it for the next
 * run's prompt; without this bound one kept what nothing else in a run may
 * carry, until a store's serializer failed on it.
 */
const STATE_TOO_DEEP = `"_state" is nested more than ${MAX_JSON_NESTING_DEPTH} levels deep (the state itself is the first level; each object or array inside another is one more).`;

/** The line the repair message gains when the state it would hand over is at fault. */
const STATE_REPAIR_RULE = `The "_state" field must be a JSON object of keys and values, nested at most ${MAX_JSON_NESTING_DEPTH} levels deep, or null to save no state.`;

/**
 * The model that wrote an answer of the router, as a model of its own and
 * without a fallback: the one the output repair is asked of. The primary keeps
 * its `base_url`; the fallback — which always calls its provider's own API —
 * never has one. Which of the two answered is told by the conversation the
 * answer comes with: its provider, its model and the destination it was held
 * with (`ConversationHistory.baseUrl`), a fallback of the primary's provider
 * and model differing from it by the destination alone. Without a declared
 * fallback, the primary answered.
 */
function answeringModel(model: ModelConfig, answer: LLMRouterResponse): ModelConfig {
  const { fallback, ...primary } = model;
  if (fallback === undefined) return primary;
  const held = answer.history;
  const primaryAnswered = held
    ? held.provider === model.provider &&
      held.model === model.name &&
      held.baseUrl === model.base_url
    : answer.provider === model.provider && answer.model === model.name;
  if (primaryAnswered) return primary;
  return {
    provider: fallback.provider,
    name: fallback.name,
    ...(model.temperature !== undefined && { temperature: model.temperature }),
  };
}

/**
 * Whether an answer's `_state` is no state at all: absent, `null`, or an empty
 * value — `""`, `0`, `false` —, which holds nothing to keep. Such a `_state`
 * writes nothing, leaves the notebook as it was, and is no fault.
 */
function isNoState(state: unknown): boolean {
  return state === undefined || state === null || state === "" || state === 0 || state === false;
}

/**
 * The validation issues of the `_state` a run would hand over: none when it is
 * no state (`isNoState`); else one when it is not a JSON object of keys and
 * values — the notebook is a key-value one — or when it nests deeper than
 * `MAX_JSON_NESTING_DEPTH`, the state itself the first level. The depth is
 * measured without recursion (`exceedsNestingDepth`), so no state makes this
 * throw.
 */
function stateIssues(state: unknown): unknown[] {
  if (isNoState(state)) return [];
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    const got = Array.isArray(state) ? "an array" : `a ${typeof state}`;
    return [
      {
        code: "custom",
        path: ["_state"],
        message: `"_state" must be a JSON object of keys and values, or null for no state — got ${got}.`,
      },
    ];
  }
  if (exceedsNestingDepth(state)) {
    return [{ code: "custom", path: ["_state"], message: STATE_TOO_DEEP }];
  }
  return [];
}

/**
 * An output's validation issues: the one of its nesting when it is deeper
 * than `MAX_JSON_NESTING_DEPTH` — its schema then not looked at —, else its
 * declared schema's; none when it passes. The depth is measured without
 * recursion (`exceedsNestingDepth`), so no output makes this throw.
 */
function outputIssues(
  schema: ReturnType<typeof outputsToZod>,
  output: Record<string, unknown>,
): unknown[] {
  if (exceedsNestingDepth(output)) return [{ code: "custom", path: [], message: OUTPUT_TOO_DEEP }];
  const validation = schema.safeParse(output);
  return validation.success ? [] : validation.error.issues;
}

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
 * (with `files: []` and `files_excluded: {}` — each adapter replaces both with
 * what it did with the run's output files) or `run_error`.
 */
export async function* runAgentLoop(opts: AgentLoopOptions): AsyncGenerator<RunEvent> {
  const { request, router, tools, stateCallbacks, logger, startMs } = opts;
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const config = request.agentConfig;
  // The run's deadline, handed to each call of the model: a request to the
  // agent's `model.base_url` is abandoned there, the read of its response
  // included. Taken at the loop's first step — the instant the adapter's
  // `withGeneratorTimeout` takes its own, both bodies starting at the first
  // `next()`. Never from `startMs`: on Fly that is taken before the machine
  // is acquired, and the run's timeout is armed after.
  const deadline = Date.now() + parseTimeout(config.environment.timeout);
  // What the run keeps of its model's answers, one budget for the run: the
  // first call and the repair count on it, and the router stops a call that
  // would take it past its bound (`RUN_MODEL_OUTPUT_MAX_BYTES`).
  const outputBudget = { usedBytes: 0 };

  let currentState: Record<string, unknown> | null = null;
  if (config.state.type === "kv" && stateCallbacks) {
    currentState = await stateCallbacks.getState(config.name);
  }

  const systemPrompt =
    config.context_mode === "persistent" && request.agentsMdContent
      ? request.agentsMdContent
      : request.skillContent;

  // Build text portion from non-file inputs only (file fields go in userContent as SkrunParts).
  // Each key is defined, not assigned: a `__proto__` field of the input stays a
  // field, where an assignment would set the copy's prototype and drop it.
  const fileFieldNames = new Set(config.inputs.filter((f) => f.type === "file").map((f) => f.name));
  const textOnlyInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request.input)) {
    if (fileFieldNames.has(k)) continue;
    Object.defineProperty(textOnlyInput, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
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

  // Events of the tool dispatch live on a side channel: the LLMRouter calls
  // `onToolCall` from inside its own loop, where we can't yield directly into
  // THIS generator. Tool calls, their results and errors, and the heartbeats
  // go into `events`, and each router call is awaited by `whileAwaiting`,
  // which yields them as they arrive — during the call, never only after it.
  const events = new EventQueue<RunEvent>();

  // What the run keeps of its tool results: each cut as the sandbox cuts it,
  // and their sum bounded — one per run, across the router's attempts. See
  // tool-results-budget.ts.
  const toolResults = new ToolResultsBudget();

  const onToolCall = async (call: ToolCallRequest): Promise<ToolCallResult> => {
    // Arguments nested deeper than the bound are never run, nor sent on: the
    // tool is not called, the model gets an error result naming the bound,
    // and the event carries that mention in place of the arguments. Measured
    // without recursion, no deeper than the first level past the bound.
    const tooDeep = exceedsNestingDepth(call.args);
    events.push({
      type: "tool_call",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      tool: call.name,
      args: tooDeep ? { _omitted: TOOL_ARGS_TOO_DEEP } : call.args,
    });

    let result: import("../tools/types.js").ToolResult;
    let kept: ToolResultKept;
    if (tooDeep) {
      // The loop's own result, of a fixed size like the marker: kept out of
      // the run's budget, so the model always reads that the tool was not
      // called, never the marker in its place.
      result = { content: TOOL_ARGS_TOO_DEEP, isError: true };
      kept = "whole";
    } else {
      // Heartbeat the tool wait: each tick goes out at once, like every event.
      let returned: import("../tools/types.js").ToolResult;
      const toolTimer = setInterval(() => {
        events.push(heartbeatEvent(request.runId, "waiting_tool"));
      }, heartbeatMs);
      try {
        returned = await tools.callTool(call.name, call.args);
      } finally {
        clearInterval(toolTimer);
      }
      // From here on, the result is what the run keeps — what the model reads
      // and what the events carry: cut, or the marker when the run's tool
      // results would pass their bound.
      ({ result, kept } = toolResults.keep(returned));
    }

    // `kept` says what the run kept of the result — whole, cut, or replaced by
    // the marker — so the line shows a run at its bounds; it never carries the
    // result itself.
    logger.info(
      { event: "tool_result", agent: config.name, tool: call.name, isError: result.isError, kept },
      `Tool ${call.name} ${result.isError ? "failed" : "completed"}`,
    );

    if (result.isError) {
      // The one rule for a code, which the marker of a result not kept follows
      // too: an error replaced keeps its code (tool-results-budget.ts).
      const codeMatch = TOOL_ERROR_CODE.exec(result.content);
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
  const agentContext = {
    name: config.name,
    version: request.agent_version ?? "unknown",
    environmentId: request.environmentId ?? "default",
  };

  // First LLM call (with tool dispatch). Its heartbeats track the OUTER LLM
  // wait; those of in-flight tool calls come from onToolCall. Every event
  // leaves while the call is in flight.
  const llmResponse = yield* whileAwaiting(
    router.call(
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
      { maxCost: config.environment.max_cost, deadline, outputBudget },
    ),
    events,
    () => heartbeatEvent(request.runId, "waiting_llm"),
    heartbeatMs,
  );

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

  // A call the router stopped on a bound is the run's end, read before
  // anything of its answer: nothing is extracted, parsed, validated or handed
  // over, and the run_error carries no usage — the fate of a run over its
  // max_cost. The router stops by return value, never by throwing, for the
  // reason it reports its spend ceiling so (see below): a thrown stop would
  // reach the adapters as a generic execution failure.
  if (llmResponse.stopped) {
    yield {
      type: "run_error",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      error: { code: llmResponse.stopped.code, message: llmResponse.stopped.message },
    };
    return;
  }

  let output: Record<string, unknown> = {};
  // The `_state` of the answer, whatever it is: set aside from the output,
  // which never carries it, and judged below when it is the state the run
  // would hand over.
  let firstState: unknown;

  // The answer's JSON object is weighed before it is parsed: past the bound,
  // the run ends there, nothing parsed.
  const jsonText = jsonObjectSlice(llmResponse.content);
  if (jsonText !== undefined) {
    const objectBytes = Buffer.byteLength(jsonText);
    if (objectBytes > OUTPUT_PARSE_MAX_BYTES) {
      // Counts and the bound only: never a content.
      logger.warn(
        {
          event: "model_bound_refused",
          agent: config.name,
          provider: llmResponse.provider,
          model: llmResponse.model,
          code: "OUTPUT_TOO_LARGE",
          limit: OUTPUT_PARSE_MAX_BYTES,
          kept_bytes: objectBytes,
        },
        "The JSON object of the model's final answer is larger than an output may weigh; it was not parsed",
      );
      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: { code: "OUTPUT_TOO_LARGE", message: OUTPUT_TOO_LARGE_MESSAGE },
      };
      return;
    }
  }

  try {
    if (jsonText !== undefined) {
      const parsed = JSON.parse(jsonText);
      firstState = parsed._state;
      delete parsed._state;
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

  let aggPromptTokens = llmResponse.usage.promptTokens;
  let aggCompletionTokens = llmResponse.usage.completionTokens;
  let aggTotalTokens = llmResponse.usage.totalTokens;
  let aggCacheReadTokens = llmResponse.usage.cacheReadTokens;
  let aggCacheWriteTokens = llmResponse.usage.cacheWriteTokens;
  let aggCost = llmResponse.estimatedCost;

  // LLM08: enforce max_cost at each cost-accumulation point (here, after the
  // main call; and after the repair retry below) — NOT post-loop — so an
  // over-budget run aborts before more work. The ceiling is also handed to the
  // router, which reads it after every tool-loop iteration and returns early:
  // the intention this comment has always stated now holds for the iterations
  // too, not just for the calls that bracket them.
  //
  // This remains the ONLY place the run stops for cost. The router reports its
  // early stop by return value and never throws, so the terminus below — the
  // same code, the same event shape — is reached whether the loop ran out of
  // iterations or ran out of budget. SSE/webhook carry it as a run_error event
  // (an HTTP 402 is only reachable on the sync path, which the FlyioAdapter
  // does not implement).
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
  // schema, and against the nesting bound (`outputIssues`), with
  // single-attempt repair retry. Same rationale as before
  // (CMA/Bedrock/Vertex industry-default permissive recovery).
  //
  // The same validation judges the state the run would hand over — one
  // validation of what the model returned: an agent that keeps a state (type
  // kv, run with its state callbacks) has its `_state` held to a JSON object of
  // at most `MAX_JSON_NESTING_DEPTH` levels (`stateIssues`). Any other agent
  // sets its `_state` aside, whatever it is, unjudged. The validation runs
  // whatever outputs are declared: an agent always declares one (the schema
  // requires it), and a loop handed none still has its state judged and its
  // output held to the nesting bound — `outputsToZod([])` takes any object.
  const judgesState = config.state.type === "kv" && stateCallbacks !== undefined;
  // The state the run hands over: the first answer's, unless a repair carries one.
  let stateToHandOver: unknown = firstState;
  const outputSchema = outputsToZod(config.outputs);
  const stateAtFault = judgesState ? stateIssues(firstState) : [];
  const issues = [...outputIssues(outputSchema, output), ...stateAtFault];
  if (issues.length > 0) {
    yield {
      type: "output_validation_warning",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      errors: issues,
    };
    logger.warn(
      {
        event: "output_validation_failed",
        agent: config.name,
        issues: issues.length,
      },
      "Final output did not match declared outputs schema — issuing repair retry",
    );

    const schemaDescription = config.outputs
      .map((o) => `  - ${o.name} (${o.type})${o.description ? `: ${o.description}` : ""}`)
      .join("\n");
    // A state at fault adds its rule, after the fields.
    const stateRule = stateAtFault.length > 0 ? `\n\n${STATE_REPAIR_RULE}` : "";
    const repairPrompt = `Your previous JSON output did not match the agent's declared output schema.

Validation errors:
${JSON.stringify(issues, null, 2)}

Required top-level fields (all required; extra keys allowed):
${schemaDescription}${stateRule}

Re-emit the output as a single JSON object matching this schema. Output only the JSON object, no commentary.`;

    // The retry continues the first call's conversation — its input, its
    // turns and their results, and the model's last turn, the output to
    // fix — with the repair message after it: asked to correct an output it
    // can no longer see, a model can only guess. On the iteration bound the
    // conversation ends on the last tool results: the output to fix is the
    // router's placeholder, in no turn, and the repair sees the results and
    // the validation errors its message quotes.
    //
    // It is asked of the model that answered — the primary, or the fallback
    // when it held the first call (`answeringModel`) —, the one whose
    // conversation it is, and with no fallback: another model would start
    // from the repair message alone, without the input nor the tools' results,
    // and guess. If that model fails, the run fails on its error.
    //
    // A conversation that carries tool calls goes back with the tools that
    // answered them declared — a request whose history calls an undeclared
    // tool may be refused — under a `none` choice and with no dispatch
    // handler: no tool runs during a repair.
    const conversation = llmResponse.history;
    const toolTurns =
      llmTools.length > 0 && conversation?.entries.some((e) => e.kind === "tool_results");

    // The repair LLM call beats like the first, while it is in flight.
    const retryResponse = yield* whileAwaiting(
      router.call(
        answeringModel(config.model, llmResponse),
        systemPrompt,
        [{ kind: "text", text: repairPrompt }],
        toolTurns ? llmTools : undefined,
        undefined,
        config.model.temperature,
        request.callerKeys,
        toolTurns ? { mode: "none" } : undefined,
        undefined,
        agentContext,
        request.creatorKeys,
        // The ceiling is passed for consistency with the main call, not to
        // close a gap: this retry hands the router no dispatch handler, so its
        // loop returns on the first iteration and the check below already
        // covers its single provider call. The budget of the model's answers
        // is the run's own: the repair's answer counts on what the first
        // call kept.
        {
          maxCost: config.environment.max_cost,
          history: conversation,
          deadline,
          outputBudget,
        },
      ),
      events,
      () => heartbeatEvent(request.runId, "waiting_llm"),
      heartbeatMs,
    );

    yield {
      type: "llm_complete",
      run_id: request.runId,
      timestamp: new Date().toISOString(),
      provider: retryResponse.provider,
      model: retryResponse.model,
      tokens: retryResponse.usage.totalTokens,
    };

    // The repair's call stopped on a bound ends the run the same way, before
    // its answer is read.
    if (retryResponse.stopped) {
      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: { code: retryResponse.stopped.code, message: retryResponse.stopped.message },
      };
      return;
    }

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

    // The caller is told the parser's message (run_error); the log line says
    // a fixed reason and, when the parser threw, the error's class — never
    // that message, which quotes the start of the model's output.
    let retryParseError: string | null = null;
    let retryParseReason = "";
    let retryParseFields: ErrorFields | undefined;
    let retryOutput: Record<string, unknown> = {};
    // The repair's `_state`, set aside from its output as the first answer's is,
    // and whether the repair carries the key at all.
    let retryState: unknown;
    let retryCarriesState = false;
    // The repair's JSON object is weighed before it is parsed too: past the
    // bound, the run ends on its own code, in place of OUTPUT_SCHEMA_INVALID.
    const retryJsonText = jsonObjectSlice(retryResponse.content);
    if (retryJsonText !== undefined) {
      const objectBytes = Buffer.byteLength(retryJsonText);
      if (objectBytes > OUTPUT_PARSE_MAX_BYTES) {
        // Counts and the bound only: never a content.
        logger.warn(
          {
            event: "model_bound_refused",
            agent: config.name,
            provider: retryResponse.provider,
            model: retryResponse.model,
            code: "OUTPUT_TOO_LARGE",
            limit: OUTPUT_PARSE_MAX_BYTES,
            kept_bytes: objectBytes,
          },
          "The JSON object of the repair's answer is larger than an output may weigh; it was not parsed",
        );
        yield {
          type: "run_error",
          run_id: request.runId,
          timestamp: new Date().toISOString(),
          error: { code: "OUTPUT_TOO_LARGE", message: OUTPUT_TOO_LARGE_MESSAGE },
        };
        return;
      }
    }
    try {
      if (retryJsonText !== undefined) {
        const parsed = JSON.parse(retryJsonText);
        retryCarriesState = Object.hasOwn(parsed, "_state");
        retryState = parsed._state;
        delete parsed._state;
        retryOutput = parsed;
      } else {
        retryParseReason = "Retry output did not contain a JSON object";
        retryParseError = retryParseReason;
      }
    } catch (err) {
      retryParseReason = "Retry output was not valid JSON";
      retryParseFields = errorFields(err);
      retryParseError = `${retryParseReason}: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (retryParseError) {
      logger.warn(
        { event: "output_retry_parse_failed", agent: config.name, ...retryParseFields },
        retryParseReason,
      );
      yield {
        type: "run_error",
        run_id: request.runId,
        timestamp: new Date().toISOString(),
        error: { code: "OUTPUT_SCHEMA_INVALID", message: retryParseError },
      };
      return;
    }

    // The repair fixes the output's format, not the run: a repaired answer
    // that carries the `_state` key gives the state handed over, whatever its
    // value — an empty one (`null`, `""`, `0`, `false`) is no state, as the
    // repair message offers: nothing is written, and it is no fault; one that
    // carries no such key keeps the state of the first answer — judged here
    // again, so a state at fault is never handed over, whichever answer
    // carries it.
    if (retryCarriesState) stateToHandOver = retryState;
    const retryIssues = [
      ...outputIssues(outputSchema, retryOutput),
      ...(judgesState ? stateIssues(stateToHandOver) : []),
    ];
    if (retryIssues.length > 0) {
      const message = `Output validation failed after repair retry: ${JSON.stringify(retryIssues)}`;
      logger.warn(
        {
          event: "output_retry_validation_failed",
          agent: config.name,
          issues: retryIssues.length,
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

  // The state is handed over once the loop's checks have passed, and only then:
  // a run the loop ends on run_error — over its cost, its output or its state
  // refused — hands over nothing. No state (`isNoState`) writes nothing, the
  // notebook left as it was. The adapters hold the write until the output files are
  // handled (deferred-state.ts), so a run that fails after the loop writes
  // nothing either; a failed write is thrown, and fails the run.
  if (judgesState && stateCallbacks && !isNoState(stateToHandOver)) {
    // Judged above: a JSON object of keys and values, within the nesting bound.
    await stateCallbacks.setState(config.name, stateToHandOver as Record<string, unknown>);
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
    files_excluded: {},
  };
}

function heartbeatEvent(runId: string, stage: RunHeartbeatEvent["stage"]): RunHeartbeatEvent {
  return { type: "run_heartbeat", run_id: runId, timestamp: new Date().toISOString(), stage };
}

/**
 * Events queued by code that cannot yield — a callback the router runs, a
 * timer — for a generator that drains them while it waits (`whileAwaiting`).
 */
class EventQueue<E> {
  private events: E[] = [];
  private wake: (() => void) | undefined;

  push(event: E): void {
    this.events.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  /** Every queued event, oldest first; the queue is left empty. */
  take(): E[] {
    const taken = this.events;
    this.events = [];
    return taken;
  }

  /** Settles on the next push, or at once when an event is already waiting. */
  next(): Promise<void> {
    if (this.events.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }
}

/**
 * Await `promise` and, while it is in flight, yield what `queue` receives as
 * it arrives — plus a `beat()` every `intervalMs`, pushed to the same queue.
 * The ticks stop the moment the promise settles; whatever was queued before is
 * yielded, then its value is the generator's return value (`const value =
 * yield* whileAwaiting(...)`), or its rejection is thrown.
 *
 * This is what keeps a wait from being silent for longer than one interval:
 * an event leaves when it happens, not when the awaited call returns.
 */
async function* whileAwaiting<T, E>(
  promise: Promise<T>,
  queue: EventQueue<E>,
  beat: () => E,
  intervalMs: number,
): AsyncGenerator<E, T> {
  const timer = setInterval(() => queue.push(beat()), intervalMs);
  let outcome: { value: T } | { error: unknown } | undefined;
  const settled = promise.then(
    (value) => {
      clearInterval(timer);
      outcome = { value };
    },
    (error: unknown) => {
      clearInterval(timer);
      outcome = { error };
    },
  );
  try {
    while (outcome === undefined) {
      await Promise.race([settled, queue.next()]);
      for (const event of queue.take()) yield event;
    }
    // What arrived while the last events were being consumed, the promise
    // settling in between.
    for (const event of queue.take()) yield event;
  } finally {
    clearInterval(timer);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * Helper that wraps a long-running promise and yields periodic heartbeat
 * events of the given `stage` while it's in flight, as each one ticks.
 * Returns the promise's resolved value via the generator's `return` channel —
 * call sites use `const value = yield* withHeartbeats(...)`.
 *
 * Used by `FlyioAdapter` to surface heartbeats around the two waits outside
 * `runAgentLoop`: acquiring the runner before it (`stage: "acquiring_runner"`)
 * and the outputs sync upload after it (`stage: "uploading_outputs"`). The
 * same mechanism as the loop's own waits, with nothing else queued.
 */
export async function* withHeartbeats<T>(
  promise: Promise<T>,
  stage: RunHeartbeatEvent["stage"],
  runId: string,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<RunHeartbeatEvent, T> {
  return yield* whileAwaiting(
    promise,
    new EventQueue<RunHeartbeatEvent>(),
    () => heartbeatEvent(runId, stage),
    intervalMs,
  );
}
