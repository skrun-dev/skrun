/**
 * The sweep that makes the file retention windows deletion bounds.
 *
 * Both file caches (agent output directories, uploaded input files) expire
 * their entries on the next read only: a directory nobody asks for again sits
 * on disk until the process ends or the cache evicts it for space. On a host
 * whose root filesystem is rebuilt at every boot that is invisible; on a
 * self-host with a persistent disk it is real, and the in-memory index that
 * would have deleted those directories is gone after a restart, so nothing ever
 * will. This module adds the two things that fix that:
 *
 *   1. A recurring sweep that removes expired entries whether or not anyone
 *      reads them — so "kept for an hour" means an hour, give or take one
 *      sweep interval.
 *   2. A boot pass that removes the directories a previous process left behind.
 *      It runs ONLY at boot, and only while the caches are still empty: a run
 *      creates its output directory BEFORE the run completes and registers it,
 *      so a periodic orphan pass would delete the files of a run in flight.
 *
 * Started from the server entrypoints, never from the app factory (every test
 * builds an app; none of them asked for a timer).
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@skrun-dev/runtime";
import { INPUT_DIR_NAME } from "../files/input-store.js";
import { inputCache } from "./input-cache.js";
import { OUTPUT_DIR_PREFIX, outputCache } from "./output-cache.js";

const logger = createLogger("file-cache");

/** Five minutes: short next to the one-hour output window, cheap to run. */
export const FILE_CACHE_SWEEP_INTERVAL_MS = 300_000;

/** Remove every expired entry of both caches now, without waiting for a read. */
export function sweepExpiredFiles(): { outputs: number; inputs: number } {
  const outputs = outputCache.sweep();
  const inputs = inputCache.sweep();
  if (outputs > 0 || inputs > 0) {
    logger.info({ event: "file_cache_swept", outputs, inputs }, "Expired run files removed");
  }
  return { outputs, inputs };
}

function readdirOrEmpty(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeQuietly(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    logger.warn(
      {
        event: "file_cache_orphan_unremovable",
        path,
        error: err instanceof Error ? err.message : String(err),
      },
      "Could not remove a leftover run file",
    );
    return false;
  }
}

/**
 * Delete what a previous process left under the temp root: every output
 * directory and every uploaded input. Safe only at boot, when nothing has been
 * registered yet — the guard refuses to run otherwise, because after boot a
 * directory without an index entry may be a run still in flight.
 */
export function removeOrphanedFilesAtBoot(root: string = tmpdir()): {
  outputDirs: number;
  inputFiles: number;
} {
  if (outputCache.size > 0 || inputCache.size > 0) {
    logger.warn(
      { event: "file_cache_boot_pass_skipped", outputs: outputCache.size, inputs: inputCache.size },
      "Orphan pass skipped: files are already registered, so this is not boot",
    );
    return { outputDirs: 0, inputFiles: 0 };
  }
  let outputDirs = 0;
  for (const entry of readdirOrEmpty(root)) {
    if (entry.isDirectory() && entry.name.startsWith(OUTPUT_DIR_PREFIX)) {
      if (removeQuietly(join(root, entry.name))) outputDirs++;
    }
  }
  let inputFiles = 0;
  const inputDir = join(root, INPUT_DIR_NAME);
  for (const entry of readdirOrEmpty(inputDir)) {
    if (removeQuietly(join(inputDir, entry.name))) inputFiles++;
  }
  if (outputDirs > 0 || inputFiles > 0) {
    logger.info(
      { event: "file_cache_orphans_removed", outputDirs, inputFiles, root },
      "Run files left by a previous process removed at boot",
    );
  }
  return { outputDirs, inputFiles };
}

/**
 * Boot pass, then the recurring sweep. Returns the timer so a caller can observe
 * or stop it. The timer never keeps the process alive on its own.
 */
export function startFileCacheSweep(root: string = tmpdir()): NodeJS.Timeout {
  try {
    removeOrphanedFilesAtBoot(root);
  } catch (err) {
    logger.error(
      {
        event: "file_cache_boot_pass_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "Orphan pass failed",
    );
  }
  const sweep = () => {
    // A background sweep has nobody waiting for an answer: its failure is a log
    // line, never a rejection that would take the process down.
    try {
      sweepExpiredFiles();
    } catch (err) {
      logger.error(
        {
          event: "file_cache_sweep_failed",
          error: err instanceof Error ? err.message : String(err),
        },
        "Expired-file sweep failed",
      );
    }
  };
  sweep();
  const timer = setInterval(sweep, FILE_CACHE_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
