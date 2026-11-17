// Per-model data tables of the LLM layer, kept in a module with no import and
// no side effect: tooling can read them without loading a provider SDK or
// opening a logger. The provider adapters import from here.

/**
 * Per-model minimum-tokens threshold for prompt-caching.
 *
 * Anthropic caches no prefix shorter than the model's threshold: a request
 * that marks one with `cache_control` is processed without caching, and no
 * error is returned (Anthropic, "Prompt caching" § Cache limitations). The
 * runtime evaluates each prefix (tools, system) independently and only
 * injects when that prefix's own token estimate exceeds the threshold.
 *
 * Source: Anthropic's "Prompt caching" page, 2026-10-05 (2026-11-17 for Claude
 * Fable 5.2 and Mythos 5.2).
 *
 * Default fallback for unmapped IDs is 512, the lowest of all current
 * Anthropic thresholds: a point placed below a model's real threshold costs
 * nothing — the request runs uncached — where a threshold set too high
 * misses a cache hit.
 */
export const MODEL_CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-opus-5-5": 512,
  "claude-sonnet-5-5": 512,
  "claude-fable-5-2": 512,
  "claude-mythos-5-2": 512,
  "claude-fable-5-1": 512,
  "claude-mythos-5-1": 512,
  "claude-fable-5": 512,
  "claude-mythos-5": 512,
  "claude-opus-5": 512,
  "claude-sonnet-5": 1024,
  "claude-opus-4-8": 1024,
  "claude-opus-4-7": 2048,
  "claude-opus-4-6": 4096,
  "claude-opus-4-5": 4096,
  "claude-sonnet-4-6": 1024,
  "claude-haiku-4-5": 4096,
  "claude-haiku-5-5": 512,
};

export const DEFAULT_CACHE_MIN_TOKENS = 512;

/**
 * Look up the per-model min-tokens threshold via prefix match against
 * `MODEL_CACHE_MIN_TOKENS`. Mirrors the prefix-match pattern used by
 * `getModelCapabilities` for snapshot/dated model IDs (e.g.
 * `claude-opus-4-7-20260416` resolves to `claude-opus-4-7`).
 */
export function getCacheMinTokens(model: string): number {
  return longestPrefix(MODEL_CACHE_MIN_TOKENS, model) ?? DEFAULT_CACHE_MIN_TOKENS;
}

/**
 * Per-model maximum output tokens: the most one call of the runtime gets from
 * a model, reasoning included — the model's own limit as its provider
 * documents it, except where the call the adapter makes stops sooner (Gemini
 * 4 Argon, below). One row per key of the capability matrix
 * (`@skrun-dev/schema`), matched like it by longest prefix.
 *
 * Only the Anthropic adapter reads it, for the `max_tokens` its API requires
 * (`getMaxOutputTokens`); the other providers take their own default — the
 * model's limit, or for Gemini 4 Argon the ceiling of the call. The drift
 * check judges each row against the two public catalogs (models.dev
 * `limit.output`, LiteLLM `max_output_tokens`).
 *
 * Source: both catalogs, 2026-10-05 and the day of each row added since —
 * models.dev's value where they differ (LiteLLM gives some models their
 * context window); LiteLLM alone for the models models.dev does not list
 * (Claude Mythos 5.2, 5.1 and 5, gpt-audio-1.5); Google's long-decode page too for
 * Gemini 4 Argon.
 */
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  // Anthropic
  "claude-opus-5-5": 128_000,
  "claude-sonnet-5-5": 128_000,
  "claude-fable-5-2": 128_000,
  "claude-mythos-5-2": 128_000,
  "claude-fable-5-1": 128_000,
  "claude-mythos-5-1": 128_000,
  "claude-fable-5": 128_000,
  "claude-mythos-5": 128_000,
  "claude-opus-5": 128_000,
  "claude-sonnet-5": 128_000,
  "claude-opus-4-8": 128_000,
  "claude-opus-4-7": 128_000,
  "claude-opus-4-6": 128_000,
  "claude-opus-4-5": 64_000,
  "claude-sonnet-4-6": 128_000,
  "claude-haiku-4-5": 64_000,
  "claude-haiku-5-5": 128_000,
  // Google
  // Gemini 4 Argon: 32,768 is the ceiling of a non-streaming generateContent
  // call, the adapter's (no maxOutputTokens sent), per Google's long-decode
  // page — not the model's limit: it writes up to 65,536 in one synchronous
  // response and up to 1,048,576 with long decode, which takes a
  // continuation the adapter does not send.
  "gemini-4-argon": 32_768,
  "gemini-3.8-flash": 65_536,
  "gemini-3.6-flash": 65_536,
  "gemini-3.5-flash-lite": 65_536,
  "gemini-3.1-pro-preview": 65_536,
  "gemini-3-flash-preview": 65_536,
  "gemini-2.5-pro": 65_536,
  "gemini-2.5-flash": 65_536,
  "gemini-2.5-flash-lite": 65_536,
  // OpenAI
  "gpt-6.1-sol": 128_000,
  "gpt-6.1-terra": 128_000,
  "gpt-6-astra": 128_000,
  "gpt-6-sol": 128_000,
  "gpt-6-luna": 128_000,
  "gpt-5.6-sol": 128_000,
  "gpt-5.6-terra": 128_000,
  "gpt-5.6-luna": 128_000,
  "gpt-5.5": 128_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.4-nano": 128_000,
  "gpt-5.2": 128_000,
  "gpt-5": 128_000,
  "gpt-5-mini": 128_000,
  "gpt-5-nano": 128_000,
  "gpt-4o": 16_384,
  "gpt-4o-mini": 16_384,
  "gpt-audio-1.5": 16_384,
  // Mistral
  "mistral-medium-2604": 262_144,
  "mistral-large-2512": 262_144,
  "mistral-large-latest": 262_144,
  "mistral-large-4": 262_144,
  "mistral-small-2603": 256_000,
  // Groq
  "openai/gpt-oss-120b": 65_536,
  "openai/gpt-oss-20b": 65_536,
  "openai/gpt-oss-safeguard-20b": 65_536,
  // xAI
  "grok-4.7": 500_000,
  "grok-4.6": 500_000,
  "grok-4.5": 500_000,
  "grok-4.3": 30_000,
  "grok-4.20-0309-reasoning": 30_000,
  "grok-4.20-0309-non-reasoning": 30_000,
  "grok-build-0.1": 256_000,
};

/**
 * The output limit of a model, by longest prefix against
 * `MODEL_MAX_OUTPUT_TOKENS` (a dated id resolves to its base model);
 * undefined for a model the table does not know.
 */
export function getMaxOutputTokens(model: string): number | undefined {
  return longestPrefix(MODEL_MAX_OUTPUT_TOKENS, model);
}

/**
 * The value of `table` for `model`: its exact key, else the longest key it
 * extends after a `-` — `claude-opus-4-7-20260416` is `claude-opus-4-7`, and
 * `claude-haiku-40` extends no key.
 */
function longestPrefix(table: Record<string, number>, model: string): number | undefined {
  if (Object.hasOwn(table, model)) return table[model];
  let best: { key: string; value: number } | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (model.startsWith(`${key}-`) && (!best || key.length > best.key.length)) {
      best = { key, value };
    }
  }
  return best?.value;
}
