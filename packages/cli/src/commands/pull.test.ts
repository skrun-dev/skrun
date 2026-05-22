import { describe, expect, it } from "vitest";
import { formatPullErrorMessage } from "./pull.js";

describe("formatPullErrorMessage", () => {
  // VT-19 (#80): on 404 the CLI prints the 3-cause SC-17 message and
  // intentionally does NOT confirm/deny the agent's existence. The
  // multi-tenant filter returns 404 indistinguishably whether the agent
  // doesn't exist OR the caller is not the owner — the CLI must respect
  // the same opacity.
  it("VT-19 (#80): on 404 prints 3-cause hint without confirming existence", () => {
    const err = Object.assign(new Error("Agent acme/secret not found"), {
      status: 404,
      code: "NOT_FOUND",
    });
    const msg = formatPullErrorMessage(err, "acme/secret");

    // 3-cause structure
    expect(msg).toContain("Agent 'acme/secret' not found");
    expect(msg).toContain("Possible causes");
    expect(msg).toContain("Typo in the agent name");
    expect(msg).toContain("skrun whoami");
    expect(msg).toContain("doesn't exist");

    // Critically — the message must NOT confirm/deny existence or use
    // permission-related language that would leak the multi-tenant rule.
    expect(msg).not.toMatch(/permission/i);
    expect(msg).not.toMatch(/forbidden/i);
    expect(msg).not.toMatch(/access denied/i);
    expect(msg).not.toMatch(/private/i);
    expect(msg).not.toMatch(/unauthorized/i);
  });

  it("VT-19b (#80): on non-404 returns the raw error message verbatim", () => {
    const err = Object.assign(new Error("Pull failed (500): internal error"), {
      status: 500,
      code: "INTERNAL",
    });
    const msg = formatPullErrorMessage(err, "acme/foo");
    expect(msg).toBe("Pull failed (500): internal error");
  });

  it("VT-19c (#80): falls back to code=NOT_FOUND when status missing (defense in depth)", () => {
    // An error without `status` but with `code: NOT_FOUND` should still
    // trigger the 3-cause hint — the helper checks both signals.
    const err = Object.assign(new Error("Agent x/y not found"), { code: "NOT_FOUND" });
    const msg = formatPullErrorMessage(err, "x/y");
    expect(msg).toContain("Possible causes");
  });

  it("handles non-Error values gracefully", () => {
    expect(formatPullErrorMessage("plain string error", "acme/foo")).toBe("plain string error");
    expect(formatPullErrorMessage({ weird: true }, "acme/foo")).toBe("[object Object]");
  });
});
