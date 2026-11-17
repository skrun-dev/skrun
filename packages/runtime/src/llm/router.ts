import {
  acceptsTemperature,
  getModelCapabilities,
  type ModelConfig,
  type ModelProvider,
} from "@skrun-dev/schema";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { checkCost } from "../security/cost-checker.js";
import { isPrivateHost } from "../security/network.js";
import { createGuardedFetch, ResponseBodyTooLargeError } from "../security/safe-fetch.js";
import { errorFields } from "../utils/error-fields.js";
import { hashCacheKey } from "./cache-key.js";
import { estimateCost } from "./cost.js";
import { LLMCapabilityError } from "./errors.js";
import { InMemoryProviderFileCache, type ProviderFileCache } from "./file-cache.js";
import type { SkrunPart } from "./parts.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GoogleProvider } from "./providers/google.js";
import {
  createGrokProvider,
  createGroqProvider,
  createMistralProvider,
  createOpenAIProvider,
  OpenAICompatibleProvider,
} from "./providers/openai.js";
import type {
  ConversationHistory,
  HistoryEntry,
  LLMCallResponse,
  LLMProvider,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinitionForLLM,
} from "./providers/types.js";
import type { ResolvedToolChoice } from "./tool-choice.js";

const MAX_TOOL_ITERATIONS = 10;

/**
 * The most tool calls one answer of the model may ask for. An answer that asks
 * for more runs none of them: the call stops on `TOO_MANY_TOOL_CALLS`. A
 * provider's own model is bounded by its output; an endpoint an agent declares
 * in `model.base_url` answers what it likes, and every call costs a turn, a
 * result and events that the conversation keeps and sends back at each turn.
 * A constant, like the iteration bound: no setting changes it.
 */
export const MAX_TOOL_CALLS_PER_TURN = 128;

/**
 * The most bytes one response of an endpoint an agent declares in
 * `model.base_url` may carry, counted once decoded. A larger one is not read
 * further: the call stops on `MODEL_RESPONSE_TOO_LARGE`. A provider called at
 * its own API is bounded by its model's output, and keeps its SDK's transport.
 * A constant: no setting changes it.
 */
export const MODEL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/** What `MODEL_RESPONSE_TOO_LARGE` says: the bound, never the endpoint's address. */
const MODEL_RESPONSE_TOO_LARGE_MESSAGE = `The response of the model endpoint the agent declares (model.base_url) is larger than ${MODEL_RESPONSE_MAX_BYTES / (1024 * 1024)} MiB (${MODEL_RESPONSE_MAX_BYTES} bytes), the most one response may weigh. It was not read further.`;

/**
 * The most bytes of the model's answers a run keeps, each answer counted as
 * the conversation keeps it: its turn exactly as the provider returned it
 * (text, reasoning, tool calls with their arguments as the model wrote them),
 * as JSON, in bytes of UTF-8. Every answer stays in the conversation and goes
 * back to the model at each turn; past this sum the call stops on
 * `MODEL_OUTPUT_BUDGET_EXCEEDED`. Counted over the run — its first call and
 * its output repair — when the caller hands both the same budget
 * (`call()`'s `opts.outputBudget`). A constant: no setting changes it.
 */
export const RUN_MODEL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** What `MODEL_OUTPUT_BUDGET_EXCEEDED` says: the bound, never a content. */
const MODEL_OUTPUT_BUDGET_EXCEEDED_MESSAGE = `The model's answers in this run weigh more than ${RUN_MODEL_OUTPUT_MAX_BYTES / (1024 * 1024)} MiB (${RUN_MODEL_OUTPUT_MAX_BYTES} bytes), the most a run keeps of them — each answer counted as the conversation keeps it, as the provider returned it: its text, its reasoning and its tool calls.`;

/**
 * What one answer weighs in the run's budget: its turn as the provider
 * returned it, as JSON, in bytes of UTF-8 — nothing when it carries none.
 */
function answerBytes(response: LLMCallResponse): number {
  return response.assistantTurn === undefined
    ? 0
    : Buffer.byteLength(JSON.stringify(response.assistantTurn));
}

/**
 * How long one call of the primary model may go unanswered (ms) before the
 * declared fallback takes over — as long as no tool of the call has run: once
 * one has, the fallback never takes over (it would run the tools again from
 * the input). The delay covers each call of the model, never the run of a
 * tool nor the whole tool loop: a primary slow over many turns is never cut
 * for it. It spares the wait on the provider SDK's own timeout (~180s) when a
 * first answer never comes. The delay of a router built without
 * `primaryFailoverMs` — the router never reads the environment: the API reads
 * SKRUN_PRIMARY_FAILOVER_MS at its start (`readPrimaryFailoverMs`) and builds
 * the run route's router with it. 45s: long enough for a legitimately slow
 * turn (large context / high thinking), ~4x faster than the SDK timeout on a
 * genuine hang. A constant: the variable is the setting.
 */
export const DEFAULT_PRIMARY_FAILOVER_MS = 45_000;

/** The longest delay a timer holds: past it, Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * SKRUN_PRIMARY_FAILOVER_MS, read the strict way. Unset → the default.
 * Set, it must be a whole number of milliseconds from 1 to 2147483647 once the
 * spaces around it are set aside; anything else — the empty string, `0`, a
 * negative, a fraction, `1e3`, `0x10`, past what a timer holds — throws,
 * naming the variable: the process that builds the run route's router reads it
 * at its start, which refuses to go on. `Number(x) || 45000` would take a
 * negative for an immediate failover, and Node would fire a delay past
 * 2147483647 ms after 1 ms.
 */
export function readPrimaryFailoverMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SKRUN_PRIMARY_FAILOVER_MS;
  if (raw === undefined) return DEFAULT_PRIMARY_FAILOVER_MS;
  const trimmed = raw.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!(ms >= 1 && ms <= MAX_TIMER_MS)) {
    throw new Error(
      `SKRUN_PRIMARY_FAILOVER_MS must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS} (got "${raw}"). Unset it to use the ${DEFAULT_PRIMARY_FAILOVER_MS} ms default.`,
    );
  }
  return ms;
}

/** Rejection of an attempt's failover when a call of the primary went unanswered too long — caught by the fallback path. */
class PrimaryFailoverTimeout extends Error {
  constructor(ms: number) {
    super(`Primary LLM call exceeded the ${ms}ms failover timeout — switching to fallback`);
    this.name = "PrimaryFailoverTimeout";
  }
}

/**
 * Thrown inside an attempt `call()` abandoned on its failover delay, when the
 * call of the model it was waiting on answers at last and asks for tools: the
 * attempt stops there, before handing a single one over — the fallback holds
 * the run. Nothing awaits that attempt any more: `call()` gave its promise a
 * neutral handler.
 */
class AttemptAbandoned extends Error {
  constructor() {
    super("The attempt was abandoned to the fallback; none of its tool calls is run");
    this.name = "AttemptAbandoned";
  }
}

/**
 * The failover of a primary that has a fallback: how long a call of its model
 * may go unanswered (`ms`), and what `call()` races the attempt against
 * (`timedOut`) — rejected on `PrimaryFailoverTimeout` by the timer the tool
 * loop arms around each call of the model while no tool has run (`fire`).
 */
interface Failover {
  ms: number;
  timedOut: Promise<never>;
  fire: (reason: PrimaryFailoverTimeout) => void;
}

