import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectOutputFiles, collectOutputFilesWithExclusions } from "./output-collector.js";

describe("collectOutputFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-output-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scans dir with multiple files and returns sorted FileInfo", () => {
    writeFileSync(join(dir, "report.pdf"), Buffer.alloc(1024)); // 1KB
    writeFileSync(join(dir, "data.csv"), Buffer.alloc(500)); // 500B

    const files = collectOutputFiles(dir);

    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("data.csv");
    expect(files[0].size).toBe(500);
    expect(files[1].name).toBe("report.pdf");
    expect(files[1].size).toBe(1024);
  });

  it("returns empty array for empty dir", () => {
    const files = collectOutputFiles(dir);
    expect(files).toEqual([]);
  });

  it("returns empty array for non-existent dir", () => {
    const files = collectOutputFiles("/tmp/does-not-exist-xyz");
    expect(files).toEqual([]);
  });

  it("excludes files exceeding size limit", () => {
    writeFileSync(join(dir, "small.txt"), Buffer.alloc(100));
    writeFileSync(join(dir, "huge.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2MB

    const files = collectOutputFiles(dir, { maxSizeMB: 1 });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("small.txt");
  });

  it("caps at max count", () => {
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, `file-${String(i).padStart(2, "0")}.txt`), "data");
    }

    const files = collectOutputFiles(dir, { maxCount: 20 });

    expect(files).toHaveLength(20);
    expect(files[0].name).toBe("file-00.txt");
    expect(files[19].name).toBe("file-19.txt");
  });

  it("takes its limits from the environment, through the shared reader", () => {
    const saved = { size: process.env.FILES_MAX_SIZE_MB, count: process.env.FILES_MAX_COUNT };
    try {
      for (let i = 0; i < 3; i++) writeFileSync(join(dir, `f-${i}.txt`), "data");
      process.env.FILES_MAX_COUNT = "2";
      expect(collectOutputFiles(dir).map((f) => f.name)).toEqual(["f-0.txt", "f-1.txt"]);

      // A count past its bound is read as the bound, not refused: all three kept.
      process.env.FILES_MAX_COUNT = "50000";
      expect(collectOutputFiles(dir)).toHaveLength(3);

      // Zero falls back to the default; an explicit option still wins.
      process.env.FILES_MAX_COUNT = "0";
      expect(collectOutputFiles(dir)).toHaveLength(3);
      expect(collectOutputFiles(dir, { maxCount: 1 })).toHaveLength(1);
    } finally {
      for (const [name, value] of [
        ["FILES_MAX_SIZE_MB", saved.size],
        ["FILES_MAX_COUNT", saved.count],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("counts what it leaves out, once each, by reason — a large file past the count included", () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f-${i}.txt`), "data");
    writeFileSync(join(dir, "zz-big.bin"), Buffer.alloc(2 * 1024 * 1024));

    const collected = collectOutputFilesWithExclusions(dir, { maxSizeMB: 1, maxCount: 3 });

    expect(collected.files.map((f) => f.name)).toEqual(["f-0.txt", "f-1.txt", "f-2.txt"]);
    expect(collected.excluded).toEqual({ name_refused: 0, too_large: 1, over_count: 2 });
    expect(collectOutputFiles(dir, { maxSizeMB: 1, maxCount: 3 }).map((f) => f.name)).toEqual(
      collected.files.map((f) => f.name),
    );
  });

  // Which refused name a file system holds depends on it: a control character
  // is a valid name on Linux, not on Windows; 200 three-byte characters (600
  // bytes of UTF-8) fit a Windows name, not a Linux one (255 bytes). Each case
  // runs where its file can exist.
  it.skipIf(process.platform === "win32")(
    "leaves out a file whose name holds a control character, and counts it",
    () => {
      writeFileSync(join(dir, "ok.txt"), "data");
      writeFileSync(join(dir, "tab\there.txt"), "data");

      const collected = collectOutputFilesWithExclusions(dir);

      expect(collected.files.map((f) => f.name)).toEqual(["ok.txt"]);
      expect(collected.excluded).toEqual({ name_refused: 1, too_large: 0, over_count: 0 });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "leaves out a file whose name runs past 512 bytes of UTF-8, and counts it",
    () => {
      writeFileSync(join(dir, "ok.txt"), "data");
      writeFileSync(join(dir, `${"€".repeat(200)}.txt`), "data");

      const collected = collectOutputFilesWithExclusions(dir);

      expect(collected.files.map((f) => f.name)).toEqual(["ok.txt"]);
      expect(collected.excluded).toEqual({ name_refused: 1, too_large: 0, over_count: 0 });
    },
  );

  it("counts nothing for a directory that does not exist", () => {
    expect(collectOutputFilesWithExclusions(join(dir, "missing"))).toEqual({
      files: [],
      excluded: { name_refused: 0, too_large: 0, over_count: 0 },
    });
  });

  it("skips directories inside output dir", () => {
    writeFileSync(join(dir, "file.txt"), "data");
    mkdirSync(join(dir, "subdir"));

    const files = collectOutputFiles(dir);

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("file.txt");
  });

  // Symbolic links must not be served as run output files.
  // A malicious script could `ln -s /etc/passwd output/leak.txt` and the file
  // routes would otherwise expose the linked content.
  it("rejects symlinks (skip with warning, don't follow)", () => {
    writeFileSync(join(dir, "real.txt"), "real content");

    // Symlink pointing to a "system" file outside the output dir
    const target = join(dir, "real.txt");
    const linkPath = join(dir, "leak.txt");
    try {
      symlinkSync(target, linkPath);
    } catch (err) {
      // Windows requires elevated rights for symlinkSync by default.
      // Skip the assertion if symlink creation fails — the production check
      // still applies (lstatSync detects whatever the FS gives back).
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    const files = collectOutputFiles(dir);
    // Only the real file should be present, not the symlink.
    expect(files.map((f) => f.name)).toEqual(["real.txt"]);
  });
});
