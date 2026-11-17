// Pricing per 1M tokens (USD), one row per current model — reviewed 2026-10-28
// against each provider's pricing page and the two public catalogs
// (models.dev, LiteLLM).
//
// A model id is priced by its own row, else by the longest key it extends
// after a `-` (a dated id is priced as its base model), else DEFAULT_PRICING
// (`pricingFor`). A variant priced apart from the model it extends needs a
// row of its own, or it is billed at that model's price.
//
// Optional cached-rate fields for prompt caching, each the provider's own
// rate for that model:
//   inputCachedRead   — read rate when a token is served from cache (every caching provider)
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

// Exported for tooling that reads the table from this module; it is not part
// of the package's public entry point.
export const PRICING: Record<string, ModelPricing> = {
  // Anthropic. Writes cost 1.25× input (5 min) and 2× input (1 h) on every
  // model; reads 0.1× input, except Claude Opus 5.5 and Sonnet 5.5 (0.05×),
  // Claude Fable 5.2, Mythos 5.2, Fable 5.1 and Mythos 5.1 (0.025×) —
  // Anthropic's pricing page.
  // Claude Fable 5.2 and Mythos 5.2 are priced below claude-fable-5 and
  // claude-mythos-5, the keys their ids extend: without these rows they would
  // be billed at those rows' price (Anthropic's pricing page, 2026-11-17).
  "claude-fable-5-2": {
    input: 8,
    output: 40,
    inputCachedRead: 0.2,
    inputCachedWrite5m: 10,
    inputCachedWrite1h: 16,
  },
  // Limited availability.
  "claude-mythos-5-2": {
    input: 8,
    output: 40,
    inputCachedRead: 0.2,
    inputCachedWrite5m: 10,
    inputCachedWrite1h: 16,
  },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    inputCachedRead: 0.1,
    inputCachedWrite5m: 2.5,
    inputCachedWrite1h: 4,
  },
  "claude-opus-5-5": {
    input: 4,
    output: 20,
    inputCachedRead: 0.2,
    inputCachedWrite5m: 5,
    inputCachedWrite1h: 8,
  },
  "claude-fable-5-1": {
    input: 10,
    output: 50,
    inputCachedRead: 0.25,
    inputCachedWrite5m: 12.5,
    inputCachedWrite1h: 20,
  },
  // Limited availability.
  "claude-mythos-5-1": {
    input: 10,
    output: 50,
    inputCachedRead: 0.25,
    inputCachedWrite5m: 12.5,
    inputCachedWrite1h: 20,
  },
  "claude-fable-5": {
    input: 10,
    output: 50,
    inputCachedRead: 1,
    inputCachedWrite5m: 12.5,
    inputCachedWrite1h: 20,
  },
  // Limited availability.
  "claude-mythos-5": {
    input: 10,
    output: 50,
    inputCachedRead: 1,
    inputCachedWrite5m: 12.5,
    inputCachedWrite1h: 20,
  },
  "claude-opus-5": {
    input: 5,
    output: 25,
    inputCachedRead: 0.5,
    inputCachedWrite5m: 6.25,
    inputCachedWrite1h: 10,
  },
  "claude-sonnet-5": {
    input: 2,
    output: 10,
    inputCachedRead: 0.2,
    inputCachedWrite5m: 2.5,
    inputCachedWrite1h: 4,
  },
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    inputCachedRead: 0.5,
    inputCachedWrite5m: 6.25,
    inputCachedWrite1h: 10,
  },
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
  "claude-opus-4-5": {
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
  // Claude Haiku 5.5 is priced by prompt length: these are its rates for a
  // prompt up to 100,000 tokens; above, every rate is 5× (0.5 / 2.5, cache
  // read 0.05). Not modelled, as the long-context prices below: `max_cost`
  // underestimates a longer prompt five times.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    inputCachedRead: 0.01,
    inputCachedWrite5m: 0.125,
    inputCachedWrite1h: 0.2,
  },

  // OpenAI. Cached input per model, from OpenAI's pricing page (standard
  // tier): 0.1× input on the GPT-5.x and GPT-6 rows, 0.05× on GPT-6.1,
  // 0.5× on GPT-4o. GPT-6.1, GPT-6 and GPT-5.6 also bill a cache write at
  // 1.25× input (2.5× for a 12-hour write, which the adapter does not ask
  // for), not modelled here: the written part bills at the input rate. Prices
  // past 272K tokens of prompt are not modelled either (OpenAI's page gives
  // them for GPT-6.1, GPT-6, GPT-5.6, GPT-5.5 and GPT-5.4).
  "gpt-6.1-sol": { input: 2, output: 10, inputCachedRead: 0.1 },
  "gpt-6.1-terra": { input: 1, output: 5, inputCachedRead: 0.05 },
  "gpt-6-astra": { input: 10, output: 50, inputCachedRead: 1 },
  "gpt-6-sol": { input: 2, output: 10, inputCachedRead: 0.2 },
  "gpt-6-luna": { input: 0.1, output: 0.5, inputCachedRead: 0.01 },
  // GPT-5.6 Sol: promotional pricing, at least through 2026-11-21.
  "gpt-5.6-sol": { input: 4, output: 20, inputCachedRead: 0.4 },
  "gpt-5.6-terra": { input: 2, output: 12, inputCachedRead: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, inputCachedRead: 0.02 },
  "gpt-5.5": { input: 5, output: 30, inputCachedRead: 0.5 },
  // A Cyber model, priced apart: without its row it would be billed as gpt-5.5.
  "gpt-5.5-cyber": { input: 12.5, output: 75, inputCachedRead: 1.25 },
  "gpt-5.4": { input: 2.5, output: 15, inputCachedRead: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, inputCachedRead: 0.075 },
  // Deprecated: gpt-5.4-nano and its dated snapshot retire 2027-04-01
  // (OpenAI's notice of 2026-10-01); the row stays until that day.
  "gpt-5.4-nano": { input: 0.2, output: 1.25, inputCachedRead: 0.02 },
  "gpt-5.2": { input: 1.75, output: 14, inputCachedRead: 0.175 },
  // Deprecated: gpt-5, gpt-5-mini, gpt-5-nano and their dated snapshots
  // retire 2026-12-11 (OpenAI's notice of 2026-06-11); the rows stay until
  // that day.
  "gpt-5": { input: 1.25, output: 10, inputCachedRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, inputCachedRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, inputCachedRead: 0.005 },
  // gpt-4o, gpt-4o-mini: OpenAI's notice of 2026-10-14 retires the dated
  // snapshots it names on 2027-01-14, and names neither alias.
  "gpt-4o": { input: 2.5, output: 10, inputCachedRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, inputCachedRead: 0.075 },
  // Audio-capable chat model. The text tier: audio tokens bill at their own
  // rate, not modelled. OpenAI publishes no cached-input rate for it.
  "gpt-audio-1.5": { input: 2.5, output: 10 },

  // Google. Implicit caching, read per model, from Google's pricing page
  // (last updated 2026-10-27). The explicit cache API's storage fee is not
  // modelled, nor are the prices past 200k tokens of prompt (Gemini 3.1 Pro
  // Preview, Gemini 2.5 Pro).
  // Prices Google's page dates, which no catalog carries yet: each row is
  // today's price, and `max_cost` counts half the cost from that day until
  // the row changes. gemini-4-argon: 4 / 20, read 0.2, from 2026-12-01 (its
  // introductory price runs through 2026-11-30); gemini-3.8-flash and
  // gemini-3.6-flash: 1.50 / 7.50, read 0.15, from 2027-01-01.
  "gemini-4-argon": { input: 2, output: 10, inputCachedRead: 0.1 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, inputCachedRead: 0.075 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, inputCachedRead: 0.075 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, inputCachedRead: 0.03 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, inputCachedRead: 0.2 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, inputCachedRead: 0.05 },
  // Gemini 2.5: open only to accounts that have used it before.
  "gemini-2.5-pro": { input: 1.25, output: 10, inputCachedRead: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, inputCachedRead: 0.03 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, inputCachedRead: 0.01 },

  // Mistral — a cached prefix is read at a tenth of the input rate (models.dev
  // and LiteLLM, 2026-10, the same ratio on every Mistral model they price);
  // the adapter passes prompt_cache_key and reads the cached tokens back.
  // Mistral Medium 3.5, by its dated id.
  "mistral-medium-2604": { input: 1.5, output: 7.5, inputCachedRead: 0.15 },
  // Mistral Large 3, and its alias.
  "mistral-large-2512": { input: 0.5, output: 1.5, inputCachedRead: 0.05 },
  "mistral-large-latest": { input: 0.5, output: 1.5, inputCachedRead: 0.05 },
  // Mistral Large 4, at the price its model page shows on 2026-11-17, cache
  // read included (1.36 / 4.18, read 0.14, on 2026-10-28). Its versioned ids
  // (mistral-large-4-0, mistral-large-4-0-8) take this row.
  "mistral-large-4": { input: 0.7, output: 2.1, inputCachedRead: 0.07 },
  // Mistral Small 4, and its alias.
  "mistral-small-2603": { input: 0.15, output: 0.6, inputCachedRead: 0.015 },
  "mistral-small-latest": { input: 0.15, output: 0.6, inputCachedRead: 0.015 },

  // Groq — prompt caching on the openai/gpt-oss family, cached input at half
  // the input rate (Groq's prompt-caching page, 2026-11-17).
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6, inputCachedRead: 0.075 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3, inputCachedRead: 0.0375 },
  "openai/gpt-oss-safeguard-20b": { input: 0.075, output: 0.3, inputCachedRead: 0.0375 },

  // xAI — cached read per model, as xAI's models page publishes it. Prices
  // past 200k tokens of prompt — every rate doubled, on every row — are not
  // modelled.
  "grok-4.7": { input: 2, output: 6, inputCachedRead: 0.5 },
  "grok-4.6": { input: 2, output: 6, inputCachedRead: 0.5 },
  "grok-4.5": { input: 2, output: 6, inputCachedRead: 0.3 },
  "grok-4.3": { input: 1.25, output: 2.5, inputCachedRead: 0.2 },
  "grok-4.20-0309-reasoning": { input: 1.25, output: 2.5, inputCachedRead: 0.2 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, output: 2.5, inputCachedRead: 0.2 },
  "grok-build-0.1": { input: 1, output: 2, inputCachedRead: 0.2 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15 };

