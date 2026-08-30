/**
 * Cold-start benchmark vitest wrapper — SC-2 / VT-2.
 *
 * The benchmark logic lives in `cold-start.ts` so both this vitest test
 * AND the standalone runner (`scripts/run-cold-start-bench.ts`, invoked
 * via `pnpm bench:cold-start`) can share it without coupling to vitest's
 * runtime.
 *
 * On Linux/macOS the standard `pnpm test:e2e tests/e2e/benchmarks/cold-start.test.ts`
 * with FLY_API_TOKEN exported works. On Windows the standalone runner is
 * recommended because vitest 4's fork pool doesn't propagate the
 * `--use-system-ca` Node flag needed for the AV-MITM cert dance — see
 * `scripts/run-cold-start-bench.ts` for the long explanation.
 *
 * Env-gated on `FLY_API_TOKEN` + `FLY_TEST_APP_NAME` — skipped by default.
 * Each invocation costs ~$0.002 in Fly machine-seconds (20 × ~10s cold
 * boot). Not safe for every PR; nightly cron or manual.
 *
 * Measurement caveat: from outside Fly's 6PN private network we can't
 * probe the runner's `/healthz` directly, so we use Fly's
 * `/wait?state=started` blocking endpoint as the closest proxy. The
 * P95 we measure is a slight under-estimate of "boot → ready-RPC" (the
 * runner's Hono server takes a further ~500ms-2s after state=started).
 * If state=started P95 is < 10s with margin, ready-RPC fits too.
 */
import { describe, expect, it } from "vitest";
import { runColdStartBenchmark } from "./cold-start.js";

const FLY_API_TOKEN = process.env.FLY_API_TOKEN;
const FLY_TEST_APP_NAME = process.env.FLY_TEST_APP_NAME;
const FLY_TEST_IMAGE = process.env.FLY_TEST_IMAGE;
const ITERATIONS = Number(process.env.COLD_START_ITERATIONS ?? "20");

const HAVE_CLOUD_ENV = !!FLY_API_TOKEN && !!FLY_TEST_APP_NAME && !!FLY_TEST_IMAGE;
const describeCold = HAVE_CLOUD_ENV ? describe : describe.skip;

describeCold("SC-2 / VT-2: cold-start P95 < 10s over 20 spawns", () => {
  if (!HAVE_CLOUD_ENV) {
    it("SKIP — set FLY_API_TOKEN + FLY_TEST_APP_NAME + FLY_TEST_IMAGE and run via `pnpm bench:cold-start`", () => {});
    return;
  }

  it(
    `${ITERATIONS} sequential spawns → P95 < 10s`,
    async () => {
      const result = await runColdStartBenchmark({
        token: FLY_API_TOKEN as string,
        appName: FLY_TEST_APP_NAME as string,
        image: FLY_TEST_IMAGE as string,
        iterations: ITERATIONS,
      });
      // biome-ignore lint/suspicious/noConsole: D-1 PASS line
      console.log(
        `PASS cold-start: p95=${result.p95}ms p50=${result.p50}ms min=${result.min}ms max=${result.max}ms over ${result.iterations} spawns`,
      );
      expect(result.p95).toBeLessThan(10_000);
    },
    10 * 60 * 1000,
  );
});
