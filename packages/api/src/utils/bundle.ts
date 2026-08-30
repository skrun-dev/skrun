import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isUnsafeName, type UnpackedAgentEntry, unpackAgentTar } from "@skrun-dev/schema";

/**
 * Maximum decompressed bundle size (gzip-bomb defense). A ~10 KB gzip can
 * decompress to many GB and exhaust memory; the codec caps the decoder at this
 * many bytes and throws once crossed. 50 MB matches the published bundle limit;
 * configurable via `BUNDLE_MAX_DECOMPRESSED_MB` for operators with larger
 * artefacts. Kept here (Node side) so the codec stays env-free.
 */
const DEFAULT_MAX_DECOMPRESSED_MB = 50;

function getMaxDecompressedBytes(): number {
  const raw = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
  const mb = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_DECOMPRESSED_MB;
  return (Number.isNaN(mb) || mb <= 0 ? DEFAULT_MAX_DECOMPRESSED_MB : mb) * 1024 * 1024;
}

/**
 * Entries that must never be extracted: path-traversal / absolute names, and
 * symlink / hardlink entries. A real tar library honours link entries, so an
 * escaping link could plant a file outside the target dir — we drop them. The
 * API reader SKIPS such entries (hot-path resilience); the CLI reader throws.
 */
function isSkippable(entry: UnpackedAgentEntry): boolean {
  if (entry.type === "symlink" || entry.type === "link") return true;
  return isUnsafeName(entry.name, entry.linkname);
}

/**
 * Extract a .agent bundle (tar.gz) into a map of filename → TEXT content.
 * Unsafe / symlink entries are skipped. This is the text view used for manifest
 * reads (SKILL.md, agent.yaml); binary-faithful extraction lives in
 * `extractBundleToDisk`.
 */
export async function extractFiles(gzBuffer: Buffer): Promise<Record<string, string>> {
  const entries = await unpackAgentTar(gzBuffer, { maxBytes: getMaxDecompressedBytes() });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (isSkippable(entry)) continue;
    files[entry.name] = entry.content.toString("utf-8");
  }
  return files;
}

/**
 * Extract a .agent bundle to a temporary directory on disk, byte-faithfully
 * (binary assets survive). Returns the temp dir, a TEXT map (for manifest reads),
 * and a cleanup function. Unsafe / symlink entries are skipped, with a defensive
 * resolve guard so nothing is written outside the target dir.
 * Needed for MCP stdio servers that must exist on the filesystem.
 */
export async function extractBundleToDisk(gzBuffer: Buffer): Promise<{
  dir: string;
  files: Record<string, string>;
  cleanup: () => void;
}> {
  const entries = await unpackAgentTar(gzBuffer, { maxBytes: getMaxDecompressedBytes() });
  const dir = join(tmpdir(), `skrun-agent-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (isSkippable(entry)) continue;
    const filePath = join(dir, entry.name);
    // Defence in depth on top of isUnsafeName: never resolve outside the dir.
    if (!resolve(filePath).startsWith(resolve(dir) + sep)) continue;
    const fileDir = dirname(filePath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }
    writeFileSync(filePath, entry.content); // raw bytes — binary-safe
    files[entry.name] = entry.content.toString("utf-8");
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
