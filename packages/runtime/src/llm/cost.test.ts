import { MODEL_CAPABILITIES } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { estimateCacheSavings, estimateCost, PRICING, pricingFor } from "./cost.js";

describe("estimateCost", () => {
  it("uses default pricing for an unknown model", () => {
    // DEFAULT_PRICING = { input: 3, output: 15 } per 1M tokens.
    const cost = estimateCost("self-hosted-llama-99-quantum", 1_000_000, 100_000);
    expect(cost).toBeCloseTo(3 + 1.5, 5);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCost("claude-opus-4-7", 0, 0)).toBe(0);
  });

  // Every row prices a small call above zero and below a dollar: a row added
  // with a malformed value (NaN, a missing key, a price per token instead of
  // per million) fails here.
  it("every row of the table prices a small call above zero and below a dollar", () => {
    const models = Object.keys(PRICING);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const cost = estimateCost(model, 1_000, 500);
      expect(cost, model).toBeGreaterThan(0);
      expect(cost, model).toBeLessThan(1);
    }
  });

  it("every cache read rate of the table is below its row's input rate", () => {
    for (const [model, pricing] of Object.entries(PRICING)) {
      if (pricing.inputCachedRead === undefined) continue;
      expect(pricing.inputCachedRead, model).toBeLessThan(pricing.input);
    }
  });

  // Spot-check the renames against capability.ts: the gemini-3.x preview
  // suffix is consistent in both files.
  it("gemini-3.1-pro-preview is priced (matches capability.ts naming)", () => {
    const cost = estimateCost("gemini-3.1-pro-preview", 1_000_000, 1_000_000);
    // Audited rate: $2 input, $12 output.
    expect(cost).toBeCloseTo(2 + 12, 5);
  });

  // A dated id of a current model takes its row; a retired dated id that no
  // row covers takes the default flat rate.
  it.each([
    ["claude-haiku-4-5-20251001", 1, 5],
    ["claude-opus-4-20250514", 3, 15],
    ["claude-sonnet-4-20250514", 3, 15],
  ] as const)("the dated id %s estimates at $%d/$%d per 1M", (model, expectedIn, expectedOut) => {
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

  // With no cacheReadTokens / cacheWriteTokens, the cost is promptTokens ×
  // input + completionTokens × output. No NaN, no error.
  it("no cache fields: the prompt at the input rate, the completion at the output rate", () => {
    const cost = estimateCost("mistral-large-2512", 1_000, 500);
    // mistral-large-2512: input=$0.5, output=$1.5
    // (1000×$0.5 + 500×$1.5) / 1M = (500 + 750) / 1M = $0.00125
    expect(cost).toBeCloseTo(0.00125, 8);
    expect(Number.isFinite(cost)).toBe(true);
  });

  // cacheReadTokens passed but the model has no inputCachedRead rate →
  // the cached portion bills at the FULL input rate. Never under-bills on
  // missing data.
  it("cacheReadTokens on a model with no cache rate bill at the full input rate (conservative)", () => {
    const cost = estimateCost("gpt-audio-1.5", 1_000, 500, 5_000);
    // (1000×$2.5 + 5000×$2.5 (fall-through to input) + 500×$10) / 1M
    // = (2500 + 12500 + 5000) / 1M = $0.02
    expect(cost).toBeCloseTo(0.02, 8);
  });

  // Mistral bills a cached prefix at a tenth of its input rate.
  it("Mistral: the cached portion bills at a tenth of the input rate", () => {
    const cost = estimateCost("mistral-large-2512", 1_000, 500, 5_000);
    // (1000×$0.5 + 5000×$0.05 + 500×$1.5) / 1M = (500 + 250 + 750) / 1M = $0.0015
    expect(cost).toBeCloseTo(0.0015, 8);
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

  // A model with no inputCachedRead → cachedRate = pricing.input → diff = 0.
  it("a model with no cache read rate (gpt-audio-1.5) saves nothing", () => {
    expect(estimateCacheSavings("gpt-audio-1.5", 10_000)).toBe(0);
  });

  it("Mistral Large 3 — reads at a tenth of the input rate: 90% saved", () => {
    // 10k × ($0.5 - $0.05) / 1M = $0.0045
    expect(estimateCacheSavings("mistral-large-2512", 10_000)).toBe(0.0045);
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

  // Edge — Gemini 2.5 Flash (input=$0.30, cachedRead=$0.03 per 1M).
  // Spot-check a small saving rounds to 6 decimals correctly.
  // 7143 × ($0.30 - $0.03) / 1_000_000 = 7143 × 0.27 / 1_000_000 = 0.00192861 USD.
  // Rounded to 6 decimals = 0.001929.
  it("Gemini 2.5 Flash — 7143 cache_read_tokens saves $0.001929 (rounded)", () => {
    expect(estimateCacheSavings("gemini-2.5-flash", 7143)).toBe(0.001929);
  });
});

describe("pricingFor", () => {
  it("returns a model's own row, with its key", () => {
    expect(pricingFor("claude-haiku-4-5")).toEqual({
      key: "claude-haiku-4-5",
      pricing: PRICING["claude-haiku-4-5"],
    });
  });

  it("prices Claude Haiku 5.5 at its rates for a prompt up to 100,000 tokens", () => {
    expect(pricingFor("claude-haiku-5-5")).toEqual({
      key: "claude-haiku-5-5",
      pricing: {
        input: 0.1,
        output: 0.5,
        inputCachedRead: 0.01,
        inputCachedWrite5m: 0.125,
        inputCachedWrite1h: 0.2,
      },
    });
  });

  it("prices Mistral Large 4 by its own row, not Mistral Large 3's", () => {
    expect(pricingFor("mistral-large-4")).toEqual({
      key: "mistral-large-4",
      pricing: { input: 0.7, output: 2.1, inputCachedRead: 0.07 },
    });
  });

  it("prices Mistral Large 4's versioned ids at its row", () => {
    for (const model of ["mistral-large-4-0", "mistral-large-4-0-8"]) {
      expect(pricingFor(model).key, model).toBe("mistral-large-4");
    }
  });

  // Claude Fable 5.2 and Mythos 5.2 extend claude-fable-5 and claude-mythos-5
  // ($10 / $50, cache read $1) and are sold for less: a row each, or they are
  // billed at the price of the model they extend.
  it.each([
    "claude-fable-5-2",
    "claude-mythos-5-2",
  ])("prices %s by its own row, not the 5 model's", (model) => {
    expect(pricingFor(model)).toEqual({
      key: model,
      pricing: {
        input: 8,
        output: 40,
        inputCachedRead: 0.2,
        inputCachedWrite5m: 10,
        inputCachedWrite1h: 16,
      },
    });
  });

  it("reads Groq's gpt-oss-safeguard-20b cache at half its input rate", () => {
    const { pricing } = pricingFor("openai/gpt-oss-safeguard-20b");
    expect(pricing.inputCachedRead).toBe(pricing.input / 2);
  });

  it("prices Gemini 4 Argon at its introductory price, by its own row", () => {
    expect(pricingFor("gemini-4-argon")).toEqual({
      key: "gemini-4-argon",
      pricing: { input: 2, output: 10, inputCachedRead: 0.1 },
    });
  });

  it("prices GPT-6.1 Terra by its own row, not at the default rate", () => {
    expect(pricingFor("gpt-6.1-terra")).toEqual({
      key: "gpt-6.1-terra",
      pricing: { input: 1, output: 5, inputCachedRead: 0.05 },
    });
  });

  it("returns the default flat rate, with no key, for a model no key covers", () => {
    expect(pricingFor("self-hosted-llama-99-quantum")).toEqual({
      pricing: { input: 3, output: 15 },
    });
  });

  it("is the lookup estimateCost prices through", () => {
    const { pricing } = pricingFor("gpt-4o-mini");
    expect(estimateCost("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(
      pricing.input + pricing.output,
      10,
    );
  });
});

describe("the pricing lookup — the longest key a model id extends", () => {
  it("prices a dated id as its base model", () => {
    expect(pricingFor("gpt-5.5-2026-04-23")).toEqual({
      key: "gpt-5.5",
      pricing: PRICING["gpt-5.5"],
    });
    expect(estimateCost("gpt-5.5-2026-04-23", 1_000_000, 1_000_000)).toBeCloseTo(5 + 30, 6);
    expect(estimateCacheSavings("gpt-5.5-2026-04-23", 10_000)).toBe(0.045);
  });

  it("lets a row of its own win over the key the id extends", () => {
    // gpt-5.5-cyber extends gpt-5.5 ($5/$30) and has a price of its own.
    expect(pricingFor("gpt-5.5-cyber").key).toBe("gpt-5.5-cyber");
    expect(estimateCost("gpt-5.5-cyber", 1_000_000, 1_000_000)).toBeCloseTo(12.5 + 75, 6);
  });

  it("prices a retired dated id with no row of its own as the key it extends", () => {
    // gpt-4o-2024-05-13 ($5/$15) lost its row when OpenAI shut it down on
    // 2026-10-23: a call to it fails at OpenAI's API, before any token.
    expect(pricingFor("gpt-4o-2024-05-13")).toEqual({ key: "gpt-4o", pricing: PRICING["gpt-4o"] });
  });

  it("takes the longest key the id extends", () => {
    // Extends both claude-sonnet-5 and claude-sonnet-5-5.
    expect(pricingFor("claude-sonnet-5-5-20260929").key).toBe("claude-sonnet-5-5");
  });

  it("extends a key only after a dash", () => {
    expect(pricingFor("gpt-5.50")).toEqual({ pricing: { input: 3, output: 15 } });
  });

  it("prices an unknown id at the default flat rate", () => {
    expect(estimateCost("self-hosted-llama-99-quantum", 1_000_000, 1_000_000)).toBeCloseTo(
      3 + 15,
      6,
    );
  });
});

describe("cache read rates, model by model", () => {
  it("reads Claude Opus 5.5 at 0.05× its input rate", () => {
    const { pricing } = pricingFor("claude-opus-5-5");
    expect(pricing.inputCachedRead).toBeCloseTo(pricing.input * 0.05, 10);
    // 10k × ($4 - $0.20) / 1M
    expect(estimateCacheSavings("claude-opus-5-5", 10_000)).toBe(0.038);
  });

  it("reads Claude Sonnet 5.5 at 0.05× its input rate", () => {
    const { pricing } = pricingFor("claude-sonnet-5-5");
    expect(pricing.inputCachedRead).toBeCloseTo(pricing.input * 0.05, 10);
    // 10k × ($2 - $0.10) / 1M
    expect(estimateCacheSavings("claude-sonnet-5-5", 10_000)).toBe(0.019);
  });

  it.each([
    "claude-fable-5-2",
    "claude-mythos-5-2",
  ])("reads %s at 0.025× its input rate", (model) => {
    const { pricing } = pricingFor(model);
    expect(pricing.inputCachedRead).toBeCloseTo(pricing.input * 0.025, 10);
    // 10k × ($8 - $0.20) / 1M
    expect(estimateCacheSavings(model, 10_000)).toBe(0.078);
  });

  it("reads Claude Fable 5.1 at 0.025× its input rate", () => {
    const { pricing } = pricingFor("claude-fable-5-1");
    expect(pricing.inputCachedRead).toBeCloseTo(pricing.input * 0.025, 10);
    // 10k × ($10 - $0.25) / 1M
    expect(estimateCacheSavings("claude-fable-5-1", 10_000)).toBe(0.0975);
  });
});