/**
 * The pricing a model id is billed at, and the row it comes from: the row
 * whose key is the id itself, else the row of the longest key the id extends
 * after a `-` (`gpt-5.5-2026-04-23` is `gpt-5.5`; `gpt-50` extends no key),
 * else — no such row — the default flat rate, with no key. The one lookup of
 * this table: `estimateCost` and `estimateCacheSavings` price through it.
 * Exported for tooling that reads the table from this module; not part of the
 * package's public entry point.
 */
export function pricingFor(model: string): { key?: string; pricing: ModelPricing } {
  if (Object.hasOwn(PRICING, model)) {
    return { key: model, pricing: PRICING[model] as ModelPricing };
  }
  let best: string | undefined;
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(`${key}-`) && (!best || key.length > best.length)) best = key;
  }
  return best !== undefined
    ? { key: best, pricing: PRICING[best] as ModelPricing }
    : { pricing: DEFAULT_PRICING };
}

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
  const { pricing } = pricingFor(model);
  const cachedRead = cacheReadTokens ?? 0;
  const cachedWrite = cacheWriteTokens ?? 0;
  const cachedReadRate = pricing.inputCachedRead ?? pricing.input;
  // Only Anthropic's rows carry a write rate, and only the Anthropic adapter
  // reports written tokens; a model with no write rate falls back to the
  // input rate. OpenAI bills a cache write on GPT-6.1, GPT-6 and GPT-5.6 at
  // 1.25× input, not modelled: its adapter reports no written count (see the
  // table's comment).
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
 * `inputCachedRead` rate (an unknown model, a model without caching), the
 * cached portion billed at the full input rate by `estimateCost` — savings
 * is 0.
 *
 * Rounding to 6 decimals via `Math.round(× 1e6) / 1e6` ensures values like
 * `2.6999999999999997e-2` collapse to exactly `0.027`, matching strict
 * equality assertions and DB row precision.
 *
 * Negative results clamped to 0 (defensive — should never happen since every
 * pricing entry has `inputCachedRead < input` by construction).
 */
export function estimateCacheSavings(model: string, cacheReadTokens: number): number {
  const { pricing } = pricingFor(model);
  const cachedRate = pricing.inputCachedRead ?? pricing.input;
  const raw = Math.max(0, (cacheReadTokens * (pricing.input - cachedRate)) / 1_000_000);
  return Math.round(raw * 1_000_000) / 1_000_000;
}
