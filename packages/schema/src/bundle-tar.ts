import { gunzipSync, gzipSync } from "node:zlib";
import { type Headers, extract as tarExtract, pack as tarPack } from "tar-stream";
import { SkrunError } from "./errors.js";

// The single source of truth for the `.agent` bundle wire format (a gzipped ustar
// archive). This module is intentionally **fs-free and env-free** so it stays
// portable (Node today, edge/Workers tomorrow) — callers own the filesystem glue
// (collecting files, writing to disk) and pass any runtime limits explicitly.

const MIB = 1024 * 1024;

/**
 * The most a push's body — the compressed bundle — may weigh on a server whose
 * operator does not set `SKRUN_PUSH_MAX_BODY_MB`, in MB (1 MB = 1,048,576
 * bytes, wherever a bundle is measured). The server reads its setting from it;
 * `skrun build` warns past it.
 */
export const DEFAULT_PUSH_MAX_BODY_MB = 50;

/**
 * The most a bundle may decompress to — its tar stream, headers and padding
 * included — under a `BUNDLE_MAX_DECOMPRESSED_MB` left unset, in MB. The server
 * unpacks under it, `skrun pull` too; `skrun build` warns past it.
 */
export const DEFAULT_MAX_DECOMPRESSED_MB = 50;

/**
 * The most a bundle's `agent.yaml` may weigh, in bytes: 128 KB (1 KB = 1,024
 * bytes). A fixed limit of every server, not a setting — the file holds the
 * agent's configuration, which no model's context makes longer; long content
 * (instructions, context, data) belongs in `SKILL.md`, `AGENTS.md` or other
 * files of the bundle. It also bounds what the `yaml` library spends reading
 * one: some shapes of YAML cost it far more than their size. A push past it
 * is refused, judged on the file's bytes before they are parsed; `skrun build`
 * warns past it.
 */
export const AGENT_YAML_MAX_BYTES = 128 * 1024;

/** A plain decimal number: digits, with or without a fraction. No sign, exponent or base. */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * A size in MB an operator sets, read from the raw value of its variable `name`
 * — the one reading of `BUNDLE_MAX_DECOMPRESSED_MB` and of the server's
 * request-body caps (`SKRUN_PUSH_MAX_BODY_MB`, `SKRUN_MAX_BODY_MB`). Unset
 * (`undefined`), `defaultMb`. Otherwise a plain decimal number, spaces around it
 * ignored, of at least one byte: anything else — the empty string, `0`, a sign,
 * `1e3`, `0x10`, `80MB`, a value under one byte — throws (`INVALID_SETTING`),
 * naming the variable. `Number` alone reads `1e3` and `0x10` as numbers,
 * `parseInt` reads `1e3` as 1, and a cap of zero bytes would refuse everything:
 * a malformed value is not an absent one. The server reads each at startup and
 * refuses to start; `skrun pull` refuses to pull. Env-free: the caller passes
 * the value it read.
 */
export function readMbSetting(raw: string | undefined, name: string, defaultMb: number): number {
  const value = raw ?? String(defaultMb);
  const trimmed = value.trim();
  const mb = DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(mb) || Math.floor(mb * MIB) < 1) {
    throw new SkrunError(
      "INVALID_SETTING",
      `${name} must be a positive decimal number of MB (got "${value}"). Unset it to use the ${defaultMb} MB default.`,
    );
  }
  return mb;
}

/**
 * The decompression cap a value of `BUNDLE_MAX_DECOMPRESSED_MB` sets, in bytes:
 * its MB as `readMbSetting` reads them, floored to whole bytes — `0.5` is
 * 524,288 bytes. Unset, `DEFAULT_MAX_DECOMPRESSED_MB`; malformed, it throws,
 * naming the variable. One reading, for the server and for `skrun pull`.
 */
export function maxDecompressedBytes(raw: string | undefined): number {
  const mb = readMbSetting(raw, "BUNDLE_MAX_DECOMPRESSED_MB", DEFAULT_MAX_DECOMPRESSED_MB);
  return Math.floor(mb * MIB);
}

