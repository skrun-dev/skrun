/**
 * The sweep that makes the file retention windows deletion bounds.
 *
 * The file caches (agent output directories, uploaded input files, extracted
 * bundles) expire their entries on the next read only: a directory nobody asks
 * for again sits on disk until the process ends or the cache evicts it for
 * space. On a host whose root filesystem is rebuilt at every boot that is
 * invisible; on a self-host with a persistent disk it is real, and the
 * in-memory index that would have deleted those directories is gone after a
 * restart, so nothing ever will. This module adds the two things that fix that:
 *
 *   1. A recurring sweep that removes expired entries whether or not anyone
 *      reads them — so "kept for an hour" means an hour, give or take one
 *      sweep interval.
 *   2. An orphan pass, at boot and after every sweep, that removes what no live
 *      process holds: what a previous process left behind, and what a run that
 *      failed before registering its files left. The temp root may be shared
 *      with another instance, so a file's modification time says when anyone
 *      may remove it: a registered file carries its deadline, a held one now
 *      plus its window, set again at every sweep; the pass removes a file two
 *      sweep intervals past that time, and never what its own process holds.
 *      It runs in the background, never two at once, and removes a bounded
 *      number of entries each time: a large stock never delays the start.
 *
 * Started from the server entrypoints, never from the app factory (every test
 * builds an app; none of them asked for a timer).
 */
import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "@skrun-dev/runtime";
import { INPUT_DIR_NAME } from "../files/input-store.js";
import { BUNDLE_DIR_PREFIX } from "../utils/bundle.js";
import { errorFields } from "../utils/error-fields.js";
import { ownedExtractionDirs, sweepBundleCache, touchOwnedExtractions } from "./bundle-cache.js";
import { inputCache, ownedInputPaths, touchOwnedInputs } from "./input-cache.js";
import {
  OUTPUT_DIR_PREFIX,
  outputCache,
  ownedOutputDirs,
  touchOwnedOutputDirs,
} from "./output-cache.js";

const logger = createLogger("file-cache");

/** Five minutes: short next to the one-hour output window, cheap to run. */
export const FILE_CACHE_SWEEP_INTERVAL_MS = 300_000;

/** The exact form of a `randomUUID()`. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The whole name of an extraction, and of a run's output directory: the
 * prefix, then a `randomUUID()` (the run's id, for an output directory).
 * Nothing else under the temp root is taken for one.
 */
const EXTRACTION_NAME = new RegExp(`^${BUNDLE_DIR_PREFIX}${UUID}$`);
const OUTPUT_DIR_NAME = new RegExp(`^${OUTPUT_DIR_PREFIX}${UUID}$`);

/**
 * How long past the time a file carries the orphan pass waits before removing
 * it: two sweep intervals. A file a live instance holds carries a time ahead —
 * its deadline, or now plus its window, set again at every sweep — so this
 * margin is never reached by a live file; the second interval covers a late
 * timer. The passing instance's own windows play no part.
 */
export const ORPHAN_MARGIN_MS = 2 * FILE_CACHE_SWEEP_INTERVAL_MS;

/**
 * Remove every expired entry of the file caches now, without waiting for a
 * read: run outputs, uploaded inputs, and extracted bundles. The bundle cache
 * is keyed by the bundle's bytes, so the extraction of a deleted version is
 * never read again — without this sweep its directory would stay until the
 * cache overflowed, and past the process's end for good. With it, an extraction leaves the
 * disk at most its TTL plus one sweep interval after it was made — or, when a
 * run still uses it, once that run ends: those are counted apart.
 */
