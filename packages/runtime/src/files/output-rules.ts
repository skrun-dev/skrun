/**
 * The rules a run's output files are held to — one definition, for every place
 * that applies them.
 *
 * A run's output files are named and sized by the code that wrote them, which
 * is the agent's. They are judged in several places: by the local engine when
 * it collects them, by the cloud runner when it lists them, by the harness when
 * it pulls them from the runner and turns their names into storage keys, and
 * by the API when it deletes those objects or presigns a link to one. A rule
 * written in each of those places drifts; written here, once, it cannot.
 *
 * A leaf module, on purpose: it is exported by the runner's slim entry point,
 * which must never load the model router or its SDKs.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolResult } from "../tools/types.js";

const MIB = 1024 * 1024;

/** The largest size limit a reader produces or a runner accepts: 1 GiB. */
export const OUTPUT_MAX_SIZE_BYTES_LIMIT = 1024 * MIB;

/** The largest count limit a reader produces or a runner accepts. */
export const OUTPUT_MAX_COUNT_LIMIT = 10_000;

/**
 * The two limits on a run's output files, in the form they travel in: the
 * largest size of one file, in bytes, and the most files a run keeps. Whole
 * numbers, at least 1, at most the bounds above.
 */
export const OutputLimitsSchema = z.object({
  max_size_bytes: z.number().int().min(1).max(OUTPUT_MAX_SIZE_BYTES_LIMIT),
  max_count: z.number().int().min(1).max(OUTPUT_MAX_COUNT_LIMIT),
});

export type OutputLimits = z.infer<typeof OutputLimitsSchema>;

/** The limits when nothing sets them: 10 MiB per file, 20 files. */
export const DEFAULT_OUTPUT_LIMITS: Readonly<OutputLimits> = Object.freeze({
  max_size_bytes: 10 * MIB,
  max_count: 20,
});

function readPositiveInt(raw: string | undefined, fallback: number, bound: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, bound);
}

/**
 * The output file limits an environment sets — `FILES_MAX_SIZE_MB` (in MiB)
 * and `FILES_MAX_COUNT` — the one reader, for the local engine and the cloud
 * upload alike. A value that is absent, unreadable, zero or negative gives the
 * default; a value past a bound gives the bound, so that what this reads is
 * always something `OutputLimitsSchema` accepts.
 */
export function readOutputLimits(env: Readonly<Record<string, string | undefined>>): OutputLimits {
  const sizeMib = readPositiveInt(
    env.FILES_MAX_SIZE_MB,
    DEFAULT_OUTPUT_LIMITS.max_size_bytes / MIB,
    OUTPUT_MAX_SIZE_BYTES_LIMIT / MIB,
  );
  return {
    max_size_bytes: sizeMib * MIB,
    max_count: readPositiveInt(
      env.FILES_MAX_COUNT,
      DEFAULT_OUTPUT_LIMITS.max_count,
      OUTPUT_MAX_COUNT_LIMIT,
    ),
  };
}

/**
 * The longest output file name, in bytes of UTF-8. A name becomes the end of a
 * storage key, after the run's prefix (`runOutputKey`), and an S3-compatible
 * store holds keys of at most 1,024 bytes: past that, the write fails, and the
 * run with it. Half of it leaves room for the prefix.
 */
export const OUTPUT_NAME_MAX_BYTES = 512;

/** Why a name from a run's file list is refused. */
export type OutputNameRefusal =
  | "not_a_string"
  | "empty"
  | "too_long"
  | "control_char"
  | "lone_surrogate"
  | "backslash"
  | "absolute"
  | "empty_segment"
  | "dot_segment";

/** U+0000 to U+001F, and U+007F. */
function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether `name` holds a lone surrogate: half of a UTF-16 pair without its
 * other half — a high one (U+D800 to U+DBFF) not followed by a low one
 * (U+DC00 to U+DFFF), or a low one not preceded by a high one. Such a string
 * is no text: no URL encodes it (`encodeURIComponent` throws on it), no storage
 * key holds it, and Postgres refuses it in `jsonb`.
 */
