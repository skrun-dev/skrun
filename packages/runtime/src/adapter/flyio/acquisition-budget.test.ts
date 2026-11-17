import { describe, expect, it } from "vitest";
import { acquisitionBudgetMs, seatDeadlineMarginMs } from "./acquisition-budget.js";
import { DEFAULT_MAX_BOOT_TIME_MS, INIT_RPC_TIMEOUT_MS } from "./adapter.js";
import { createWorstCaseMs, FLY_APP_ACTION_BURST } from "./fly-api.js";
import { OUTPUTS_UPLOAD_BUDGET_MS } from "./outputs-upload.js";

// Every expected value is recomputed from the exported bounds: a number copied
// here would stay right while the bounds it came from moved.
describe("the acquisition budget and the seat margin", () => {
  it("bound an acquisition by one creation's worst case, the boot budget and the wait for /init", () => {
    expect(acquisitionBudgetMs({ concurrentCreates: 21 })).toBe(
      createWorstCaseMs({ concurrentCreates: 21 }) + DEFAULT_MAX_BOOT_TIME_MS + INIT_RPC_TIMEOUT_MS,
    );
    // The same figures written out, as a reading aid: 141 + 90 + 300.
    expect(acquisitionBudgetMs({ concurrentCreates: 21 })).toBe(531_000);
  });

  it("follow the boot budget the adapter is given", () => {
    expect(acquisitionBudgetMs({ concurrentCreates: 3, maxBootTimeMs: 30_000 })).toBe(
      createWorstCaseMs({ concurrentCreates: 3 }) + 30_000 + INIT_RPC_TIMEOUT_MS,
    );
  });

  it("count no wait for a slot without a cap: the platform's burst", () => {
    expect(acquisitionBudgetMs({ concurrentCreates: FLY_APP_ACTION_BURST })).toBe(
      createWorstCaseMs({ concurrentCreates: 1 }) + DEFAULT_MAX_BOOT_TIME_MS + INIT_RPC_TIMEOUT_MS,
    );
  });

  it("keep a seat for the acquisition budget and the outputs upload past the timeout", () => {
    expect(seatDeadlineMarginMs({ concurrentCreates: 21 })).toBe(
      acquisitionBudgetMs({ concurrentCreates: 21 }) + OUTPUTS_UPLOAD_BUDGET_MS,
    );
    expect(seatDeadlineMarginMs({ concurrentCreates: 21 })).toBe(651_000);
  });

  it.each([
    1, 3, 21, 100,
  ])("leave the margin at least the budget plus the upload, for %i creations at once", (concurrentCreates) => {
    for (const maxBootTimeMs of [undefined, 1, 120_000]) {
      const input = { concurrentCreates, maxBootTimeMs };
      expect(seatDeadlineMarginMs(input)).toBeGreaterThanOrEqual(
        acquisitionBudgetMs(input) + OUTPUTS_UPLOAD_BUDGET_MS,
      );
      expect(seatDeadlineMarginMs(input)).toBeGreaterThanOrEqual(acquisitionBudgetMs(input));
    }
  });
});
