import { describe, expect, it } from "vitest";
import { getMalformedAllowlistEntries, isGithubUserAllowed } from "./signup-allowlist.js";

const alice = { id: 90123, login: "alice" };
const carol = { id: 55, login: "carol" };

/** Build an env object with (or without) the allowlist set — keeps tests isolated. */
function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { SKRUN_ALLOWED_GITHUB_USERS: value };
}

describe("signup-allowlist · isGithubUserAllowed", () => {
  // SC-1 — off by default (open)
  it("unset → open", () => {
    expect(isGithubUserAllowed(alice, env())).toBe(true);
  });
  it("empty string → open", () => {
    expect(isGithubUserAllowed(alice, env(""))).toBe(true);
  });
  it("whitespace-only → open", () => {
    expect(isGithubUserAllowed(alice, env("   "))).toBe(true);
  });
  it("only-blank entries (',, ,') → open", () => {
    expect(isGithubUserAllowed(alice, env(",, ,"))).toBe(true);
  });

  // SC-2 — username, case-insensitive
  it("username match is case-insensitive", () => {
    const e = env("alice,bob");
    expect(isGithubUserAllowed({ id: 1, login: "alice" }, e)).toBe(true);
    expect(isGithubUserAllowed({ id: 1, login: "Alice" }, e)).toBe(true);
    expect(isGithubUserAllowed({ id: 1, login: "ALICE" }, e)).toBe(true);
  });
  it("non-listed username → rejected", () => {
    expect(isGithubUserAllowed(carol, env("alice,bob"))).toBe(false);
  });

  // SC-3 — id:NNN, rename-proof
  it("id:NNN matches the id regardless of login (rename-proof)", () => {
    const e = env("id:90123");
    expect(isGithubUserAllowed({ id: 90123, login: "old-name" }, e)).toBe(true);
    expect(isGithubUserAllowed({ id: 90123, login: "new-name" }, e)).toBe(true);
  });
  it("non-matching id → rejected", () => {
    expect(isGithubUserAllowed({ id: 55, login: "x" }, env("id:90123"))).toBe(false);
  });
  it("the id: prefix is case-insensitive (ID:)", () => {
    expect(isGithubUserAllowed({ id: 90123, login: "x" }, env("ID:90123"))).toBe(true);
  });

  // SC-3 — malformed id: → no-match (+ fail-closed when it's the only entry)
  it("malformed id: (blank / non-numeric suffix) → no-match", () => {
    expect(isGithubUserAllowed({ id: 90123, login: "x" }, env("id:"))).toBe(false);
    expect(isGithubUserAllowed({ id: 90123, login: "x" }, env("id:abc"))).toBe(false);
  });
  it("a list of only-malformed entries enforces (matches no one, not open)", () => {
    // the operator clearly tried to restrict → fail-closed, never silently open
    expect(isGithubUserAllowed({ id: 90123, login: "x" }, env("id:abc"))).toBe(false);
  });

  // mixed / duplicates / trimming
  it("mixed username + id entries", () => {
    const e = env("alice, id:90123, bob");
    expect(isGithubUserAllowed({ id: 1, login: "bob" }, e)).toBe(true);
    expect(isGithubUserAllowed({ id: 90123, login: "renamed" }, e)).toBe(true);
    expect(isGithubUserAllowed({ id: 2, login: "carol" }, e)).toBe(false);
  });
  it("duplicate entries are harmless", () => {
    expect(isGithubUserAllowed({ id: 1, login: "alice" }, env("alice,alice,alice"))).toBe(true);
  });
  it("entries are trimmed", () => {
    expect(isGithubUserAllowed({ id: 1, login: "alice" }, env("  alice  ,  bob  "))).toBe(true);
  });

  // scale
  it("scales to a large list (1000 entries)", () => {
    const names = Array.from({ length: 1000 }, (_, i) => `user${i}`);
    const e = env(names.join(","));
    expect(isGithubUserAllowed({ id: 1, login: "user999" }, e)).toBe(true);
    expect(isGithubUserAllowed({ id: 1, login: "nobody" }, e)).toBe(false);
  });
});

describe("signup-allowlist · getMalformedAllowlistEntries", () => {
  it("returns [] for a clean config (or unset)", () => {
    expect(getMalformedAllowlistEntries(env("alice,id:90123"))).toEqual([]);
    expect(getMalformedAllowlistEntries(env())).toEqual([]);
  });
  it("surfaces malformed id: entries, preserving the original text", () => {
    expect(getMalformedAllowlistEntries(env("alice, id:, id:abc, bob"))).toEqual(["id:", "id:abc"]);
  });
});
