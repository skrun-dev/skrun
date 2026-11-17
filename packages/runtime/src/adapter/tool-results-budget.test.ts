import { describe, expect, it } from "vitest";
import {
  TOOL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResult,
} from "../files/output-rules.js";
import type { ToolResult } from "../tools/types.js";
import {
  RUN_TOOL_RESULTS_MAX_BYTES,
  TOOL_RESULT_NOT_KEPT_MARKER,
  ToolResultsBudget,
} from "./tool-results-budget.js";

const MIB = 1024 * 1024;

/** Bytes of UTF-8 of a content. */
const bytesOf = (content: string): number => Buffer.byteLength(content, "utf8");

/** The number of bytes a text names: "8 MiB", "512 KiB", "1000 bytes". */
function bytesNamedIn(text: string): number | undefined {
  const named = /(\d+) (MiB|KiB|bytes)\b/.exec(text);
  if (!named) return undefined;
  const unit = { MiB: MIB, KiB: 1024, bytes: 1 }[named[2] as "MiB" | "KiB" | "bytes"];
  return Number(named[1]) * unit;
}

/** A result of `bytes` bytes of ASCII content. */
const resultOf = (bytes: number, isError = false): ToolResult => ({
  content: "r".repeat(bytes),
  isError,
});

describe("the tool results a run keeps", () => {
  it("names in its marker the bound it keeps to: the constant's, never a copy of it", () => {
    expect(RUN_TOOL_RESULTS_MAX_BYTES).toBe(8 * MIB);
    expect(bytesNamedIn(TOOL_RESULT_NOT_KEPT_MARKER)).toBe(RUN_TOOL_RESULTS_MAX_BYTES);
  });

  it("says nothing in its marker of whether the tool ran: a call it replaces may never have run", () => {
    expect(TOOL_RESULT_NOT_KEPT_MARKER).not.toMatch(/\bcalled\b/i);
    expect(TOOL_RESULT_NOT_KEPT_MARKER).not.toMatch(/\btool (ran|was|did)\b/i);
  });

  it("keeps a result under the cut as it is, says it kept it whole, and counts its bytes of UTF-8", () => {
    const budget = new ToolResultsBudget();
    const small = { content: "é€😀", isError: false };

    const { result, kept } = budget.keep(small);

    expect(result).toBe(small);
    expect(kept).toBe("whole");
    expect(budget.bytesKept).toBe(bytesOf("é€😀"));
    expect(budget.bytesKept).toBe(9);
  });

  it("cuts a result over 1 MiB as the sandbox cuts it, says it cut it, and counts what it keeps of it", () => {
    const budget = new ToolResultsBudget();
    const big = resultOf(3 * MIB);

    const { result, kept } = budget.keep(big);

    expect(kept).toBe("cut");
    expect(result).toEqual(truncateToolResult(big));
    expect(result.content.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      TOOL_RESPONSE_MAX_BYTES,
    );
    expect(budget.bytesKept).toBe(bytesOf(result.content));
  });

  it("leaves a result the sandbox already cut unchanged, and says it is a cut one", () => {
    const budget = new ToolResultsBudget();
    const cutBySandbox = truncateToolResult(resultOf(2 * MIB));

    const { result, kept } = budget.keep(cutBySandbox);

    expect(result).toBe(cutBySandbox);
    expect(kept).toBe("cut");
  });

  it("replaces the result that would take the run past 8 MiB, says it replaced it, and keeps the sum within it", () => {
    const budget = new ToolResultsBudget();
    const seen = Array.from({ length: 12 }, () => budget.keep(resultOf(MIB)));

    const kept = seen.filter((r) => r.result.content !== TOOL_RESULT_NOT_KEPT_MARKER);
    const replaced = seen.filter((r) => r.result.content === TOOL_RESULT_NOT_KEPT_MARKER);
    // Each 1 MiB result is cut just under 1 MiB: eight fit, the ninth would not.
    expect(kept).toHaveLength(8);
    expect(replaced).toHaveLength(4);
    expect(seen.slice(0, 8)).toEqual(kept);
    expect(seen.map((r) => r.kept)).toEqual([
      ...Array(8).fill("cut"),
      ...Array(4).fill("replaced"),
    ]);
    const sum = kept.reduce((total, r) => total + bytesOf(r.result.content), 0);
    expect(sum).toBeLessThanOrEqual(RUN_TOOL_RESULTS_MAX_BYTES);
    expect(budget.bytesKept).toBe(sum);
  });

  it("keeps a result that fits exactly, and replaces one byte more", () => {
    const filled = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) filled.keep(resultOf(MIB - 1024));
    const room = RUN_TOOL_RESULTS_MAX_BYTES - filled.bytesKept;
    expect(room).toBe(8 * 1024);

    const exact = resultOf(room);
    expect(filled.keep(exact).result).toBe(exact);
    expect(filled.bytesKept).toBe(RUN_TOOL_RESULTS_MAX_BYTES);
    expect(filled.keep(resultOf(1)).result.content).toBe(TOOL_RESULT_NOT_KEPT_MARKER);

    const almost = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) almost.keep(resultOf(MIB - 1024));
    expect(almost.keep(resultOf(room + 1)).result.content).toBe(TOOL_RESULT_NOT_KEPT_MARKER);
    expect(almost.bytesKept).toBe(RUN_TOOL_RESULTS_MAX_BYTES - room);
  });

  it("keeps a later result that still fits after one was replaced, and never rewrites what it kept", () => {
    const budget = new ToolResultsBudget();
    const first = budget.keep(resultOf(MIB - 1024)).result;
    const firstContent = first.content;
    for (let i = 0; i < 7; i++) budget.keep(resultOf(MIB - 1024));

    expect(budget.keep(resultOf(MIB)).result.content).toBe(TOOL_RESULT_NOT_KEPT_MARKER);
    const small = { content: "still fits", isError: false };
    expect(budget.keep(small)).toEqual({ result: small, kept: "whole" });
    expect(first.content).toBe(firstContent);
  });

  it("counts an error result like any other, and a replaced error stays an error", () => {
    const budget = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) budget.keep(resultOf(MIB - 1024, true));
    expect(budget.bytesKept).toBe(8 * (MIB - 1024));

    const replaced = budget.keep(resultOf(MIB, true));
    expect(replaced).toEqual({
      result: { content: TOOL_RESULT_NOT_KEPT_MARKER, isError: true },
      kept: "replaced",
    });
    const replacedSuccess = budget.keep(resultOf(MIB, false));
    expect(replacedSuccess).toEqual({
      result: { content: TOOL_RESULT_NOT_KEPT_MARKER, isError: false },
      kept: "replaced",
    });
  });

  it("keeps the code an error starts with in front of the marker that replaces it, and counts neither", () => {
    const budget = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) budget.keep(resultOf(MIB - 1024));
    const before = budget.bytesKept;
    const install = `[SCRIPT_DEPS_INSTALL_FAILED] ${"x".repeat(MIB)}`;

    const error = budget.keep({ content: install, isError: true });
    // A success that starts the same way carries no code: the marker alone.
    const success = budget.keep({ content: install, isError: false });

    expect(error).toEqual({
      result: {
        content: `[SCRIPT_DEPS_INSTALL_FAILED] ${TOOL_RESULT_NOT_KEPT_MARKER}`,
        isError: true,
      },
      kept: "replaced",
    });
    expect(success.result).toEqual({ content: TOOL_RESULT_NOT_KEPT_MARKER, isError: false });
    expect(budget.bytesKept).toBe(before);
  });

  it("knows a code of up to 64 capitals and underscores: past them, a bracketed start is no code", () => {
    const budget = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) budget.keep(resultOf(MIB - 1024));
    const code64 = "A_".repeat(32);
    const code65 = `${code64}B`;

    const kept64 = budget.keep({ content: `[${code64}] ${"x".repeat(MIB)}`, isError: true });
    const kept65 = budget.keep({ content: `[${code65}] ${"x".repeat(MIB)}`, isError: true });

    expect(kept64.result.content).toBe(`[${code64}] ${TOOL_RESULT_NOT_KEPT_MARKER}`);
    expect(kept65.result.content).toBe(TOOL_RESULT_NOT_KEPT_MARKER);
  });

  it("keeps no more than the marker of an error that starts with a bracket of nearly 1 MiB of capitals, whole within the cut", () => {
    const budget = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) budget.keep(resultOf(MIB - 1024));

    const hostile = budget.keep({ content: `[${"A".repeat(MIB - 1024)}] x`, isError: true });

    expect(hostile.result).toEqual({ content: TOOL_RESULT_NOT_KEPT_MARKER, isError: true });
  });

  it("counts no marker: the bytes kept are the results', whatever the number of replacements", () => {
    const budget = new ToolResultsBudget();
    for (let i = 0; i < 8; i++) budget.keep(resultOf(MIB - 1024));
    const before = budget.bytesKept;

    // Results that need no cut, each larger than the room left: replaced, one after the other.
    const replaced = Array.from({ length: 100 }, () => budget.keep(resultOf(MIB - 64)));

    expect(replaced.every((r) => r.result.content === TOOL_RESULT_NOT_KEPT_MARKER)).toBe(true);
    expect(budget.bytesKept).toBe(before);
  });

  it("counts bytes of UTF-8, not characters", () => {
    const budget = new ToolResultsBudget();
    // Each "€" is one character and three bytes: 2.9 million characters are 8.7 MB.
    const euros = { content: "€".repeat(2_900_000), isError: false };
    const { result } = budget.keep(euros);

    expect(result.content.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(budget.bytesKept).toBe(bytesOf(result.content));
    expect(budget.bytesKept).toBeGreaterThan(result.content.length);
  });

  it("is one per run: a new run starts from nothing", () => {
    const full = new ToolResultsBudget();
    for (let i = 0; i < 9; i++) full.keep(resultOf(MIB));

    const next = new ToolResultsBudget();
    const result = resultOf(MIB - 1024);
    expect(next.keep(result).result).toBe(result);
    expect(next.bytesKept).toBe(MIB - 1024);
  });
});
