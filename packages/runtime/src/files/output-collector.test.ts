import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectOutputFiles } from "./output-collector.js";

describe("collectOutputFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-output-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scans dir with multiple files and returns sorted FileInfo (VT-1)", () => {
    writeFileSync(join(dir, "report.pdf"), Buffer.alloc(1024)); // 1KB
    writeFileSync(join(dir, "data.csv"), Buffer.alloc(500)); // 500B

    const files = collectOutputFiles(dir);

    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("data.csv");
    expect(files[0].size).toBe(500);
    expect(files[1].name).toBe("report.pdf");
    expect(files[1].size).toBe(1024);
  });

  it("returns empty array for empty dir (VT-2)", () => {
    const files = collectOutputFiles(dir);
    expect(files).toEqual([]);
  });

  it("returns empty array for non-existent dir", () => {
    const files = collectOutputFiles("/tmp/does-not-exist-xyz");
    expect(files).toEqual([]);
  });

  it("excludes files exceeding size limit (VT-3)", () => {
    writeFileSync(join(dir, "small.txt"), Buffer.alloc(100));
    writeFileSync(join(dir, "huge.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2MB

    const files = collectOutputFiles(dir, { maxSizeMB: 1 });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("small.txt");
  });

  it("caps at max count (VT-4)", () => {
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, `file-${String(i).padStart(2, "0")}.txt`), "data");
    }

    const files = collectOutputFiles(dir, { maxCount: 20 });

    expect(files).toHaveLength(20);
    expect(files[0].name).toBe("file-00.txt");
    expect(files[19].name).toBe("file-19.txt");
  });

  it("skips directories inside output dir", () => {
    writeFileSync(join(dir, "file.txt"), "data");
    mkdirSync(join(dir, "subdir"));

    const files = collectOutputFiles(dir);

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("file.txt");
  });
});
