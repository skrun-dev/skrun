import {
  acquisitionBudgetMs,
  FLY_APP_ACTION_BURST,
  seatDeadlineMarginMs,
} from "@skrun-dev/runtime";
import { describe, expect, it } from "vitest";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import { runAcquisitionBounds } from "./acquisition-bounds.js";

describe("the bounds of a run's acquisition", () => {
  it("without an instance cap, counts the platform's burst of creations, pool or not", () => {
    const unbounded = parseQuotaEnv({});
    for (const poolRunning of [false, true]) {
      expect(runAcquisitionBounds(unbounded, poolRunning)).toEqual({
        concurrentCreates: FLY_APP_ACTION_BURST,
        acquisitionBudgetMs: acquisitionBudgetMs({ concurrentCreates: FLY_APP_ACTION_BURST }),
        seatMarginMs: seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST }),
      });
    }
  });

  it("with an instance cap, counts its runs, and one more while a pool refills", () => {
    const capped = parseQuotaEnv({ SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20" });
    expect(runAcquisitionBounds(capped, false)).toEqual({
      concurrentCreates: 20,
      acquisitionBudgetMs: acquisitionBudgetMs({ concurrentCreates: 20 }),
      seatMarginMs: seatDeadlineMarginMs({ concurrentCreates: 20 }),
    });
    expect(runAcquisitionBounds(capped, true)).toEqual({
      concurrentCreates: 21,
      acquisitionBudgetMs: acquisitionBudgetMs({ concurrentCreates: 21 }),
      seatMarginMs: seatDeadlineMarginMs({ concurrentCreates: 21 }),
    });
  });

  it("keeps a seat's margin past the acquisition's whole budget", () => {
    for (const cap of [null, 1, 20]) {
      const bounds = runAcquisitionBounds({ instanceCap: cap }, true);
      expect(bounds.seatMarginMs).toBeGreaterThan(bounds.acquisitionBudgetMs);
    }
  });
});
