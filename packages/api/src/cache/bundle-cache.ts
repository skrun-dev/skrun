import { rmSync } from "node:fs";
import { TTLCache } from "@skrun-dev/runtime";
import type { AgentConfig } from "@skrun-dev/schema";
import { extractBundleToDisk, extractFiles, MANIFEST_FILES } from "../utils/bundle.js";
import { setRemovableAfter } from "./removable-after.js";

/**
 * What a run made of a bundle's `agent.yaml`, read once for the bundle's
 * entry: the configuration, as the reading thread sent it — JSON, which each
 * run parses into an object of its own, its keys in the order the parse gave
 * them —, or the message the read was refused with.
 */
export type BundleConfigRead = { json: string } | { refused: string };

/**
 * Read a bundle's `agent.yaml` — its text, never empty — into what the entry
 * keeps (`BundleConfigRead`). Rejects only when the file was never judged: a
 * reader's failure.
 */
export type ReadBundleConfig = (agentYaml: string) => Promise<BundleConfigRead>;

/**
 * The configuration a run gets of an entry's read: an object of its own,
 * parsed from the JSON the entry keeps — no run shares one with another, nor
 * with the cache — its keys in the order the read gave them.
 */
export function configObject(read: { json: string }): AgentConfig {
  return JSON.parse(read.json) as AgentConfig;
}

/**
 * What the cache keeps of one bundle: the text of its manifests
 * (`MANIFEST_FILES`, those the bundle has — never any other file of it), the
 * configuration its `agent.yaml` declares, read once, and, when a run needs
 * the bundle on disk, the directory it was extracted to. An entry without one
 * — read by a cloud run, whose sandbox fetches its own copy of the bundle —
 * has nothing on this process's disk: nothing to hold, to date or to remove,
 * and it counts among none of the extractions below.
 */
export interface BundleCacheEntry {
  /** The extraction's directory: present when the bundle was written to disk. */
  dir?: string;
  /** The text of the bundle's manifests, by name. */
  files: Record<string, string>;
  /**
   * The configuration of the bundle's `agent.yaml`, read once with the entry
   * (`readConfig`). Absent when the bundle has no `agent.yaml`, or an empty
   * one — or when the entry was made without `readConfig`.
   */
  config?: BundleConfigRead;
  /**
   * Runs reading this extraction now. On the local runtime a run's scripts
   * are launched from the directory while the run goes on, so the directory
   * is never removed while this is above zero. Absent means zero.
   */
  users?: number;
  /** Left the cache while in use: the last release removes the directory. */
  evicted?: boolean;
  /** When the cache's entry expires, in ms: the time the directory carries. */
  expiresAt?: number;
  /** The cache's window, in ms: what a held extraction carries past now. */
  windowMs?: number;
}

/** One run's use of an extraction. `release` is idempotent. */
export interface BundleLease {
  release(): void;
}

const DEFAULT_TTL_S = 600; // 10 minutes
const DEFAULT_MAX = 50;
const DEFAULT_MAX_MB = 256;
const MIB = 1024 * 1024;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * Every extraction this process still has on disk through `getOrExtract`:
 * those in a cache, and those evicted but still in use. Lets the process count
 * what runs hold. An entry with no directory is never one of them.
 */
const ownedExtractions = new Set<BundleCacheEntry>();

/**
 * Set the time an extraction carries for the orphan pass of an instance
 * sharing this temp root: its cache deadline, or — while a run holds it — now
 * plus the cache's window, whichever is later. An entry with no directory
 * carries nothing.
 */
function touch(entry: BundleCacheEntry, now: number = Date.now()): void {
  if (entry.dir === undefined) return;
  const held = (entry.users ?? 0) > 0 ? now + (entry.windowMs ?? bundleCacheTtlMs()) : 0;
  setRemovableAfter(entry.dir, Math.max(entry.expiresAt ?? 0, held));
}

/**
 * Set again the time every extraction this process still has carries: each
 * one in a cache, and each one evicted but still in use. Called by the
 * recurring sweep, so a held one's time stays ahead of now.
 */
