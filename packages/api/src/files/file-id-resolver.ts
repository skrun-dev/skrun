import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { getInputFile } from "../cache/input-cache.js";
import { getOutputFileById } from "../cache/output-cache.js";
import { contentTypeFor } from "./content-types.js";

export interface ResolvedFile {
  source: "input" | "output";
  path: string;
  /**
   * The name a download of the file carries: an output's file name; for an
   * input, its `file_id` (an upload keeps no name of its own).
   */
  name: string;
  metadata: {
    size: number;
    media_type: string;
    purpose: "input" | "output";
    expires_at?: Date;
  };
}

/**
 * Resolve a file_id across input-store and output-cache (unified namespace).
 * Both input-side (uploads) and output-side (run artifacts) share the same
 * `fil_<32 hex>` ID space.
 */
export function resolveFileId(fileId: string): ResolvedFile | null {
  const inputMeta = getInputFile(fileId);
  if (inputMeta) {
    return {
      source: "input",
      path: inputMeta.path,
      name: fileId,
      metadata: {
        size: inputMeta.size,
        media_type: inputMeta.media_type,
        purpose: inputMeta.purpose,
        expires_at: inputMeta.expires_at,
      },
    };
  }

  const outputEntry = getOutputFileById(fileId);
  if (outputEntry) {
    const path = join(outputEntry.dir, outputEntry.filename);
    if (!existsSync(path)) return null;
    // Defense-in-depth: reject symlinks AND any resolved path that escapes
    // the registered output dir (covers symlink chains the collector might
    // miss if the file was registered out-of-band).
    const lstat = lstatSync(path);
    if (lstat.isSymbolicLink()) return null;
    const realPath = realpathSync(path);
    const realDir = realpathSync(outputEntry.dir);
    if (realPath !== realDir && !realPath.startsWith(realDir + sep)) return null;
    return {
      source: "output",
      path,
      name: outputEntry.filename,
      metadata: {
        size: lstat.size,
        media_type: contentTypeFor(outputEntry.filename),
        purpose: "output",
      },
    };
  }

  return null;
}
