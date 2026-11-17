import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { type Headers, pack as tarPack } from "tar-stream";
import { describe, expect, it } from "vitest";
import {
  AGENT_BUNDLE_EXCLUDES,
  AGENT_YAML_MAX_BYTES,
  type AgentTarEntry,
  BundleDecompressedTooLargeError,
  BundleEntryError,
  DEFAULT_MAX_DECOMPRESSED_MB,
  DEFAULT_PUSH_MAX_BODY_MB,
  decompressedCapText,
  isExcludedEntry,
  isUnsafeName,
  maxDecompressedBytes,
  packAgentTar,
  readMbSetting,
  type UnpackedAgentEntry,
  unpackAgentTar,
} from "./bundle-tar.js";

const MAX = 50 * 1024 * 1024;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures");

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** An entry of an archive written by hand: any type, any name. */
interface RawEntry {
  name: string;
  type?: Headers["type"];
  linkname?: string;
  content?: Buffer;
}

/** A gzipped tar of `entries` as given — `packAgentTar` writes files only, its names cleaned. */
function packRaw(entries: RawEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
    for (const e of entries) {
      const type = e.type ?? "file";
      const content = type === "file" ? (e.content ?? Buffer.from(e.name)) : Buffer.alloc(0);
      pack.entry(
        { name: e.name, type, linkname: e.linkname, size: content.length, mtime: new Date(0) },
        content,
      );
    }
    pack.finalize();
  });
}

function contentOf(entries: UnpackedAgentEntry[], name: string): Buffer {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`entry not found: ${name}`);
  return entry.content;
}

