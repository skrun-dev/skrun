import type {
  FileInfo,
  Logger,
  MachineSpawnPhase,
  RunCompleteEvent,
  RunErrorEvent,
} from "@skrun-dev/runtime";
import { estimateCacheSavings, exceedsNestingDepth } from "@skrun-dev/runtime";
import type { Context } from "hono";
import { filesRetentionSeconds, outputCache } from "../cache/output-cache.js";
import { type DbAdapter, type FinalRunWrite, SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import type { Run, RunStatus } from "../db/schema.js";
import { runOutputDeletes } from "../files/output-purge.js";
import { getUser } from "../middleware/auth.js";
import type { RuntimeMode } from "../runtime/adapter-selection.js";
import { AgentYamlReadAbandonedError } from "../services/agent-yaml-reader.js";
import { isMasterCredential } from "../services/key-scope.js";
import { RegistryError } from "../services/registry.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { errorFields } from "../utils/error-fields.js";
import { LONE_SURROGATE, NUL } from "../utils/unstorable-text.js";

/**
 * DRY the 9+ inline `if (err instanceof RegistryError) ...; throw err;` blocks
 * scattered across `registry.ts` and `run.ts`. Every route's catch clause for
 * a RegistryError follows the same shape — fan-in here so the response
 * contract stays consistent (and changes apply in one place).
 *
 * Non-RegistryError exceptions are re-thrown so the surrounding `app.onError`
 * (or default 500 handler) reports them; this helper only handles the
 * domain-error path. A refusal that asks the client to wait (`retryAfterS`)
 * carries it as `Retry-After`.
 */
export function dispatchRegistryError(c: Context, err: unknown): Response {
  if (err instanceof RegistryError) {
    const headers =
      err.retryAfterS === undefined ? undefined : { "Retry-After": String(err.retryAfterS) };
    return c.json({ error: { code: err.code, message: err.message } }, err.status, headers);
  }
  throw err;
}

/**
 * `dispatchRegistryError` for the two push routes, and the push whose client
 * hung up while its `agent.yaml` waited to be read: the read was dropped and
 * nothing stored (`AgentYamlReadAbandonedError`), and nobody is left to tell.
 * Answered `499` with no body — the status proxies log for a client that
 * closed its request —, never the `500` of an error no route handles, with
 * its `unhandled_error` line.
 */
export function dispatchPushError(c: Context, err: unknown): Response {
  if (err instanceof AgentYamlReadAbandonedError) return new Response(null, { status: 499 });
  return dispatchRegistryError(c, err);
}

/**
 * Account-management guard (R2). Returns a 403 `Response` to short-circuit when
 * the caller is NOT a master credential (a session, a dev-token, or an
 * account-wide full-operation key); `null` to proceed. Collapses the
 * previously hand-rolled `KEY_SCOPE_FORBIDDEN` blocks (auth / registry /
 * llm-key routes) into one canonical check + message.
 */
export function requireMasterCredential(c: Context): Response | null {
  if (isMasterCredential(getUser(c))) return null;
  return c.json(
    {
      error: {
        code: "KEY_SCOPE_FORBIDDEN",
        message: "This action requires an account-wide API key (or a session / dev-token).",
      },
    },
    403,
  );
}

/** What a run's row keeps of its output: the bytes of its JSON text, beyond which a marker replaces it. */
export const RUN_OUTPUT_KEPT_BYTES = 32 * 1024;

/** What a run's row keeps of its input: the bytes of its JSON text, beyond which a marker replaces it. */
export const RUN_INPUT_KEPT_BYTES = 8 * 1024;

/** What a run's row keeps of its error: its bytes, beyond which it is cut and suffixed. */
export const RUN_ERROR_KEPT_BYTES = 8 * 1024;

/**
 * What a run's row keeps in place of an input or an output too large to keep:
 * the size of its JSON text, in bytes, and the beginning of that text.
 */
export interface TruncatedRunContent {
  _truncated: { bytes: number; preview: string };
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** U+FFFD, the replacement character. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * A string as a run's row keeps it: each U+0000 and each lone surrogate
 * replaced by U+FFFD. Postgres refuses both — a `text` column holds no NUL
 * byte, and `jsonb` refuses the escapes `JSON.stringify` writes for them
 * (`\u0000`, `\ud800`) —, and a final write it refuses leaves the row running.
 * The string itself when it holds neither.
 */
function keptText(text: string): string {
  const withoutNul = text.includes(NUL) ? text.replaceAll(NUL, REPLACEMENT_CHARACTER) : text;
  return withoutNul.replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
}

/**
 * A JSON value with every string in it — its keys included — as `keptText`
 * keeps it: a copy where one changed, the value itself where none did. Only
 * strings, arrays and plain objects are walked; any other value is returned
 * as it is.
 */
function keptJsonValue(value: unknown): unknown {
  if (typeof value === "string") return keptText(value);
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const kept = keptJsonValue(item);
      if (kept !== item) changed = true;
      return kept;
    });
    return changed ? items : value;
  }
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]): [string, unknown] => {
    const keptKey = keptText(key);
    const kept = keptJsonValue(item);
    if (keptKey !== key || kept !== item) changed = true;
    return [keptKey, kept];
  });
  if (!changed) return value;
  const copy: Record<string, unknown> = {};
  // Defined, not assigned: a `__proto__` key stays a key.
  for (const [key, item] of entries) {
    Object.defineProperty(copy, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * The longest beginning of `text`, cut between two characters, whose bytes
 * — as `cost` counts each character — add up to at most `budget`.
 */
function prefixWithin(text: string, budget: number, cost: (char: string) => number): string {
  let used = 0;
  let end = 0;
  for (const char of text) {
    const bytes = cost(char);
    if (used + bytes > budget) break;
    used += bytes;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The marker a run's row keeps in place of a value nested deeper than
 * `MAX_JSON_NESTING_DEPTH` (100 levels, `@skrun-dev/runtime`) — a value that
 * contains itself among them. A defense, not a path: the run route refuses
 * such an input before its copy is built (`400 INVALID_INPUT_TYPE`), and the
 * agent loop such an output (`OUTPUT_SCHEMA_INVALID`). The value is neither
 * measured nor written — its size would take walking all of it, which the
 * bound is there to spare —, so `bytes` is 0, a size no JSON text has (the
 * shortest, `{}`, takes 2), and `preview` empty: the marker's shape all the
 * same, so that its readers — the dashboard — see content not kept.
 */
function tooDeepMarker(): Record<string, unknown> {
  const marker: TruncatedRunContent = { _truncated: { bytes: 0, preview: "" } };
  return marker as unknown as Record<string, unknown>;
}

/**
 * A JSON value as a run's row keeps it: its strings as `keptText` keeps them,
 * then whole when its JSON text takes at most `maxBytes`, else the marker —
 * the text's size and as much of its beginning as keeps the marker itself
 * within `maxBytes`. A value nested deeper than `MAX_JSON_NESTING_DEPTH` is
 * `tooDeepMarker`, whatever its size: its depth measured without recursion,
 * no deeper than the first level past the bound (`exceedsNestingDepth`), and
 * nothing more done with it — so that no depth makes the copy throw or cost,
 * and the row never holds a value deeper than the bound — Postgres `jsonb`
 * refuses one past about sixteen thousand levels, under a code that reads as
 * an outage (`54001`).
 */
function keptJson(content: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (exceedsNestingDepth(content)) return tooDeepMarker();
  const value = keptJsonValue(content) as Record<string, unknown>;
  const text = JSON.stringify(value);
  const bytes = utf8Bytes(text);
  if (bytes <= maxBytes) return value;
  const frame = utf8Bytes(JSON.stringify({ _truncated: { bytes, preview: "" } }));
  // Each character counted as it is written inside the marker's JSON string, escapes included.
  const preview = prefixWithin(
    text,
    maxBytes - frame,
    (char) => utf8Bytes(JSON.stringify(char)) - 2,
  );
  const marker: TruncatedRunContent = { _truncated: { bytes, preview } };
  return marker as unknown as Record<string, unknown>;
}

/**
 * An error as a run's row keeps it: as `keptText` keeps it, then whole when it
 * takes at most `maxBytes`, else its beginning followed by `… [truncated: N
 * bytes]` — N the size of the whole error —, the two within `maxBytes`.
 */
function keptError(content: string, maxBytes: number): string {
  const error = keptText(content);
  const bytes = utf8Bytes(error);
  if (bytes <= maxBytes) return error;
  const suffix = `… [truncated: ${bytes} bytes]`;
  return `${prefixWithin(error, maxBytes - utf8Bytes(suffix), utf8Bytes)}${suffix}`;
}

/**
 * What a run's row keeps of its content: first, each U+0000 and each lone
 * surrogate replaced by U+FFFD (`keptText`: what Postgres refuses to store);
 * then the input and the output whole up to `RUN_INPUT_KEPT_BYTES` and
 * `RUN_OUTPUT_KEPT_BYTES` of JSON text, the error up to
 * `RUN_ERROR_KEPT_BYTES`; beyond, a marker (`TruncatedRunContent`), or the
 * error cut and suffixed — sizes and previews counted on the replaced text.
 * An input or an output nested deeper than `MAX_JSON_NESTING_DEPTH` levels
 * — which neither the run route nor the agent loop lets through — is
 * `tooDeepMarker`, and never makes the copy throw. The same on every store:
 * written by the admission (the input) and by the final write (the output,
 * the error), before either reaches the store. Only
 * the row's copy changes: the run's caller is always handed all of it, as it
 * was. The other fields are returned as given.
 */
export function truncateRunContent<
  T extends {
    input?: Record<string, unknown> | null;
    output?: Record<string, unknown> | null;
    error?: string | null;
  },
>(content: T): T {
  const kept = { ...content };
  if (content.input != null) {
    kept.input = keptJson(content.input, RUN_INPUT_KEPT_BYTES) as T["input"];
  }
  if (content.output != null) {
    kept.output = keptJson(content.output, RUN_OUTPUT_KEPT_BYTES) as T["output"];
  }
  if (content.error != null) {
    kept.error = keptError(content.error, RUN_ERROR_KEPT_BYTES) as T["error"];
  }
  return kept;
}

/**
 * The largest number a Postgres `integer` column holds (2^31 − 1): a run's
 * token counts and its `duration_ms`.
 */
const INTEGER_COLUMN_MAX = 2_147_483_647;

/**
 * The largest amount a `numeric(10,6)` column holds — four digits before the
 * point, six after: a run's estimated cost and its cache savings, in USD.
 */
const USD_COLUMN_MAX = 9_999.999999;

/** A count as a run's row keeps it: a whole number from 0 to `INTEGER_COLUMN_MAX`; 0 for what is not a finite number. */
function keptCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(INTEGER_COLUMN_MAX, Math.round(value));
}

/** A duration as a run's row keeps it: as `keptCount` keeps a count; null — unknown — for what is not a finite number. */
function keptDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return keptCount(value);
}

/** An amount as a run's row keeps it: from 0 to `USD_COLUMN_MAX`, to the millionth; 0 for what is not a finite number. */
function keptUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(USD_COLUMN_MAX, Math.round(value * 1_000_000) / 1_000_000);
}

/**
 * A charged time as a run's row keeps it — a `bigint` —: a whole number from
 * 0 to the largest exact one; none, so not written, for what is not a finite
 * number — the compute sums then count the row's end minus its creation.
 */
function keptChargedMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

/** The fields of a run's final write that carry a number. */
type RunNumberField = {
  [K in keyof FinalRunWrite]-?: NonNullable<FinalRunWrite[K]> extends number ? K : never;
}[keyof FinalRunWrite];

/**
 * How a run's row keeps each number its final write carries: within what its
 * column holds on every store. Exhaustive on purpose: a number field added to
 * the write does not compile until it is bounded here.
 */
const RUN_NUMBER_BOUNDS: { [K in RunNumberField]-?: (value: unknown) => FinalRunWrite[K] } = {
  usage_prompt_tokens: keptCount,
  usage_completion_tokens: keptCount,
  usage_total_tokens: keptCount,
  usage_cache_read_tokens: keptCount,
  usage_cache_write_tokens: keptCount,
  usage_estimated_cost: keptUsd,
  usage_cache_savings_usd: keptUsd,
  duration_ms: keptDuration,
  charged_ms: keptChargedMs,
};

/**
 * A final write with each of its numbers as a run's row keeps it
 * (`RUN_NUMBER_BOUNDS`). A run's usage comes from its model's provider — from
 * an endpoint an agent declares (`model.base_url`), which reports what it
 * likes: a count past what an `integer` holds, a fraction, a negative, a cost
 * past `numeric(10,6)` — and a store refuses the whole write for one such
 * number. The same on every store, before the write reaches it; a field the
 * write does not carry stays absent, and every other field is returned as
 * given. Only the row's copy is bounded: the run's caller is told its usage
 * as the run counted it.
 */
export function keptRunNumbers(write: FinalRunWrite): FinalRunWrite {
  const bounds = RUN_NUMBER_BOUNDS as Record<string, (value: unknown) => unknown>;
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(write)) {
    if (!Object.hasOwn(bounds, field)) {
      kept[field] = value;
      continue;
    }
    const bounded = bounds[field]?.(value);
    if (bounded !== undefined) kept[field] = bounded;
  }
  return kept as FinalRunWrite;
}

