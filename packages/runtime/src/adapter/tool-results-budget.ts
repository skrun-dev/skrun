// What a run keeps of its tool results, on both runtimes.
//
// The agent loop keeps every tool result for the rest of the run: in the
// conversation it sends the model at each turn, and in the events of the run.
// The loop turns up to `MAX_TOOL_ITERATIONS` times, and a model's answer may ask
// for any number of calls: nothing bounded what a run held in the server's
// memory. The cloud runtime's sandbox cuts each result to
// `TOOL_RESPONSE_MAX_BYTES`; the local runtime cut nothing — a script returns up
// to its output buffer, an MCP server's result had no bound of its own.
//
// So the loop passes every result a call returns through one `ToolResultsBudget`
// per run — all but its own, of a fixed size, for arguments nested too deep:
//   - each result is cut as the sandbox cuts it (`truncateToolResult`) — a result
//     the sandbox already cut passes unchanged, so the cloud runtime sees no
//     difference;
//   - the bytes of UTF-8 of each content kept are added up, and a result that
//     would take the sum past `RUN_TOOL_RESULTS_MAX_BYTES` is replaced by a
//     marker that names the bound. A later result that still fits is kept.
// What was kept is never rewritten: the conversation the model has seen stays
// as it saw it. The run goes on, and the model reads the marker.
//
// An error result counts like any other: the conversation keeps it the same
// way, and a failing script's error output can be as large as its result. The
// marker does not count: its size is fixed, and there is one per call the model
// wrote — a call its own turn already holds. Counted, it would need something
// smaller still once even the marker no longer fit. An error replaced keeps the
// code it starts with in front of the marker (`TOOL_ERROR_CODE`), uncounted
// too: a code is bounded, so the two stay within a fixed size.

import {
  describeBytes,
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResult,
} from "../files/output-rules.js";
import type { ToolResult } from "../tools/types.js";

/** The most a run keeps of its tool results, in bytes of UTF-8 of their contents: 8 MiB. */
export const RUN_TOOL_RESULTS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What the model reads in place of a result that the run could not keep: it
 * names the bound. It says nothing of whether the tool ran — the result it
 * replaces may be an error from before the tool was reached (an unknown tool,
 * dependencies that failed to install, a server not connected).
 */
export const TOOL_RESULT_NOT_KEPT_MARKER = `[Result not kept: with it, the tool results of this run would weigh more than ${describeBytes(RUN_TOOL_RESULTS_MAX_BYTES)}, the most a run keeps. This call's result is left out.]`;

/**
 * The code an error result may start with — `[CODE] `, 1 to 64 capitals and
 * underscores — and the one rule for it: the loop carries it apart in the run's
 * `tool_call_error` event, and an error replaced by the marker keeps it in
 * front of the marker. The content is the tool's to write: bounded, the code
 * keeps the marker it precedes within a fixed size; a longer bracket is no code.
 */
export const TOOL_ERROR_CODE = /^\[([A-Z_]{1,64})\]\s*/;

/**
 * What the run kept of a result, as the loop logs it: the whole of it; a cut
 * one, ending with the marker of the cut — cut here, or by the sandbox before
 * it answered; or the marker in its place.
 */
export type ToolResultKept = "whole" | "cut" | "replaced";

/** A result as the run keeps it, and what it kept of it. */
export interface KeptToolResult {
  result: ToolResult;
  kept: ToolResultKept;
}

/** The tool results one run keeps — one per run, never shared. */
export class ToolResultsBudget {
  private keptBytes = 0;

  /**
   * The result as the run keeps it — what the model reads and the run's events
   * carry: cut to `TOOL_RESPONSE_MAX_BYTES`, then counted; or the marker, in the
   * place of a result that would take the run past `RUN_TOOL_RESULTS_MAX_BYTES`.
   * An error result stays an error, kept or replaced.
   */
  keep(result: ToolResult): KeptToolResult {
    const cut = truncateToolResult(result);
    // Counting the cut content is also what lets the original go. A cut content
    // is a slice of the original joined to the marker, and V8 keeps the whole
    // original behind such a string until it is flattened: `Buffer.byteLength`
    // flattens it, and the result kept then holds its own bytes alone. A result
    // kept must never hold its original — counting before the cut, or counting
    // in a way that does not flatten, would leave the server holding each
    // original whole (measured: four results of 20 MiB cut by
    // `truncateToolResult` alone held 80 MiB of heap, 4 MiB through `keep`).
    const bytes = Buffer.byteLength(cut.content, "utf8");
    if (this.keptBytes + bytes > RUN_TOOL_RESULTS_MAX_BYTES) {
      const code = cut.isError ? TOOL_ERROR_CODE.exec(cut.content)?.[1] : undefined;
      return {
        result: {
          content: code
            ? `${ownCopy(`[${code}] `)}${TOOL_RESULT_NOT_KEPT_MARKER}`
            : TOOL_RESULT_NOT_KEPT_MARKER,
          isError: cut.isError,
        },
        kept: "replaced",
      };
    }
    this.keptBytes += bytes;
    const wasCut = cut !== result || cut.content.endsWith(TOOL_RESULT_TRUNCATION_MARKER);
    return { result: cut, kept: wasCut ? "cut" : "whole" };
  }

  /** The bytes of UTF-8 of the contents kept so far, markers aside. */
  get bytesKept(): number {
    return this.keptBytes;
  }
}

/**
 * `text` in a string of its own. A code matched in a content is a slice of it,
 * and V8 keeps the whole content behind a slice: kept in front of the marker,
 * it would hold the result the marker replaces. Decoded from its bytes, it
 * holds them alone.
 */
function ownCopy(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}
