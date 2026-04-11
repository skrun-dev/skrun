import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Extract files from a .agent bundle (tar.gz).
 * Returns a map of filename → content as string.
 * Skips entries with path traversal (e.g., "../") or absolute paths.
 */
export function extractFiles(gzBuffer: Buffer): Record<string, string> {
  const tarBuffer = gunzipSync(gzBuffer);
  const files: Record<string, string> = {};
  let offset = 0;

  while (offset < tarBuffer.length - 512) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    // Check for end-of-archive
    if (header.every((b) => b === 0)) break;

    // Extract filename
    const nameEnd = header.indexOf(0);
    const fileName = header.subarray(0, Math.min(nameEnd, 100)).toString("utf-8");

    // Extract size (octal, bytes 124-135)
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    // Read content
    const content = tarBuffer.subarray(offset, offset + size);

    // Skip entries with path traversal or absolute paths
    if (!fileName.startsWith("/") && !fileName.includes("..")) {
      files[fileName] = content.toString("utf-8");
    }

    // Skip to next 512-byte boundary
    const padding = (512 - (size % 512)) % 512;
    offset += size + padding;
  }

  return files;
}

/**
 * Extract a .agent bundle to a temporary directory on disk.
 * Returns the temp directory path and a cleanup function.
 * Needed for MCP stdio servers that must exist on the filesystem.
 */
export function extractBundleToDisk(gzBuffer: Buffer): {
  dir: string;
  files: Record<string, string>;
  cleanup: () => void;
} {
  const files = extractFiles(gzBuffer);
  const dir = join(tmpdir(), `skrun-agent-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    // Verify the resolved path is still within the target directory
    if (!filePath.startsWith(dir)) {
      continue;
    }
    const fileDir = dirname(filePath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }
    writeFileSync(filePath, content, "utf-8");
  }

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  };

  return { dir, files, cleanup };
}