/**
 * A decompression cap as a refusal tells it, a bundle being known only to
 * decompress to more: rounded down to a tenth of a MB — of a KB under 0.1 MB,
 * to the byte under 0.1 KB —, so that "more than" it stays true, and never
 * reads as nothing: `52428800` is `50 MB`, `524288` is `0.5 MB`, `52428` is
 * `51.1 KB` (1 MB = 1,048,576 bytes, 1 KB = 1,024). One wording, for the
 * server's refusals and for `skrun pull`'s.
 */
export function decompressedCapText(maxBytes: number): string {
  const tenthsDown = (value: number) => Math.floor(value * 10) / 10;
  const mb = tenthsDown(maxBytes / MIB);
  if (mb > 0) return `${mb} MB`;
  const kb = tenthsDown(maxBytes / 1024);
  if (kb > 0) return `${kb} KB`;
  return `${maxBytes} B`;
}

/**
 * The rejection of `unpackAgentTar` for an archive that decompresses to more
 * than the cap its caller sets (`maxBytes`) — the gzip-bomb defense. What is
 * counted is the decompressed tar stream, its headers and padding included,
 * not the sum of the files. The decoder stops at the cap, so the archive's
 * full size is never known: only that it is larger than `maxBytes`.
 *
 * Any other failure to read an archive — not gzip, not a tar, cut short —
 * rejects with the decoder's own error, never this one.
 */
export class BundleDecompressedTooLargeError extends SkrunError {
  /** The cap the archive went past, in bytes. */
  readonly maxBytes: number;