export function sweepExpiredFiles(): {
  outputs: number;
  inputs: number;
  bundlesRemoved: number;
  bundlesHeld: number;
} {
  const outputs = outputCache.sweep();
  const inputs = inputCache.sweep();
  const bundles = sweepBundleCache();
  // What this process still holds carries the time past which anyone may
  // remove it: a deadline, or now plus a window for what is held with none yet
  // (a run longer than its window included). Set again here, since a file
  // written into a directory moves its time. That time only guides the orphan
  // pass of an instance sharing the temp root; a file's own expiry is its
  // cache's.
  touchOwnedExtractions();
  touchOwnedOutputDirs();
  touchOwnedInputs();
  if (outputs > 0 || inputs > 0 || bundles.removed > 0 || bundles.held > 0) {
    logger.info(
      {
        event: "file_cache_swept",
        outputs,
        inputs,
        bundles_removed: bundles.removed,
        bundles_held: bundles.held,
      },
      "Expired run files removed",
    );
  }
  return { outputs, inputs, bundlesRemoved: bundles.removed, bundlesHeld: bundles.held };
}

/**
 * The most entries one orphan pass removes. What is left goes at the next
 * passes, one interval apart, so a pass never runs for long, whatever the
 * stock under the temp root — a self-host upgraded from a version that never
 * removed extractions can hold tens of thousands.
 *
 * Twenty thousand stays above what a stopped server can leave at the default
 * cache bounds — 1,000 recorded output directories (`output-cache.ts`),
 * 10,000 uploads (`input-cache.ts`), 50 extractions (`BUNDLE_CACHE_MAX`) —
 * with room for the output directories of runs that failed before recording
 * them: in steady state every file that comes of age between two passes goes
 * at the next one, and the retention bounds hold. One removal took about half
 * a millisecond on a Windows host (a leftover extraction holds one or two
 * files), so a full pass is seconds of background work; even at ten
 * milliseconds a removal it ends within one interval.
 */
export const ORPHAN_PASS_MAX_REMOVALS = 20_000;

/** What one orphan pass removed, by kind. */
export interface OrphanPassResult {
  outputDirs: number;
  inputFiles: number;
  bundleDirs: number;
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function removeQuietly(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    // The path stays: it is a name this server generated (a run's output
    // directory, an uploaded input's id). A name an agent chose lives inside an
    // output directory, and would only ever show in the error's message.
    logger.warn(
      { event: "file_cache_orphan_unremovable", path, ...errorFields(err) },
      "Could not remove a leftover run file",
    );
    return false;
  }
}

/** Modification time in ms, or undefined when the entry cannot be read. */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Every path this process holds, resolved: what its own orphan pass never removes. */
function ownedPaths(): ReadonlySet<string> {
  return new Set(
    [...ownedOutputDirs(), ...ownedInputPaths(), ...ownedExtractionDirs()].map((path) =>
      resolve(path),
    ),
  );
}

/**
 * What the pass may remove, in the order it takes them: uploads first, then
 * output directories — the files that carry what callers sent and what their
 * runs produced —, then extractions. A bounded pass that meets a large stock
 * thus reaches those first.
 */
async function* orphanCandidates(
  root: string,
): AsyncGenerator<{ kind: keyof OrphanPassResult; path: string }> {
  const inputDir = join(root, INPUT_DIR_NAME);
  for (const entry of await entriesOf(inputDir)) {
    yield { kind: "inputFiles", path: join(inputDir, entry.name) };
  }
  const rootEntries = (await entriesOf(root)).filter((entry) => entry.isDirectory());
  for (const entry of rootEntries) {
    if (OUTPUT_DIR_NAME.test(entry.name)) {
      yield { kind: "outputDirs", path: join(root, entry.name) };
    }
  }
  for (const entry of rootEntries) {
    if (EXTRACTION_NAME.test(entry.name)) {
      yield { kind: "bundleDirs", path: join(root, entry.name) };
    }
  }
}

