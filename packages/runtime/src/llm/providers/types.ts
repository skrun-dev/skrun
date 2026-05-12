import type { ProviderFileCache } from "../file-cache.js";
import type { SkrunPart } from "../parts.js";
import type { ResolvedToolChoice } from "../tool-choice.js";

export interface ToolDefinitionForLLM {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolCallResult {
  name: string;
  result: string;
  id?: string;
}

export interface LLMCallRequest {
  systemPrompt: string;
  /**
   * Multimodal user content as a discriminated union of text/image/document/audio parts.
   * Source of truth for the user message.
   */
  userContent: SkrunPart[];
  /**
   * @deprecated Derived alias for backward compat — concat of all text parts in `userContent`.
   * New provider implementations should consume `userContent` directly.
   */
  userMessage: string;
  tools?: ToolDefinitionForLLM[];
  /** Original tool call requests from the previous LLM response (contains args) */
  toolCalls?: ToolCallRequest[];
  /** Tool execution results matching the toolCalls above */
  toolResults?: ToolCallResult[];
  temperature?: number;
  model: string;
  /**
   * Resolved tool-choice directive. Provider adapters translate this IR into
   * native API shape (Anthropic tool_choice / Gemini function_calling_config /
   * OpenAI tool_choice). Default `{ mode: "auto" }` if unset.
   */
  toolChoice?: ResolvedToolChoice;
  /**
   * Whether the model may emit multiple tool calls in parallel within one
   * response. `false` maps to Anthropic `disable_parallel_tool_use` /
   * OpenAI `parallel_tool_calls: false`. Gemini has no native equivalent
   * (no-op + warning at translation time). Default `true` (provider native).
   */
  parallelTools?: boolean;
  /**
   * Per-run cache for provider-side file_ids. Set by `LLMRouter.call()` and threaded
   * through tool-loop iterations so the same SkrunPart bytes don't re-upload.
   */
  _fileCache?: ProviderFileCache;
  /**
   * Already-hashed cache routing key (prompt-caching). Computed once per
   * run by `LLMRouter.call()` from the agent context (see `cache-key.ts`
   * `hashCacheKey()`) and threaded through tool-loop iterations so all
   * iterations of the same run share the same cache pool.
   *
   * Provider-specific transport (set by the adapter, not the router):
   * - **OpenAI**: passed as `prompt_cache_key` body field on Chat Completions / Responses.
   * - **xAI Grok** (Chat Completions): passed as `x-grok-conv-id` HTTP header.
   * - **xAI Grok** (Responses): passed as `prompt_cache_key` body field.
   * - **Anthropic / Gemini / Groq**: not used (Anthropic uses `cache_control` blocks,
   *   Gemini + Groq are fully implicit on stable-prefix detection).
   * - **Mistral**: ignored (no native caching).
   *
   * Undefined when the router has no agent context (e.g. dev-mode raw call) — adapters
   * fall back to no-key behavior.
   */
  cacheKey?: string;
}

/**
 * Concatenate all text parts of a SkrunPart[] into a single string.
 * Used to derive the deprecated `userMessage` from the canonical `userContent`.
 */
export function userMessageFromContent(parts: SkrunPart[]): string {
  return parts
    .filter((p): p is Extract<SkrunPart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

export interface LLMCallResponse {
  content: string;
  toolCalls?: ToolCallRequest[];
  /**
   * Token-usage shape returned from a single provider call. Adapter is
   * responsible for normalizing provider-specific fields into this uniform
   * shape (prompt-caching).
   *
   * - `promptTokens`: tokens billed at the FULL input rate. The cached
   *   portion (if any) is reported separately via `cacheReadTokens` and
   *   excluded from `promptTokens` to avoid double-counting in cost
   *   computation. Anthropic's native shape is already non-overlapping;
   *   OpenAI / xAI / Groq / Gemini are GROSS in their native response, so
   *   the adapter computes `promptTokens = gross_prompt_tokens - cached_tokens`.
   * - `completionTokens`: tokens billed at the output rate. Unchanged from
   *   the pre-#68 shape.
   * - `cacheReadTokens`: tokens served from the provider's cache and billed
   *   at the cached-read rate (typically 0.10× input on Anthropic, GPT-5.x,
   *   Gemini 2.5+/3.x, 0.5× input on Groq gpt-oss + OpenAI gpt-4o legacy).
   *   Optional — undefined when the provider doesn't expose it (Mistral) or
   *   when no cache hit occurred.
   * - `cacheWriteTokens`: tokens written to cache and billed at the cached-
   *   write rate. Anthropic only (5min TTL by default; the 1h TTL toggle
   *   is intentionally not exposed by the runtime). Optional — undefined
   *   for all other providers.
   *
   * Total cost = (promptTokens × inputRate) + (cacheReadTokens × cachedReadRate)
   *            + (cacheWriteTokens × cachedWriteRate) + (completionTokens × outputRate)
   * — all four addends non-overlapping.
   */
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface LLMProvider {
  readonly name: string;
  call(request: LLMCallRequest): Promise<LLMCallResponse>;
}