/** What a completion records of a run: its output, its usage, its files. */
export interface RunCompletionFields {
  output: Record<string, unknown>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  durationMs: number | null | undefined;
  files: FileInfo[] | undefined;
}

/**
 * Where this process stands on a run's final status: `none` — not written;
 * `shutdown-provisional` — the failure the server's stop writes into a run
 * still going once its drain is over, which a completion may still replace;
 * `final` — written, for good.
 */
export type FinalClaimState = "none" | "shutdown-provisional" | "final";

/**
 * Whether this process has written a run's final status. One per run — the
 * run's entry in the registry of runs in flight (`runtime/in-flight-runs.ts`),
 * registered by the route that serves it; `finalizeRun` moves it,
 * synchronously, before any wait: `none` → `final` (an end of the run's own,
 * or one on the stop's path) or → `shutdown-provisional` (the stop's
 * fallback); `shutdown-provisional` → `final` for a completion only; `final` →
 * nothing.
 */
export interface FinalStatusClaim {
  claim: FinalClaimState;
  /**
   * Why the run was ended from outside. `shutdown`: the server's stop abandoned
   * it — from then on every failure of the run is the stop's, written with
   * `SHUTDOWN_RUN_ERROR`. `deadline`: its seat's deadline came while it was in
   * flight, and the deadline's failure was written as its final status
   * (`RUN_DEADLINE_ERROR`) — every end of the run that follows is told as
   * that failure.
   */
  reason?: "shutdown" | "deadline";
  /**
   * The instant the run was admitted — its row's creation, on this process's
   * clock: its charged time counts from it. Unknown, no charged time is written.
   */
  readonly admittedAt?: Date;
  /**
   * Set when the run's machine never got ready: the phase its acquisition
   * stopped at, as the cloud adapter tells it before the run's error.
   */
  spawnFailure?: { phase: MachineSpawnPhase | undefined };
}

