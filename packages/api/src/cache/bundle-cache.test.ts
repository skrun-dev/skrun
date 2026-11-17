import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTLCache } from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireBundle,
  type BundleCacheEntry,
  bundleCache,
  bundleCacheMaxBytes,
  bundleExtractionsInUse,
  createBundleCache,
  entryBytes,
  getOrExtract,
  getOrReadManifests,
  ownedExtractionDirs,
  stringBytes,
  sweepBundleCache,
} from "./bundle-cache.js";

// Helper: create a real temp dir to simulate an extracted bundle
function makeTempDir(): string {
  const dir = join(tmpdir(), `skrun-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("BundleCache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  it("getOrExtract returns cached entry on second call (VT-5)", () => {
    const cache = new TTLCache<string, BundleCacheEntry>({
      ttlMs: 60_000,
      maxEntries: 10,
    });

    const dir = makeTempDir();
    tempDirs.push(dir);
    const entry: BundleCacheEntry = { dir, files: { "SKILL.md": "test" } };
    cache.set("dev/agent/1.0.0", entry);

    // Second call should return cached — no extraction needed
    const result = cache.get("dev/agent/1.0.0");
    expect(result).toBe(entry);
    expect(result?.dir).toBe(dir);
    expect(result?.files["SKILL.md"]).toBe("test");
  });

  it("getOrExtract rejects on an invalid bundle buffer (VT-6)", async () => {
    // getOrExtract delegates to the async extractBundleToDisk; an invalid buffer
    // makes the extraction reject (gunzip fails on non-gzip input).
    const cache = new TTLCache<string, BundleCacheEntry>({
      ttlMs: 60_000,
      maxEntries: 10,
    });

    await expect(
      getOrExtract(cache, "dev/agent/1.0.0", Buffer.from("not-a-tarball")),
    ).rejects.toThrow();
  });

  it("eviction cleans up temp directory (VT-7)", () => {
    const dir = makeTempDir();
    expect(existsSync(dir)).toBe(true);

    const cache = new TTLCache<string, BundleCacheEntry>({
      ttlMs: 60_000,
      maxEntries: 1,
      onEvict: (_key, entry) => {
        try {
          rmSync(entry.dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },
    });

    cache.set("dev/agent/1.0.0", { dir, files: {} });

    // Adding a second entry evicts the first (max=1)
    const dir2 = makeTempDir();
    tempDirs.push(dir2);
    cache.set("dev/agent/2.0.0", { dir: dir2, files: {} });

    expect(existsSync(dir)).toBe(false); // evicted → dir cleaned
  });

  it("createBundleCache reads env vars for TTL and max", () => {
    process.env.BUNDLE_CACHE_TTL = "5";
    process.env.BUNDLE_CACHE_MAX = "3";

    const cache = createBundleCache();
    // Verify max by filling past capacity
    for (let i = 0; i < 4; i++) {
      const d = makeTempDir();
      tempDirs.push(d);
      cache.set(`key-${i}`, { dir: d, files: {} });
    }
    expect(cache.size).toBe(3); // max=3, 4th evicted the 1st

    process.env.BUNDLE_CACHE_TTL = undefined as unknown as string;
    process.env.BUNDLE_CACHE_MAX = undefined as unknown as string;
  });
});

// On the local runtime a run launches its scripts from the extracted
// directory while it goes on. Whatever evicts the entry — its expiry found by a
// sweep or a read, the size bound — the directory of an extraction in use stays
// until the last run using it is done.
describe("BundleCache: an extraction in use is never removed", () => {
  const TTL_S = 600;
  const caches: Array<ReturnType<typeof createBundleCache>> = [];

  function cacheOf(max = 10): ReturnType<typeof createBundleCache> {
    vi.stubEnv("BUNDLE_CACHE_TTL", String(TTL_S));
    vi.stubEnv("BUNDLE_CACHE_MAX", String(max));
    const cache = createBundleCache();
    caches.push(cache);
    return cache;
  }

  const bundle = (text: string): Promise<Buffer> =>
    packAgentTar([{ name: "SKILL.md", content: Buffer.from(text) }]);

  afterEach(() => {
    for (const cache of caches.splice(0)) cache.clear();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    ["a sweep", (cache: ReturnType<typeof createBundleCache>) => cache.sweep()],
    ["a read", (cache: ReturnType<typeof createBundleCache>) => cache.get("k")],
  ])("an expired entry in use leaves the cache on %s, its directory stays until the release", async (_, find) => {
    vi.useFakeTimers();
    const cache = cacheOf();
    const entry = await getOrExtract(cache, "k", await bundle("in use"));
    const lease = acquireBundle(entry);

    vi.advanceTimersByTime(TTL_S * 1000 + 1);
    find(cache);
    expect(cache.size).toBe(0);
    expect(existsSync(entry.dir)).toBe(true);

    lease.release();
    expect(existsSync(entry.dir)).toBe(false);
  });

  it("an entry in use pushed out by the size bound keeps its directory until the release", async () => {
    const cache = cacheOf(1);
    const entry = await getOrExtract(cache, "first", await bundle("first"));
    const lease = acquireBundle(entry);

    await getOrExtract(cache, "second", await bundle("second"));
    expect(cache.get("first")).toBeUndefined();
    expect(existsSync(entry.dir)).toBe(true);

    lease.release();
    expect(existsSync(entry.dir)).toBe(false);
  });

  it("an entry released before it expires leaves with its directory, as before", async () => {
    vi.useFakeTimers();
    const cache = cacheOf();
    const entry = await getOrExtract(cache, "k", await bundle("released"));
    acquireBundle(entry).release();
    expect(existsSync(entry.dir)).toBe(true);

    vi.advanceTimersByTime(TTL_S * 1000 + 1);
    expect(cache.sweep()).toBe(1);
    expect(existsSync(entry.dir)).toBe(false);
  });

  // The run takes its hold inside the call that hands it the extraction: no
  // await and no caller code sit between the cache and the hold.
  it("getOrExtract hands the extraction back already held, on an extraction and on a hit", async () => {
    const cache = cacheOf();
    const bytes = await bundle("held at once");
    const before = bundleExtractionsInUse();

    const first = await getOrExtract(cache, "k", bytes, { acquire: true });
    expect(bundleExtractionsInUse()).toBe(before + 1);
    const second = await getOrExtract(cache, "k", bytes, { acquire: true });
    expect(second.entry).toBe(first.entry);
    expect(bundleExtractionsInUse()).toBe(before + 2);

    cache.delete("k");
    first.lease.release();
    expect(existsSync(first.entry.dir)).toBe(true);
    second.lease.release();
    expect(existsSync(first.entry.dir)).toBe(false);
    expect(bundleExtractionsInUse()).toBe(before);
  });

  it("a lease released twice gives back one use only — another run's use keeps the directory", async () => {
    const cache = cacheOf();
    const entry = await getOrExtract(cache, "k", await bundle("two runs"));
    const before = bundleExtractionsInUse();
    const first = acquireBundle(entry);
    const second = acquireBundle(entry);
    expect(bundleExtractionsInUse()).toBe(before + 2);

    first.release();
    first.release();
    expect(entry.users).toBe(1);
    expect(bundleExtractionsInUse()).toBe(before + 1);

    cache.delete("k");
    expect(existsSync(entry.dir)).toBe(true);

    second.release();
    expect(entry.users).toBe(0);
    expect(existsSync(entry.dir)).toBe(false);
    expect(bundleExtractionsInUse()).toBe(before);
  });
});

// The cache keeps the text a run reads — the three manifests — and nothing
// else of a bundle: an entry holds no other file, as bytes or as text. A run
// that needs the bundle on disk (the local runtime) gets an extraction, its
// directory owned and counted; one that needs the manifests only (the cloud
// runtime) gets an entry with no directory, which nothing on disk stands for.
describe("BundleCache: what an entry keeps", () => {
  const MANIFESTS = {
    "agent.yaml": "name: kept\n",
    "SKILL.md": "# kept\n",
    "AGENTS.md": "# context\n",
  };
  let root: string;

  /** A bundle of the three manifests, a script and a binary asset; `tag` makes its bytes its own. */
  const bundle = (tag: string): Promise<Buffer> =>
    packAgentTar([
      ...Object.entries(MANIFESTS).map(([name, text]) => ({ name, content: Buffer.from(text) })),
      { name: "scripts/run.py", content: Buffer.from(`print(${JSON.stringify(tag)})\n`) },
      { name: "assets/blob.bin", content: Buffer.alloc(256 * 1024, 0xff) },
    ]);

  const extractionsUnderRoot = () =>
    readdirSync(root).filter((name) => name.startsWith("skrun-agent-"));

  beforeEach(() => {
    // A temp root of the case's own, so what is written is read there alone:
    // `os.tmpdir()` reads these at every call.
    root = mkdtempSync(join(tmpdir(), "skrun-entry-case-"));
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
  });

  afterEach(() => {
    bundleCache.clear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("getOrExtract writes the whole bundle to the extraction's directory, and keeps the text of the three manifests only", async () => {
    const entry = await getOrExtract(bundleCache, "k", await bundle("disk"));
    expect(entry.files).toEqual(MANIFESTS);
    expect(readFileSync(join(entry.dir, "scripts", "run.py"), "utf-8")).toBe('print("disk")\n');
    expect(readFileSync(join(entry.dir, "assets", "blob.bin")).length).toBe(256 * 1024);
    expect(extractionsUnderRoot()).toHaveLength(1);
    expect(ownedExtractionDirs()).toContain(entry.dir);
  });

  it("getOrReadManifests keeps the text of the three manifests only, and writes nothing to disk", async () => {
    const owned = ownedExtractionDirs().length;
    const inUse = bundleExtractionsInUse();

    const entry = await getOrReadManifests(bundleCache, "k", await bundle("memory"));
    // Exactly this: the manifests, and no directory.
    expect(entry).toEqual({ files: MANIFESTS });
    expect(bundleCache.get("k")).toBe(entry);
    expect(readdirSync(root)).toEqual([]);
    expect(ownedExtractionDirs()).toHaveLength(owned);
    expect(bundleExtractionsInUse()).toBe(inUse);
    // A second read is the cache's: nothing read again.
    expect(await getOrReadManifests(bundleCache, "k", Buffer.from("never read"))).toBe(entry);
  });

  it("an entry with no directory leaves on a sweep counted neither removed nor held; an extraction beside it is counted removed", async () => {
    vi.useFakeTimers();
    await getOrReadManifests(bundleCache, "memory", await bundle("memory"));
    const extraction = await getOrExtract(bundleCache, "disk", await bundle("disk"));

    vi.advanceTimersByTime(600_000 + 1); // the cache's default window, plus one tick
    expect(sweepBundleCache()).toEqual({ removed: 1, held: 0 });
    expect(bundleCache.size).toBe(0);
    expect(existsSync(extraction.dir)).toBe(false);
    expect(extractionsUnderRoot()).toEqual([]);
  });

  it("getOrExtract does not take an entry with no directory for an extraction: it extracts the bundle, and its entry takes that one's place", async () => {
    const bytes = await bundle("both");
    const manifestsOnly = await getOrReadManifests(bundleCache, "k", bytes);
    const held = await getOrExtract(bundleCache, "k", bytes, { acquire: true });
    try {
      expect(held.entry).not.toBe(manifestsOnly);
      expect(held.entry.files).toEqual(MANIFESTS);
      expect(existsSync(join(held.entry.dir, "scripts", "run.py"))).toBe(true);
      expect(bundleCache.get("k")).toBe(held.entry);
      // And a manifests read is served by the extraction from then on.
      expect(await getOrReadManifests(bundleCache, "k", bytes)).toBe(held.entry);
    } finally {
      held.lease.release();
    }
  });

  describe("the configuration, read once with the entry", () => {
    const readConfig = vi.fn(async (agentYaml: string) => ({
      json: JSON.stringify({ agentYaml }),
    }));

    afterEach(() => {
      readConfig.mockClear();
    });

    it.each([
      ["getOrExtract", (bytes: Buffer) => getOrExtract(bundleCache, "k", bytes, { readConfig })],
      [
        "getOrReadManifests",
        (bytes: Buffer) => getOrReadManifests(bundleCache, "k", bytes, { readConfig }),
      ],
    ] as const)("%s reads agent.yaml once, before the entry enters the cache, and serves it from then on", async (_, read) => {
      const bytes = await bundle("config");
      const entry = await read(bytes);
      expect(entry.config).toEqual({
        json: JSON.stringify({ agentYaml: MANIFESTS["agent.yaml"] }),
      });
      expect(readConfig).toHaveBeenCalledExactlyOnceWith(MANIFESTS["agent.yaml"]);
      // Weighed with it: the manifests and the JSON.
      expect(bundleCache.bytes).toBe(entryBytes(entry));
      expect(entryBytes(entry)).toBeGreaterThan(entryBytes({ files: MANIFESTS }));
      expect(await read(bytes)).toBe(entry);
      expect(readConfig).toHaveBeenCalledOnce();
    });

    it("reads nothing for a bundle with no agent.yaml, or an empty one", async () => {
      for (const agentYaml of [undefined, ""]) {
        bundleCache.clear();
        const bytes = await packAgentTar([
          { name: "SKILL.md", content: Buffer.from("# none\n") },
          ...(agentYaml === undefined ? [] : [{ name: "agent.yaml", content: Buffer.from("") }]),
        ]);
        const entry = await getOrReadManifests(bundleCache, "k", bytes, { readConfig });
        expect(entry.config).toBeUndefined();
        expect(await getOrReadManifests(bundleCache, "k", bytes, { readConfig })).toBe(entry);
      }
      expect(readConfig).not.toHaveBeenCalled();
    });

    it("an extraction replacing a manifests-only entry keeps its configuration, never read again", async () => {
      const bytes = await bundle("both");
      const manifestsOnly = await getOrReadManifests(bundleCache, "k", bytes, { readConfig });
      const held = await getOrExtract(bundleCache, "k", bytes, { acquire: true, readConfig });
      try {
        expect(held.entry.config).toBe(manifestsOnly.config);
        expect(readConfig).toHaveBeenCalledOnce();
      } finally {
        held.lease.release();
      }
    });

    it.each([
      ["getOrExtract", (bytes: Buffer) => getOrExtract(bundleCache, "k", bytes, { readConfig })],
      [
        "getOrReadManifests",
        (bytes: Buffer) => getOrReadManifests(bundleCache, "k", bytes, { readConfig }),
      ],
    ] as const)("%s does not serve an entry made without the configuration to a caller that reads it", async (_, read) => {
      const bytes = await bundle("unread");
      const unread = await getOrExtract(bundleCache, "k", bytes);
      const entry = await read(bytes);
      expect(entry).not.toBe(unread);
      expect(entry.config).toBeDefined();
      expect(bundleCache.get("k")).toBe(entry);
      expect(existsSync(unread.dir)).toBe(false);
    });

    it("a read that fails leaves nothing: no entry, no directory, no lease held", async () => {
      const failure = new Error("the reader failed");
      const owned = ownedExtractionDirs().length;
      const inUse = bundleExtractionsInUse();
      await expect(
        getOrExtract(bundleCache, "k", await bundle("fails"), {
          acquire: true,
          readConfig: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(bundleCache.size).toBe(0);
      expect(extractionsUnderRoot()).toEqual([]);
      expect(ownedExtractionDirs()).toHaveLength(owned);
      expect(bundleExtractionsInUse()).toBe(inUse);
    });
  });
});

// Besides its count, the cache is bounded by what its entries weigh: the text
// of their manifests, never counted below what the process holds of it — one
// byte a character for a string all in ASCII, two otherwise. Past the budget
// the least recently used leave first, through the eviction an extraction in
// use survives; an entry heavier than the whole budget is served to its run
// and not kept.
describe("BundleCache: a budget in bytes", () => {
  const MIB = 1024 * 1024;
  const KIB = 1024;
  const caches: Array<ReturnType<typeof createBundleCache>> = [];
  let root: string;

  /** A cache of a 1 MB budget, and a count of `max`. */
  function cacheOf(max = 50, budgetMb = "1"): ReturnType<typeof createBundleCache> {
    vi.stubEnv("BUNDLE_CACHE_MAX_MB", budgetMb);
    vi.stubEnv("BUNDLE_CACHE_MAX", String(max));
    const cache = createBundleCache();
    caches.push(cache);
    return cache;
  }

  /** A bundle whose one manifest is a SKILL.md of `chars` characters of `fill`. */
  const bundleOf = (chars: number, fill = "a"): Promise<Buffer> =>
    packAgentTar([{ name: "SKILL.md", content: Buffer.from(fill.repeat(chars)) }]);

  const extractionsUnderRoot = () =>
    readdirSync(root).filter((name) => name.startsWith("skrun-agent-"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skrun-budget-case-"));
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
  });

  afterEach(() => {
    for (const cache of caches.splice(0)) cache.clear();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  describe("what an entry weighs", () => {
    it("one byte a character for a string all in ASCII", () => {
      expect(stringBytes("")).toBe(0);
      expect(stringBytes("plain ascii")).toBe(11);
      expect(stringBytes("\u007f")).toBe(1);
    });

    it("two bytes a character for a string with one character past ASCII — every character of it, Latin-1 ones included", () => {
      // Node keeps a large such string two bytes a character, Latin-1 or not.
      expect(stringBytes("\u0080")).toBe(2);
      expect(stringBytes("éàüñ ÿ")).toBe(12);
      expect(stringBytes(`${"a".repeat(99)}é`)).toBe(200);
      expect(stringBytes("ā")).toBe(2);
      expect(stringBytes(`${"a".repeat(99)}€`)).toBe(200);
      // A character outside the BMP is two UTF-16 units, each two bytes.
      expect(stringBytes("😀")).toBe(4);
    });

    it("an entry weighs the text of its manifests, nothing else of it", () => {
      expect(
        entryBytes({
          dir: "/never/read",
          files: { "SKILL.md": "abc", "agent.yaml": "ā".repeat(10), "AGENTS.md": "" },
        }),
      ).toBe(3 + 20);
    });

    it("and the text its configuration is kept as: its JSON, or its refusal's message", () => {
      const files = { "SKILL.md": "abc" };
      expect(entryBytes({ files, config: { json: '{"name":"x"}' } })).toBe(3 + 12);
      expect(entryBytes({ files, config: { json: '{"d":"é"}' } })).toBe(3 + 18);
      expect(entryBytes({ files, config: { refused: "Invalid agent.yaml" } })).toBe(3 + 18);
    });

    it.each([
      ["past Latin-1", "ā"],
      ["all in Latin-1, past ASCII", "é"],
    ])("a manifest %s, read from a bundle, weighs twice its length in the cache", async (_, fill) => {
      const cache = cacheOf();
      const entry = await getOrReadManifests(cache, "k", await bundleOf(1000, fill));
      expect(entry.files["SKILL.md"]).toHaveLength(1000);
      expect(cache.bytes).toBe(2000);
    });

    it("a manifest all in ASCII weighs its length", async () => {
      const cache = cacheOf();
      await getOrReadManifests(cache, "k", await bundleOf(1000));
      expect(cache.bytes).toBe(1000);
    });
  });

  it("the setting is read like the others: unset, empty, malformed, zero or below, 256 MB; else the whole MB it starts with", () => {
    for (const raw of [undefined, "", "abc", "0", "-5"]) {
      vi.stubEnv("BUNDLE_CACHE_MAX_MB", raw);
      expect(bundleCacheMaxBytes(), String(raw)).toBe(256 * MIB);
    }
    vi.stubEnv("BUNDLE_CACHE_MAX_MB", "64");
    expect(bundleCacheMaxBytes()).toBe(64 * MIB);
    vi.stubEnv("BUNDLE_CACHE_MAX_MB", "12.9");
    expect(bundleCacheMaxBytes()).toBe(12 * MIB);
  });

  it("past the budget, the least recently used leave first, until the new entry fits", async () => {
    const cache = cacheOf();
    for (const key of ["first", "second", "third"]) {
      await getOrReadManifests(cache, key, await bundleOf(300 * KIB, key[0]));
    }
    cache.get("first"); // "second" is now the least recently used
    await getOrReadManifests(cache, "fourth", await bundleOf(300 * KIB, "d"));

    expect(cache.get("second")).toBeUndefined();
    for (const key of ["first", "third", "fourth"]) expect(cache.get(key), key).toBeDefined();
    expect(cache.bytes).toBe(900 * KIB);

    // One twice as heavy pushes the two oldest out.
    await getOrReadManifests(cache, "fifth", await bundleOf(600 * KIB, "e"));
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("third")).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(900 * KIB);
  });

  it("the count still bounds it, under a budget that would take more", async () => {
    const cache = cacheOf(2, "256");
    for (const key of ["a", "b", "c"])
      await getOrReadManifests(cache, key, await bundleOf(10, key));
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
  });

  it("an entry heavier than the whole budget is served, not kept — and evicts nothing", async () => {
    const cache = cacheOf();
    await getOrReadManifests(cache, "small", await bundleOf(KIB));
    const heavy = await bundleOf(MIB + 1);

    const entry = await getOrReadManifests(cache, "heavy", heavy);
    expect(entry.files["SKILL.md"]).toHaveLength(MIB + 1);
    expect(cache.get("heavy")).toBeUndefined();
    expect(cache.get("small")).toBeDefined();
    expect(cache.bytes).toBe(KIB);
    // The next read reads the bundle again.
    expect(await getOrReadManifests(cache, "heavy", heavy)).not.toBe(entry);
  });

  it("an extraction heavier than the whole budget, held by its run, keeps its directory until the release — never cached", async () => {
    const cache = cacheOf();
    const inUse = bundleExtractionsInUse();
    const { entry, lease } = await getOrExtract(cache, "heavy", await bundleOf(MIB + 1), {
      acquire: true,
    });
    expect(cache.get("heavy")).toBeUndefined();
    expect(existsSync(join(entry.dir, "SKILL.md"))).toBe(true);
    expect(ownedExtractionDirs()).toContain(entry.dir);
    expect(bundleExtractionsInUse()).toBe(inUse + 1);

    lease.release();
    expect(existsSync(entry.dir)).toBe(false);
    expect(ownedExtractionDirs()).not.toContain(entry.dir);
    expect(extractionsUnderRoot()).toEqual([]);
  });

  it("an extraction heavier than the whole budget, with no lease, leaves the disk at once", async () => {
    const cache = cacheOf();
    const entry = await getOrExtract(cache, "heavy", await bundleOf(MIB + 1));
    expect(cache.get("heavy")).toBeUndefined();
    expect(existsSync(entry.dir)).toBe(false);
    expect(ownedExtractionDirs()).not.toContain(entry.dir);
  });

  it("an extraction in use pushed out by the budget keeps its directory until its last lease, as by the count", async () => {
    const cache = cacheOf();
    const first = await getOrExtract(cache, "first", await bundleOf(600 * KIB, "f"), {
      acquire: true,
    });
    const second = acquireBundle(first.entry);
    const unused = await getOrExtract(cache, "unused", await bundleOf(100 * KIB, "u"));

    await getOrExtract(cache, "third", await bundleOf(600 * KIB, "t"));
    expect(cache.get("first")).toBeUndefined();
    expect(first.entry.evicted).toBe(true);
    expect(existsSync(first.entry.dir)).toBe(true);
    // The unused one, more recent, stays: the budget took only what it needed.
    expect(cache.get("unused")).toBe(unused);

    first.lease.release();
    expect(existsSync(first.entry.dir)).toBe(true);
    second.release();
    expect(existsSync(first.entry.dir)).toBe(false);
  });
});
