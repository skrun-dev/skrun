import { describe, expect, it } from "vitest";
import {
  derivedNamespace,
  NAMESPACE_MAX_ATTEMPTS,
  NamespaceUnavailableError,
  namespaceBase,
} from "./namespace.js";

// The shape every agent route accepts for a namespace (the path-segment rule
// of routes/registry.ts). A name this module hands out must always pass it.
const PATH_SEGMENT = /^[a-z0-9-]{1,64}$/;

describe("namespaceBase — the default name of a new account", () => {
  it("is the GitHub login in lowercase", () => {
    expect(namespaceBase("Alice")).toBe("alice");
    expect(namespaceBase("alice-dev")).toBe("alice-dev");
    expect(namespaceBase("A1b2")).toBe("a1b2");
  });

  it("replaces every character outside [a-z0-9-] with a hyphen", () => {
    expect(namespaceBase("Bob_Acme")).toBe("bob-acme");
    expect(namespaceBase("a.b")).toBe("a-b");
    expect(namespaceBase("élan")).toBe("lan");
  });

  it("merges consecutive hyphens, so a base never carries the derived suffix's double hyphen", () => {
    expect(namespaceBase("a__b")).toBe("a-b");
    expect(namespaceBase("a-_-b")).toBe("a-b");
    expect(namespaceBase("a--b")).toBe("a-b");
  });

  it("strips leading and trailing hyphens", () => {
    expect(namespaceBase("_x_")).toBe("x");
    expect(namespaceBase("-x-")).toBe("x");
  });

  it("falls back to `user` when nothing is left", () => {
    expect(namespaceBase("")).toBe("user");
    expect(namespaceBase("___")).toBe("user");
    expect(namespaceBase("ÉÈ")).toBe("user");
  });

  it("truncates to 64 characters, without a trailing hyphen", () => {
    expect(namespaceBase("a".repeat(80))).toBe("a".repeat(64));
    // the 64th character would be a hyphen: it goes too
    const login = `${"a".repeat(63)}_b`;
    expect(namespaceBase(login)).toBe("a".repeat(63));
  });

  it("maps two different logins to the same base — the derivation then keeps them apart", () => {
    // `a_b` and `a-b` both sanitize to `a-b`; the first account created takes
    // it, the second gets `a-b--2` (checked against every backend by the
    // adapter contract).
    expect(namespaceBase("a_b")).toBe(namespaceBase("a-b"));
    expect(derivedNamespace(namespaceBase("a-b"), 2)).toBe("a-b--2");
  });

  it("always yields a valid path segment", () => {
    for (const login of ["Alice", "Bob_Acme", "_x_", "", "a".repeat(200), "--", "Ünïcødé_Ñame"]) {
      expect(namespaceBase(login)).toMatch(PATH_SEGMENT);
    }
  });
});

describe("derivedNamespace — the name tried at attempt n", () => {
  it("is the base itself at n = 1", () => {
    expect(derivedNamespace("alice", 1)).toBe("alice");
  });

  it("is `<base>--<n>` from n = 2", () => {
    expect(derivedNamespace("alice", 2)).toBe("alice--2");
    expect(derivedNamespace("alice", 3)).toBe("alice--3");
    expect(derivedNamespace("alice", 10)).toBe("alice--10");
    expect(derivedNamespace("alice", NAMESPACE_MAX_ATTEMPTS)).toBe(
      `alice--${NAMESPACE_MAX_ATTEMPTS}`,
    );
  });

  it("truncates a 64-character base so the derived name still fits in 64", () => {
    const base = "a".repeat(64);
    const name = derivedNamespace(base, 2);
    expect(name).toHaveLength(64);
    expect(name.endsWith("--2")).toBe(true);
    expect(derivedNamespace(base, 1000)).toHaveLength(64);
  });

  it("never leaves the truncated base ending in a hyphen", () => {
    // truncated to 61 characters, the base would end in "-"
    const base = `${"a".repeat(60)}-bbb`;
    const name = derivedNamespace(base, 2);
    expect(name).toBe(`${"a".repeat(60)}--2`);
    expect(name).toMatch(PATH_SEGMENT);
  });

  it("always yields a valid path segment", () => {
    for (const base of ["alice", "a".repeat(64), `${"a".repeat(60)}-bbb`, "x"]) {
      for (const n of [1, 2, 9, 10, 99, 100, NAMESPACE_MAX_ATTEMPTS]) {
        expect(derivedNamespace(base, n)).toMatch(PATH_SEGMENT);
      }
    }
  });

  it("refuses an attempt number that is not a positive integer", () => {
    expect(() => derivedNamespace("alice", 0)).toThrow(RangeError);
    expect(() => derivedNamespace("alice", -1)).toThrow(RangeError);
    expect(() => derivedNamespace("alice", 1.5)).toThrow(RangeError);
  });
});

describe("NamespaceUnavailableError", () => {
  it("is a named error that carries no login", () => {
    const err = new NamespaceUnavailableError(NAMESPACE_MAX_ATTEMPTS);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NamespaceUnavailableError");
    expect(err.code).toBe("NAMESPACE_UNAVAILABLE");
    expect(err.message).toContain(String(NAMESPACE_MAX_ATTEMPTS));
  });
});