describe("packAgentTar / unpackAgentTar", () => {
  it("normalises Windows backslash names to POSIX (VT-1)", async () => {
    const gz = await packAgentTar([{ name: "scripts\\foo.py", content: Buffer.from("x") }]);
    const entries = await unpackAgentTar(gz, { maxBytes: MAX });
    expect(entries.map((e) => e.name)).toEqual(["scripts/foo.py"]);
  });

  it("round-trips text and binary content byte-identically (VT-2)", async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const entries: AgentTarEntry[] = [
      { name: "SKILL.md", content: Buffer.from("# hi\n") },
      { name: "scripts/probe.py", content: Buffer.from("print(1)\n") },
      { name: "assets/logo.bin", content: bin },
    ];
    const out = await unpackAgentTar(await packAgentTar(entries), { maxBytes: MAX });
    expect(out.map((e) => e.name).sort()).toEqual([
      "SKILL.md",
      "assets/logo.bin",
      "scripts/probe.py",
    ]);
    expect(contentOf(out, "SKILL.md").toString()).toBe("# hi\n");
    expect(contentOf(out, "assets/logo.bin").equals(bin)).toBe(true);
  });

  it("is byte-deterministic, incl. a >100-byte name that triggers PAX (VT-10)", async () => {
    const entries: AgentTarEntry[] = [
      { name: "SKILL.md", content: Buffer.from("hi") },
      { name: `scripts/${"b".repeat(120)}.py`, content: Buffer.from("x") },
    ];
    const a = await packAgentTar(entries);
    const b = await packAgentTar(entries);
    expect(sha(a)).toBe(sha(b));
  });

  it("preserves a 100-byte name (VT-11)", async () => {
    const name = `d/${"a".repeat(98)}`; // 2 + 98 = 100 bytes
    const out = await unpackAgentTar(await packAgentTar([{ name, content: Buffer.from("x") }]), {
      maxBytes: MAX,
    });
    expect(out[0]?.name).toBe(name);
  });

  it("enforces the gzip-bomb decompression cap (VT-4): a typed rejection that carries the cap", async () => {
    const gz = await packAgentTar([{ name: "big.bin", content: Buffer.alloc(2 * 1024 * 1024, 1) }]);
    const read = unpackAgentTar(gz, { maxBytes: 1024 });
    await expect(read).rejects.toBeInstanceOf(BundleDecompressedTooLargeError);
    await expect(read).rejects.toMatchObject({
      code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
      maxBytes: 1024,
      message: expect.stringMatching(/exceeds 1024 bytes \(gzip-bomb defense/),
    });
  });

  it("rejects an archive that does not read with the decoder's own error, never the cap's", async () => {
    for (const unreadable of [
      Buffer.from("not gzip at all"),
      gzipSync(Buffer.from("gzip, but not a tar")),
      (await packAgentTar([{ name: "a", content: Buffer.alloc(4096, 7) }])).subarray(0, 30),
    ]) {
      const read = unpackAgentTar(unreadable, { maxBytes: MAX });
      await expect(read).rejects.toBeInstanceOf(Error);
      await expect(read).rejects.not.toBeInstanceOf(BundleDecompressedTooLargeError);
    }
  });

  describe("keep: only the entries it names are collected", () => {
    const big = Buffer.from(Array.from({ length: 300 * 1024 }, (_, i) => (i * 7919) % 256));

    it("collects the named entries whole, and leaves out the others", async () => {
      const gz = await packAgentTar([
        { name: "assets/big.bin", content: big },
        { name: "agent.yaml", content: Buffer.from("name: kept\n") },
        { name: "scripts/run.py", content: Buffer.from("print(1)\n") },
        { name: "SKILL.md", content: Buffer.from("# kept\n") },
      ]);
      const wanted = new Set(["agent.yaml", "SKILL.md", "AGENTS.md"]);
      const out = await unpackAgentTar(gz, { maxBytes: MAX, keep: (name) => wanted.has(name) });
      expect(out.map((e) => e.name)).toEqual(["agent.yaml", "SKILL.md"]);
      expect(contentOf(out, "agent.yaml").toString()).toBe("name: kept\n");
      expect(contentOf(out, "SKILL.md").toString()).toBe("# kept\n");
    });

    it("still judges the whole archive against the cap, entries it leaves out included", async () => {
      const gz = await packAgentTar([
        { name: "agent.yaml", content: Buffer.from("name: kept\n") },
        { name: "assets/big.bin", content: big },
      ]);
      const read = unpackAgentTar(gz, {
        maxBytes: 100 * 1024,
        keep: (name) => name === "agent.yaml",
      });
      await expect(read).rejects.toBeInstanceOf(BundleDecompressedTooLargeError);
    });
  });

  // Read as SKRUN_PUSH_MAX_BODY_MB is, by the same function: unset, the
  // default; a plain positive decimal number of MB; anything else refused,
  // the variable named — never the default in its place.
  describe("maxDecompressedBytes: the one reading of BUNDLE_MAX_DECOMPRESSED_MB", () => {
    const MIB = 1024 * 1024;

    it("defaults to 50 MB, the server's and the CLI's alike, when unset", () => {
      expect(DEFAULT_MAX_DECOMPRESSED_MB).toBe(50);
      expect(DEFAULT_PUSH_MAX_BODY_MB).toBe(50);
      // A fixed limit, no setting: the push refuses past it, build warns.
      expect(AGENT_YAML_MAX_BYTES).toBe(131_072);
      expect(maxDecompressedBytes(undefined)).toBe(50 * MIB);
    });

    it("takes a positive decimal number of MB, spaces around it ignored, floored to whole bytes", () => {
      expect(maxDecompressedBytes("200")).toBe(200 * MIB);
      expect(maxDecompressedBytes("1")).toBe(MIB);
      expect(maxDecompressedBytes(" 60 ")).toBe(60 * MIB);
      expect(maxDecompressedBytes("0.5")).toBe(524_288);
      expect(maxDecompressedBytes("2.")).toBe(2 * MIB);
      expect(maxDecompressedBytes(".5")).toBe(524_288);
      // 0.3 MB is 314,572.8 bytes: the cap is the whole bytes under it.
      expect(maxDecompressedBytes("0.3")).toBe(314_572);
    });

    it.each([
      "",
      " ",
      "abc",
      "0",
      "-5",
      "+5",
      "1e3",
      "0x10",
      "12,5",
      "80MB",
      "MB80",
      "Infinity",
      // Positive, and under one byte: a cap that would refuse every bundle.
      "0.0000001",
    ])("refuses %j, naming the variable and the default", (raw) => {
      expect(() => maxDecompressedBytes(raw)).toThrow(
        `BUNDLE_MAX_DECOMPRESSED_MB must be a positive decimal number of MB (got "${raw}"). Unset it to use the 50 MB default.`,
      );
    });

    it("throws a SkrunError whose code is INVALID_SETTING", () => {
      expect(() => readMbSetting("1e3", "SOME_MB", 7)).toThrow(
        expect.objectContaining({
          code: "INVALID_SETTING",
          message:
            'SOME_MB must be a positive decimal number of MB (got "1e3"). Unset it to use the 7 MB default.',
        }),
      );
      expect(readMbSetting(undefined, "SOME_MB", 7)).toBe(7);
    });
  });

  // What the server's extraction, the cloud sandbox's `tar -xzf` and `skrun
  // pull` cannot all write out (GNU tar 1.35 measured on each refused shape
  // but the NUL): refused by the reader every one of them shares, whatever
  // `keep` collects, the entry named.
  describe("an archive an entry of which cannot be written out", () => {
    const yaml = { name: "agent.yaml", content: Buffer.from("name: x\n") };
    const long = (bytes: number) => "a".repeat(bytes);
    const deep = (bytes: number) =>
      Array.from({ length: Math.ceil(bytes / 100) }, (_, i) => `${"d".repeat(97)}${i}`.slice(0, 99))
        .join("/")
        .slice(0, bytes);

    it.each<[string, RawEntry[], string, RegExp]>([
      [
        "a file, then a file under it",
        [yaml, { name: "x" }, { name: "x/y" }],
        "x/y",
        /needs "x" to be a directory/,
      ],
      [
        "a file under a path, then a file of it",
        [yaml, { name: "x/y" }, { name: "x" }],
        "x/y",
        /needs "x" to be a directory/,
      ],
      [
        "a file, then a directory under it",
        [yaml, { name: "a" }, { name: "a/b/", type: "directory" }],
        "a/b/",
        /needs "a" to be a directory/,
      ],
      [
        "a directory, then a file of its path",
        [yaml, { name: "x/", type: "directory" }, { name: "x" }],
        "x",
        /both a directory and a file/,
      ],
      [
        "a file, then a directory of its path",
        [yaml, { name: "x" }, { name: "x/", type: "directory" }],
        "x",
        /both a directory and a file/,
      ],
      [
        "a link, then a file under it",
        [yaml, { name: "x", type: "symlink", linkname: "y" }, { name: "x/z" }],
        "x/z",
        /needs "x" to be a directory/,
      ],
      [
        "two spellings of one path",
        [yaml, { name: "x" }, { name: "./x//y" }],
        "./x//y",
        /needs "x" to be a directory/,
      ],
      [
        "a name over 255 bytes",
        [yaml, { name: `d/${long(256)}` }],
        `d/${long(256)}`,
        /a name of 256 bytes between two "\/"; a file system takes 255 at most/,
      ],
      [
        "a name of 128 é, 256 bytes",
        [yaml, { name: "é".repeat(128) }],
        "é".repeat(128),
        /a name of 256 bytes/,
      ],
      [
        "a path over 1,024 bytes",
        [yaml, { name: deep(1025) }],
        deep(1025),
        /a path of 1025 bytes; an entry's path may have 1024 at most/,
      ],
      [
        "a path that climbs out",
        [yaml, { name: "scripts/../../x" }],
        "scripts/../../x",
        /climbs out of the bundle's directory/,
      ],
      ["a file with no name", [yaml, { name: ".", type: "file" }], ".", /a file with no name/],
      [
        "a file whose name ends with /",
        [yaml, { name: "x/", type: "file" }],
        "x/",
        /ends with "\/"/,
      ],
      // Past 100 bytes, so a PAX record carries the name: a ustar header ends it at the NUL.
      [
        "a NUL in a name",
        [yaml, { name: `${long(120)}\u0000b` }],
        `${long(120)}\u0000b`,
        /holds a NUL character/,
      ],
      // `\` is a character of a name, not a separator: 301 bytes between two `/`.
      [
        "a name over 255 bytes that holds `\\`",
        [yaml, { name: `d/${long(150)}\\${long(150)}` }],
        `d/${long(150)}\\${long(150)}`,
        /a name of 301 bytes between two "\/"/,
      ],
      // A file under a file, found though a sibling sorts between them as
      // written: `.` comes before `/`, so `scripts/run.py` lies between
      // `scripts/run` and `scripts/run/x.py` — not once `/` sorts first.
      [
        "a file, a sibling, then a file under the first",
        [yaml, { name: "scripts/run" }, { name: "scripts/run.py" }, { name: "scripts/run/x.py" }],
        "scripts/run/x.py",
        /needs "scripts\/run" to be a directory/,
      ],
      [
        "a character device",
        [yaml, { name: "dev/tty", type: "character-device" }],
        "dev/tty",
        /is a character device: tar cannot make one without privileges/,
      ],
      ["a block device", [yaml, { name: "sda", type: "block-device" }], "sda", /is a block device/],
      [
        "a hard link to no entry",
        [yaml, { name: "h", type: "link", linkname: "a" }],
        "h",
        /is a hard link to "a", and no file of that path comes before it/,
      ],
      [
        "a hard link to an entry placed after it",
        [yaml, { name: "h", type: "link", linkname: "a" }, { name: "a" }],
        "h",
        /is a hard link to "a", and no file of that path comes before it/,
      ],
      [
        "a hard link to itself",
        [yaml, { name: "h", type: "link", linkname: "h" }],
        "h",
        /is a hard link to "h"/,
      ],
      [
        "a hard link to a directory",
        [yaml, { name: "d/", type: "directory" }, { name: "h", type: "link", linkname: "d" }],
        "h",
        /is a hard link to "d"/,
      ],
    ])("refuses %s, naming the entry", async (_label, entries, entry, message) => {
      const gz = await packRaw(entries);
      for (const keep of [undefined, (name: string) => name === "agent.yaml"]) {
        const read = unpackAgentTar(gz, { maxBytes: MAX, keep });
        await expect(read).rejects.toBeInstanceOf(BundleEntryError);
        await expect(read).rejects.toMatchObject({
          code: "BUNDLE_ENTRY_UNWRITABLE",
          entry,
          message,
        });
      }
    });

    it.each<[string, RawEntry[]]>([
      [
        "a directory, then files under it",
        [yaml, { name: "x/", type: "directory" }, { name: "x/y" }],
      ],
      [
        "a directory twice",
        [yaml, { name: "x/", type: "directory" }, { name: "x/", type: "directory" }],
      ],
      [
        "the bundle's own directory, as `tar -C dir .` writes it",
        [{ name: "./", type: "directory" }, { name: "./agent.yaml" }],
      ],
      [
        "a file twice — the last one is written, by every writer",
        [yaml, { name: "x" }, { name: "./x" }],
      ],
      ["two names that differ only by case", [yaml, { name: "A" }, { name: "a/y" }]],
      ["a name of 255 bytes, in a path of 1,024", [yaml, { name: `${deep(768)}/${long(255)}` }]],
      ["an absolute name, which its readers skip or refuse", [yaml, { name: "/abs" }]],
      [
        "a link, which its readers skip or refuse",
        [yaml, { name: "l", type: "symlink", linkname: "../../etc" }],
      ],
      [
        "a hard link to an earlier file, however its path is spelled",
        [
          yaml,
          { name: "./a/b" },
          { name: "h", type: "link", linkname: "a/b" },
          { name: "i", type: "link", linkname: "/a//./b" },
          { name: "j", type: "link", linkname: "h" },
        ],
      ],
      ["a FIFO", [yaml, { name: "f", type: "fifo" }]],
      // `\` is a character of a name where an agent runs: no separator, no `..`.
      ["a file, and a name that holds `x\\`", [yaml, { name: "x" }, { name: "x\\y" }]],
      ["a name that holds `\\..\\`", [yaml, { name: "a\\..\\b" }]],
      ["a name of 255 bytes that holds `\\`", [yaml, { name: `${long(127)}\\${long(127)}` }]],
      ["a file whose name ends with `\\`", [yaml, { name: "x\\" }]],
    ])("accepts %s", async (_label, entries) => {
      const out = await unpackAgentTar(await packRaw(entries), { maxBytes: MAX });
      expect(out).toHaveLength(entries.length);
    });

    // Sorted, not compared pairwise: an archive of many entries, deep and
    // contradicting at its very end, is judged in one pass.
    // Judged on the paths sorted: a file and the entry under it are found
    // side by side, however many entries — or however deep ones — sort
    // between where they were written. (Cost measured at the 50 MB default
    // cap: about 0.1 s for 100,000 entries, or for 25,000 paths of 1,006
    // bytes; no time bound here — a pairwise reading of these sizes still
    // ends within any bound a slow machine would allow.)
    it.each<[string, (i: number) => string, number]>([
      ["many entries", (i) => `f${i}`, 10_000],
      ["deep entries", (i) => `${i}/${"a/".repeat(500)}f`, 2_000],
    ])("finds a contradiction among %s, written first and last", async (_label, nameOf, count) => {
      const entries: RawEntry[] = [yaml, { name: "zz", content: Buffer.alloc(0) }];
      for (let i = 0; i < count; i++) entries.push({ name: nameOf(i), content: Buffer.alloc(0) });
      entries.push({ name: "zz/y", content: Buffer.alloc(0) });
      await expect(
        unpackAgentTar(await packRaw(entries), { maxBytes: 200 * 1024 * 1024 }),
      ).rejects.toMatchObject({ message: expect.stringMatching(/needs "zz" to be a directory/) });
    });
  });

  // A refusal says the bundle decompresses to more than the cap: rounded down,
  // so it stays true, and never to nothing.
  it.each([
    [50 * 1024 * 1024, "50 MB"],
    [524_288, "0.5 MB"],
    [1024 * 1024 - 1, "0.9 MB"],
    [52_428, "51.1 KB"],
    [1000, "0.9 KB"],
    [100, "100 B"],
  ])("decompressedCapText(%i) is %s", (bytes, text) => {
    expect(decompressedCapText(bytes)).toBe(text);
  });

  it("reads a legacy hand-rolled ustar bundle from the registry (RT-1 / SC-8)", async () => {
    const gz = readFileSync(join(FIXTURES, "legacy-handrolled.agent"));
    const out = await unpackAgentTar(gz, { maxBytes: MAX });
    expect(out.map((e) => e.name).sort()).toEqual([
      "SKILL.md",
      "agent.yaml",
      "assets/logo.bin",
      "scripts/probe.py",
    ]);
    expect(contentOf(out, "scripts/probe.py").toString()).toBe("print('hello from scripts/')\n");
    // Binary asset survives a hand-rolled→tar-stream read byte-identically.
    const expectedBin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(contentOf(out, "assets/logo.bin").equals(expectedBin)).toBe(true);
  });
});

describe("isExcludedEntry", () => {
  it("excludes explicit dirs, dotfiles, *.secret, and *.agent", () => {
    expect(AGENT_BUNDLE_EXCLUDES.has("node_modules")).toBe(true);
    for (const name of [
      "node_modules",
      "venv",
      ".venv",
      "__pycache__",
      ".env",
      ".hidden",
      "k.secret",
      "my-bundle-1.0.0.agent",
    ]) {
      expect(isExcludedEntry(name)).toBe(true);
    }
    for (const name of ["scripts", "SKILL.md", "main.py", "agent.yaml"]) {
      expect(isExcludedEntry(name)).toBe(false);
    }
  });
});

describe("isUnsafeName", () => {
  it("flags parent-traversal, absolute names, and escaping symlink targets", () => {
    expect(isUnsafeName("../evil")).toBe(true);
    expect(isUnsafeName("a/../../b")).toBe(true);
    expect(isUnsafeName("/etc/passwd")).toBe(true);
    expect(isUnsafeName("link", "../../etc/passwd")).toBe(true);
    expect(isUnsafeName("scripts/foo.py")).toBe(false);
    expect(isUnsafeName("link", "sibling.txt")).toBe(false);
  });
});
