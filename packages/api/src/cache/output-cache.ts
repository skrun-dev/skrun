import { rmSync } from "node:fs";
import type { FileInfo } from "@skrun-dev/runtime";
import { TTLCache } from "@skrun-dev/runtime";
import { setRemovableAfter } from "./removable-after.js";

const DEFAULT_RETENTION_S = 3600; // 1 hour

/**
 * The longest window `FILES_RETENTION_S` can set: a hundred years of 365 days.
 * A deadline is written as an ISO date with a four-digit year, and a hundred
 * years keep it far from both limits of that form: past year 9999 the string
 * grows a sign and two more digits — a store that compares deadlines as text
 * would find it already due — and past about year 275760 it is no date at all.
 * A margin, not the breaking point. A larger value is read as this one.
 */
export const FILES_RETENTION_MAX_S = 100 * 365 * 86_400;

/** Per-run output directories live under the temp root as `<prefix><runId>`. */
export const OUTPUT_DIR_PREFIX = "skrun-outputs-";

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * How long a run's output files are kept, in seconds (`FILES_RETENTION_S`).
 *
 * One definition, two readers: the local output cache below, which reads it
 * once when it is built, and the deadline written when a cloud run completes
 * for the copies that run left in object storage, read at each completion —
 * the value in force when a run ends is the one that run keeps. The window is
 * a published deletion bound: a second reading of the variable elsewhere would
 * be a second place for it to drift. At most `FILES_RETENTION_MAX_S`.
 */
export function filesRetentionSeconds(): number {
  return Math.min(readEnvInt("FILES_RETENTION_S", DEFAULT_RETENTION_S), FILES_RETENTION_MAX_S);
}

interface OutputFileIndexEntry {
  run_id: string;
  filename: string;
}

/** Reverse index: file_id → {run_id, filename}. Populated when a run completes. */
const outputFileIdIndex = new Map<string, OutputFileIndexEntry>();

/** The cache's window, read once when it is built: what a deadline counts. */
const OUTPUT_WINDOW_MS = filesRetentionSeconds() * 1000;

/** The output directories in the cache below, each with its deadline. */
const registeredOutputDeadlines = new Map<string, number>();

/** Tracks run_id → outputDir for file serving + TTL cleanup. */
export const outputCache = new TTLCache<string, string>({
  ttlMs: OUTPUT_WINDOW_MS,
  maxEntries: 1000,
  onEvict: (runId, dir) => {
    registeredOutputDeadlines.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    // The run's file_ids leave the reverse index with it, whatever evicted it
    // (a delete, a sweep, an expired read, the LRU bound): otherwise the index
    // only ever grows. The cache's key is the run_id.
    for (const [fileId, entry] of outputFileIdIndex) {
      if (entry.run_id === runId) outputFileIdIndex.delete(fileId);
    }
  },
});

/**
 * Output directories of runs still in flight on this process, with how many
 * holds each has. A run creates its directory when it starts, and the cache
 * learns of it only when the run completes: until then, this is the only
 * record that the directory is alive.
 */
const heldOutputDirs = new Map<string, number>();

/**
 * Mark a run's output directory alive until the hold is released, which the
 * run does when it ends. A held directory has no deadline yet: it carries now
 * plus the window, set here and again at every sweep, so the orphan pass of an
 * instance sharing the temp root never reaches it, however long the run lasts.
 * `release` is idempotent.
 */
export function holdOutputDir(dir: string): { release(): void } {
  heldOutputDirs.set(dir, (heldOutputDirs.get(dir) ?? 0) + 1);
  setRemovableAfter(dir, Date.now() + OUTPUT_WINDOW_MS);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const left = (heldOutputDirs.get(dir) ?? 1) - 1;
      if (left > 0) heldOutputDirs.set(dir, left);
      else heldOutputDirs.delete(dir);
    },
  };
}

/**
 * Every output directory this process holds: those of runs in flight, and
 * those registered in the cache. The orphan pass never removes one.
 */
export function ownedOutputDirs(): string[] {
  return [...new Set([...heldOutputDirs.keys(), ...registeredOutputDeadlines.keys()])];
}

/**
 * Set again the time every output directory this process holds carries: a
 * registered one its deadline, never later — a file written into it since may
 * have moved it; a held one now plus the window. Returns how many.
 */
export function touchOwnedOutputDirs(now: number = Date.now()): number {
  const dirs = ownedOutputDirs();
  for (const dir of dirs) {
    const deadline = registeredOutputDeadlines.get(dir) ?? 0;
    const held = heldOutputDirs.has(dir) ? now + OUTPUT_WINDOW_MS : 0;
    setRemovableAfter(dir, Math.max(deadline, held));
  }
  return dirs.length;
}

/** How many holds on output directories this process has right now. */
export function outputDirHolds(): number {
  let holds = 0;
  for (const count of heldOutputDirs.values()) holds += count;
  return holds;
}

/**
 * Register a completed run's output directory. Its expiry counts from now, and
 * it carries its deadline — now plus the window — as its modification time:
 * left behind by a stopped server, it goes two to three sweeps past that
 * deadline, counted from its creation.
 */
export function registerOutput(runId: string, dir: string, files?: FileInfo[]): void {
  outputCache.set(runId, dir);
  const deadline = Date.now() + OUTPUT_WINDOW_MS;
  registeredOutputDeadlines.set(dir, deadline);
  setRemovableAfter(dir, deadline);
  if (files) {
    for (const f of files) {
      if (f.file_id) {
        outputFileIdIndex.set(f.file_id, { run_id: runId, filename: f.name });
      }
    }
  }
}

export function getOutputDir(runId: string): string | undefined {
  return outputCache.get(runId);
}

export function getOutputFileById(fileId: string): { dir: string; filename: string } | undefined {
  const entry = outputFileIdIndex.get(fileId);
  if (!entry) return undefined;
  const dir = outputCache.get(entry.run_id);
  if (!dir) {
    // run_id was evicted from the cache — drop dangling index entry.
    outputFileIdIndex.delete(fileId);
    return undefined;
  }
  return { dir, filename: entry.filename };
}

/**
 * id of the run that produced this output file_id. Routes use it to look
 * up `runs.user_id` and refuse cross-tenant reads. Returns undefined when
 * the file_id has no output entry (input file_ids return undefined too).
 */
export function getOutputRunId(fileId: string): string | undefined {
  return outputFileIdIndex.get(fileId)?.run_id;
}

/** For tests only — clear all output state. */
export function _clearOutputCacheForTests(): void {
  outputCache.clear();
  outputFileIdIndex.clear();
}
