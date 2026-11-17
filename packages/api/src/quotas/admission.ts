/**
 * A run's admission against what its account may consume: the pre-check, read
 * before the run's bundle is pulled, and the admission itself, which writes the
 * run's row only if its account and the instance still have room — the one
 * caller of `db.admitRun`.
 *
 * The pre-check reads the account's usage without a lock and applies the rule
 * the admission applies (`admissionVerdict`): a run that would be refused is
 * refused before anything is pulled or extracted. It decides nothing for good —
 * the admission reads everything again, under the account's lock, as it
 * writes the row. When nothing bounds the run, neither reads anything: the
 * row is written in one insert, without a lock — its deadline, its right to
 * the pool and its bounded input recorded all the same.
 *
 * A refusal is a status, a code, a message and its headers — `Retry-After`
 * whenever waiting helps (never for a timeout above the server's maximum),
 * the account's numbers for a master credential only. Any other key —
 * reduced to fewer operations, or delegated to a client — gets the same code,
 * hence the bound, and `Retry-After`, with words that say only that the
 * account reached a usage limit: never the numbers, which are the account's,
 * not the key's. Each refusal is one `quota_refused` line —
 * the account's internal id, the bound (`max_timeout` for a timeout above the
 * server's maximum), the plan.
 *
 * While a runner pool runs, the admission also gives the run its right to a
 * pooled machine — its account's fast runs of the rolling hour — which refuses
 * nothing: a run without it takes the cold path, and is one
 * `run_cold_by_quota` line — the run, the account's internal id, the plan.
 * Without a pool no run has the right, and nothing of it is told or logged.
 *
 * The clock is the process's (`Date.now`) unless one is handed in: the row's
 * creation instant, its seat's deadline and every sum are read on it.
 */

import type { Logger } from "@skrun-dev/runtime";
import { EnvironmentConfigSchema } from "@skrun-dev/schema";
import {
  type AccountUsage,
  type AdmissionLimits,
  type AdmissionRule,
  type AdmittedRunData,
  admissionIsBounded,
  admissionVerdict,
  type DbAdapter,
  fastRunsSince,
} from "../db/adapter.js";
import type { Run } from "../db/schema.js";
import { truncateRunContent } from "../routes/_helpers.js";
import { isMasterCredential } from "../services/key-scope.js";
import type { UserContext } from "../types.js";
import { type AccountThresholds, type QuotaConfig, thresholdsFor } from "./thresholds.js";

/** How long a run refused for its account's seats is told to wait, in seconds: a seat frees often. */
export const SEAT_RETRY_AFTER_S = 10;

/** How long a run refused for the instance's capacity — or `busy` — is told to wait, in seconds. */
export const CAPACITY_RETRY_AFTER_S = 5;

/**
 * The headers that carry an account's numbers, each sent for a bound that is
 * set — all of them exposed to a browser on another origin (the CORS mount).
 */
export const QUOTA_HEADERS = {
  /** The account's seats: runs in flight at once. */
  runsLimit: "X-Quota-Runs-Limit",
  /** The seats left once this run holds one. */
  runsRemaining: "X-Quota-Runs-Remaining",
  /** The account's compute seconds per window. */
  computeLimit: "X-Quota-Compute-Limit",
  /** The compute seconds left in the current window. */
  computeRemaining: "X-Quota-Compute-Remaining",
  /** When the current window ends, in Unix seconds — the form of `X-RateLimit-Reset`. */
  computeReset: "X-Quota-Compute-Reset",
  /**
   * The account's runs per rolling hour entitled to a pooled machine, and
   * those left once this run's right is counted — sent only while a runner
   * pool runs: without one, no run has the right and nothing is said of it.
   * A plan that includes none is told its limit alone.
   */
  fastRunsLimit: "X-Quota-Fast-Runs-Limit",
  fastRunsRemaining: "X-Quota-Fast-Runs-Remaining",
} as const;

/** What any credential but a master one is told of an account's limit: that one is reached. */
export const ACCOUNT_LIMIT_MESSAGE = "This account has reached a usage limit; try again later.";

/** What every caller is told when the instance is full, or the run's admission is `busy`. */
export const CAPACITY_MESSAGE = "The service is at full capacity; try again.";

/**
 * Why a run was refused: the bound it met, or `busy` — the database did not
 * answer the admission in time once it held its connection: a lock not
 * obtained, a statement past its bound or the transaction left idle that long,
 * or the connection gone silent (`admitRun`, `db/postgres.ts`).
 */
