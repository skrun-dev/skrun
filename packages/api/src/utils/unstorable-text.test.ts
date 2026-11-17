import { describe, expect, it } from "vitest";
import { unstorableForm } from "./unstorable-text.js";

describe("unstorableForm", () => {
  it.each([
    ["plain text", "plain text"],
    ["an empty text", ""],
    ["a whole surrogate pair", "a \u{1F600} b"],
    ["two pairs in a row", "\u{1F600}\u{1F642}"],
  ])("finds nothing in %s", (_label, text) => {
    expect(unstorableForm(text)).toBeNull();
  });

  it.each([
    ["U+0000", "a\u0000b", "nul"],
    ["U+0000 and a lone surrogate: the NUL character", "\ud800\u0000", "nul"],
    ["a high surrogate at the end", "a\ud800", "lone_surrogate"],
    ["a low surrogate at the start", "\udc00a", "lone_surrogate"],
    ["a pair the wrong way round", "a\udc00\ud800b", "lone_surrogate"],
    ["a high surrogate before a whole pair", "\ud800\u{1F600}", "lone_surrogate"],
  ])("finds %s", (_label, text, form) => {
    expect(unstorableForm(text)).toBe(form);
  });

  it("answers the same when asked again: the shared expression keeps no state between calls", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(unstorableForm("a\ud800")).toBe("lone_surrogate");
      expect(unstorableForm("b\udc00")).toBe("lone_surrogate");
    }
  });
});
