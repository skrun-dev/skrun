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

/**
 * One assistant turn exactly as the provider returned it, tagged with the
 * `name` of the adapter that produced it. Opaque everywhere else: the router
 * stores it and hands it back, and only that adapter reads `content` —
 * Anthropic its response `content` blocks (thinking blocks and their
 * signatures included), Gemini its candidate `content` (thought signatures
 * included), the OpenAI-compatible adapters their assistant message,
 * restricted to the fields Chat Completions accepts back as input. What we do
 * not understand, we send back untouched.
 *
 * It carries the model's own output: never logged, never persisted.
 */
export interface NativeTurn {
  /** `LLMProvider.name` of the adapter that produced the turn. */
  provider: string;
  /** The provider's own shape of the turn, as returned. */
  content: unknown;
}

/**
 * One step of a conversation after its initial input: an assistant turn, the
 * results of the tool calls it made (each with the id of its call when the
 * provider gives one), or a later user message.
 */
export type HistoryEntry =
  | { kind: "assistant"; turn: NativeTurn }
  | { kind: "tool_results"; results: ToolCallResult[] }
  | { kind: "user"; parts: SkrunPart[] };

/**
 * The conversation one router call held, returned so that a later call can
 * continue it. Bound to the provider AND the model that produced its turns: a
 * turn is valid only for the model that wrote it (a thinking signature is) —
 * and to the destination they were exchanged with, `baseUrl`. In memory for
 * the duration of a call; never logged, never persisted.
 */
export interface ConversationHistory {
  provider: string;
  model: string;
  /**
   * The endpoint an agent declared (`model.base_url`) the turns were
   * exchanged with; absent at the provider's own API. Behind a declared
   * endpoint the adapter is OpenAI-compatible whatever the provider's name,
   * and so are its turns: a conversation goes back only to the same
   * destination.
   */
  baseUrl?: string;
  /** The conversation's first user message. */
  input: SkrunPart[];
  /** Everything after it, in order. */
  entries: HistoryEntry[];
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
  /**
   * The conversation after `userContent`, in order: each assistant turn as the
   * provider returned it, the tool results that answered it, later user
   * messages. Empty on a first turn. The adapter renders all of it, in its
   * provider's shape — a turn untouched, each result paired with its call by id
   * where the provider gives one, by position otherwise. Every turn was
   * produced by this adapter: a turn tagged with another provider is a
   * programming error (`LLMHistoryError`).
   */
  history?: HistoryEntry[];
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
   * - **OpenAI**, **Mistral**: passed as `prompt_cache_key` body field on Chat Completions
   *   (OpenAI's Responses too).
   * - **xAI Grok** (Chat Completions): passed as `x-grok-conv-id` HTTP header.
   * - **xAI Grok** (Responses): passed as `prompt_cache_key` body field.
   * - **Anthropic / Gemini / Groq**: not used (Anthropic uses `cache_control` blocks,
   *   Gemini + Groq are fully implicit on stable-prefix detection).
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
  /** This turn exactly as the provider returned it (see `NativeTurn`). */
  assistantTurn: NativeTurn;
  /**
   * Token-usage shape returned from a single provider call. Adapter is
   * responsible for normalizing provider-specific fields into this uniform
   * shape (prompt-caching).
   *
   * - `promptTokens`: tokens billed at the FULL input rate. The cached
   *   portion (if any) is reported separately via `cacheReadTokens` and
   *   excluded from `promptTokens` to avoid double-counting in cost
   *   computation. Anthropic's native shape is already non-overlapping;
   *   OpenAI / xAI / Groq / Mistral / Gemini are GROSS in their native response, so
   *   the adapter computes `promptTokens = gross_prompt_tokens - cached_tokens`.
   * - `completionTokens`: tokens billed at the output rate. Unchanged from
   *   the shape it had before prompt-cache accounting.
   * - `cacheReadTokens`: tokens served from the provider's cache and billed
   *   at the cached-read rate (typically 0.10× input on Anthropic, GPT-5.x,
   *   Gemini 2.5+/3.x and Mistral, 0.5× input on Groq gpt-oss + OpenAI gpt-4o
   *   legacy). Optional — undefined when the provider does not report it, or
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
