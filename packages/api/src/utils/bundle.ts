import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Maximum decompressed bundle size. `gunzipSync` has no implicit cap, so a
 * ~10 KB gzip can decompress to many GB and exhaust server memory
 * (gzip-bomb DoS). The `maxOutputLength` option (Node 16.5+) makes the
 * decoder throw a `RangeError` once the threshold is crossed — bytes
 * already produced are bounded by the cap, no extra buffering on top.
 *
 * 50 MB matches the current published bundle limit; configurable via
 * `BUNDLE_MAX_DECOMPRESSED_MB` for operators with larger artefacts.
 */
const DEFAULT_MAX_DECOMPRESSED_MB = 50;

function getMaxDecompressedBytes(): number {
  const raw = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
  const mb = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_DECOMPRESSED_MB;
  return (Number.isNaN(mb) || mb <= 0 ? DEFAULT_MAX_DECOMPRESSED_MB : mb) * 1024 * 1024;
}

function safeGunzip(gzBuffer: Buffer): Buffer {
  const max = getMaxDecompressedBytes();
  try {
    return gunzipSync(gzBuffer, { maxOutputLength: max });
  } catch (err) {
    // Node throws `RangeError` with code 'ERR_BUFFER_TOO_LARGE' when
    // maxOutputLength is exceeded. Re-throw with a clearer message so the
    // route handler can surface a typed 400 instead of an opaque crash.
    const errno = (err as NodeJS.ErrnoException).code;
    if (
      errno === "ERR_BUFFER_TOO_LARGE" ||
      (err instanceof RangeError && /maxOutputLength|too large/i.test(err.message))
    ) {
      throw new Error(
        `Decompressed bundle exceeds ${max} bytes (gzip-bomb defense — set BUNDLE_MAX_DECOMPRESSED_MB to raise the cap).`,
      );
    }
    throw err;
  }
}

/**
 * Extract files from a .agent bundle (tar.gz).
 * Returns a map of filename → content as string.
 * Skips entries with path traversal (e.g., "../") or absolute paths.
 */
export function extractFiles(gzBuffer: Buffer): Record<string, string> {
  const tarBuffer = safeGunzip(gzBuffer);
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
    // Verify the resolved path stays within the target directory
    if (!resolve(filePath).startsWith(resolve(dir) + sep)) {
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
