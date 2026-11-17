import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _clearOutputCacheForTests,
  filesRetentionSeconds,
  getOutputDir,
  getOutputRunId,
  holdOutputDir,
  outputCache,
  outputDirHolds,
  registerOutput,
} from "./output-cache.js";

// The reverse index (file_id -> run) is filled when a run's outputs are
// registered. Whatever removes the run from the cache — a delete, or its
// expiry found by a sweep or by a read — must take its file ids with it, or the
// index only ever grows.
describe("output cache: evicting a run drops its file ids", () => {
  // Directories that do not exist: eviction removes a run's directory, and
  // there is nothing here to remove.
  const dirOf = (runId: string): string => join(tmpdir(), `skrun-output-cache-test-${runId}`);

  function registerTwoRuns(): void {
    registerOutput("run_a", dirOf("run_a"), [
      { name: "a.txt", size: 1, file_id: "fil_a" },
      { name: "b.txt", size: 1, file_id: "fil_b" },
    ]);
    registerOutput("run_b", dirOf("run_b"), [{ name: "c.txt", size: 1, file_id: "fil_c" }]);
  }

  afterEach(() => {
    _clearOutputCacheForTests();
    vi.useRealTimers();
  });

  it("drops them when the run is deleted from the cache, and leaves another run's", () => {
    registerTwoRuns();
    expect(getOutputRunId("fil_a")).toBe("run_a");

    outputCache.delete("run_a");

    expect(getOutputRunId("fil_a")).toBeUndefined();
    expect(getOutputRunId("fil_b")).toBeUndefined();
    expect(getOutputRunId("fil_c")).toBe("run_b");
  });

  it.each([
    ["a sweep", () => outputCache.sweep()],
    ["a read of the run", () => getOutputDir("run_a")],
  ])("drops them when the run expires, found by %s", (_, find) => {
    vi.useFakeTimers();
    registerOutput("run_a", dirOf("run_a"), [
      { name: "a.txt", size: 1, file_id: "fil_a" },
      { name: "b.txt", size: 1, file_id: "fil_b" },
    ]);
    vi.advanceTimersByTime(filesRetentionSeconds() * 1000 + 1);

    find();

    // The premise: the run has left the cache.
    expect(getOutputDir("run_a")).toBeUndefined();
    expect(getOutputRunId("fil_a")).toBeUndefined();
    expect(getOutputRunId("fil_b")).toBeUndefined();
  });
});

// The orphan pass of an instance sharing the temp root removes a run's output
// directory only two sweeps past the time it carries. A registered directory
// carries its deadline, set at its registration and again at every sweep.
describe("output cache: what keeps a live output directory young", () => {
  const dirs: string[] = [];

  afterEach(() => {
    _clearOutputCacheForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("registering a run's output directory sets its modification time to its deadline", () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-output-cache-touch-"));
    dirs.push(dir);
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(dir, threeHoursAgo, threeHoursAgo);

    registerOutput("run_touched", dir);

    // The default window, one hour, from now.
    expect(Math.abs(statSync(dir).mtimeMs - (Date.now() + 3_600_000))).toBeLessThan(60_000);
  });

  it("a hold on an output directory is given back once, however often it is released", () => {
    const before = outputDirHolds();
    const first = holdOutputDir("/nowhere/a");
    const second = holdOutputDir("/nowhere/a");
    expect(outputDirHolds()).toBe(before + 2);

    first.release();
    first.release();
    expect(outputDirHolds()).toBe(before + 1);

    second.release();
    expect(outputDirHolds()).toBe(before);
  });
});
