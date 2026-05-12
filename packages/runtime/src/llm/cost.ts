// Pricing per 1M tokens (USD) — refreshed 2026-05-04 against authoritative
// provider docs (May 2026 model-registry refresh + caching primitives audit).
//
// Older model IDs are kept for back-compat with existing agent.yaml files.
// Models in capability.ts but missing here fall back to DEFAULT_PRICING.
//
// Optional cached-rate fields for prompt caching:
//   inputCachedRead   — read rate when a token is served from cache (all 5 caching providers)
//   inputCachedWrite5m — write rate at 5min TTL (Anthropic only — explicit cache_control)
//   inputCachedWrite1h — write rate at 1h TTL (Anthropic only — stored for reference,
//                       the runtime currently uses the 5m default. Kept here so cost
//                       attribution stays accurate if a user enables 1h externally).
interface ModelPricing {
  input: number;
  output: number;
  inputCachedRead?: number;
  inputCachedWrite5m?: number;
  inputCachedWrite1h?: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic — Claude 4.x current.
  // Cached rates are uniform across all Claude models per Anthropic policy:
  //   read   = 0.10× input (90% off)
  //   write 5m = 1.25× input
  //   write 1h = 2.00× input
  "claude-opus-4-7": {
    input: 5,
    output: 25,
    inputCachedRead: 0.5,
    inputCachedWrite5m: 6.25,
    inputCachedWrite1h: 10,
  },
  "claude-opus-4-6": {
    input: 5,
    output: 25,
    inputCachedRead: 0.5,
    inputCachedWrite5m: 6.25,
    inputCachedWrite1h: 10,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    inputCachedRead: 0.3,
    inputCachedWrite5m: 3.75,
    inputCachedWrite1h: 6,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    inputCachedRead: 0.1,
    inputCachedWrite5m: 1.25,
    inputCachedWrite1h: 2,
  },
  // Anthropic — older / dated identifiers
  "claude-opus-4-20250514": {
    input: 15,
    output: 75,
    inputCachedRead: 1.5,
    inputCachedWrite5m: 18.75,
    inputCachedWrite1h: 30,
  },
  "claude-sonnet-4-20250514": {
    input: 3,
    output: 15,
    inputCachedRead: 0.3,
    inputCachedWrite5m: 3.75,
    inputCachedWrite1h: 6,
  },
  "claude-haiku-4-5-20251001": {
    input: 1,
    output: 5,
    inputCachedRead: 0.1,
    inputCachedWrite5m: 1.25,
    inputCachedWrite1h: 2,
  },

  // OpenAI — GPT-5.x current.
  // Per current OpenAI pricing page (May 2026): cached input = 0.10× input
  // (90% off) for the entire gpt-5 family. Marketed as "up to 90% input
  // cost reduction." OpenAI launched caching at 50% off in Oct 2024; the
  // 0.10× ratio is the current rate for newer models.
  "gpt-5.5-pro": { input: 30, output: 180, inputCachedRead: 3 },
  "gpt-5.5": { input: 5, output: 30, inputCachedRead: 0.5 },
  "gpt-5.4-pro": { input: 30, output: 60, inputCachedRead: 3 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, inputCachedRead: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 0.8, inputCachedRead: 0.02 },
  "gpt-5.4": { input: 5, output: 15, inputCachedRead: 0.5 },
  // OpenAI — audio-capable chat models. Pricing shown is the TEXT tier;
  // audio tokens bill at a separate higher rate ($32 / $64 per 1M for
  // gpt-audio family). The cost helper here estimates the text portion;
  // audio portion is tracked separately by the runtime when present.
  // gpt-audio uses the gpt-4o-derived legacy 50% cached discount (0.5× input)
  // per OpenAI launch terms — not yet aligned with the gpt-5 90% rate.
  "gpt-audio": { input: 2.5, output: 10, inputCachedRead: 1.25 },
  "gpt-audio-1.5": { input: 2.5, output: 10, inputCachedRead: 1.25 },
  "gpt-4o-audio-preview": { input: 2.5, output: 10, inputCachedRead: 1.25 },
  // OpenAI — legacy. gpt-4o family retains the launch 50% cached discount.
  "gpt-4o": { input: 2.5, output: 10, inputCachedRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, inputCachedRead: 0.075 },
  "o3-mini": { input: 1.1, output: 4.4, inputCachedRead: 0.55 },
  // gpt-5.3-codex, gpt-5-pro, gpt-5: pricing not in May 2026 audit data —
  // fall back to DEFAULT_PRICING until next refresh verifies on
  // openai.com/api/pricing.

  // Google — Gemini 3.x family (all preview as of May 2026).
  // Per ai.google.dev/pricing: implicit caching read = ~10% of input on
  // 2.5+/3.x (90% off, no storage fee on implicit). Explicit Cache API
  // adds storage fee per hour ($1/M for Flash, $4.50/M for Pro) — deferred
  // to a future "managed cache" feature, not modeled here.
  "gemini-3.1-pro-preview": { input: 2, output: 12, inputCachedRead: 0.2 },
  "gemini-3.1-flash-preview": { input: 0.5, output: 3, inputCachedRead: 0.05 },
  "gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.5, inputCachedRead: 0.025 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, inputCachedRead: 0.05 },
  // Google — Gemini 2.5 (still GA alongside 3.x preview)
  "gemini-2.5-pro": { input: 1.25, output: 10, inputCachedRead: 0.125 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6, inputCachedRead: 0.015 },

