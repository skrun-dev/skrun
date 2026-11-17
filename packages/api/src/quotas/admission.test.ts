import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@skrun-dev/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage, RunAdmission, RunAdmissionResult } from "../db/adapter.js";
import { API_KEY_DEFAULT_SCOPES, type Run } from "../db/schema.js";
import type { KeyContext } from "../types.js";
import {
  ACCOUNT_LIMIT_MESSAGE,
  CAPACITY_MESSAGE,
  QUOTA_HEADERS,
  type QuotaRefusal,
  type RunQuotaInit,
  runQuota,
  timeoutAboveLimit,
} from "./admission.js";
import { parseQuotaEnv, type QuotaConfig } from "./thresholds.js";

/** Every line the admission writes, parsed, oldest first. */
const lines: Array<Record<string, unknown>> = [];
const log = createLogger("quota-test", {
  write(line: string) {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  },
});

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

/** 13:00:00.5 UTC: the six-hour window runs from 12:00 to 18:00. */
const NOW = Date.parse("2026-10-16T13:00:00.500Z");
const WINDOW_START = "2026-10-16T12:00:00.000Z";
const WINDOW_END_S = Date.parse("2026-10-16T18:00:00.000Z") / 1000;

/** Two seats, an hour of compute per six-hour window, twenty runs on the instance. */
const BOUNDED: QuotaConfig = parseQuotaEnv({
  SKRUN_QUOTA_CONCURRENT_RUNS: "2",
  SKRUN_QUOTA_COMPUTE_SECONDS: "3600",
  SKRUN_QUOTA_WINDOW_S: "21600",
  SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20",
});

const UNBOUNDED: QuotaConfig = parseQuotaEnv({});

function key(over: Partial<KeyContext>): KeyContext {
  return {
    id: "key-1",
    scope_kind: "account",
    operations: [...API_KEY_DEFAULT_SCOPES],
    agent_ids: [],
    ...over,
  };
}

/** The credentials a run can come with: two master ones, and the two that are not. */
const CREDENTIALS = {
  session: null,
  "full key": key({}),
  "reduced key": key({ operations: ["agent:run"] }),
  "delegated key": key({ scope_kind: "agents", agent_ids: ["agent-1"] }),
} as const;
type Credential = keyof typeof CREDENTIALS;
const MASTER: Credential[] = ["session", "full key"];
const NOT_MASTER: Credential[] = ["reduced key", "delegated key"];

function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    seatsInUse: 0,
    computeUsedMs: 0,
    fastRunsUsed: 0,
    releasingFastRunAt: null,
    instanceSeatsInUse: 0,
    ...over,
  };
}

/** A store whose reads hand back `read`, and whose admission hands back `admitted`. */
function store(read: AccountUsage, admitted?: RunAdmissionResult) {
  return {
    getAccountUsage: vi.fn(async () => read),
    admitRun: vi.fn(async (_admission: RunAdmission) => admitted as RunAdmissionResult),
  };
}

function quotaFor(
  credential: Credential,
  db: RunQuotaInit["db"],
  over: Partial<RunQuotaInit> = {},
): ReturnType<typeof runQuota> {
  return runQuota({
    db,
    config: BOUNDED,
    user: { id: ACCOUNT, key: CREDENTIALS[credential] },
    poolRunning: false,
    log,
    now: () => NOW,
    ...over,
  });
}

const RUN = { id: "run-1", agent_id: "agent-1", agent_version: "acme/agent@1.0.0", input: {} };

/** The quota headers a response carries — `Retry-After` set aside. */
function quotaHeaders(refusal: QuotaRefusal | Record<string, string>): Record<string, string> {
  const headers = "headers" in refusal ? (refusal.headers as Record<string, string>) : refusal;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.startsWith("X-Quota-")),
  );
}

beforeEach(() => {
  lines.length = 0;
});

