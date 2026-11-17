import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  BundleDecompressedTooLargeError,
  BundleEntryError,
  packAgentTar,
  type UnpackedAgentEntry,
  unpackAgentTar,
} from "@skrun-dev/schema";
import { type Headers, pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleWriteError, extractBundleToDisk, extractFiles } from "./bundle.js";

// The codec as it is, watched: a test reads which entries it collected.
vi.mock("@skrun-dev/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/schema")>();
  return { ...actual, unpackAgentTar: vi.fn(actual.unpackAgentTar) };
});

// The filesystem as it is, watched: a test makes it refuse the extraction's writes.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

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
    const files = await extractFiles(gz, ["hello.txt"]);
    expect(files["hello.txt"]).toBe("world");
  });

  it("reads only the named files: the codec reads the others past, never collecting them nor turning them into text", async () => {
    const unpack = vi.mocked(unpackAgentTar);
    unpack.mockClear();
    const gz = await packAgentTar([
      { name: "assets/model.bin", content: Buffer.alloc(64 * 1024, 0xff) },
      { name: "agent.yaml", content: Buffer.from("name: x\n") },
      { name: "SKILL.md", content: Buffer.from("# x") },
    ]);
    const files = await extractFiles(gz, ["agent.yaml", "AGENTS.md"]);
    expect(files).toEqual({ "agent.yaml": "name: x\n" });
    const collected = (await unpack.mock.results[0]?.value) as UnpackedAgentEntry[];
    expect(collected.map((entry) => entry.name)).toEqual(["agent.yaml"]);
  });

  // A path that climbs out with `..`: the codec refuses its archive — the
  // cloud sandbox's tar refuses such an entry, so no run could load it.
  it("refuses an archive with a path-traversal entry, even named", async () => {
    const gz = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from("name: x\n") },
      { name: "../escape.txt", content: Buffer.from("leak") },
    ]);
    const read = extractFiles(gz, ["agent.yaml", "../escape.txt"]);
    await expect(read).rejects.toBeInstanceOf(BundleEntryError);
    await expect(read).rejects.toMatchObject({ entry: "../escape.txt" });
  });

  it("skips an absolute name, even named", async () => {
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# ok") },
      { name: "/etc/escape.txt", content: Buffer.from("leak") },
    ]);
    const files = await extractFiles(gz, ["SKILL.md", "/etc/escape.txt"]);
    expect(files).toEqual({ "SKILL.md": "# ok" });
  });

  it("skips symlink entries even when the target escapes, even named (VT-7)", async () => {
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# ok") },
      { name: "evil", type: "symlink", linkname: "../../etc/passwd" },
    ]);
    const files = await extractFiles(gz, ["SKILL.md", "evil"]);
    expect(files["SKILL.md"]).toBe("# ok");
    expect(files.evil).toBeUndefined();
  });

  // VT-14 (SEC-010): the gzip-bomb fixture decompresses to ~60 MB, exceeding the
  // 50 MB default cap. Must reject with the codec's typed error, which carries
  // the cap, instead of allocating 60 MB and (worst-case at a higher ratio)
  // OOMing — whichever files are asked for: the cap judges the whole archive.
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
      const read = extractFiles(bombGz, ["agent.yaml"]);
      await expect(read).rejects.toBeInstanceOf(BundleDecompressedTooLargeError);
      await expect(read).rejects.toMatchObject({ maxBytes: 50 * 1024 * 1024 });
    });

    it("VT-14: BUNDLE_MAX_DECOMPRESSED_MB raises the cap when operators need bigger bundles", async () => {
      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "100"; // 100 MB > 60 MB fixture
      const bombGz = readFileSync(bombPath());
      // Decompresses to 60 MB of zeros → tar-stream reads it as an empty archive.
      // Important: it does not throw the bomb defense error.
      const files = await extractFiles(bombGz, ["agent.yaml"]);
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

  it("skips symlink + absolute entries on disk", async () => {
    const gz = await packRaw([
      { name: "SKILL.md", content: Buffer.from("# ok") },
      { name: "evil", type: "symlink", linkname: "../../etc/passwd" },
      { name: "/escape.txt", content: Buffer.from("leak") },
    ]);
    const { dir, files, cleanup } = await extractBundleToDisk(gz);
    try {
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "evil"))).toBe(false);
      expect(existsSync(join(dir, "escape.txt"))).toBe(false);
      expect(files).toEqual({ "SKILL.md": "# ok" });
    } finally {
      cleanup();
    }
  });

  // The standard `tar` writes an entry for each directory it packs — skrun
  // build writes none. Each makes its directory, an empty one included; none
  // is written as a file.
  it("makes the directory of a directory entry, as a bundle the standard tar makes carries", async () => {
    const gz = await packRaw([
      { name: "agent.yaml", content: Buffer.from("name: x\n") },
      { name: "SKILL.md", content: Buffer.from("# skill\n") },
      { name: "scripts/", type: "directory" },
      { name: "scripts/run.py", content: Buffer.from("print(1)\n") },
      { name: "assets/", type: "directory" },
    ]);
    const { dir, files, cleanup } = await extractBundleToDisk(gz);
    try {
      expect(readFileSync(join(dir, "scripts", "run.py"), "utf-8")).toBe("print(1)\n");
      expect(statSync(join(dir, "scripts")).isDirectory()).toBe(true);
      expect(statSync(join(dir, "assets")).isDirectory()).toBe(true);
      expect(readdirSync(join(dir, "assets"))).toEqual([]);
      expect(files).toEqual({ "agent.yaml": "name: x\n", "SKILL.md": "# skill\n" });
    } finally {
      cleanup();
    }
  });

  // What a run reads as text is its three manifests: the text of every other
  // file — a binary asset turned into a string twice its size — would be held
  // by the run cache for nothing.
  it("writes every file to disk, and keeps the text of the three manifests only", async () => {
    const gz = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from("name: x\n") },
      { name: "SKILL.md", content: Buffer.from("# skill\n") },
      { name: "AGENTS.md", content: Buffer.from("# context\n") },
      { name: "scripts/run.py", content: Buffer.from("print(1)\n") },
      { name: "assets/blob.bin", content: Buffer.alloc(64 * 1024, 0xff) },
      { name: "docs/SKILL.md", content: Buffer.from("# not the agent's\n") },
    ]);
    const { dir, files, cleanup } = await extractBundleToDisk(gz);
    try {
      expect(files).toEqual({
        "agent.yaml": "name: x\n",
        "SKILL.md": "# skill\n",
        "AGENTS.md": "# context\n",
      });
      expect(readFileSync(join(dir, "scripts", "run.py"), "utf-8")).toBe("print(1)\n");
      expect(readFileSync(join(dir, "assets", "blob.bin")).length).toBe(64 * 1024);
      expect(readFileSync(join(dir, "docs", "SKILL.md"), "utf-8")).toBe("# not the agent's\n");
    } finally {
      cleanup();
    }
  });

  describe("an extraction that fails", () => {
    let root: string;
    let actualWriteFileSync: typeof writeFileSync;

    beforeEach(async () => {
      // A temp root of the case's own: `os.tmpdir()` reads these at every call.
      root = mkdtempSync(join(tmpdir(), "skrun-extract-fails-"));
      for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
      actualWriteFileSync = (await vi.importActual<typeof import("node:fs")>("node:fs"))
        .writeFileSync;
    });

    afterEach(() => {
      vi.mocked(writeFileSync).mockImplementation(actualWriteFileSync);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });

    it("rejects with BundleWriteError when the disk refuses a write: the filesystem's code, never its path, and nothing left", async () => {
      const gz = await packAgentTar([
        { name: "SKILL.md", content: Buffer.from("# ok") },
        { name: "scripts/private-report-builder.py", content: Buffer.from("print(1)\n") },
      ]);
      const refusal = Object.assign(
        new Error(
          `ENOSPC: no space left on device, write '${root}/scripts/private-report-builder.py'`,
        ),
        { code: "ENOSPC", errno: -28, syscall: "write" },
      );
      vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
        if (String(file).includes("private-report-builder")) throw refusal;
        actualWriteFileSync(file, data, options);
      });

      const read = extractBundleToDisk(gz);
      await expect(read).rejects.toBeInstanceOf(BundleWriteError);
      await expect(read).rejects.toMatchObject({ code: "ENOSPC", cause: refusal });
      await expect(read).rejects.not.toHaveProperty(
        "message",
        expect.stringContaining("private-report-builder"),
      );
      // The directory written so far — SKILL.md was — is removed.
      expect(readdirSync(root)).toEqual([]);
    });

    // A file `scripts/run`, then `scripts/run/helper.py`: a valid archive no
    // filesystem can write out. The codec refuses it before the first write —
    // a bundle stored before the push refused it —, never the filesystem.
    it("rejects with BundleEntryError for entries that contradict each other, before anything is written", async () => {
      const gz = await packAgentTar([
        { name: "SKILL.md", content: Buffer.from("# ok") },
        { name: "scripts/run", content: Buffer.from("#!/bin/sh\n") },
        { name: "scripts/run/helper.py", content: Buffer.from("print(1)\n") },
      ]);
      vi.mocked(writeFileSync).mockClear();
      const read = extractBundleToDisk(gz);
      await expect(read).rejects.toBeInstanceOf(BundleEntryError);
      await expect(read).rejects.not.toBeInstanceOf(BundleWriteError);
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    });

    it("rejects with the decoder's own error for an archive that does not read, and writes nothing", async () => {
      const read = extractBundleToDisk(Buffer.from("not a bundle"));
      await expect(read).rejects.toBeInstanceOf(Error);
      await expect(read).rejects.not.toBeInstanceOf(BundleWriteError);
      await expect(read).rejects.not.toBeInstanceOf(BundleDecompressedTooLargeError);
      expect(readdirSync(root)).toEqual([]);
    });
  });
});
