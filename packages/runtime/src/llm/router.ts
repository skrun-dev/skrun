import { getModelCapabilities, type ModelConfig, type ModelProvider } from "@skrun-dev/schema";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { isPrivateHost } from "../security/network.js";
import { createGuardedFetch } from "../security/safe-fetch.js";
import { redactSecretsFromString } from "../utils/redact.js";
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
  LLMCallResponse,
  LLMProvider,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinitionForLLM,
} from "./providers/types.js";
import type { ResolvedToolChoice } from "./tool-choice.js";

const MAX_TOOL_ITERATIONS = 10;

/**
 * Fast-failover timeout for the primary LLM call (ms). When a fallback model is
 * configured and the primary hangs longer than this, stop waiting and switch to
 * the fallback — instead of blocking on the provider SDK's own timeout (~180s).
 * Tunable via SKRUN_PRIMARY_FAILOVER_MS. Default 45s: long enough for a
 * legitimately slow turn (large context / high thinking), ~4x faster than the
 * SDK timeout on a genuine hang.
 */
const PRIMARY_FAILOVER_TIMEOUT_MS = Number(process.env.SKRUN_PRIMARY_FAILOVER_MS) || 45_000;

/** Rejection thrown when the primary call exceeds the failover timeout — caught by the fallback path. */
class PrimaryFailoverTimeout extends Error {
  constructor(ms: number) {
    super(`Primary LLM call exceeded the ${ms}ms failover timeout — switching to fallback`);
    this.name = "PrimaryFailoverTimeout";
  }
}

/**
 * Race the primary call against a failover timeout that rejects; the timer is
 * cleared as soon as the primary settles.
 *
 * Caveat: on timeout the abandoned primary keeps running in the background until
 * its own timeout/close — it may still complete (a wasted, billable LLM call)
 * and any partial tool-loop work it did is discarded (the fallback restarts from
 * the user input). Acceptable for a fallback trigger.
 */
function racePrimaryWithFailover<T>(primary: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PrimaryFailoverTimeout(ms)), ms);
  });
  return Promise.race([primary, timeout]).finally(() => clearTimeout(timer));
}

