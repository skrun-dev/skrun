// Unit tests for `skrun cache list` / `skrun cache clear` (#57 Tasks 6.1 + 6.2).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCacheEntries, renderCacheTable, scanCacheEntries } from "./cache.js";

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "skrun-cli-cache-test-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function writeIn(relativePath: string, content: string): void {
  const full = join(rootDir, relativePath);
  const parent = dirname(full);
  if (parent !== rootDir) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("scanCacheEntries", () => {
  it("returns [] when rootDir does not exist", () => {
    expect(scanCacheEntries(join(rootDir, "missing"))).toEqual([]);
  });

  it("returns [] on an empty rootDir", () => {
    expect(scanCacheEntries(rootDir)).toEqual([]);
  });

  it("returns one row per non-tmp directory", () => {
    mkdirSync(join(rootDir, HASH_A));
    mkdirSync(join(rootDir, HASH_B));
    writeIn(`${HASH_A}/marker.txt`, "x");

    const rows = scanCacheEntries(rootDir);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.hash))).toEqual(new Set([HASH_A, HASH_B]));
  });

  it("skips .tmp-* orphan dirs", () => {
    mkdirSync(join(rootDir, HASH_A));
    mkdirSync(join(rootDir, ".tmp-orphan-1234"));
    writeIn(".tmp-orphan-1234/leftover.txt", "x");

    const rows = scanCacheEntries(rootDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBe(HASH_A);
  });

  it("counts Node packages from node_modules/ and ignores dotted dirs", () => {
    mkdirSync(join(rootDir, HASH_A, "node_modules", "jszip"), { recursive: true });
    writeIn(`${HASH_A}/node_modules/jszip/package.json`, "{}");
    mkdirSync(join(rootDir, HASH_A, "node_modules", "lodash"), { recursive: true });
    mkdirSync(join(rootDir, HASH_A, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(rootDir, HASH_A, "node_modules", ".cache"), { recursive: true });

    const rows = scanCacheEntries(rootDir);
    expect(rows[0]?.packageCount).toBe(2);
  });

  it("expands @scope/* packages to per-package count", () => {
    mkdirSync(join(rootDir, HASH_A, "node_modules", "@skrun-dev", "schema"), { recursive: true });
    mkdirSync(join(rootDir, HASH_A, "node_modules", "@skrun-dev", "runtime"), { recursive: true });
    mkdirSync(join(rootDir, HASH_A, "node_modules", "jszip"), { recursive: true });

    const rows = scanCacheEntries(rootDir);
    expect(rows[0]?.packageCount).toBe(3); // 2 scoped + 1 plain
  });

  it("counts Python packages from venv/lib/python*/site-packages (Unix layout)", () => {
    mkdirSync(join(rootDir, HASH_A, "venv", "bin"), { recursive: true });
    writeIn(`${HASH_A}/venv/bin/python`, "");
    mkdirSync(join(rootDir, HASH_A, "venv", "lib", "python3.11", "site-packages", "pandas"), {
      recursive: true,
    });
    mkdirSync(join(rootDir, HASH_A, "venv", "lib", "python3.11", "site-packages", "numpy"), {
      recursive: true,
    });
    mkdirSync(
      join(rootDir, HASH_A, "venv", "lib", "python3.11", "site-packages", "pandas-2.2.3.dist-info"),
      { recursive: true },
    );

    const rows = scanCacheEntries(rootDir);
    // pandas + numpy. dist-info is excluded.
    expect(rows[0]?.packageCount).toBe(2);
  });

  it("counts Python packages from venv/Lib/site-packages (Windows layout)", () => {
    // Simulate a Windows venv: Scripts/ (not bin/) + Lib/site-packages.
    mkdirSync(join(rootDir, HASH_A, "venv", "Scripts"), { recursive: true });
    writeIn(`${HASH_A}/venv/Scripts/python.exe`, "");
    mkdirSync(join(rootDir, HASH_A, "venv", "Lib", "site-packages", "pandas"), { recursive: true });
    mkdirSync(join(rootDir, HASH_A, "venv", "Lib", "site-packages", "matplotlib"), {
      recursive: true,
    });
    mkdirSync(join(rootDir, HASH_A, "venv", "Lib", "site-packages", "__pycache__"), {
      recursive: true,
    });

    const rows = scanCacheEntries(rootDir);
    // pandas + matplotlib. __pycache__ excluded.
    expect(rows[0]?.packageCount).toBe(2);
  });

  it("returns undefined packageCount when no node_modules / venv is found", () => {
    mkdirSync(join(rootDir, HASH_A));
    writeIn(`${HASH_A}/random.txt`, "x");

    const rows = scanCacheEntries(rootDir);
    expect(rows[0]?.packageCount).toBeUndefined();
  });

  it("computes recursive sizeBytes including nested files", () => {
    mkdirSync(join(rootDir, HASH_A, "deep", "nested"), { recursive: true });
    writeIn(`${HASH_A}/top.txt`, "abc"); // 3 bytes
    writeIn(`${HASH_A}/deep/mid.txt`, "1234567"); // 7 bytes
    writeIn(`${HASH_A}/deep/nested/leaf.txt`, "12"); // 2 bytes

    const rows = scanCacheEntries(rootDir);
    expect(rows[0]?.sizeBytes).toBe(12);
  });

  it("sorts entries by lastUsedMs descending", () => {
    mkdirSync(join(rootDir, HASH_A));
    mkdirSync(join(rootDir, HASH_B));
    // Force explicit timestamps so the test is deterministic regardless of
    // mtime granularity (Windows ~100ns; ext4 ~1ns; some FAT/NTFS configs 2s).
    const now = Date.now() / 1000;
    utimesSync(join(rootDir, HASH_A), now - 100, now - 100); // 100s ago
    utimesSync(join(rootDir, HASH_B), now, now); // now

    const rows = scanCacheEntries(rootDir);
    expect(rows[0]?.hash).toBe(HASH_B);
    expect(rows[1]?.hash).toBe(HASH_A);
  });
});

