// Outputs-upload helper — pulls the file list from a runner via
// `POST /outputs/collect`, fetches each file's bytes via
// `GET /outputs/file?path=X`, writes them to R2 / MinIO through the storage
// adapter, then returns the files stored, with presigned GET URLs, for the
// `run_complete` event — and how many it left out, by reason.
//
// Lives on the HARNESS side: the sandbox runner holds no storage credentials.
// The harness pulls bytes, writes them to its own storage, and presigns. The
// upload is synchronous — `run_complete` is not emitted until it has ended —
// and bounded: it keeps a time budget of its own, `OUTPUTS_UPLOAD_BUDGET_MS`.
//
// Each GET URL is presigned with an attachment disposition: the store answers
// it with `Content-Disposition: attachment`, so a file opened from its URL is
// saved, never rendered as a page on the store's origin — the same header the
// API's own download routes send.
//
// The runner's answers are not trusted. Its file list is asked for under the
// API's own limits, read bounded through the runner module, checked against
// its schema, and the output name rule and the selection are applied to it
// again: a runner from before the limits, or one the agent took over, lists
// what it likes. Each file is read into one buffer no larger than the size
// limit, reserved first on the process's output bytes budget. Nothing a runner
// writes reaches a log line — positions, sizes, counts and reasons only.
//
// What each failure does — decided, once the budget is involved, by whether its
// signal is raised, never by the name of the error:
//
// | What happens                                          | Outcome                                  |
// |-------------------------------------------------------|------------------------------------------|
// | the budget runs out, whatever the step under way —    | the upload stops: that file and those    |
// | waiting for room, a pull, a write, a presign          | after it are left out (`upload_budget`); |
// |                                                       | what was stored is returned, and the run |
// |                                                       | succeeds with it                         |
// | a pull fails — its time, an answer cut short, past    | that file is left out (`pull_failed`,    |
// | the size limit, redirected, an error status           | `too_large`); the upload goes on         |
// | a name the output name rule refuses, a listed size    | that file is left out (`name_refused`,   |
// | past the limit, a file past the count                 | `too_large`, `over_count`)               |
// | the file list cannot be read — an error status, a     | `OutputsUploadError`                     |
// | redirect, its time, its size, its shape               |                                          |
// | a write or a presign fails before the budget runs out | `OutputsUploadError`                     |
//
// `OutputsUploadError` is of its own class, with a constant message — no path,
// no status, no runner text. Its code names the step that failed, and the cause
// it keeps is that step's error: the run's failure line gives both, the cause by
// its class alone. The run ends on it as a failed run, never as an aborted or
// timed-out one. What was already written stays, in no file list the purge
// reads: it is left to a lifecycle rule on the bucket, which the operator sets.
//
// A write cut by the budget may still have stored its object, in no file list
// either: once that write has ended, its object is deleted at best — not
// awaited — and a store without a delete, or a delete that fails, is logged by
// the file's position.

import { attachmentDisposition } from "../../files/content-disposition.js";
import {
  CollectResponseSchema,
  type OutputLimits,
  readOutputLimits,
  selectOutputFiles,
} from "../../files/output-rules.js";
import type { Logger } from "../../logger.js";
import { createLogger } from "../../logger.js";
import type { FileExclusionReason, FileInfo } from "../../types.js";
import { errorFields } from "../../utils/error-fields.js";
import type { PresignedStorageAdapter } from "./adapter.js";
import {
  type OutputBytesBudget,
  processOutputBytesBudget,
  type ReleaseOutputBytes,
} from "./output-bytes-budget.js";
import { runOutputKey } from "./output-keys.js";
import {
  callRunner,
  discardRunnerBody,
  RunnerResponseTooLarge,
  RunnerStatusError,
  readRunnerBodyInto,
  readRunnerJson,
} from "./runner-call.js";

/** TTL (seconds) for the presigned GET URLs embedded in `run_complete` events. */
const OUTPUTS_PRESIGNED_TTL_S = 15 * 60;

/** How long the pull of one file may take, from asking to its last byte. */
const PULL_FILE_TIMEOUT_MS = 60_000;

/** How long the runner's file list may take, from asking to its last byte. */
export const OUTPUTS_MANIFEST_TIMEOUT_MS = 30_000;

/**
 * How long a whole upload may take: 120 s, counted from its start. Past it,
 * the upload stops where it is — the file under way and those after it are
 * left out — and the run ends with the files already stored. It holds the file
 * list's own bound, so the list always comes in within it.
 */
export const OUTPUTS_UPLOAD_BUDGET_MS = 120_000;