  // Mistral — no native prompt-caching API as of May 2026 (verified
  // docs.mistral.ai). All entries omit cached fields. The runtime adapter
  // is no-op + structured "cache_skipped" log on every call. Flip when
  // Mistral adds a cache primitive.
  "mistral-large-3": { input: 2, output: 6 },
  "mistral-medium-3.5": { input: 0.4, output: 2 },
  "mistral-medium-3": { input: 0.4, output: 2 },
  "mistral-small-4": { input: 0.15, output: 0.6 },
  "mistral-small-3.1": { input: 0.2, output: 0.6 },
  "ministral-8b": { input: 0.1, output: 0.1 },
  "magistral-medium-1.2": { input: 2, output: 5 },
  "mistral-large-latest": { input: 2, output: 6 },
  "mistral-small-latest": { input: 0.1, output: 0.3 },

  // Groq — caching limited to openai/gpt-oss-* family (+ kimi-k2 once added
  // to matrix). 50% flat discount per Groq docs. Llama / Qwen / compound
  // omit the field — caching not yet rolled out by Groq for those.
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6, inputCachedRead: 0.075 },
  "openai/gpt-oss-20b": { input: 0.1, output: 0.4, inputCachedRead: 0.05 },
  "openai/gpt-oss-safeguard-20b": { input: 0.1, output: 0.4, inputCachedRead: 0.05 },
  "gpt-oss-120b": { input: 0.15, output: 0.6, inputCachedRead: 0.075 }, // back-compat unprefixed
  "gpt-oss-20b": { input: 0.1, output: 0.4, inputCachedRead: 0.05 }, // back-compat unprefixed
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  // llama-4-scout, llama-4-maverick, qwen3-32b, groq/compound* — preview-tier
  // pricing not stable in audit data, fall back to DEFAULT_PRICING until
  // next refresh on console.groq.com/docs/models or groq.com/pricing.

  // xAI — exact cached-rate not published by xAI as of May 2026.
  // Per docs.x.ai: "cached prompt token price, substantially lower than
  // regular." Conservative estimate of 0.25× input (~75% off) used here so
  // that runtime cost-tracking does not over-bill on cache hits. Refresh
  // once xAI publishes exact figures.
  "grok-4.3": { input: 1.25, output: 2.5, inputCachedRead: 0.3125 },
  "grok-4.1-fast": { input: 0.2, output: 0.5, inputCachedRead: 0.05 },
  "grok-4.20-multi-agent": { input: 2, output: 6, inputCachedRead: 0.5 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15 };

/**
 * Estimate the cost in USD for a single LLM call.
 *
 * `cacheReadTokens` and `cacheWriteTokens` are the cached-portion counts
 * extracted from the provider response (Anthropic uses both; OpenAI / xAI
 * / Groq / Gemini use only `cacheReadTokens`). The runtime adapter
 * normalizes `promptTokens` to the NON-cached residual before passing here.
 *
 * If a model has no `inputCachedRead` rate, the cached portion bills at
 * the full input rate (conservative — never under-bills). If
 * `cacheReadTokens` is undefined or 0, the formula degrades cleanly to
 * the legacy behavior (just promptTokens × input + completionTokens × output).
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;
  const cachedRead = cacheReadTokens ?? 0;
  const cachedWrite = cacheWriteTokens ?? 0;
  const cachedReadRate = pricing.inputCachedRead ?? pricing.input;
  // Anthropic-only — fall back to full input rate when no write rate is
  // defined (other providers don't bill a separate write surcharge).
  const cachedWriteRate = pricing.inputCachedWrite5m ?? pricing.input;
  return (
    (promptTokens * pricing.input +
      cachedRead * cachedReadRate +
      cachedWrite * cachedWriteRate +
      completionTokens * pricing.output) /
    1_000_000
  );
}

/**
 * Estimate the dollar savings produced by prompt-caching on a single LLM call.
 *
 * Returns USD (fractional, rounded to 6 decimals to match the operator
 * dashboard's NUMERIC(10,6) DB column precision). When the model has no
 * `inputCachedRead` rate (e.g., Mistral, unknown models), the cached portion
 * billed at the full input rate by `estimateCost` — savings is 0.
 *
 * Rounding to 6 decimals via `Math.round(× 1e6) / 1e6` ensures values like
 * `2.6999999999999997e-2` collapse to exactly `0.027`, matching strict
 * equality assertions and DB row precision.
 *
 * Negative results clamped to 0 (defensive — should never happen since every
 * pricing entry has `inputCachedRead < input` by construction).
 */
export function estimateCacheSavings(model: string, cacheReadTokens: number): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;
  const cachedRate = pricing.inputCachedRead ?? pricing.input;
  const raw = Math.max(0, (cacheReadTokens * (pricing.input - cachedRate)) / 1_000_000);
  return Math.round(raw * 1_000_000) / 1_000_000;
}