export type QuotaBound = "compute" | "concurrency" | "instance" | "busy";

/** A refused run, as its caller is answered. */
export interface QuotaRefusal {
  status: 400 | 429 | 503;
  code:
    | "CONCURRENCY_LIMIT_REACHED"
    | "COMPUTE_QUOTA_EXCEEDED"
    | "CAPACITY_EXHAUSTED"
    | "TIMEOUT_ABOVE_LIMIT";
  message: string;
  /** `Retry-After` when waiting helps, and the account's numbers for a master credential. */
  headers: Record<string, string>;
}

/** What one run's admission needs: the store, the settings, who asks, and the clock. */
export interface RunQuotaInit {
  db: Pick<DbAdapter, "admitRun" | "getAccountUsage">;
  config: QuotaConfig;
  /** The authenticated caller: its account, its plan and its credential. */
  user: Pick<UserContext, "id" | "plan" | "key" | "syntheticAccount">;
  /** A runner pool runs: only then does a run have a right to a pooled machine. */
  poolRunning: boolean;
  /** Its lines carry the account's internal id. */
  log: Logger;
  /** The clock, in ms since the epoch. Default `Date.now`. */
  now?: () => number;
}

/** What the admission did. */
export type RunAdmissionOutcome =
  | {
      admitted: true;
      /** The row written. */
      run: Run;
      /** The run's right to a pooled machine. */
      poolEntitled: boolean;
      /** The instant written as the row's creation: the run's charged time counts from it. */
      admittedAt: Date;
      /** The instant written as the seat's deadline (`deadline_at`): the admission's plus `holdMs`. */
      deadlineAt: Date;
      /** The account's numbers once this run holds its seat — a master credential's, bounds set only. */
      headers: Record<string, string>;
    }
  | { admitted: false; refusal: QuotaRefusal };

/** One run's quota: its thresholds, its pre-check and its admission. */
export interface RunQuota {
  /** The thresholds of the caller's account when the run arrived. */
  readonly thresholds: AccountThresholds;
  /** Whether anything bounds this run — when nothing does, neither step reads anything. */
  readonly bounded: boolean;
  /** The pre-check: a refusal, or null when the run may go on to its admission. Writes nothing. */
  precheck(): Promise<QuotaRefusal | null>;
  /**
   * The refusal of a run whose timeout is above the server's maximum
   * (`timeoutAboveLimit`), its `quota_refused` line written — bound
   * `max_timeout`, whatever bounds the account.
   */
  refuseTimeout(input: Parameters<typeof timeoutAboveLimit>[0]): QuotaRefusal;
  /**
   * Write the run's row if its account and the instance still have room. Its
   * seat's deadline is the admission's instant plus `holdMs`; the row keeps a
   * bounded copy of the run's input (`truncateRunContent`). Rejects as the
   * store does — a row naming an account, an agent or a key that no longer
   * exists writes nothing and rejects.
   */
  admit(input: {
    run: Omit<AdmittedRunData, "user_id">;
    holdMs: number;
  }): Promise<RunAdmissionOutcome>;
}

/** A logger that writes nothing: the thresholds read again at the admission name the plan once only. */
const SILENT: Pick<Logger, "warn"> = { warn: () => undefined };

/** The account's limits as the store's rule reads them. */
function limitsOf(thresholds: AccountThresholds): AdmissionLimits {
  return {
    concurrentRuns: thresholds.concurrentRuns,
    computeMs: thresholds.computeSeconds === null ? null : thresholds.computeSeconds * 1000,
    fastRunsPerHour: thresholds.fastRunsPerHour,
    instanceCap: thresholds.instanceCap,
  };
}

/** An instant of the window's end, `HH:MM UTC` — the seconds too, when a window ends between two minutes. */
function utcTimeOf(ms: number): string {
  const iso = new Date(ms).toISOString();
  const seconds = iso.slice(17, 19);
  return `${iso.slice(11, 16)}${seconds === "00" ? "" : `:${seconds}`} UTC`;
}

/**
 * The account's numbers, as headers — a master credential's only, for each
 * bound that is set, and for a run that has an account. `holding` is 1 once
 * the run holds its seat (the usage was read before it was written), 0 for a
 * refused run. The fast runs are told only while a runner pool runs, and
 * `fastRight` is 1 once the run was given the right to a pooled machine — the
 * right is counted at the admission, and given back once the run's machine is
 * ready if no pooled machine was taken for the run. These headers stay the
 * admission's snapshot, as the others do: a right still held at the admission
 * (`usage.fastRunsUsed` counts it) and given back after they left — the
 * run's own, or another of the account's runs' — is not in them: fast runs
 * too few told, by one for each such right; as of the admission, never too
 * many. The current figure is read at `GET /api/usage`.
 */