function failoverOf(ms: number): Failover {
  let fire: (reason: PrimaryFailoverTimeout) => void = () => undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    fire = reject;
  });
  return { ms, timedOut, fire };
}

/** Why a call stopped on a bound (`LLMRouterResponse.stopped`). */
type RouterStop = NonNullable<LLMRouterResponse["stopped"]>;

/**
 * What `call()` keeps of one model's attempt, shared with its tool loop and
 * read again once the attempt has ended: whether the fallback may still take
 * over depends on it. `toolsServed` counts the calls handed to `onToolCall` —
 * the first dispatch counts, whatever its result. `outputBytes` sums what the
 * attempt's answers weigh (`answerBytes`), each counted as it arrives: added
 * to the run's budget when the attempt is the one returned, dropped when the
 * fallback replaces it. `controller` is aborted when `call()` abandons the
 * attempt to the fallback on its failover delay: the loop reads it before each
 * tool it would hand over, and hands none once it is aborted. `failover` is set
 * for the primary of a model that declares a fallback only.
 */
interface Attempt {
  toolsServed: number;
  outputBytes: number;
  controller: AbortController;
  failover?: Failover;
}

/**
 * The bytes of the model's answers a run has kept so far, across its calls of
 * the router — its first call and its output repair. The caller creates one
 * per run and hands it to each call; `call()` adds to it what the attempt it
 * returns has kept.
 */
interface ModelOutputBudget {
  usedBytes: number;
}

/**
 * What a primary stopped on a bound spent before the fallback replaced it:
 * the tokens of the answers it was billed for — the refused one included —,
 * and their cost estimated at the primary's model's price. The run keeps them
 * in its usage and its cost; a primary that failed has none, no usage of its
 * having been read.
 */
interface ReplacedSpend {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/** The spend of an attempt of `model` whose answers counted `usage`. */
function spendOf(
  model: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): ReplacedSpend {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost: estimateCost(
      model,
      usage.promptTokens,
      usage.completionTokens,
      cacheReadTokens || undefined,
      cacheWriteTokens || undefined,
    ),
  };
}

/**
 * Whether the fallback may take over from a stopped attempt of the primary: a
 * stop the fallback may not meet in its turn — an answer that asked for more
 * tool calls than a turn may carry, or a response of the agent's `base_url`
 * larger than one may weigh (the fallback never calls that endpoint) —, and no
 * tool of the attempt has run yet (which is the same as its first answer: a
 * second one is only asked for once the calls of the first were dispatched).
 * Otherwise the stop is the call's answer — always so for the budget of the
 * model's answers (`MODEL_OUTPUT_BUDGET_EXCEEDED`): those answers come from
 * the model itself, whichever one answers.
 */
function fallbackMayTakeOver(stop: RouterStop, attempt: Attempt): boolean {
  return (
    (stop.code === "TOO_MANY_TOOL_CALLS" || stop.code === "MODEL_RESPONSE_TOO_LARGE") &&
    attempt.toolsServed === 0
  );
}

/**
 * Thrown inside `call()` when the primary's attempt stopped on a bound the
 * fallback may take over from — caught by the fallback path like a failure.
 * It never leaves `call()`: it is thrown only when a fallback is declared.
 */
class PrimaryStopped extends Error {
  constructor(stop: RouterStop) {
    super(stop.message);
    this.name = "PrimaryStopped";
  }
}

export interface LLMRouterResponse {
  content: string;
  /**
   * Aggregated token usage across all tool-loop iterations of a single run —
   * those of a primary stopped on a bound that the fallback replaced
   * included: its answers were billed. `estimatedCost` prices each attempt's
   * tokens at its own model. Cache fields sum the per-iteration values
   * reported by the provider adapter. See `LLMCallResponse.usage` JSDoc for
   * the per-iteration semantic.
   *
   * - `promptTokens`: sum of full-rate prompt tokens (cached portion excluded).
   * - `completionTokens`: sum of output tokens.
   * - `totalTokens`: sum of input + output (legacy field, full-rate only).
   *   NOTE: `totalTokens` does NOT include `cacheReadTokens` or `cacheWriteTokens`
   *   to preserve back-compat with existing consumers that read it as "compute
   *   total tokens billed at full rate" — the cached portion is tracked separately.
   * - `cacheReadTokens` / `cacheWriteTokens`: optional, summed across iterations,
   *   undefined when no provider in the chain reported any cache activity.
   */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  estimatedCost: number;
  provider: string;
  model: string;
  durationMs: number;
  /**
   * Set when the tool loop stopped early because `maxCost` was already passed.
   * Optional, so it is additive for every existing consumer: absent means the
   * loop ran to its natural end.
   *
   * The flag makes the early stop OBSERVABLE; it is not itself a terminus. The
   * caller keeps its own cost check on `estimatedCost` and emits the run error
   * it already owns — this response carries the very number that check reads.
   */
  costExceeded?: boolean;
  /**
   * Set when the call stopped on a bound of what the model may make the
   * process keep: an answer that asked for more than `MAX_TOOL_CALLS_PER_TURN`
   * tool calls, none of which ran (`TOO_MANY_TOOL_CALLS`); a response of the
   * agent's `model.base_url` larger than `MODEL_RESPONSE_MAX_BYTES`, not read
   * further (`MODEL_RESPONSE_TOO_LARGE`); an answer that took what the run
   * keeps of the model's answers past `RUN_MODEL_OUTPUT_MAX_BYTES`, its calls
   * not run (`MODEL_OUTPUT_BUDGET_EXCEEDED`). `content` is then empty, and
   * `usage` and `estimatedCost` count every turn the model answered — a
   * refused answer included (it was billed), a response refused unread not
   * (its usage was never read). Unlike `costExceeded`, this IS the end of the
   * call: the caller ends the run on `code`, with `message` as its text,
   * before reading `content`. Optional, so it is additive for every existing
   * consumer: absent means the call was not stopped on a bound.
   */
  stopped?: {
    code: "TOO_MANY_TOOL_CALLS" | "MODEL_RESPONSE_TOO_LARGE" | "MODEL_OUTPUT_BUDGET_EXCEEDED";
    message: string;
  };
  /**
   * The conversation of the attempt that produced `content`, for a later call
   * to continue (`call()`'s `opts.history`): the input, then each assistant
   * turn exactly as the provider returned it with the tool results that
   * answered it. The last turn is included when it answered — not when its
   * tool calls got no result (the loop stopped on `max_cost` or on a bound
   * before running them, or no handler ran them): a provider refuses a call
   * without its result, so what is returned can always be sent back as is. On the
   * iteration bound, the conversation ends on the last tool results. Bound to
   * `provider`, `model` and the destination the attempt called
   * (`ConversationHistory.baseUrl`).
   *
   * It carries the model's own output: never logged, never persisted.
   * Optional, so it is additive for every existing consumer.
   */
  history?: ConversationHistory;
}

export type ToolCallHandler = (call: ToolCallRequest) => Promise<ToolCallResult>;

/**
 * Everything one tool-loop pass needs. An options object rather than a
 * positional list: the loop already threads a dozen mostly-optional values, and
 * at that width the call sites stop being readable — a misplaced `undefined`
 * silently becomes another parameter's value.
 */
