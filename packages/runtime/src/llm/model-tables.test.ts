import { MODEL_CAPABILITIES } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_MIN_TOKENS,
  getCacheMinTokens,
  getMaxOutputTokens,
  MODEL_CACHE_MIN_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
} from "./model-tables.js";

describe("getCacheMinTokens", () => {
  it("gives a dated model id the threshold of its base model", () => {
    expect(getCacheMinTokens("claude-opus-4-7-20260416")).toBe(
      MODEL_CACHE_MIN_TOKENS["claude-opus-4-7"],
    );
    expect(getCacheMinTokens("claude-haiku-4-5-20251001")).toBe(
      MODEL_CACHE_MIN_TOKENS["claude-haiku-4-5"],
    );
  });

  it("reads an exact key as is", () => {
    expect(getCacheMinTokens("claude-opus-4-7")).toBe(2048);
  });

  it("prefers the longest matching key over a shorter one", () => {
    // `claude-sonnet-5` (1024) is also a prefix of `claude-sonnet-5-5` (512);
    // the longer key wins.
    expect(getCacheMinTokens("claude-sonnet-5-5-20260929")).toBe(512);
  });

  it("does not treat a key as a prefix without the dash boundary", () => {
    // `claude-sonnet-5` (1024) must not match `claude-sonnet-50`.
    expect(getCacheMinTokens("claude-sonnet-50")).toBe(DEFAULT_CACHE_MIN_TOKENS);
    expect(DEFAULT_CACHE_MIN_TOKENS).not.toBe(MODEL_CACHE_MIN_TOKENS["claude-sonnet-5"]);
  });

  it("falls back to the lowest threshold Anthropic documents, 512", () => {
    expect(DEFAULT_CACHE_MIN_TOKENS).toBe(512);
    expect(Math.min(...Object.values(MODEL_CACHE_MIN_TOKENS))).toBe(DEFAULT_CACHE_MIN_TOKENS);
  });

  it("falls back to the default for an unmapped id", () => {
    expect(getCacheMinTokens("some-other-model")).toBe(DEFAULT_CACHE_MIN_TOKENS);
  });
});

describe("getMaxOutputTokens", () => {
  it("gives a dated model id the limit of its base model", () => {
    expect(getMaxOutputTokens("claude-opus-4-7-20260416")).toBe(
      MODEL_MAX_OUTPUT_TOKENS["claude-opus-4-7"],
    );
  });

  it("prefers the longest matching key over a shorter one", () => {
    // `gpt-5` is also a prefix of `gpt-5-mini`; the longer key wins. Both
    // limits are equal today: the threshold case above tells the two keys
    // apart through the same lookup.
    expect(getMaxOutputTokens("gpt-5-mini-2025-08-07")).toBe(MODEL_MAX_OUTPUT_TOKENS["gpt-5-mini"]);
  });

  it("knows no limit for an unmapped id, nor for a key extended without the dash boundary", () => {
    expect(getMaxOutputTokens("some-other-model")).toBeUndefined();
    expect(getMaxOutputTokens("gpt-50")).toBeUndefined();
  });

  it("has a row, a positive whole number, for every key of the capability matrix", () => {
    const keys = Object.values(MODEL_CAPABILITIES).flatMap((rows) => Object.keys(rows));
    expect(keys.length).toBeGreaterThan(0);
    const missing = keys.filter((key) => !Object.hasOwn(MODEL_MAX_OUTPUT_TOKENS, key));
    expect(missing).toEqual([]);
    for (const value of Object.values(MODEL_MAX_OUTPUT_TOKENS)) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
  });

  it("gives Gemini 4 Argon the ceiling of the adapter's call, not the model's limit", () => {
    // A non-streaming generateContent call stops at 32,768 output tokens
    // unless continued; the model writes up to 65,536 in one synchronous
    // response, 1,048,576 with long decode. The public catalogs disagree
    // (32,768 and 1,048,576): the drift check, which needs every source
    // against a row to fail it, passes either. Pinned both ways here.
    expect(getMaxOutputTokens("gemini-4-argon")).toBe(32_768);
  });
});
