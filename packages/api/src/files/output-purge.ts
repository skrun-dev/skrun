/**
 * The deletion of the output files a cloud run leaves in object storage.
 *
 * On the cloud runtime, a run's output files are uploaded to the object store —
 * the bucket that also holds the bundles — under keys the runtime defines
 * (`runOutputKey`, `runOutputsArchiveKey`). When such a run completes, its row
 * gets a deadline: the completion time plus the files retention window. This
 * module deletes those objects once the deadline has passed, then marks the row.
 *
 * Why the deadline is in the database, and not in a timer. A process that is not
 * running has no timer — a service scaled to zero while idle, or one being
 * redeployed. A deadline written when the run completes survives that, and the
 * pass run at startup catches up with whatever fell due in the meantime.
 *
 * Why the bucket is never listed. The keys are rebuilt from the file list the
 * row keeps (`runOutputDeletes`, the one definition, which an account deletion
 * uses too). The storage port can list under a folder, and the purge does not:
 * a listing over a bucket shared with bundles would widen what a mistake in a
 * prefix could reach. What the database does not know — an upload that failed
 * half-way, a completion write that was lost — is for a lifecycle rule on the
 * bucket, the operator's decision.
 *
 * What the name check is, and what it rests on. The names come from the
 * sandbox, and a key is built from a name by concatenation: a `..` segment is
 * not resolved here, and the storage client sends it as it is. The stores this
 * runs against do not resolve it either, nor keep it as a key: R2 and MinIO
 * both refuse it — MinIO answers 400, naming the segment, R2 fails the
 * request's signature — on a write, a read and a delete alike. So a delete for
 * such a name reaches nothing, a bundle least of all; but that is the store's
 * refusal, not a property of keys, and not one to build on. What closes the
 * hole whatever a store does is the output name rule (`outputNameRefusal`, the
 * runtime's, re-exported here): the cloud upload applies it before a name
 * becomes a key, so no object is written under a name it refuses, and the
 * purge and the fresh link refuse the same names — any name the upload
 * accepts, the purge can delete. A refused name gets no delete; the run's
 * other names are deleted as usual, and the run is marked.
 *
 * Why there is no lock. Every instance runs the purge, so two of them can take
 * the same run: deleting a key that is already gone is not an error, and a run
 * already marked keeps its first mark. Both succeed.
 *
 * What a log line says: the run id, counts, a reason, a position in the file
 * list, the class and code of an error. Never a file name, a key, or an error
 * message, which can quote the key: a file name can be personal data, and a log
 * store is another destination, kept for another length of time.
 *
 * Started from the server entry points, never from the app factory — every test
 * builds an app, and none of them asked for a timer.
 */
import {
  createLogger,
  isSafeOutputName,
  type OutputNameRefusal,
  outputNameRefusal,
  runOutputKey,
  runOutputsArchiveKey,
} from "@skrun-dev/runtime";
import { FILE_CACHE_SWEEP_INTERVAL_MS } from "../cache/file-cache-sweep.js";
import type { DbAdapter } from "../db/adapter.js";
import type { Run } from "../db/schema.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { errorFields } from "../utils/error-fields.js";

const logger = createLogger("output-purge");

/** At most this many runs per pass; the others wait for the next one. */
export const OUTPUT_PURGE_MAX_ROWS = 100;

/**
 * At most this many deletes per pass — except for the first run of a pass,
 * which is always finished: a run with more files than this would otherwise
 * never be.
 */
export const OUTPUT_PURGE_MAX_KEYS = 1000;

/**
 * A pass stops once this many of its runs have failed. Against a store that
 * does not answer, each failed delete waits out the client's timeouts: a pass
 * that went on would last hours and log one failure per run. Several runs
 * failing in one pass are a store or a database in trouble, not several runs.
 * One run that keeps failing is one failure: the pass goes on past it.
 */
export const OUTPUT_PURGE_MAX_FAILED_RUNS = 3;

