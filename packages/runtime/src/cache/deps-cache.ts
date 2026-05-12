// Disk-backed cache for resolved script dependencies.
//
// Each cache entry is a directory at `<rootDir>/<hash>/` whose layout is
// ecosystem-specific:
//   - Python:  <hash>/venv/                    (Unix: bin/python, Windows: Scripts/python.exe)
//   - Node:    <hash>/node_modules/             (consumed via NODE_PATH at spawn)
//
// The hash is a content-addressable SHA-256 of the manifest's CONTENT (no
// absolute paths). Two bundles with identical `requirements.txt` text on
// different hosts produce the same hash — required for cross-host
// determinism and the future cloud Docker BuildKit cache key.
//
// In-memory state is intentionally minimal: an in-flight `Map<hash,
// Promise<string>>` deduplicates concurrent `ensure()` calls within the same
// process. Cross-process atomicity comes from `fs.rename` (POSIX atomic;
// Windows handles via the rename failure paths).

import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";

export interface DepsCacheEntry {
  hash: string;
  path: string;
  sizeBytes: number;
  packageCount: number | undefined;
  lastUsedMs: number;
}

export interface DepsCacheClearResult {
  deletedCount: number;
  freedBytes: number;
}

export interface DepsCacheOptions {
  /**
   * Override the cache root. Defaults to `SKRUN_DEPS_DIR` env or `~/.skrun/deps`.
   * Tests should pass an isolated `mkdtempSync()` directory.
   */
  rootDir?: string;
}

export type InstallFn = (targetPath: string) => Promise<void>;

function defaultRootDir(): string {
  return process.env.SKRUN_DEPS_DIR ?? join(homedir(), ".skrun", "deps");
}

/**
 * Compute the content-addressable cache key for a manifest.
 *
 * The input is the canonical concatenation of ecosystem + manifestKind +
 * manifestContent + lockfileKind + lockfileContent, joined by `\n`. Absolute
 * paths are excluded by design (cross-host determinism).
 *
 * Two bundles with identical manifest+lockfile text on different machines
 * produce the same hash — same key the future cloud Docker BuildKit layer
 * cache will use.
 */
export function computeDepsHash(manifest: ManifestInfo): string {
  if (manifest.ecosystem === "none") {
    throw new Error("Cannot compute hash for ecosystem 'none' — no manifest present");
  }
  const parts: string[] = [manifest.ecosystem];
  if (manifest.ecosystem === "python") {
    parts.push(manifest.manifestKind);
    parts.push(manifest.manifestContent);
    if (manifest.lockfileKind) {
      parts.push(manifest.lockfileKind);
      parts.push(manifest.lockfileContent ?? "");
    }
  } else {
    // ecosystem === "node"
    parts.push(manifest.manifestContent);
    if (manifest.lockfileKind) {
      parts.push(manifest.lockfileKind);
      parts.push(manifest.lockfileContent ?? "");
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * Disk-backed cache for resolved script dependencies.
 *
 * Concurrent-safe within a single process via the `inflight` Map; cross-process
 * atomicity comes from `fs.rename` (POSIX atomic; Windows/Linux race outcomes
 * handled by the EEXIST/ENOTEMPTY/EPERM branch).
 */
export class DepsCache {
  readonly rootDir: string;
  // Concurrent-install dedup: shared promise per hash within this process.
  // Cleared after the install settles (success or failure).
  protected readonly inflight = new Map<string, Promise<string>>();

  constructor(options: DepsCacheOptions = {}) {
    this.rootDir = options.rootDir ?? defaultRootDir();
  }

  /** Same algorithm as the module-level `computeDepsHash` — exposed as a static for ergonomics. */
  static computeHash(manifest: ManifestInfo): string {
    return computeDepsHash(manifest);
  }

  /** Absolute path that an entry with the given hash would occupy on disk. */
  pathForHash(hash: string): string {
    return join(this.rootDir, hash);
  }

  /** Whether an entry exists on disk for the given hash. */
  has(hash: string): boolean {
    return existsSync(this.pathForHash(hash));
  }

  /**
   * Resolve a manifest to a path containing its installed dependencies.
   *
   * On cache hit: touches mtime (LRU bookkeeping) and returns the existing
   * path. On cache miss: runs `installFn(tmpPath)` against a `.tmp-*` staging
   * directory and atomically renames it to `<rootDir>/<hash>/`. If two
   * processes race to populate the same hash, the second's rename fails with
   * EEXIST/ENOTEMPTY (POSIX) or EPERM (Windows) — the loser cleans up its
   * tmp dir and uses the winner's result.
   *
   * Within the same process, concurrent calls share a single in-flight
   * promise — `installFn` runs at most once per hash per process.
   */
  async ensure(manifest: ManifestInfo, installFn: InstallFn): Promise<string> {
    const hash = computeDepsHash(manifest);

    const existing = this.inflight.get(hash);
    if (existing) return existing;

    const promise = this.ensureInternal(hash, installFn).finally(() => {
      this.inflight.delete(hash);
    });
    this.inflight.set(hash, promise);
    return promise;
  }

  private async ensureInternal(hash: string, installFn: InstallFn): Promise<string> {
    const finalPath = this.pathForHash(hash);

    // Cache hit: touch mtime (best-effort) and return.
    if (existsSync(finalPath)) {
      const now = new Date();
      await utimes(finalPath, now, now).catch(() => {
        // mtime touch is LRU bookkeeping — non-fatal on permission/Windows quirks.
      });
      return finalPath;
    }

    await mkdir(this.rootDir, { recursive: true });

    // PID + 8 random hex chars = effectively collision-free across concurrent
    // installs, even across hosts sharing an NFS mount.
    const tmpName = `.tmp-${hash}-${process.pid}-${randomBytes(4).toString("hex")}`;
    const tmpPath = join(this.rootDir, tmpName);

    try {
      // Fail loud if tmpPath collision happens (would indicate a logic error).
      await mkdir(tmpPath);
      await installFn(tmpPath);

      try {
        await rename(tmpPath, finalPath);
        return finalPath;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Race lost: another process won the rename. Common across platforms:
        //   - Linux ext4: ENOTEMPTY (rename target already a non-empty dir)
        //   - macOS APFS / generic POSIX: EEXIST
        //   - Windows NTFS: EPERM (rename over existing dir refused)
        if (
          (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") &&
          existsSync(finalPath)
        ) {
          return finalPath;
        }
        throw err;
      }
    } finally {
      // Cleanup runs in all paths:
      //   - rename success: tmpPath already moved, rm is no-op (force: true).
      //   - rename race-lost: tmpPath still exists with our partial install.
      //   - installFn throw: tmpPath exists with partial content.
      //   - mkdir(tmpPath) throw: tmpPath doesn't exist, rm is no-op.
      await rm(tmpPath, { recursive: true, force: true }).catch(() => {
        // Cleanup failure is non-fatal — orphaned `.tmp-*` dirs are GC'd by `clear()`.
      });
    }
  }

  /**
   * List all cache entries with metadata, sorted by last-used descending.
   * Skips orphaned `.tmp-*` dirs from interrupted installs.
   */
  async listEntries(): Promise<DepsCacheEntry[]> {
    if (!existsSync(this.rootDir)) return [];

    const dirEntries = await readdir(this.rootDir, { withFileTypes: true });
    const result: DepsCacheEntry[] = [];

    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".tmp-")) continue;

      const path = join(this.rootDir, entry.name);
      const [statResult, sizeBytes, packageCount] = await Promise.all([
        stat(path).catch(() => null),
        directorySizeBytes(path),
        countPackages(path),
      ]);

      result.push({
        hash: entry.name,
        path,
        sizeBytes,
        packageCount,
        lastUsedMs: statResult?.mtimeMs ?? 0,
      });
    }

    result.sort((a, b) => b.lastUsedMs - a.lastUsedMs);
    return result;
  }

  /**
   * Delete every cache entry (and orphaned `.tmp-*` dirs). Reports the count
   * and bytes freed for hash entries only — orphans are silent cleanup.
   */
  async clear(): Promise<DepsCacheClearResult> {
    if (!existsSync(this.rootDir)) return { deletedCount: 0, freedBytes: 0 };

    const dirEntries = await readdir(this.rootDir, { withFileTypes: true });
    let deletedCount = 0;
    let freedBytes = 0;

    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.rootDir, entry.name);
      const isOrphan = entry.name.startsWith(".tmp-");

      if (!isOrphan) {
        freedBytes += await directorySizeBytes(path);
        deletedCount++;
      }
      await rm(path, { recursive: true, force: true }).catch(() => {
        // Best-effort. Files may be in use on Windows; user can retry.
      });
    }

    return { deletedCount, freedBytes };
  }
}