// What each refusal says, to whom: the numbers are the account's, and only a
// master credential — a session, the dev token, an account-wide key carrying
// every operation — is told them. A key reduced to fewer operations, or
// delegated to a client, is told that the account reached a limit.
describe("a refused run, as each credential is told it", () => {
  /** What the store reads for each refusal: the bound reached, the others not. */
  const READS = {
    concurrency: usage({ seatsInUse: 2, computeUsedMs: 10_000 }),
    compute: usage({ seatsInUse: 1, computeUsedMs: 3_600_000 }),
    instance: usage({ seatsInUse: 0, computeUsedMs: 0, instanceSeatsInUse: 20 }),
  } as const;

  /** The numbers a master credential gets beside each refusal: every bound set. */
  const NUMBERS = {
    concurrency: {
      [QUOTA_HEADERS.runsLimit]: "2",
      [QUOTA_HEADERS.runsRemaining]: "0",
      [QUOTA_HEADERS.computeLimit]: "3600",
      [QUOTA_HEADERS.computeRemaining]: "3590",
      [QUOTA_HEADERS.computeReset]: String(WINDOW_END_S),
    },
    compute: {
      [QUOTA_HEADERS.runsLimit]: "2",
      [QUOTA_HEADERS.runsRemaining]: "1",
      [QUOTA_HEADERS.computeLimit]: "3600",
      [QUOTA_HEADERS.computeRemaining]: "0",
      [QUOTA_HEADERS.computeReset]: String(WINDOW_END_S),
    },
    instance: {
      [QUOTA_HEADERS.runsLimit]: "2",
      [QUOTA_HEADERS.runsRemaining]: "2",
      [QUOTA_HEADERS.computeLimit]: "3600",
      [QUOTA_HEADERS.computeRemaining]: "3600",
      [QUOTA_HEADERS.computeReset]: String(WINDOW_END_S),
    },
  } as const;

  const EXPECTED = {
    concurrency: {
      status: 429,
      code: "CONCURRENCY_LIMIT_REACHED",
      retryAfter: "10",
      master: "2 runs in progress on this account; your plan's limit is 2.",
      other: ACCOUNT_LIMIT_MESSAGE,
    },
    // The window renews at 18:00; 17 999.5 s from 13:00:00.5, rounded up.
    compute: {
      status: 429,
      code: "COMPUTE_QUOTA_EXCEEDED",
      retryAfter: "18000",
      master: "3600 s used of 3600 in this window; it renews at 18:00 UTC.",
      other: ACCOUNT_LIMIT_MESSAGE,
    },
    instance: {
      status: 503,
      code: "CAPACITY_EXHAUSTED",
      retryAfter: "5",
      master: CAPACITY_MESSAGE,
      other: CAPACITY_MESSAGE,
    },
  } as const;

  const BOUNDS = ["concurrency", "compute", "instance"] as const;
  const STEPS = ["pre-check", "admission"] as const;

  /** The refusal of `bound` as `credential` meets it, at the pre-check or at the admission. */
  async function refusalOf(
    bound: (typeof BOUNDS)[number],
    credential: Credential,
    step: (typeof STEPS)[number],
  ): Promise<QuotaRefusal> {
    const read = READS[bound];
    if (step === "pre-check") {
      const db = store(read);
      const refusal = await quotaFor(credential, db).precheck();
      expect(db.admitRun).not.toHaveBeenCalled();
      return refusal as QuotaRefusal;
    }
    const db = store(usage(), { admitted: false, reason: bound, usage: read });
    const outcome = await quotaFor(credential, db).admit({ run: RUN, holdMs: 1_000 });
    expect(outcome.admitted).toBe(false);
    return (outcome as { refusal: QuotaRefusal }).refusal;
  }

  for (const step of STEPS) {
    for (const bound of BOUNDS) {
      it.each(
        MASTER,
      )(`${step}, ${bound}: a %s gets the status, the code, Retry-After, the account's numbers in words and in headers`, async (credential) => {
        const refusal = await refusalOf(bound, credential, step);
        const expected = EXPECTED[bound];
        expect(refusal.status).toBe(expected.status);
        expect(refusal.code).toBe(expected.code);
        expect(refusal.message).toBe(expected.master);
        expect(refusal.headers["Retry-After"]).toBe(expected.retryAfter);
        expect(quotaHeaders(refusal)).toEqual(NUMBERS[bound]);
      });

      it.each(
        NOT_MASTER,
      )(`${step}, ${bound}: a %s gets the status, the code and Retry-After — no number, in words or in headers`, async (credential) => {
        const refusal = await refusalOf(bound, credential, step);
        const expected = EXPECTED[bound];
        expect(refusal.status).toBe(expected.status);
        expect(refusal.code).toBe(expected.code);
        expect(refusal.message).toBe(expected.other);
        expect(refusal.message).not.toMatch(/\d/);
        expect(refusal.headers).toEqual({ "Retry-After": expected.retryAfter });
      });
    }
  }

  it.each([
    ...MASTER,
    ...NOT_MASTER,
  ])("a lock not obtained in time: a %s is told the service is full, retry in 5 s, no number", async (credential) => {
    const db = store(usage(), { admitted: false, reason: "busy", usage: null });
    const outcome = await quotaFor(credential, db).admit({ run: RUN, holdMs: 1_000 });
    expect(outcome).toEqual({
      admitted: false,
      refusal: {
        status: 503,
        code: "CAPACITY_EXHAUSTED",
        message: CAPACITY_MESSAGE,
        headers: { "Retry-After": "5" },
      },
    });
  });

  it("a window renewing between two minutes is named to the second", async () => {
    // A 90 s window: from 13:00:00 to 13:01:30.
    const config = parseQuotaEnv({
      SKRUN_QUOTA_COMPUTE_SECONDS: "60",
      SKRUN_QUOTA_WINDOW_S: "90",
    });
    const db = store(usage({ computeUsedMs: 61_000 }));
    const refusal = await quotaFor("session", db, { config }).precheck();
    expect(refusal?.message).toBe("61 s used of 60 in this window; it renews at 13:01:30 UTC.");
    expect(refusal?.headers["Retry-After"]).toBe("90");
  });

  it("each refusal is one line: the account's internal id, the bound, the plan — nothing of the caller's key", async () => {
    for (const bound of BOUNDS) await refusalOf(bound, "reduced key", "pre-check");
    await quotaFor(
      "delegated key",
      store(usage(), { admitted: false, reason: "busy", usage: null }),
    ).admit({
      run: RUN,
      holdMs: 1_000,
    });
    const refused = lines.filter((line) => line.event === "quota_refused");
    expect(refused.map(({ user_id, bound, plan }) => ({ user_id, bound, plan }))).toEqual([
      { user_id: ACCOUNT, bound: "concurrency", plan: "free" },
      { user_id: ACCOUNT, bound: "compute", plan: "free" },
      { user_id: ACCOUNT, bound: "instance", plan: "free" },
      { user_id: ACCOUNT, bound: "busy", plan: "free" },
    ]);
    expect(JSON.stringify(refused)).not.toContain("key-1");
  });
});

