import type { RunnerPool } from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import type { AccountUsage } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { parseQuotaEnv, type QuotaEnv } from "../quotas/thresholds.js";
import { MemoryStorage } from "../storage/memory.js";
import { DEV_TOKEN, fakeFlyioDeps } from "./flyio-run-harness.shared.js";

/**
 * `GET /api/usage`: what an account consumes, read by the account itself — its
 * plan, its seats in use, its compute in the current window, and, only while
 * a runner pool runs, its fast runs of the rolling hour. Through the whole
 * app: the real authentication, the route as mounted, an in-memory database.
 * What is simulated: the runner pool (an object that says whether it runs),
 * the clock (fixed), and where the server's log lines go (captured).
 */

/** The server's log lines, captured instead of printed. */
const { lines } = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      actual.createLogger(name, {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
  };
});

const MINUTE = 60_000;
/** Now, for every case: 12:30 UTC. A six-hour window runs from 12:00 to 18:00. */
const T0 = Date.parse("2026-10-18T12:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  lines.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Where the server runs its agents, and whether a runner pool runs beside them. */
type Engine = "local" | "cloud without a pool" | "cloud with a pool" | "cloud with a pool of zero";

function server(env: QuotaEnv, engine: Engine = "local") {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const quotaConfig = parseQuotaEnv(env);
  if (engine === "local") {
    return { app: createApp(storage, db, { runtimeMode: "local", quotaConfig }), db };
  }
  const deps = fakeFlyioDeps(storage);
  if (engine !== "cloud without a pool") {
    deps.pool = {
      enabled: engine === "cloud with a pool",
      start: () => undefined,
    } as unknown as RunnerPool;
  }
  return {
    app: createApp(storage, db, { runtimeMode: "flyio", flyioDeps: deps, quotaConfig }),
    db,
  };
}

type KeyKind = "full" | "run-only" | "delegated";

/** An account, its plan, and a key of `kind`. */
async function account(
  db: MemoryDb,
  username: string,
  opts: { plan?: string; kind?: KeyKind } = {},
): Promise<{ id: string; key: string }> {
  const user = await db.createUser({ github_id: `gh-${username}`, username });
  if (opts.plan !== undefined) await db.updateUser(user.id, { plan: opts.plan });
  return { id: user.id, key: await keyOf(db, user.id, opts.kind ?? "full") };
}

async function keyOf(db: MemoryDb, userId: string, kind: KeyKind): Promise<string> {
  const k = generateApiKey();
  await db.createApiKey({
    user_id: userId,
    key_hash: k.keyHash,
    key_prefix: k.keyPrefix,
    name: kind,
    ...(kind === "run-only" && { scopes: ["agent:run"] }),
    ...(kind === "delegated" && { scope_kind: "agents" as const, agents: [] }),
  });
  return k.key;
}

let runCount = 0;

/**
 * One run of `userId`, admitted at `at` with or without the right to a pooled
 * machine. Still running (its seat held for an hour) unless `ended` gives its
 * end and the time it was charged.
 */
async function run(
  db: MemoryDb,
  userId: string,
  at: number,
  opts: { entitled?: boolean; ended?: { at: number; chargedMs: number } } = {},
): Promise<void> {
  const id = `run-${++runCount}`;
  const admitted = await db.admitRun({
    run: { id, agent_id: null, agent_version: "1.0.0", user_id: userId },
    now: iso(at),
    deadlineAt: iso(at + 60 * MINUTE),
    windowStart: null,
    limits: { concurrentRuns: null, computeMs: null, fastRunsPerHour: null, instanceCap: null },
    // Nothing bounds the write: the row has the right exactly when a pool is said to run.
    poolRunning: opts.entitled ?? false,
  });
  expect(admitted.admitted).toBe(true);
  if (opts.ended) {
    await db.finishRun(id, {
      status: "completed",
      completed_at: iso(opts.ended.at),
      charged_ms: opts.ended.chargedMs,
    });
  }
}

/** The route's answer: its status, and its body — the text itself when it is not JSON. */
async function usage(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request("/api/usage", { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { status: res.status, body };
}

/** The route's status and the fast runs it tells. */
async function fastRuns(app: ReturnType<typeof createApp>, token: string) {
  const { status, body } = await usage(app, token);
  const quotas = body.quotas as Record<string, unknown> | null | undefined;
  return { status, fast_runs: quotas?.fast_runs };
}

describe("GET /api/usage — an account reads its own consumption", () => {
  it("two accounts on one server each read their own numbers: the plan, the seats in use, the compute of the window, the fast runs of the hour", async () => {
    const { app, db } = server(
      {
        SKRUN_QUOTA_CONCURRENT_RUNS: "2",
        SKRUN_QUOTA_COMPUTE_SECONDS: "3600",
        SKRUN_QUOTA_WINDOW_S: "21600",
        SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "3",
      },
      "cloud with a pool",
    );
    const alice = await account(db, "alice");
    const bob = await account(db, "bob");
    // Alice: a run that ended at 12:12, charged 90.5 s, and one in flight since 12:25 — both with the right.
    await run(db, alice.id, T0 - 20 * MINUTE, {
      entitled: true,
      ended: { at: T0 - 18 * MINUTE, chargedMs: 90_500 },
    });
    await run(db, alice.id, T0 - 5 * MINUTE, { entitled: true });
    // Bob: one run that ended, without the right.
    await run(db, bob.id, T0 - 10 * MINUTE, { ended: { at: T0 - 9 * MINUTE, chargedMs: 30_000 } });

    const window = { start: "2026-10-18T12:00:00.000Z", end: "2026-10-18T18:00:00.000Z" };
    expect(await usage(app, alice.key)).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: {
          concurrent_runs: { limit: 2, in_use: 1 },
          // 90.5 s, plus the five minutes of the run in flight, in whole seconds.
          compute: { limit_seconds: 3600, used_seconds: 390, window },
          fast_runs: { limit: 3, remaining: 1, resets_at: "2026-10-18T13:10:00.000Z" },
        },
      },
    });
    expect(await usage(app, bob.key)).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: {
          concurrent_runs: { limit: 2, in_use: 0 },
          compute: { limit_seconds: 3600, used_seconds: 30, window },
          fast_runs: { limit: 3, remaining: 3, resets_at: null },
        },
      },
    });
  });

  // The window is fixed: a run created a millisecond before its start belongs
  // to the window before, however recent, and counts nothing here.
  it("the compute counts the current window's runs only: a run created just before the window's start counts nothing, one created at its start counts", async () => {
    const { app, db } = server({
      SKRUN_QUOTA_COMPUTE_SECONDS: "3600",
      SKRUN_QUOTA_WINDOW_S: "21600",
    });
    const alice = await account(db, "alice");
    const start = Date.parse("2026-10-18T12:00:00.000Z");
    await run(db, alice.id, start - 1, { ended: { at: start + 5 * MINUTE, chargedMs: 600_000 } });
    await run(db, alice.id, start, { ended: { at: start + 2 * MINUTE, chargedMs: 90_000 } });
    expect((await usage(app, alice.key)).body).toEqual({
      plan: "free",
      quotas: {
        concurrent_runs: null,
        compute: {
          limit_seconds: 3600,
          used_seconds: 90,
          window: { start: "2026-10-18T12:00:00.000Z", end: "2026-10-18T18:00:00.000Z" },
        },
        fast_runs: null,
      },
    });
  });

  // The numbers are the account's, not the key's: a key handed out to run an
  // agent reads none of them — the refusal of the run history, word for word.
  it("a key without full access is refused: a run-only key told what it takes, a delegated key with its own words", async () => {
    const { app, db } = server({ SKRUN_QUOTA_CONCURRENT_RUNS: "2" });
    const alice = await account(db, "alice");
    const runOnly = await keyOf(db, alice.id, "run-only");
    const delegated = await keyOf(db, alice.id, "delegated");

    expect(await usage(app, runOnly)).toEqual({
      status: 403,
      body: {
        error: {
          code: "KEY_SCOPE_FORBIDDEN",
          message:
            "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.",
        },
      },
    });
    expect(await usage(app, delegated)).toEqual({
      status: 403,
      body: {
        error: {
          code: "KEY_SCOPE_FORBIDDEN",
          message: "This endpoint is not available to a resource-scoped API key.",
        },
      },
    });
    expect((await usage(app, alice.key)).status).toBe(200);
  });

  it("a request without credentials is refused 401", async () => {
    const { app } = server({ SKRUN_QUOTA_CONCURRENT_RUNS: "2" });
    const res = await app.request("/api/usage");
    expect(res.status).toBe(401);
  });

  it.each<Engine>([
    "local",
    "cloud with a pool",
  ])("no quota variable set (%s): quotas null, the plan still named", async (engine) => {
    const { app, db } = server({}, engine);
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - MINUTE, { entitled: true });
    expect(await usage(app, alice.key)).toEqual({
      status: 200,
      body: { plan: "free", quotas: null },
    });
  });

  // Without a pool no run has the right to one: the route says nothing of
  // fast runs, whatever the variable says.
  it.each<Engine>([
    "local",
    "cloud without a pool",
    "cloud with a pool of zero",
  ])("no pool running (%s), the fast-run variable set: fast_runs null, the rest told", async (engine) => {
    const { app, db } = server(
      { SKRUN_QUOTA_CONCURRENT_RUNS: "2", SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "3" },
      engine,
    );
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - MINUTE);
    expect(await usage(app, alice.key)).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: { concurrent_runs: { limit: 2, in_use: 1 }, compute: null, fast_runs: null },
      },
    });
  });

  it("a pool running and no fast-run variable: every run has the right, none is counted — limit, remaining and resets_at null", async () => {
    const { app, db } = server({ SKRUN_QUOTA_CONCURRENT_RUNS: "2" }, "cloud with a pool");
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - 10 * MINUTE, { entitled: true });
    expect(await usage(app, alice.key)).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: {
          concurrent_runs: { limit: 2, in_use: 1 },
          compute: null,
          fast_runs: { limit: null, remaining: null, resets_at: null },
        },
      },
    });
  });

  // A plan with no fast run has nothing left and nothing that comes back —
  // even with runs of the hour that had the right before its plan changed.
  it("a pool running and a plan that includes no fast run: limit 0, remaining 0, resets_at null", async () => {
    const { app, db } = server({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "0" }, "cloud with a pool");
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - 10 * MINUTE, { entitled: true });
    expect(await usage(app, alice.key)).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: {
          concurrent_runs: null,
          compute: null,
          fast_runs: { limit: 0, remaining: 0, resets_at: null },
        },
      },
    });
  });

  it("resets_at is the creation of the oldest run of the hour that keeps the right, plus an hour: a run without it moves that neither way, and a run exactly an hour old has left the hour", async () => {
    const { app, db } = server({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "3" }, "cloud with a pool");
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - 60 * MINUTE, { entitled: true }); // 11:30:00.000 — out of the hour
    await run(db, alice.id, T0 - 45 * MINUTE); // 11:45, no right
    await run(db, alice.id, T0 - 40 * MINUTE, { entitled: true }); // 11:50 — the oldest that counts
    await run(db, alice.id, T0 - 10 * MINUTE, { entitled: true }); // 12:20
    await run(db, alice.id, T0 - 5 * MINUTE); // 12:25, no right
    expect(await fastRuns(app, alice.key)).toEqual({
      status: 200,
      fast_runs: { limit: 3, remaining: 1, resets_at: "2026-10-18T12:50:00.000Z" },
    });
  });

  // Three runs entitled at 11:40, 12:00 and 12:10, then the plan lowered to
  // two an hour: the 11:40 run leaving at 12:40 still leaves two — the limit.
  // A right comes back only when the 12:00 run leaves, at 13:00.
  it("fast runs used up under a lowered plan: remaining 0, never below, and resets_at the instant the account drops back under its limit — a right is back then, not before", async () => {
    const { app, db } = server({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" }, "cloud with a pool");
    const alice = await account(db, "alice");
    for (const ago of [50, 30, 20]) {
      await run(db, alice.id, T0 - ago * MINUTE, { entitled: true });
    }
    expect(await fastRuns(app, alice.key)).toEqual({
      status: 200,
      fast_runs: { limit: 2, remaining: 0, resets_at: "2026-10-18T13:00:00.000Z" },
    });
    vi.setSystemTime(Date.parse("2026-10-18T12:59:59.999Z"));
    expect((await fastRuns(app, alice.key)).fast_runs).toEqual({
      limit: 2,
      remaining: 0,
      resets_at: "2026-10-18T13:00:00.000Z",
    });
    vi.setSystemTime(Date.parse("2026-10-18T13:00:00.000Z"));
    expect((await fastRuns(app, alice.key)).fast_runs).toEqual({
      limit: 2,
      remaining: 1,
      resets_at: "2026-10-18T13:10:00.000Z",
    });
  });

  // A store that does not follow the type — written in JavaScript, or built
  // against the type before the field was required — may leave out the run
  // whose leaving gives a right back: the route answers resets_at null and
  // says so in one line, never a 500.
  it("a store that leaves out the run whose leaving gives a right back: resets_at null, the rest told, and one error line with the account's id", async () => {
    const { app, db } = server({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "3" }, "cloud with a pool");
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - 10 * MINUTE, { entitled: true });
    const read = db.getAccountUsage.bind(db);
    vi.spyOn(db, "getAccountUsage").mockImplementation(async (userId, at) => {
      const { releasingFastRunAt: _leftOut, ...rest } = await read(userId, at);
      return rest as AccountUsage;
    });
    expect(await fastRuns(app, alice.key)).toEqual({
      status: 200,
      fast_runs: { limit: 3, remaining: 2, resets_at: null },
    });
    const unread = lines.filter((line) => line.event === "usage_releasing_unread");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ level: 50, user_id: alice.id });
  });

  // The line is for a store that leaves the field out, and for it alone: one
  // that sets it — to a run's creation, or to null when no right comes back —
  // writes none.
  it.each([
    ["a run's creation", true, "2026-10-18T13:20:00.000Z"],
    ["null, no right to come back", false, null],
  ] as const)("a store that tells the run whose leaving gives a right back — %s — writes no error line", async (_label, entitled, resetsAt) => {
    const { app, db } = server({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "3" }, "cloud with a pool");
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - 10 * MINUTE, { entitled });
    expect(await fastRuns(app, alice.key)).toEqual({
      status: 200,
      fast_runs: { limit: 3, remaining: entitled ? 2 : 3, resets_at: resetsAt },
    });
    expect(lines.filter((line) => line.event === "usage_releasing_unread")).toEqual([]);
  });

  it("no run with the right in the hour: every fast run left, and nothing to reset", async () => {
    const { app, db } = server({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" }, "cloud with a pool");
    const alice = await account(db, "alice");
    await run(db, alice.id, T0 - 90 * MINUTE, { entitled: true });
    await run(db, alice.id, T0 - 10 * MINUTE);
    expect(await fastRuns(app, alice.key)).toEqual({
      status: 200,
      fast_runs: { limit: 2, remaining: 2, resets_at: null },
    });
  });

  // The dev token carries no plan: it reads the free plan's numbers, as its
  // runs are bounded by them, whatever plan its account was given.
  it("the dev token reads the free plan, where an account's key reads the plan it was assigned", async () => {
    const { app, db } = server({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=3" });
    const alice = await account(db, "alice", { plan: "pro" });

    const dev = await usage(app, DEV_TOKEN);
    expect(dev.body).toEqual({
      plan: "free",
      quotas: { concurrent_runs: { limit: 1, in_use: 0 }, compute: null, fast_runs: null },
    });
    const me = await app.request("/api/me", { headers: { Authorization: `Bearer ${DEV_TOKEN}` } });
    const devId = ((await me.json()) as { id: string }).id;
    expect(await db.updateUser(devId, { plan: "pro" })).toMatchObject({ plan: "pro" });
    expect((await usage(app, DEV_TOKEN)).body.plan).toBe("free");

    expect((await usage(app, alice.key)).body).toEqual({
      plan: "pro",
      quotas: { concurrent_runs: { limit: 3, in_use: 0 }, compute: null, fast_runs: null },
    });
  });

  // A dev token whose account could not be recorded has no row behind its id,
  // and its runs count against no account: there is nothing to read — whether
  // the server sets quotas or not.
  it.each<[string, QuotaEnv]>([
    ["quotas set", { SKRUN_QUOTA_CONCURRENT_RUNS: "2", SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "3" }],
    ["no quota set", {}],
  ])("a dev token whose account could not be recorded is answered 404, before any read (%s)", async (_label, env) => {
    const { app, db } = server(env, "cloud with a pool");
    vi.spyOn(db, "createUser").mockRejectedValue(new Error("database is locked"));
    const reads = vi.spyOn(db, "getAccountUsage");
    expect(await usage(app, DEV_TOKEN)).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "This account has no record." } },
    });
    expect(reads).not.toHaveBeenCalled();
  });

  it("a plan no setting names reads the free plan's numbers, and is named in one line with the account's id", async () => {
    const { app, db } = server({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=3" });
    const alice = await account(db, "alice", { plan: "ghost" });
    expect((await usage(app, alice.key)).body).toEqual({
      plan: "free",
      quotas: { concurrent_runs: { limit: 1, in_use: 0 }, compute: null, fast_runs: null },
    });
    const unknown = lines.filter((line) => line.event === "quota_plan_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ plan: "ghost", user_id: alice.id });
  });
});