function usageHeaders(
  thresholds: AccountThresholds,
  usage: AccountUsage | null,
  holding: 0 | 1,
  pool: { running: boolean; fastRight: 0 | 1 },
): Record<string, string> {
  if (usage === null) return {};
  const headers: Record<string, string> = {};
  if (thresholds.concurrentRuns !== null) {
    const remaining = thresholds.concurrentRuns - usage.seatsInUse - holding;
    headers[QUOTA_HEADERS.runsLimit] = String(thresholds.concurrentRuns);
    headers[QUOTA_HEADERS.runsRemaining] = String(Math.max(0, remaining));
  }
  if (thresholds.computeSeconds !== null && thresholds.window !== null) {
    const remainingMs = thresholds.computeSeconds * 1000 - usage.computeUsedMs;
    headers[QUOTA_HEADERS.computeLimit] = String(thresholds.computeSeconds);
    headers[QUOTA_HEADERS.computeRemaining] = String(Math.max(0, Math.floor(remainingMs / 1000)));
    headers[QUOTA_HEADERS.computeReset] = String(Math.ceil(thresholds.window.endMs / 1000));
  }
  if (pool.running && thresholds.fastRunsPerHour !== null) {
    headers[QUOTA_HEADERS.fastRunsLimit] = String(thresholds.fastRunsPerHour);
    // A plan that includes none is told so by its limit: a remaining count of
    // 0 would read as used up.
    if (thresholds.fastRunsPerHour > 0) {
      const remaining = thresholds.fastRunsPerHour - usage.fastRunsUsed - pool.fastRight;
      headers[QUOTA_HEADERS.fastRunsRemaining] = String(Math.max(0, remaining));
    }
  }
  return headers;
}

/**
 * The timeout of an agent that declares none, in seconds: the default
 * `agent.yaml`'s schema fills in before the version's configuration is
 * recorded and before the run reads it.
 */
const DEFAULT_TIMEOUT_S = Number.parseInt(EnvironmentConfigSchema.parse({}).timeout, 10);

/**
 * The refusal of a run whose timeout is above the server's maximum: `400`,
 * the same words for every credential — the maximum is the server's, and the
 * timeout the caller's agent (or override) declares. Nothing to wait for.
 * An agent's timeout equal to the default is not said to be declared: the
 * schema fills the default in, so nothing tells an agent that declares it
 * from one that declares none.
 */
export function timeoutAboveLimit(input: {
  declaredS: number;
  maxS: number;
  /** The timeout comes from the request's environment override, not from the agent. */
  overridden: boolean;
}): QuotaRefusal {
  const accepted = `this server accepts at most ${input.maxS} s.`;
  let message: string;
  if (input.overridden) {
    message = `This run's environment override declares ${input.declaredS} s; ${accepted}`;
  } else if (input.declaredS === DEFAULT_TIMEOUT_S) {
    message = `This agent runs up to ${input.declaredS} s, the default timeout of an agent that declares none; ${accepted}`;
  } else {
    message = `This agent declares ${input.declaredS} s; ${accepted}`;
  }
  return { status: 400, code: "TIMEOUT_ABOVE_LIMIT", message, headers: {} };
}

/**
 * One run's quota, read for the caller of `init.user` at the instant it is
 * built: the plan's thresholds — a plan no setting names gives `free`'s, with
 * one `quota_plan_unknown` line that names it and the account's id.
 */
