/**
 * Per-plan quota settings: the eight operator variables that bound what an
 * account consumes, read once when the server starts.
 *
 * This module is the only reader of the eight variables — every other module
 * receives the reading (`QuotaConfig`), never the environment. Each name is
 * read by a literal access, so the guard that keeps the production inventory
 * derives them from this file.
 *
 * Unset, a variable leaves its bound off: an instance that sets none behaves
 * as it did before quotas. A value the server cannot apply refuses the start,
 * naming the variable — never a guess.
 *
 * The per-plan form: a variable is a comma-separated list whose entries are
 * `plan=value`, or a bare number, which is the value of `free` — the plan an
 * account without one gets. `"2"`, `"free=2"` and `"2,pro=5"` all give `free`
 * 2. Spaces around entries, names and values are ignored, as is an empty entry;
 * a plan name is read in lowercase and must then be made of `a-z`, `0-9` and
 * `-`. Refused: a plan given twice (a bare number and `free=` included), an
 * entry with no plan name or no value, a value that is not a whole number, a
 * value under the bound's minimum, plans named without a value for `free`, and
 * a variable set but empty. Three variables take one number for every plan:
 * the window (one window for everyone), the instance cap (global by nature),
 * and the maximum duration of a run. The window must divide one day exactly,
 * and compute seconds need it.
 *
 * Adding a plan needs no code: a plan is known once a per-plan variable names
 * it, and a known plan that a variable does not name gets that variable's
 * `free` value.
 */

import type { Logger } from "@skrun-dev/runtime";

/** The plan of an account that names none, and the value every plan falls back to. */
export const DEFAULT_PLAN = "free";

/** The eight variables, one per bound. */
export const QUOTA_ENV_NAMES = [
  "SKRUN_QUOTA_CONCURRENT_RUNS",
  "SKRUN_QUOTA_COMPUTE_SECONDS",
  "SKRUN_QUOTA_WINDOW_S",
  "SKRUN_QUOTA_FAST_RUNS_PER_HOUR",
  "SKRUN_QUOTA_STORAGE_MB",
  "SKRUN_QUOTA_INPUT_FILES",
  "SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS",
  "SKRUN_RUN_MAX_TIMEOUT_S",
] as const;

export type QuotaEnvName = (typeof QUOTA_ENV_NAMES)[number];

/** The variables as an environment holds them: each one a string, or unset. */
export type QuotaEnv = Partial<Record<QuotaEnvName, string | undefined>>;

/** A per-plan setting: the value of each plan it names, `free` always among them. */
export type PlanValues = ReadonlyMap<string, number>;

/** The settings, read. A bound left unset is `null`: nothing bounds it. */
export interface QuotaConfig {
  /** No variable is set: the instance behaves as it did before quotas. */
  unlimited: boolean;
  /** The length of the fixed compute window, in seconds; it divides one day. */
  windowS: number | null;
  /** Runs in flight on the whole instance, every account together. */
  instanceCap: number | null;
  /** The longest timeout a run may declare, in seconds. */
  maxTimeoutS: number | null;
  perPlan: {
    /** Runs in flight per account. */
    concurrentRuns: PlanValues | null;
    /** Compute seconds per account and per window. */
    computeSeconds: PlanValues | null;
    /** Runs per account and per rolling hour entitled to a pooled machine; 0 allowed. */
    fastRunsPerHour: PlanValues | null;
    /** Bundle storage per account, in MB. */
    storageMb: PlanValues | null;
    /** Live input-file uploads per account. */
    inputFiles: PlanValues | null;
  };
  /** `free`, and every plan a per-plan variable names. */
  knownPlans: ReadonlySet<string>;
}

/** A quota variable the server cannot apply: the start is refused. */
export class QuotaConfigError extends Error {
  constructor(
    /** The variable refused. */
    readonly variable: QuotaEnvName,
    /** Its value, as it was set. */
    readonly value: string,
    /** Why, in a sentence that follows the variable's name. */
    readonly reason: string,
  ) {
    super(`${variable} ${reason} (got "${value}"). Unset it to leave this bound off.`);
    this.name = "QuotaConfigError";
  }
}

/** One day, in seconds: a window must divide it exactly. */
const DAY_S = 86_400;

/** A plan name once lowercased. */
const PLAN_NAME = /^[a-z0-9-]+$/;

/** A whole number: digits only — no sign, no fraction, no exponent. */
const WHOLE_NUMBER = /^\d+$/;

/** How one variable is read. */
interface Reading {
  /** The smallest value it accepts. */
  min: 0 | 1;
  /** Whether a plan may have a value of its own. */
  perPlan: boolean;
}