/**
 * Whether a failed start at each phase charges its run. A machine that never
 * got ready — never created, never answering its boot probe, the object store
 * not signing for it (`presign`: the probe that shows its host, before any
 * machine, or the run's `/init` URLs once its machine answers), a pooled
 * machine not woken or not claimed — charges nothing: none of the agent was in
 * play yet. `init-rpc` charges: it is the runner's `/init`, where the agent's
 * own MCP servers connect, and a server of the agent's that fails or hangs
 * fails it. Exhaustive on purpose: a new phase does not compile until it is
 * decided here.
 */
const SPAWN_PHASE_CHARGES: Record<MachineSpawnPhase, boolean> = {
  create: false,
  "boot-probe": false,
  presign: false,
  "init-rpc": true,
  "pool-resume": false,
  "pool-claim": false,
};

/**
 * The time a run is charged as its final status is written, in ms. Its end
 * minus its admission, on one clock — the process's —, never negative; but 0
 * on the server stop's path — a failure once the stop abandoned the run, its
 * provisional failure included: a run is not charged for our stop (a
 * completion that replaces the provisional failure is charged as any
 * completion) —, and 0 for a failure whose machine never got ready
 * (`SPAWN_PHASE_CHARGES`), whatever cut its acquisition — both decided first,
 * without the admission's instant. Otherwise undefined when the claim does
 * not know when the run was admitted: the row's charged time stays null,
 * which the compute sums count as its end minus its creation — never 0.
 */