/**
 * A tick skipped because the previous pass is still running is a warning; the
 * skip that makes this many in a row is an error, once per stall. A pass that
 * never ends — a query that hangs, with no statement timeout on the database
 * client — purges nothing until the process restarts, and must not read like
 * a slow one.
 */
export const OUTPUT_PURGE_STALLED_AFTER_SKIPS = 3;

/**
 * The output name rule — why a name from a run's file list gets no delete, and
 * whether the purge deletes the object stored under it. Defined once in the
 * runtime, where the upload applies it too; re-exported here for the API's own
 * callers, the fresh-link route among them.
 */
export { isSafeOutputName, type OutputNameRefusal, outputNameRefusal };

/** What one pass did. */
export interface OutputPurgeResult {
  /** Runs whose objects were all deleted, and that were marked. */
  rows: number;
  /** Deletes that succeeded. */
  deleted: number;
  /** Names that got no delete. */
  refused: number;
  /** Runs left unmarked because a delete or the mark failed; the next pass takes them again. */
  failed: number;
}

/** One object to delete for a run: one of its output files, or its archive (`fileIndex` null). */
export interface PlannedDelete {
  key: string;
  fileIndex: number | null;
}

/** A name from a run's file list that gets no delete, by its position in the list. */
export interface Refusal {
  fileIndex: number;
  reason: OutputNameRefusal | null;
}

/**
 * The keys a run's output objects are stored under, and the names that get
 * none: every name `isSafeOutputName` accepts, then the run's archive. The one
 * definition of those keys for whoever deletes them.
 */
export function runOutputDeletes(run: Pick<Run, "id" | "files">): {
  keys: PlannedDelete[];
  refusals: Refusal[];
} {
  const keys: PlannedDelete[] = [];
  const refusals: Refusal[] = [];
  const files: unknown[] = Array.isArray(run.files) ? run.files : [];
  for (const [fileIndex, file] of files.entries()) {
    const name =
      typeof file === "object" && file !== null ? (file as { name?: unknown }).name : undefined;
    if (isSafeOutputName(name)) {
      keys.push({ key: runOutputKey(run.id, name), fileIndex });
    } else {
      refusals.push({ fileIndex, reason: outputNameRefusal(name) });
    }
  }
  // Nothing writes the archive today, but a URL to upload it is presigned for
  // every run: deleting it costs one call on a key that is usually absent, and
  // the day something does write it, it is already covered.
  keys.push({ key: runOutputsArchiveKey(run.id), fileIndex: null });
  return { keys, refusals };
}

/** Which object a failed delete was for, without its key. */
function objectFields(fileIndex: number | null): Record<string, unknown> {
  return fileIndex === null
    ? { object: "outputs_archive" }
    : { object: "output_file", file_index: fileIndex };
}

/**
 * One pass: the runs whose deadline is at or before `now` and that are not yet
 * marked, oldest deadline first, within the bounds above. For each run, its
 * objects are deleted one after the other, and the run is marked only once every
 * delete has succeeded. A failure leaves the run unmarked for the next pass; so
 * does a pass that stops after too many of them.
 */