function hasLoneSurrogate(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = name.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Why `name` is refused, or `null` when it is a plain relative path of at most
 * `OUTPUT_NAME_MAX_BYTES`, with no control character and no lone surrogate —
 * the one definition of the rule, which `isSafeOutputName` states as a yes or
 * no.
 */
export function outputNameRefusal(name: unknown): OutputNameRefusal | null {
  if (typeof name !== "string") return "not_a_string";
  if (name === "") return "empty";
  if (Buffer.byteLength(name, "utf8") > OUTPUT_NAME_MAX_BYTES) return "too_long";
  if (hasControlChar(name)) return "control_char";
  if (hasLoneSurrogate(name)) return "lone_surrogate";
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/")) return "absolute";
  for (const segment of name.split("/")) {
    if (segment === "") return "empty_segment";
    if (segment === "." || segment === "..") return "dot_segment";
  }
  return null;
}

/** Whether `name` passes the output name rule. */
export function isSafeOutputName(name: unknown): name is string {
  return outputNameRefusal(name) === null;
}

/**
 * Why the selection leaves a file out — one reason per file, in the order a
 * candidate is examined: its name, then its size, then whether the count is
 * already reached.
 */
export const OUTPUT_EXCLUSION_REASONS = ["name_refused", "too_large", "over_count"] as const;

export type OutputExclusionReason = (typeof OUTPUT_EXCLUSION_REASONS)[number];

/** How many files the selection left out, by reason. */
export type OutputExclusionCounts = Record<OutputExclusionReason, number>;

/**
 * Counts by reason as a run's caller is told them: each reason that left at
 * least one file out, in the order given — `{}` when none did.
 */
export function reportedExclusions<R extends string>(
  counts: Readonly<Record<R, number>>,
): Partial<Record<R, number>> {
  const reported: Partial<Record<R, number>> = {};
  for (const reason of Object.keys(counts) as R[]) {
    if (counts[reason] > 0) reported[reason] = counts[reason];
  }
  return reported;
}

/** What the selection needs of a file: its path, relative to the outputs root, and its size. */
export interface OutputCandidate {
  path: string;
  size: number;
}

/** A file the selection left out: the candidate, its position in the input, and why. */
export interface OutputExclusion<T extends OutputCandidate> {
  candidate: T;
  index: number;
  reason: OutputExclusionReason;
}

/** What the selection keeps, sorted by path, and what it leaves out. */
export interface OutputSelection<T extends OutputCandidate> {
  kept: T[];
  excluded: OutputExclusionCounts;
  exclusions: OutputExclusion<T>[];
}

/** The order the local collector has always listed files in: by UTF-16 code unit, as `sort()` does. */
function byPath(a: OutputCandidate, b: OutputCandidate): number {
  if (a.path < b.path) return -1;
  return a.path > b.path ? 1 : 0;
}

/**
 * The one selection rule for a run's output files, applied wherever they are
 * listed — by the local engine, by the cloud runner, and again by the harness
 * on what a runner reports.
 *
 * The candidates are examined in path order. A name the output name rule
 * refuses is left out; then a file larger than `max_size_bytes`; neither takes
 * a place in the count. The first `max_count` files left are kept, and every
 * one after them is left out. Each file left out is counted once, under one
 * reason: a file too large is `too_large` wherever it falls, past the count
 * included. What is kept is what the local collector has always kept; only
 * what it counts of the rest is new.
 */
export function selectOutputFiles<T extends OutputCandidate>(
  candidates: readonly T[],
  limits: OutputLimits,
): OutputSelection<T> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => byPath(a.candidate, b.candidate));
  const kept: T[] = [];
  const excluded: OutputExclusionCounts = { name_refused: 0, too_large: 0, over_count: 0 };
  const exclusions: OutputExclusion<T>[] = [];
  for (const { candidate, index } of ordered) {
    let reason: OutputExclusionReason | null = null;
    if (!isSafeOutputName(candidate.path)) reason = "name_refused";
    else if (candidate.size > limits.max_size_bytes) reason = "too_large";
    else if (kept.length >= limits.max_count) reason = "over_count";
    if (reason === null) {
      kept.push(candidate);
      continue;
    }
    excluded[reason]++;
    exclusions.push({ candidate, index, reason });
  }
  return { kept, excluded, exclusions };
}

/**
 * Every regular file under `root`, at any depth, with its path relative to the
 * root — forward slashes, whatever the platform — and its size. A symbolic
 * link is neither a file nor a directory here: it is left out, and a link to a
 * directory is not followed. A root that does not exist lists nothing — the
 * run wrote no file.
 */
export async function walkOutputFiles(root: string): Promise<OutputCandidate[]> {
  const files: OutputCandidate[] = [];
  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        // `lstat`, never `stat`: a file swapped for a link since the listing
        // is not followed, and is left out like any other link.
        const s = await lstat(abs);
        if (s.isFile()) files.push({ path: rel, size: s.size });
      }
    }
  }
  await walk(root, "");
  return files;
}

/**
 * Refuses `rel`, a path under `root`, when it goes through a symbolic link at
 * any level: the root itself, each directory on the way, and the last
 * component are `lstat`ed in turn — never followed —, and a link is refused
 * wherever it points, as the walk leaves links out. A component that is not
 * there ends the check: it is no link, and the read that follows fails on it.
 * `rel` is taken as it is, its separators either slash; resolving it, and
 * refusing one that leaves the root, is the caller's, first.
 */
export async function assertNoLinkInPath(root: string, rel: string): Promise<void> {
  const parts = rel.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  let at = root;
  for (let depth = 0; depth <= parts.length; depth++) {
    if (depth > 0) at = join(at, parts[depth - 1] as string);
    let isLink: boolean;
    try {
      isLink = (await lstat(at)).isSymbolicLink();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw err;
    }
    if (isLink) throw new Error(`path "${rel}" goes through a symbolic link`);
  }
}

