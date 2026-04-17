import { rmSync } from "node:fs";
import { TTLCache } from "@skrun-dev/runtime";
import { extractBundleToDisk } from "../utils/bundle.js";

export interface BundleCacheEntry {
  dir: string;
  files: Record<string, string>;
}

const DEFAULT_TTL_S = 600; // 10 minutes
const DEFAULT_MAX = 50;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function createBundleCache(): TTLCache<string, BundleCacheEntry> {
  const ttlMs = readEnvInt("BUNDLE_CACHE_TTL", DEFAULT_TTL_S) * 1000;
  const maxEntries = readEnvInt("BUNDLE_CACHE_MAX", DEFAULT_MAX);

  return new TTLCache<string, BundleCacheEntry>({
    ttlMs,
    maxEntries,
    onEvict: (_key, entry) => {
      try {
        rmSync(entry.dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  });
}

/** Module-level singleton */
export const bundleCache = createBundleCache();

/**
 * Get a cached bundle extraction or extract and cache it.
 * Key format: "namespace/name/version"
 */
export function getOrExtract(
  cache: TTLCache<string, BundleCacheEntry>,
  key: string,
  bundleBuffer: Buffer,
): BundleCacheEntry {
  const cached = cache.get(key);
  if (cached) return cached;

  const extracted = extractBundleToDisk(bundleBuffer);
  const entry: BundleCacheEntry = { dir: extracted.dir, files: extracted.files };
  cache.set(key, entry);
  // Do NOT call extracted.cleanup — the cache owns the lifecycle now
  return entry;
}