function chargedTimeMs(
  claim: FinalStatusClaim,
  input: FinalizeRunInput,
  stopPath: boolean,
): number | undefined {
  if (input.status === "failed") {
    if (stopPath) return 0;
    const phase = claim.spawnFailure?.phase;
    if (phase !== undefined && !SPAWN_PHASE_CHARGES[phase]) return 0;
  }
  if (claim.admittedAt === undefined) return undefined;
  return Math.max(0, input.now.getTime() - claim.admittedAt.getTime());
}

/**
 * The code a caller is told a run ended with when the server's stop ended it —
 * the run did not finish, and running it again makes sense, though its tools
 * may already have run. Its message is `SHUTDOWN_RUN_ERROR`. A streamed run's
 * `run_error` and a webhook delivery carry it; a synchronous run is answered
 * `503` with it. A run sent once the stop has begun is refused `503` with it
 * too, before anything of it is written (`SERVER_STOPPING_REFUSAL`). Listed in
 * the error codes of docs/api.md.
 */
export const SHUTDOWN_RUN_ERROR_CODE = "SERVER_STOPPED";

/**
 * The error a run's row reads, and its caller is told, when its seat's
 * deadline — its timeout, plus the margin for its machine's acquisition and
 * its outputs' upload, `runs.deadline_at` — came while it was still in flight:
 * the process stopped it then (`runtime/in-flight-runs.ts`). A streamed run
 * whose caller stops reading its events is the run that reaches it: its
 * writes wait, and nothing of it moves on. Its code is
 * `RUN_DEADLINE_ERROR_CODE`.
 */
export const RUN_DEADLINE_ERROR =
  "This run was still in progress at its deadline — its timeout, plus the time its machine may take to get ready and its outputs to upload — and was stopped.";

/**
 * The code of `RUN_DEADLINE_ERROR`: a streamed run's `run_error` and a webhook
 * delivery carry it; a synchronous run is answered `504` with it. Listed in the
 * error codes of docs/api.md.
 */
export const RUN_DEADLINE_ERROR_CODE = "DEADLINE_EXCEEDED";

/**
 * The message of a run refused because the server's stop has begun: nothing of
 * it ran and no row was written, so sending it again — to a server that runs —
 * is safe. Answered `503` under `SHUTDOWN_RUN_ERROR_CODE`.
 */
export const SERVER_STOPPING_REFUSAL =
  "The server is stopping and did not start this run; send it again.";

/**
 * The error a failed run's row reads when its final write had to be made again
 * without its content (`withoutContent`, `statusOnly`): the database refused
 * the data of the first one, and the error the run ended on is not recorded.
 * Its caller was told that error, whole.
 */
export const RUN_ERROR_NOT_KEPT = "This run failed; its error could not be recorded.";

/**
 * A final write without the content the store may have refused: a
 * completion's output left null, a failure's error replaced by
 * `RUN_ERROR_NOT_KEPT` — but the stop's phrase stays the stop's phrase, which
 * a completion may still replace. The status, its end, the charged time, the
 * usage and the files stay: the file names are what the output purge deletes
 * the run's objects by.
 */
function withoutContent(write: FinalRunWrite, stopPath: boolean): FinalRunWrite {
  if (write.status === "completed") return { ...write, output: null };
  if (stopPath || write.error == null) return write;
  return { ...write, error: RUN_ERROR_NOT_KEPT };
}

/**
 * The last final write: only what the server computes, and bounds, itself —
 * the status, its end, the charged time, and an error in its own words: none
 * for a completion — which clears the stop's provisional phrase it may
 * replace —, the stop's phrase on the stop's path, `RUN_ERROR_NOT_KEPT` for
 * any other failure that carried an error. No usage, no output, no file
 * list: once the run's numbers are bounded (`keptRunNumbers`), and its file
 * names held to the output name rule by both runtimes — which refuses a
 * control character and a lone surrogate, what Postgres cannot hold in
 * `jsonb` —, the write without content can only be refused by the store
 * itself, and this one is the last resort. Recorded this way, a
 * run keeps no file list and no purge deadline: a cloud run's output objects,
 * if it left any, are then removed only by a lifecycle rule on the bucket —
 * as when no write lands at all.
 */
function statusOnly(write: FinalRunWrite, stopPath: boolean): FinalRunWrite {
  const error =
    write.status === "completed"
      ? null
      : stopPath || write.error == null
        ? (write.error ?? null)
        : RUN_ERROR_NOT_KEPT;
  return {
    status: write.status,
    completed_at: write.completed_at,
    error,
    ...(write.charged_ms !== undefined && { charged_ms: write.charged_ms }),
  };
}

/**
 * What a run's row is written: its content as `truncateRunContent` keeps it,
 * its numbers as `keptRunNumbers` keeps them. Throws — a `TypeError`, no
 * code — on content that JSON cannot write at all: a `BigInt`. Never for its
 * depth, nor for a value that contains itself, deeper than any bound: both
 * are kept as the marker (`tooDeepMarker`).
 */
function rowCopy(write: FinalRunWrite): FinalRunWrite {
  return keptRunNumbers(truncateRunContent(write));
}