  constructor(maxBytes: number, cause?: unknown) {
    super(
      "BUNDLE_DECOMPRESSED_TOO_LARGE",
      `Decompressed bundle exceeds ${maxBytes} bytes (gzip-bomb defense — raise the cap if this is legitimate).`,
      cause,
    );
    this.name = "BundleDecompressedTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * The longest name an entry's path may hold between two `/`, in bytes:
 * Linux's `NAME_MAX`, the file systems a bundle is written out on where an
 * agent runs — the server's, the cloud sandbox's. Counted in bytes, as Linux
 * counts it, not in characters: 128 `é` are 256 bytes.
 */
export const BUNDLE_ENTRY_NAME_MAX_BYTES = 255;

/**
 * The longest path an entry may have, in bytes, as the archive spells it.
 * Linux's `PATH_MAX` (4,096) counts the directory a bundle is written into
 * too — the run's temporary directory, the sandbox's, the one `skrun pull`
 * runs in —, which the archive does not know: 1,024 leaves it 3 KiB. It is
 * also macOS's `PATH_MAX`, where `skrun pull` may write.
 */
export const BUNDLE_ENTRY_PATH_MAX_BYTES = 1024;

/**
 * The rejection of `unpackAgentTar` for an archive an entry of which cannot be
 * written out where an agent runs — by the server, which extracts it for a
 * run on the local runtime; by `tar`, in the cloud sandbox; by `skrun pull`:
 *  - a path that holds `..` — the sandbox's `tar` refuses it;
 *  - a file with no name, or whose name ends with `/`, a directory's mark;
 *  - a name that holds a NUL character, which no file system takes;
 *  - a path over `BUNDLE_ENTRY_PATH_MAX_BYTES`, or a name over
 *    `BUNDLE_ENTRY_NAME_MAX_BYTES` between two `/`;
 *  - two entries that contradict each other: a file where another entry
 *    needs a directory (`x`, and `x/y`), or one path both a file and a
 *    directory — in either order;
 *  - a character or a block device: `tar`, run without privileges as the
 *    sandbox runs it, cannot make one;
 *  - a hard link with no file to link to — no entry of its target's path
 *    before it in the archive, or only a directory —, which `tar` cannot make
 *    either. A hard link to an earlier file passes, and so does a FIFO.
 * Only `/` separates the names of a path: where an agent runs, on Linux, `\`
 * is a character of a name. Any entry that is not a directory — a file, a
 * link — counts as a file. Two files of one path do not contradict each
 * other: every writer writes the last one. Nor do two paths that differ only
 * by case (`A`, `a`): two files on Linux, one on a disk that ignores case.
 * Its message names the entry, and why; `entry` is the entry's name as the
 * archive spells it.
 */
export class BundleEntryError extends SkrunError {
  /** The entry the message names, as the archive spells it. */
  readonly entry: string;

  constructor(entry: string, message: string) {
    super("BUNDLE_ENTRY_UNWRITABLE", message);
    this.name = "BundleEntryError";
    this.entry = entry;
  }
}

/** An entry's name as a message quotes it: whole up to 80 characters, its start otherwise. */
function quoted(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 60)}…` : name);
}

/** An entry, placed: its clean path as a sort key (`sortKey`). */
interface PlacedEntry {
  key: string;
  name: string;
  directory: boolean;
}

/**
 * A path as every writer reads it: the names between its `/`, the empty ones
 * and `.` left out — `./x//y` is `x/y`.
 */
function cleanPath(name: string): string {
  // Most paths have no empty name and no `.`: they are their own clean path,
  // never split.
  return UNCLEAN.test(name)
    ? name
        .split("/")
        .filter((part) => part !== "" && part !== ".")
        .join("/")
    : name;
}

/**
 * Where `name` would be written, or why it cannot be (`BundleEntryError`),
 * judged on its own: at its clean path (`cleanPath`), the same file for every
 * writer.
 */
function placeEntry(name: string, directory: boolean): PlacedEntry | BundleEntryError {
  const refused = (why: string) => new BundleEntryError(name, `The entry ${quoted(name)} ${why}`);
  if (name.includes("\0")) {
    return refused("holds a NUL character, which no file system takes in a name.");
  }
  const bytes = Buffer.byteLength(name);
  if (bytes > BUNDLE_ENTRY_PATH_MAX_BYTES) {
    return refused(
      `has a path of ${bytes} bytes; an entry's path may have ${BUNDLE_ENTRY_PATH_MAX_BYTES} at most.`,
    );
  }
  if (CLIMBS_OUT.test(name)) {
    return refused(`climbs out of the bundle's directory: its path holds "..".`);
  }
  // A UTF-16 code unit is 3 bytes of UTF-8 at most: a shorter name needs no count.
  for (const [long] of name.matchAll(MAYBE_TOO_LONG)) {
    const longBytes = Buffer.byteLength(long);
    if (longBytes > BUNDLE_ENTRY_NAME_MAX_BYTES) {
      return refused(
        `holds a name of ${longBytes} bytes between two "/"; a file system takes ${BUNDLE_ENTRY_NAME_MAX_BYTES} at most.`,
      );
    }
  }
  const clean = cleanPath(name);
  if (!directory && clean === "") return refused("is a file with no name.");
  if (!directory && name.endsWith("/")) {
    return refused(`is a file whose name ends with "/", a directory's mark.`);
  }
  return { key: sortKey(clean), name, directory };
}

/**
 * A clean path's bytes, each `/` made a NUL — the lowest byte, no name holds
 * one —, read one character per byte: strings compared as such compare as
 * the bytes do, so the paths under a path sort right after it.
 */
function sortKey(path: string): string {
  const bytes = Buffer.from(path);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x2f) bytes[i] = 0;
  return bytes.toString("latin1");
}

/** A `..` between two `/`, or at either end. */
const CLIMBS_OUT = /(?:^|\/)\.\.(?:\/|$)/;
/** A name long enough that its bytes may pass `BUNDLE_ENTRY_NAME_MAX_BYTES`. */
const MAYBE_TOO_LONG = new RegExp(`[^/]{${Math.floor(BUNDLE_ENTRY_NAME_MAX_BYTES / 3) + 1},}`, "g");
/** An empty name or a `.` between two `/`, or at either end. */
const UNCLEAN = /(?:^|\/)\.?(?:\/|$)/;

/**
 * Why an entry cannot be written out for its type, or `undefined`: a device,
 * or a hard link to no file before it — `files` holds the keys (`sortKey`) of
 * the entries before it that are not directories.
 */
function typeRefusal(header: Headers, files: ReadonlySet<string>): BundleEntryError | undefined {
  const refused = (why: string) =>
    new BundleEntryError(header.name, `The entry ${quoted(header.name)} ${why}`);
  if (header.type === "character-device" || header.type === "block-device") {
    const kind = header.type === "character-device" ? "character" : "block";
    return refused(
      `is a ${kind} device: tar cannot make one without privileges, and an agent's bundle is written out without them.`,
    );
  }
  const target = header.linkname ?? "";
  if (header.type === "link" && !files.has(sortKey(cleanPath(target)))) {
    return refused(
      `is a hard link to ${quoted(target)}, and no file of that path comes before it in the bundle: tar cannot make the link.`,
    );
  }
  return undefined;
}