describe("an admitted run", () => {
  function admittedResult(read: AccountUsage | null): RunAdmissionResult {
    return { admitted: true, run: { id: "run-1" } as Run, poolEntitled: false, usage: read };
  }

  it("is written with the clock's instant, its seat's deadline, the window's start, the plan's limits and its account", async () => {
    const db = store(usage(), admittedResult(usage()));
    const outcome = await quotaFor("reduced key", db, { poolRunning: true }).admit({
      run: RUN,
      holdMs: 951_000,
    });
    expect(db.admitRun).toHaveBeenCalledOnce();
    expect(db.admitRun.mock.calls[0]?.[0]).toEqual({
      run: { ...RUN, user_id: ACCOUNT },
      now: new Date(NOW).toISOString(),
      deadlineAt: new Date(NOW + 951_000).toISOString(),
      windowStart: WINDOW_START,
      limits: { concurrentRuns: 2, computeMs: 3_600_000, fastRunsPerHour: null, instanceCap: 20 },
      poolRunning: true,
    });
    expect(outcome).toMatchObject({ admitted: true, admittedAt: new Date(NOW) });
  });

  it.each(MASTER)("a %s is told what is left once this run holds its seat", async (credential) => {
    const db = store(usage(), admittedResult(usage({ seatsInUse: 1, computeUsedMs: 1_500 })));
    const outcome = await quotaFor(credential, db).admit({ run: RUN, holdMs: 1_000 });
    expect(outcome.admitted && outcome.headers).toEqual({
      [QUOTA_HEADERS.runsLimit]: "2",
      [QUOTA_HEADERS.runsRemaining]: "0",
      [QUOTA_HEADERS.computeLimit]: "3600",
      [QUOTA_HEADERS.computeRemaining]: "3598",
      [QUOTA_HEADERS.computeReset]: String(WINDOW_END_S),
    });
  });

  it.each(NOT_MASTER)("a %s is told nothing of the account's numbers", async (credential) => {
    const db = store(usage(), admittedResult(usage({ seatsInUse: 1 })));
    const outcome = await quotaFor(credential, db).admit({ run: RUN, holdMs: 1_000 });
    expect(outcome.admitted && outcome.headers).toEqual({});
  });

  it("only the bounds that are set have headers", async () => {
    const config = parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "3" });
    const db = store(usage(), admittedResult(usage({ seatsInUse: 1 })));
    const outcome = await quotaFor("session", db, { config }).admit({ run: RUN, holdMs: 1_000 });
    expect(outcome.admitted && outcome.headers).toEqual({
      [QUOTA_HEADERS.runsLimit]: "3",
      [QUOTA_HEADERS.runsRemaining]: "1",
    });
  });
});