/**
 * How long a run's final write waits before it is made again, once the
 * database could not take it — a connection it closed, a failover, a pooler
 * restarting —: one second, then four more. The write made again is the same,
 * whole: a database that refuses writes for a moment refuses attempts made
 * back to back, and the row stays `running`, never charged; spaced, the first
 * finds a new connection and the second a database restarted within the five
 * seconds, which records the run as it ended, its output or its error
 * included. Two waits at most for a run, whichever of its writes they follow:
 * five seconds in all, so that they fit, with the attempts that fail at once,
 * within the bound a streamed run's final event waits for its write
 * (`FINAL_WRITE_WAIT_MS`, ten seconds) and well within the server stop's grace
 * (`SHUTDOWN_GRACE_MS`, twenty). A write the database refused for the data it
 * carried (`namesTheData`), or whose row copy could not be built, is neither
 * waited for nor made again as it was: the next one carries less, at once.
 */
export const FINAL_WRITE_RETRY_DELAYS_MS: readonly [number, number] = [1_000, 4_000];

/**
 * Whether a failed write's error says the database refused the data it
 * carried, not that it could not take a write: a SQLSTATE of class 22 (data
 * exception — a value its column does not hold) or 23 (integrity constraint
 * violation — a check, a not-null), as Postgres reports them. The same write
 * would be refused again: the next one carries less, at once. Anything else
 * the store throws — a connection refused, reset or timed out, a code of
 * another class, no code at all — is taken for the database being
 * unavailable: the same write is made again, whole, after a wait. Asked only
 * of an error from the store: one thrown building the row's copy, before it —
 * a `TypeError` on content that JSON cannot write at all — is the data's
 * whatever it carries (`finalizeRun`). The line decides what the row
 * keeps: a refusal of the data the store reported under another code would
 * have its write made again whole until the waits run out — the copy is built
 * so that Postgres has none to report, its strings cleaned, its content and
 * its numbers bounded.
 */
function namesTheData(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
}

/** The wait before a final write's next attempt: a plain timer, the clock a test can drive. */
function waitBeforeRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The three final writes, by step — the run's end with its content, without
 * it, with its status only: what a log line's message calls each, the event of
 * its failure when another attempt follows, and what a message says of it as
 * the next attempt.
 */
const FINAL_WRITES = [
  { called: "", failed: "db_update_failed", asNext: "" },
  {
    called: " without its content",
    failed: "run_final_write_without_content_failed",
    asNext: "it is written once more, at once, without its content",
  },
  {
    called: " with its status only",
    failed: "run_final_write_status_only_failed",
    asNext:
      "it is written a last time, at once, with its status, its end and its charged time only",
  },
] as const;

/**
 * One line for a final write that failed, with the error's class and code,
 * never its message: the event of its write when another attempt follows — the
 * same write after `delay` ms, or the next one at once —, and
 * `run_final_write_failed` when none is left.
 */
function logFinalWriteFailure(
  log: Logger,
  runId: string,
  input: FinalizeRunInput,
  attempt: { step: number; next: number | undefined; delay: number | undefined },
  err: unknown,
): void {
  const { step, next, delay } = attempt;
  const failed = `Recording the run's final status${FINAL_WRITES[step].called} failed (${input.mode}, ${input.status})`;
  if (next === undefined) {
    log.error(
      { event: "run_final_write_failed", run_id: runId, ...errorFields(err) },
      `${failed}; no attempt is left: the run may remain in 'running' state`,
    );
    return;
  }
  const then =
    next === step ? `it is made again, the same, in ${delay} ms` : FINAL_WRITES[next].asNext;
  log.error(
    { event: FINAL_WRITES[step].failed, run_id: runId, ...errorFields(err) },
    `${failed}; ${then}`,
  );
}

/** How a run ended, and what its final write needs to record it. */
export type FinalizeRunInput = {
  /** The end of the run, on this process's clock: `completed_at` is this instant. */
  now: Date;
  /** The response shape: it only names the mode in a log line. */
  mode: "sse" | "webhook" | "sync";
  /** Where the run executed, and so where its output files are. */
  runtimeMode: RuntimeMode;
  /** The cloud runtime's object storage, for a completion whose run was cleared. */
  outputStorage?: Pick<StorageAdapter, "delete">;
} & (
  | {
      status: "completed";
      completion: RunCompletionFields;
      /** The model the cache savings are priced with. */
      modelForCostLookup: string;
    }
  | {
      status: "failed";
      /** Already cleaned of the run's keys by the caller. */
      error: string | null;
      /**
       * The server stop's fallback, for a run still going once its drain is
       * over: written with `SHUTDOWN_RUN_ERROR`, it leaves the claim
       * `shutdown-provisional`, which a completion may still replace.
       */
      provisional?: boolean;
    }
);

export interface FinalizeRunResult {
  /** False when the run's final status was already claimed in this process: nothing was written. */
  claimed: boolean;
  /** Whether this call's write landed on the row. */
  written: boolean;
  /**
   * The row's status after the call: the one written, or, when the row was
   * already finished, the one it holds; null when the write failed, or when
   * the row could not be read. A failure that found the stop's provisional
   * one in place hands back `failed`, at once: the status the stop's write
   * gives the row, landed or still going.
   */
  status: RunStatus | null;
  /**
   * When `status` is `failed`: the error this call wrote, whole, when its write
   * landed — the row keeps a bounded copy of it (`truncateRunContent`); else
   * the error the row holds — or, on a row whose content was cleared and so
   * holds none, the one this process's claim stands for (the stop's phrase for
   * its provisional failure). On the stop's path with no row it could write,
   * the stop's phrase. Null otherwise.
   */
  error: string | null;
  /**
   * Whether the run ended on the server stop's path, its row not completed —
   * its write failed included: the caller is then told the stop's failure,
   * `SHUTDOWN_RUN_ERROR_CODE`.
   */
  stopped: boolean;
  /**
   * The code the caller is told the failure under when it is not the run's
   * own and not the stop's: `RUN_DEADLINE_ERROR_CODE`, for a run its deadline
   * ended. Absent otherwise.
   */
  code?: string;
  /** A completion's cache savings, for the caller's payload; 0 for a failure. */
  cacheSavingsUsd: number;
  /** Whether the row's content was cleared — by an account deletion while the run ran. */
  contentCleared: boolean;
}

