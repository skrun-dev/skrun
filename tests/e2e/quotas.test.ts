/**
 * E2E: what an account may consume, through POST /run — its seats, its compute
 * window and its plan.
 *
 * A seat is held from a run's admission to its final status: the account's
 * next run is admitted as soon as the previous one has ended, whatever its
 * mode and whatever its outcome — and a streamed run's caller may start the
 * next one on the very final event. Each refusal is told to a master
 * credential with the account's numbers, and to any other key of the account
 * without them. A plan an administrator assigns applies from the account's
 * next request; a plan no setting names gets the free plan's thresholds, and
 * says so once.
 *
 * Unchanged with the quotas set: a run still going when its account is
 * deleted, who `GET /api/me` signs in, the run history and the statistics. And
 * `GET /api/me` stays outside every per-address limiter.
 *
 * An account reads its own numbers through `GET /api/usage` — the ones its
 * runs' headers carry —, and its fast runs only while a runner pool runs.
 *
 * Through the SDK, its `fetch` handed to the app: a push past the server's
 * longest timeout or past the account's bundle storage, and an upload past its
 * live uploads, are refused as their typed errors — nothing of a refused push
 * stored, a deleted version or upload making room.
 *
 * What is simulated: the model (a spy on the built router's call, which a case
 * may hold until it lets the run end), the webhook delivery (captured, not
 * sent), and the server's log lines (captured); for the case with a runner
 * pool, the pool (an object that says it runs) and the cloud engine's run (a
 * spy that plays its events). What is real: the route, the pre-check and the
 * admission, the in-memory database and every write to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
import { createSession, sessionCookieName } from "../../packages/api/src/auth/session.js";
import { inputCache } from "../../packages/api/src/cache/input-cache.js";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import {
  ACCOUNT_LIMIT_MESSAGE,
  CAPACITY_MESSAGE,
} from "../../packages/api/src/quotas/admission.js";
import { parseQuotaEnv, type QuotaEnv } from "../../packages/api/src/quotas/thresholds.js";
import { validBundleOfSize } from "../../packages/api/src/routes/agent-bundle.shared.js";
import {
  FAKE_WEBHOOK_URL,
  fakeFlyioDeps,
  pushRunnableAgent,
  runFlyio,
  settledRun,
} from "../../packages/api/src/routes/flyio-run-harness.shared.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import {
  FlyioAdapter,
  LLMRouter,
  type RunEvent,
  type RunnerPool,
  type RunRequest,
} from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import {
  SkrunApiError,
  SkrunCapacityError,
  SkrunClient,
  SkrunComputeQuotaError,
  SkrunConcurrencyLimitError,
  SkrunFileUploadError,
  SkrunInputFilesLimitError,
  SkrunStorageQuotaError,
  SkrunTimeoutAboveLimitError,
} from "../../packages/sdk/src/index.js";
import { createTestApp, DEV_TOKEN, parseSSEEvents, seedUserKey } from "./setup.js";

/** Webhook deliveries, captured instead of sent. */
const deliveries = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../packages/api/src/utils/webhook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/api/src/utils/webhook.js")>();
  return {
    ...actual,
    deliverWebhook: async (_url: string, payload: object) => {
      deliveries.push(payload as Record<string, unknown>);
    },
  };
});

/** The server's log lines, captured instead of printed: every logger the API creates writes here. */
const logLines = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../packages/runtime/dist/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/runtime/dist/index.js")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      actual.createLogger(name, {
        write: (line: string) => {
          logLines.push(JSON.parse(line) as Record<string, unknown>);
        },
      }),
  };
});
const logged = (event: string) => logLines.filter((line) => line.event === event);

/** A caller's own model key: the run is servable without any server key. */
const CALLER_KEY = JSON.stringify({ anthropic: "sk-ant-fake-caller-key" });
const PROVIDER_REFUSED = "The provider refused.";

type Mode = "sync" | "sse" | "webhook";
type Outcome = "completes" | "fails";
type App = ReturnType<typeof createTestApp>["app"];

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The next model calls a case holds, oldest first: each waits for its outcome. */
const holds: Array<{ enter: () => void; outcome: Promise<Outcome> }> = [];

/** A model call held until the case releases it — the run in flight until then. */
interface HeldCall {
  /** Settles once the call has started: the run's row is written, its seat held. */
  entered: Promise<void>;
  /** End the call: the run completes, or its model fails. */
  release(outcome?: Outcome): void;
}

/** Hold the next model call that starts. */
function holdNextModelCall(): HeldCall {
  let enter: () => void = () => {};
  let settle: (outcome: Outcome) => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  holds.push({ enter, outcome });
  return { entered, release: (o: Outcome = "completes") => settle(o) };
}