/**
 * Delete what no live process holds under the temp root: output directories,
 * uploaded inputs and bundle extractions — each only once two sweep intervals
 * have passed the time it carries, which no file a live instance holds can
 * reach (each sweep sets it ahead), and never one in `owned`, what this
 * process holds. At most `limit` removals: the rest waits for the next pass.
 * Runs at boot and after every sweep: a file a stopped server left, or a run
 * that failed before registering its directory, goes once it comes of age,
 * with no restart.
 *
 * Asynchronous throughout: a large stock never holds the event loop. `owned`
 * is read when the pass starts; a file this process takes later is one it has
 * just created, or one it registers with a time ahead, and each candidate's
 * time is read just before its removal — so neither is ever old enough.
 *
 * An output directory and an extraction are each recognised by their whole
 * name, as a directory (a link is neither followed nor removed) directly under
 * the root.
 */
export async function removeOrphanedFiles(
  root: string = tmpdir(),
  now: number = Date.now(),
  owned: ReadonlySet<string> = ownedPaths(),
  limit: number = ORPHAN_PASS_MAX_REMOVALS,
): Promise<OrphanPassResult> {
  const removed: OrphanPassResult = { outputDirs: 0, inputFiles: 0, bundleDirs: 0 };
  let total = 0;
  let limitReached = false;
  for await (const { kind, path } of orphanCandidates(root)) {
    if (total >= limit) {
      limitReached = true;
      break;
    }
    if (owned.has(resolve(path))) continue;
    const mtime = await mtimeOf(path);
    if (mtime === undefined || now <= mtime + ORPHAN_MARGIN_MS) continue;
    if (await removeQuietly(path)) {
      removed[kind]++;
      total++;
    }
  }
  if (total > 0) {
    logger.info(
      {
        event: "file_cache_orphans_removed",
        ...removed,
        root,
        ...(limitReached ? { limit_reached: true } : {}),
      },
      "Run files no live process holds removed",
    );
  }
  return removed;
}

/** The pass the timer started and that has not ended yet, if any. */
let passInFlight: Promise<OrphanPassResult> | undefined;

/**
 * The orphan pass the timer started and that is still going, if one is:
 * what a caller awaits to see it end.
 */
export function orphanPassInFlight(): Promise<OrphanPassResult> | undefined {
  return passInFlight;
}

/**
 * Start an orphan pass unless one is still going — two never overlap: a tick
 * that finds one under way leaves it be, and the next tick starts the next
 * pass. A background pass has nobody waiting for an answer: its failure is a
 * log line, never a rejection that would take the process down.
 */
function startOrphanPass(root: string, limit: number): void {
  if (passInFlight) return;
  passInFlight = (async () => {
    // Yield first: the body below then runs only once `passInFlight` holds this
    // pass, so its `finally` always clears it — even when an argument throws.
    await null;
    try {
      return await removeOrphanedFiles(root, Date.now(), ownedPaths(), limit);
    } catch (err) {
      logger.error(
        { event: "file_cache_orphan_pass_failed", ...errorFields(err) },
        "Orphan pass failed",
      );
      return { outputDirs: 0, inputFiles: 0, bundleDirs: 0 };
    } finally {
      passInFlight = undefined;
    }
  })();
}

/**
 * The sweep, then the orphan pass: at once, then at every interval. Returns
 * the timer so a caller can observe or stop it. The timer never keeps the
 * process alive on its own.
 *
 * It returns before the first orphan pass ends: the pass runs in the
 * background, so a stock however large never delays the start. The server
 * entry points call it once the server listens.
 */
export function startFileCacheSweep(
  root: string = tmpdir(),
  maxRemovals: number = ORPHAN_PASS_MAX_REMOVALS,
): NodeJS.Timeout {
  const tick = () => {
    // The expiry sweep is bounded by the caches' sizes and runs at every tick,
    // whether or not an orphan pass is still going.
    try {
      sweepExpiredFiles();
    } catch (err) {
      logger.error(
        { event: "file_cache_sweep_failed", ...errorFields(err) },
        "Expired-file sweep failed",
      );
    }
    startOrphanPass(root, maxRemovals);
  };
  tick();
  const timer = setInterval(tick, FILE_CACHE_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
