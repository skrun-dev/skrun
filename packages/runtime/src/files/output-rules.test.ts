import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoLinkInPath,
  CollectRequestSchema,
  CollectResponseSchema,
  DEFAULT_OUTPUT_LIMITS,
  describeBytes,
  isSafeOutputName,
  OutputLimitsSchema,
  outputFileReadRange,
  outputNameRefusal,
  readOutputLimits,
  selectOutputFiles,
  TOOL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResult,
  walkAndSelectOutputFiles,
  walkOutputFiles,
} from "./output-rules.js";

const MIB = 1024 * 1024;

describe("the output file limits an environment sets", () => {
  it("are 10 MiB per file and 20 files when nothing sets them", () => {
    expect(readOutputLimits({})).toEqual({ max_size_bytes: 10 * MIB, max_count: 20 });
    expect(DEFAULT_OUTPUT_LIMITS).toEqual({ max_size_bytes: 10 * MIB, max_count: 20 });
  });

  it("reads the size in MiB and the count as they are set", () => {
    expect(readOutputLimits({ FILES_MAX_SIZE_MB: "5", FILES_MAX_COUNT: "7" })).toEqual({
      max_size_bytes: 5 * MIB,
      max_count: 7,
    });
  });

  it.each([
    "0",
    "-3",
    "abc",
    "",
    " ",
  ])("gives the default for a value that is zero, negative or unreadable: %j", (raw) => {
    expect(readOutputLimits({ FILES_MAX_SIZE_MB: raw, FILES_MAX_COUNT: raw })).toEqual({
      max_size_bytes: 10 * MIB,
      max_count: 20,
    });
  });

  it("reads a value past the bounds as the bound: 1 GiB per file, 10,000 files", () => {
    expect(readOutputLimits({ FILES_MAX_SIZE_MB: "2048", FILES_MAX_COUNT: "20000" })).toEqual({
      max_size_bytes: 1024 * MIB,
      max_count: 10_000,
    });
    expect(readOutputLimits({ FILES_MAX_SIZE_MB: "1024", FILES_MAX_COUNT: "10000" })).toEqual({
      max_size_bytes: 1024 * MIB,
      max_count: 10_000,
    });
  });

  it("only ever produces limits the schema accepts", () => {
    for (const raw of [
      undefined,
      "",
      "0",
      "-1",
      "1",
      "7",
      "1024",
      "1025",
      "10000",
      "10001",
      "9e99",
    ]) {
      const limits = readOutputLimits({ FILES_MAX_SIZE_MB: raw, FILES_MAX_COUNT: raw });
      expect(OutputLimitsSchema.safeParse(limits).success).toBe(true);
    }
  });

  it("the schema refuses a limit that is not a whole number from 1 to its bound", () => {
    const ok = { max_size_bytes: 10 * MIB, max_count: 20 };
    expect(OutputLimitsSchema.safeParse(ok).success).toBe(true);
    expect(
      OutputLimitsSchema.safeParse({ max_size_bytes: 1024 * MIB, max_count: 10_000 }).success,
    ).toBe(true);
    for (const bad of [
      { ...ok, max_size_bytes: 0 },
      { ...ok, max_size_bytes: 1024 * MIB + 1 },
      { ...ok, max_size_bytes: 1.5 },
      { ...ok, max_count: 0 },
      { ...ok, max_count: 10_001 },
      { ...ok, max_count: "20" },
    ]) {
      expect(OutputLimitsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the output name rule", () => {
  /** A name of exactly `bytes` UTF-8 bytes, made of `unit` repeated (plus ASCII padding). */
  function nameOfBytes(bytes: number, unit = "a"): string {
    const unitBytes = Buffer.byteLength(unit, "utf8");
    const name = unit.repeat(Math.floor(bytes / unitBytes)) + "a".repeat(bytes % unitBytes);
    expect(Buffer.byteLength(name, "utf8")).toBe(bytes);
    return name;
  }

  it.each([
    ["a/../b", "dot_segment"],
    ["../x", "dot_segment"],
    ["x/./y", "dot_segment"],
    ["a//b", "empty_segment"],
    ["/x", "absolute"],
    ["a\\b", "backslash"],
    ["", "empty"],
  ])("refuses %j as a path that is not plain and relative (%s)", (name, reason) => {
    expect(outputNameRefusal(name)).toBe(reason);
    expect(isSafeOutputName(name)).toBe(false);
  });

  it("refuses a name longer than 512 bytes of UTF-8, however few characters it has", () => {
    const ascii = nameOfBytes(513);
    // 171 three-byte characters: 513 bytes, but only 171 characters.
    const multiByte = nameOfBytes(513, "€");
    expect(multiByte.length).toBe(171);

    expect(outputNameRefusal(ascii)).toBe("too_long");
    expect(outputNameRefusal(multiByte)).toBe("too_long");
    expect(outputNameRefusal(`d/${nameOfBytes(511)}`)).toBe("too_long");
    expect(isSafeOutputName(multiByte)).toBe(false);
  });

  it.each([
    ["a NUL", "a\u0000b"],
    ["a unit separator", "a\u001fb"],
    ["a DEL", "a\u007fb"],
    ["a tab", "a\tb"],
    ["a line feed", "report\n.txt"],
  ])("refuses a name with a control character: %s", (_label, name) => {
    expect(outputNameRefusal(name)).toBe("control_char");
    expect(isSafeOutputName(name)).toBe(false);
  });

  // Half of a UTF-16 pair without its other half: no URL encodes such a name,
  // no storage key holds it, and Postgres refuses it in a JSON column.
  it.each([
    ["a lone high surrogate", "report-\ud800.txt"],
    ["a lone low surrogate", "report-\udc80.txt"],
    ["a high surrogate at the very end", "report\ud83d"],
    ["a low surrogate at the very start", "\ude00report"],
    ["a pair the wrong way round", "a\udc00\ud800b"],
    ["a high surrogate followed by another high one", "d/\ud83d😀.txt"],
  ])("refuses a name with a lone surrogate: %s", (_label, name) => {
    expect(outputNameRefusal(name)).toBe("lone_surrogate");
    expect(isSafeOutputName(name)).toBe(false);
  });

  it("accepts plain relative paths, up to exactly 512 bytes", () => {
    for (const name of [
      "rapport.pdf",
      "d/b.csv",
      nameOfBytes(512),
      nameOfBytes(512, "é"),
      `dir/${nameOfBytes(508)}`,
      "café ✓.txt",
      // A character beyond the Basic Multilingual Plane: a whole pair.
      "rapport 😀.txt",
      nameOfBytes(512, "😀"),
      "a b",
    ]) {
      expect(outputNameRefusal(name)).toBeNull();
      expect(isSafeOutputName(name)).toBe(true);
    }
  });

  it("refuses what is not a string", () => {
    for (const name of [undefined, null, 42, {}, ["a"]]) {
      expect(outputNameRefusal(name)).toBe("not_a_string");
      expect(isSafeOutputName(name)).toBe(false);
    }
  });
});

describe("the selection of a run's output files", () => {
  const KIB = 1024;
  const LIMITS = { max_size_bytes: 10 * MIB, max_count: 20 };

  /** `f-00.txt` … `f-<n-1>.txt`, 1 KiB each. */
  function smallFiles(n: number): Array<{ path: string; size: number }> {
    return Array.from({ length: n }, (_, i) => ({
      path: `f-${String(i).padStart(2, "0")}.txt`,
      size: KIB,
    }));
  }

  /** The same candidates in a fixed order that is not the sorted one. */
  function shuffled<T>(items: T[]): T[] {
    return items
      .map((item, i) => ({ item, key: (i * 7919) % 101 }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.item);
  }

  const BIG = { path: "big.bin", size: 11 * MIB };
  const REFUSED = { path: "a/../b.txt", size: KIB };

  it("keeps the first 20 by path, and leaves out the large file and the refused name without counting them in the 20", () => {
    const candidates = shuffled([...smallFiles(25), BIG, REFUSED]);

    const selection = selectOutputFiles(candidates, LIMITS);

    expect(selection.kept.map((f) => f.path)).toEqual(smallFiles(20).map((f) => f.path));
    expect(selection.excluded).toEqual({ name_refused: 1, too_large: 1, over_count: 5 });
  });

  it("counts each file it leaves out once, under one reason, and names where it was in the input", () => {
    const candidates = shuffled([...smallFiles(25), BIG, REFUSED]);

    const selection = selectOutputFiles(candidates, LIMITS);

    expect(selection.kept.length + selection.exclusions.length).toBe(candidates.length);
    const byPath = new Map(selection.exclusions.map((e) => [e.candidate.path, e]));
    expect(byPath.size).toBe(selection.exclusions.length);
    expect(byPath.get("a/../b.txt")?.reason).toBe("name_refused");
    expect(byPath.get("big.bin")?.reason).toBe("too_large");
    for (const path of ["f-20.txt", "f-21.txt", "f-22.txt", "f-23.txt", "f-24.txt"]) {
      expect(byPath.get(path)?.reason).toBe("over_count");
    }
    for (const exclusion of selection.exclusions) {
      expect(candidates[exclusion.index]).toBe(exclusion.candidate);
    }
  });

  it("counts a file refused by name and too large once, as refused by name: the name is judged first", () => {
    const both = { path: "a/../big.bin", size: 11 * MIB };
    const candidates = [...smallFiles(3), both];

    const selection = selectOutputFiles(candidates, LIMITS);

    expect(selection.kept.map((f) => f.path)).toEqual(["f-00.txt", "f-01.txt", "f-02.txt"]);
    expect(selection.excluded).toEqual({ name_refused: 1, too_large: 0, over_count: 0 });
    expect(selection.exclusions).toEqual([{ candidate: both, index: 3, reason: "name_refused" }]);
  });

  it("counts a large file as too large wherever it falls in the order, past the cut included", () => {
    const late = { path: "zz-big.bin", size: 11 * MIB };

    const selection = selectOutputFiles([...smallFiles(25), late, REFUSED], LIMITS);

    expect(selection.kept.map((f) => f.path)).toEqual(smallFiles(20).map((f) => f.path));
    expect(selection.excluded).toEqual({ name_refused: 1, too_large: 1, over_count: 5 });
  });

  it("applies the limits it is given: two files, 1 MiB each", () => {
    const selection = selectOutputFiles(shuffled([...smallFiles(25), BIG, REFUSED]), {
      max_size_bytes: MIB,
      max_count: 2,
    });

    expect(selection.kept.map((f) => f.path)).toEqual(["f-00.txt", "f-01.txt"]);
    expect(selection.excluded).toEqual({ name_refused: 1, too_large: 1, over_count: 23 });
  });

  it("keeps a file of exactly the size limit and leaves out one byte more", () => {
    const selection = selectOutputFiles(
      [
        { path: "at-limit.bin", size: MIB },
        { path: "over-limit.bin", size: MIB + 1 },
        { path: "empty.txt", size: 0 },
      ],
      { max_size_bytes: MIB, max_count: 20 },
    );

    expect(selection.kept.map((f) => f.path)).toEqual(["at-limit.bin", "empty.txt"]);
    expect(selection.excluded).toEqual({ name_refused: 0, too_large: 1, over_count: 0 });
  });

  it("sorts by path the way the local collector always has, and keeps what each candidate carries", () => {
    const candidates = [
      { path: "b.txt", size: 1, mimeType: "text/plain" },
      { path: "B.txt", size: 2, mimeType: "text/plain" },
      { path: "a/z.txt", size: 3, mimeType: "text/plain" },
      { path: "a.txt", size: 4, mimeType: "text/plain" },
    ];

    const selection = selectOutputFiles(candidates, LIMITS);

    expect(selection.kept.map((f) => f.path)).toEqual(candidates.map((f) => f.path).sort());
    expect(selection.kept.map((f) => f.path)).toEqual(["B.txt", "a.txt", "a/z.txt", "b.txt"]);
    expect(selection.kept.find((f) => f.path === "a.txt")).toBe(candidates[3]);
  });

  it("keeps nothing and leaves out nothing when there is nothing", () => {
    expect(selectOutputFiles([], LIMITS)).toEqual({
      kept: [],
      excluded: { name_refused: 0, too_large: 0, over_count: 0 },
      exclusions: [],
    });
  });
});

describe("the walk of an outputs directory", () => {
  const KIB = 1024;
  let root: string;

  /** Whether this process may create a symbolic link to a file (not on unprivileged Windows). */
  const canLinkFiles = (() => {
    const probe = mkdtempSync(join(tmpdir(), "skrun-walk-probe-"));
    try {
      writeFileSync(join(probe, "t"), "");
      symlinkSync(join(probe, "t"), join(probe, "l"));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  })();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skrun-walk-"));
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(root, `f-${String(i).padStart(2, "0")}.txt`), Buffer.alloc(KIB));
    }
    // 11 MiB without writing 11 MiB: the size is what the walk reads.
    writeFileSync(join(root, "big.bin"), "");
    truncateSync(join(root, "big.bin"), 11 * MIB);
    mkdirSync(join(root, "sub", "deeper"), { recursive: true });
    writeFileSync(join(root, "sub", "g.txt"), Buffer.alloc(KIB));
    writeFileSync(join(root, "sub", "deeper", "h.txt"), "hi");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists every file under the root, in subdirectories too, by its path relative to the root with forward slashes", async () => {
    const files = await walkOutputFiles(root);

    const byPath = new Map(files.map((f) => [f.path, f.size]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        "big.bin",
        ...Array.from({ length: 25 }, (_, i) => `f-${String(i).padStart(2, "0")}.txt`),
        "sub/deeper/h.txt",
        "sub/g.txt",
      ].sort(),
    );
    expect(byPath.get("big.bin")).toBe(11 * MIB);
    expect(byPath.get("f-07.txt")).toBe(KIB);
    expect(byPath.get("sub/deeper/h.txt")).toBe(2);
  });

  it("keeps, walked then selected, the same 20 files as the selection of the same list", async () => {
    const selection = await walkAndSelectOutputFiles(root, {
      max_size_bytes: 10 * MIB,
      max_count: 20,
    });

    expect(selection.kept.map((f) => f.path)).toEqual(
      Array.from({ length: 20 }, (_, i) => `f-${String(i).padStart(2, "0")}.txt`),
    );
    expect(selection.excluded).toEqual({ name_refused: 0, too_large: 1, over_count: 7 });
  });

  it.skipIf(!canLinkFiles)("leaves out a symbolic link to a file", async () => {
    symlinkSync(join(root, "f-00.txt"), join(root, "link.txt"));

    const paths = (await walkOutputFiles(root)).map((f) => f.path);

    expect(paths).toContain("f-00.txt");
    expect(paths).not.toContain("link.txt");
  });

  it("does not follow a link to a directory", async () => {
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    symlinkSync(join(root, "sub"), join(root, "linked-dir"), "junction");

    const paths = (await walkOutputFiles(root)).map((f) => f.path);

    expect(paths).toContain("sub/g.txt");
    expect(paths.filter((p) => p.startsWith("linked-dir"))).toEqual([]);
  });

  it("lists nothing when the root does not exist: the run wrote no file", async () => {
    expect(await walkOutputFiles(join(root, "missing"))).toEqual([]);
  });
});

describe("a path through a link, refused at every level", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skrun-path-links-"));
    outside = mkdtempSync(join(tmpdir(), "skrun-path-links-outside-"));
    mkdirSync(join(root, "sub", "deeper"), { recursive: true });
    writeFileSync(join(root, "sub", "deeper", "kept.txt"), "kept");
    writeFileSync(join(outside, "secret.txt"), "outside the root");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("lets a path of plain directories and a file through, and one that is not there", async () => {
    await expect(assertNoLinkInPath(root, "sub/deeper/kept.txt")).resolves.toBeUndefined();
    await expect(assertNoLinkInPath(root, "sub/missing/x.txt")).resolves.toBeUndefined();
  });

  it("refuses a path through a link to a directory outside the root", async () => {
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    symlinkSync(outside, join(root, "linked"), "junction");

    await expect(assertNoLinkInPath(root, "linked/secret.txt")).rejects.toThrow(
      'path "linked/secret.txt" goes through a symbolic link',
    );
  });

  // Symbolic links proper, which an unprivileged Windows process cannot make.
  it.skipIf(process.platform === "win32")(
    "refuses a path through a link to /etc, at a file listed by hand",
    async () => {
      symlinkSync("/etc", join(root, "sub", "etc"));

      await expect(assertNoLinkInPath(root, "sub/etc/passwd")).rejects.toThrow(
        'path "sub/etc/passwd" goes through a symbolic link',
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a path whose last component is a link, and a root that is one",
    async () => {
      symlinkSync(join(outside, "secret.txt"), join(root, "sub", "file-link.txt"));
      const linkedRoot = join(outside, "root-link");
      symlinkSync(root, linkedRoot);

      await expect(assertNoLinkInPath(root, "sub/file-link.txt")).rejects.toThrow(
        "goes through a symbolic link",
      );
      await expect(assertNoLinkInPath(linkedRoot, "sub/deeper/kept.txt")).rejects.toThrow(
        "goes through a symbolic link",
      );
    },
  );
});

describe("the shape of a collect request", () => {
  it("gives the defaults for an empty body, and for an empty object", () => {
    expect(CollectRequestSchema.parse(undefined)).toEqual({
      max_size_bytes: 10 * MIB,
      max_count: 20,
    });
    expect(CollectRequestSchema.parse({})).toEqual({ max_size_bytes: 10 * MIB, max_count: 20 });
  });

  it("takes the limits it is sent, each one on its own", () => {
    expect(CollectRequestSchema.parse({ max_size_bytes: 5 * MIB, max_count: 7 })).toEqual({
      max_size_bytes: 5 * MIB,
      max_count: 7,
    });
    expect(CollectRequestSchema.parse({ max_count: 7 })).toEqual({
      max_size_bytes: 10 * MIB,
      max_count: 7,
    });
  });

  it.each([
    ["a negative count", { max_count: -1 }],
    ["a count of NaN, as JSON sends it", JSON.parse(JSON.stringify({ max_count: Number.NaN }))],
    ["a size of 1e18", { max_size_bytes: 1e18 }],
    ["a count that is not whole", { max_count: 2.5 }],
    ["a size of zero", { max_size_bytes: 0 }],
    ["a count past its bound", { max_count: 10_001 }],
    ["a count sent as text", { max_count: "20" }],
    ["a body that is not an object", null],
  ])("refuses %s", (_label, body) => {
    expect(CollectRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("the shape of a collect response", () => {
  const FILE = { path: "d/b.csv", size: 3, mimeType: "text/csv" };

  it("accepts a list of files with no exclusions, as an earlier runner answers", () => {
    const parsed = CollectResponseSchema.parse({ files: [] });
    expect(parsed).toEqual({ files: [] });
    expect(CollectResponseSchema.parse({ files: [FILE] })).toEqual({ files: [FILE] });
  });

  it("accepts the exclusions counted by reason, a missing reason counted as zero", () => {
    expect(
      CollectResponseSchema.parse({ files: [FILE], excluded: { too_large: 1, over_count: 5 } }),
    ).toEqual({ files: [FILE], excluded: { name_refused: 0, too_large: 1, over_count: 5 } });
  });

  it.each([
    ["no file list", {}],
    ["a file list that is not a list", { files: {} }],
    ["a path that is not text", { files: [{ ...FILE, path: 42 }] }],
    ["a negative size", { files: [{ ...FILE, size: -1 }] }],
    ["a size that is not whole", { files: [{ ...FILE, size: 1.5 }] }],
    ["a size sent as text", { files: [{ ...FILE, size: "3" }] }],
    ["no type", { files: [{ path: "a.txt", size: 1 }] }],
    ["a negative count", { files: [], excluded: { over_count: -1 } }],
    ["a count that is not whole", { files: [], excluded: { too_large: 0.5 } }],
    ["a count past any safe integer", { files: [], excluded: { too_large: 2 ** 60 } }],
  ])("refuses %s", (_label, body) => {
    expect(CollectResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("the bytes a runner serves for one output file", () => {
  it("serves an empty file as nothing, with no range to read", () => {
    expect(outputFileReadRange(0, 10)).toEqual({ kind: "empty" });
  });

  it("serves a file within the limit from its first byte to the size it was listed at", () => {
    expect(outputFileReadRange(5, 10)).toEqual({ kind: "range", start: 0, end: 4 });
    expect(outputFileReadRange(10, 10)).toEqual({ kind: "range", start: 0, end: 9 });
  });

  it("refuses a file past the limit, by one byte or by many", () => {
    expect(outputFileReadRange(11, 10)).toEqual({ kind: "too_large" });
    expect(outputFileReadRange(50, 10)).toEqual({ kind: "too_large" });
  });

  it("reads no more than the listed size from a file that grew since", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-range-"));
    try {
      const file = join(dir, "grows.txt");
      writeFileSync(file, "12345");
      const range = outputFileReadRange(5, 10);
      appendFileSync(file, "67890");

      if (range.kind !== "range") throw new Error(`expected a range, got ${range.kind}`);
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(file, { start: range.start, end: range.end })) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString()).toBe("12345");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a tool result cut to fit its answer", () => {
  const MARKER = TOOL_RESULT_TRUNCATION_MARKER;

  /** The number of bytes a text names: "1 MiB", "512 KiB", "1000 bytes". */
  function bytesNamedIn(text: string): number | undefined {
    const named = /(\d+) (MiB|KiB|bytes)\b/.exec(text);
    if (!named) return undefined;
    const unit = { MiB: 1024 * 1024, KiB: 1024, bytes: 1 }[named[2] as "MiB" | "KiB" | "bytes"];
    return Number(named[1]) * unit;
  }

  it("names in its marker the bound it cuts to: the constant's, never a copy of it", () => {
    expect(bytesNamedIn(TOOL_RESULT_TRUNCATION_MARKER)).toBe(TOOL_RESPONSE_MAX_BYTES);
  });

  it("says a number of bytes in whole MiB or KiB when it is one, in bytes otherwise", () => {
    expect(
      [1_048_576, 2_097_152, 524_288, 65_536, 1024, 1_048_577, 1000, 0].map(describeBytes),
    ).toEqual([
      "1 MiB",
      "2 MiB",
      "512 KiB",
      "64 KiB",
      "1 KiB",
      "1048577 bytes",
      "1000 bytes",
      "0 bytes",
    ]);
    for (const bytes of [1_048_576, 2_097_152, 524_288, 1_048_577]) {
      expect(bytesNamedIn(describeBytes(bytes))).toBe(bytes);
    }
  });

  /** Bytes of UTF-8 of the JSON a runner answers with. */
  function answerBytes(result: unknown): number {
    return Buffer.byteLength(JSON.stringify(result), "utf8");
  }

  /** Checks every promise of a cut, and returns the beginning kept. */
  function expectCut(original: { content: string; isError: boolean }): string {
    const cut = truncateToolResult(original);

    expect(answerBytes(cut)).toBeLessThanOrEqual(1_048_576);
    expect(Object.keys(JSON.parse(JSON.stringify(cut))).sort()).toEqual(["content", "isError"]);
    expect(cut.isError).toBe(original.isError);
    expect(cut.content.endsWith(MARKER)).toBe(true);
    const kept = cut.content.slice(0, -MARKER.length);
    expect(original.content.startsWith(kept)).toBe(true);
    // On a character boundary: never half of a surrogate pair at the end.
    const last = kept.charCodeAt(kept.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    // And as long as it can be: one more character would not fit.
    const next = original.content.codePointAt(kept.length);
    if (next !== undefined) {
      const longer = { ...cut, content: kept + String.fromCodePoint(next) + MARKER };
      expect(answerBytes(longer)).toBeGreaterThan(1_048_576);
    }
    return kept;
  }

  it("cuts 3 MiB of text to fit 1 MiB, with the marker the model reads", () => {
    const kept = expectCut({ content: "a".repeat(3 * MIB), isError: false });
    expect(kept.length).toBeGreaterThan(1_048_576 - 200);
  });

  it("cuts an error the same way: both branches of the answer", () => {
    expectCut({ content: "e".repeat(3 * MIB), isError: true });
  });

  it("cuts text of multi-byte characters on a character boundary", () => {
    expectCut({ content: "é€".repeat(700_000), isError: false });
  });

  it("never splits a surrogate pair", () => {
    // Each emoji: two UTF-16 units, four bytes; an odd offset puts a pair across every cut.
    expectCut({ content: `x${"😀".repeat(600_000)}`, isError: false });
    expectCut({ content: "😀".repeat(600_000), isError: true });
  });

  it("keeps a surrogate pair that fits at the very end of the room left", () => {
    // Half a pair escapes to six bytes, the whole pair weighs four: the size of a
    // cut does not grow with it unless the cut stays between two characters.
    const room = answerBytes({ content: MARKER, isError: false });
    const n = 1_048_576 - 5 - room;
    const content = `${"a".repeat(n)}😀${"b".repeat(144)}`;

    const kept = expectCut({ content, isError: false });

    expect(kept.slice(n)).toBe("😀b");
  });

  it("counts the escapes JSON adds: quotes and line breaks weigh two bytes each", () => {
    const kept = expectCut({ content: '"\n'.repeat(400_000), isError: false });
    // About half a million characters fit, not a million.
    expect(kept.length).toBeLessThan(530_000);
  });

  it("returns a result that fits unchanged, up to exactly 1 MiB of answer", () => {
    const small = { content: "fine", isError: false };
    expect(truncateToolResult(small)).toBe(small);

    const envelope = answerBytes({ content: "", isError: false });
    const exact = { content: "a".repeat(1_048_576 - envelope), isError: false };
    expect(answerBytes(exact)).toBe(1_048_576);
    expect(truncateToolResult(exact)).toBe(exact);

    const overByOne = { content: `${exact.content}a`, isError: false };
    expectCut(overByOne);
  });
});
