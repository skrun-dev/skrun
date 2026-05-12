// `skrun cache list` and `skrun cache clear` — manage the script-deps cache
// at `~/.skrun/deps/<hash>/`.
//
// Implementation note: the on-disk layout is the same one written by the
// runtime's `DepsCache` (see `packages/runtime/src/cache/deps-cache.ts`),
// but we walk it directly here rather than import `@skrun-dev/runtime` —
// pulling in the runtime would bring every LLM provider SDK into the CLI
// bin. The walk is small (~80 lines) and the on-disk format is stable.

import type { Dirent } from "node:fs";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import * as format from "../utils/format.js";

const CONFIRM_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB

function defaultRootDir(): string {
  return process.env.SKRUN_DEPS_DIR ?? join(homedir(), ".skrun", "deps");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function directorySizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySizeBytes(path);
    } else if (entry.isFile()) {
      try {
        total += statSync(path).size;
      } catch {
        // Skip unreadable.
      }
    }
  }
  return total;
}

/**
 * Best-effort count of installed packages in a cache entry. Platform-aware
 * for Python venvs and Node node_modules. Returns `undefined` if the layout
 * cannot be identified — surfaced as `?` to the user.
 */
function countPackages(entryPath: string): number | undefined {
  // Node: count immediate children of node_modules, expand scoped pkgs.
  const nodeModulesPath = join(entryPath, "node_modules");
  if (existsSync(nodeModulesPath)) {
    try {
      const entries = readdirSync(nodeModulesPath, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) {
          try {
            const scoped = readdirSync(join(nodeModulesPath, entry.name), { withFileTypes: true });
            count += scoped.filter((s) => s.isDirectory()).length;
          } catch {
            // Skip unreadable scope.
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

  // Python venv: detect Windows vs Unix layout.
  const venvPath = join(entryPath, "venv");
  if (existsSync(venvPath)) {
    if (existsSync(join(venvPath, "Scripts"))) {
      return countSitePackages(join(venvPath, "Lib", "site-packages"));
    }
    if (existsSync(join(venvPath, "bin"))) {
      try {
        const libEntries = readdirSync(join(venvPath, "lib"), { withFileTypes: true });
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

function countSitePackages(sitePackagesPath: string): number | undefined {
  if (!existsSync(sitePackagesPath)) return undefined;
  try {
    const entries = readdirSync(sitePackagesPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".dist-info") || entry.name.endsWith(".egg-info")) continue;
      if (entry.name === "__pycache__") continue;
      count++;
    }
    return count;
  } catch {
    return undefined;
  }
}

interface CacheRow {
  hash: string;
  path: string;
  sizeBytes: number;
  packageCount: number | undefined;
  lastUsedMs: number;
}

/** Scan the cache root and return every non-orphan entry, sorted by mtime desc. */
export function scanCacheEntries(rootDir: string = defaultRootDir()): CacheRow[] {
  if (!existsSync(rootDir)) return [];
  const dirEntries = readdirSync(rootDir, { withFileTypes: true });
  const rows: CacheRow[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".tmp-")) continue;
    const path = join(rootDir, entry.name);
    let lastUsedMs = 0;
    try {
      lastUsedMs = statSync(path).mtimeMs;
    } catch {
      // Skip stat failure.
    }
    rows.push({
      hash: entry.name,
      path,
      sizeBytes: directorySizeBytes(path),
      packageCount: countPackages(path),
      lastUsedMs,
    });
  }
  rows.sort((a, b) => b.lastUsedMs - a.lastUsedMs);
  return rows;
}

/** Render the cache list as a fixed-width table to stdout. */
export function renderCacheTable(rows: CacheRow[]): string {
  if (rows.length === 0) return "No cache entries.";
  const lines: string[] = [];
  lines.push("HASH         SIZE       PACKAGES   LAST USED");
  lines.push("------------ ---------- ---------- ---------------");
  let totalBytes = 0;
  let totalPackages = 0;
  let unknownPackages = false;
  for (const row of rows) {
    const hashShort = row.hash.slice(0, 12);
    const sizeStr = formatBytes(row.sizeBytes).padEnd(10);
    const pkgStr =
      row.packageCount === undefined ? "?         " : String(row.packageCount).padEnd(10);
    const usedStr = formatRelativeTime(row.lastUsedMs);
    lines.push(`${hashShort} ${sizeStr} ${pkgStr} ${usedStr}`);
    totalBytes += row.sizeBytes;
    if (row.packageCount === undefined) {
      unknownPackages = true;
    } else {
      totalPackages += row.packageCount;
    }
  }
  lines.push("------------ ---------- ---------- ---------------");
  const totalSize = formatBytes(totalBytes).padEnd(10);
  const totalPkgs = unknownPackages ? `${totalPackages}+?` : String(totalPackages);
  lines.push(`${rows.length} entries     ${totalSize} ${totalPkgs}`);
  return lines.join("\n");
}

/** Recursive delete of all entries (including `.tmp-*` orphans). */
export function clearCacheEntries(rootDir: string = defaultRootDir()): {
  deletedCount: number;
  freedBytes: number;
} {
  if (!existsSync(rootDir)) return { deletedCount: 0, freedBytes: 0 };
  const entries = readdirSync(rootDir, { withFileTypes: true });
  let deletedCount = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(rootDir, entry.name);
    const isOrphan = entry.name.startsWith(".tmp-");
    if (!isOrphan) {
      freedBytes += directorySizeBytes(path);
      deletedCount++;
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
  return { deletedCount, freedBytes };
}

/** Sum of bytes across all hash entries (excludes orphans). */
function totalCacheSize(rootDir: string): number {
  if (!existsSync(rootDir)) return 0;
  const entries = readdirSync(rootDir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".tmp-")) continue;
    total += directorySizeBytes(join(rootDir, entry.name));
  }
  return total;
}

export function registerCacheCommand(program: Command): void {
  const cache = program.command("cache").description("Manage the script dependency cache");

  cache
    .command("list")
    .description("List all cached dependency entries")
    .action(() => {
      const rootDir = defaultRootDir();
      const rows = scanCacheEntries(rootDir);
      console.log(renderCacheTable(rows));
    });

  cache
    .command("clear")
    .description("Delete every entry from the script dependency cache")
    .option("-y, --yes", "Skip the confirmation prompt above 100 MB")
    .action(async (opts) => {
      const rootDir = defaultRootDir();
      const totalBytes = totalCacheSize(rootDir);

      if (totalBytes > CONFIRM_THRESHOLD_BYTES && !opts.yes) {
        const { confirm } = await import("@clack/prompts");
        const answer = await confirm({
          message: `Cache is ${formatBytes(totalBytes)}. Delete all entries?`,
          initialValue: false,
        });
        if (answer !== true) {
          format.info("Aborted. Nothing was deleted.");
          return;
        }
      }

      const result = clearCacheEntries(rootDir);
      format.success(
        `Cleared ${result.deletedCount} entries (${formatBytes(result.freedBytes)} freed).`,
      );
    });
}
