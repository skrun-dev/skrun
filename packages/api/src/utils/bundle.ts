import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  isUnsafeName,
  maxDecompressedBytes,
  type UnpackedAgentEntry,
  unpackAgentTar,
} from "@skrun-dev/schema";

/**
 * The decompression cap this server unpacks a bundle under, in bytes, as the
 * readers below read it (gzip-bomb defense: a ~10 KB gzip can decompress to
 * many GB; the codec stops the decoder at the cap and rejects with
 * `BundleDecompressedTooLargeError`). `BUNDLE_MAX_DECOMPRESSED_MB`, read here
 * — Node side, so the codec stays env-free — by the codec's own reading of it,
 * the one `skrun pull` makes too; its default is the codec's
 * `DEFAULT_MAX_DECOMPRESSED_MB`. A malformed value throws, naming the
 * variable: `createApp` reads it once at startup, so a server never starts on
 * one.
 */
export function getMaxDecompressedBytes(): number {
  return maxDecompressedBytes(process.env.BUNDLE_MAX_DECOMPRESSED_MB);
}

/**
 * The files a run reads out of its agent's bundle as text — its instructions,
 * its configuration and its persistent context: all that the run cache keeps
 * of a bundle in memory. Every other file is read from the extraction's
 * directory, on the local runtime, or from the sandbox's own copy of the
 * bundle, on the cloud one; never from memory.
 */
export const MANIFEST_FILES: readonly string[] = ["SKILL.md", "agent.yaml", "AGENTS.md"];

/**
 * An extraction that could not be written out: the bundle unpacked, but a
 * directory or a file of it could not be written — no space left, no
 * permission, or a name this server's filesystem does not take though the
 * codec let it through (one that differs from another only by case, on a disk
 * that ignores case). An archive an entry of which cannot be written out
 * anywhere — two entries that contradict each other, a name too long — never
 * gets here: the codec rejects it first (`BundleEntryError`), before anything
 * is written. It carries the filesystem's code (`ENOSPC`, `EACCES`,
 * `ENOENT`…) as its own — the one thing that tells which —, and never the
 * filesystem's message, which names the path — a file name of the bundle.
 * The original error is its `cause`.
 */
export class BundleWriteError extends Error {
  readonly code: string | undefined;

  constructor(cause: unknown) {
    super("The bundle could not be written out on this server.", { cause });
    this.name = "BundleWriteError";
    const code =
      typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === "string" ? code : undefined;
  }
}

/**
 * Entries that must never be extracted: absolute names, and symlink /
 * hardlink entries. A real tar library honours link entries, so an escaping
 * link could plant a file outside the target dir — we drop them. The API
 * reader SKIPS such entries (hot-path resilience); the CLI reader throws. A
 * name that holds `..` never reaches here: the codec rejects its archive
 * (`BundleEntryError`); `isUnsafeName` still judges it, in depth.
 */
function isSkippable(entry: UnpackedAgentEntry): boolean {
  if (entry.type === "symlink" || entry.type === "link") return true;
  return isUnsafeName(entry.name, entry.linkname);
}

/**
 * Read the BYTES of the named files of a .agent bundle (tar.gz): a map of
 * filename → content, a name left out when the bundle has no such file. The
 * whole archive is decompressed under the cap, in one block, in memory —
 * past it, the read rejects with `BundleDecompressedTooLargeError` — but only
 * the named entries are copied out: every other one is read past. Unsafe / symlink
 * entries are skipped, whatever their name. For a reader that judges a file's
 * size before it reads it as text (the push's `agent.yaml`).
 */
export async function extractFileBytes(
  gzBuffer: Buffer,
  names: readonly string[],
): Promise<Record<string, Buffer>> {
  const wanted = new Set(names);
  const entries = await unpackAgentTar(gzBuffer, {
    maxBytes: getMaxDecompressedBytes(),
    keep: (name) => wanted.has(name),
  });
  const files: Record<string, Buffer> = {};
  for (const entry of entries) {
    if (isSkippable(entry)) continue;
    files[entry.name] = entry.content;
  }
  return files;
}

/**
 * Read the TEXT of the named files of a .agent bundle (tar.gz), as
 * `extractFileBytes` reads their bytes: no other file is held nor converted
 * to text. This is the view for manifest reads (`agent.yaml`, `SKILL.md`,
 * `AGENTS.md`); binary-faithful extraction lives in `extractBundleToDisk`.
 */
export async function extractFiles(
  gzBuffer: Buffer,
  names: readonly string[],
): Promise<Record<string, string>> {
  const bytes = await extractFileBytes(gzBuffer, names);
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(bytes)) files[name] = content.toString("utf-8");
  return files;
}

/**
 * Every extraction is a directory directly under the temp root named this
 * prefix plus a `randomUUID()`. The orphan pass recognises a leftover extraction
 * by that whole name, so the one definition lives here, beside the code that
 * makes the name.
 */
export const BUNDLE_DIR_PREFIX = "skrun-agent-";

/**
 * Extract a .agent bundle to a temporary directory on disk, byte-faithfully
 * (binary assets survive). Returns the temp dir, the TEXT of the bundle's
 * manifests (`MANIFEST_FILES`, those it has — never any other file's), and a
 * cleanup function. A directory entry — the standard `tar` writes one for
 * each directory it packs; `skrun build` writes none — makes its directory.
 * Unsafe / symlink entries are skipped, with a defensive resolve guard so
 * nothing is written outside the target dir.
 * Needed for scripts and MCP stdio servers that must exist on the filesystem.
 *
 * Rejects as `extractFiles` does for a bundle that does not unpack — past the
 * cap, `BundleDecompressedTooLargeError`; an entry that cannot be written
 * out, `BundleEntryError`; otherwise the decoder's own error —, before
 * anything is written; and with `BundleWriteError` when a write fails, the
 * directory written so far removed first.
 */
export async function extractBundleToDisk(gzBuffer: Buffer): Promise<{
  dir: string;
  files: Record<string, string>;
  cleanup: () => void;
}> {
  const entries = await unpackAgentTar(gzBuffer, { maxBytes: getMaxDecompressedBytes() });
  const dir = join(tmpdir(), `${BUNDLE_DIR_PREFIX}${randomUUID()}`);
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  };
  const manifests = new Set(MANIFEST_FILES);
  const files: Record<string, string> = {};

  try {
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
      if (isSkippable(entry)) continue;
      const filePath = join(dir, entry.name);
      // Defence in depth on top of isUnsafeName: never resolve outside the dir.
      if (!resolve(filePath).startsWith(resolve(dir) + sep)) continue;
      if (entry.type === "directory") {
        mkdirSync(filePath, { recursive: true });
        continue;
      }
      const fileDir = dirname(filePath);
      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }
      writeFileSync(filePath, entry.content); // raw bytes — binary-safe
      if (manifests.has(entry.name)) files[entry.name] = entry.content.toString("utf-8");
    }
  } catch (err) {
    cleanup();
    throw new BundleWriteError(err);
  }

  return { dir, files, cleanup };
}