/**
 * The failure a run's caller is told once the run's final write is done: the
 * stop's, under its code, whenever the run ended on the stop's path — even
 * when the write failed and the row stays running; otherwise, when the row
 * says the run failed, its error — whole when this run's own write recorded
 * it, though the row keeps it cut (`FinalizeRunResult.error`) —, under the
 * code the result names when the failure is not the run's own (the deadline's).
 * Null when the caller's own end stands
 * — the row completed, or no final status of this call is known (a write that
 * failed off the stop's path, or was still going at the stream's bound; a
 * second end the claim skipped).
 */
export function failureToTell(
  written: FinalizeRunResult | undefined,
): { code?: string; message: string } | null {
  if (written?.stopped) {
    return { code: SHUTDOWN_RUN_ERROR_CODE, message: written.error ?? SHUTDOWN_RUN_ERROR };
  }
  if (written?.status !== "failed" || written.error === null) return null;
  return written.code === undefined
    ? { message: written.error }
    : { code: written.code, message: written.error };
}

/**
 * What a run its deadline ended is told, whatever end of its own follows: the
 * deadline's failure, under its code — the status the deadline's write gives
 * the row, landed or still going.
 */
function deadlineVerdict(): FinalizeRunResult {
  return {
    claimed: false,
    written: false,
    status: "failed",
    error: RUN_DEADLINE_ERROR,
    stopped: false,
    code: RUN_DEADLINE_ERROR_CODE,
    cacheSavingsUsd: 0,
    contentCleared: false,
  };
}

/**
 * What a run's failure is known to be when its final write has not come back
 * — the stream's bound fell before it. Read from the claim, synchronously:
 * once the stop has abandoned the run (`reason`), or holds its provisional
 * failure, the run's failure is the stop's, whatever the write does — the
 * caller is told `SHUTDOWN_RUN_ERROR_CODE` and the stop's phrase, never the
 * abandon its run ended on. Undefined off the stop's path: nothing is known,
 * and the run's own failure is told.
 */
export function stopVerdictOf(claim: FinalStatusClaim): FinalizeRunResult | undefined {
  if (claim.reason !== "shutdown" && claim.claim !== "shutdown-provisional") return undefined;
  return {
    claimed: true,
    written: false,
    status: null,
    error: SHUTDOWN_RUN_ERROR,
    stopped: true,
    cacheSavingsUsd: 0,
    contentCleared: false,
  };
}

/**
 * The final event a streamed run's caller is sent: the run's own, unless the
 * row it was written to says otherwise — then a `run_error` that carries the
 * row's failure (`failureToTell`). A completion whose row stayed failed — the
 * stop's provisional failure on a row whose content was cleared — is told as
 * that failure; a failure the stop's rule rewrote, as the stop's.
 */
export function finalEventFor<E extends RunCompleteEvent | RunErrorEvent>(
  event: E,
  written: FinalizeRunResult | undefined,
): E | RunErrorEvent {
  const told = failureToTell(written);
  if (told === null) return event;
  const code = told.code ?? (event.type === "run_error" ? event.error.code : "EXECUTION_FAILED");
  if (
    event.type === "run_error" &&
    event.error.code === code &&
    event.error.message === told.message
  ) {
    return event;
  }
  return {
    type: "run_error",
    run_id: event.run_id,
    timestamp: event.timestamp,
    error: { code, message: told.message },
  };
}

/**
 * The row of a run its final write found already finished, read back; null,
 * and one line with the error's class and code, when it cannot be read.
 */
async function readFinishedRow(db: DbAdapter, log: Logger, runId: string): Promise<Run | null> {
  try {
    return await db.getRun(runId);
  } catch (err) {
    log.warn(
      { event: "run_final_read_failed", run_id: runId, ...errorFields(err) },
      "The run's row, already finished, could not be read back; its caller is told its own end",
    );
    return null;
  }
}