/** A value per plan, each at least 1. */
const PER_PLAN: Reading = { min: 1, perPlan: true };
/** A value per plan, 0 allowed: none of it for that plan. */
const PER_PLAN_OR_NONE: Reading = { min: 0, perPlan: true };
/** One number for every plan, at least 1. */
const ONE_FOR_ALL: Reading = { min: 1, perPlan: false };

/**
 * Read one variable. Unset → `null`. A variable without the per-plan form
 * hands back its one number as `free`'s.
 */
function readSetting(
  variable: QuotaEnvName,
  raw: string | undefined,
  { min, perPlan }: Reading,
): Map<string, number> | null {
  if (raw === undefined) return null;
  const refuse = (reason: string) => new QuotaConfigError(variable, raw, reason);
  if (raw.trim() === "") throw refuse("is set but empty");
  const values = new Map<string, number>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const equals = entry.indexOf("=");
    let plan = DEFAULT_PLAN;
    let text = entry;
    if (equals !== -1) {
      if (!perPlan) throw refuse("takes one number for every plan, not a value per plan");
      plan = entry.slice(0, equals).trim().toLowerCase();
      text = entry.slice(equals + 1).trim();
      if (plan === "") throw refuse(`has an entry with no plan name ("${entry}")`);
      if (!PLAN_NAME.test(plan)) {
        throw refuse(`names a plan outside lowercase letters, digits and "-" ("${plan}")`);
      }
      if (text === "") throw refuse(`gives the plan "${plan}" no value`);
    }
    const value = WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(value)) throw refuse(`takes whole numbers ("${text}" is not one)`);
    if (value < min) throw refuse(`takes values of at least ${min} ("${text}" is under it)`);
    if (values.has(plan)) {
      throw refuse(
        `gives the plan "${plan}" two values — a bare number is the value of "${DEFAULT_PLAN}"`,
      );
    }
    values.set(plan, value);
  }
  if (!values.has(DEFAULT_PLAN)) {
    throw refuse(
      `names plans without a value for "${DEFAULT_PLAN}", the plan of every account that names none — give it one, by "${DEFAULT_PLAN}=" or a bare number`,
    );
  }
  return values;
}

/** The one number of a variable that takes one for every plan. */
function oneForAll(values: Map<string, number> | null): number | null {
  return values?.get(DEFAULT_PLAN) ?? null;
}

/**
 * Read the eight variables from an environment — the process's, or any record
 * of the same names (the production config file's values, for its check).
 * Throws `QuotaConfigError` on the first variable it cannot apply.
 */
export function parseQuotaEnv(env: QuotaEnv): QuotaConfig {
  const concurrentRuns = readSetting(
    "SKRUN_QUOTA_CONCURRENT_RUNS",
    env.SKRUN_QUOTA_CONCURRENT_RUNS,
    PER_PLAN,
  );
  const computeSeconds = readSetting(
    "SKRUN_QUOTA_COMPUTE_SECONDS",
    env.SKRUN_QUOTA_COMPUTE_SECONDS,
    PER_PLAN,
  );
  const windowS = oneForAll(
    readSetting("SKRUN_QUOTA_WINDOW_S", env.SKRUN_QUOTA_WINDOW_S, ONE_FOR_ALL),
  );
  const fastRunsPerHour = readSetting(
    "SKRUN_QUOTA_FAST_RUNS_PER_HOUR",
    env.SKRUN_QUOTA_FAST_RUNS_PER_HOUR,
    PER_PLAN_OR_NONE,
  );
  const storageMb = readSetting("SKRUN_QUOTA_STORAGE_MB", env.SKRUN_QUOTA_STORAGE_MB, PER_PLAN);
  const inputFiles = readSetting("SKRUN_QUOTA_INPUT_FILES", env.SKRUN_QUOTA_INPUT_FILES, PER_PLAN);
  const instanceCap = oneForAll(
    readSetting(
      "SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS",
      env.SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS,
      ONE_FOR_ALL,
    ),
  );
  const maxTimeoutS = oneForAll(
    readSetting("SKRUN_RUN_MAX_TIMEOUT_S", env.SKRUN_RUN_MAX_TIMEOUT_S, ONE_FOR_ALL),
  );

  // The renewals then fall at the same hours every day, which a message can
  // name; a window of several days is the billing period's to give, not this.
  if (windowS !== null && (windowS > DAY_S || DAY_S % windowS !== 0)) {
    throw new QuotaConfigError(
      "SKRUN_QUOTA_WINDOW_S",
      String(env.SKRUN_QUOTA_WINDOW_S),
      windowS > DAY_S
        ? `is longer than one day (${DAY_S} s): a window of several days is not accepted`
        : `must divide one day (${DAY_S} s) exactly, so the windows renew at the same hours every day`,
    );
  }
  if (computeSeconds !== null && windowS === null) {
    throw new QuotaConfigError(
      "SKRUN_QUOTA_COMPUTE_SECONDS",
      String(env.SKRUN_QUOTA_COMPUTE_SECONDS),
      "is set without SKRUN_QUOTA_WINDOW_S: a number of compute seconds means nothing without the window it is counted over — set the window too",
    );
  }

  const perPlan = { concurrentRuns, computeSeconds, fastRunsPerHour, storageMb, inputFiles };
  const knownPlans = new Set<string>([DEFAULT_PLAN]);
  for (const values of Object.values(perPlan)) {
    for (const plan of values?.keys() ?? []) knownPlans.add(plan);
  }
  return {
    unlimited: QUOTA_ENV_NAMES.every((name) => env[name] === undefined),
    windowS,
    instanceCap,
    maxTimeoutS,
    perPlan,
    knownPlans,
  };
}

