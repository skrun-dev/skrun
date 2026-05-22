import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractFiles } from "./bundle.js";

// Minimal tar builder for the happy-path tests. Real bundles are produced by
// the CLI; we just need enough structure here to round-trip an extractFiles().
function tarOne(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf-8");
  const sizeOctal = content.length.toString(8).padStart(11, "0");
  header.write(sizeOctal, 124, "utf-8");
  const contentBuf = Buffer.from(content, "utf-8");
  const padLen = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, contentBuf, Buffer.alloc(padLen), Buffer.alloc(1024)]);
}

describe("extractFiles", () => {
  it("decompresses + extracts a tiny single-file bundle", () => {
    const tar = tarOne("hello.txt", "world");
    const gz = gzipSync(tar);
    const files = extractFiles(gz);
    expect(files["hello.txt"]).toBe("world");
  });

  it("skips path-traversal entries (../escape.txt)", () => {
    const tar = tarOne("../escape.txt", "leak");
    const gz = gzipSync(tar);
    const files = extractFiles(gz);
    expect(files["../escape.txt"]).toBeUndefined();
  });

  // VT-14 (SEC-010): the gzip-bomb fixture decompresses to ~60 MB, exceeding
  // the 50 MB default cap. Must throw a clear "gzip-bomb defense" error
  // instead of allocating 60 MB and (worst-case at a higher ratio) OOMing.
  describe("gzip-bomb defense (SEC-010)", () => {
    const previousCap = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
    afterEach(() => {
      if (previousCap === undefined) delete process.env.BUNDLE_MAX_DECOMPRESSED_MB;
      else process.env.BUNDLE_MAX_DECOMPRESSED_MB = previousCap;
    });

    it("VT-14: rejects a bundle whose decompressed size exceeds the cap", () => {
      const bombPath = join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "tests",
        "fixtures",
        "gzip-bomb-50mb.gz",
      );
      const bombGz = readFileSync(bombPath);
      // Sanity: the .gz on disk is tiny but decompresses huge.
      expect(bombGz.length).toBeLessThan(200 * 1024); // < 200 KB on disk
      expect(() => extractFiles(bombGz)).toThrow(/gzip-bomb defense/);
    });

    it("VT-14: BUNDLE_MAX_DECOMPRESSED_MB raises the cap when operators need bigger bundles", () => {
      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "100"; // 100 MB > 60 MB fixture
      const bombPath = join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "tests",
        "fixtures",
        "gzip-bomb-50mb.gz",
      );
      const bombGz = readFileSync(bombPath);
      // The decompression succeeds (no throw); the result is a 60 MB buffer of
      // zeros, which extractFiles parses as a tar — empty (no valid tar
      // entries). Important: it does not throw the bomb defense error.
      const files = extractFiles(bombGz);
      expect(Object.keys(files)).toHaveLength(0);
    });
  });
});
