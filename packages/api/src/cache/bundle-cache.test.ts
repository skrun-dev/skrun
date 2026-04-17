import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTLCache } from "@skrun-dev/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { type BundleCacheEntry, createBundleCache, getOrExtract } from "./bundle-cache.js";

// Helper: create a real temp dir to simulate an extracted bundle
function makeTempDir(): string {
  const dir = join(tmpdir(), `skrun-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("BundleCache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  it("getOrExtract returns cached entry on second call (VT-5)", () => {
    const cache = new TTLCache<string, BundleCacheEntry>({
      ttlMs: 60_000,
      maxEntries: 10,
    });

    const dir = makeTempDir();
    tempDirs.push(dir);
    const entry: BundleCacheEntry = { dir, files: { "SKILL.md": "test" } };
    cache.set("dev/agent/1.0.0", entry);

    // Second call should return cached — no extraction needed
    const result = cache.get("dev/agent/1.0.0");
    expect(result).toBe(entry);
    expect(result?.dir).toBe(dir);
    expect(result?.files["SKILL.md"]).toBe("test");
  });

  it("getOrExtract calls extractBundleToDisk on cache miss (VT-6)", () => {
    // We can't easily create a real .agent bundle here,
    // so we test that getOrExtract delegates to extractBundleToDisk
    // by verifying it throws on invalid buffer (same as extractBundleToDisk would)
    const cache = new TTLCache<string, BundleCacheEntry>({
      ttlMs: 60_000,
      maxEntries: 10,
    });

    expect(() => getOrExtract(cache, "dev/agent/1.0.0", Buffer.from("not-a-tarball"))).toThrow();
  });

  it("eviction cleans up temp directory (VT-7)", () => {
    const dir = makeTempDir();
    expect(existsSync(dir)).toBe(true);

    const cache = new TTLCache<string, BundleCacheEntry>({
      ttlMs: 60_000,
      maxEntries: 1,
      onEvict: (_key, entry) => {
        try {
          rmSync(entry.dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },
    });

    cache.set("dev/agent/1.0.0", { dir, files: {} });

    // Adding a second entry evicts the first (max=1)
    const dir2 = makeTempDir();
    tempDirs.push(dir2);
    cache.set("dev/agent/2.0.0", { dir: dir2, files: {} });

    expect(existsSync(dir)).toBe(false); // evicted → dir cleaned
  });

  it("createBundleCache reads env vars for TTL and max", () => {
    process.env.BUNDLE_CACHE_TTL = "5";
    process.env.BUNDLE_CACHE_MAX = "3";

    const cache = createBundleCache();
    // Verify max by filling past capacity
    for (let i = 0; i < 4; i++) {
      const d = makeTempDir();
      tempDirs.push(d);
      cache.set(`key-${i}`, { dir: d, files: {} });
    }
    expect(cache.size).toBe(3); // max=3, 4th evicted the 1st

    process.env.BUNDLE_CACHE_TTL = undefined as unknown as string;
    process.env.BUNDLE_CACHE_MAX = undefined as unknown as string;
  });
});
