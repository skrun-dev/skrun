import { rmSync } from "node:fs";
import { TTLCache } from "@skrun-dev/runtime";

const DEFAULT_RETENTION_S = 86_400; // 24 hours
const MAX_ENTRIES = 10_000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export interface InputFileMetadata {
  path: string;
  size: number;
  media_type: string;
  purpose: "input";
  expires_at: Date;
}

/** Tracks file_id → InputFileMetadata for serving + TTL cleanup of input uploads. */
export const inputCache = new TTLCache<string, InputFileMetadata>({
  ttlMs: readEnvInt("INPUT_FILES_RETENTION_S", DEFAULT_RETENTION_S) * 1000,
  maxEntries: MAX_ENTRIES,
  onEvict: (_key, meta) => {
    try {
      rmSync(meta.path, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  },
});

export function registerInputFile(fileId: string, meta: InputFileMetadata): void {
  inputCache.set(fileId, meta);
}

export function getInputFile(fileId: string): InputFileMetadata | undefined {
  return inputCache.get(fileId);
}

export function deleteInputFile(fileId: string): boolean {
  return inputCache.delete(fileId);
}

export function getInputRetentionSeconds(): number {
  return readEnvInt("INPUT_FILES_RETENTION_S", DEFAULT_RETENTION_S);
}
