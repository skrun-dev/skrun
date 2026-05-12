import { getModelCapabilities, type ModelConfig, type ModelProvider } from "@skrun-dev/schema";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
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
      const result = await this.callWithToolLoop(
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
      );
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
            error: primaryError instanceof Error ? primaryError.message : String(primaryError),
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
  ): Promise<{
    content: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  }> {
    const llmProvider = this.resolveProvider(provider, callerKeys, baseUrl);

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
  ): LLMProvider {
    // 1. Caller-provided key → ephemeral provider instance
    if (callerKeys?.[providerName]) {
      return this.createProvider(providerName, callerKeys[providerName], baseUrl);
    }
    // 2. Custom base_url → ephemeral provider with server key + custom endpoint
    if (baseUrl) {
      const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`] ?? "";
      return this.createProvider(providerName, envKey, baseUrl);
    }
    // 3. Server-side provider (registered at startup from env vars)
    const serverProvider = this.providers.get(providerName);
    if (serverProvider) {
      return serverProvider;
    }
    // 3. No key available
    throw new Error(
      `No API key available for provider "${providerName}". Provide one via X-LLM-API-Key header or set ${providerName.toUpperCase()}_API_KEY env var.`,
    );
  }

  /** Create an ephemeral provider instance with an explicit API key and optional base URL. */
  private createProvider(providerName: string, apiKey: string, baseUrl?: string): LLMProvider {
    // If base_url is provided, use OpenAI-compatible provider regardless of provider name
    // (Ollama, vLLM, LocalAI all expose OpenAI-compatible endpoints)
    if (baseUrl) {
      return new OpenAICompatibleProvider(providerName, apiKey || "no-key", baseUrl);
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