export async function purgeDueRunOutputs(
  db: DbAdapter,
  storage: Pick<StorageAdapter, "delete">,
  now: Date = new Date(),
): Promise<OutputPurgeResult> {
  // The form the deadline is written in: one store compares the two as text.
  const at = now.toISOString();
  const result: OutputPurgeResult = { rows: 0, deleted: 0, refused: 0, failed: 0 };
  const due = await db.listRunsDueForOutputPurge(at, OUTPUT_PURGE_MAX_ROWS);
  let keysLeft = OUTPUT_PURGE_MAX_KEYS;

  runs: for (const [position, run] of due.entries()) {
    if (result.failed >= OUTPUT_PURGE_MAX_FAILED_RUNS) {
      logger.warn(
        {
          event: "run_output_purge_pass_stopped",
          failed_runs: result.failed,
          runs_left: due.length - position,
        },
        "Output purge pass stopped after repeated failures; the remaining runs wait for the next pass",
      );
      break;
    }
    const { keys, refusals } = runOutputDeletes(run);
    // A run is started only when all of its deletes fit in what is left of the
    // pass; otherwise it heads the next one. The first run is always finished.
    if (position > 0 && keys.length > keysLeft) break;
    keysLeft -= keys.length;

    for (const { fileIndex, reason } of refusals) {
      logger.warn(
        { event: "run_output_name_refused", run_id: run.id, reason, file_index: fileIndex },
        "Output file name refused: nothing is deleted for it",
      );
    }
    result.refused += refusals.length;

    // Marked only after every delete succeeded: a run marked while one of its
    // objects is still there would never be looked at again.
    for (const { key, fileIndex } of keys) {
      try {
        await storage.delete(key);
      } catch (err) {
        logger.error(
          {
            event: "run_output_purge_failed",
            run_id: run.id,
            step: "delete",
            ...objectFields(fileIndex),
            ...errorFields(err),
          },
          "Output file delete failed; the run is left for the next pass",
        );
        result.failed++;
        continue runs;
      }
      result.deleted++;
    }
    try {
      await db.markRunOutputsPurged(run.id, at);
    } catch (err) {
      logger.error(
        { event: "run_output_purge_failed", run_id: run.id, step: "mark", ...errorFields(err) },
        "Marking the run's outputs purged failed; the run is left for the next pass",
      );
      result.failed++;
      continue;
    }
    result.rows++;
    logger.info(
      {
        event: "run_outputs_purged",
        run_id: run.id,
        deleted: keys.length,
        refused: refusals.length,
      },
      "Run output files deleted from object storage",
    );
  }
  return result;
}

/**
 * Start the purge: one pass now, then one every `FILE_CACHE_SWEEP_INTERVAL_MS`
 * — the interval of the local file sweep, so the one interval the docs state
 * for both comes from one constant. No environment variable: the retention
 * window is a published deletion bound, and an interval an operator could widen
 * would make it false without anyone touching this file.
 *
 * Without an object store — any runtime but the cloud one, where a run's files
 * stay on local disk and the file sweep covers them — nothing starts, and this
 * returns `undefined`.
 *
 * The pass at startup needs no guard like the local sweep's orphan pass: a
 * deadline is written when a run completes, so no run still in flight is due.
 *
 * Returns the timer, which never keeps the process alive on its own.
 */
export function startRunOutputPurge(
  db: DbAdapter,
  storage?: Pick<StorageAdapter, "delete">,
): NodeJS.Timeout | undefined {
  if (!storage) return undefined;
  let running = false;
  let skippedInARow = 0;
  const pass = () => {
    // One pass at a time in a process. A pass that outlives the interval — a
    // backlog after a long stop, a store that answers slowly — makes the next
    // tick skip, and says so; still running OUTPUT_PURGE_STALLED_AFTER_SKIPS
    // ticks later, it says so as an error, once: a pass that never ends would
    // otherwise stop the purge behind nothing louder than a warning.
    if (running) {
      skippedInARow++;
      if (skippedInARow === OUTPUT_PURGE_STALLED_AFTER_SKIPS) {
        logger.error(
          { event: "run_output_purge_pass_stalled", skipped_ticks: skippedInARow },
          "Output purge pass still running after several intervals; nothing is purged until it ends",
        );
      } else {
        logger.warn(
          { event: "run_output_purge_pass_skipped", skipped_ticks: skippedInARow },
          "Output purge pass skipped: the previous one is still running",
        );
      }
      return;
    }
    skippedInARow = 0;
    running = true;
    // A failed pass is a log line, never a rejection: one from a timer callback
    // would take the whole process down over a database blip.
    void purgeDueRunOutputs(db, storage)
      .catch((err) => {
        logger.error(
          { event: "run_output_purge_pass_failed", ...errorFields(err) },
          "Output purge pass failed; the next one starts over",
        );
      })
      .finally(() => {
        running = false;
      });
  };

  // At startup, and only then on the interval: a process that was stopped when
  // runs fell due catches up now, not an interval later.
  pass();

  const timer = setInterval(pass, FILE_CACHE_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