/**
 * The most a file list may weigh: 1 MiB, or 1 KiB per file a run may keep when
 * that is more. An honest entry takes far less than 1 KiB — a name is at most
 * 512 bytes — so a list past this is not one a runner that applies the limits
 * sends.
 */
export function outputsManifestMaxBytes(limits: OutputLimits): number {
  return Math.max(1024 * 1024, limits.max_count * 1024);
}

/** The message of every failure of the upload: it names no path, no status, no runner text. */
const OUTPUTS_UPLOAD_ERROR_MESSAGE = "The run's output files could not be stored.";

/**
 * A step of an upload: reading the runner's file list, then, for each file,
 * reserving room on the bytes budget, pulling it, writing it to storage and
 * signing its link.
 */
export type OutputsUploadStep = "list" | "reserve" | "pull" | "put" | "presign";

/**
 * The outputs upload failed: the run cannot end with its files. Of its own
 * class, so that it is never read as the run's abort or timeout, and with a
 * constant message. Its `code` names the step that failed — `outputs_list`,
 * `outputs_put`, … —, a token a log line carries as `error_code`; the cause,
 * kept, is the error that step failed with, whose message is never logged: a
 * storage error can quote the key, and the key holds a name the agent chose.
 */
export class OutputsUploadError extends Error {
  readonly code: `outputs_${OutputsUploadStep}`;

  constructor(step: OutputsUploadStep, options?: ErrorOptions) {
    super(OUTPUTS_UPLOAD_ERROR_MESSAGE, options);
    this.name = "OutputsUploadError";
    this.code = `outputs_${step}`;
  }
}

/** Why a run's output file is not among those stored: the reasons a run's caller is told. */
export type OutputsUploadExclusionReason = FileExclusionReason;

/** How many of a run's output files were left out, by reason. */
export type OutputsUploadExclusions = Record<OutputsUploadExclusionReason, number>;

/** What an upload stored, and how many files it left out. */
export interface OutputsUploadResult {
  files: FileInfo[];
  excluded: OutputsUploadExclusions;
}

export interface OutputManifestEntry {
  /** Path relative to `/mnt/session/outputs` inside the runner. */
  path: string;
  size: number;
  mimeType: string;
}

export interface OutputsUploadOptions {
  /** Stable run identifier — used in the R2 key namespace. */
  runId: string;
  /** Runner HTTP base URL (`http://[fdaa:...]:9000`). */
  runnerBaseUrl: string;
  /** Storage adapter that does the actual PUT to R2/MinIO. */
  storage: PresignedStorageAdapter;
  /** Injectable fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Per-run RPC bearer token. When set, sent as
   * `Authorization: Bearer <token>` on `/outputs/collect` + `/outputs/file` so
   * the runner's RPC middleware accepts the harness's outputs pull. Unset →
   * no header (back-compat with a runner that does not enforce the token).
   */
  token?: string;
  /** Override the presigned-URL TTL for the returned FileInfo entries. */
  presignedTtlSeconds?: number;
  /** Override the per-file pull timeout. */
  pullTimeoutMs?: number;
  /**
   * The limits the runner is asked to apply, and that are applied again to
   * what it lists. Default: the environment's (`readOutputLimits`), the one
   * reader the local engine uses too.
   */
  limits?: OutputLimits;
  /** Where the upload logs what it leaves out. */
  logger?: Logger;
  /**
   * The bytes budget each file's buffer is reserved on, before its pull: shared
   * by every run, so that the buffers of all the uploads at once stay within it.
   * Default: the process's ({@link processOutputBytesBudget}).
   */
  bytesBudget?: OutputBytesBudget;
}

/**
 * Pull the file list from the runner, then write each file to storage, one
 * after the other, within {@link OUTPUTS_UPLOAD_BUDGET_MS} of the start.
 *
 * Resolves with `files`, ready to embed in the `run_complete` event — each
 * entry carries `name`, the `size` received (never the one the runner
 * announced), and a presigned `url` for direct GET by the caller — and
 * `excluded`, the files left out counted by reason: what the runner left out of
 * its list, plus what this upload left out itself. Each file is written at
 * `runOutputKey(runId, relative-path)`, the one definition of where a run's
 * outputs live in storage.
 *
 * - A file refused by name, past the size limit or past the count, or whose
 *   pull fails → left out, counted and logged; the upload goes on.
 * - The budget runs out → the upload stops where it is: the file under way and
 *   those after it are left out (`upload_budget`), and it resolves with what it
 *   stored. A write cut by it has its object deleted at best once it ended.
 * - The file list cannot be read, or a write or a presign fails before the
 *   budget runs out → rejects with {@link OutputsUploadError}. What was already
 *   written is not removed.
 *
 * The outcome of a failed write or presign is decided by whether the budget's
 * signal is raised, never by the error's name: a write cut by the budget and
 * one that timed out by itself can fail with the same one.
 */
