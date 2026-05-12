import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { getInputFile } from "../cache/input-cache.js";
import { getOutputFileById } from "../cache/output-cache.js";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function inferMediaType(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export interface ResolvedFile {
  source: "input" | "output";
  path: string;
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
    const stat = statSync(path);
    return {
      source: "output",
      path,
      metadata: {
        size: stat.size,
        media_type: inferMediaType(outputEntry.filename),
        purpose: "output",
      },
    };
  }

  return null;
}
