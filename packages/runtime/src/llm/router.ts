import type { ModelConfig } from "@skrun-dev/schema";
import { estimateCost } from "./cost.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GoogleProvider } from "./providers/google.js";
import {
  createGroqProvider,
  createMistralProvider,
  createOpenAIProvider,
} from "./providers/openai.js";
import type {
  LLMCallResponse,
  LLMProvider,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinitionForLLM,
} from "./providers/types.js";

const MAX_TOOL_ITERATIONS = 10;

export interface LLMRouterResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  estimatedCost: number;
  provider: string;
  model: string;
  durationMs: number;
}

export type ToolCallHandler = (call: ToolCallRequest) => Promise<ToolCallResult>;

export class LLMRouter {
  private providers = new Map<string, LLMProvider>();

  constructor() {
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
  }

  /** For testing: register a provider manually */
  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  async call(
    modelConfig: ModelConfig,
    systemPrompt: string,
    userMessage: string,
    tools?: ToolDefinitionForLLM[],
    onToolCall?: ToolCallHandler,
    temperature?: number,
    callerKeys?: Record<string, string>,
  ): Promise<LLMRouterResponse> {
    const start = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Try primary provider
    try {
      const result = await this.callWithToolLoop(
        modelConfig.provider,
        modelConfig.name,
        systemPrompt,
        userMessage,
        tools,
        onToolCall,
        temperature ?? modelConfig.temperature,
        callerKeys,
      );
      totalPromptTokens += result.usage.promptTokens;
      totalCompletionTokens += result.usage.completionTokens;

      return this.buildResponse(
        result.content,
        totalPromptTokens,
        totalCompletionTokens,
        modelConfig.provider,
        modelConfig.name,
        start,
      );
    } catch (primaryError) {
      // Try fallback
      if (modelConfig.fallback) {
        console.warn(
          `[LLMRouter] Primary ${modelConfig.provider}/${modelConfig.name} failed: ${primaryError instanceof Error ? primaryError.message : primaryError}. Trying fallback...`,
        );

        const result = await this.callWithToolLoop(
          modelConfig.fallback.provider,
          modelConfig.fallback.name,
          systemPrompt,
          userMessage,
          tools,
          onToolCall,
          temperature ?? modelConfig.temperature,
          callerKeys,
        );
        totalPromptTokens += result.usage.promptTokens;
        totalCompletionTokens += result.usage.completionTokens;

        return this.buildResponse(
          result.content,
          totalPromptTokens,
          totalCompletionTokens,
          modelConfig.fallback.provider,
          modelConfig.fallback.name,
          start,
        );
      }
      throw primaryError;
    }
  }

  private async callWithToolLoop(
    provider: string,
    model: string,
    systemPrompt: string,
    userMessage: string,
    tools?: ToolDefinitionForLLM[],
    onToolCall?: ToolCallHandler,
    temperature?: number,
    callerKeys?: Record<string, string>,
  ): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const llmProvider = this.resolveProvider(provider, callerKeys);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let toolResults: ToolCallResult[] | undefined;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response: LLMCallResponse = await llmProvider.call({
        model,
        systemPrompt,
        userMessage,
        tools: tools?.length ? tools : undefined,
        toolResults,
        temperature,
      });

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;

      // If no tool calls, return the content
      if (!response.toolCalls?.length || !onToolCall) {
        return {
          content: response.content,
          usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        };
      }

      // Execute tool calls
      toolResults = [];
      for (const call of response.toolCalls) {
        const result = await onToolCall(call);
        toolResults.push(result);
      }
    }

    // Max iterations reached
    console.warn(
      `[LLMRouter] Max tool iterations (${MAX_TOOL_ITERATIONS}) reached for ${provider}/${model}. Returning last available content.`,
    );
    return {
      content:
        "[Max tool iterations reached — agent may need fewer tool calls or a higher iteration limit]",
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    };
  }

  /** Resolve the provider for a given request: caller key takes precedence over server key. */
  private resolveProvider(providerName: string, callerKeys?: Record<string, string>): LLMProvider {
    // 1. Caller-provided key → ephemeral provider instance
    if (callerKeys?.[providerName]) {
      return this.createProvider(providerName, callerKeys[providerName]);
    }
    // 2. Server-side provider (registered at startup from env vars)
    const serverProvider = this.providers.get(providerName);
    if (serverProvider) {
      return serverProvider;
    }
    // 3. No key available
    throw new Error(
      `No API key available for provider "${providerName}". Provide one via X-LLM-API-Key header or set ${providerName.toUpperCase()}_API_KEY env var.`,
    );
  }

  /** Create an ephemeral provider instance with an explicit API key. */
  private createProvider(providerName: string, apiKey: string): LLMProvider {
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
  ): LLMRouterResponse {
    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      estimatedCost: estimateCost(model, promptTokens, completionTokens),
      provider,
      model,
      durationMs: Date.now() - startTime,
    };
  }
}
