import { MODEL_CAPABILITIES } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { estimateCacheSavings, estimateCost } from "./cost.js";

describe("estimateCost", () => {
  it("uses default pricing for an unknown model", () => {
    // DEFAULT_PRICING = { input: 3, output: 15 } per 1M tokens.
    const cost = estimateCost("self-hosted-llama-99-quantum", 1_000_000, 100_000);
    expect(cost).toBeCloseTo(3 + 1.5, 5);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCost("claude-opus-4-7", 0, 0)).toBe(0);
  });

  // VT-2 — every live model returns a positive number for non-zero tokens.
  // This catches a regression where a row is added but with malformed values
  // (e.g. NaN, missing input/output keys).
  it("every priced model returns a positive number for non-zero tokens", () => {
    // We can't enumerate PRICING directly (it's not exported), so we test
    // each row indirectly via a representative call. The list mirrors the
    // current cost.ts contents.
    const pricedModels = [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-4-5-20251001",
      "gpt-5.5-pro",
      "gpt-5.5",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4",
      "gpt-audio",
      "gpt-audio-1.5",
      "gpt-4o-audio-preview",
      "gpt-4o",
      "gpt-4o-mini",
      "o3-mini",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "mistral-large-3",
      "mistral-medium-3.5",
      "mistral-medium-3",
      "mistral-small-4",
      "mistral-small-3.1",
      "ministral-8b",
      "magistral-medium-1.2",
      "mistral-large-latest",
      "mistral-small-latest",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "openai/gpt-oss-safeguard-20b",
      "gpt-oss-120b",
      "gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "grok-4.3",
      "grok-4.1-fast",
      "grok-4.20-multi-agent",
    ];
    for (const model of pricedModels) {
      const cost = estimateCost(model, 1_000, 500);
      expect(cost, model).toBeGreaterThan(0);
      expect(cost, model).toBeLessThan(1); // sanity: no row should bill > $1 for tiny test usage
    }
  });

  // Spot-check the bug fix in 2.1 — gpt-5.5-pro was previously $5/$30
  // (copy-paste of gpt-5.5). Now $30/$180 per audited OpenAI docs.
  it("gpt-5.5-pro pricing matches OpenAI docs ($30/$180 per 1M)", () => {
    const cost = estimateCost("gpt-5.5-pro", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(30 + 180, 5);
  });

  // Spot-check the renames against capability.ts: the gemini-3.x preview
  // suffix is consistent in both files.
  it("gemini-3.1-pro-preview is priced (matches capability.ts naming)", () => {
    const cost = estimateCost("gemini-3.1-pro-preview", 1_000_000, 1_000_000);
    // Audited rate: $2 input, $12 output.
    expect(cost).toBeCloseTo(2 + 12, 5);
  });

  // Spot-check Groq prefix vs unprefixed parity (back-compat alias).
  it("openai/gpt-oss-120b and gpt-oss-120b have identical pricing (alias)", () => {
    const a = estimateCost("openai/gpt-oss-120b", 1_000_000, 1_000_000);
    const b = estimateCost("gpt-oss-120b", 1_000_000, 1_000_000);
    expect(a).toBe(b);
  });

  // RT-1 — legacy snapshot models still estimate (no breakage from the
  // refresh). Confirms back-compat for agents that hardcoded snapshot IDs.
  it.each([
    ["claude-haiku-4-5-20251001", 1, 5],
    ["claude-opus-4-20250514", 15, 75],
    ["claude-sonnet-4-20250514", 3, 15],
  ] as const)("legacy snapshot %s estimates at $%d/$%d per 1M", (model, expectedIn, expectedOut) => {
    const cost = estimateCost(model, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(expectedIn + expectedOut, 5);
  });

  // Capability ↔ cost parity (distinct from VT-3 docs↔code parity).
  // Every model that has a CAPABILITY entry should estimate to a positive
  // number (either via its own row or via DEFAULT_PRICING for fall-through
  // entries we explicitly accepted in 2.1's honesty comments — those
  // estimate to default $3/$15 which is still positive).
  it("every model in capability.ts estimates to a positive cost (no NaN, no zero)", () => {
    for (const [provider, models] of Object.entries(MODEL_CAPABILITIES)) {
      for (const modelName of Object.keys(models)) {
        const cost = estimateCost(modelName, 1_000, 500);
        expect(cost, `${provider}/${modelName}`).toBeGreaterThan(0);
        expect(Number.isFinite(cost), `${provider}/${modelName}`).toBe(true);
      }
    }
  });

  // VT-2 (#68 prompt-caching) — cost computation uses the cached-read rate
  // for the cached portion. Anthropic Sonnet 4.6: input=$3, cached_read=$0.30,
  // cached_write_5m=$3.75, output=$15.
  // Usage: { promptTokens: 2000, cacheReadTokens: 10000, cacheWriteTokens: 4000, completionTokens: 500 }
  // Expected: (2000×$3 + 10000×$0.30 + 4000×$3.75 + 500×$15) / 1_000_000
  //         = (6000 + 3000 + 15000 + 7500) / 1_000_000
  //         = 31500 / 1_000_000
  //         = $0.0315
  it("uses cached rate for cacheReadTokens + cacheWriteTokens (Anthropic Sonnet 4.6)", () => {
    const cost = estimateCost("claude-sonnet-4-6", 2_000, 500, 10_000, 4_000);
    expect(cost).toBeCloseTo(0.0315, 6);
  });

  // VT-2 — OpenAI gpt-5.5 cached rate (0.10× = 90% off).
  // Usage: { promptTokens: 1000, cacheReadTokens: 5000, completionTokens: 200 }
  // Expected: (1000×$5 + 5000×$0.50 + 200×$30) / 1_000_000
  //         = (5000 + 2500 + 6000) / 1_000_000 = $0.0135
  it("uses cached rate for OpenAI gpt-5.5 (0.10× = 90% off)", () => {
    const cost = estimateCost("gpt-5.5", 1_000, 200, 5_000);
    expect(cost).toBeCloseTo(0.0135, 6);
  });

  // VT-2 — Groq gpt-oss cached rate (0.5× = 50% off).
  // Usage: { promptTokens: 1000, cacheReadTokens: 2000, completionTokens: 500 }
  // Expected: (1000×$0.15 + 2000×$0.075 + 500×$0.6) / 1_000_000
  //         = (150 + 150 + 300) / 1_000_000 = $0.0006
  it("uses cached rate for Groq openai/gpt-oss-120b (0.5× = 50% off)", () => {
    const cost = estimateCost("openai/gpt-oss-120b", 1_000, 500, 2_000);
    expect(cost).toBeCloseTo(0.0006, 6);
  });

  // RT-2 (#68 regression) — when no cacheReadTokens / cacheWriteTokens are
  // provided, cost computation falls back to the pre-#68 behavior:
  // promptTokens × input + completionTokens × output. No NaN, no error.
  it("RT-2: no cache fields → falls back to pre-#68 formula (Mistral)", () => {
    // Mistral has no caching fields in PRICING (no native API).
    // Without cache args, behaves identically to before #68.
    const cost = estimateCost("mistral-large-3", 1_000, 500);
    // mistral-large-3: input=$2, output=$6
    // (1000×$2 + 500×$6) / 1M = (2000 + 3000) / 1M = $0.005
    expect(cost).toBeCloseTo(0.005, 6);
    expect(Number.isFinite(cost)).toBe(true);
  });

  // RT-2 — cacheReadTokens passed but model has no inputCachedRead rate
  // (Mistral) → conservatively bills cached portion at FULL input rate.
  // Never under-bills on missing data.
  it("RT-2: cacheReadTokens on uncached model bills at full input rate (conservative)", () => {
    const cost = estimateCost("mistral-large-3", 1_000, 500, 5_000);
    // (1000×$2 + 5000×$2 (fall-through to input) + 500×$6) / 1M
    // = (2000 + 10000 + 3000) / 1M = $0.015
    expect(cost).toBeCloseTo(0.015, 6);
  });

  // RT-2 — undefined cache args + zero cache args yield identical cost.
  it("RT-2: undefined and 0 cache args produce identical cost", () => {
    const a = estimateCost("claude-sonnet-4-6", 1_000, 500);
    const b = estimateCost("claude-sonnet-4-6", 1_000, 500, 0, 0);
    expect(a).toBe(b);
  });
});

describe("estimateCacheSavings", () => {
  // VT-3 — Anthropic Sonnet 4.6 (input=$3, inputCachedRead=$0.30 per 1M).
  // 10_000 cache_read_tokens × ($3 - $0.30) / 1_000_000 = 0.027 USD.
  // Math.round(× 1e6) / 1e6 ensures strict equality despite IEEE 754 noise
  // in the underlying (3 - 0.3) = 2.6999999999999997 subtraction.
  it("VT-3: Anthropic Sonnet 4.6 — 10K cache_read_tokens saves $0.027", () => {
    expect(estimateCacheSavings("claude-sonnet-4-6", 10_000)).toBe(0.027);
  });

  // VT-3 free-win — OpenAI gpt-5.5 (input=$5, inputCachedRead=$0.50 per 1M).
  // 10_000 × ($5 - $0.50) / 1_000_000 = 0.045 USD.
  it("VT-3 free-win: OpenAI gpt-5.5 — 10K cache_read_tokens saves $0.045", () => {
    expect(estimateCacheSavings("gpt-5.5", 10_000)).toBe(0.045);
  });

  // VT-4 — Mistral has no inputCachedRead → cachedRate = pricing.input → diff = 0.
  it("VT-4: Mistral large-3 — no inputCachedRead → savings = 0", () => {
    expect(estimateCacheSavings("mistral-large-3", 10_000)).toBe(0);
  });

  // VT-4 — unknown model uses DEFAULT_PRICING which has no inputCachedRead.
  it("VT-4: unknown model — DEFAULT_PRICING has no cache rate → savings = 0", () => {
    expect(estimateCacheSavings("unknown/foo-7b", 10_000)).toBe(0);
  });

  // VT-5 — defensive clamp: negative cacheReadTokens → 0 (Math.max guard).
  // No real model has inputCachedRead > input, but a negative input value
  // exercises the clamp directly without mocking PRICING.
  it("VT-5: negative cacheReadTokens clamps to 0 (defensive)", () => {
    expect(estimateCacheSavings("claude-sonnet-4-6", -100)).toBe(0);
  });

  // Edge — zero tokens returns 0.
  it("zero cache_read_tokens returns 0", () => {
    expect(estimateCacheSavings("claude-sonnet-4-6", 0)).toBe(0);
  });

  // Edge — Gemini 2.5 Flash (input=$0.15, cachedRead=$0.015 per 1M).
  // Spot-check a small saving rounds to 6 decimals correctly.
  // 7143 × ($0.15 - $0.015) / 1_000_000 = 7143 × 0.135 / 1_000_000 = 0.000964305 USD.
  // Rounded to 6 decimals = 0.000964.
  it("Gemini 2.5 Flash — 7143 cache_read_tokens saves $0.000964 (rounded)", () => {
    expect(estimateCacheSavings("gemini-2.5-flash", 7143)).toBe(0.000964);
  });
});