describe("renderCacheTable", () => {
  it("renders 'No cache entries.' on empty input", () => {
    expect(renderCacheTable([])).toBe("No cache entries.");
  });

  it("renders header + rows + total when entries exist", () => {
    const output = renderCacheTable([
      {
        hash: "a".repeat(64),
        path: "/fake/path/a",
        sizeBytes: 1024,
        packageCount: 5,
        lastUsedMs: Date.now() - 1000,
      },
    ]);
    expect(output).toMatch(/HASH/);
    expect(output).toMatch(/SIZE/);
    expect(output).toMatch(/PACKAGES/);
    expect(output).toMatch(/LAST USED/);
    // 12-char hash short form
    expect(output).toContain("aaaaaaaaaaaa");
    // size formatted
    expect(output).toMatch(/1\.0 KB/);
    // package count
    expect(output).toMatch(/\b5\b/);
    // total row
    expect(output).toMatch(/1 entries/);
  });

  it("renders '?' for unknown package count and totals as 0+?", () => {
    const output = renderCacheTable([
      {
        hash: "a".repeat(64),
        path: "/fake/path/a",
        sizeBytes: 100,
        packageCount: undefined,
        lastUsedMs: Date.now(),
      },
    ]);
    expect(output).toContain("?");
    expect(output).toMatch(/0\+\?/);
  });
});

describe("clearCacheEntries", () => {
  it("returns 0/0 when rootDir does not exist", () => {
    const result = clearCacheEntries(join(rootDir, "missing"));
    expect(result).toEqual({ deletedCount: 0, freedBytes: 0 });
  });

  it("returns 0/0 on empty rootDir", () => {
    const result = clearCacheEntries(rootDir);
    expect(result).toEqual({ deletedCount: 0, freedBytes: 0 });
  });

  it("deletes all hash entries and reports count + bytes", () => {
    mkdirSync(join(rootDir, HASH_A));
    writeIn(`${HASH_A}/file.txt`, "hello"); // 5 bytes
    mkdirSync(join(rootDir, HASH_B));
    writeIn(`${HASH_B}/file.txt`, "world!!!"); // 8 bytes

    const result = clearCacheEntries(rootDir);
    expect(result.deletedCount).toBe(2);
    expect(result.freedBytes).toBe(13);
    expect(readdirSync(rootDir)).toEqual([]);
  });

  it("also deletes .tmp-* orphans (silent — not counted)", () => {
    mkdirSync(join(rootDir, HASH_A));
    writeIn(`${HASH_A}/x`, "x"); // 1 byte
    mkdirSync(join(rootDir, ".tmp-orphan-1234"));
    writeIn(".tmp-orphan-1234/y", "y"); // not counted but deleted

    const result = clearCacheEntries(rootDir);
    expect(result.deletedCount).toBe(1); // orphan not counted
    expect(result.freedBytes).toBe(1); // only HASH_A's bytes counted
    expect(readdirSync(rootDir)).toEqual([]); // both gone
  });

  it("ignores files at the root (not directories)", () => {
    mkdirSync(join(rootDir, HASH_A));
    writeIn(`${HASH_A}/x`, "x");
    writeIn("loose-file.txt", "stray");

    const result = clearCacheEntries(rootDir);
    expect(result.deletedCount).toBe(1);
    expect(existsSync(join(rootDir, "loose-file.txt"))).toBe(true); // file preserved
  });
});
