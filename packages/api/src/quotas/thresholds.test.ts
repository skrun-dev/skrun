import { describe, expect, it, vi } from "vitest";
import {
  type AccountThresholds,
  parseQuotaEnv,
  QUOTA_ENV_NAMES,
  type QuotaConfig,
  QuotaConfigError,
  type QuotaEnv,
  type QuotaEnvName,
  readQuotaConfig,
  thresholdsFor,
} from "./thresholds.js";

/** The settings a plan can give a value of its own. */
const PER_PLAN: QuotaEnvName[] = [
  "SKRUN_QUOTA_CONCURRENT_RUNS",
  "SKRUN_QUOTA_COMPUTE_SECONDS",
  "SKRUN_QUOTA_FAST_RUNS_PER_HOUR",
  "SKRUN_QUOTA_STORAGE_MB",
  "SKRUN_QUOTA_INPUT_FILES",
];

/** The settings that take one number for every plan. */
const ONE_FOR_ALL: QuotaEnvName[] = [
  "SKRUN_QUOTA_WINDOW_S",
  "SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS",
  "SKRUN_RUN_MAX_TIMEOUT_S",
];

/**
 * One setting, with what it needs to be read on its own: a number of compute
 * seconds means nothing without its window, so the window comes with it.
 */
function alone(name: QuotaEnvName, value: string): QuotaEnv {
  return name === "SKRUN_QUOTA_COMPUTE_SECONDS"
    ? { [name]: value, SKRUN_QUOTA_WINDOW_S: "21600" }
    : { [name]: value };
}

