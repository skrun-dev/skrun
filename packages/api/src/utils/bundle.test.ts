import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { packAgentTar } from "@skrun-dev/schema";
import { type Headers, pack as tarPack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { extractBundleToDisk, extractFiles } from "./bundle.js";

// Build a gzipped tar with arbitrary entries (incl. a symlink) for the reader's
// security tests — packAgentTar only emits regular files, so we drop to tar-stream.
function packRaw(
  entries: Array<{ name: string; type?: Headers["type"]; linkname?: string; content?: Buffer }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
    for (const e of entries) {
      const content = e.content ?? Buffer.alloc(0);
      pack.entry(
        {
          name: e.name,
          type: e.type ?? "file",
          linkname: e.linkname,
          size: content.length,
          mtime: new Date(0),
        },
        content,
      );
    }
    pack.finalize();
  });
}

describe("extractFiles", () => {
  it("decompresses + extracts a tiny single-file bundle (VT-2)", async () => {
    const gz = await packAgentTar([{ name: "hello.txt", content: Buffer.from("world") }]);
    const files = await extractFiles(gz);
    expect(files["hello.txt"]).toBe("world");
  });

  it("skips path-traversal entries (VT-5)", async () => {
    const gz = await packAgentTar([{ name: "../escape.txt", content: Buffer.from("leak") }]);
    const files = await extractFiles(gz);
    expect(files["../escape.txt"]).toBeUndefined();
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("skips symlink entries even when the target escapes (VT-7)", async () => {
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# ok") },
      { name: "evil", type: "symlink", linkname: "../../etc/passwd" },
    ]);
    const files = await extractFiles(gz);
    expect(files["SKILL.md"]).toBe("# ok");
    expect(files.evil).toBeUndefined();
  });

  // VT-14 (SEC-010): the gzip-bomb fixture decompresses to ~60 MB, exceeding the
  // 50 MB default cap. Must reject with a clear "gzip-bomb defense" error instead
  // of allocating 60 MB and (worst-case at a higher ratio) OOMing.
  describe("gzip-bomb defense (SEC-010)", () => {
    const previousCap = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
    afterEach(() => {
      if (previousCap === undefined) delete process.env.BUNDLE_MAX_DECOMPRESSED_MB;
      else process.env.BUNDLE_MAX_DECOMPRESSED_MB = previousCap;
    });

    const bombPath = () =>
      join(import.meta.dirname, "..", "..", "..", "..", "tests", "fixtures", "gzip-bomb-50mb.gz");

    it("VT-14: rejects a bundle whose decompressed size exceeds the cap", async () => {
      const bombGz = readFileSync(bombPath());
      // Sanity: the .gz on disk is tiny but decompresses huge.
      expect(bombGz.length).toBeLessThan(200 * 1024); // < 200 KB on disk
      await expect(extractFiles(bombGz)).rejects.toThrow(/gzip-bomb defense/);
    });

    it("VT-14: BUNDLE_MAX_DECOMPRESSED_MB raises the cap when operators need bigger bundles", async () => {
      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "100"; // 100 MB > 60 MB fixture
      const bombGz = readFileSync(bombPath());
      // Decompresses to 60 MB of zeros → tar-stream reads it as an empty archive.
      // Important: it does not throw the bomb defense error.
      const files = await extractFiles(bombGz);
      expect(Object.keys(files)).toHaveLength(0);
    });
  });
});

describe("extractBundleToDisk", () => {
  it("writes binary assets byte-identically to disk (VT-9 / SC-6)", async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const gz = await packAgentTar([
      { name: "SKILL.md", content: Buffer.from("# hi") },
      { name: "assets/logo.bin", content: bin },
    ]);
    const { dir, files, cleanup } = await extractBundleToDisk(gz);
    try {
      const onDisk = readFileSync(join(dir, "assets", "logo.bin"));
      expect(onDisk.equals(bin)).toBe(true); // raw bytes, not utf-8-mangled
      expect(files["SKILL.md"]).toBe("# hi"); // text map still available for manifests
    } finally {
      cleanup();
    }
  });

  it("skips symlink + traversal entries on disk (VT-5 / VT-7)", async () => {
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# ok") },
      { name: "evil", type: "symlink", linkname: "../../etc/passwd" },
      { name: "../escape.txt", content: Buffer.from("leak") },
    ]);
    const { dir, files, cleanup } = await extractBundleToDisk(gz);
    try {
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "evil"))).toBe(false);
      expect(files["../escape.txt"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