export function runQuota(init: RunQuotaInit): RunQuota {
  const clock = init.now ?? Date.now;
  // The account the run is counted for: none for a dev-token caller whose
  // account could not be recorded — the instance cap alone bounds it.
  const accountId = init.user.syntheticAccount ? null : init.user.id;
  const log = init.log.child({ user_id: accountId });
  const master = isMasterCredential(init.user);
  const thresholds = thresholdsFor(init.config, init.user.plan, clock(), log);
  /** The thresholds at an instant: the plan read once, the window that instant's. */
  const thresholdsAt = (nowMs: number) => thresholdsFor(init.config, init.user.plan, nowMs, SILENT);
  const ruleOf = (at: AccountThresholds): AdmissionRule => ({
    run: { user_id: accountId },
    limits: limitsOf(at),
    windowStart: at.window === null ? null : new Date(at.window.startMs).toISOString(),
    poolRunning: init.poolRunning,
  });
  const bounded = admissionIsBounded(ruleOf(thresholds));

  /** The refusal for `bound`, its line written. */
  const refuse = (
    bound: QuotaBound,
    usage: AccountUsage | null,
    at: AccountThresholds,
    nowMs: number,
  ): QuotaRefusal => {
    log.info(
      { event: "quota_refused", bound, plan: at.plan },
      "A run was refused: its account or the instance reached a limit",
    );
    const numbers =
      master && accountId !== null
        ? usageHeaders(at, usage, 0, { running: init.poolRunning, fastRight: 0 })
        : {};
    if (bound === "compute") {
      const endMs = at.window?.endMs ?? nowMs;
      const usedS = Math.floor((usage?.computeUsedMs ?? 0) / 1000);
      return {
        status: 429,
        code: "COMPUTE_QUOTA_EXCEEDED",
        message: master
          ? `${usedS} s used of ${at.computeSeconds} in this window; it renews at ${utcTimeOf(endMs)}.`
          : ACCOUNT_LIMIT_MESSAGE,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((endMs - nowMs) / 1000))),
          ...numbers,
        },
      };
    }
    if (bound === "concurrency") {
      const seats = usage?.seatsInUse ?? 0;
      return {
        status: 429,
        code: "CONCURRENCY_LIMIT_REACHED",
        message: master
          ? `${seats} run${seats === 1 ? "" : "s"} in progress on this account; your plan's limit is ${at.concurrentRuns}.`
          : ACCOUNT_LIMIT_MESSAGE,
        headers: { "Retry-After": String(SEAT_RETRY_AFTER_S), ...numbers },
      };
    }
    return {
      status: 503,
      code: "CAPACITY_EXHAUSTED",
      message: CAPACITY_MESSAGE,
      headers: { "Retry-After": String(CAPACITY_RETRY_AFTER_S), ...numbers },
    };
  };

  return {
    thresholds,
    bounded,

    refuseTimeout(input) {
      log.info(
        { event: "quota_refused", bound: "max_timeout", plan: thresholds.plan },
        "A run was refused: its timeout is above the server's maximum",
      );
      return timeoutAboveLimit(input);
    },

    async precheck() {
      if (!bounded) return null;
      const nowMs = clock();
      const at = thresholdsAt(nowMs);
      const rule = ruleOf(at);
      const now = new Date(nowMs).toISOString();
      const usage = await init.db.getAccountUsage(accountId, {
        now,
        windowStart: rule.windowStart,
        // The fast runs decide nothing here — they never refuse a run — but a
        // refusal tells what is left of them, while a pool runs.
        fastSince: init.poolRunning && at.fastRunsPerHour !== null ? fastRunsSince(now) : null,
        instance: at.instanceCap !== null,
      });
      const verdict = admissionVerdict(rule, usage);
      return verdict.admitted ? null : refuse(verdict.reason, usage, at, nowMs);
    },

    async admit({ run, holdMs }) {
      const nowMs = clock();
      const at = thresholdsAt(nowMs);
      const rule = ruleOf(at);
      const deadlineAt = new Date(nowMs + holdMs);
      const result = await init.db.admitRun({
        // The row keeps a bounded copy of the input; the run is handed all of it.
        run: { ...truncateRunContent(run), user_id: accountId },
        now: new Date(nowMs).toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        windowStart: rule.windowStart,
        limits: rule.limits,
        poolRunning: init.poolRunning,
      });
      if (!result.admitted) {
        return { admitted: false, refusal: refuse(result.reason, result.usage, at, nowMs) };
      }
      // A run past its account's fast runs of the hour is sent to the cold
      // path, never refused: one line says so. Without a pool no run has the
      // right, and none is said to miss it.
      if (init.poolRunning && !result.poolEntitled) {
        log.info(
          { event: "run_cold_by_quota", run_id: result.run.id, plan: at.plan },
          "A run takes the cold path: its account has no fast run left this hour",
        );
      }
      return {
        admitted: true,
        run: result.run,
        poolEntitled: result.poolEntitled,
        admittedAt: new Date(nowMs),
        deadlineAt,
        headers:
          master && accountId !== null
            ? usageHeaders(at, result.usage, 1, {
                running: init.poolRunning,
                fastRight: result.poolEntitled ? 1 : 0,
              })
            : {},
      };
    },
  };
}