interface ToolLoopOptions {
  provider: string;
  model: string;
  systemPrompt: string;
  userContent: SkrunPart[];
  tools?: ToolDefinitionForLLM[];
  onToolCall?: ToolCallHandler;
  temperature?: number;
  callerKeys?: Record<string, string>;
  baseUrl?: string;
  fileCache?: ProviderFileCache;
  toolChoice?: ResolvedToolChoice;
  parallelTools?: boolean;
  cacheKey?: string;
  creatorKeys?: Record<string, string>;
  /** Spend ceiling for this pass, in USD. Undefined leaves the loop bounded only by its iteration count. */
  maxCost?: number;
  /**
   * What the attempt this pass replaces already spent, estimated at its own
   * model's price (USD): the fallback that takes over from a primary stopped
   * on a bound, whose refused answer was billed. The ceiling is read on it
   * plus this pass's own spend — the pass is handed what is left of
   * `maxCost`. Undefined: nothing before this pass.
   */
  spentBefore?: number;
  /**
   * A conversation this pass continues — already checked to come from this
   * pass's provider, model and destination. Undefined starts from
   * `userContent` alone.
   */
  history?: ConversationHistory;
  /** The attempt this pass is, which `call()` reads again once it has ended. */
  attempt: Attempt;
  /**
   * What the run has kept of the model's answers before this pass: the pass
   * stops once its own answers (`attempt.outputBytes`) take the sum past
   * `RUN_MODEL_OUTPUT_MAX_BYTES`. Read only: `call()` adds to it.
   */
  outputBudget: Readonly<ModelOutputBudget>;
  /**
   * The instant (ms, `Date.now()`'s clock) the run ends at. A request to the
   * agent's `model.base_url` is abandoned there, the read of its response
   * included. Undefined: no deadline of the call's own.
   */
  deadline?: number;
}

/**
 * Agent identity passed to the router for prompt-cache routing.
 *
 * The router hashes (`hashCacheKey()`) `${name}@${version}+${environmentId}`
 * once per call and threads the resulting hex digest as `cacheKey` into each
 * provider iteration. Provider adapters use it as their cache routing
 * primitive (OpenAI body field, xAI Grok header, etc.). Anthropic and Gemini
 * don't consume it — they cache via cache_control / implicit prefix detection.
 *
 * Optional — when undefined (e.g. dev-mode raw call), `cacheKey` stays
 * undefined and adapters fall back to no-key behavior.
 */
export interface AgentContext {
  name: string;
  version: string;
  environmentId: string;
}

/**
 * Whether this server may direct a model call at a private / loopback address.
 *
 * Fail-closed, mirroring `SKRUN_ALLOW_LOCAL_WEBHOOKS`: an operator running a local
 * inference server (Ollama / vLLM / LocalAI — documented in docs/agent-yaml.md)
 * opts in explicitly, and a multi-tenant deployment never does.
 */
function localModelHostsAllowed(): boolean {
  return process.env.SKRUN_ALLOW_LOCAL_MODEL_HOSTS === "true";
}

/**
 * Whether this server may pair its OWN provider key with an agent-declared
 * `base_url`. Fail-closed: safe only where every agent is authored by the
 * operator (single-tenant self-host).
 */
function serverKeyWithCustomBaseUrlAllowed(): boolean {
  return process.env.SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL === "true";
}

/**
 * Where the key for one provider comes from, or why no key can be used.
 *
 * - `caller` — the request's `X-LLM-API-Key` names the provider;
 * - `creator` — a key the agent's owner attached to the agent;
 * - `server-base-url` — the agent declares `model.base_url` and the operator
 *   allows the server's own key (possibly none) to go to it;
 * - `server` — a provider the server registered from its environment.
 *
 * Refusals: `meta-needs-base-url` (the provider is meta, which has no endpoint
 * of its own, and no `model.base_url` is given: no key at any tier serves it —
 * a fallback included, which is never sent to one), `no-key` (no tier has a
 * key), `base-url-needs-own-key` (the agent declares `model.base_url`, and the
 * server does not send its own key there).
 */
export type KeySource =
  | { tier: "caller" | "creator" | "server-base-url" | "server" }
  | { refused: "meta-needs-base-url" | "no-key" | "base-url-needs-own-key" };

/** The key decision for each model of a run (`LLMRouter.checkModelKeys`). */
export interface ModelKeys {
  primary: KeySource;
  /** Absent when the agent declares no fallback model. */
  fallback?: KeySource;
  /** The primary, or else the fallback, finds a key: the run can start. */
  servable: boolean;
}

export interface KeySourceInputs {
  callerKeys?: Record<string, string>;
  creatorKeys?: Record<string, string>;
  baseUrl?: string;
  /** The server registered this provider from its environment. */
  serverHasProvider: boolean;
  /** The operator lets the server's own key go to an agent-declared `base_url`. */
  serverKeyWithBaseUrlAllowed: boolean;
}

/**
 * The key decision, in one place: caller > creator > server, a declared
 * `base_url` being orthogonal to the tier except for the server's own key —
 * and, before any tier, meta without a `base_url`, which no key serves.
 * Pure — it builds no provider, validates no URL and reads no environment.
 * The router acts on it; the run route asks it before any machine exists
 * (`LLMRouter.checkKeyResolvable`).
 */
export function resolveKeySource(provider: string, inputs: KeySourceInputs): KeySource {
  // The router has a client for every provider but meta: only an
  // OpenAI-compatible endpoint the agent declares serves it.
  if (provider === "meta" && !inputs.baseUrl) return { refused: "meta-needs-base-url" };
  if (inputs.callerKeys?.[provider]) return { tier: "caller" };
  if (inputs.creatorKeys?.[provider]) return { tier: "creator" };
  if (inputs.baseUrl) {
    return inputs.serverKeyWithBaseUrlAllowed
      ? { tier: "server-base-url" }
      : { refused: "base-url-needs-own-key" };
  }
  if (inputs.serverHasProvider) return { tier: "server" };
  return { refused: "no-key" };
}

function unknownProviderError(providerName: string): Error {
  return new Error(`Unknown provider: "${providerName}"`);
}

function noKeyError(providerName: string): Error {
  return new Error(
    `No API key available for provider "${providerName}". Provide one via the X-LLM-API-Key header, attach a creator key to the agent, or set the ${providerName.toUpperCase()}_API_KEY env var.`,
  );
}

/**
 * Validate an agent-declared `base_url` before it becomes the destination of a
 * request that carries an API key.
 *
 * `base_url` is a deliberate feature — alternative OpenAI-compatible providers and
 * local inference servers. What it cannot be allowed to do is choose where SOMEONE
 * ELSE'S credential goes: it is declared in `agent.yaml` by the agent AUTHOR, while
 * the key on the request may belong to the OPERATOR (server tier) or to the CALLER
 * (`X-LLM-API-Key`). And because the LLM loop runs in the harness rather than the
 * sandbox, an unchecked value also reaches hosts the agent's own `allowed_hosts`
 * egress rules exist to keep it away from.
 */
