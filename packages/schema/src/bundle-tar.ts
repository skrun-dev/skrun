import { gunzipSync, gzipSync } from "node:zlib";
import { type Headers, extract as tarExtract, pack as tarPack } from "tar-stream";

// The single source of truth for the `.agent` bundle wire format (a gzipped ustar
// archive). This module is intentionally **fs-free and env-free** so it stays
// portable (Node today, edge/Workers tomorrow) — callers own the filesystem glue
// (collecting files, writing to disk) and pass any runtime limits explicitly.

/** A file entry to pack into a `.agent` bundle. */
export interface AgentTarEntry {
  name: string;
  content: Buffer;
}

/** A raw entry read out of a `.agent` bundle, content collected in memory. */
export interface UnpackedAgentEntry {
  name: string;
  /** tar entry type — `"file"`, `"symlink"`, `"directory"`, `"link"`, … */
  type: string;
  /** Present for symlink / hardlink entries. */
  linkname?: string;
  content: Buffer;
}

// Names/uid/gid/mode/mtime are pinned so identical inputs produce byte-identical
// bundles — required for a stable integrity hash over the bundle bytes.
const PINNED_MTIME = new Date(0);
const PINNED_MODE = 0o644;

/** Directory / file names never included in a bundle. */
export const AGENT_BUNDLE_EXCLUDES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".env",
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv",
]);

/**
 * True if a single path segment (a file or directory name) must be excluded from
 * a bundle: an explicit exclude, any dotfile, a `*.secret` file, or a built
 * `*.agent` bundle (a build artifact — never ship a prior build's output).
 */
export function isExcludedEntry(name: string): boolean {
  if (AGENT_BUNDLE_EXCLUDES.has(name)) return true;
  if (name.startsWith(".") && name !== ".") return true;
  if (name.endsWith(".secret")) return true;
  if (name.endsWith(".agent")) return true;
  return false;
}

function pathEscapes(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\")) return true; // absolute (posix / unc)
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // windows drive-absolute
  return p.split(/[\\/]/).includes(".."); // any parent-dir traversal segment
}

/**
 * True if a bundle entry is unsafe to extract: an absolute or parent-traversing
 * name, or a symlink whose target escapes. Pure string analysis — callers decide
 * the reaction (skip vs throw) and keep their own on-disk resolve guard.
 */
export function isUnsafeName(name: string, linkname?: string | null): boolean {
  return pathEscapes(name) || (linkname != null && pathEscapes(linkname));
}

/**
 * Pack file entries into a deterministic gzipped ustar `.agent` bundle. Entry
 * names are normalised to POSIX separators; mtime/uid/gid/mode are pinned.
 */
export function packAgentTar(entries: AgentTarEntry[]): Promise<Buffer> {
  const pack = tarPack();
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });

  for (const { name, content } of entries) {
    const header: Headers = {
      name: name.split(/[\\/]/).join("/"),
      size: content.length,
      mtime: PINNED_MTIME,
      mode: PINNED_MODE,
      uid: 0,
      gid: 0,
      type: "file",
    };
    pack.entry(header, content);
  }
  pack.finalize();

  return collected.then((tar) => gzipSync(tar));
}

function safeGunzip(gz: Buffer, maxBytes: number): Buffer {
  try {
    return gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ERR_BUFFER_TOO_LARGE" ||
      (err instanceof RangeError && /maxOutputLength|too large/i.test(err.message))
    ) {
      throw new Error(
        `Decompressed bundle exceeds ${maxBytes} bytes (gzip-bomb defense — raise the cap if this is legitimate).`,
      );
    }
    throw err;
  }
}

/**
 * Read every entry out of a gzipped ustar `.agent` bundle into memory. Enforces a
 * caller-supplied decompression cap (gzip-bomb defense). Does not touch disk and
 * applies no path policy — callers inspect `type`/`linkname` (via `isUnsafeName`)
 * and choose to skip or throw.
 */
export function unpackAgentTar(
  gz: Buffer,
  opts: { maxBytes: number },
): Promise<UnpackedAgentEntry[]> {
  return new Promise((resolve, reject) => {
    // Decompress inside the executor so a gzip-bomb rejects the promise rather
    // than throwing synchronously at the call site.
    let tar: Buffer;
    try {
      tar = safeGunzip(gz, opts.maxBytes);
    } catch (err) {
      reject(err);
      return;
    }
    const extract = tarExtract();
    const entries: UnpackedAgentEntry[] = [];

    extract.on("entry", (header: Headers, entryStream, next: (error?: unknown) => void) => {
      const parts: Buffer[] = [];
      entryStream.on("data", (c: Buffer) => parts.push(c));
      entryStream.on("end", () => {
        entries.push({
          name: header.name,
          type: header.type ?? "file",
          linkname: header.linkname ?? undefined,
          content: Buffer.concat(parts),
        });
        next();
      });
      entryStream.on("error", reject);
    });
    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);

    extract.end(tar);
  });
}