// The instance as it was before quotas: no variable set, nothing read, the row
// written as it always was.
describe("with nothing to bound the run", () => {
  it("the pre-check reads nothing and lets the run through; the admission passes no limit and answers no header", async () => {
    const db = store(usage(), {
      admitted: true,
      run: { id: "run-1" } as Run,
      poolEntitled: false,
      usage: null,
    });
    const quota = quotaFor("session", db, { config: UNBOUNDED });
    expect(quota.bounded).toBe(false);
    expect(await quota.precheck()).toBeNull();
    expect(db.getAccountUsage).not.toHaveBeenCalled();
    const outcome = await quota.admit({ run: RUN, holdMs: 1_000 });
    expect(db.admitRun.mock.calls[0]?.[0]).toMatchObject({
      windowStart: null,
      limits: { concurrentRuns: null, computeMs: null, fastRunsPerHour: null, instanceCap: null },
    });
    expect(outcome).toMatchObject({ admitted: true, headers: {} });
    expect(lines).toEqual([]);
  });
});

describe("a run without an account — a dev-token caller whose account could not be recorded", () => {
  it("is counted for no account: the instance alone bounds it, and no account's numbers are told", async () => {
    const db = store(usage({ instanceSeatsInUse: 3 }), {
      admitted: true,
      run: { id: "run-1" } as Run,
      poolEntitled: false,
      usage: usage({ instanceSeatsInUse: 3 }),
    });
    const quota = quotaFor("session", db, {
      user: { id: "dev-synthetic", key: null, syntheticAccount: true },
    });
    expect(await quota.precheck()).toBeNull();
    expect(db.getAccountUsage).toHaveBeenCalledWith(null, {
      now: new Date(NOW).toISOString(),
      windowStart: WINDOW_START,
      fastSince: null,
      instance: true,
    });
    const outcome = await quota.admit({ run: RUN, holdMs: 1_000 });
    expect(db.admitRun.mock.calls[0]?.[0].run.user_id).toBeNull();
    expect(outcome).toMatchObject({ admitted: true, headers: {} });
  });
});