beforeEach(() => {
  deliveries.length = 0;
  logLines.length = 0;
  holds.length = 0;
  vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => {
    const hold = holds.shift();
    if (hold) {
      hold.enter();
      if ((await hold.outcome) === "fails") throw new Error(PROVIDER_REFUSED);
    }
    return {
      content: '{"answer":"ok"}',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      estimatedCost: 0,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      durationMs: 1,
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One case's server, with these quota settings, and its account `alice` with a master key. */
interface World {
  app: App;
  db: MemoryDb;
  /** The app's object store: where a pushed bundle goes. */
  storage: MemoryStorage;
  alice: { id: string; key: string };
  /** Alice's agent, when the case pushed one. */
  agent: string;
  /** `POST /run` of alice's agent, with `token` (alice's master key by default). */
  run(mode: Mode, token?: string): Promise<Response>;
}

async function world(env: QuotaEnv, agent?: string): Promise<World> {
  const { app, db, storage } = createTestApp({ quotaConfig: parseQuotaEnv(env) });
  const alice = await seedUserKey(db, "alice");
  // Each case its own agent name: extracted bundles are cached by their bytes.
  if (agent) await pushRunnableAgent(app, db, "alice", agent, alice.key);
  return {
    app,
    db,
    storage,
    alice,
    agent: agent ?? "",
    run: (mode, token = alice.key) => runAs(app, "alice", agent ?? "", token, mode),
  };
}

async function runAs(
  app: App,
  ns: string,
  name: string,
  token: string,
  mode: Mode,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...bearer(token),
    "Content-Type": "application/json",
    "X-LLM-API-Key": CALLER_KEY,
  };
  if (mode === "sse") headers.Accept = "text/event-stream";
  const body: Record<string, unknown> = { input: { q: "hello" } };
  if (mode === "webhook") body.webhook_url = FAKE_WEBHOOK_URL;
  return await app.request(`/api/agents/${ns}/${name}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Wait for a run's end as its caller is told it, and hand back the status it was told. */
async function toldEnd(response: Promise<Response>, mode: Mode): Promise<string> {
  const res = await response;
  if (mode === "sync") {
    const body = (await res.json()) as { status?: string };
    return String(body.status);
  }
  if (mode === "sse") {
    const events = parseSSEEvents(await res.text());
    const final = events.find((e) => e.event === "run_complete" || e.event === "run_error");
    return final?.event === "run_complete" ? "completed" : final ? "failed" : "no final event";
  }
  expect(res.status).toBe(202);
  await vi.waitFor(() => expect(deliveries).toHaveLength(1), { timeout: 10_000 });
  return String(deliveries[0]?.status);
}

/** The error code of a refused response. */
async function errorOf(res: Response): Promise<{ code?: string; message?: string }> {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return body.error ?? {};
}

/** Read a stream's events as they arrive, each handed to `onEvent` before the next is read. */
async function readEvents(
  res: Response,
  onEvent: (event: { event: string; data: Record<string, unknown> }) => Promise<void>,
): Promise<string[]> {
  if (!res.body) throw new Error("the response has no body");
  const names: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return names;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const [event] = parseSSEEvents(buffer.slice(0, end + 2));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      if (!event) continue;
      names.push(event.event);
      await onEvent(event);
    }
  }
}

describe("E2E: a seat is held while a run runs, and freed as it ends", () => {
  const CASES = (["sync", "sse", "webhook"] as const).flatMap((mode) =>
    (["completes", "fails"] as const).map((outcome) => [mode, outcome] as const),
  );

  it.each(
    CASES,
  )("with one seat, a %s run that %s holds it until its end, and the next run is admitted at once", async (mode, outcome) => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" }, `one-seat-${mode}-${outcome}`);
    const held = holdNextModelCall();
    const first = w.run(mode);
    await held.entered;

    const refused = await w.run("sync");
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe("CONCURRENCY_LIMIT_REACHED");

    held.release(outcome);
    const expected = outcome === "completes" ? "completed" : "failed";
    expect(await toldEnd(first, mode)).toBe(expected);
    // The refused run wrote nothing; the first one is finished.
    expect((await w.db.listRuns()).map((run) => run.status)).toEqual([expected]);

    const next = await w.run("sync");
    expect(next.status).toBe(200);
    expect(next.headers.get("X-Quota-Runs-Remaining")).toBe("0");
    expect(((await next.json()) as { status?: string }).status).toBe("completed");
  });

  it("with one seat, a streamed run's caller who starts the next run on the very run_complete event has it admitted", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" }, "next-on-final-event");
    // The final write is slowed down: a final event sent before it lands would
    // reach the caller while the seat is still held.
    const finishRun = w.db.finishRun.bind(w.db);
    vi.spyOn(w.db, "finishRun").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return finishRun(...args);
    });

    let next: Response | undefined;
    const events = await readEvents(await w.run("sse"), async (event) => {
      if (event.event === "run_complete" && next === undefined) next = await w.run("sync");
    });

    expect(events.at(-1)).toBe("run_complete");
    expect(next?.status).toBe(200);
    expect(((await next?.json()) as { status?: string }).status).toBe("completed");
  });
});

describe("E2E: GET /api/me and the per-address limiters", () => {
  it("GET /api/me answers three hundred requests in a row from one address, every one 200", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" });
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) {
      const res = await w.app.request("/api/me", { headers: bearer(w.alice.key) });
      statuses.push(res.status);
    }
    const notOk = statuses.findIndex((status) => status !== 200);
    expect({ answered: statuses.length, firstNotOk: notOk === -1 ? null : notOk + 1 }).toEqual({
      answered: 300,
      firstNotOk: null,
    });
  });
});

describe("E2E: an account's plan decides its thresholds", () => {
  /** Assign `plan` to `id` as the instance administrator (the dev token, a master credential). */
  async function assign(app: App, id: string, plan: string): Promise<Response> {
    return app.request(`/api/admin/accounts/${id}/plan`, {
      method: "PUT",
      headers: { ...bearer(DEV_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
  }

  it("an account on the free plan, assigned another plan by an administrator, gets that plan's seats from its very next request", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=2" }, "plan-assigned");
    const held = holdNextModelCall();
    const first = w.run("sync");
    await held.entered;

    const refused = await w.run("sync");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("X-Quota-Runs-Limit")).toBe("1");

    const assigned = await assign(w.app, w.alice.id, "pro");
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toEqual({ id: w.alice.id, plan: "pro" });

    const admitted = await w.run("sync");
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("X-Quota-Runs-Limit")).toBe("2");
    expect(admitted.headers.get("X-Quota-Runs-Remaining")).toBe("0");

    held.release();
    expect(await toldEnd(first, "sync")).toBe("completed");
    expect(logged("quota_plan_unknown")).toEqual([]);
  });

  it("with three plans set, an account assigned the third gets its own seats", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=2,team=3" }, "plan-third");
    expect((await assign(w.app, w.alice.id, "team")).status).toBe(200);

    const res = await w.run("sync");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Quota-Runs-Limit")).toBe("3");
    expect(res.headers.get("X-Quota-Runs-Remaining")).toBe("2");
    expect(logged("quota_plan_unknown")).toEqual([]);
  });

  it("an account whose plan no setting names gets the free plan's seats, and one line names that plan", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=2" }, "plan-ghost");
    // Written straight to the database: the assignment route refuses a plan it does not know.
    await w.db.updateUser(w.alice.id, { plan: "ghost" });

    const res = await w.run("sync");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Quota-Runs-Limit")).toBe("1");
    expect(logged("quota_plan_unknown")).toEqual([
      expect.objectContaining({ event: "quota_plan_unknown", plan: "ghost", user_id: w.alice.id }),
    ]);
  });

  it.each([
    ["no plan", null],
    ["an empty plan", ""],
    ["the dev token", "dev token"],
  ] as const)("%s gets the free plan's seats, and no line is written", async (label, plan) => {
    const name = `plan-none-${label.replaceAll(" ", "-")}`;
    const env = { SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=2" };
    let res: Response;
    if (plan === "dev token") {
      const w = await world(env);
      await pushRunnableAgent(w.app, w.db, "dev", name);
      res = await runAs(w.app, "dev", name, DEV_TOKEN, "sync");
    } else {
      const w = await world(env, name);
      // The column holds what an older row, or a manual write, may leave there.
      await w.db.updateUser(w.alice.id, { plan: plan as string });
      res = await w.run("sync");
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Quota-Runs-Limit")).toBe("1");
    expect(logged("quota_plan_unknown")).toEqual([]);
  });
});

describe("E2E: each refusal, as a master key, a reduced key and a delegated key of the account see it", () => {
  type Credential = "master" | "reduced" | "delegated";
  const CREDENTIALS: readonly Credential[] = ["master", "reduced", "delegated"];

  /** Alice's three keys: her master key, one reduced to running, one delegated to her agent. */
  async function keysOf(w: World): Promise<Record<Credential, string>> {
    const agent = await w.db.getAgent("alice", w.agent);
    if (!agent) throw new Error("agent missing after push");
    const mint = async (scope: { scope_kind?: "agents"; agents?: string[] }) => {
      const { key, keyHash, keyPrefix } = generateApiKey();
      await w.db.createApiKey({
        user_id: w.alice.id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: "k",
        scopes: ["agent:run"],
        ...scope,
      });
      return key;
    };
    return {
      master: w.alice.key,
      reduced: await mint({}),
      delegated: await mint({ scope_kind: "agents", agents: [agent.id] }),
    };
  }

  /**
   * What each credential was answered: status, code, message, the wait, the
   * account's numbers, the names a browser may read, and the error the SDK
   * builds from that response — whether it is `typed`, its name and its wait.
   */
  async function refusalsSeenBy(
    w: World,
    keys: Record<Credential, string>,
    typed: abstract new (...args: never[]) => SkrunApiError,
  ) {
    const seen: Record<string, unknown> = {};
    for (const credential of CREDENTIALS) {
      const res = await w.run("sync", keys[credential]);
      const sdk = await SkrunApiError.fromResponse(res.clone());
      const error = await errorOf(res);
      seen[credential] = {
        status: res.status,
        code: error.code,
        message: error.message,
        retryAfter: res.headers.get("Retry-After"),
        numbers: Object.fromEntries(
          [...res.headers.entries()].filter(([name]) => name.startsWith("x-quota-")),
        ),
        sdk: {
          typed: sdk instanceof typed,
          name: sdk.name,
          retryAfterSeconds: (sdk as { retryAfterSeconds?: number }).retryAfterSeconds,
        },
        exposed: (res.headers.get("Access-Control-Expose-Headers") ?? "")
          .split(",")
          .map((name) => name.trim()),
      };
    }
    return seen;
  }

  const EXPOSED = expect.arrayContaining([
    "Retry-After",
    "X-Quota-Runs-Limit",
    "X-Quota-Runs-Remaining",
    "X-Quota-Compute-Limit",
    "X-Quota-Compute-Remaining",
    "X-Quota-Compute-Reset",
  ]);

  it("seats: 429 CONCURRENCY_LIMIT_REACHED, Retry-After 10, the account's numbers for the master key only", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "1" }, "refused-seats");
    const keys = await keysOf(w);
    const held = holdNextModelCall();
    const first = w.run("sync");
    await held.entered;

    const seen = await refusalsSeenBy(w, keys, SkrunConcurrencyLimitError);
    const others = {
      status: 429,
      code: "CONCURRENCY_LIMIT_REACHED",
      message: ACCOUNT_LIMIT_MESSAGE,
      retryAfter: "10",
      numbers: {},
      sdk: { typed: true, name: "SkrunConcurrencyLimitError", retryAfterSeconds: 10 },
      exposed: EXPOSED,
    };
    expect(seen).toEqual({
      master: {
        ...others,
        message: "1 run in progress on this account; your plan's limit is 1.",
        numbers: { "x-quota-runs-limit": "1", "x-quota-runs-remaining": "0" },
      },
      reduced: others,
      delegated: others,
    });

    held.release();
    expect(await toldEnd(first, "sync")).toBe("completed");
    expect(await w.db.listRuns()).toHaveLength(1);
  });

  it("compute: 429 COMPUTE_QUOTA_EXCEEDED, told to wait until the window renews, the account's numbers for the master key only", async () => {
    const at = Date.parse("2026-10-16T13:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const w = await world(
      { SKRUN_QUOTA_COMPUTE_SECONDS: "1", SKRUN_QUOTA_WINDOW_S: "3600" },
      "refused-compute",
    );
    const keys = await keysOf(w);
    const held = holdNextModelCall();
    const first = w.run("sync");
    await held.entered;
    // Two seconds into the run in flight: the window's one second is spent.
    vi.setSystemTime(at + 2_000);

    const seen = await refusalsSeenBy(w, keys, SkrunComputeQuotaError);
    const others = {
      status: 429,
      code: "COMPUTE_QUOTA_EXCEEDED",
      message: ACCOUNT_LIMIT_MESSAGE,
      retryAfter: "3598",
      numbers: {},
      sdk: { typed: true, name: "SkrunComputeQuotaError", retryAfterSeconds: 3598 },
      exposed: EXPOSED,
    };
    expect(seen).toEqual({
      master: {
        ...others,
        message: "2 s used of 1 in this window; it renews at 14:00 UTC.",
        numbers: {
          "x-quota-compute-limit": "1",
          "x-quota-compute-remaining": "0",
          "x-quota-compute-reset": String(Date.parse("2026-10-16T14:00:00.000Z") / 1000),
        },
      },
      reduced: others,
      delegated: others,
    });

    held.release();
    expect(await toldEnd(first, "sync")).toBe("completed");
    expect(await w.db.listRuns()).toHaveLength(1);
  });

  it("the instance full: 503 CAPACITY_EXHAUSTED, Retry-After 5, the same words for every key, the account's numbers for the master key only", async () => {
    const w = await world(
      { SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "1", SKRUN_QUOTA_CONCURRENT_RUNS: "5" },
      "refused-capacity",
    );
    const keys = await keysOf(w);
    const held = holdNextModelCall();
    const first = w.run("sync");
    await held.entered;

    const seen = await refusalsSeenBy(w, keys, SkrunCapacityError);
    const others = {
      status: 503,
      code: "CAPACITY_EXHAUSTED",
      message: CAPACITY_MESSAGE,
      retryAfter: "5",
      numbers: {},
      sdk: { typed: true, name: "SkrunCapacityError", retryAfterSeconds: 5 },
      exposed: EXPOSED,
    };
    expect(seen).toEqual({
      master: {
        ...others,
        numbers: { "x-quota-runs-limit": "5", "x-quota-runs-remaining": "4" },
      },
      reduced: others,
      delegated: others,
    });

    held.release();
    expect(await toldEnd(first, "sync")).toBe("completed");
    expect(await w.db.listRuns()).toHaveLength(1);
  });
});

describe("E2E: unchanged with the quotas set", () => {
  const QUOTAS: QuotaEnv = {
    SKRUN_QUOTA_CONCURRENT_RUNS: "1",
    SKRUN_QUOTA_COMPUTE_SECONDS: "3600",
    SKRUN_QUOTA_WINDOW_S: "21600",
  };

  it("a run still going when its account is deleted completes for its caller, and its row keeps nothing of its content", async () => {
    const w = await world(QUOTAS, "deleted-while-running");
    const held = holdNextModelCall();
    const ran = w.run("sync");
    await held.entered;

    const deletion = await w.app.request("/api/account", {
      method: "DELETE",
      headers: { ...bearer(w.alice.key), "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "alice" }),
    });
    expect(deletion.status).toBe(200);

    held.release();
    const res = await ran;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id: string; status: string; output: unknown };
    expect(body.status).toBe("completed");
    expect(body.output).toEqual({ answer: "ok" });
    const row = await w.db.getRun(body.run_id);
    expect(row).toMatchObject({
      status: "completed",
      user_id: null,
      agent_id: null,
      input: null,
      output: null,
      error: null,
    });
    expect(row?.content_cleared_at).toEqual(expect.any(String));
  });

  it("the run history and the statistics list the runs written — a refused run is not one — and none of a run's quota columns", async () => {
    const w = await world(QUOTAS, "history-and-stats");
    const held = holdNextModelCall();
    const first = w.run("sync");
    await held.entered;
    expect((await w.run("sync")).status).toBe(429);
    held.release();
    expect(await toldEnd(first, "sync")).toBe("completed");

    const runs = (await (
      await w.app.request("/api/runs", { headers: bearer(w.alice.key) })
    ).json()) as Array<Record<string, unknown>>;
    expect(runs.map((run) => run.status)).toEqual(["completed"]);
    for (const column of ["deadline_at", "charged_ms", "pool_entitled"]) {
      expect(runs[0]).not.toHaveProperty(column);
    }
    const one = (await (
      await w.app.request(`/api/runs/${runs[0]?.id}`, { headers: bearer(w.alice.key) })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(one).sort()).toEqual(Object.keys(runs[0] ?? {}).sort());

    const stats = (await (
      await w.app.request("/api/stats", { headers: bearer(w.alice.key) })
    ).json()) as { runs_today: number; failed_today: number };
    expect({ runs_today: stats.runs_today, failed_today: stats.failed_today }).toEqual({
      runs_today: 1,
      failed_today: 0,
    });
  });

  describe("who GET /api/me signs in, under a shared cookie domain", () => {
    const KEYS = [
      "NODE_ENV",
      "CORS_ORIGIN",
      "SKRUN_DEV_AUTH",
      "SKRUN_PUBLIC_URL",
      "SKRUN_SESSION_COOKIE_DOMAIN",
    ] as const;
    const snapshot: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of KEYS) snapshot[key] = process.env[key];
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGIN = "https://app.example.com";
      delete process.env.SKRUN_DEV_AUTH;
      process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
      process.env.SKRUN_SESSION_COOKIE_DOMAIN = "example.com";
    });

    afterEach(() => {
      for (const key of KEYS) {
        if (snapshot[key] === undefined) delete process.env[key];
        else process.env[key] = snapshot[key];
      }
    });

    it("a valid session signs its account in, no credential is 401, and the session cookie sent twice is 401 and erased", async () => {
      const w = await world(QUOTAS);
      const name = sessionCookieName();
      expect(name).toBe("__Secure-skrun_session");
      const session = await createSession(w.db, w.alice.id);

      const valid = await w.app.request("/api/me", { headers: { Cookie: `${name}=${session}` } });
      expect(valid.status).toBe(200);
      expect(((await valid.json()) as { id?: string }).id).toBe(w.alice.id);

      const none = await w.app.request("/api/me");
      expect(none.status).toBe(401);

      const twice = await w.app.request("/api/me", {
        headers: { Cookie: `${name}=${session}; ${name}=planted-by-a-sibling-host` },
      });
      expect(twice.status).toBe(401);
      expect(twice.headers.getSetCookie()).toHaveLength(5);
    });
  });
});

describe("E2E: an account reads its own usage, and the numbers its runs carry", () => {
  /** `GET /api/usage` with `token`: its status and its body. */
  async function usageOf(app: App, token: string) {
    const res = await app.request("/api/usage", { headers: bearer(token) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** A key of `userId` that may only run agents, or one delegated to no agent. */
  async function mintKey(db: MemoryDb, userId: string, kind: "run-only" | "delegated") {
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: kind,
      scopes: ["agent:run"],
      ...(kind === "delegated" && { scope_kind: "agents" as const, agents: [] }),
    });
    return key;
  }

  it("without a pool, two accounts each read their own numbers — the ones their runs' headers carry — and nothing of fast runs, the variable set", async () => {
    const w = await world(
      {
        SKRUN_QUOTA_CONCURRENT_RUNS: "2",
        SKRUN_QUOTA_COMPUTE_SECONDS: "3600",
        SKRUN_QUOTA_WINDOW_S: "86400",
        SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2",
      },
      "usage-two-accounts",
    );
    const bob = await seedUserKey(w.db, "bob");
    const held = holdNextModelCall();
    const opened = await w.run("sse");
    await held.entered;

    // The stream opened at the run's admission: its seat counted, its time not yet.
    const reset = Number(opened.headers.get("X-Quota-Compute-Reset"));
    const window = {
      start: new Date((reset - 86_400) * 1000).toISOString(),
      end: new Date(reset * 1000).toISOString(),
    };
    expect({
      runsRemaining: opened.headers.get("X-Quota-Runs-Remaining"),
      computeRemaining: opened.headers.get("X-Quota-Compute-Remaining"),
      fastLimit: opened.headers.get("X-Quota-Fast-Runs-Limit"),
      fastRemaining: opened.headers.get("X-Quota-Fast-Runs-Remaining"),
    }).toEqual({
      runsRemaining: "1",
      computeRemaining: "3600",
      fastLimit: null,
      fastRemaining: null,
    });

    const alice = await usageOf(w.app, w.alice.key);
    expect(alice).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: {
          concurrent_runs: { limit: 2, in_use: 1 },
          compute: { limit_seconds: 3600, used_seconds: expect.any(Number), window },
          fast_runs: null,
        },
      },
    });
    expect(await usageOf(w.app, bob.key)).toEqual({
      status: 200,
      body: {
        plan: "free",
        quotas: {
          concurrent_runs: { limit: 2, in_use: 0 },
          compute: { limit_seconds: 3600, used_seconds: 0, window },
          fast_runs: null,
        },
      },
    });

    held.release();
    await opened.text();
    // The SDK reads the same route the server serves.
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      w.app.fetch(new Request(input, init))) as typeof fetch;
    try {
      const client = new SkrunClient({ baseUrl: "http://usage.test", token: w.alice.key });
      const read = await client.usage();
      expect(read).toEqual((await usageOf(w.app, w.alice.key)).body);
      expect(read.quotas?.concurrent_runs).toEqual({ limit: 2, in_use: 0 });
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it("a key without full access is refused, the dev token reads the free plan, and GET /api/me carries nothing more", async () => {
    const w = await world({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=1,pro=3" });
    await w.db.updateUser(w.alice.id, { plan: "pro" });
    const runOnly = await mintKey(w.db, w.alice.id, "run-only");
    const delegated = await mintKey(w.db, w.alice.id, "delegated");

    const refused = {
      runOnly: await usageOf(w.app, runOnly),
      delegated: await usageOf(w.app, delegated),
    };
    expect({
      runOnly: [refused.runOnly.status, (refused.runOnly.body.error as { code?: string }).code],
      delegated: [
        refused.delegated.status,
        (refused.delegated.body.error as { code?: string }).code,
      ],
    }).toEqual({
      runOnly: [403, "KEY_SCOPE_FORBIDDEN"],
      delegated: [403, "KEY_SCOPE_FORBIDDEN"],
    });

    expect((await usageOf(w.app, w.alice.key)).body).toEqual({
      plan: "pro",
      quotas: { concurrent_runs: { limit: 3, in_use: 0 }, compute: null, fast_runs: null },
    });
    expect((await usageOf(w.app, DEV_TOKEN)).body).toEqual({
      plan: "free",
      quotas: { concurrent_runs: { limit: 1, in_use: 0 }, compute: null, fast_runs: null },
    });

    const me = await w.app.request("/api/me", { headers: bearer(w.alice.key) });
    expect(Object.keys((await me.json()) as object).sort()).toEqual([
      "avatar_url",
      "email",
      "id",
      "namespace",
      "plan",
      "role",
      "username",
      "verification_policy",
    ]);
  });

  it("with a runner pool (the cloud engine, its run simulated), the route and each run's headers agree on the fast runs: two an hour, the third run sent cold", async () => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const pool = { enabled: true, start: () => undefined } as unknown as RunnerPool;
    const app = createApp(storage, db, {
      runtimeMode: "flyio",
      flyioDeps: { ...fakeFlyioDeps(storage), pool },
      quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" }),
    });
    await pushRunnableAgent(app, db, "dev", "usage-fast-runs");
    const requests: RunRequest[] = [];
    vi.spyOn(FlyioAdapter.prototype, "executeStream").mockImplementation(async function* (
      request: RunRequest,
    ): AsyncGenerator<RunEvent> {
      requests.push(request);
      const at = () => new Date().toISOString();
      yield {
        type: "run_start",
        run_id: request.runId,
        timestamp: at(),
        agent: request.agentConfig.name,
        agent_version: request.agent_version ?? "unknown",
      };
      yield {
        type: "run_complete",
        run_id: request.runId,
        timestamp: at(),
        output: { answer: "scripted" },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 1,
        files: [],
        files_excluded: {},
      };
    });
    const fastRuns = async () => {
      const { status, body } = await usageOf(app, DEV_TOKEN);
      return { status, fast_runs: (body.quotas as Record<string, unknown> | null)?.fast_runs };
    };

    expect(await fastRuns()).toEqual({
      status: 200,
      fast_runs: { limit: 2, remaining: 2, resets_at: null },
    });
    const seen: Array<Record<string, unknown>> = [];
    let resetsAt: string | null = null;
    for (let i = 0; i < 3; i++) {
      const res = await runFlyio(app, "dev", "usage-fast-runs", { mode: "sse" });
      expect(res.status).toBe(200);
      await res.text();
      const request = requests[i];
      const row = await settledRun(db, request?.runId ?? "");
      resetsAt ??= new Date(Date.parse(row.created_at) + 3_600_000).toISOString();
      seen.push({
        eligible: request?.poolEligible,
        entitled: row.pool_entitled,
        headers: [
          res.headers.get("X-Quota-Fast-Runs-Limit"),
          res.headers.get("X-Quota-Fast-Runs-Remaining"),
        ],
        route: (await fastRuns()).fast_runs,
      });
    }
    // The first run's right ends its hour first; the third, sent cold, moves nothing.
    expect(seen).toEqual([
      {
        eligible: true,
        entitled: true,
        headers: ["2", "1"],
        route: { limit: 2, remaining: 1, resets_at: resetsAt },
      },
      {
        eligible: true,
        entitled: true,
        headers: ["2", "0"],
        route: { limit: 2, remaining: 0, resets_at: resetsAt },
      },
      {
        eligible: false,
        entitled: false,
        headers: ["2", "0"],
        route: { limit: 2, remaining: 0, resets_at: resetsAt },
      },
    ]);
    expect(logged("run_cold_by_quota")).toHaveLength(1);
  });
});

describe("E2E: what a push and an upload may take, through the SDK", () => {
  const MIB = 1024 * 1024;

  afterEach(() => {
    inputCache.clear();
  });

  /** Run `body` with the SDK's `fetch` handed to `app`. */
  async function throughApp<T>(app: App, body: () => Promise<T>): Promise<T> {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init))) as typeof fetch;
    try {
      return await body();
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  }

  /** What `promise` was rejected with, or null when it resolved. */
  const rejection = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => null,
      (err: unknown) => err,
    );

  /** A key of `userId` reduced to `operations`, or one delegated to no agent. */
  async function keyOf(db: MemoryDb, userId: string, operations: string[], delegated = false) {
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
      scopes: operations,
      ...(delegated && { scope_kind: "agents" as const, agents: [] }),
    });
    return key;
  }

  /** A bundle whose agent.yaml declares `timeout`. */
  function agentBundle(name: string, timeout: string): Promise<Buffer> {
    const yaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-6",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      `  timeout: ${timeout}`,
    ].join("\n");
    return packAgentTar([{ name: "agent.yaml", content: Buffer.from(yaml) }]);
  }

  it("a push past the server's longest timeout or the account's storage is refused as its typed error and leaves nothing; a deleted version makes room", async () => {
    const w = await world({ SKRUN_RUN_MAX_TIMEOUT_S: "900", SKRUN_QUOTA_STORAGE_MB: "1" });
    const pusher = await keyOf(w.db, w.alice.id, ["agent:push"]);

    await throughApp(w.app, async () => {
      const master = new SkrunClient({ baseUrl: "http://push.test", token: w.alice.key });
      const reduced = new SkrunClient({ baseUrl: "http://push.test", token: pusher });

      const slow = await rejection(
        master.push("alice/slow", await agentBundle("slow", "1800s"), "1.0.0"),
      );
      expect(slow).toBeInstanceOf(SkrunTimeoutAboveLimitError);
      expect(slow).toMatchObject({
        status: 400,
        message: "This agent declares 1800 s; this server accepts at most 900 s.",
        retryAfterSeconds: undefined,
      });

      // Nearly the whole storage, taken by two versions of one agent.
      await master.push("alice/big", await validBundleOfSize(MIB / 2, "big"), "1.0.0");
      await master.push("alice/big", await validBundleOfSize(MIB / 2 - 1024, "big"), "1.0.1");
      const more = await validBundleOfSize(2048, "more");
      const over = await rejection(master.push("alice/more", more, "1.0.0"));
      expect(over).toBeInstanceOf(SkrunStorageQuotaError);
      expect(over).toMatchObject({
        status: 413,
        message:
          "This account's agents hold 1023 KB of the 1 MB of bundle storage its plan allows; this bundle (2 KB) does not fit. Delete a version no longer needed (DELETE /api/agents/:namespace/:name/versions/:version) to make room — or, for an agent's last version, the agent (DELETE /api/agents/:namespace/:name), which deletes its state and its model keys too, and removes it from the keys restricted to it.",
        retryAfterSeconds: undefined,
      });
      const told = await rejection(reduced.push("alice/more", more, "1.0.0"));
      expect(told).toBeInstanceOf(SkrunStorageQuotaError);
      expect((told as SkrunStorageQuotaError).message).toBe(
        "This push would take this account past the bundle storage its plan allows; a version deleted from the account makes room — or, for an agent's last version, the agent, which deletes its state and its model keys too, and removes it from the keys restricted to it.",
      );
      // A version already pushed is told so, not that the storage is full.
      const again = await rejection(
        master.push("alice/big", await validBundleOfSize(MIB / 2, "big"), "1.0.0"),
      );
      expect(again).toMatchObject({ status: 409, code: "VERSION_EXISTS" });

      // Nothing of a refused push: no agent, no object.
      expect(await w.db.getAgent("alice", "slow")).toBeNull();
      expect(await w.db.getAgent("alice", "more")).toBeNull();
      expect(await w.storage.get("alice/slow/1.0.0.agent")).toBeNull();
      expect(await w.storage.get("alice/more/1.0.0.agent")).toBeNull();

      const deleted = await w.app.request("/api/agents/alice/big/versions/1.0.0", {
        method: "DELETE",
        headers: bearer(w.alice.key),
      });
      expect(deleted.status).toBe(204);
      await master.push("alice/more", more, "1.0.0");
      expect(await w.storage.get("alice/more/1.0.0.agent")).not.toBeNull();
    });

    expect(logged("quota_refused").map((line) => [line.bound, line.plan])).toEqual([
      ["max_timeout", "free"],
      ["storage", "free"],
      ["storage", "free"],
    ]);
  });

  it("an upload past the account's live uploads is refused, its typed error the cause of the SDK's, told to wait for the oldest's expiry; a deleted upload makes room", async () => {
    const at = Date.parse("2026-10-18T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const w = await world({ SKRUN_QUOTA_INPUT_FILES: "1" });
    const delegated = await keyOf(w.db, w.alice.id, ["agent:run"], true);
    const file = () => new Blob([new Uint8Array(16)], { type: "image/png" });

    await throughApp(w.app, async () => {
      const master = new SkrunClient({ baseUrl: "http://upload.test", token: w.alice.key });
      const client = new SkrunClient({ baseUrl: "http://upload.test", token: delegated });

      const first = await master.uploadFile(file());
      vi.setSystemTime(at + 60_000);
      const refused = {
        master: await rejection(master.uploadFile(file())),
        delegated: await rejection(client.uploadFile(file())),
      };
      const causes = Object.fromEntries(
        Object.entries(refused).map(([who, err]) => {
          expect(err).toBeInstanceOf(SkrunFileUploadError);
          const cause = (err as SkrunFileUploadError).cause;
          expect(cause).toBeInstanceOf(SkrunInputFilesLimitError);
          const typed = cause as SkrunInputFilesLimitError;
          return [
            who,
            { status: typed.status, wait: typed.retryAfterSeconds, said: typed.message },
          ];
        }),
      );
      expect(causes).toEqual({
        master: {
          status: 429,
          wait: 86_400 - 60,
          said: "1 live upload on this account; your plan's limit is 1. The oldest expires at 2026-10-19T12:00:00.000Z; an upload deleted (DELETE /api/files/:id) frees its place sooner.",
        },
        delegated: { status: 429, wait: 86_400 - 60, said: ACCOUNT_LIMIT_MESSAGE },
      });

      // The SDK frees the place: the upload deleted, the next one is kept.
      await master.deleteFile(first.file_id);
      expect((await client.uploadFile(file())).file_id).toMatch(/^fil_[0-9a-f]{32}$/);
      const gone = await rejection(master.deleteFile(first.file_id));
      expect(gone).toMatchObject({ status: 404, code: "FILE_NOT_FOUND" });
    });

    expect(logged("quota_refused").map((line) => [line.bound, line.plan])).toEqual([
      ["input_files", "free"],
      ["input_files", "free"],
    ]);
  });
});