/**
 * The quota settings of this process, read once when the server starts.
 * Throws `QuotaConfigError` — a refused start — on a value it cannot apply.
 */
export function readQuotaConfig(env: NodeJS.ProcessEnv = process.env): QuotaConfig {
  return parseQuotaEnv(env);
}

/** What bounds one account at one instant. A bound left unset is `null`: nothing bounds it. */
export interface AccountThresholds {
  /** The plan whose values apply: the account's own when a setting names it, `free` otherwise. */
  plan: string;
  /** Runs in flight for the account. */
  concurrentRuns: number | null;
  /** Compute seconds for the account in the current window. */
  computeSeconds: number | null;
  /**
   * The current window, fixed and aligned on UTC: from `floor(now / L) × L`,
   * included, to one length later, excluded — in ms since the epoch. Null
   * without a window.
   */
  window: { startMs: number; endMs: number } | null;
  /** Runs per rolling hour entitled to a pooled machine. */
  fastRunsPerHour: number | null;
  /** Bundle storage for the account, in bytes. */
  storageBytes: number | null;
  /** Live input-file uploads for the account. */
  inputFiles: number | null;
  /** Runs in flight on the whole instance — the same for every account. */
  instanceCap: number | null;
  /** The longest timeout a run may declare, in seconds — the same for every account. */
  maxTimeoutS: number | null;
}

const MIB = 1024 * 1024;

/**
 * The thresholds of an account at `nowMs`, from its plan (`users.plan`).
 * Pure: it reads the settings it is given, never the environment.
 *
 * The plan is compared in lowercase. No plan (`undefined`, `null`, empty) is
 * `free`, silently. A plan no setting names is `free` too — never unlimited —
 * with one `quota_plan_unknown` line naming it; the caller binds the account's
 * id on the logger it passes. Settings that name no plan but `free` (bare
 * numbers) consult no plan at all. A known plan a setting does not name gets
 * that setting's `free` value, silently.
 */
export function thresholdsFor(
  config: QuotaConfig,
  plan: string | null | undefined,
  nowMs: number,
  log: Pick<Logger, "warn">,
): AccountThresholds {
  const named = (plan ?? "").trim().toLowerCase();
  let applied = DEFAULT_PLAN;
  if (config.knownPlans.size > 1 && named !== "") {
    if (config.knownPlans.has(named)) {
      applied = named;
    } else {
      log.warn(
        { event: "quota_plan_unknown", plan },
        "An account's plan is named by no quota setting; it gets the thresholds of the free plan",
      );
    }
  }
  const planValue = (values: PlanValues | null): number | null =>
    values === null ? null : (values.get(applied) ?? values.get(DEFAULT_PLAN) ?? null);
  let window: AccountThresholds["window"] = null;
  if (config.windowS !== null) {
    const windowMs = config.windowS * 1000;
    const startMs = Math.floor(nowMs / windowMs) * windowMs;
    window = { startMs, endMs: startMs + windowMs };
  }
  const storageMb = planValue(config.perPlan.storageMb);
  return {
    plan: applied,
    concurrentRuns: planValue(config.perPlan.concurrentRuns),
    computeSeconds: planValue(config.perPlan.computeSeconds),
    window,
    fastRunsPerHour: planValue(config.perPlan.fastRunsPerHour),
    storageBytes: storageMb === null ? null : storageMb * MIB,
    inputFiles: planValue(config.perPlan.inputFiles),
    instanceCap: config.instanceCap,
    maxTimeoutS: config.maxTimeoutS,
  };
}