/**
 * The files under `root` the selection rule keeps, and what it leaves out —
 * the walk, then `selectOutputFiles`, in one call: what a runner answers a
 * collect request with.
 */
export async function walkAndSelectOutputFiles(
  root: string,
  limits: OutputLimits,
): Promise<OutputSelection<OutputCandidate>> {
  return selectOutputFiles(await walkOutputFiles(root), limits);
}

/**
 * The body of a collect request: the limits the runner applies. An empty
 * body, or a limit left out, takes the default; anything else that is not a
 * whole number within the bounds is refused.
 */
export const CollectRequestSchema = z
  .object({
    max_size_bytes: OutputLimitsSchema.shape.max_size_bytes.default(
      DEFAULT_OUTPUT_LIMITS.max_size_bytes,
    ),
    max_count: OutputLimitsSchema.shape.max_count.default(DEFAULT_OUTPUT_LIMITS.max_count),
  })
  .prefault({});

const excludedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);

/**
 * The answer to a collect request: the files kept, each with its path, size and
 * type, and the files left out, counted by reason. The counts are optional: a
 * runner from before them answers the list alone.
 */
export const CollectResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      mimeType: z.string(),
    }),
  ),
  excluded: z
    .object({
      name_refused: excludedCount,
      too_large: excludedCount,
      over_count: excludedCount,
    })
    .optional(),
});

export type CollectResponse = z.infer<typeof CollectResponseSchema>;

/**
 * What a runner serves for one output file: nothing to stream, a byte range to
 * stream (`end` included, the form `createReadStream` takes), or a refusal.
 */
export type OutputFileReadRange =
  | { kind: "empty" }
  | { kind: "range"; start: 0; end: number }
  | { kind: "too_large" };

/**
 * The bytes a runner serves for an output file listed at `size`, under a size
 * limit of `maxBytes`: never past the limit — a larger file is refused — and
 * never past the listed size, so a file that grew since it was listed is cut
 * where it was listed. An empty file is nothing to stream: the range a stream
 * would take for it, `end: -1`, is an error, not an empty read.
 */
export function outputFileReadRange(size: number, maxBytes: number): OutputFileReadRange {
  if (size > maxBytes) return { kind: "too_large" };
  if (size === 0) return { kind: "empty" };
  return { kind: "range", start: 0, end: size - 1 };
}

/** The most a tool's answer may weigh, in bytes of UTF-8 of its JSON, envelope included: 1 MiB. */
export const TOOL_RESPONSE_MAX_BYTES = 1_048_576;

/**
 * A number of bytes as a text says it: whole MiB or KiB when it is a whole
 * number of them, bytes otherwise — `1 MiB`, `64 KiB`, `1000 bytes`. A text that
 * names a bound says it through this, from the bound's constant: written out,
 * it would keep naming the old bound once the constant changed.
 */
export function describeBytes(bytes: number): string {
  const MIB = 1024 * 1024;
  if (bytes >= MIB && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/** What the model reads at the end of a tool result that was cut: it names the bound. */
export const TOOL_RESULT_TRUNCATION_MARKER = `\n\n[Result truncated: it was larger than ${describeBytes(TOOL_RESPONSE_MAX_BYTES)}. Only the beginning is shown.]`;

/** Bytes of UTF-8 of the JSON a runner answers a tool call with. */
function answerBytes(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

/** `content` cut at `end`, moved back one unit when that would split a surrogate pair. */
function prefixOnBoundary(content: string, end: number): string {
  const before = content.charCodeAt(end - 1);
  const at = content.charCodeAt(end);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
  return content.slice(0, splitsPair ? end - 1 : end);
}

/**
 * A tool result whose answer fits `TOOL_RESPONSE_MAX_BYTES`, counted as the
 * runner sends it — UTF-8 bytes of the JSON, envelope and escapes included.
 * A result that fits is returned as it is. One that does not keeps the longest
 * beginning of its content that fits with the marker after it, cut between two
 * characters, never inside one; an error result stays an error. The model reads
 * the marker, and knows it did not see everything.
 */
export function truncateToolResult(result: ToolResult): ToolResult {
  if (answerBytes(result) <= TOOL_RESPONSE_MAX_BYTES) return result;
  const { content, isError } = result;
  const withPrefix = (end: number): ToolResult => ({
    content: prefixOnBoundary(content, end) + TOOL_RESULT_TRUNCATION_MARKER,
    isError,
  });
  // The serialised size only grows with the prefix, so the longest prefix that
  // fits is found by bisection. Every character weighs at least one byte: no
  // prefix longer than the bound can fit.
  let fits = 0;
  let tooLong = Math.min(content.length, TOOL_RESPONSE_MAX_BYTES) + 1;
  while (tooLong - fits > 1) {
    const mid = Math.floor((fits + tooLong) / 2);
    if (answerBytes(withPrefix(mid)) <= TOOL_RESPONSE_MAX_BYTES) fits = mid;
    else tooLong = mid;
  }
  return withPrefix(fits);
}