export async function uploadOutputs(opts: OutputsUploadOptions): Promise<OutputsUploadResult> {
  const startedAt = Date.now();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const ttl = opts.presignedTtlSeconds ?? OUTPUTS_PRESIGNED_TTL_S;
  const pullTimeoutMs = opts.pullTimeoutMs ?? PULL_FILE_TIMEOUT_MS;
  const limits = opts.limits ?? readOutputLimits(process.env);
  const logger = opts.logger ?? createLogger("outputs-upload");

  // The budget is a signal, raised by the upload itself. Whether it is raised is
  // what decides the outcome of a failed step — never the error's name: a write
  // cut by it and one that timed out by itself can fail with the same one.
  const budget = new AbortController();
  const budgetTimer = setTimeout(
    () => budget.abort(new DOMException("The outputs upload ran out of time.", "TimeoutError")),
    OUTPUTS_UPLOAD_BUDGET_MS,
  );
  try {
    return await uploadUnderBudget(opts, {
      fetchImpl,
      ttl,
      pullTimeoutMs,
      limits,
      logger,
      startedAt,
      signal: budget.signal,
    });
  } finally {
    clearTimeout(budgetTimer);
  }
}

/** Where an upload was when one of its files failed, or when its budget ran out. */
type UploadStage = Exclude<OutputsUploadStep, "list">;

async function uploadUnderBudget(
  opts: OutputsUploadOptions,
  run: {
    fetchImpl: typeof fetch;
    ttl: number;
    pullTimeoutMs: number;
    limits: OutputLimits;
    logger: Logger;
    startedAt: number;
    signal: AbortSignal;
  },
): Promise<OutputsUploadResult> {
  const { fetchImpl, ttl, pullTimeoutMs, limits, logger, signal } = run;
  // The list has its own bound, well within the budget: it is never cut by it.
  const manifest = await fetchManifest(opts.runnerBaseUrl, fetchImpl, limits, opts.token);
  const excluded: OutputsUploadExclusions = {
    name_refused: 0,
    too_large: 0,
    over_count: 0,
    pull_failed: 0,
    upload_budget: 0,
  };
  const runnerExcluded = manifest.excluded;
  if (runnerExcluded) {
    excluded.name_refused += runnerExcluded.name_refused;
    excluded.too_large += runnerExcluded.too_large;
    excluded.over_count += runnerExcluded.over_count;
    if (runnerExcluded.name_refused + runnerExcluded.too_large + runnerExcluded.over_count > 0) {
      logger.warn(
        { event: "outputs_runner_excluded", run_id: opts.runId, ...runnerExcluded },
        "The runner left output files out of its list",
      );
    }
  }

  // One line per file left out, up to the number a run may keep: the list is
  // the runner's to write, and it can hold tens of thousands of refused names.
  const exclusionLines = cappedExclusionLines(logger, opts.runId, limits.max_count);

  // The rule the runner was asked to apply, applied again to what it answered.
  const selection = selectOutputFiles(manifest.files, limits);
  for (const { candidate, index, reason } of selection.exclusions) {
    excluded[reason]++;
    if (reason === "over_count") continue;
    exclusionLines.file(index, candidate.size, reason);
  }
  if (selection.excluded.over_count > 0) {
    logger.warn(
      {
        event: "files_count_exceeded",
        run_id: opts.runId,
        max_count: limits.max_count,
        over_count: selection.excluded.over_count,
      },
      "The runner listed more output files than a run keeps",
    );
  }

  const bytesBudget = opts.bytesBudget ?? processOutputBytesBudget();
  const positions = new Map(manifest.files.map((candidate, index) => [candidate, index]));
  const files: FileInfo[] = [];
  let bytes = 0;
  // One file at a time: an upload holds one reservation, one buffer, at once.
  for (const [at, entry] of selection.kept.entries()) {
    const index = positions.get(entry);
    let stage: UploadStage = "reserve";
    let release: ReleaseOutputBytes | undefined;
    // Set once the write is asked for: from then on, the store may hold the object.
    let key: string | undefined;
    try {
      release = await bytesBudget.reserve(limits.max_size_bytes, signal);
      stage = "pull";
      const pulled = await pullFile(opts.runnerBaseUrl, entry.path, fetchImpl, {
        maxBytes: limits.max_size_bytes,
        timeoutMs: pullTimeoutMs,
        token: opts.token,
        signal,
      });
      // A pull the budget ended is not a failed pull: the upload stops.
      signal.throwIfAborted();
      if (!pulled.ok) {
        excluded[pulled.reason]++;
        exclusionLines.file(index, entry.size, pulled.reason);
        continue;
      }
      stage = "put";
      key = runOutputKey(opts.runId, entry.path);
      await opts.storage.put(key, pulled.bytes, { signal });
      signal.throwIfAborted();
      stage = "presign";
      const url = await unlessAborted(
        opts.storage.getPresignedDownloadUrl(key, ttl, {
          contentDisposition: attachmentDisposition(entry.path),
        }),
        signal,
      );
      // The size received, never the one the runner announced.
      files.push({ name: entry.path, size: pulled.bytes.length, url });
      bytes += pulled.bytes.length;
    } catch (err) {
      // A step that failed before the budget ran out fails the upload, whatever
      // its error says, under the name of that step.
      if (!signal.aborted) {
        exclusionLines.flush();
        throw new OutputsUploadError(stage, { cause: err });
      }
      // The write has ended — it was awaited — but the object it may have stored
      // is in no file list, where the purge would find it.
      if (key !== undefined) eraseCutWrite(opts.storage, key, { runId: opts.runId, index, logger });
      const left = selection.kept.length - at;
      excluded.upload_budget += left;
      logger.warn(
        {
          event: "outputs_upload_budget_exhausted",
          run_id: opts.runId,
          stage,
          uploaded: files.length,
          excluded: left,
        },
        "The outputs upload ran out of time",
      );
      break;
    } finally {
      release?.();
    }
  }
  exclusionLines.flush();
  logger.info(
    {
      event: "outputs_uploaded",
      run_id: opts.runId,
      files: files.length,
      bytes,
      excluded: Object.values(excluded).reduce((sum, count) => sum + count, 0),
      duration_ms: Date.now() - run.startedAt,
    },
    "Outputs uploaded",
  );
  return { files, excluded };
}