// The fast runs: the account's runs per rolling hour that may take a pooled
// machine. They exist only while a runner pool runs — then the admission gives
// the right, the headers tell what is left of it, and a run sent to the cold
// path for want of it is one line. Without a pool, nothing of them is told.
describe("the fast runs, while a runner pool runs", () => {
  /** Two fast runs an hour, one seat. */
  const FAST: QuotaConfig = parseQuotaEnv({
    SKRUN_QUOTA_CONCURRENT_RUNS: "1",
    SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2",
  });
  const HOUR_AGO = new Date(NOW - 3_600_000).toISOString();

  function admittedResult(read: AccountUsage, poolEntitled: boolean): RunAdmissionResult {
    return { admitted: true, run: { id: "run-1" } as Run, poolEntitled, usage: read };
  }

  const coldLines = () => lines.filter((line) => line.event === "run_cold_by_quota");

  it.each([
    ["entitled, none used before it: one left", 0, true, "1"],
    ["entitled, one used before it: none left", 1, true, "0"],
    ["not entitled, both used: none left", 2, false, "0"],
    ["not entitled, more used than a limit since lowered: none left, never below", 3, false, "0"],
  ] as const)("an admitted run %s — its right counted once it is given", async (_label, used, entitled, left) => {
    const db = store(usage(), admittedResult(usage({ fastRunsUsed: used }), entitled));
    const outcome = await quotaFor("session", db, { config: FAST, poolRunning: true }).admit({
      run: RUN,
      holdMs: 1_000,
    });
    expect(outcome.admitted && outcome.poolEntitled).toBe(entitled);
    expect(outcome.admitted && outcome.headers).toEqual({
      [QUOTA_HEADERS.runsLimit]: "1",
      [QUOTA_HEADERS.runsRemaining]: "0",
      [QUOTA_HEADERS.fastRunsLimit]: "2",
      [QUOTA_HEADERS.fastRunsRemaining]: left,
    });
  });

  it.each(
    NOT_MASTER,
  )("a %s is told nothing of them — the run sent to the cold path is still one line", async (credential) => {
    const db = store(usage(), admittedResult(usage({ fastRunsUsed: 2 }), false));
    const outcome = await quotaFor(credential, db, { config: FAST, poolRunning: true }).admit({
      run: RUN,
      holdMs: 1_000,
    });
    expect(outcome.admitted && outcome.headers).toEqual({});
    expect(coldLines()).toHaveLength(1);
  });

  it("a run sent to the cold path is one line — the run, the account's internal id, the plan; nothing of the key — and an entitled run none", async () => {
    await quotaFor("full key", store(usage(), admittedResult(usage(), true)), {
      config: FAST,
      poolRunning: true,
    }).admit({ run: RUN, holdMs: 1_000 });
    expect(coldLines()).toEqual([]);

    await quotaFor("full key", store(usage(), admittedResult(usage({ fastRunsUsed: 2 }), false)), {
      config: FAST,
      poolRunning: true,
    }).admit({ run: RUN, holdMs: 1_000 });
    const cold = coldLines();
    expect(cold.map(({ run_id, user_id, plan }) => ({ run_id, user_id, plan }))).toEqual([
      { run_id: "run-1", user_id: ACCOUNT, plan: "free" },
    ]);
    expect(JSON.stringify(cold)).not.toContain("key-1");
  });

  it("a plan that includes none is told its limit, never a remaining count — and every run of it is sent to the cold path", async () => {
    const config = parseQuotaEnv({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "free=0,pro=5" });
    const db = store(usage(), admittedResult(usage(), false));
    const outcome = await quotaFor("session", db, { config, poolRunning: true }).admit({
      run: RUN,
      holdMs: 1_000,
    });
    expect(outcome.admitted && outcome.headers).toEqual({ [QUOTA_HEADERS.fastRunsLimit]: "0" });
    expect(coldLines()).toHaveLength(1);
  });

  it("with a pool running and no fast-run variable, every run is entitled and nothing of them is told", async () => {
    const config = parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" });
    const db = store(usage(), admittedResult(usage(), true));
    const outcome = await quotaFor("session", db, { config, poolRunning: true }).admit({
      run: RUN,
      holdMs: 1_000,
    });
    expect(outcome.admitted && outcome.headers).toEqual({
      [QUOTA_HEADERS.runsLimit]: "1",
      [QUOTA_HEADERS.runsRemaining]: "0",
    });
    expect(coldLines()).toEqual([]);
  });

  it("without a pool, the variable set, nothing of them is told — no header and no line, though no run has the right", async () => {
    const db = store(usage(), admittedResult(usage(), false));
    const outcome = await quotaFor("session", db, { config: FAST, poolRunning: false }).admit({
      run: RUN,
      holdMs: 1_000,
    });
    expect(outcome.admitted && outcome.headers).toEqual({
      [QUOTA_HEADERS.runsLimit]: "1",
      [QUOTA_HEADERS.runsRemaining]: "0",
    });
    expect(coldLines()).toEqual([]);
  });

  it("a run without an account is told no number and is no line: it has the right as soon as a pool runs", async () => {
    const db = store(usage(), admittedResult(usage(), true));
    const outcome = await quotaFor("session", db, {
      config: parseQuotaEnv({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "0" }),
      poolRunning: true,
      user: { id: "dev-synthetic", key: null, syntheticAccount: true },
    }).admit({ run: RUN, holdMs: 1_000 });
    expect(db.admitRun.mock.calls[0]?.[0].run.user_id).toBeNull();
    expect(outcome).toMatchObject({ admitted: true, poolEntitled: true, headers: {} });
    expect(coldLines()).toEqual([]);
  });

  it.each([
    ["a pool running and the variable set: the rolling hour", true, FAST, HOUR_AGO],
    ["no pool: none", false, FAST, null],
    ["a pool running, no fast-run variable: none", true, BOUNDED, null],
  ] as const)("the pre-check reads the fast runs with %s", async (_label, poolRunning, config, fastSince) => {
    const db = store(usage());
    await quotaFor("session", db, { config, poolRunning }).precheck();
    expect(db.getAccountUsage.mock.calls[0]?.[1]).toMatchObject({ fastSince });
  });

  it("a run refused at the pre-check is told the fast runs left — the runs already given the right counted, nothing consumed by the refused one", async () => {
    const db = store(usage({ seatsInUse: 1, fastRunsUsed: 1 }));
    const refusal = await quotaFor("session", db, { config: FAST, poolRunning: true }).precheck();
    expect(refusal?.code).toBe("CONCURRENCY_LIMIT_REACHED");
    expect(quotaHeaders(refusal as QuotaRefusal)).toEqual({
      [QUOTA_HEADERS.runsLimit]: "1",
      [QUOTA_HEADERS.runsRemaining]: "0",
      [QUOTA_HEADERS.fastRunsLimit]: "2",
      [QUOTA_HEADERS.fastRunsRemaining]: "1",
    });
    expect(coldLines()).toEqual([]);
  });

  it("a run refused at its admission is told the same, from the usage the admission read", async () => {
    const db = store(usage(), {
      admitted: false,
      reason: "concurrency",
      usage: usage({ seatsInUse: 1, fastRunsUsed: 2 }),
    });
    const outcome = await quotaFor("session", db, { config: FAST, poolRunning: true }).admit({
      run: RUN,
      holdMs: 1_000,
    });
    expect(quotaHeaders((outcome as { refusal: QuotaRefusal }).refusal)).toEqual({
      [QUOTA_HEADERS.runsLimit]: "1",
      [QUOTA_HEADERS.runsRemaining]: "0",
      [QUOTA_HEADERS.fastRunsLimit]: "2",
      [QUOTA_HEADERS.fastRunsRemaining]: "0",
    });
  });
});

