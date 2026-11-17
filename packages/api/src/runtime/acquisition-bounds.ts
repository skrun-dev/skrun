/**
 * The bounds of a run's acquisition of its machine on the cloud runtime,
 * computed in one place. The run routes hand them to every run; whatever else
 * must agree with them reads them here, never a copy of the arithmetic.
 */
import {
  acquisitionBudgetMs,
  FLY_APP_ACTION_BURST,
  seatDeadlineMarginMs,
} from "@skrun-dev/runtime";
import type { QuotaConfig } from "../quotas/thresholds.js";

/** What bounds a run's acquisition of its machine. */
export interface RunAcquisitionBounds {
  /**
   * How many creations this process may be asked for at once: the runs the
   * instance cap lets it hold, plus one while a pool refills (the refill
   * creates one machine at a time); without a cap, the platform's burst.
   */
  concurrentCreates: number;
  /** The budget a run's acquisition of its machine is held to, in ms. */
  acquisitionBudgetMs: number;
  /**
   * The margin a seat keeps past its run's timeout, in ms. It covers the very
   * budget the acquisition is held to, and the upload of the outputs.
   */
  seatMarginMs: number;
}

/**
 * The bounds of a run's acquisition, for the instance's quota settings and
 * whether a runner pool runs — both derived by the runtime's functions from
 * the creations that may be asked for at once.
 */
export function runAcquisitionBounds(
  quotaConfig: Pick<QuotaConfig, "instanceCap">,
  poolRunning: boolean,
): RunAcquisitionBounds {
  const concurrentCreates =
    quotaConfig.instanceCap === null
      ? FLY_APP_ACTION_BURST
      : quotaConfig.instanceCap + (poolRunning ? 1 : 0);
  return {
    concurrentCreates,
    acquisitionBudgetMs: acquisitionBudgetMs({ concurrentCreates }),
    seatMarginMs: seatDeadlineMarginMs({ concurrentCreates }),
  };
}
