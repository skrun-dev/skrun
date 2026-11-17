import { createLogger, type RunnerPool } from "@skrun-dev/runtime";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type AccountUsage,
  type DbAdapter,
  FAST_RUN_WINDOW_MS,
  fastRunsSince,
} from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";
import { type QuotaConfig, thresholdsFor } from "../quotas/thresholds.js";
import { assertMasterReadOrThrow } from "../services/key-scope.js";
import { dispatchRegistryError } from "./_helpers.js";

/**
 * `GET /api/usage` — what an account consumes, read by the account itself: its
 * plan, and, for each bound the server sets, its limit and what the account
 * uses of it now. The same sums the admission of a run reads, at the instant
 * of the request, without a lock: a run admitted a moment later can change
 * them.
 *
 * The numbers are the account's, not a key's: like the run history and the
 * statistics, they are read by a full-access credential only — a session, the
 * dev token, or an account-wide key that carries every operation. A delegated
 * key keeps its own refusal, a reduced one is told what the read takes.
 *
 * Nothing here is under `GET /api/me`, which stays as it is.
 */

// Its own name: a line it writes is told apart from a run's.
const logger = createLogger("usage");

/** An account's fast runs of the rolling hour — told only while a runner pool runs. */
export interface FastRunsUsage {
  /** The runs per rolling hour entitled to a pooled machine; `null` when that bound is off. */
  limit: number | null;
  /**
   * Those left now, never below 0 — the runs of the hour that keep the right
   * counted, a run that gave it back (no pooled machine was taken for it) no
   * longer; `null` when the bound is off.
   */
  remaining: number | null;
  /**
   * When the next right comes back: the creation of the oldest run of the
   * hour that keeps the right, plus an hour — or, for an account that holds
   * more of them than `limit` (its plan or the limit lowered since), the
   * creation of the one whose leaving brings it back under `limit`, plus an
   * hour. `null` when no run of the hour keeps it, when the bound is off, and
   * for a plan that includes none — nothing comes back.
   */
  resets_at: string | null;
}

/** The route's body. */
export interface UsageResponse {
  /** The plan whose thresholds apply: `free` for a plan no setting names, and for the dev token. */
  plan: string;
  /**
   * `null` when the server sets no quota at all. The seats and the compute
   * each `null` when their bound is off; the fast runs `null` only while no
   * runner pool runs — with one and their bound off, three `null`s.
   */
  quotas: {
    concurrent_runs: { limit: number; in_use: number } | null;
    compute: {
      limit_seconds: number;
      /** The charged time of the window's runs, in whole seconds (rounded down). */
      used_seconds: number;
      /** The current window, fixed and aligned on UTC: start included, end excluded. */
      window: { start: string; end: string };
    } | null;
    /** `null` while no runner pool runs: no run has the right to one, and nothing is said of it. */
    fast_runs: FastRunsUsage | null;
  } | null;
}

export interface UsageRoutesOptions {
  /** The quota settings, read once by the app. */
  quotaConfig: QuotaConfig;
  /**
   * The cloud runtime's runner pool, when it has one. Fast runs exist only
   * while it runs — configured with a size above zero.
   */
  pool?: Pick<RunnerPool, "enabled">;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The fast runs of an account whose plan allows `limit` of them per hour, from
 * its usage read with that limit. A plan that includes none (0) has nothing
 * left, and no right comes back — whatever runs of the hour had one before
 * the plan changed: no run's leaving brings the account under 0. A store
 * that leaves out the run whose leaving gives a right back is answered as
 * none, and `unread` is called.
 */
function fastRunsOf(limit: number | null, usage: AccountUsage, unread: () => void): FastRunsUsage {
  if (limit === null) return { limit: null, remaining: null, resets_at: null };
  // Read through a type that admits `undefined`: a store this server does not
  // build — written in JavaScript, or against the type before the field was
  // required — may leave it out.
  const releasing: string | null | undefined = usage.releasingFastRunAt;
  if (releasing === undefined) unread();
  return {
    limit,
    remaining: Math.max(0, limit - usage.fastRunsUsed),
    resets_at: releasing == null ? null : iso(Date.parse(releasing) + FAST_RUN_WINDOW_MS),
  };
}

export function createUsageRoutes(
  db: Pick<DbAdapter, "getAccountUsage">,
  authMiddleware: MiddlewareHandler,
  opts: UsageRoutesOptions,
): Hono {
  const router = new Hono();

  router.get("/usage", authMiddleware, async (c) => {
    const user = getUser(c);
    try {
      assertMasterReadOrThrow(user);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
    // A dev token whose account could not be recorded: no row behind the id,
    // and its runs count against no account — nothing to read, and nothing read.
    if (user.syntheticAccount) {
      return c.json({ error: { code: "NOT_FOUND", message: "This account has no record." } }, 404);
    }
    const nowMs = Date.now();
    // A plan no setting names is read as `free`, and named once, with the account's id.
    const at = thresholdsFor(
      opts.quotaConfig,
      user.plan,
      nowMs,
      logger.child({ user_id: user.id }),
    );
    if (opts.quotaConfig.unlimited) return c.json<UsageResponse>({ plan: at.plan, quotas: null });

    const poolRunning = opts.pool?.enabled === true;
    const now = iso(nowMs);
    const window = at.computeSeconds === null ? null : at.window;
    // The fast runs are read only while a pool runs and the plan bounds them.
    const fastLimit = poolRunning ? at.fastRunsPerHour : null;
    const usage = await db.getAccountUsage(user.id, {
      now,
      windowStart: window === null ? null : iso(window.startMs),
      fastSince: fastLimit === null ? null : fastRunsSince(now),
      ...(fastLimit !== null && { fastLimit }),
    });
    return c.json<UsageResponse>({
      plan: at.plan,
      quotas: {
        concurrent_runs:
          at.concurrentRuns === null
            ? null
            : { limit: at.concurrentRuns, in_use: usage.seatsInUse },
        compute:
          at.computeSeconds === null || window === null
            ? null
            : {
                limit_seconds: at.computeSeconds,
                used_seconds: Math.floor(usage.computeUsedMs / 1000),
                window: { start: iso(window.startMs), end: iso(window.endMs) },
              },
        fast_runs: poolRunning
          ? fastRunsOf(at.fastRunsPerHour, usage, () =>
              logger.error(
                { event: "usage_releasing_unread", user_id: user.id },
                "the store left out the run whose leaving gives a fast run back: resets_at answered null",
              ),
            )
          : null,
      },
    });
  });

  return router;
}
