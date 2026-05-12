import { rmSync } from "node:fs";
import type { FileInfo } from "@skrun-dev/runtime";
import { TTLCache } from "@skrun-dev/runtime";

const DEFAULT_RETENTION_S = 3600; // 1 hour

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

interface OutputFileIndexEntry {
  run_id: string;
  filename: string;
}

/** Reverse index: file_id → {run_id, filename}. Populated when a run completes. */
const outputFileIdIndex = new Map<string, OutputFileIndexEntry>();

/** Tracks run_id → outputDir for file serving + TTL cleanup. */
export const outputCache = new TTLCache<string, string>({
  ttlMs: readEnvInt("FILES_RETENTION_S", DEFAULT_RETENTION_S) * 1000,
  maxEntries: 1000,
  onEvict: (_key, dir) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    // Also drop any output file_ids associated with this run from the reverse index.
    // (We don't have a back-pointer from dir to run_id here; entries are best-effort
    // GC'd when the cache evicts. The lookup-side `getOutputFileById` handles
    // dangling entries gracefully when the dir no longer exists.)
  },
});

export function registerOutput(runId: string, dir: string, files?: FileInfo[]): void {
  outputCache.set(runId, dir);
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

/** For tests only — clear all output state. */
export function _clearOutputCacheForTests(): void {
  outputCache.clear();
  outputFileIdIndex.clear();
}
