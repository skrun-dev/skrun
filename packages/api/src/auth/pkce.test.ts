import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyChallenge } from "./pkce.js";

const challengeFor = (v: string) => createHash("sha256").update(v).digest("base64url");

describe("verifyChallenge (PKCE S256)", () => {
  it("accepts the matching verifier", () => {
    const verifier = "a".repeat(43);
    expect(verifyChallenge(verifier, challengeFor(verifier))).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const verifier = "a".repeat(43);
    expect(verifyChallenge("b".repeat(43), challengeFor(verifier))).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(verifyChallenge("", "x")).toBe(false);
    expect(verifyChallenge("x", "")).toBe(false);
  });

  it("rejects a challenge of a different length", () => {
    expect(verifyChallenge("verifier", "short")).toBe(false);
  });
});