/**
 * The one function that writes a run's final status — every mode, every way a
 * run ends. A completion writes its output, usage and files; a failure its
 * error — the row keeping a bounded copy of the two (`truncateRunContent`),
 * while the error handed back is the one written, whole. `completed_at` is
 * `input.now`, and the time the run is charged (`charged_ms`,
 * `chargedTimeMs`) goes in the same write.
 *
 * Once per run. The claim is taken synchronously, before any wait: a second
 * call for the same run — however close behind the first, whatever the first
 * is still waiting on — returns at once, writes nothing, and logs
 * `run_finalize_skipped`. The write itself is `finishRun`, which lands only on
 * a row still running: a row finished elsewhere is never written again, and
 * the call then reads the row back and hands back the status it holds.
 *
 * One exception, the server's stop. Once the stop has abandoned a run
 * (`claim.reason`), every failure of the run that follows — the abort its loop
 * ends on, an acquisition the abort cut, the net under an unexpected end — is
 * the stop's: written with `SHUTDOWN_RUN_ERROR` as the run's final status if
 * nothing is in place yet, and of no effect if the stop's provisional failure
 * is (the call then returns at once, like any call of no effect, and hands
 * back the stop's failure — its write may still be going). Only a completion
 * replaces the provisional failure — `finishRun` is asked to
 * (`replaceShutdownProvisional`) —, and the caller is told what the row says
 * (`finalEventFor`, `failureToTell`) — or, on the stop's path, the stop's
 * failure even when the write failed or has not come back (`stopVerdictOf`).
 *
 * A run whose seat's deadline came while it was in flight: the registry of
 * runs in flight wrote the deadline's failure through this function
 * (`claim.reason` `deadline`), and every later call — the end the run's
 * stopped adapter comes to — is skipped and hands back that failure, under
 * `RUN_DEADLINE_ERROR_CODE`: the caller is told what the row says.
 *
 * A cloud run (`flyio`) that produced files left them in object storage, so its
 * completion also writes `purge_after`: the completion time plus the output
 * retention window (`filesRetentionSeconds()`), in `toISOString()` form — the
 * form the query for due runs compares — after which those objects are due for
 * deletion. The deadline rides in the very write that records the file names:
 * if that write fails, neither exists, and nothing in the database points at
 * the objects any more (only a lifecycle rule on the bucket, an operator's
 * choice, removes them). A local run's files sit in the process's temp
 * directory, which the local sweep already covers; a run without files leaves
 * nothing behind; a failure records no files. None of them gets a deadline.
 *
 * What the row is written is already what every store accepts: the content's
 * copy (`truncateRunContent`) and the numbers (`keptRunNumbers`). A write that
 * fails all the same is one log line, with the error's class and code — never
 * its message —, and what follows depends on why (`namesTheData`). A database
 * that could not take it gets the same write again, whole, one second later,
 * then four seconds after that (`FINAL_WRITE_RETRY_DELAYS_MS`): back within
 * them, it records the run as it ended, its content included. A refusal of the
 * data — by the database, or before it: a row's copy that could not be built
 * at all, content that JSON cannot write, whatever its error carries —
 * brings, at once, the write without its content
 * (`withoutContent`): a store that refused what the run produced still
 * records how and when it ended, and what it is charged
 * (`run_final_write_without_content`); its data refused too, a last write
 * carries only what the server computes itself (`statusOnly`: the status, its
 * end, the charged time, an error in its own words —
 * `run_final_write_status_only`), which only the store itself refuses. Any
 * write may meet either refusal: two waits at most for the run, five seconds
 * in all, and two steps down — five attempts at most, three of the same write
 * when the database does not come back. A failure another attempt follows is
 * logged by its write (`db_update_failed`,
 * `run_final_write_without_content_failed`,
 * `run_final_write_status_only_failed`); the one after which none is left is
 * `run_final_write_failed`, and the call still returns: the response ships,
 * the row may stay `running`. The caller is told the run's own error, whole,
 * whichever write lands. A synchronous run's response and a webhook's
 * delivery wait for the attempts, a streamed run's final event at most
 * `FINAL_WRITE_WAIT_MS`, and the run settles only once the last has ended.
 *
 * A run whose account was deleted while it ran. The deletion clears the run's
 * content and marks the row; the final write then leaves `output`, `error`,
 * `files` and `purge_after` as they are and hands back the marked row — the
 * mark is learnt from the write itself, never from a read before it. Such a run
 * keeps nothing of what it produced: on every runtime its local output
 * directory, registered before the write, is dropped, and a completion on the
 * cloud runtime deletes the output objects it would have recorded
 * (`outputStorage`, by the keys and with the name check the output purge uses;
 * a failure is logged with no key). `contentCleared` says it happened.
 */
