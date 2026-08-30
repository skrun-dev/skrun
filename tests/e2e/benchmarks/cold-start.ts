/**
 * Cold-start benchmark logic — SC-2 / VT-2.
 *
 * The actual benchmark function. Re-exported via `cold-start.test.ts`
 * (vitest wrapper) and used directly by `scripts/run-cold-start-bench.ts`
 * (standalone Windows-friendly runner).
 *
 * Why this is a `.ts` and not a `.test.ts`: importing vitest's
 * `describe()` from a non-test runner crashes with
 * "Cannot read properties of undefined (reading 'config')". So the pure
 * logic lives here; the vitest assertion wrapper lives next to it.
 *
 * See cold-start.test.ts for the full benchmark documentation
 * (measurement caveats, env-gating, etc.).
 */
import { FlyMachinesApi } from "../../../packages/runtime/src/adapter/flyio/fly-api.js";
import { buildMachineConfig } from "../../../packages/runtime/src/adapter/flyio/machine-config.js";

export interface BenchmarkResult {
  durations: number[];
  p95: number;
  p50: number;
  min: number;
  max: number;
  iterations: number;
}

export interface BenchmarkOptions {
  token: string;
  appName: string;
  image: string;
  iterations: number;
  /** Stream per-iteration progress to stdout. */
  log?: (msg: string) => void;
}

/**
 * Run the cold-start benchmark. Throws on infra failure (machine create
 * fails). Returns the collected durations + percentiles.
 *
 * Caller is responsible for env gating + asserting the result against
 * the threshold (SC-2 says P95 < 10_000 ms).
 */
export async function runColdStartBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  const api = new FlyMachinesApi(opts.token, opts.appName);
  const durations: number[] = [];
  const startTs = Date.now();
  const log = opts.log ?? (() => {});

  // Helper: run one spawn → destroy cycle, optionally recording duration.
  // 60s wait timeout handles the first-pull case (image not yet cached in
  // the region — Fly pulls ~750MB the first time it sees a new tag).
  // Subsequent iterations against the warm cache typically complete in
  // ~3-8 seconds.
  async function oneSpawn(label: string, record: boolean): Promise<void> {
    const runId = `bench-${startTs}-${label}`;
    const config = buildMachineConfig({
      runId,
      image: opts.image,
      bundleUrl: "https://example.com/dummy-bundle.tar.gz",
      outputsPutUrl: "https://example.com/dummy-outputs",
      allowedHosts: [],
    });

    const tStart = Date.now();
    let machineId: string | null = null;
    try {
      const machine = await api.create(config);
      machineId = machine.id;
      const waitUrl = `https://api.machines.dev/v1/apps/${encodeURIComponent(opts.appName)}/machines/${encodeURIComponent(machineId)}/wait?state=started&timeout=60`;
      const waitRes = await fetch(waitUrl, {
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (!waitRes.ok) {
        throw new Error(`wait?state=started returned ${waitRes.status}: ${await waitRes.text()}`);
      }
      const tReady = Date.now();
      const durationMs = tReady - tStart;
      if (record) {
        durations.push(durationMs);
      }
      log(`  ${label}: ${durationMs}ms${record ? "" : " (warm-up, not recorded)"}`);
    } finally {
      if (machineId) {
        try {
          await api.destroy(machineId);
        } catch (err) {
          log(`  cleanup failed for ${machineId}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Warm-up: prime the region's image cache so the first MEASURED spawn
  // isn't dominated by Fly's per-region tag pull (~1 min for ~750MB).
  // SC-2 measures the steady-state cold-start (= cache warm, instance
  // cold) which is what production runs experience on every spawn after
  // the first deploy.
  log("warm-up spawn (priming region image cache)...");
  await oneSpawn("warmup", false);

  for (let i = 0; i < opts.iterations; i++) {
    await oneSpawn(`spawn ${i + 1}/${opts.iterations}`, true);
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const idx95 = Math.ceil(0.95 * sorted.length) - 1;
  return {
    durations,
    p95: sorted[idx95],
    p50: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    iterations: durations.length,
  };
}