describe("the plan of the account", () => {
  const PLANS = parseQuotaEnv({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5" });

  it("a plan no setting names gets free's limits and one line naming it with the account's id — one for the whole run", async () => {
    const db = store(usage(), {
      admitted: true,
      run: { id: "run-1" } as Run,
      poolEntitled: false,
      usage: usage(),
    });
    const quota = quotaFor("session", db, {
      config: PLANS,
      user: { id: ACCOUNT, key: null, plan: "ghost" },
    });
    expect(quota.thresholds).toMatchObject({ plan: "free", concurrentRuns: 2 });
    await quota.precheck();
    await quota.admit({ run: RUN, holdMs: 1_000 });
    const unknown = lines.filter((line) => line.event === "quota_plan_unknown");
    expect(unknown.map(({ user_id, plan }) => ({ user_id, plan }))).toEqual([
      { user_id: ACCOUNT, plan: "ghost" },
    ]);
  });

  it("a named plan gets its own limits, in the refusal and in the line", async () => {
    const db = store(usage({ seatsInUse: 5 }));
    const refusal = await quotaFor("session", db, {
      config: PLANS,
      user: { id: ACCOUNT, key: null, plan: "pro" },
    }).precheck();
    expect(refusal?.message).toBe("5 runs in progress on this account; your plan's limit is 5.");
    expect(lines.find((line) => line.event === "quota_refused")).toMatchObject({
      user_id: ACCOUNT,
      bound: "concurrency",
      plan: "pro",
    });
  });
});

describe("a timeout above the server's maximum", () => {
  it("is refused 400 TIMEOUT_ABOVE_LIMIT, in the same words for every caller, with nothing to wait for", () => {
    expect(timeoutAboveLimit({ declaredS: 1800, maxS: 900, overridden: false })).toEqual({
      status: 400,
      code: "TIMEOUT_ABOVE_LIMIT",
      message: "This agent declares 1800 s; this server accepts at most 900 s.",
      headers: {},
    });
    expect(timeoutAboveLimit({ declaredS: 1800, maxS: 900, overridden: true }).message).toBe(
      "This run's environment override declares 1800 s; this server accepts at most 900 s.",
    );
  });
});

// The published error-code table (docs/api.md) lists every code a run's quota
// refusal and the account routes — the plan assignment among them — answer
// with, and the quota refusals of a push and of an upload. The table's own
// guard (error-codes-doc.test.ts) checks the other direction only: a listed
// code nothing emits fails it, an emitted code the table forgets does not.
describe("the error-code table of docs/api.md, from the quotas' side", () => {
  const read = (...path: string[]) => readFileSync(join(import.meta.dirname, ...path), "utf-8");

  /**
   * The codes a source answers with: each `code: "…"` it writes. Read as
   * text, which errs on the safe side here — a code written that way in a
   * comment is asked of the table too, never let through.
   */
  const answered = (source: string): string[] =>
    [...source.matchAll(/\bcode:\s*"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1] as string);

  /** The first cell of each row of the table under "### Error codes". */
  const listed = (markdown: string): Set<string> => {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === "### Error codes");
    const codes = new Set<string>();
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" && codes.size === 0) continue;
      if (!line.startsWith("|")) break;
      const code = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line)?.[1];
      if (code) codes.add(code);
    }
    return codes;
  };

  /**
   * A quota code written outside these files, in a file that answers many
   * more: asked of the table by name, once its file is seen to write it — a
   * code renamed there leaves the case below without it, never the table
   * asked for a name nothing writes.
   */
  const written = (source: string, code: string): string[] =>
    source.includes(`"${code}"`) ? [code] : [];

  const sources = {
    "quotas/admission.ts": answered(read("admission.ts")),
    "routes/account.ts": answered(read("..", "routes", "account.ts")),
    "services/registry.ts": written(
      read("..", "services", "registry.ts"),
      "STORAGE_QUOTA_EXCEEDED",
    ),
    "routes/files.ts": written(read("..", "routes", "files.ts"), "INPUT_FILES_LIMIT_REACHED"),
  };
  const table = listed(read("..", "..", "..", "..", "docs", "api.md"));

  it("reads the seven codes of the quotas, the push's and the upload's among them, and of the plan assignment, and a table that is not empty", () => {
    expect(Object.values(sources).flat()).toEqual(
      expect.arrayContaining([
        "CONCURRENCY_LIMIT_REACHED",
        "COMPUTE_QUOTA_EXCEEDED",
        "CAPACITY_EXHAUSTED",
        "TIMEOUT_ABOVE_LIMIT",
        "UNKNOWN_PLAN",
        "STORAGE_QUOTA_EXCEEDED",
        "INPUT_FILES_LIMIT_REACHED",
      ]),
    );
    expect(table.size).toBeGreaterThan(0);
  });

  it("has a row for every code they answer with", () => {
    const missing = Object.entries(sources).flatMap(([file, codes]) =>
      codes.filter((code) => !table.has(code)).map((code) => `${file}: ${code}`),
    );
    expect(missing).toEqual([]);
  });
});