export async function finalizeRun(
  db: DbAdapter,
  log: Logger,
  runId: string,
  claim: FinalStatusClaim,
  input: FinalizeRunInput,
): Promise<FinalizeRunResult> {
  const heldProvisional = claim.claim === "shutdown-provisional";
  if (claim.claim === "final" || (heldProvisional && input.status === "failed")) {
    log.info(
      { event: "run_finalize_skipped", run_id: runId, status: input.status },
      "The run's final status was already written by this process; this one is not",
    );
    if (heldProvisional) {
      // The stop's failure stays: what the row says once its write lands.
      return {
        claimed: false,
        written: false,
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        stopped: true,
        cacheSavingsUsd: 0,
        contentCleared: false,
      };
    }
    // The deadline's failure stays: what the row says once its write lands.
    if (claim.reason === "deadline") return deadlineVerdict();
    return {
      claimed: false,
      written: false,
      status: null,
      error: null,
      stopped: false,
      cacheSavingsUsd: 0,
      contentCleared: false,
    };
  }
  // A completion over the stop's provisional failure: the one write that may replace a finished row.
  const replacing = heldProvisional;
  const provisional = input.status === "failed" && input.provisional === true;
  // The stop's rule: a failure once the stop abandoned the run is the stop's.
  const stopPath = input.status === "failed" && (provisional || claim.reason === "shutdown");
  claim.claim = provisional ? "shutdown-provisional" : "final";

  const completedAt = input.now.toISOString();
  let write: FinalRunWrite;
  let cacheSavingsUsd = 0;
  let files: Array<{ name: string; size: number }> | null = null;
  if (input.status === "completed") {
    const fields = input.completion;
    cacheSavingsUsd = estimateCacheSavings(input.modelForCostLookup, fields.cacheReadTokens);
    // One clock reading: the deadline counts from the completion time the row records.
    const filesInObjectStorage = input.runtimeMode === "flyio" && (fields.files?.length ?? 0) > 0;
    const purgeAfter = filesInObjectStorage
      ? new Date(input.now.getTime() + filesRetentionSeconds() * 1000).toISOString()
      : undefined;
    files = fields.files?.map((f) => ({ name: f.name, size: f.size })) ?? null;
    write = {
      status: "completed",
      output: fields.output,
      // A completed run carries no error.
      error: null,
      usage_prompt_tokens: fields.promptTokens,
      usage_completion_tokens: fields.completionTokens,
      usage_total_tokens: fields.totalTokens,
      usage_estimated_cost: fields.estimatedCost,
      usage_cache_read_tokens: fields.cacheReadTokens,
      usage_cache_write_tokens: fields.cacheWriteTokens,
      usage_cache_savings_usd: cacheSavingsUsd,
      duration_ms: fields.durationMs ?? null,
      files,
      completed_at: completedAt,
      ...(purgeAfter !== undefined && { purge_after: purgeAfter }),
    };
  } else {
    // A failure writes no usage: the columns keep their default, 0.
    write = {
      status: "failed",
      error: stopPath ? SHUTDOWN_RUN_ERROR : input.error,
      completed_at: completedAt,
    };
  }
  // The time the run is charged, in the same write as its status.
  const chargedMs = chargedTimeMs(claim, input, stopPath);
  if (chargedMs !== undefined) write.charged_ms = chargedMs;

  const options = replacing ? { replaceShutdownProvisional: true } : undefined;
  // The writes, from the most complete to the least, each under the same
  // condition — a row still running, or the stop's provisional failure for a
  // completion —, so a row finished meanwhile is not written again: the run's
  // end with its content; without its content; with only what the server
  // computes itself. A write the database could not take is made again, the
  // same, after a wait (`FINAL_WRITE_RETRY_DELAYS_MS`, two at most for the
  // run); one it refused for its data — or whose copy could not be built —
  // gives way to the next, at once. The claim was taken above, before any of
  // them: a second call meanwhile is skipped. The row is written its copy
  // (`rowCopy`); `write` keeps the output and the error whole.
  const writes = [write, withoutContent(write, stopPath), statusOnly(write, stopPath)];
  let step = 0;
  let waits = 0;
  let written: Run | null = null;
  let writeFailed = false;
  for (;;) {
    // Whether this attempt reached the store: an error before it is the copy's.
    let copied = false;
    try {
      const copy = rowCopy(writes[step]);
      copied = true;
      written = await db.finishRun(runId, copy, options);
      writeFailed = false;
      if (written !== null && step === 1) {
        log.warn(
          { event: "run_final_write_without_content", run_id: runId, status: input.status },
          "The run's final status was recorded without its output or error",
        );
      } else if (written !== null && step === 2) {
        log.warn(
          { event: "run_final_write_status_only", run_id: runId, status: input.status },
          "The run's final status was recorded with its end and its charged time only: no usage, no files",
        );
      }
      break;
    } catch (err) {
      writeFailed = true;
      // A row's copy that could not be built — content that JSON cannot write
      // at all — never reached the store: its data caused the error, whatever
      // its class and code, and the same copy would fail again.
      const refusedData = !copied || namesTheData(err);
      const delay =
        refusedData || waits >= FINAL_WRITE_RETRY_DELAYS_MS.length
          ? undefined
          : FINAL_WRITE_RETRY_DELAYS_MS[waits];
      // The next attempt: the write after this one for a refusal of its data,
      // this one again after a wait otherwise — none once either runs out.
      const next = refusedData
        ? step + 1 < writes.length
          ? step + 1
          : undefined
        : delay !== undefined
          ? step
          : undefined;
      logFinalWriteFailure(log, runId, input, { step, next, delay }, err);
      if (next === undefined) break;
      if (delay !== undefined) {
        waits++;
        await waitBeforeRetry(delay);
      }
      step = next;
    }
  }
  let row: Run | null = written;
  if (written === null && !writeFailed) {
    // Already finished, not by this process: the row says how the run ended.
    row = await readFinishedRow(db, log, runId);
    log.warn(
      {
        event: "run_final_write_refused",
        run_id: runId,
        status: input.status,
        row_status: row?.status ?? null,
      },
      "The run's row was already finished; its final status was not written again",
    );
  }

  const contentCleared = row?.content_cleared_at != null;
  if (contentCleared) {
    // The local copy, if this process holds one: evicting it removes the directory.
    outputCache.delete(runId);
    if (input.status === "completed" && input.runtimeMode === "flyio" && input.outputStorage) {
      for (const { key } of runOutputDeletes({ id: runId, files }).keys) {
        try {
          await input.outputStorage.delete(key);
        } catch (err) {
          // No key and no file name: the run's content is meant to be gone.
          log.error(
            { event: "cleared_run_output_delete_failed", ...errorFields(err) },
            "An output object of a run whose account was deleted could not be deleted",
          );
        }
      }
    }
  }
  const status = row?.status ?? null;
  // The error this call stands for, whole: the one it wrote — the row keeps a
  // bounded copy — or, for a completion over the stop's provisional failure,
  // the stop's phrase.
  const claimedError = replacing
    ? SHUTDOWN_RUN_ERROR
    : write.status === "failed"
      ? write.error
      : null;
  // On the stop's path the caller is told the stop's failure unless the row
  // says the run completed — a write that failed included: the row then stays
  // running, and nothing the caller is told may be the abandon its run ended on.
  const stopped = stopPath ? status !== "completed" : replacing && status === "failed";
  // A failure this call wrote is told whole, never the row's bounded copy; a
  // row finished elsewhere is told by its own error — or, holding none (its
  // content cleared), by the one this claim stands for.
  const failure = written !== null ? claimedError : (row?.error ?? claimedError);
  return {
    claimed: true,
    written: written !== null,
    status,
    error: status === "failed" ? (failure ?? null) : stopped ? SHUTDOWN_RUN_ERROR : null,
    stopped,
    cacheSavingsUsd,
    contentCleared,
  };
}
