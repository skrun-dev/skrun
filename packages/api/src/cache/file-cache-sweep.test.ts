import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INPUT_DIR_NAME } from "../files/input-store.js";
import {
  FILE_CACHE_SWEEP_INTERVAL_MS,
  removeOrphanedFilesAtBoot,
  startFileCacheSweep,
  sweepExpiredFiles,
} from "./file-cache-sweep.js";
import { inputCache, registerInputFile } from "./input-cache.js";
import { _clearOutputCacheForTests, OUTPUT_DIR_PREFIX, registerOutput } from "./output-cache.js";

// Retention used to be "until the next read": an expired directory nobody asked
// for again stayed on disk. These cases pin the two things that changed — a
// sweep that deletes on its own, and a boot pass that removes what a previous
// process left — and the one thing that must NOT change: a live entry is never
// touched, and the boot pass never runs once anything is registered.
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
  afterEach(() => {
    _clearOutputCacheForTests();
    inputCache.clear();
    vi.useRealTimers();
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("removes an expired output directory without anyone reading it", () => {
    const dir = join(mk(), `${OUTPUT_DIR_PREFIX}run-1`);
    mkdirSync(dir);
    writeFileSync(join(dir, "result.txt"), "x");
    registerOutput("run-1", dir);

    vi.advanceTimersByTime(3_600_000 + 1); // the default output window, plus one tick
    expect(sweepExpiredFiles()).toEqual({ outputs: 1, inputs: 0 });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a live output directory alone", () => {
    const dir = join(mk(), `${OUTPUT_DIR_PREFIX}run-2`);
    mkdirSync(dir);
    registerOutput("run-2", dir);

    vi.advanceTimersByTime(10_000);
    expect(sweepExpiredFiles()).toEqual({ outputs: 0, inputs: 0 });
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
    expect(sweepExpiredFiles()).toEqual({ outputs: 0, inputs: 1 });
    expect(existsSync(path)).toBe(false);
  });

  it("at boot, removes the output directories and uploads a previous process left — and nothing else", () => {
    const root = mk();
    mkdirSync(join(root, `${OUTPUT_DIR_PREFIX}old-a`));
    mkdirSync(join(root, `${OUTPUT_DIR_PREFIX}old-b`));
    writeFileSync(join(root, `${OUTPUT_DIR_PREFIX}old-b`, "deep.txt"), "z");
    mkdirSync(join(root, "unrelated-dir"));
    writeFileSync(join(root, "unrelated-file"), "keep");
    mkdirSync(join(root, INPUT_DIR_NAME));
    writeFileSync(join(root, INPUT_DIR_NAME, "stale.bin"), "s");

    expect(removeOrphanedFilesAtBoot(root)).toEqual({ outputDirs: 2, inputFiles: 1 });
    expect(existsSync(join(root, `${OUTPUT_DIR_PREFIX}old-a`))).toBe(false);
    expect(existsSync(join(root, `${OUTPUT_DIR_PREFIX}old-b`))).toBe(false);
    expect(existsSync(join(root, INPUT_DIR_NAME, "stale.bin"))).toBe(false);
    expect(existsSync(join(root, INPUT_DIR_NAME))).toBe(true);
    expect(existsSync(join(root, "unrelated-dir"))).toBe(true);
    expect(existsSync(join(root, "unrelated-file"))).toBe(true);
  });

  it("refuses the orphan pass once anything is registered — a run in flight has a directory and no index entry yet", () => {
    const root = mk();
    mkdirSync(join(root, `${OUTPUT_DIR_PREFIX}in-flight`));
    const live = join(mk(), `${OUTPUT_DIR_PREFIX}live`);
    mkdirSync(live);
    registerOutput("live", live);

    expect(removeOrphanedFilesAtBoot(root)).toEqual({ outputDirs: 0, inputFiles: 0 });
    expect(existsSync(join(root, `${OUTPUT_DIR_PREFIX}in-flight`))).toBe(true);
  });

  it("starts with a boot pass and returns a timer that does not keep the process alive", () => {
    const root = mk();
    mkdirSync(join(root, `${OUTPUT_DIR_PREFIX}leftover`));

    const timer = startFileCacheSweep(root);
    try {
      expect(existsSync(join(root, `${OUTPUT_DIR_PREFIX}leftover`))).toBe(false);
      expect(FILE_CACHE_SWEEP_INTERVAL_MS).toBe(300_000);
      // The interval is the sweep, not another orphan pass: a directory created
      // after boot survives every tick.
      mkdirSync(join(root, `${OUTPUT_DIR_PREFIX}created-after-boot`));
      vi.advanceTimersByTime(FILE_CACHE_SWEEP_INTERVAL_MS * 3);
      expect(existsSync(join(root, `${OUTPUT_DIR_PREFIX}created-after-boot`))).toBe(true);
      // And the interval IS the sweep: a registered entry that expires is
      // gone by the next tick, with nobody reading it.
      const registered = join(root, `${OUTPUT_DIR_PREFIX}registered`);
      mkdirSync(registered);
      registerOutput("registered", registered);
      vi.advanceTimersByTime(3_600_000 + FILE_CACHE_SWEEP_INTERVAL_MS);
      expect(existsSync(registered)).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