/** The reasons an upload logs a file it leaves out for, one line per file. */
type LoggedExclusionReason = Extract<
  OutputsUploadExclusionReason,
  "name_refused" | "too_large" | "pull_failed"
>;

/**
 * The lines an upload writes for the files it leaves out by name, by size or
 * by a failed pull: `outputs_file_excluded`, one per file — its position in the
 * list, the size listed, the reason — up to `cap` of them, the number of files
 * a run may keep. A runner that applies the limits never lists more files than
 * that, nor fails more pulls; a list past it is written to fill the log — 1 MiB
 * holds some 29,000 names the rule refuses. The files past the cap are counted
 * by reason instead, and `flush` writes those counts in one line,
 * `outputs_files_excluded_unlogged`, when there are any. What the run reports
 * it left out stays exact: only the lines are capped.
 */
function cappedExclusionLines(logger: Logger, runId: string, cap: number) {
  let logged = 0;
  const unlogged: Record<LoggedExclusionReason, number> = {
    name_refused: 0,
    too_large: 0,
    pull_failed: 0,
  };
  return {
    file(index: number | undefined, size: number, reason: LoggedExclusionReason): void {
      if (logged >= cap) {
        unlogged[reason]++;
        return;
      }
      logged++;
      logger.warn(
        { event: "outputs_file_excluded", run_id: runId, index, size, reason },
        "Output file left out",
      );
    },
    flush(): void {
      if (unlogged.name_refused + unlogged.too_large + unlogged.pull_failed === 0) return;
      logger.warn(
        { event: "outputs_files_excluded_unlogged", run_id: runId, ...unlogged },
        "Output files left out past the lines an upload writes one by one",
      );
    },
  };
}

/**
 * `step`, or the signal's reason if the signal is aborted first. The step goes
 * on unwatched: whatever it ends with later is dropped.
 */
function unlessAborted<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    step.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Delete, at best, the object a write cut by the budget may have stored. Not
 * awaited: the run ends within its budget, and a delete that fails or a store
 * without one leaves the object to a lifecycle rule on the bucket, the
 * operator's — logged by the file's position, never by its key.
 */