export function touchOwnedExtractions(now: number = Date.now()): number {
  for (const entry of ownedExtractions) touch(entry, now);
  return ownedExtractions.size;
}

/** The directory of every extraction this process holds. The orphan pass never removes one. */
export function ownedExtractionDirs(): string[] {
  return [...ownedExtractions].flatMap((entry) => (entry.dir === undefined ? [] : [entry.dir]));
}

/** Remove an entry's directory, when it has one, and stop owning it. */
function removeExtraction(entry: BundleCacheEntry): void {
  if (entry.dir !== undefined) {
    try {
      rmSync(entry.dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  ownedExtractions.delete(entry);
}

/**
 * How long an extraction stays in the cache, in milliseconds
 * (`BUNDLE_CACHE_TTL`, in seconds). One definition, two readers: the cache,
 * built once, and the orphan pass's window for an extraction another process
 * left.
 */
export function bundleCacheTtlMs(): number {
  return readEnvInt("BUNDLE_CACHE_TTL", DEFAULT_TTL_S) * 1000;
}

/**
 * What the cache's entries may weigh together, in bytes (`BUNDLE_CACHE_MAX_MB`,
 * in MB; 256 unset or malformed), as `entryBytes` weighs them — besides their
 * count (`BUNDLE_CACHE_MAX`).
 */
export function bundleCacheMaxBytes(): number {
  return readEnvInt("BUNDLE_CACHE_MAX_MB", DEFAULT_MAX_MB) * MIB;
}

/**
 * What a string's characters take in memory, at most, in bytes: one per
 * character for a string all in ASCII, two otherwise — never less than what
 * the process holds of them, the string's header aside. Not one per character
 * for a string all in Latin-1, which V8 can keep so: a manifest decoded from
 * UTF-8 is not always kept so — from about a million characters on, Node
 * keeps a string with any character past ASCII two bytes per character,
 * outside V8's heap (measured, Node 24: not at 1,031,000, at 1,033,000).
 */
export function stringBytes(text: string): number {
  return /[\u0080-\uffff]/.test(text) ? text.length * 2 : text.length;
}

/**
 * What an entry weighs in the cache's budget: the text of its manifests, and
 * the text its configuration is kept as — its JSON, or its refusal's message
 * —, each by `stringBytes`. The configuration is kept as text, never as the
 * object it parses into: a string's weight is known from its length — a kept
 * JSON measured at `stringBytes` plus ~25 bytes, its header and its slot —,
 * an object's is not: 21 bytes for each character of JSON for a list of empty
 * objects (`[{},{},…]`), 13 for one of empty lists (measured on Node 24,
 * Windows, 2026-11-16, configurations read from 128 KB files).
 */
export function entryBytes(entry: BundleCacheEntry): number {
  let bytes = 0;
  for (const text of Object.values(entry.files)) bytes += stringBytes(text);
  if (entry.config) {
    bytes += stringBytes("json" in entry.config ? entry.config.json : entry.config.refused);
  }
  return bytes;
}

/**
 * Whether `entry` serves a caller that reads the configuration
 * (`readConfig`): it holds one, or its bundle has no `agent.yaml` to read.
 * One made without reading it serves no such caller: its bundle is read
 * again, and the new entry takes its place.
 */
function servesConfig(entry: BundleCacheEntry, readConfig?: ReadBundleConfig): boolean {
  return !readConfig || entry.config !== undefined || !entry.files["agent.yaml"];
}

/** The configuration of a bundle whose manifests are `files`, read by `readConfig`; none without an `agent.yaml`. */
async function configOf(
  files: Record<string, string>,
  readConfig: ReadBundleConfig,
): Promise<BundleConfigRead | undefined> {
  const agentYaml = files["agent.yaml"];
  return agentYaml ? readConfig(agentYaml) : undefined;
}

/**
 * Take an entry out of the cache's hands, whatever evicts it — its expiry
 * found by a sweep or a read, the count or the byte budget, a delete — or when
 * the budget does not keep it: a run still reading the directory keeps it,
 * and its directory leaves with the last run; else it leaves now.
 */
function leaveCache(entry: BundleCacheEntry): void {
  if ((entry.users ?? 0) > 0) {
    entry.evicted = true;
    return;
  }
  removeExtraction(entry);
}

/** Each cache's window, as it read it when built. */
const cacheWindows = new WeakMap<TTLCache<string, BundleCacheEntry>, number>();

/**
 * A run cache: entries live `BUNDLE_CACHE_TTL`, at most `BUNDLE_CACHE_MAX` of
 * them, weighing at most `BUNDLE_CACHE_MAX_MB` together — the least recently
 * used leave first. An entry heavier than the whole budget is not kept: the
 * run that read it is served, and the next one reads the bundle again.
 */
export function createBundleCache(): TTLCache<string, BundleCacheEntry> {
  const ttlMs = bundleCacheTtlMs();
  const maxEntries = readEnvInt("BUNDLE_CACHE_MAX", DEFAULT_MAX);

  const cache = new TTLCache<string, BundleCacheEntry>({
    ttlMs,
    maxEntries,
    onEvict: (_key, entry) => leaveCache(entry),
    budget: { maxBytes: bundleCacheMaxBytes(), sizeOf: entryBytes },
  });
  cacheWindows.set(cache, ttlMs);
  return cache;
}

/**
 * Mark an extraction in use by one run, until the lease is released. A run
 * takes it through `getOrExtract(…, { acquire: true })`, never after. Each
 * acquisition gets its own lease, and a lease releases once whatever calls it:
 * a second release can never take another run's use away.
 */
export function acquireBundle(entry: BundleCacheEntry): BundleLease {
  entry.users = (entry.users ?? 0) + 1;
  touch(entry);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      entry.users = (entry.users ?? 1) - 1;
      if (entry.users === 0 && entry.evicted) removeExtraction(entry);
    },
  };
}

/** How many runs hold an extraction of this process right now. */
export function bundleExtractionsInUse(): number {
  let inUse = 0;
  for (const entry of ownedExtractions) inUse += entry.users ?? 0;
  return inUse;
}

/** Module-level singleton */
export const bundleCache = createBundleCache();

/** Extractions that left the cache while in use: their directory waits for the last run. */
function evictedInUse(): number {
  let count = 0;
  for (const entry of ownedExtractions) if (entry.evicted) count++;
  return count;
}

/**
 * Sweep the module's cache. An expired entry leaves it either way; `removed`
 * counts the directories that left the disk with it, `held` the ones a run
 * still uses, which go when the last of those runs ends. An entry with no
 * directory leaves the cache counted in neither.
 */
export function sweepBundleCache(): { removed: number; held: number } {
  const ownedBefore = ownedExtractions.size;
  const heldBefore = evictedInUse();
  bundleCache.sweep();
  const held = evictedInUse() - heldBefore;
  // A directory removed with its entry is no longer owned; one a run still
  // holds is, marked evicted: the difference is what left the disk.
  return { removed: ownedBefore - ownedExtractions.size, held };
}

/** An entry whose bundle is on disk, at its `dir`. */
export type BundleExtraction = BundleCacheEntry & { dir: string };

function isExtraction(entry: BundleCacheEntry): entry is BundleExtraction {
  return entry.dir !== undefined;
}

/**
 * Get a cached bundle extraction or extract and cache it: the bundle written
 * to a directory, and the text of its manifests kept. An entry of the same
 * bytes that holds the manifests only (`getOrReadManifests`) is no extraction:
 * the bundle is extracted, and its entry takes that one's place — its
 * configuration, read already, kept.
 * Key: the SHA-256 (hex) of the bundle's bytes. Two versions with the same
 * bytes share one extraction; a name and version published again with other
 * bytes never meet the first one.
 *
 * With `readConfig`, the entry holds the configuration of the bundle's
 * `agent.yaml` (`config`), read once: before a new entry enters the cache, so
 * that its weight counts it. A read that rejects — a reader's failure, the
 * file never judged — leaves nothing: the directory removed, the lease
 * released, the rejection passed on. An entry made without `readConfig`, of a
 * bundle with an `agent.yaml`, does not serve a caller that passes one.
 *
 * With `{ acquire: true }` the extraction comes back already held by one run:
 * the lease is taken here, in the same step that reads or fills the cache, so
 * nothing the caller does can come between the two — and before the cache
 * sees a new extraction, so one its budget does not keep is evicted held: its
 * directory leaves with the run's release. Without a lease, such an
 * extraction's directory leaves at once.
 */
export function getOrExtract(
  cache: TTLCache<string, BundleCacheEntry>,
  key: string,
  bundleBuffer: Buffer,
  options?: { readConfig?: ReadBundleConfig },
): Promise<BundleExtraction>;
export function getOrExtract(
  cache: TTLCache<string, BundleCacheEntry>,
  key: string,
  bundleBuffer: Buffer,
  options: { acquire: true; readConfig?: ReadBundleConfig },
): Promise<{ entry: BundleExtraction; lease: BundleLease }>;
export async function getOrExtract(
  cache: TTLCache<string, BundleCacheEntry>,
  key: string,
  bundleBuffer: Buffer,
  options?: { acquire?: true; readConfig?: ReadBundleConfig },
): Promise<BundleExtraction | { entry: BundleExtraction; lease: BundleLease }> {
  const readConfig = options?.readConfig;
  const cached = cache.get(key);
  if (cached && isExtraction(cached) && servesConfig(cached, readConfig)) {
    return options?.acquire ? { entry: cached, lease: acquireBundle(cached) } : cached;
  }

  const extracted = await extractBundleToDisk(bundleBuffer);
  const windowMs = cacheWindows.get(cache) ?? bundleCacheTtlMs();
  // Dated from now while its configuration is read: an instance sharing the
  // temp root never sees the directory without a time ahead.
  const entry: BundleExtraction = {
    dir: extracted.dir,
    files: extracted.files,
    windowMs,
    expiresAt: Date.now() + windowMs,
  };
  ownedExtractions.add(entry);
  const lease = options?.acquire ? acquireBundle(entry) : undefined;
  if (!lease) touch(entry);
  if (readConfig) {
    try {
      const config = cached?.config ?? (await configOf(entry.files, readConfig));
      if (config) entry.config = config;
    } catch (err) {
      lease?.release();
      removeExtraction(entry);
      throw err;
    }
  }
  if (cache.set(key, entry)) {
    entry.expiresAt = Date.now() + windowMs;
    touch(entry);
  } else {
    leaveCache(entry);
  }
  // Do NOT call extracted.cleanup — the cache owns the lifecycle now
  return lease ? { entry, lease } : entry;
}

/**
 * Get the text of a bundle's manifests (`MANIFEST_FILES`) from the cache, or
 * read them and cache them — for a run that needs nothing else of the bundle
 * on this process: a cloud run, whose sandbox fetches its own copy. Nothing is
 * written to disk, and no other file of the bundle is kept, as bytes or as
 * text: the archive is decompressed whole, in memory, under the server's cap,
 * and only the manifests are copied out of it.
 * An extraction of the same bytes, already cached, serves as well. With
 * `readConfig`, the entry holds the configuration of the bundle's
 * `agent.yaml`, read once, as `getOrExtract` reads it; an entry made without
 * it, of a bundle with an `agent.yaml`, gives its manifests to a new entry
 * that reads it, and leaves.
 *
 * Nothing to hold: the entry has no directory, so no lease is taken. Same key
 * as `getOrExtract`. Rejects as `extractFiles` does, and as `readConfig` does.
 */
export async function getOrReadManifests(
  cache: TTLCache<string, BundleCacheEntry>,
  key: string,
  bundleBuffer: Buffer,
  options?: { readConfig?: ReadBundleConfig },
): Promise<BundleCacheEntry> {
  const readConfig = options?.readConfig;
  const cached = cache.get(key);
  if (cached && servesConfig(cached, readConfig)) return cached;

  const files = cached?.files ?? (await extractFiles(bundleBuffer, MANIFEST_FILES));
  const entry: BundleCacheEntry = { files };
  if (readConfig) {
    const config = await configOf(files, readConfig);
    if (config) entry.config = config;
  }
  // One the budget does not keep is served all the same; nothing to remove.
  cache.set(key, entry);
  return entry;
}