/**
 * The first contradiction between `placed` entries, or `undefined`: a path
 * both a file and a directory, or a file with an entry under it. Judged on
 * the paths' keys sorted, so in one pass whatever their number and depth: the
 * entries under a path sort right after it (`sortKey`). The bundle's own
 * directory (`./`) is left out.
 */
function firstContradiction(placed: PlacedEntry[]): BundleEntryError | undefined {
  const sorted = placed
    .filter((entry) => entry.key !== "")
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let i = 0;
  while (i < sorted.length) {
    const key = sorted[i]?.key;
    let file: PlacedEntry | undefined;
    let directory: PlacedEntry | undefined;
    let j = i;
    for (let entry = sorted[j]; entry && entry.key === key; entry = sorted[++j]) {
      if (entry.directory) directory ??= entry;
      else file ??= entry;
    }
    if (file && directory) {
      return new BundleEntryError(
        file.name,
        `The entries ${quoted(directory.name)} and ${quoted(file.name)} make one path both a directory and a file.`,
      );
    }
    const next = sorted[j];
    if (file && next?.key.startsWith(`${file.key}\0`)) {
      return new BundleEntryError(
        next.name,
        `The entry ${quoted(next.name)} needs ${quoted(file.name)} to be a directory, and the bundle makes it a file.`,
      );
    }
    i = j;
  }
  return undefined;
}

/** How `unpackAgentTar` reads an archive. */
export interface UnpackAgentTarOptions {
  /**
   * The most bytes the archive may decompress to, its tar headers included.
   * Past it, the read rejects with `BundleDecompressedTooLargeError`.
   */
  maxBytes: number;
  /**
   * Which entries to collect, by name. An entry it refuses is read past —
   * never copied out of the decompressed archive, which is held whole while it
   * is read — and left out of the result; the cap still judges the whole
   * archive. Omitted, every entry is collected.
   */
  keep?: (name: string) => boolean;
}

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
      throw new BundleDecompressedTooLargeError(maxBytes, err);
    }
    throw err;
  }
}

/**
 * Read the entries of a gzipped ustar `.agent` bundle into memory — every one,
 * or those `keep` names. The archive is decompressed whole, in one block, before
 * any entry is read. Enforces a caller-supplied decompression cap (gzip-bomb
 * defense): past it, rejects with `BundleDecompressedTooLargeError`. Judges
 * every entry's name and type, those `keep` leaves out included, against the
 * others: an archive one of whose entries cannot be written out rejects with
 * `BundleEntryError` — so the push, a run's extraction and `skrun pull` refuse
 * it alike, before anything is written. Does not touch disk; an absolute name,
 * and where a link points, are no concern of its own — beyond a hard link with
 * no file before it, which cannot be written out —: callers inspect
 * `type`/`linkname` (via `isUnsafeName`) and choose to skip or throw.
 */
export function unpackAgentTar(
  gz: Buffer,
  opts: UnpackAgentTarOptions,
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
    const placed: PlacedEntry[] = [];
    // The entries read so far that are not directories: what a hard link may link to.
    const files = new Set<string>();

    extract.on("entry", (header: Headers, entryStream, next: (error?: unknown) => void) => {
      let place = placeEntry(header.name, header.type === "directory");
      if (!(place instanceof BundleEntryError)) place = typeRefusal(header, files) ?? place;
      if (place instanceof BundleEntryError) {
        reject(place);
        extract.destroy();
        return;
      }
      placed.push(place);
      if (!place.directory) files.add(place.key);
      if (opts.keep && !opts.keep(header.name)) {
        // Read past: the bytes flow through and are dropped, none of them held.
        entryStream.on("end", () => next());
        entryStream.on("error", reject);
        entryStream.resume();
        return;
      }
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
    extract.on("finish", () => {
      const contradiction = firstContradiction(placed);
      if (contradiction) reject(contradiction);
      else resolve(entries);
    });
    extract.on("error", reject);

    extract.end(tar);
  });
}
