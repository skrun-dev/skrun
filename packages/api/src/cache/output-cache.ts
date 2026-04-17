import { rmSync } from "node:fs";
import { TTLCache } from "@skrun-dev/runtime";

const DEFAULT_RETENTION_S = 3600; // 1 hour

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

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
  },
});

export function registerOutput(runId: string, dir: string): void {
  outputCache.set(runId, dir);
}

export function getOutputDir(runId: string): string | undefined {
  return outputCache.get(runId);
}