/** What reading the settings throws — undefined when they are read. */
function thrownBy(env: QuotaEnv): unknown {
  try {
    parseQuotaEnv(env);
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The refusal names the variable, by its field and in its message. */
function expectRefused(env: QuotaEnv, variable: QuotaEnvName): QuotaConfigError {
  const err = thrownBy(env);
  expect(err).toBeInstanceOf(QuotaConfigError);
  const refusal = err as QuotaConfigError;
  expect(refusal.name).toBe("QuotaConfigError");
  expect(refusal.variable).toBe(variable);
  expect(refusal.message).toContain(variable);
  return refusal;
}

/** The settings are read without a refusal; their reading is handed back. */
function accepted(env: QuotaEnv): QuotaConfig {
  let config: QuotaConfig | undefined;
  expect(() => {
    config = parseQuotaEnv(env);
  }).not.toThrow();
  return config as QuotaConfig;
}

describe("quota settings — a value the server cannot apply refuses to start, naming the variable", () => {
  it("there are eight settings, one per bound", () => {
    expect([...QUOTA_ENV_NAMES].sort()).toEqual([...PER_PLAN, ...ONE_FOR_ALL].sort());
  });

  describe.each(QUOTA_ENV_NAMES)("%s", (name) => {
    it.each(["-1", "abc", "1.5"])("is refused at %s", (value) => {
      expectRefused(alone(name, value), name);
    });

    it("is refused when set but empty or blank", () => {
      expectRefused(alone(name, ""), name);
      expectRefused(alone(name, "   "), name);
    });
  });

  it.each(
    QUOTA_ENV_NAMES.filter((name) => name !== "SKRUN_QUOTA_FAST_RUNS_PER_HOUR"),
  )("%s is refused at 0", (name) => {
    expectRefused(alone(name, "0"), name);
  });

  it("a window that does not divide a day is refused: five hours", () => {
    expectRefused({ SKRUN_QUOTA_WINDOW_S: "18000" }, "SKRUN_QUOTA_WINDOW_S");
  });

  it("a window of several days is refused: two days", () => {
    expectRefused({ SKRUN_QUOTA_WINDOW_S: "172800" }, "SKRUN_QUOTA_WINDOW_S");
  });

  it.each(PER_PLAN)("%s naming plans without a value for free is refused", (name) => {
    expectRefused(alone(name, "pro=5"), name);
  });

  it("an entry with no plan name is refused", () => {
    expectRefused({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,=3" }, "SKRUN_QUOTA_CONCURRENT_RUNS");
  });

  it.each([
    "2,free=3",
    "free=2,free=3",
  ])("a plan given twice is refused — a bare number is free's value: %s", (value) => {
    expectRefused({ SKRUN_QUOTA_CONCURRENT_RUNS: value }, "SKRUN_QUOTA_CONCURRENT_RUNS");
  });

  it("a plan given no value is refused", () => {
    expectRefused({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=" }, "SKRUN_QUOTA_CONCURRENT_RUNS");
  });

  it("a plan name outside lowercase letters, digits and hyphens is refused", () => {
    expectRefused({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,Pro!=3" }, "SKRUN_QUOTA_CONCURRENT_RUNS");
  });

  it.each([
    ["SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS", "free=20"],
    ["SKRUN_QUOTA_WINDOW_S", "free=21600"],
    ["SKRUN_RUN_MAX_TIMEOUT_S", "free=900"],
  ] as const)("%s takes one number for every plan: %s is refused", (name, value) => {
    expectRefused({ [name]: value }, name);
  });

  it("compute seconds without a window are refused, naming both settings", () => {
    const refusal = expectRefused(
      { SKRUN_QUOTA_COMPUTE_SECONDS: "3600" },
      "SKRUN_QUOTA_COMPUTE_SECONDS",
    );
    expect(refusal.message).toContain("SKRUN_QUOTA_WINDOW_S");
  });
});

describe("quota settings — what is read", () => {
  it("no setting at all: unlimited, every bound unset, free the one known plan", () => {
    const config = accepted({});
    expect(config).toEqual({
      unlimited: true,
      windowS: null,
      instanceCap: null,
      maxTimeoutS: null,
      perPlan: {
        concurrentRuns: null,
        computeSeconds: null,
        fastRunsPerHour: null,
        storageMb: null,
        inputFiles: null,
      },
      knownPlans: new Set(["free"]),
    });
  });

  it("without a maximum duration, no run's timeout is compared to one, however large", () => {
    const config = accepted({ SKRUN_QUOTA_CONCURRENT_RUNS: "2" });
    expect(config.unlimited).toBe(false);
    expect(config.maxTimeoutS).toBeNull();
  });

  it("no fast run for a plan is a value: 0 is accepted there", () => {
    const config = accepted({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "free=0,pro=60" });
    expect(config.perPlan.fastRunsPerHour).toEqual(
      new Map([
        ["free", 0],
        ["pro", 60],
      ]),
    );
  });

  it("spaces around entries, names and values, and empty entries, are ignored", () => {
    const config = accepted({ SKRUN_QUOTA_CONCURRENT_RUNS: " free = 2 , pro=5 ," });
    expect(config.perPlan.concurrentRuns).toEqual(
      new Map([
        ["free", 2],
        ["pro", 5],
      ]),
    );
  });

  it("a bare number is free's value: 2,pro=5 reads as free=2,pro=5", () => {
    const mixed = accepted({ SKRUN_QUOTA_CONCURRENT_RUNS: "2,pro=5" });
    const named = accepted({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5" });
    expect(mixed).toEqual(named);
  });

  it("a bare number alone sets free, and names no other plan", () => {
    const config = accepted({ SKRUN_QUOTA_STORAGE_MB: "500" });
    expect(config.perPlan.storageMb).toEqual(new Map([["free", 500]]));
    expect(config.knownPlans).toEqual(new Set(["free"]));
  });

  it("plan names are read in lowercase: FREE=2 is free", () => {
    const config = accepted({ SKRUN_QUOTA_CONCURRENT_RUNS: "FREE=2,Pro=5" });
    expect(config.perPlan.concurrentRuns).toEqual(
      new Map([
        ["free", 2],
        ["pro", 5],
      ]),
    );
  });

  it("three plans, no code: each one named by a setting is known, with its own values", () => {
    const config = accepted({
      SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5,team=10",
      SKRUN_QUOTA_STORAGE_MB: "free=500,pro=2048,team=8192",
    });
    expect(config.knownPlans).toEqual(new Set(["free", "pro", "team"]));
    expect(config.perPlan.concurrentRuns?.get("team")).toBe(10);
    expect(config.perPlan.storageMb?.get("team")).toBe(8192);
  });

  it("a plan named by one setting only is known all the same", () => {
    const config = accepted({
      SKRUN_QUOTA_CONCURRENT_RUNS: "free=2",
      SKRUN_QUOTA_INPUT_FILES: "free=50,team=200",
    });
    expect(config.knownPlans).toEqual(new Set(["free", "team"]));
  });

  it("the three settings for every plan are read as numbers", () => {
    const config = accepted({
      SKRUN_QUOTA_WINDOW_S: "21600",
      SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20",
      SKRUN_RUN_MAX_TIMEOUT_S: "900",
    });
    expect(config.windowS).toBe(21_600);
    expect(config.instanceCap).toBe(20);
    expect(config.maxTimeoutS).toBe(900);
    expect(config.unlimited).toBe(false);
  });

  it.each([
    "86400",
    "21600",
    "3600",
    "60",
    "1",
  ])("a window that divides a day is read: %s", (value) => {
    expect(accepted({ SKRUN_QUOTA_WINDOW_S: value }).windowS).toBe(Number(value));
  });

  it("compute seconds with their window are read", () => {
    const config = accepted({
      SKRUN_QUOTA_COMPUTE_SECONDS: "free=3600,pro=14400",
      SKRUN_QUOTA_WINDOW_S: "21600",
    });
    expect(config.perPlan.computeSeconds).toEqual(
      new Map([
        ["free", 3600],
        ["pro", 14400],
      ]),
    );
  });

  it("the server's start reads the process environment the same way", () => {
    let config: QuotaConfig | undefined;
    expect(() => {
      config = readQuotaConfig({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5" });
    }).not.toThrow();
    expect(config).toEqual(parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5" }));
    let refused: unknown;
    try {
      readQuotaConfig({ SKRUN_QUOTA_WINDOW_S: "18000" });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(QuotaConfigError);
  });
});

const MIB = 1024 * 1024;

/** Thirteen o'clock UTC, a weekday: the middle of the noon-to-six window of a six-hour day. */
const ONE_PM = Date.UTC(2026, 9, 14, 13, 0, 0);

/** A plan's thresholds, and the lines the call wrote. */
function thresholds(
  config: QuotaConfig,
  plan: string | null | undefined,
  nowMs = ONE_PM,
): { got: AccountThresholds; lines: unknown[][] } {
  const warn = vi.fn();
  let got: AccountThresholds | undefined;
  expect(() => {
    got = thresholdsFor(config, plan, nowMs, { warn } as never);
  }).not.toThrow();
  return { got: got as AccountThresholds, lines: warn.mock.calls };
}

/** Two plans, every setting: the production shape. */
const TWO_PLANS = parseQuotaEnv({
  SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5",
  SKRUN_QUOTA_COMPUTE_SECONDS: "free=3600,pro=14400",
  SKRUN_QUOTA_WINDOW_S: "21600",
  SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "free=20,pro=60",
  SKRUN_QUOTA_STORAGE_MB: "free=500,pro=2048",
  SKRUN_QUOTA_INPUT_FILES: "free=50,pro=200",
  SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20",
  SKRUN_RUN_MAX_TIMEOUT_S: "900",
});

/** What a free account gets from it. */
const FREE: Omit<AccountThresholds, "window"> = {
  plan: "free",
  concurrentRuns: 2,
  computeSeconds: 3600,
  fastRunsPerHour: 20,
  storageBytes: 500 * MIB,
  inputFiles: 50,
  instanceCap: 20,
  maxTimeoutS: 900,
};

describe("an account's thresholds, from its plan", () => {
  it("the window is fixed and aligned on UTC: at 13:00, a six-hour window runs from 12:00 to 18:00", () => {
    const { got } = thresholds(TWO_PLANS, "free");
    expect(got.window).toEqual({
      startMs: Date.UTC(2026, 9, 14, 12, 0, 0),
      endMs: Date.UTC(2026, 9, 14, 18, 0, 0),
    });
  });

  it("an instant on a window's edge opens the next one; the last instant before it closes the previous", () => {
    const noon = Date.UTC(2026, 9, 14, 12, 0, 0);
    expect(thresholds(TWO_PLANS, "free", noon).got.window?.startMs).toBe(noon);
    expect(thresholds(TWO_PLANS, "free", noon - 1).got.window).toEqual({
      startMs: Date.UTC(2026, 9, 14, 6, 0, 0),
      endMs: noon,
    });
  });

  it("a free account gets free's values, and the instance's", () => {
    const { got, lines } = thresholds(TWO_PLANS, "free");
    expect(got).toMatchObject(FREE);
    expect(lines).toEqual([]);
  });

  it("a pro account gets pro's values", () => {
    const { got, lines } = thresholds(TWO_PLANS, "pro");
    expect(got).toMatchObject({
      plan: "pro",
      concurrentRuns: 5,
      computeSeconds: 14400,
      fastRunsPerHour: 60,
      storageBytes: 2048 * MIB,
      inputFiles: 200,
      instanceCap: 20,
      maxTimeoutS: 900,
    });
    expect(lines).toEqual([]);
  });

  it("a plan stored in capitals is read in lowercase: PRO is pro", () => {
    const { got, lines } = thresholds(TWO_PLANS, "PRO");
    expect(got.plan).toBe("pro");
    expect(got.concurrentRuns).toBe(5);
    expect(lines).toEqual([]);
  });

  it("three plans, no code: free, pro and team each get their own", () => {
    const three = parseQuotaEnv({
      SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5,team=10",
      SKRUN_QUOTA_COMPUTE_SECONDS: "free=3600,pro=14400,team=36000",
      SKRUN_QUOTA_WINDOW_S: "21600",
      SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "free=20,pro=60,team=120",
      SKRUN_QUOTA_STORAGE_MB: "free=500,pro=2048,team=8192",
      SKRUN_QUOTA_INPUT_FILES: "free=50,pro=200,team=500",
    });
    expect(thresholds(three, "free").got).toMatchObject({ plan: "free", concurrentRuns: 2 });
    expect(thresholds(three, "pro").got).toMatchObject({ plan: "pro", computeSeconds: 14400 });
    expect(thresholds(three, "team").got).toMatchObject({
      plan: "team",
      concurrentRuns: 10,
      computeSeconds: 36000,
      fastRunsPerHour: 120,
      storageBytes: 8192 * MIB,
      inputFiles: 500,
    });
  });

  it("a plan no setting names gets free's values — never unlimited — and one line that names it", () => {
    const { got, lines } = thresholds(TWO_PLANS, "ghost");
    expect(got).toMatchObject(FREE);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[0]).toEqual({ event: "quota_plan_unknown", plan: "ghost" });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["the empty string", ""],
  ])("an account with no plan (%s) gets free's values, with no line", (_label, plan) => {
    const { got, lines } = thresholds(TWO_PLANS, plan);
    expect(got).toMatchObject(FREE);
    expect(lines).toEqual([]);
  });

  it("a known plan a setting does not name gets that setting's free value — never unlimited — with no line", () => {
    const config = parseQuotaEnv({
      SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5",
      SKRUN_QUOTA_STORAGE_MB: "500",
    });
    const { got, lines } = thresholds(config, "pro");
    expect(got.concurrentRuns).toBe(5);
    expect(got.storageBytes).toBe(500 * MIB);
    expect(lines).toEqual([]);
  });

  it("no setting at all: nothing bounds the account, no window, and no plan is consulted", () => {
    const { got, lines } = thresholds(parseQuotaEnv({}), "pro");
    expect(got).toEqual({
      plan: "free",
      concurrentRuns: null,
      computeSeconds: null,
      window: null,
      fastRunsPerHour: null,
      storageBytes: null,
      inputFiles: null,
      instanceCap: null,
      maxTimeoutS: null,
    });
    expect(lines).toEqual([]);
  });

  it("settings that are all bare numbers name no plan: every account gets them, and no plan is consulted", () => {
    const config = parseQuotaEnv({
      SKRUN_QUOTA_CONCURRENT_RUNS: "3",
      SKRUN_QUOTA_STORAGE_MB: "100",
    });
    for (const plan of ["free", "pro", "ghost", undefined]) {
      const { got, lines } = thresholds(config, plan);
      expect(got).toMatchObject({ plan: "free", concurrentRuns: 3, storageBytes: 100 * MIB });
      expect(lines).toEqual([]);
    }
  });

  it("a bound left unset stays unset for every plan", () => {
    const config = parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5" });
    const { got } = thresholds(config, "pro");
    expect(got.concurrentRuns).toBe(5);
    expect(got.computeSeconds).toBeNull();
    expect(got.window).toBeNull();
    expect(got.storageBytes).toBeNull();
    expect(got.instanceCap).toBeNull();
  });
});