function eraseCutWrite(
  storage: PresignedStorageAdapter,
  key: string,
  where: { runId: string; index: number | undefined; logger: Logger },
): void {
  const left = (fields: Record<string, unknown>) =>
    where.logger.warn(
      {
        event: "outputs_interrupted_object_left",
        run_id: where.runId,
        index: where.index,
        ...fields,
      },
      "An output object a cut write may have stored is left to the lifecycle rule",
    );
  const remove = storage.delete;
  if (remove === undefined) {
    left({ reason: "no_delete" });
    return;
  }
  new Promise<void>((resolve) => resolve(remove.call(storage, key))).catch((err: unknown) =>
    left({ reason: "delete_failed", ...errorFields(err) }),
  );
}

/**
 * The runner's file list: asked for under `limits`, within
 * {@link OUTPUTS_MANIFEST_TIMEOUT_MS} from asking to its last byte, read up to
 * {@link outputsManifestMaxBytes}, and checked against its schema. Anything
 * else fails the upload. An error status fails it with a `RunnerStatusError`
 * cause, a list not in its shape with a plain `Error`: the run's failure line,
 * which names the cause by its class, tells the two apart — a runner's `400`
 * to limits past its own bounds among them.
 */
async function fetchManifest(
  baseUrl: string,
  fetchImpl: typeof fetch,
  limits: OutputLimits,
  token?: string,
) {
  const startedAt = Date.now();
  let raw: unknown;
  try {
    const response = await callRunner(
      fetchImpl,
      `${baseUrl}/outputs/collect`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(limits),
      },
      { headersTimeoutMs: OUTPUTS_MANIFEST_TIMEOUT_MS },
    );
    if (!response.ok) {
      discardRunnerBody(response);
      throw new RunnerStatusError("/outputs/collect", response.status);
    }
    raw = await readRunnerJson(response, {
      maxBytes: outputsManifestMaxBytes(limits),
      deadlineMs: Math.max(0, OUTPUTS_MANIFEST_TIMEOUT_MS - (Date.now() - startedAt)),
      what: "/outputs/collect",
    });
  } catch (err) {
    throw new OutputsUploadError("list", { cause: err });
  }
  const parsed = CollectResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OutputsUploadError("list", {
      cause: new Error("/outputs/collect answered a list that is not one"),
    });
  }
  return parsed.data;
}

/** A file pulled, or why it is left out. */
type PulledFile =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: Extract<OutputsUploadExclusionReason, "too_large" | "pull_failed"> };

/**
 * Pull one file into one buffer of `maxBytes`, allocated once the answer's
 * headers are in and never grown; what is stored is the part of it the answer
 * filled. A file past `maxBytes` — announced by its `Content-Length`, refused
 * by the runner (`413`), or found so while reading, one byte past the limit at
 * most — is too large. Any other failure leaves it out as a failed pull: an
 * error status, a redirect, an answer that ends before its `Content-Length`
 * (a file that shrank), or one still coming `timeoutMs` after asking. Never
 * throws for the file: the upload goes on with the next. `signal` stops the
 * pull as a failed one; the caller tells that apart by the signal.
 */
async function pullFile(
  baseUrl: string,
  path: string,
  fetchImpl: typeof fetch,
  options: { maxBytes: number; timeoutMs: number; token?: string; signal?: AbortSignal },
): Promise<PulledFile> {
  const startedAt = Date.now();
  try {
    const response = await callRunner(
      fetchImpl,
      `${baseUrl}/outputs/file?path=${encodeURIComponent(path)}`,
      { headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined },
      { headersTimeoutMs: options.timeoutMs, signal: options.signal },
    );
    if (!response.ok) {
      discardRunnerBody(response);
      return { ok: false, reason: response.status === 413 ? "too_large" : "pull_failed" };
    }
    const declared = declaredLength(response);
    if (declared !== null && declared > options.maxBytes) {
      // Refused before a byte of the body is read.
      discardRunnerBody(response);
      return { ok: false, reason: "too_large" };
    }
    const buffer = Buffer.allocUnsafe(options.maxBytes);
    const received = await readRunnerBodyInto(response, buffer, {
      deadlineMs: Math.max(0, options.timeoutMs - (Date.now() - startedAt)),
      signal: options.signal,
      what: "/outputs/file",
    });
    if (declared !== null && received !== declared) return { ok: false, reason: "pull_failed" };
    return { ok: true, bytes: buffer.subarray(0, received) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof RunnerResponseTooLarge ? "too_large" : "pull_failed",
    };
  }
}

/** The answer's `Content-Length`, when it gives a whole number of bytes. */
function declaredLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  const value = Number(header.trim());
  return Number.isSafeInteger(value) ? value : null;
}
