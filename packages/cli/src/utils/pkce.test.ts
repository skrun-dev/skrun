import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkce } from "./pkce.js";

describe("generatePkce", () => {
  it("produces a 43-char base64url verifier and the matching S256 challenge", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(method).toBe("S256");
    // The challenge is the S256 of the verifier (the same identity the server checks).
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("is unique per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});
