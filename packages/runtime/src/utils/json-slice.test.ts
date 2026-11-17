import { describe, expect, it } from "vitest";
import { jsonObjectSlice } from "./json-slice.js";

/**
 * The oracle: the greedy pattern the slice must agree with — from a `{`, anything
 * (line ends included), to a `}`. It lives here, never in the code that ships.
 */
const GREEDY_OBJECT = /\{[\s\S]*\}/;
const byPattern = (text: string): string | undefined => text.match(GREEDY_OBJECT)?.[0];

/** Numbers in [0, 1) from a fixed seed (mulberry32): the same strings at every run, and no dependency. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The braces; the line ends a match must cross (`\n`, `\r`, the line separator
 * U+2028); a space, a letter, a letter of two UTF-8 bytes, and a character of
 * two UTF-16 units.
 */
const ALPHABET = ["{", "}", "\n", "\r", " ", " ", "a", "é", "😀"];

describe("jsonObjectSlice — the JSON object of a model's answer", () => {
  it("takes from the first '{' to the last '}' after it, and finds nothing when no '}' follows the first '{'", () => {
    const cases: Array<[string, string | undefined]> = [
      ["", undefined],
      ["}{", undefined],
      ["{{", undefined],
      ["a{b}c}", "{b}c}"],
      ['Here it is: {"a": {"b": 1}} — done.', '{"a": {"b": 1}}'],
      ["no object at all", undefined],
    ];
    for (const [text, expected] of cases) {
      expect(jsonObjectSlice(text)).toBe(expected);
      expect(byPattern(text)).toBe(expected);
    }
  });

  it("finds what the greedy pattern finds, on 200,000 strings drawn from a fixed seed", () => {
    const next = seeded(0x5eed);
    const disagreements: string[] = [];
    let found = 0;
    let none = 0;
    for (let n = 0; n < 200_000; n++) {
      const length = Math.floor(next() * 25);
      let text = "";
      for (let k = 0; k < length; k++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
      const slice = jsonObjectSlice(text);
      if (slice !== byPattern(text)) disagreements.push(JSON.stringify(text));
      if (slice === undefined) none++;
      else found++;
    }

    expect(disagreements.slice(0, 5)).toEqual([]);
    expect(disagreements.length).toBe(0);
    // Both outcomes drawn often: the agreement is not that of strings that never hold a slice.
    expect(found).toBeGreaterThan(20_000);
    expect(none).toBeGreaterThan(20_000);
  });

  it("reads 4 MiB of '{' and no '}' in under 50 ms, and finds no object", () => {
    const text = "{".repeat(4 * 1024 * 1024);

    const started = performance.now();
    const slice = jsonObjectSlice(text);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(50);
    expect(slice).toBeUndefined();
  });
});
