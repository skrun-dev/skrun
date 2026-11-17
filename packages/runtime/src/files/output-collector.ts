import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { createLogger } from "../logger.js";
import type { FileInfo } from "../types.js";
import {
  type OutputExclusionCounts,
  outputNameRefusal,
  readOutputLimits,
  selectOutputFiles,
} from "./output-rules.js";

const logger = createLogger("files");

export interface CollectOptions {
  maxSizeMB?: number;
  maxCount?: number;
}

/** The files a local run keeps, and how many it left out, by reason. */
export interface CollectedOutputFiles {
  files: FileInfo[];
  excluded: OutputExclusionCounts;
}

/**
 * Scan an output directory and collect file metadata.
 * Enforces size and count limits. Returns sorted FileInfo[].
 */
export function collectOutputFiles(dir: string, options?: CollectOptions): FileInfo[] {
  return collectOutputFilesWithExclusions(dir, options).files;
}

/**
 * `collectOutputFiles`, and what it left out, counted by reason — the same
 * selection rule the cloud runner applies (`selectOutputFiles`), on the files
 * at the top of the directory.
 */
export function collectOutputFilesWithExclusions(
  dir: string,
  options?: CollectOptions,
): CollectedOutputFiles {
  const none: CollectedOutputFiles = {
    files: [],
    excluded: { name_refused: 0, too_large: 0, over_count: 0 },
  };
  if (!dir || !existsSync(dir)) return none;

  // The environment's limits, through the one reader the cloud upload uses too;
  // an explicit option wins over it.
  const limits = readOutputLimits(process.env);
  const maxSizeBytes =
    options?.maxSizeMB !== undefined ? options.maxSizeMB * 1024 * 1024 : limits.max_size_bytes;
  const maxCount = options?.maxCount ?? limits.max_count;

  const entries = readdirSync(dir);
  const candidates: Array<{ path: string; size: number }> = [];

  for (const name of entries.sort()) {
    // Use lstatSync so symlinks are detected before they are followed. A
    // script-created symlink to /etc/passwd would otherwise be served via
    // the file routes.
    const stat = lstatSync(`${dir}/${name}`);
    if (stat.isSymbolicLink()) {
      logger.warn(
        { event: "symlink_rejected", file: name, dir },
        `File "${name}" is a symbolic link, refused`,
      );
      continue;
    }
    if (!stat.isFile()) continue;
    candidates.push({ path: name, size: stat.size });
  }

  const selection = selectOutputFiles(candidates, {
    max_size_bytes: maxSizeBytes,
    max_count: maxCount,
  });

  for (const { candidate, reason } of selection.exclusions) {
    if (reason === "too_large") {
      const { path: name, size } = candidate;
      logger.warn(
        { event: "file_too_large", file: name, size, maxBytes: maxSizeBytes },
        `File "${name}" exceeds size limit (${size} > ${maxSizeBytes}), excluded`,
      );
    } else if (reason === "name_refused") {
      // Not the name itself: it is refused because it may hold a control
      // character, or run past any reasonable length.
      logger.warn(
        { event: "file_name_refused", refusal: outputNameRefusal(candidate.path) },
        "An output file name is refused by the output name rule, excluded",
      );
    }
  }
  if (selection.excluded.over_count > 0) {
    logger.warn(
      { event: "files_count_exceeded", maxCount, total: entries.length },
      `File count exceeds limit (${entries.length} > ${maxCount}), remaining files excluded`,
    );
  }

  return {
    files: selection.kept.map(({ path: name, size }) => ({
      name,
      size,
      file_id: `fil_${randomUUID().replace(/-/g, "")}`,
    })),
    excluded: selection.excluded,
  };
}
