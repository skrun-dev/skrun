// The time a cloud run may spend getting its machine, and the margin a seat it
// holds keeps past its run's timeout — both derived from the bounds the client
// and the adapter export, never from a number copied here.
//
// The adapter's constants are read inside the functions only, at call time:
// `adapter.ts` imports this module for its own default budget, and neither
// module reads the other's bindings while it loads.

import { DEFAULT_MAX_BOOT_TIME_MS, INIT_RPC_TIMEOUT_MS } from "./adapter.js";
import { createWorstCaseMs } from "./fly-api.js";
import { OUTPUTS_UPLOAD_BUDGET_MS } from "./outputs-upload.js";

/** What the bound of one acquisition depends on. */
export interface AcquisitionBudgetInput {
  /**
   * How many creations one process may be asked for at once — the runs it may
   * hold at once, plus one while a pool refills (the refill creates one machine
   * at a time). Without such a cap, the platform's burst: no wait for a slot is
   * counted then.
   */
  concurrentCreates: number;
  /** The adapter's boot budget, when it is given one. Default `DEFAULT_MAX_BOOT_TIME_MS`. */
  maxBootTimeMs?: number;
}

/**
 * The longest one cloud run may spend acquiring its machine — waking a pooled
 * one, then creating its own if none would serve, up to the runner's answer to
 * `/init` — in ms: the longest one creation waits in the client
 * (`createWorstCaseMs`, for `concurrentCreates` at once), the boot budget, and
 * the wait for `/init` (`INIT_RPC_TIMEOUT_MS`). 531 s for 21 creations at once
 * on the default boot budget: 141 + 90 + 300.
 *
 * It is a hard bound: the adapter aborts every call of the acquisition once it
 * is spent, the pool's claims and the cold path sharing it. Two tails it does
 * not add, and so cuts instead: the last `/healthz` probe started before the
 * boot budget ran out (up to 5 s past it), and the read of `/init`'s body (up
 * to 30 s once its headers arrived) — an acquisition that hits every worst
 * case at once fails up to 35 s early rather than late. Nor does it count the
 * time the platform takes to answer each request, nor a pooled machine's
 * claim beyond what the budget leaves it: two slow claims can spend it before
 * the cold path starts.
 */
export function acquisitionBudgetMs({
  concurrentCreates,
  maxBootTimeMs = DEFAULT_MAX_BOOT_TIME_MS,
}: AcquisitionBudgetInput): number {
  return createWorstCaseMs({ concurrentCreates }) + maxBootTimeMs + INIT_RPC_TIMEOUT_MS;
}

/**
 * How long past its run's timeout a seat stays held, in ms: the acquisition
 * budget, and the outputs upload's (`OUTPUTS_UPLOAD_BUDGET_MS`) — 651 s for 21
 * creations at once on the default boot budget. Never less than the
 * acquisition budget: both come from the same bounds, and move together.
 *
 * What it does not cover: the writes after the upload — the run's state, its
 * final status. They have no time bound of their own here; on Postgres, the
 * API's pool bounds each statement they send (its statement bound, 5 s more
 * on a connection that gets no answer).
 */
export function seatDeadlineMarginMs(input: AcquisitionBudgetInput): number {
  return acquisitionBudgetMs(input) + OUTPUTS_UPLOAD_BUDGET_MS;
}
