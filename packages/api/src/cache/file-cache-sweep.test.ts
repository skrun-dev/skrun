import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packAgentTar } from "@skrun-dev/schema";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INPUT_DIR_NAME } from "../files/input-store.js";
import { acquireBundle, bundleCache, getOrExtract } from "./bundle-cache.js";
import {
  FILE_CACHE_SWEEP_INTERVAL_MS,
  ORPHAN_PASS_MAX_REMOVALS,
  orphanPassInFlight,
  removeOrphanedFiles,
  startFileCacheSweep,
  sweepExpiredFiles,
} from "./file-cache-sweep.js";
import { inputCache, registerInputFile } from "./input-cache.js";
import {
  _clearOutputCacheForTests,
  holdOutputDir,
  OUTPUT_DIR_PREFIX,
  registerOutput,
} from "./output-cache.js";

// Retention used to be "until the next read": an expired directory nobody asked
// for again stayed on disk. These cases pin the two things that changed — a
// sweep that deletes on its own, and an orphan pass, at boot and at every
// sweep, that removes what no live process holds — and the one thing that must
// NOT change: a live file, this process's or another instance's, is never
// removed.
describe("file cache sweep", () => {
  const roots: string[] = [];
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), "skrun-sweep-test-"));
    roots.push(d);
    return d;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    // A pass the timer started must end inside its own case: the next case's
    // timer would otherwise find it under way and skip its first pass.
    await orphanPassInFlight();
    _clearOutputCacheForTests();
    inputCache.clear();
    bundleCache.clear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("removes an expired output directory without anyone reading it", () => {
    const dir = join(mk(), `${OUTPUT_DIR_PREFIX}run-1`);
    mkdirSync(dir);
    writeFileSync(join(dir, "result.txt"), "x");
    registerOutput("run-1", dir);

    vi.advanceTimersByTime(3_600_000 + 1); // the default output window, plus one tick
    expect(sweepExpiredFiles()).toEqual({
      outputs: 1,
      inputs: 0,
      bundlesRemoved: 0,
      bundlesHeld: 0,
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a live output directory alone", () => {
    const dir = join(mk(), `${OUTPUT_DIR_PREFIX}run-2`);
    mkdirSync(dir);
    registerOutput("run-2", dir);

    vi.advanceTimersByTime(10_000);
    expect(sweepExpiredFiles()).toEqual({
      outputs: 0,
      inputs: 0,
      bundlesRemoved: 0,
      bundlesHeld: 0,
    });
    expect(existsSync(dir)).toBe(true);
  });

  it("removes an expired uploaded input the same way", () => {
    const path = join(mk(), "upload.bin");
    writeFileSync(path, "y");
    registerInputFile("file-1", {
      path,
      size: 1,
      media_type: "application/octet-stream",
      purpose: "input",
      expires_at: new Date(Date.now() + 86_400_000),
      owner_id: "u1",
    });

    vi.advanceTimersByTime(86_400_000 + 1); // the default input window, plus one tick
    expect(sweepExpiredFiles()).toEqual({
      outputs: 0,
      inputs: 1,
      bundlesRemoved: 0,
      bundlesHeld: 0,
    });
    expect(existsSync(path)).toBe(false);
  });

  // An extracted bundle is cached by its bytes: once its version is deleted
  // nobody asks for that key again, and an expiry found only on a read would
  // leave its directory on disk for good. The sweep removes it anyway.
  it("removes an expired bundle extraction without anyone reading it, and leaves a live one", async () => {
    const old = await getOrExtract(bundleCache, "old-bytes", await tinyBundle("old"));
    vi.advanceTimersByTime(300_000);
    const live = await getOrExtract(bundleCache, "live-bytes", await tinyBundle("live"));
    expect(existsSync(old.dir)).toBe(true);

    vi.advanceTimersByTime(300_000 + 1); // the old one is past the default 600 s, the live one is not
    const swept = sweepExpiredFiles();
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(live.dir)).toBe(true);
    expect(bundleCache.size).toBe(1);
    expect(swept).toEqual({ outputs: 0, inputs: 0, bundlesRemoved: 1, bundlesHeld: 0 });
  });

  // An expired extraction a run still holds leaves the cache, and its directory
  // stays: the sweep counts it apart from the ones it removed from disk.
  it("counts an expired extraction still in use apart from the ones it removed", async () => {
    const held = await getOrExtract(bundleCache, "held-bytes", await tinyBundle("held"), {
      acquire: true,
    });
    const unused = await getOrExtract(bundleCache, "unused-bytes", await tinyBundle("unused"));

    vi.advanceTimersByTime(600_000 + 1);
    expect(sweepExpiredFiles()).toEqual({
      outputs: 0,
      inputs: 0,
      bundlesRemoved: 1,
      bundlesHeld: 1,
    });
    expect(existsSync(unused.dir)).toBe(false);
    expect(existsSync(held.entry.dir)).toBe(true);
    held.lease.release();
    expect(existsSync(held.entry.dir)).toBe(false);
  });

  it("at boot, removes the output directories and uploads a previous process left — and nothing else", async () => {
    const root = mk();
    const oldA = join(root, outputName());
    const oldB = join(root, outputName());
    mkdirSync(oldA);
    mkdirSync(oldB);
    writeFileSync(join(oldB, "deep.txt"), "z");
    mkdirSync(join(root, "unrelated-dir"));
    writeFileSync(join(root, "unrelated-file"), "keep");
    mkdirSync(join(root, INPUT_DIR_NAME));
    writeFileSync(join(root, INPUT_DIR_NAME, "stale.bin"), "s");
    // Left days ago: past every window.
    for (const path of [oldA, oldB, join(root, INPUT_DIR_NAME, "stale.bin")]) {
      ageBy(path, 3 * 86_400_000);
    }

    expect(await removeOrphanedFiles(root)).toEqual({
      outputDirs: 2,
      inputFiles: 1,
      bundleDirs: 0,
    });
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    expect(existsSync(join(root, INPUT_DIR_NAME, "stale.bin"))).toBe(false);
    expect(existsSync(join(root, INPUT_DIR_NAME))).toBe(true);
    expect(existsSync(join(root, "unrelated-dir"))).toBe(true);
    expect(existsSync(join(root, "unrelated-file"))).toBe(true);
  });

  // The pass runs on the timer too, so it meets what this process holds: a run
  // in flight, a registered output or upload, a cached extraction. However old
  // one looks, the pass leaves it; a true leftover beside them still goes.
  it("the orphan pass never removes what this process holds, however old it looks", async () => {
    const root = mk();
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
    const leftover = join(root, outputName());
    const inFlight = join(root, outputName());
    const registered = join(root, outputName());
    for (const dir of [leftover, inFlight, registered]) mkdirSync(dir);
    const hold = holdOutputDir(inFlight);
    registerOutput("registered", registered);
    mkdirSync(join(root, INPUT_DIR_NAME));
    const upload = join(root, INPUT_DIR_NAME, "upload.bin");
    writeFileSync(upload, "u");
    registerInputFile("held-upload", uploadMeta(upload));
    const cached = await getOrExtract(bundleCache, "cached", await tinyBundle("cached"));
    expect(dirname(cached.dir)).toBe(root);
    for (const path of [leftover, inFlight, registered, upload, cached.dir]) {
      ageBy(path, 3 * 86_400_000);
    }
    try {
      expect(await removeOrphanedFiles(root)).toEqual({
        outputDirs: 1,
        inputFiles: 0,
        bundleDirs: 0,
      });
      expect(existsSync(leftover)).toBe(false);
      for (const kept of [inFlight, registered, upload, cached.dir]) {
        expect(existsSync(kept), kept).toBe(true);
      }
    } finally {
      hold.release();
    }
  });

  // A registered output or upload carries its deadline as its modification
  // time. No instance sharing the temp root, whatever its own windows, removes
  // it before that deadline plus two sweeps; once its server is gone, one
  // removes it by the next sweep after that — counted from its creation, never
  // from the server's last sweep.
  it("a registered output or upload outlives its server only until its deadline plus two to three sweeps", async () => {
    const root = mk();
    const dir = join(root, outputName());
    mkdirSync(dir);
    registerOutput("registered-long", dir);
    mkdirSync(join(root, INPUT_DIR_NAME));
    const upload = join(root, INPUT_DIR_NAME, "upload.bin");
    writeFileSync(upload, "u");
    registerInputFile("upload-long", uploadMeta(upload));
    const created = Date.now();

    // Its server sweeps for 55 minutes, then stops: nothing touches either again.
    for (let sweeps = 0; sweeps < 11; sweeps++) {
      vi.advanceTimersByTime(FILE_CACHE_SWEEP_INTERVAL_MS);
      sweepExpiredFiles();
    }
    // Another instance passes at chosen times: the pass reads no window of
    // its own, only the time each file carries.
    const passAt = (sinceCreation: number) =>
      removeOrphanedFiles(root, created + sinceCreation, ANOTHER_INSTANCE);
    const twoSweeps = 2 * FILE_CACHE_SWEEP_INTERVAL_MS;

    expect((await passAt(3_600_000 + twoSweeps - 60_000)).outputDirs).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect((await passAt(3_600_000 + twoSweeps + 60_000)).outputDirs).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect((await passAt(86_400_000 + twoSweeps - 60_000)).inputFiles).toBe(0);
    expect(existsSync(upload)).toBe(true);
    expect((await passAt(86_400_000 + twoSweeps + 60_000)).inputFiles).toBe(1);
    expect(existsSync(upload)).toBe(false);
  });

  // A leftover whose time is not yet two sweeps old at boot used to stay until
  // a later restart. The pass runs at every sweep: it goes once it comes of age.
  it("a leftover too recent to remove at boot goes at a later sweep, with no restart", async () => {
    const root = mk();
    const out = join(root, outputName());
    mkdirSync(out);
    ageBy(out, 5 * 60_000);
    mkdirSync(join(root, INPUT_DIR_NAME));
    const upload = join(root, INPUT_DIR_NAME, "upload.bin");
    writeFileSync(upload, "u");
    ageBy(upload, 5 * 60_000);

    const timer = startFileCacheSweep(root);
    try {
      await orphanPassInFlight();
      expect(existsSync(out)).toBe(true);
      expect(existsSync(upload)).toBe(true);
      await ticks(3);
      expect(existsSync(out)).toBe(false);
      expect(existsSync(upload)).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  // A bundle extraction a previous process left is removed at boot — but the
  // temp root may be shared with another instance still running, so only a
  // directory with the whole name an extraction gets, and only two sweeps past
  // the time it carries: a live one carries a time ahead.
  it("at boot, removes an old leftover extraction by its whole name, never what only looks like one", async () => {
    const root = mk();
    const outside = mk(); // a link's target, out of the root
    writeFileSync(join(outside, "keep.txt"), "keep");
    const minutesAgo = (path: string, minutes: number): void => {
      const at = new Date(Date.now() - minutes * 60_000);
      utimesSync(path, at, at);
    };
    const uuid = (): string => randomUUID();

    const leftover = join(root, `skrun-agent-${uuid()}`);
    mkdirSync(leftover);
    writeFileSync(join(leftover, "SKILL.md"), "x");
    // The dependency link an extraction can carry: removing the extraction
    // removes the link, never what it points to.
    symlinkSync(outside, join(leftover, "node_modules"), "junction");
    minutesAgo(leftover, 21);

    const notAUuid = join(root, "skrun-agent-notauuid");
    const trailing = join(root, `skrun-agent-${uuid()}-x`);
    const other = join(root, `other-${uuid()}`);
    const recent = join(root, `skrun-agent-${uuid()}`); // within two sweeps of its time
    const ahead = join(root, `skrun-agent-${uuid()}`); // another instance's, still held
    for (const dir of [notAUuid, trailing, other, recent, ahead]) mkdirSync(dir);
    const file = join(root, `skrun-agent-${uuid()}`);
    writeFileSync(file, "a file, not an extraction");
    const link = join(root, `skrun-agent-${uuid()}`);
    symlinkSync(outside, link, "junction");
    for (const path of [notAUuid, trailing, other, file]) minutesAgo(path, 60);
    minutesAgo(recent, 9);
    minutesAgo(ahead, -10);

    expect(await removeOrphanedFiles(root)).toEqual({
      outputDirs: 0,
      inputFiles: 0,
      bundleDirs: 1,
    });
    expect(existsSync(leftover)).toBe(false);
    for (const kept of [notAUuid, trailing, other, recent, ahead, file, link]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  // A run's output directory is named the prefix plus the run's uuid, directly
  // under the root, and nothing else is taken for one.
  it("at boot, removes an old leftover output directory by its whole name, never what only looks like one", async () => {
    const root = mk();
    const leftover = join(root, outputName());
    const notAUuid = join(root, `${OUTPUT_DIR_PREFIX}notauuid`);
    const trailing = join(root, `${outputName()}-x`);
    for (const dir of [leftover, notAUuid, trailing]) {
      mkdirSync(dir);
      ageBy(dir, 3 * 86_400_000);
    }
    const file = join(root, outputName());
    writeFileSync(file, "a file, not an output directory");
    ageBy(file, 3 * 86_400_000);

    expect((await removeOrphanedFiles(root)).outputDirs).toBe(1);
    expect(existsSync(leftover)).toBe(false);
    for (const kept of [notAUuid, trailing, file]) expect(existsSync(kept), kept).toBe(true);
  });

  // A run longer than the window holds its extraction: every sweep touches
  // what this process holds, so another instance starting on the same temp
  // root never finds it old.
  it("an extraction held by a run 25 minutes long stays young, and another instance's orphan pass keeps it", async () => {
    const root = mk();
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
    try {
      const entry = await getOrExtract(bundleCache, "held", await tinyBundle("held"));
      expect(dirname(entry.dir)).toBe(root);
      const lease = acquireBundle(entry);

      for (let sweeps = 0; sweeps < 5; sweeps++) {
        vi.advanceTimersByTime(FILE_CACHE_SWEEP_INTERVAL_MS);
        sweepExpiredFiles();
      }
      // Past the cache's 600 s: the entry has left the cache, the run still holds it.
      expect(bundleCache.size).toBe(0);
      const removableAfter = statSync(entry.dir).mtimeMs;

      expect((await removeOrphanedFiles(root, Date.now(), ANOTHER_INSTANCE)).bundleDirs).toBe(0);
      expect(existsSync(entry.dir)).toBe(true);
      expect(removableAfter).toBeGreaterThan(Date.now());

      lease.release();
      expect(existsSync(entry.dir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // The same rule for run outputs and uploads: a leftover goes two sweeps past
  // the time it carries, whatever window the passing instance is set to.
  it("removes a leftover output directory or upload only two sweeps past the time it carries", async () => {
    const root = mk();
    const names = new Map<string, string>();
    const out = (name: string): string => {
      if (!names.has(name)) names.set(name, outputName());
      return join(root, names.get(name) as string);
    };
    const upload = (name: string): string => join(root, INPUT_DIR_NAME, name);
    mkdirSync(join(root, INPUT_DIR_NAME));
    for (const name of ["old", "recent", "ahead"]) {
      mkdirSync(out(name));
      writeFileSync(upload(name), name);
    }
    for (const path of [out("old"), upload("old")]) ageBy(path, 11 * 60_000);
    for (const path of [out("recent"), upload("recent")]) ageBy(path, 9 * 60_000);
    for (const path of [out("ahead"), upload("ahead")]) ageBy(path, -3_600_000);

    expect(await removeOrphanedFiles(root)).toEqual({
      outputDirs: 1,
      inputFiles: 1,
      bundleDirs: 0,
    });
    expect(existsSync(out("old"))).toBe(false);
    expect(existsSync(upload("old"))).toBe(false);
    for (const kept of [out("recent"), out("ahead"), upload("recent"), upload("ahead")]) {
      expect(existsSync(kept), kept).toBe(true);
    }
  });

  // The deadline a registered file carries is its cache's: the window an
  // operator sets, read when the cache is built.
  it("the window an operator sets moves the deadline a registered output or upload carries", async () => {
    vi.stubEnv("FILES_RETENTION_S", "60");
    vi.stubEnv("INPUT_FILES_RETENTION_S", "120");
    vi.resetModules();
    const outputs = await import("./output-cache.js");
    const inputs = await import("./input-cache.js");
    const root = mk();
    const dir = join(root, outputName());
    mkdirSync(dir);
    const upload = join(root, "upload.bin");
    writeFileSync(upload, "u");
    try {
      outputs.registerOutput("short-window", dir);
      inputs.registerInputFile("short-upload", uploadMeta(upload));
      expect(Math.abs(statSync(dir).mtimeMs - (Date.now() + 60_000))).toBeLessThan(1_000);
      expect(Math.abs(statSync(upload).mtimeMs - (Date.now() + 120_000))).toBeLessThan(1_000);
    } finally {
      outputs._clearOutputCacheForTests();
      inputs.inputCache.clear();
    }
  });

  // A run's output directory is made when the run starts, and its window
  // starts only when the run completes: a run longer than the window holds its
  // directory, and every sweep touches it.
  it("the output directory of a run going on for 2 hours stays young, and another instance's orphan pass keeps it", async () => {
    const root = mk();
    const dir = join(root, outputName());
    mkdirSync(dir);
    const hold = holdOutputDir(dir);
    try {
      for (let sweeps = 0; sweeps < 24; sweeps++) {
        vi.advanceTimersByTime(FILE_CACHE_SWEEP_INTERVAL_MS);
        sweepExpiredFiles();
      }
      const removableAfter = statSync(dir).mtimeMs;

      expect((await removeOrphanedFiles(root, Date.now(), ANOTHER_INSTANCE)).outputDirs).toBe(0);
      expect(existsSync(dir)).toBe(true);
      expect(removableAfter).toBeGreaterThan(Date.now());
    } finally {
      hold.release();
    }
  });

  it("starts with an orphan pass and returns a timer that does not keep the process alive", async () => {
    const root = mk();
    const leftover = join(root, outputName());
    mkdirSync(leftover);
    ageBy(leftover, 3 * 86_400_000);

    const timer = startFileCacheSweep(root);
    try {
      await orphanPassInFlight();
      expect(existsSync(leftover)).toBe(false);
      expect(FILE_CACHE_SWEEP_INTERVAL_MS).toBe(300_000);
      // A directory a run holds survives every tick.
      const createdAfterBoot = join(root, outputName());
      mkdirSync(createdAfterBoot);
      const hold = holdOutputDir(createdAfterBoot);
      await ticks(3);
      expect(existsSync(createdAfterBoot)).toBe(true);
      hold.release();
      // And the interval IS the sweep: a registered entry that expires is
      // gone by the next tick, with nobody reading it.
      const registered = join(root, outputName());
      mkdirSync(registered);
      registerOutput("registered", registered);
      vi.advanceTimersByTime(3_600_000);
      await ticks(1);
      expect(existsSync(registered)).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  // A self-host upgraded from a version that never removed extractions can
  // hold tens of thousands under its temp root. A pass run before the server
  // listened kept it from answering its health check for minutes: starting the
  // sweep hands back at once, and the pass goes on in the background.
  it("starting the sweep hands back before its orphan pass ends, whatever the stock", async () => {
    const root = mk();
    const stock = 1_000;
    const leftovers: string[] = [];
    for (let i = 0; i < stock; i++) {
      const dir = join(root, `skrun-agent-${randomUUID()}`);
      mkdirSync(dir);
      ageBy(dir, 3 * 86_400_000);
      leftovers.push(dir);
    }

    const timer = startFileCacheSweep(root);
    try {
      expect(leftovers.filter((dir) => existsSync(dir)).length).toBe(stock);
      expect(orphanPassInFlight()).toBeDefined();
      expect(await orphanPassInFlight()).toEqual({
        outputDirs: 0,
        inputFiles: 0,
        bundleDirs: stock,
      });
      expect(leftovers.filter((dir) => existsSync(dir)).length).toBe(0);
    } finally {
      clearInterval(timer);
    }
  });

  // A pass that meets a stock larger than its bound removes that many and
  // leaves the rest: uploads first, then output directories, then
  // extractions.
  it("one pass removes at most its bound, uploads first, then output directories", async () => {
    const root = mk();
    mkdirSync(join(root, INPUT_DIR_NAME));
    const uploads = ["a.bin", "b.bin"].map((name) => join(root, INPUT_DIR_NAME, name));
    for (const path of uploads) writeFileSync(path, "u");
    const outputs = [outputName(), outputName()].map((name) => join(root, name));
    const extractions = [1, 2, 3].map(() => join(root, `skrun-agent-${randomUUID()}`));
    for (const dir of [...outputs, ...extractions]) mkdirSync(dir);
    for (const path of [...uploads, ...outputs, ...extractions]) ageBy(path, 3 * 86_400_000);

    expect(await removeOrphanedFiles(root, Date.now(), ANOTHER_INSTANCE, 3)).toEqual({
      outputDirs: 1,
      inputFiles: 2,
      bundleDirs: 0,
    });
    for (const path of uploads) expect(existsSync(path), path).toBe(false);
    expect(outputs.filter((dir) => existsSync(dir)).length).toBe(1);
    expect(extractions.filter((dir) => existsSync(dir)).length).toBe(3);
    expect(await removeOrphanedFiles(root, Date.now(), ANOTHER_INSTANCE, 3)).toEqual({
      outputDirs: 1,
      inputFiles: 0,
      bundleDirs: 2,
    });
  });

  // The bound the timer's passes take: a stock larger than it goes over the
  // following passes, one interval apart.
  it("a stock larger than the bound goes over the following passes", async () => {
    const root = mk();
    const leftovers = Array.from({ length: 7 }, () => join(root, `skrun-agent-${randomUUID()}`));
    for (const dir of leftovers) {
      mkdirSync(dir);
      ageBy(dir, 3 * 86_400_000);
    }
    const remaining = () => leftovers.filter((dir) => existsSync(dir)).length;

    const timer = startFileCacheSweep(root, 3);
    try {
      await orphanPassInFlight();
      expect(remaining()).toBe(4);
      await ticks(1);
      expect(remaining()).toBe(1);
      await ticks(1);
      expect(remaining()).toBe(0);
    } finally {
      clearInterval(timer);
    }
    expect(ORPHAN_PASS_MAX_REMOVALS).toBe(20_000);
  });

  // A pass slower than the interval must not be joined by a second one over
  // the same entries: the tick that finds one under way leaves it be.
  it("a tick that finds an orphan pass under way starts no second one", async () => {
    const root = mk();
    const stock = 200;
    for (let i = 0; i < stock; i++) {
      const dir = join(root, `skrun-agent-${randomUUID()}`);
      mkdirSync(dir);
      ageBy(dir, 3 * 86_400_000);
    }

    const timer = startFileCacheSweep(root);
    try {
      const first = orphanPassInFlight();
      expect(first).toBeDefined();
      vi.advanceTimersByTime(FILE_CACHE_SWEEP_INTERVAL_MS);
      expect(orphanPassInFlight()).toBe(first);
      expect(await first).toEqual({ outputDirs: 0, inputFiles: 0, bundleDirs: stock });
      expect(orphanPassInFlight()).toBeUndefined();
    } finally {
      clearInterval(timer);
    }
  });

  // The cases above call the starter directly: they would stay green if no
  // server ever started it. These two files are the ones that run a server;
  // their source is read as a syntax tree, so a call commented out is no call.
  // Each starts it once the server listens — inside the callback `serve` calls
  // then — and nowhere else, so the first pass never runs before the server
  // can answer.
  it("both server entry points start the sweep once the server listens, and only then", () => {
    for (const entry of ["server.ts", "dev.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", entry), "utf8");
      expect(callsOf(source, "startFileCacheSweep"), entry).toEqual({
        insideServeCallback: 1,
        elsewhere: 0,
      });
    }
  });
});

/** Let `n` sweep intervals pass, each followed by the end of the orphan pass it started. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(FILE_CACHE_SWEEP_INTERVAL_MS);
    await orphanPassInFlight();
  }
}

/** What another instance sharing the temp root knows this one holds: nothing. */
const ANOTHER_INSTANCE: ReadonlySet<string> = new Set();

/** An uploaded input's metadata, for a file at `path`. */
function uploadMeta(path: string) {
  return {
    path,
    size: 1,
    media_type: "application/octet-stream",
    purpose: "input" as const,
    expires_at: new Date(Date.now() + 86_400_000),
    owner_id: "u1",
    uploaded_by_key_id: null,
  };
}

/** The whole name a run's output directory gets: the prefix, then the run's uuid. */
function outputName(): string {
  return `${OUTPUT_DIR_PREFIX}${randomUUID()}`;
}

/** Set a path's modification time `ms` before now. */
function ageBy(path: string, ms: number): void {
  const at = new Date(Date.now() - ms);
  utimesSync(path, at, at);
}

/** A bundle that extracts: one file whose content tells the bundles apart. */
function tinyBundle(text: string): Promise<Buffer> {
  return packAgentTar([{ name: "SKILL.md", content: Buffer.from(text) }]);
}

/**
 * How many times `source` calls `name`, read as a syntax tree rather than as
 * text: inside a function passed to a `serve(...)` call, and elsewhere.
 */
function callsOf(source: string, name: string): { insideServeCallback: number; elsewhere: number } {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const counts = { insideServeCallback: 0, elsewhere: 0 };
  const isServeCallback = (node: ts.Node): boolean =>
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(node.parent) &&
    ts.isIdentifier(node.parent.expression) &&
    node.parent.expression.text === "serve" &&
    node.parent.arguments.includes(node);
  const visit = (node: ts.Node, inside: boolean): void => {
    const nowInside = inside || isServeCallback(node);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      if (nowInside) counts.insideServeCallback++;
      else counts.elsewhere++;
    }
    ts.forEachChild(node, (child) => visit(child, nowInside));
  };
  visit(file, false);
  return counts;
}