function assertModelBaseUrlAllowed(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`model.base_url is not a valid URL: "${baseUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `model.base_url must use http or https (got "${parsed.protocol}" in "${baseUrl}").`,
    );
  }
  if (!localModelHostsAllowed() && isPrivateHost(parsed.hostname)) {
    throw new Error(
      `model.base_url host "${parsed.hostname}" is a private or reserved address. ` +
        "Set SKRUN_ALLOW_LOCAL_MODEL_HOSTS=true on this server to allow a local " +
        "inference endpoint (Ollama / vLLM / LocalAI).",
    );
  }
}

/** How a router is built, beyond its logger. */
export interface LLMRouterOptions {
  /**
   * How long one call of the primary model may go unanswered (ms) before a
   * declared fallback takes over, while no tool of the call has run.
   * Undefined: `DEFAULT_PRIMARY_FAILOVER_MS`. The API passes the value it read
   * at its start (`readPrimaryFailoverMs`).
   */
  primaryFailoverMs?: number;
}

export class LLMRouter {
  private providers = new Map<string, LLMProvider>();
  private logger: Logger;
  private readonly primaryFailoverMs: number;

  constructor(logger?: Logger, opts?: LLMRouterOptions) {
    this.logger = logger ?? createLogger("llm");
    this.primaryFailoverMs = opts?.primaryFailoverMs ?? DEFAULT_PRIMARY_FAILOVER_MS;
    // Register available providers based on env keys
    if (process.env.ANTHROPIC_API_KEY) {
      this.providers.set("anthropic", new AnthropicProvider());
    }
    if (process.env.OPENAI_API_KEY) {
      this.providers.set("openai", createOpenAIProvider());
    }
    if (process.env.GOOGLE_API_KEY) {
      this.providers.set("google", new GoogleProvider());
    }
    if (process.env.MISTRAL_API_KEY) {
      this.providers.set("mistral", createMistralProvider());
    }
    if (process.env.GROQ_API_KEY) {
      this.providers.set("groq", createGroqProvider());
    }
    if (process.env.XAI_API_KEY) {
      this.providers.set("xai", createGrokProvider());
    }
  }

  /** For testing: register a provider manually */
  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  async call(
    modelConfig: ModelConfig,
    systemPrompt: string,
    userContent: SkrunPart[] | string,
    tools?: ToolDefinitionForLLM[],
    onToolCall?: ToolCallHandler,
    temperature?: number,
    callerKeys?: Record<string, string>,
    toolChoice?: ResolvedToolChoice,
    parallelTools?: boolean,
    agentContext?: AgentContext,
    creatorKeys?: Record<string, string>,
    /**
     * Terminal options bag rather than one more positional slot — the list above
     * is already at the width where a misplaced `undefined` lands in the wrong
     * parameter.
     *
     * `history` — a conversation a previous call returned
     * (`LLMRouterResponse.history`), to continue: `userContent` is appended to
     * it as the next user message. Applied only to the attempt whose provider
     * AND model produced it — a turn is valid only for the model that wrote it
     * — at the same destination: the agent's `model.base_url` for both, or
     * neither. Behind a declared endpoint the adapter is OpenAI-compatible
     * under the provider's name, so the name alone does not tell the shape of
     * a turn. Ignored by any other attempt, which starts from `userContent`
     * alone, as without it.
     *
     * `deadline` — the instant (ms, `Date.now()`'s clock) the run ends at: a
     * request to the agent's `model.base_url` is abandoned there, the read of
     * its response included. A provider called at its own API keeps its SDK's
     * transport, and its own timeout.
     *
     * `outputBudget` — what the run has kept of the model's answers so far,
     * one object per run handed to each of its calls: the call stops once its
     * answers take the sum past `RUN_MODEL_OUTPUT_MAX_BYTES`, and adds to it
     * the answers of the attempt it returns — never those of a primary the
     * fallback replaced. Undefined: the call counts its own answers from zero.
     */
    opts?: {
      maxCost?: number;
      history?: ConversationHistory;
      deadline?: number;
      outputBudget?: ModelOutputBudget;
    },
  ): Promise<LLMRouterResponse> {
    const start = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;

    // Accept legacy string for backward compat — wrap into a single text part.
    const parts: SkrunPart[] =
      typeof userContent === "string" ? [{ kind: "text", text: userContent }] : userContent;

    // Per-run provider file cache. Discarded at end of this call.
    const fileCache = new InMemoryProviderFileCache();

    // Prompt-cache routing key. Computed once per call from the agent
    // context. Threaded as `cacheKey` into every provider iteration so all
    // tool-loop iterations share the same cache pool. Undefined when no
    // agent context (e.g. dev-mode raw call) → adapters skip cache routing.
    const cacheKey = agentContext
      ? hashCacheKey(agentContext.name, agentContext.version, agentContext.environmentId)
      : undefined;

    // The caller's conversation goes only to the attempt of the provider,
    // model and destination that produced it: a primary behind the agent's
    // `base_url` and a fallback of the same provider and model at its own API
    // share a name, not the shape of their turns. Each attempt otherwise holds
    // its own: the two passes below share no state, so a fallback starts from
    // the input, never from what the primary accumulated before failing.
    const continued = (
      provider: string,
      model: string,
      baseUrl: string | undefined,
    ): ConversationHistory | undefined =>
      opts?.history?.provider === provider &&
      opts.history.model === model &&
      opts.history.baseUrl === baseUrl
        ? opts.history
        : undefined;

    // What the run has kept of the model's answers: the caller's, shared by
    // the calls of a run, or this call's own.
    const outputBudget: ModelOutputBudget = opts?.outputBudget ?? { usedBytes: 0 };

    // Try primary provider. Only a primary with a fallback to hand over to is
    // timed: without one, a slow call is waited on.
    const primaryAttempt: Attempt = {
      toolsServed: 0,
      outputBytes: 0,
      controller: new AbortController(),
      ...(modelConfig.fallback && { failover: failoverOf(this.primaryFailoverMs) }),
    };
    // The primary's stop the fallback takes over from, when that is why the
    // fallback path runs: logged by its code, the failure fields left to errors.
    let handedOver: RouterStop | undefined;
    // What that stopped primary spent — its refused answer was billed —, which
    // the run's usage and cost keep, and the fallback's ceiling starts from.
    let replaced: ReplacedSpend | undefined;
    // Its conversation, returned with the call when nothing of the ceiling is
    // left for the fallback.
    let replacedHistory: ConversationHistory | undefined;
    try {
      // When a fallback is configured, the attempt races its failover: a call
      // of the primary's model that goes unanswered past the delay, while no
      // tool has run, hands the run to the fallback fast (instead of blocking
      // on the provider SDK's ~180s timeout). The rejection is handled by the
      // catch → fallback path below.
      const primaryCall = this.callWithToolLoop({
        provider: modelConfig.provider,
        model: modelConfig.name,
        systemPrompt,
        userContent: parts,
        tools,
        onToolCall,
        temperature: temperature ?? modelConfig.temperature,
        callerKeys,
        baseUrl: modelConfig.base_url,
        fileCache,
        toolChoice,
        parallelTools,
        cacheKey,
        creatorKeys,
        maxCost: opts?.maxCost,
        history: continued(modelConfig.provider, modelConfig.name, modelConfig.base_url),
        attempt: primaryAttempt,
        outputBudget,
        deadline: opts?.deadline,
      });
      const failover = primaryAttempt.failover;
      // An attempt abandoned on its failover delay goes on in the background
      // until its call of the model answers, then stops before any tool
      // (`AttemptAbandoned`) or ends on its own: nothing awaits it any more.
      if (failover) primaryCall.catch(() => undefined);
      const result = failover
        ? await Promise.race([primaryCall, failover.timedOut])
        : await primaryCall;
      // A stop the fallback may take over from goes down the fallback path, the
      // primary's usage kept with the call's — its answers were billed, unlike
      // those of a primary that failed, of which no usage was read; any other
      // stop is the call's answer, with the usage of the turns made.
      if (
        modelConfig.fallback &&
        result.stopped &&
        fallbackMayTakeOver(result.stopped, primaryAttempt)
      ) {
        handedOver = result.stopped;
        replaced = spendOf(modelConfig.name, result.usage);
        replacedHistory = result.history;
        throw new PrimaryStopped(result.stopped);
      }
      // The attempt returned is the one whose answers the run keeps; those of
      // a primary the fallback replaces are dropped with it.
      outputBudget.usedBytes += primaryAttempt.outputBytes;
      totalPromptTokens += result.usage.promptTokens;
      totalCompletionTokens += result.usage.completionTokens;
      totalCacheReadTokens += result.usage.cacheReadTokens ?? 0;
      totalCacheWriteTokens += result.usage.cacheWriteTokens ?? 0;

      return this.buildResponse(
        result.content,
        totalPromptTokens,
        totalCompletionTokens,
        modelConfig.provider,
        modelConfig.name,
        start,
        totalCacheReadTokens,
        totalCacheWriteTokens,
        result.costExceeded,
        result.history,
        result.stopped,
      );
    } catch (primaryError) {
      // Try fallback — only while no tool of the primary has run. The attempt
      // is read again here whatever ended it: a stop handed over, an error of
      // its provider, its failover delay, or an error its loop threw after a
      // tool was handed over. Once a tool has run, the fallback would start
      // from the input and run the tools again: the call fails instead.
      if (modelConfig.fallback) {
        // A stopped primary whose billed answers alone spent the whole ceiling —
        // past it, as the caller's own check reads it (`checkCost`) — leaves the
        // fallback nothing: it is not called, and no call more is billed.
        const ceilingSpent =
          replaced !== undefined && checkCost(replaced.cost, opts?.maxCost).exceeded;
        const takesOver = primaryAttempt.toolsServed === 0 && !ceilingSpent;
        // The provider error by its class, code and HTTP status, never its
        // message: a 401/4xx can echo a key fragment or quote the request it
        // refused. The status tells a rate limit from a refused key. A stop by
        // its code alone: its message carries nothing the code does not say.
        this.logger.warn(
          {
            event: "primary_failed",
            provider: modelConfig.provider,
            model: modelConfig.name,
            tools_served: primaryAttempt.toolsServed,
            fallback: takesOver,
            ...(handedOver ? { stop: handedOver.code } : errorFields(primaryError)),
          },
          takesOver
            ? "Primary LLM failed, trying fallback"
            : ceilingSpent
              ? "Primary LLM stopped once its answers had spent the whole max_cost; the fallback does not take over"
              : "Primary LLM failed after a tool ran; the fallback does not take over",
        );
        if (ceilingSpent && replaced !== undefined && handedOver !== undefined) {
          // The call is the primary's stop, as for a primary without a fallback:
          // the caller reads the bound before the cost, and ends the run on the
          // bound's code — the primary's usage and cost counted.
          outputBudget.usedBytes += primaryAttempt.outputBytes;
          return this.buildResponse(
            "",
            replaced.promptTokens,
            replaced.completionTokens,
            modelConfig.provider,
            modelConfig.name,
            start,
            replaced.cacheReadTokens,
            replaced.cacheWriteTokens,
            false,
            replacedHistory,
            handedOver,
          );
        }
        if (!takesOver) throw primaryError;

        // The fallback hands over to no one: its stops are returned as they are.
        // It starts with the budget the run had before this call: the primary's
        // answers, which it replaces, are not counted. Its spend ceiling is what
        // a stopped primary left of `maxCost` (`spentBefore`).
        const fallbackAttempt: Attempt = {
          toolsServed: 0,
          outputBytes: 0,
          controller: new AbortController(),
        };
        const result = await this.callWithToolLoop({
          provider: modelConfig.fallback.provider,
          model: modelConfig.fallback.name,
          systemPrompt,
          userContent: parts,
          tools,
          onToolCall,
          temperature: temperature ?? modelConfig.temperature,
          callerKeys,
          baseUrl: undefined,
          fileCache,
          toolChoice,
          parallelTools,
          cacheKey,
          creatorKeys,
          maxCost: opts?.maxCost,
          spentBefore: replaced?.cost,
          // The fallback always calls its provider's own API (no base_url).
          history: continued(modelConfig.fallback.provider, modelConfig.fallback.name, undefined),
          attempt: fallbackAttempt,
          outputBudget,
          deadline: opts?.deadline,
        });
        outputBudget.usedBytes += fallbackAttempt.outputBytes;
        totalPromptTokens += result.usage.promptTokens;
        totalCompletionTokens += result.usage.completionTokens;
        totalCacheReadTokens += result.usage.cacheReadTokens ?? 0;
        totalCacheWriteTokens += result.usage.cacheWriteTokens ?? 0;

        return this.buildResponse(
          result.content,
          totalPromptTokens,
          totalCompletionTokens,
          modelConfig.fallback.provider,
          modelConfig.fallback.name,
          start,
          totalCacheReadTokens,
          totalCacheWriteTokens,
          result.costExceeded,
          result.history,
          result.stopped,
          replaced,
        );
      }
      throw primaryError;
    }
  }

  private async callWithToolLoop(opts: ToolLoopOptions): Promise<{
    content: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    costExceeded?: boolean;
    stopped?: RouterStop;
    history: ConversationHistory;
  }> {
    const {
      provider,
      model,
      systemPrompt,
      userContent,
      tools,
      onToolCall,
      temperature,
      callerKeys,
      baseUrl,
      fileCache,
      toolChoice,
      parallelTools,
      cacheKey,
      creatorKeys,
      maxCost,
      spentBefore = 0,
      history,
      attempt,
      outputBudget,
      deadline,
    } = opts;
    const llmProvider = this.resolveProvider(provider, callerKeys, baseUrl, creatorKeys, deadline);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;

    // The conversation of this pass, in each provider's own shape: the input,
    // then every assistant turn as the provider returned it and the results
    // that answered it. In memory for this call only — never logged, never
    // persisted, never handed to another pass. Continuing a conversation
    // appends `userContent` to it as the next user message.
    const input = history ? history.input : userContent;
    const entries: HistoryEntry[] = history
      ? [...history.entries, { kind: "user", parts: userContent }]
      : [];
    // What this returns can always be sent back as is. A last turn whose calls
    // got no results — the loop stopped before running them, or had no handler
    // to run them — is left out: a provider refuses a call without its result.
    const conversation = (unanswered = false): ConversationHistory => ({
      provider,
      model,
      // The destination, where there is one to say: the conversation goes
      // back only there.
      ...(baseUrl !== undefined && { baseUrl }),
      input,
      entries: unanswered ? entries.slice(0, -1) : entries,
    });

    // Defense-in-depth capability check: refuse non-text content the model can't handle.
    // The primary gate runs at `skrun deploy/push` (capability check); this catches any drift.
    this.checkCapabilities(provider, model, history ? [...input, ...userContent] : userContent);

    // What this attempt's model accepts of the declared settings, decided once
    // for every turn of the attempt.
    const sentTemperature = this.temperatureFor(provider, model, temperature, baseUrl);
    const firstToolChoice = this.toolChoiceFor(provider, model, toolChoice);

    // Derive deprecated userMessage alias from text parts for backward-compat
    // with provider impls that haven't been migrated to userContent.
    const userMessage = input
      .filter((p): p is Extract<SkrunPart, { kind: "text" }> => p.kind === "text")
      .map((p) => p.text)
      .join("\n");

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      // Apply tool-choice only on the FIRST iteration. Once the model
      // has called the forced tool and we feed the result back, switch to
      // auto so the model can generate a final response. Without this, the
      // tool-loop hits MAX_TOOL_ITERATIONS because every iteration re-forces
      // the same tool call.
      const iterationToolChoice: ResolvedToolChoice | undefined =
        i === 0 ? firstToolChoice : { mode: "auto" };

      // While no tool of the attempt has run, a call of the model that goes
      // unanswered past the failover delay hands the run to the fallback. The
      // timer covers this call alone — never a tool's run — and is cleared as
      // soon as the call is decided, whatever its outcome.
      const failover = attempt.toolsServed === 0 ? attempt.failover : undefined;
      const failoverTimer = failover
        ? setTimeout(() => this.abandon(attempt, failover, provider, model), failover.ms)
        : undefined;
      let response: LLMCallResponse;
      try {
        response = await llmProvider.call({
          model,
          systemPrompt,
          userContent: input,
          userMessage,
          tools: tools?.length ? tools : undefined,
          // A copy per iteration: what was sent must not change when the next
          // turn is appended.
          history: [...entries],
          temperature: sentTemperature,
          toolChoice: iterationToolChoice,
          parallelTools,
          _fileCache: fileCache,
          cacheKey,
        });
      } catch (err) {
        // A response of the agent's `base_url` past its bound, refused by its
        // body as the SDK read it. A stop rather than a failure: thrown, it
        // would lose its name on the way out, and the turns made with it.
        if (!(err instanceof ResponseBodyTooLargeError)) throw err;
        // The bound only: never the endpoint, never a content.
        this.logger.warn(
          {
            event: "model_bound_refused",
            provider,
            model,
            code: "MODEL_RESPONSE_TOO_LARGE",
            limit: MODEL_RESPONSE_MAX_BYTES,
          },
          "A response of the model endpoint the agent declares was larger than one may weigh; it was not read further",
        );
        return {
          content: "",
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
            ...(totalCacheWriteTokens > 0 && { cacheWriteTokens: totalCacheWriteTokens }),
          },
          stopped: { code: "MODEL_RESPONSE_TOO_LARGE", message: MODEL_RESPONSE_TOO_LARGE_MESSAGE },
          // The refused response never entered the conversation.
          history: conversation(),
        };
      } finally {
        clearTimeout(failoverTimer);
      }

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;
      totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
      totalCacheWriteTokens += response.usage.cacheWriteTokens ?? 0;
      entries.push({ kind: "assistant", turn: response.assistantTurn });
      // Every answer the attempt received is counted, a refused one included:
      // the run keeps it with the attempt, or drops it with the attempt.
      attempt.outputBytes += answerBytes(response);

      // What one answer may ask for is read first — before the spend ceiling
      // and before any dispatch — and on every answer, whether a handler would
      // run its calls or not: none of the calls of a refused answer runs. The
      // stop is reported by return value, for the reason the ceiling below is.
      const callsAsked = response.toolCalls?.length ?? 0;
      if (callsAsked > MAX_TOOL_CALLS_PER_TURN) {
        // Counts and the bound only: never the endpoint, never a content.
        this.logger.warn(
          {
            event: "model_bound_refused",
            provider,
            model,
            code: "TOO_MANY_TOOL_CALLS",
            limit: MAX_TOOL_CALLS_PER_TURN,
            calls: callsAsked,
          },
          "A model answer asked for more tool calls than one turn may carry; none of them was run",
        );
        return {
          content: "",
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
            ...(totalCacheWriteTokens > 0 && { cacheWriteTokens: totalCacheWriteTokens }),
          },
          stopped: {
            code: "TOO_MANY_TOOL_CALLS",
            message: `The model asked for ${callsAsked} tool calls in one turn; a turn may ask for at most ${MAX_TOOL_CALLS_PER_TURN}. None of them was run.`,
          },
          history: conversation(true),
        };
      }

      // What the run keeps of the model's answers is read next — after the
      // call bound, which may still hand the run to the fallback, and before
      // the spend ceiling and any dispatch: none of the calls of an answer
      // past the bound runs. This stop never hands the run to the fallback.
      const keptBytes = outputBudget.usedBytes + attempt.outputBytes;
      if (keptBytes > RUN_MODEL_OUTPUT_MAX_BYTES) {
        // Counts and the bound only: never the endpoint, never a content.
        this.logger.warn(
          {
            event: "model_bound_refused",
            provider,
            model,
            code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
            limit: RUN_MODEL_OUTPUT_MAX_BYTES,
            kept_bytes: keptBytes,
          },
          "The model's answers in this run weigh more than a run keeps of them; the call was stopped",
        );
        return {
          content: "",
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
            ...(totalCacheWriteTokens > 0 && { cacheWriteTokens: totalCacheWriteTokens }),
          },
          stopped: {
            code: "MODEL_OUTPUT_BUDGET_EXCEEDED",
            message: MODEL_OUTPUT_BUDGET_EXCEEDED_MESSAGE,
          },
          history: conversation(Boolean(response.toolCalls?.length)),
        };
      }

      // Every iteration accumulates spend, so every iteration is where the
      // ceiling has to be read: checking it only once the loop is over means
      // the loop has already bought everything it was meant to prevent.
      //
      // The overage is reported BY RETURN VALUE, never by throwing. The agent
      // loop awaits this call inside a `try` that has only a `finally`, and the
      // adapters above it turn any thrown error into a generic execution
      // failure — a thrown ceiling would lose its identity on the way out and
      // the run would end on the wrong terminus. Returning the flag keeps the
      // stop where it belongs and leaves the adapters untouched.
      //
      // The number below is produced by the SAME estimator and the SAME
      // comparison the caller applies to the response it receives, over the
      // same accumulators — so the caller's own ceiling check reads exactly
      // this value and emits the cost error it already owns. A fallback that
      // replaced a stopped primary starts from what the primary spent
      // (`spentBefore`), which the response counts the same way.
      const spentSoFar =
        spentBefore +
        estimateCost(
          model,
          totalPromptTokens,
          totalCompletionTokens,
          totalCacheReadTokens || undefined,
          totalCacheWriteTokens || undefined,
        );
      if (checkCost(spentSoFar, maxCost).exceeded) {
        this.logger.warn(
          {
            event: "tool_loop_cost_exceeded",
            provider,
            model,
            iteration: i,
            estimatedCost: spentSoFar,
            maxCost,
          },
          "Tool loop stopped mid-run — accumulated cost passed max_cost",
        );
        return {
          content: response.content,
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
            ...(totalCacheWriteTokens > 0 && { cacheWriteTokens: totalCacheWriteTokens }),
          },
          costExceeded: true,
          history: conversation(Boolean(response.toolCalls?.length)),
        };
      }

      // If no tool calls, return the content
      if (!response.toolCalls?.length || !onToolCall) {
        return {
          content: response.content,
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
            ...(totalCacheWriteTokens > 0 && { cacheWriteTokens: totalCacheWriteTokens }),
          },
          history: conversation(Boolean(response.toolCalls?.length)),
        };
      }

      // Execute the tool calls; the next iteration sends their results after
      // the turn that asked for them.
      const answered: ToolCallResult[] = [];
      for (const call of response.toolCalls) {
        // An attempt abandoned to the fallback hands no tool over: its answer
        // came too late, and the fallback holds the run.
        if (attempt.controller.signal.aborted) throw new AttemptAbandoned();
        // Counted as it is handed over, before its result: a tool has served
        // from its first dispatch, whatever comes back.
        attempt.toolsServed++;
        const result = await onToolCall(call);
        // Each result carries the id of the call it answers: the adapters pair
        // them by id where the provider gives one, by position otherwise.
        const id = call.id ?? result.id;
        answered.push(id === undefined ? result : { ...result, id });
      }
      entries.push({ kind: "tool_results", results: answered });
    }

    // Max iterations reached
    this.logger.warn(
      { event: "max_iterations", provider, model, maxIterations: MAX_TOOL_ITERATIONS },
      "Max tool iterations reached",
    );
    return {
      content:
        "[Max tool iterations reached — agent may need fewer tool calls or a higher iteration limit]",
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
        ...(totalCacheWriteTokens > 0 && { cacheWriteTokens: totalCacheWriteTokens }),
      },
      // Ends on the last tool results: the turn that would have answered them
      // was never asked for.
      history: conversation(),
    };
  }

  /**
   * A call of the primary's model went unanswered past the failover delay, no
   * tool having run: the attempt hands no tool over from now on, and `call()`
   * turns to the fallback. The call itself goes on in the background — no
   * provider takes a signal —, its answer dropped when it comes.
   */
  private abandon(attempt: Attempt, failover: Failover, provider: string, model: string): void {
    attempt.controller.abort();
    // The delay only: never the endpoint, never a content.
    this.logger.warn(
      { event: "primary_abandoned", provider, model, failover_ms: failover.ms },
      "A call of the primary model went unanswered past the failover delay, no tool having run; the fallback takes over",
    );
    failover.fire(new PrimaryFailoverTimeout(failover.ms));
  }

  /**
   * The temperature an attempt sends: the declared one, except to a model
   * `acceptsTemperature` says takes none — one the capability matrix marks as
   * refusing or ignoring any, or one it does not list, called at the own API
   * of a provider whose latest models take none (Anthropic, Google, OpenAI);
   * an attempt at a declared `base_url` keeps the value for an unlisted
   * model. That model gets none — its default — and the degradation is
   * logged, on the line the adapters already use for a setting their
   * provider lacks; `validateAgent` warned about it at build time.
   */
  private temperatureFor(
    provider: string,
    model: string,
    temperature: number | undefined,
    baseUrl: string | undefined,
  ): number | undefined {
    if (temperature === undefined) return undefined;
    if (acceptsTemperature(provider as ModelProvider, model, baseUrl)) return temperature;
    const listed = getModelCapabilities(provider as ModelProvider, model) !== undefined;
    this.logger.warn(
      {
        event: "provider_gap",
        provider,
        model,
        gap: "temperature_not_supported",
        fallback: "provider_default",
      },
      listed
        ? `${provider}/${model} does not accept a temperature; sending none, the model's default applies`
        : `${provider}/${model} is not in the capability matrix and the latest ${provider} models take no temperature; sending none, the model's default applies`,
    );
    return undefined;
  }

  /**
   * The tool-choice directive an attempt's first turn sends: the declared one,
   * except a forced choice — required, a specific tool, or a subset, which an
   * adapter may send as "any" — to a model the capability matrix marks as
   * refusing one (its provider answers 400 to every such request). That model
   * gets `auto`, logged on the `provider_gap` line; `validateAgent` warned
   * about it at build time.
   */
  private toolChoiceFor(
    provider: string,
    model: string,
    toolChoice: ResolvedToolChoice | undefined,
  ): ResolvedToolChoice | undefined {
    if (!toolChoice || toolChoice.mode === "auto" || toolChoice.mode === "none") return toolChoice;
    if (getModelCapabilities(provider as ModelProvider, model)?.forcedToolChoice !== false) {
      return toolChoice;
    }
    this.logger.warn(
      {
        event: "provider_gap",
        provider,
        model,
        gap: "forced_tool_choice_not_supported",
        fallback: "auto",
        mode: toolChoice.mode,
      },
      `${provider}/${model} refuses a forced tool choice; sending auto — the model may answer without the tool`,
    );
    return { mode: "auto" };
  }

  private checkCapabilities(provider: string, model: string, parts: SkrunPart[]): void {
    const caps = getModelCapabilities(provider as ModelProvider, model);
    if (!caps) return; // self-hosted bypass
    for (const part of parts) {
      if (part.kind === "text") continue;
      if (!caps[part.kind]) {
        throw new LLMCapabilityError(provider, model, part.kind);
      }
    }
  }

  /**
   * Resolve the provider for a given request: caller key takes precedence over
   * server key. `deadline` reaches only a provider built for a `base_url`.
   */
  private resolveProvider(
    providerName: string,
    callerKeys?: Record<string, string>,
    baseUrl?: string,
    creatorKeys?: Record<string, string>,
    deadline?: number,
  ): LLMProvider {
    // Per-provider resolution chain: caller > creator > server > error. A custom
    // base_url is ORTHOGONAL to the key source — it's the agent's endpoint
    // override, threaded into whichever tier supplies the key, so a creator key
    // is used WITH the base_url rather than bypassing the custom endpoint.
    //
    // Validated FIRST, before any tier is chosen: the destination is agent-declared
    // and every tier below attaches a credential to it.
    if (baseUrl) {
      assertModelBaseUrlAllowed(baseUrl);
    }
    const source = this.keySource(providerName, callerKeys, baseUrl, creatorKeys);
    if ("refused" in source) {
      // No client for it, whatever key: said as when a key reached the
      // provider's construction, and no key is advised.
      if (source.refused === "meta-needs-base-url") throw unknownProviderError(providerName);
      // Custom base_url + the SERVER's own key. Fail-closed by default: the agent
      // author picks the endpoint, so that tier hands the operator's credential to
      // a destination the operator did not choose. Opt in only where every agent on
      // the instance is authored by the operator.
      if (source.refused === "base-url-needs-own-key") {
        throw new Error(
          `Agent declares model.base_url ("${baseUrl}") and supplied no key for provider ` +
            `"${providerName}". This server does not send its own key to an agent-declared ` +
            "endpoint. Attach a creator key to the agent, pass one via the X-LLM-API-Key " +
            "header, or set SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL=true if every agent here " +
            "is authored by the operator.",
        );
      }
      throw noKeyError(providerName);
    }
    switch (source.tier) {
      // 1. Caller-provided key → ephemeral provider instance
      case "caller":
        return this.createProvider(
          providerName,
          callerKeys?.[providerName] ?? "",
          baseUrl,
          deadline,
        );
      // 2. Creator-attached key (decrypted harness-side) → ephemeral instance
      case "creator":
        return this.createProvider(
          providerName,
          creatorKeys?.[providerName] ?? "",
          baseUrl,
          deadline,
        );
      // 3. Custom base_url + the server's own key (possibly none), under the opt-in
      case "server-base-url":
        return this.createProvider(
          providerName,
          process.env[`${providerName.toUpperCase()}_API_KEY`] ?? "",
          baseUrl,
          deadline,
        );
      // 4. Server-side provider (registered at startup from env vars)
      case "server": {
        const serverProvider = this.providers.get(providerName);
        if (!serverProvider) throw noKeyError(providerName);
        return serverProvider;
      }
    }
  }

  /**
   * Whether a run of this provider would find a key, without building a
   * provider: the same decision `resolveProvider` acts on, read before any
   * machine exists. It does not validate `baseUrl` (the router still refuses
   * an invalid one at the first call). One model: `checkModelKeys` reads a
   * run's primary and fallback.
   */
  checkKeyResolvable(
    providerName: string,
    callerKeys?: Record<string, string>,
    baseUrl?: string,
    creatorKeys?: Record<string, string>,
  ): KeySource {
    return this.keySource(providerName, callerKeys, baseUrl, creatorKeys);
  }

  /**
   * The key decision for each model of a run, read as `call` uses them: the
   * primary with its `base_url`, the fallback without one (`call` never sends
   * the fallback to the agent's endpoint). A run can start when either finds a
   * key: a primary with none fails at its first call, and `call` then turns to
   * the fallback.
   */
  checkModelKeys(
    model: Pick<ModelConfig, "provider" | "base_url" | "fallback">,
    callerKeys?: Record<string, string>,
    creatorKeys?: Record<string, string>,
  ): ModelKeys {
    const primary = this.keySource(model.provider, callerKeys, model.base_url, creatorKeys);
    const fallback = model.fallback
      ? this.keySource(model.fallback.provider, callerKeys, undefined, creatorKeys)
      : undefined;
    const found = (source: KeySource | undefined): boolean =>
      source !== undefined && !("refused" in source);
    return {
      primary,
      ...(fallback && { fallback }),
      servable: found(primary) || found(fallback),
    };
  }

  private keySource(
    providerName: string,
    callerKeys?: Record<string, string>,
    baseUrl?: string,
    creatorKeys?: Record<string, string>,
  ): KeySource {
    return resolveKeySource(providerName, {
      callerKeys,
      creatorKeys,
      baseUrl,
      serverHasProvider: this.providers.has(providerName),
      serverKeyWithBaseUrlAllowed: serverKeyWithCustomBaseUrlAllowed(),
    });
  }

  /** Create an ephemeral provider instance with an explicit API key and optional base URL. */
  private createProvider(
    providerName: string,
    apiKey: string,
    baseUrl?: string,
    deadline?: number,
  ): LLMProvider {
    // If base_url is provided, use OpenAI-compatible provider regardless of provider name
    // (Ollama, vLLM, LocalAI all expose OpenAI-compatible endpoints)
    if (baseUrl) {
      // This is the ONE site where an agent-declared endpoint
      // becomes a provider, so it is the one that gets the connect-time SSRF guard —
      // the same one webhook / file-input / MCP already use. It is NOT set in the
      // constructor: this class also backs OpenAI/Mistral/Grok/Groq at fixed
      // endpoints, whose transport must not change.
      //
      // The guard and `assertModelBaseUrlAllowed` are not redundant. undici skips
      // `connect.lookup` for an IP literal, so the guard checks a literal itself,
      // at every connection — `http://127.0.0.1/...` as the base_url or as the
      // target of a redirect, which the declaration-time check never sees. A
      // public hostname RESOLVING to a private address passes the literal check
      // and is stopped only here. The declaration-time check refuses a private
      // base_url before any key tier is chosen, naming the opt-in. No host list
      // is passed: a hop to a public host does not reach our network.
      //
      // `allowPrivateHosts` must track the same opt-in the declaration-time check
      // honours, or the documented Ollama-on-localhost case (docs/agent-yaml.md:39)
      // would pass the first check and be blocked at connect.
      //
      // The endpoint answers what it likes, and the process of the API reads
      // it: each response is held to `MODEL_RESPONSE_MAX_BYTES` (refused by its
      // body, never by the fetch — the SDK retries a failed fetch), read within
      // what is left of the run (`deadline`, joined to the SDK's own signal),
      // and stripped of the headers that would make the SDK wait as long as the
      // endpoint says, or retry as it says: it retries on its own rules alone.
      return new OpenAICompatibleProvider(
        providerName,
        apiKey || "no-key",
        baseUrl,
        undefined,
        createGuardedFetch({
          allowPrivateHosts: localModelHostsAllowed(),
          maxResponseBytes: MODEL_RESPONSE_MAX_BYTES,
          deadline,
          stripRetryHeaders: true,
        }) as unknown as typeof fetch,
      );
    }
    switch (providerName) {
      case "anthropic":
        return new AnthropicProvider(apiKey);
      case "openai":
        return createOpenAIProvider(apiKey);
      case "google":
        return new GoogleProvider(apiKey);
      case "mistral":
        return createMistralProvider(apiKey);
      case "groq":
        return createGroqProvider(apiKey);
      case "xai":
        return createGrokProvider(apiKey);
      default:
        throw unknownProviderError(providerName);
    }
  }

  private buildResponse(
    content: string,
    promptTokens: number,
    completionTokens: number,
    provider: string,
    model: string,
    startTime: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    costExceeded = false,
    history?: ConversationHistory,
    stopped?: RouterStop,
    replaced?: ReplacedSpend,
  ): LLMRouterResponse {
    // The tokens counted are the attempt's own and those of a stopped primary
    // it replaced; each attempt's are priced at its own model.
    const allPrompt = promptTokens + (replaced?.promptTokens ?? 0);
    const allCompletion = completionTokens + (replaced?.completionTokens ?? 0);
    const allCacheRead = cacheReadTokens + (replaced?.cacheReadTokens ?? 0);
    const allCacheWrite = cacheWriteTokens + (replaced?.cacheWriteTokens ?? 0);
    return {
      content,
      usage: {
        promptTokens: allPrompt,
        completionTokens: allCompletion,
        // totalTokens keeps its meaning from before prompt caching (full-rate input + output,
        // excluding cached portion) per LLMRouterResponse JSDoc.
        totalTokens: allPrompt + allCompletion,
        ...(allCacheRead > 0 && { cacheReadTokens: allCacheRead }),
        ...(allCacheWrite > 0 && { cacheWriteTokens: allCacheWrite }),
      },
      // The same sum the tool loop reads its ceiling on (`spentBefore`).
      estimatedCost:
        (replaced?.cost ?? 0) +
        estimateCost(
          model,
          promptTokens,
          completionTokens,
          cacheReadTokens || undefined,
          cacheWriteTokens || undefined,
        ),
      provider,
      model,
      durationMs: Date.now() - startTime,
      // Emitted only when true, like the cache fields above: a response that ran
      // to its natural end carries no flag at all.
      ...(costExceeded && { costExceeded: true }),
      ...(history && { history }),
      ...(stopped && { stopped }),
    };
  }
}