/**
 * Sum of file sizes within a directory tree. Best-effort: missing or
 * permission-denied paths contribute 0 rather than throwing.
 */
async function directorySizeBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(path);
    } else if (entry.isFile()) {
      try {
        total += (await stat(path)).size;
      } catch {
        // Skip unreadable files.
      }
    }
  }
  return total;
}

/**
 * Best-effort count of packages installed in a cache entry.
 *
 * Platform-aware for Python venvs:
 *   - Unix venv:    venv/lib/pythonX.Y/site-packages/
 *   - Windows venv: venv/Lib/site-packages/
 *   - Node:         node_modules/ (skipping dotted dirs)
 *
 * Returns undefined when the layout cannot be identified — `cache list`
 * surfaces this as `?` to the user without erroring.
 */
async function countPackages(entryPath: string): Promise<number | undefined> {
  // Node: count immediate children of node_modules, expanding scoped packages.
  const nodeModulesPath = join(entryPath, "node_modules");
  if (existsSync(nodeModulesPath)) {
    try {
      const entries = await readdir(nodeModulesPath, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue; // .bin, .cache, .staging
        if (entry.name.startsWith("@")) {
          try {
            const scoped = await readdir(join(nodeModulesPath, entry.name), {
              withFileTypes: true,
            });
            count += scoped.filter((s) => s.isDirectory()).length;
          } catch {
            // Skip unreadable scope dir.
          }
        } else {
          count++;
        }
      }
      return count;
    } catch {
      return undefined;
    }
  }

  // Python venv: detect Windows vs Unix layout via Scripts/ vs bin/.
  const venvPath = join(entryPath, "venv");
  if (existsSync(venvPath)) {
    if (existsSync(join(venvPath, "Scripts"))) {
      return countSitePackages(join(venvPath, "Lib", "site-packages"));
    }
    if (existsSync(join(venvPath, "bin"))) {
      try {
        const libEntries = await readdir(join(venvPath, "lib"), { withFileTypes: true });
        const pythonDir = libEntries.find(
          (entry) => entry.isDirectory() && entry.name.startsWith("python"),
        );
        if (pythonDir) {
          return countSitePackages(join(venvPath, "lib", pythonDir.name, "site-packages"));
        }
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

async function countSitePackages(sitePackagesPath: string): Promise<number | undefined> {
  if (!existsSync(sitePackagesPath)) return undefined;
  try {
    const entries = await readdir(sitePackagesPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Exclude metadata + bytecode caches — they're not "packages" the user installed.
      if (entry.name.endsWith(".dist-info") || entry.name.endsWith(".egg-info")) continue;
      if (entry.name === "__pycache__") continue;
      count++;
    }
    return count;
  } catch {
    return undefined;
  }
}
