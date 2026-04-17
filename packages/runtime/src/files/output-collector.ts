import { existsSync, readdirSync, statSync } from "node:fs";
import { createLogger } from "../logger.js";
import type { FileInfo } from "../types.js";

const logger = createLogger("files");

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export interface CollectOptions {
  maxSizeMB?: number;
  maxCount?: number;
}

/**
 * Scan an output directory and collect file metadata.
 * Enforces size and count limits. Returns sorted FileInfo[].
 */
export function collectOutputFiles(dir: string, options?: CollectOptions): FileInfo[] {
  if (!dir || !existsSync(dir)) return [];

  const maxSizeBytes = (options?.maxSizeMB ?? readEnvInt("FILES_MAX_SIZE_MB", 10)) * 1024 * 1024;
  const maxCount = options?.maxCount ?? readEnvInt("FILES_MAX_COUNT", 20);

  const entries = readdirSync(dir);
  const files: FileInfo[] = [];

  for (const name of entries.sort()) {
    const stat = statSync(`${dir}/${name}`);
    if (!stat.isFile()) continue;

    if (stat.size > maxSizeBytes) {
      logger.warn(
        { event: "file_too_large", file: name, size: stat.size, maxBytes: maxSizeBytes },
        `File "${name}" exceeds size limit (${stat.size} > ${maxSizeBytes}), excluded`,
      );
      continue;
    }

    if (files.length >= maxCount) {
      logger.warn(
        { event: "files_count_exceeded", maxCount, total: entries.length },
        `File count exceeds limit (${entries.length} > ${maxCount}), remaining files excluded`,
      );
      break;
    }

    files.push({ name, size: stat.size });
  }

  return files;
}
