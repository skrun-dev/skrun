// Unit tests for `DepsCache` (#57 Task 3.3).
//
// All tests use an isolated `mkdtempSync` directory passed as `rootDir`, so
// they never touch the real `~/.skrun/deps`. Install functions are mocks that
// write a tiny stub layout — full Python/Node installer behavior is tested
// separately in Phase 4.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDepsHash, DepsCache } from "./deps-cache.js";

let rootDir: string;
let cache: DepsCache;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "skrun-deps-cache-test-"));
  cache = new DepsCache({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function pythonRequirements(content: string): ManifestInfo {
  return { ecosystem: "python", manifestKind: "requirements", manifestContent: content };
}

function nodeManifest(
  content: string,
  lockfile?: { kind: "npm" | "pnpm" | "yarn"; content: string },
): ManifestInfo {
  return {
    ecosystem: "node",
    manifestContent: content,
    ...(lockfile && { lockfileKind: lockfile.kind, lockfileContent: lockfile.content }),
  };
}

/** Creates a tiny Node-style install layout in `targetPath`. */
function fakeNodeInstall(targetPath: string): Promise<void> {
  mkdirSync(join(targetPath, "node_modules", "jszip"), { recursive: true });
  writeFileSync(join(targetPath, "node_modules", "jszip", "package.json"), '{"name":"jszip"}');
  writeFileSync(join(targetPath, "node_modules", "jszip", "index.js"), "module.exports = {};");
  return Promise.resolve();
}

/** Creates a tiny Python venv layout (Unix-style) in `targetPath`. */
function fakePythonInstall(targetPath: string): Promise<void> {
  mkdirSync(join(targetPath, "venv", "bin"), { recursive: true });
  writeFileSync(join(targetPath, "venv", "bin", "python"), "#!/usr/bin/env python3\n");
  mkdirSync(join(targetPath, "venv", "lib", "python3.11", "site-packages", "pandas"), {
    recursive: true,
  });
  writeFileSync(
    join(targetPath, "venv", "lib", "python3.11", "site-packages", "pandas", "__init__.py"),
    "",
  );
  return Promise.resolve();
}

describe("computeDepsHash — content-only determinism (SC-13)", () => {
  it("produces the same hash for identical manifest content", () => {
    const a = pythonRequirements("pandas==2.2.3\n");
    const b = pythonRequirements("pandas==2.2.3\n");
    expect(computeDepsHash(a)).toBe(computeDepsHash(b));
  });

  it("produces different hashes for different manifest content", () => {
    const a = pythonRequirements("pandas==2.2.3\n");
    const b = pythonRequirements("pandas==2.1.0\n");
    expect(computeDepsHash(a)).not.toBe(computeDepsHash(b));
  });

  it("differentiates manifest content with vs without lockfile", () => {
    const a = nodeManifest('{"name":"x"}');
    const b = nodeManifest('{"name":"x"}', { kind: "npm", content: '{"lockfileVersion":3}' });
    expect(computeDepsHash(a)).not.toBe(computeDepsHash(b));
  });

  it("differentiates the same manifest with different lockfile kinds (npm vs pnpm)", () => {
    const a = nodeManifest('{"name":"x"}', { kind: "npm", content: "lock" });
    const b = nodeManifest('{"name":"x"}', { kind: "pnpm", content: "lock" });
    expect(computeDepsHash(a)).not.toBe(computeDepsHash(b));
  });

  it("differentiates Node vs Python manifests with identical content text", () => {
    const a: ManifestInfo = { ecosystem: "node", manifestContent: "X" };
    const b: ManifestInfo = {
      ecosystem: "python",
      manifestKind: "requirements",
      manifestContent: "X",
    };
    expect(computeDepsHash(a)).not.toBe(computeDepsHash(b));
  });

  it("throws when called on ecosystem 'none'", () => {
    expect(() => computeDepsHash({ ecosystem: "none" })).toThrow(/none/);
  });

  it("DepsCache.computeHash matches the module-level computeDepsHash", () => {
    const m = pythonRequirements("pandas\n");
    expect(DepsCache.computeHash(m)).toBe(computeDepsHash(m));
  });
});

describe("DepsCache.ensure — cold path", () => {
  it("invokes installFn once and returns the resolved path", async () => {
    const m = nodeManifest('{"name":"x","dependencies":{"jszip":"^3"}}');
    const installFn = vi.fn(fakeNodeInstall);

    const path = await cache.ensure(m, installFn);

    expect(installFn).toHaveBeenCalledTimes(1);
    expect(path).toBe(cache.pathForHash(computeDepsHash(m)));
    expect(existsSync(join(path, "node_modules", "jszip"))).toBe(true);
  });

  it("creates the rootDir if it does not exist", async () => {
    const nestedRoot = join(rootDir, "nested", "deps");
    const c = new DepsCache({ rootDir: nestedRoot });
    const m = pythonRequirements("pandas\n");

    await c.ensure(m, fakePythonInstall);

    expect(existsSync(nestedRoot)).toBe(true);
  });
});

describe("DepsCache.ensure — warm path (cache hit)", () => {
  it("does NOT invoke installFn on the second call", async () => {
    const m = nodeManifest('{"name":"x"}');
    const installFn = vi.fn(fakeNodeInstall);

    await cache.ensure(m, installFn);
    await cache.ensure(m, installFn);

    expect(installFn).toHaveBeenCalledTimes(1);
  });

  it("returns the same path on the second call", async () => {
    const m = pythonRequirements("pandas\n");
    const a = await cache.ensure(m, fakePythonInstall);
    const b = await cache.ensure(m, vi.fn());
    expect(a).toBe(b);
  });
});

describe("DepsCache.ensure — in-process dedup", () => {
  it("runs installFn at most once when 5 ensures race for the same hash", async () => {
    const m = nodeManifest('{"name":"x"}');
    const installFn = vi.fn(async (path: string) => {
      // Simulate slow install so all 5 calls overlap.
      await new Promise((r) => setTimeout(r, 30));
      await fakeNodeInstall(path);
    });

    const results = await Promise.all([
      cache.ensure(m, installFn),
      cache.ensure(m, installFn),
      cache.ensure(m, installFn),
      cache.ensure(m, installFn),
      cache.ensure(m, installFn),
    ]);

    expect(installFn).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1); // all 5 returned the same path
  });

  it("does NOT dedup ensures across different manifests (VT-15 venv isolation)", async () => {
    const a = pythonRequirements("pandas==2.2.0\n");
    const b = pythonRequirements("pandas==2.1.0\n");
    const installFn = vi.fn(fakePythonInstall);

    const [pathA, pathB] = await Promise.all([
      cache.ensure(a, installFn),
      cache.ensure(b, installFn),
    ]);

    expect(installFn).toHaveBeenCalledTimes(2);
    expect(pathA).not.toBe(pathB);
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    // Both venvs coexist in the cache root.
    const entries = readdirSync(rootDir).filter((n) => !n.startsWith(".tmp-"));
    expect(entries.length).toBe(2);
  });

  it("clears the in-flight entry after success so subsequent calls re-check disk", async () => {
    const m = nodeManifest('{"name":"x"}');
    const installFn = vi.fn(fakeNodeInstall);

    await cache.ensure(m, installFn);
    // After the first ensure resolves, inflight should be cleared. A second
    // ensure must hit the disk-cache branch (not in-flight branch) — it
    // should return without re-installing.
    await cache.ensure(m, installFn);
    expect(installFn).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight entry after a failure so retries are possible", async () => {
    const m = nodeManifest('{"name":"x"}');
    const failing = vi.fn().mockRejectedValue(new Error("install boom"));
    const succeeding = vi.fn(fakeNodeInstall);

    await expect(cache.ensure(m, failing)).rejects.toThrow("install boom");
    // After the first ensure rejected, the second one must run installFn again.
    await cache.ensure(m, succeeding);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

describe("DepsCache.ensure — failure paths and atomicity", () => {
  it("cleans up tmp dir when installFn throws (no orphan in finalPath)", async () => {
    const m = nodeManifest('{"name":"x"}');
    const failing = vi.fn().mockRejectedValue(new Error("install failed"));

    await expect(cache.ensure(m, failing)).rejects.toThrow("install failed");

    // Final hash dir must NOT exist (install never completed).
    expect(cache.has(computeDepsHash(m))).toBe(false);
    // No `.tmp-*` orphans should remain — finally block cleaned up.
    const orphans = readdirSync(rootDir).filter((n) => n.startsWith(".tmp-"));
    expect(orphans).toEqual([]);
  });

  it("treats a pre-existing finalPath as a cache hit (race-lost simulation)", async () => {
    const m = nodeManifest('{"name":"x"}');
    const finalPath = cache.pathForHash(computeDepsHash(m));

    // Pre-populate finalPath as if another process won the race.
    mkdirSync(join(finalPath, "node_modules", "competitor"), { recursive: true });
    writeFileSync(join(finalPath, "node_modules", "competitor", "marker.txt"), "winner");

    const installFn = vi.fn(fakeNodeInstall);
    const path = await cache.ensure(m, installFn);

    expect(path).toBe(finalPath);
    // installFn must NOT have run — the warm-path check catches the existing dir.
    expect(installFn).not.toHaveBeenCalled();
    // The pre-existing content is preserved (we did not overwrite the winner).
    expect(existsSync(join(finalPath, "node_modules", "competitor", "marker.txt"))).toBe(true);
  });
});

describe("DepsCache.has + pathForHash", () => {
  it("has() returns false on cold cache, true after ensure", async () => {
    const m = pythonRequirements("pandas\n");
    expect(cache.has(computeDepsHash(m))).toBe(false);
    await cache.ensure(m, fakePythonInstall);
    expect(cache.has(computeDepsHash(m))).toBe(true);
  });

  it("pathForHash uses the rootDir + hash join", () => {
    const hash = "abc123";
    expect(cache.pathForHash(hash)).toBe(join(rootDir, hash));
  });
});

describe("DepsCache.listEntries", () => {
  it("returns [] on a non-existent rootDir", async () => {
    const c = new DepsCache({ rootDir: join(rootDir, "missing") });
    const entries = await c.listEntries();
    expect(entries).toEqual([]);
  });

  it("returns [] on an empty rootDir", async () => {
    const entries = await cache.listEntries();
    expect(entries).toEqual([]);
  });

  it("returns one entry per cached hash with size + lastUsedMs", async () => {
    const a = nodeManifest('{"name":"a"}');
    const b = pythonRequirements("pandas\n");
    await cache.ensure(a, fakeNodeInstall);
    await cache.ensure(b, fakePythonInstall);

    const entries = await cache.listEntries();
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.path.endsWith(entry.hash)).toBe(true);
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(entry.lastUsedMs).toBeGreaterThan(0);
    }
  });

  it("counts Node packages from node_modules/", async () => {
    const m = nodeManifest('{"name":"x"}');
    await cache.ensure(m, fakeNodeInstall);
    const entries = await cache.listEntries();
    expect(entries[0]?.packageCount).toBe(1); // only `jszip`
  });

  it("counts Python packages from venv/lib/python*/site-packages (Unix layout)", async () => {
    const m = pythonRequirements("pandas\n");
    await cache.ensure(m, fakePythonInstall);
    const entries = await cache.listEntries();
    expect(entries[0]?.packageCount).toBe(1); // only `pandas`
  });

  it("skips .tmp-* orphan dirs", async () => {
    mkdirSync(join(rootDir, ".tmp-orphan-hash-1234"), { recursive: true });
    writeFileSync(join(rootDir, ".tmp-orphan-hash-1234", "leftover.txt"), "x");
    const entries = await cache.listEntries();
    expect(entries).toEqual([]);
  });

  it("returns undefined packageCount when layout cannot be identified", async () => {
    // Create a hash dir manually with no node_modules and no venv.
    const fakeHash = "f".repeat(64);
    mkdirSync(join(rootDir, fakeHash), { recursive: true });
    writeFileSync(join(rootDir, fakeHash, "broken.txt"), "x");

    const entries = await cache.listEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.packageCount).toBeUndefined();
  });
});

describe("DepsCache.clear", () => {
  it("returns 0/0 on an empty cache", async () => {
    const result = await cache.clear();
    expect(result).toEqual({ deletedCount: 0, freedBytes: 0 });
  });

  it("returns 0/0 when rootDir does not exist", async () => {
    const c = new DepsCache({ rootDir: join(rootDir, "missing") });
    const result = await c.clear();
    expect(result).toEqual({ deletedCount: 0, freedBytes: 0 });
  });

  it("deletes all hash entries and reports count + bytes", async () => {
    const a = nodeManifest('{"name":"a"}');
    const b = pythonRequirements("pandas\n");
    await cache.ensure(a, fakeNodeInstall);
    await cache.ensure(b, fakePythonInstall);

    const result = await cache.clear();
    expect(result.deletedCount).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(0);

    const entries = readdirSync(rootDir);
    expect(entries).toEqual([]);
  });

  it("also deletes .tmp-* orphans (silent — not counted)", async () => {
    mkdirSync(join(rootDir, ".tmp-orphan-hash-aaaa"), { recursive: true });
    writeFileSync(join(rootDir, ".tmp-orphan-hash-aaaa", "leftover.txt"), "x");

    const result = await cache.clear();
    expect(result.deletedCount).toBe(0); // orphans are not counted
    const entries = readdirSync(rootDir);
    expect(entries).toEqual([]);
  });
});
