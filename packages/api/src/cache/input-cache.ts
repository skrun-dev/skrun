import { rmSync } from "node:fs";
import { TTLCache } from "@skrun-dev/runtime";
import { setRemovableAfter } from "./removable-after.js";

const DEFAULT_RETENTION_S = 86_400; // 24 hours
const MAX_ENTRIES = 10_000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * The longest window `INPUT_FILES_RETENTION_S` can set: a hundred years of 365
 * days. An upload's deadline is handed back as an ISO date with a four-digit
 * year, and a hundred years keep it far from both limits of that form: past
 * year 9999 the string grows a sign and two more digits, and past about year
 * 275760 it is no date at all — the upload would fail. A margin, not the
 * breaking point. A larger value is read as this one.
 */
const INPUT_FILES_RETENTION_MAX_S = 100 * 365 * 86_400;

/**
 * How long an uploaded input file is kept, in seconds (`INPUT_FILES_RETENTION_S`).
 * One definition, two readers: the cache below, which reads it once when it is
 * built, and the deadline an upload is given, read at each upload. At most
 * `INPUT_FILES_RETENTION_MAX_S`.
 */
export function getInputRetentionSeconds(): number {
  return Math.min(
    readEnvInt("INPUT_FILES_RETENTION_S", DEFAULT_RETENTION_S),
    INPUT_FILES_RETENTION_MAX_S,
  );
}

export interface InputFileMetadata {
  path: string;
  size: number;
  media_type: string;
  purpose: "input";
  expires_at: Date;
  /**
   * id of the user who uploaded the file via POST /api/files. Read by the
   * GET /files/:id and /content routes to refuse cross-tenant reads.
   */
  owner_id: string;
  /**
   * id of the API key that made the upload, or null for a session or the dev
   * token. A key that is not full-access reads, deletes, or passes as a run
   * input only the uploads it made itself; every key of an account carries the
   * account's `owner_id`, so the account alone cannot tell two clients apart.
   */
  uploaded_by_key_id: string | null;
}

/** The cache's window, read once when it is built: what a deadline counts. */
const INPUT_WINDOW_MS = getInputRetentionSeconds() * 1000;

/** The upload paths in the cache below, each with its deadline. */
const registeredInputDeadlines = new Map<string, number>();

/**
 * The uploads in the cache below, by the account that made them, each with its
 * deadline (ms since the epoch): the cache is keyed by file id only, and an
 * account deletion must find its uploads — and an upload count them — without
 * walking every entry. Kept in step by `registerInputFile` and the eviction.
 */
const inputFilesByOwner = new Map<string, Map<string, number>>();

/** Tracks file_id → InputFileMetadata for serving + TTL cleanup of input uploads. */
export const inputCache = new TTLCache<string, InputFileMetadata>({
  ttlMs: INPUT_WINDOW_MS,
  maxEntries: MAX_ENTRIES,
  onEvict: (fileId, meta) => {
    registeredInputDeadlines.delete(meta.path);
    const owned = inputFilesByOwner.get(meta.owner_id);
    if (owned) {
      owned.delete(fileId);
      if (owned.size === 0) inputFilesByOwner.delete(meta.owner_id);
    }
    try {
      rmSync(meta.path, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  },
});

/**
 * Register an upload. Its expiry counts from now, and it carries its deadline —
 * now plus the window — as its modification time: left behind by a stopped
 * server, it goes two to three sweeps past that deadline, counted from its
 * upload. The upload's own expiry is the cache's, never this time.
 */
export function registerInputFile(fileId: string, meta: InputFileMetadata): void {
  // Read before the cache stamps the entry: the deadline is never past the
  // cache's own expiry of it.
  const deadline = Date.now() + INPUT_WINDOW_MS;
  // Set first: replacing an entry evicts the previous one, owner index included.
  inputCache.set(fileId, meta);
  let owned = inputFilesByOwner.get(meta.owner_id);
  if (!owned) {
    owned = new Map();
    inputFilesByOwner.set(meta.owner_id, owned);
  }
  owned.set(fileId, deadline);
  registeredInputDeadlines.set(meta.path, deadline);
  setRemovableAfter(meta.path, deadline);
}

/** Every upload this process holds. The orphan pass never removes one. */
export function ownedInputPaths(): string[] {
  return [...registeredInputDeadlines.keys()];
}

/** Set again the deadline every upload this process holds carries. Returns how many. */
export function touchOwnedInputs(): number {
  for (const [path, deadline] of registeredInputDeadlines) setRemovableAfter(path, deadline);
  return registeredInputDeadlines.size;
}

export function getInputFile(fileId: string): InputFileMetadata | undefined {
  return inputCache.get(fileId);
}

export function deleteInputFile(fileId: string): boolean {
  return inputCache.delete(fileId);
}

/** How many uploads of `ownerId` this process holds, by the owner index. */
export function inputFilesHeldBy(ownerId: string): number {
  return inputFilesByOwner.get(ownerId)?.size ?? 0;
}

/**
 * The uploads of `ownerId` this process holds that have not expired at `nowMs`,
 * and — when they are `limit` or more — the moment the account holds fewer
 * than `limit` again (ms since the epoch): the deadline of its
 * (count − limit + 1)-th oldest upload, the oldest when it holds `limit`
 * exactly, a later one when it holds more (its plan lowered). `null` while it
 * holds fewer. An upload stops counting at its deadline, before the cache
 * drops it: expiry is found by a read or by the sweep, which may come minutes
 * later. Walks the account's own uploads only. Another instance counts its own.
 */
export function liveInputFilesOf(
  ownerId: string,
  limit: number,
  nowMs: number = Date.now(),
): { count: number; belowLimitAtMs: number | null } {
  const deadlines: number[] = [];
  for (const deadline of inputFilesByOwner.get(ownerId)?.values() ?? []) {
    if (deadline > nowMs) deadlines.push(deadline);
  }
  const count = deadlines.length;
  if (count < limit) return { count, belowLimitAtMs: null };
  // In the order they expire, which the clock may not have kept between two uploads.
  deadlines.sort((a, b) => a - b);
  // Each expiry takes one away: the account is below `limit` once
  // count − limit + 1 of them have gone, the oldest first.
  return { count, belowLimitAtMs: deadlines[count - limit] };
}

/**
 * Evict every upload `ownerId` made from this process — entry and file — and
 * return how many. Another instance keeps its own until they expire.
 */
export function evictInputFilesOfOwner(ownerId: string): number {
  const owned = inputFilesByOwner.get(ownerId);
  if (!owned) return 0;
  let evicted = 0;
  // A copy: each eviction removes its id from the index being walked.
  for (const fileId of [...owned.keys()]) {
    if (inputCache.delete(fileId)) evicted++;
  }
  inputFilesByOwner.delete(ownerId);
  return evicted;
}