export interface LLMRouterResponse {
  content: string;
  /**
   * Aggregated token usage across all tool-loop iterations of a single run.
   * Cache fields sum the per-iteration values reported by the provider
   * adapter. See `LLMCallResponse.usage` JSDoc for the per-iteration semantic.
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
}

export type ToolCallHandler = (call: ToolCallRequest) => Promise<ToolCallResult>;

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

export class LLMRouter {
  private providers = new Map<string, LLMProvider>();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger("llm");
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

    // Try primary provider
    try {
      // When a fallback is configured, race the primary against a short
      // failover timeout so a hanging primary switches to the fallback fast
      // (instead of blocking on the provider SDK's ~180s timeout). The timeout
      // rejection is handled by the catch → fallback path below.
      const primaryCall = this.callWithToolLoop(
        modelConfig.provider,
        modelConfig.name,
        systemPrompt,
        parts,
        tools,
        onToolCall,
        temperature ?? modelConfig.temperature,
        callerKeys,
        modelConfig.base_url,
        fileCache,
        toolChoice,
        parallelTools,
        cacheKey,
        creatorKeys,
      );
      const result = modelConfig.fallback
        ? await racePrimaryWithFailover(primaryCall, PRIMARY_FAILOVER_TIMEOUT_MS)
        : await primaryCall;
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
      );
    } catch (primaryError) {
      // Try fallback
      if (modelConfig.fallback) {
        this.logger.warn(
          {
            event: "primary_failed",
            provider: modelConfig.provider,
            model: modelConfig.name,
            // Sanitize the provider error before logging: a 401/4xx can echo a
            // key fragment, and pino's `redact` paths can't scrub a free-text
            // scalar. Strip every active caller + creator key value first.
            error: redactSecretsFromString(
              primaryError instanceof Error ? primaryError.message : String(primaryError),
              [...Object.values(callerKeys ?? {}), ...Object.values(creatorKeys ?? {})],
            ),
          },
          "Primary LLM failed, trying fallback",
        );

        const result = await this.callWithToolLoop(
          modelConfig.fallback.provider,
          modelConfig.fallback.name,
          systemPrompt,
          parts,
          tools,
          onToolCall,
          temperature ?? modelConfig.temperature,
          callerKeys,
          undefined,
          fileCache,
          toolChoice,
          parallelTools,
          cacheKey,
          creatorKeys,
        );
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
        );
      }
      throw primaryError;
    }
  }

  private async callWithToolLoop(
    provider: string,
    model: string,
    systemPrompt: string,
    userContent: SkrunPart[],
    tools?: ToolDefinitionForLLM[],
    onToolCall?: ToolCallHandler,
    temperature?: number,
    callerKeys?: Record<string, string>,
    baseUrl?: string,
    fileCache?: ProviderFileCache,
    toolChoice?: ResolvedToolChoice,
    parallelTools?: boolean,
    cacheKey?: string,
    creatorKeys?: Record<string, string>,
  ): Promise<{
    content: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  }> {
    const llmProvider = this.resolveProvider(provider, callerKeys, baseUrl, creatorKeys);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let toolResults: ToolCallResult[] | undefined;
    let previousToolCalls: ToolCallRequest[] | undefined;

    // Defense-in-depth capability check: refuse non-text content the model can't handle.
    // The primary gate runs at `skrun deploy/push` (capability check); this catches any drift.
    this.checkCapabilities(provider, model, userContent);

    // Derive deprecated userMessage alias from text parts for backward-compat
    // with provider impls that haven't been migrated to userContent.
    const userMessage = userContent
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
        i === 0 ? toolChoice : { mode: "auto" };

      const response: LLMCallResponse = await llmProvider.call({
        model,
        systemPrompt,
        userContent,
        userMessage,
        tools: tools?.length ? tools : undefined,
        toolCalls: previousToolCalls,
        toolResults,
        temperature,
        toolChoice: iterationToolChoice,
        parallelTools,
        _fileCache: fileCache,
        cacheKey,
      });

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;
      totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
      totalCacheWriteTokens += response.usage.cacheWriteTokens ?? 0;

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
        };
      }

      // Execute tool calls and store originals for next iteration
      previousToolCalls = response.toolCalls;
      toolResults = [];
      for (const call of response.toolCalls) {
        const result = await onToolCall(call);
        toolResults.push(result);
      }
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
    };
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

  /** Resolve the provider for a given request: caller key takes precedence over server key. */
  private resolveProvider(
    providerName: string,
    callerKeys?: Record<string, string>,
    baseUrl?: string,
    creatorKeys?: Record<string, string>,
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
    // 1. Caller-provided key → ephemeral provider instance
    if (callerKeys?.[providerName]) {
      return this.createProvider(providerName, callerKeys[providerName], baseUrl);
    }
    // 2. Creator-attached key (decrypted harness-side) → ephemeral instance
    if (creatorKeys?.[providerName]) {
      return this.createProvider(providerName, creatorKeys[providerName], baseUrl);
    }
    // 3. Custom base_url + the SERVER's own key. Fail-closed by default: the agent
    // author picks the endpoint, so this tier hands the operator's credential to a
    // destination the operator did not choose. Opt in only where every agent on the
    // instance is authored by the operator.
    if (baseUrl) {
      if (!serverKeyWithCustomBaseUrlAllowed()) {
        throw new Error(
          `Agent declares model.base_url ("${baseUrl}") and supplied no key for provider ` +
            `"${providerName}". This server does not send its own key to an agent-declared ` +
            "endpoint. Attach a creator key to the agent, pass one via the X-LLM-API-Key " +
            "header, or set SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL=true if every agent here " +
            "is authored by the operator.",
        );
      }
      const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`] ?? "";
      return this.createProvider(providerName, envKey, baseUrl);
    }
    // 4. Server-side provider (registered at startup from env vars)
    const serverProvider = this.providers.get(providerName);
    if (serverProvider) {
      return serverProvider;
    }
    // 5. No key available
    throw new Error(
      `No API key available for provider "${providerName}". Provide one via the X-LLM-API-Key header, attach a creator key to the agent, or set the ${providerName.toUpperCase()}_API_KEY env var.`,
    );
  }

  /** Create an ephemeral provider instance with an explicit API key and optional base URL. */
  private createProvider(providerName: string, apiKey: string, baseUrl?: string): LLMProvider {
    // If base_url is provided, use OpenAI-compatible provider regardless of provider name
    // (Ollama, vLLM, LocalAI all expose OpenAI-compatible endpoints)
    if (baseUrl) {
      // This is the ONE site where an agent-declared endpoint
      // becomes a provider, so it is the one that gets the connect-time SSRF guard —
      // the same one webhook / file-input / MCP already use. It is NOT set in the
      // constructor: this class also backs OpenAI/Mistral/Grok/Groq at fixed
      // endpoints, whose transport must not change.
      //
      // The guard and `assertModelBaseUrlAllowed` cover DISJOINT cases, measured:
      // undici skips `connect.lookup` for an IP literal, so the guard never sees
      // `http://127.0.0.1/...` — the declaration-time check is the only defence
      // there. Conversely a public hostname RESOLVING to a private address passes
      // the literal check and is stopped only here. Both are required.
      //
      // `allowPrivateHosts` must track the same opt-in the declaration-time check
      // honours, or the documented Ollama-on-localhost case (docs/agent-yaml.md:39)
      // would pass the first check and be blocked at connect.
      return new OpenAICompatibleProvider(
        providerName,
        apiKey || "no-key",
        baseUrl,
        undefined,
        createGuardedFetch({
          allowPrivateHosts: localModelHostsAllowed(),
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
        throw new Error(`Unknown provider: "${providerName}"`);
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
  ): LLMRouterResponse {
    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        // totalTokens preserves pre-#68 semantic (full-rate input + output,
        // excluding cached portion) per LLMRouterResponse JSDoc.
        totalTokens: promptTokens + completionTokens,
        ...(cacheReadTokens > 0 && { cacheReadTokens }),
        ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
      },
      estimatedCost: estimateCost(
        model,
        promptTokens,
        completionTokens,
        cacheReadTokens || undefined,
        cacheWriteTokens || undefined,
      ),
      provider,
      model,
      durationMs: Date.now() - startTime,
    };
  }
}
