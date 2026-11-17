import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { getRequestListener } from "@hono/node-server";
import {
  acquisitionBudgetMs,
  FLY_APP_ACTION_BURST,
  FlyioAdapter,
  MAX_TIMER_DELAY_MS,
  type MachineSpawnPhase,
  machineLifetimeSeconds,
  RUN_OUTPUTS_PREFIX,
  type RunEvent,
  type RunnerPool,
  type RunRequest,
  runOutputKey,
  seatDeadlineMarginMs,
} from "@skrun-dev/runtime";
import { packAgentTar, parseAgentYaml } from "@skrun-dev/schema";
import { SSEStreamingApi } from "hono/streaming";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { bundleCache, bundleExtractionsInUse, ownedExtractionDirs } from "../cache/bundle-cache.js";
import { removeOrphanedFiles } from "../cache/file-cache-sweep.js";
import { SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import {
  _resetShutdownForTests,
  backgroundCleanupCount,
  shutdownInFlightRuns,
} from "../runtime/in-flight-runs.js";
import { MemoryStorage } from "../storage/memory.js";
import { BUNDLE_DIR_PREFIX } from "../utils/bundle.js";
import { FINAL_WRITE_RETRY_DELAYS_MS, SHUTDOWN_RUN_ERROR_CODE } from "./_helpers.js";
import { minimalAgentYaml } from "./agent-bundle.shared.js";
import {
  DEV_TOKEN,
  FAKE_AGENT_VERSION,
  FAKE_WEBHOOK_URL,
  type FakeRunScript,
  type FakeRunScriptHolder,
  fakeFlyioDeps,
  parseSseEvents,
  pushRunnableAgent,
  runFlyio,
  settledRun,
} from "./flyio-run-harness.shared.js";
import { storeVersion } from "./stored-version.shared.js";

// The run route builds its model router once, when the app is built
// (`createApp`), from the process environment. The key cases at the end of this
// file need providers this process holds no server key for — anthropic (the
// harness's agent), google and openai — made certain before any import, so
// before any app is built.
vi.hoisted(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

// The cloud adapter is the one piece replaced — the harness says why and how.
// The logger factory is replaced too, so a test can read what the route logs.
// vi.mock is hoisted above every import, so what its factories read is declared
// with vi.hoisted, and the harness is imported inside the factory, lazily.
const { script, deliverWebhook, log } = vi.hoisted(() => ({
  script: {
    next: { outcome: "error", code: "UNSCRIPTED", message: "no script set" } as FakeRunScript,
  } as FakeRunScriptHolder,
  deliverWebhook: vi.fn(async (_url: string, _payload: object) => {}),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const { makeFakeFlyioAdapterClass } = await import("./flyio-run-harness.shared.js");
  const logger = {
    ...log,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: "info",
    child: () => logger,
  };
  return {
    ...actual,
    FlyioAdapter: makeFakeFlyioAdapterClass(actual, script),
    createLogger: () => logger,
  };
});

// The webhook route imports its delivery when a run ends. Replaced, it sends
// nothing, and its call is the signal that the background run is over.
vi.mock("../utils/webhook.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/webhook.js")>()),
  deliverWebhook,
}));

const RETENTION_S = 60;
const NS = "dev";

const TWO_FILES = [
  { name: "report.txt", content: "hello" },
  { name: "data/table.csv", content: "a,b\n1,2\n" },
];

/** The deadline a run completed at `completedAt` must carry, in the form it is stored in. */
function deadlineFor(completedAt: string | null): string {
  if (completedAt === null) throw new Error("the run has no completion time");
  return new Date(Date.parse(completedAt) + RETENTION_S * 1000).toISOString();
}

/** The timer the case's clock does not replace: what a wait in real time is made of. */
const realSetTimeout = globalThis.setTimeout;

/** Wait in real time — the case's clock untouched — until `done` holds, five seconds at most. */
async function untilReally(done: () => boolean): Promise<void> {
  const giveUpAt = performance.now() + 5_000;
  while (!done()) {
    if (performance.now() > giveUpAt) throw new Error("the condition did not hold within 5 s");
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
  }
}

/**
 * A final write's three attempts, the store refusing each for anything but
 * its data — a lock not granted, a driver's error with no SQLSTATE —, so the
 * same write each time: each attempt awaited in real time, the case's clock
 * then moved on by exactly the wait before the next — one second, then four
 * more.
 */
async function throughTheSpacedAttempts(attempts: () => number): Promise<void> {
  const [second, third] = FINAL_WRITE_RETRY_DELAYS_MS;
  await untilReally(() => attempts() >= 1);
  await vi.advanceTimersByTimeAsync(second);
  await untilReally(() => attempts() >= 2);
  await vi.advanceTimersByTimeAsync(third);
  await untilReally(() => attempts() >= 3);
}

describe("cloud runs through the route — the output purge deadline", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let fetchSpy: MockInstance<typeof fetch>;
  let connectSpy: MockInstance;

  /**
   * Hermetic, checked rather than assumed: no `fetch` (it would also fail the
   * run, loudly) and no socket opened by anything else — an HTTP agent, the
   * webhook's own client, a database driver.
   */
  function expectNoNetwork(): void {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.stubEnv("FILES_RETENTION_S", String(RETENTION_S));
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access in a hermetic test"));
    connectSpy = vi.spyOn(Socket.prototype, "connect");
    deliverWebhook.mockClear();
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
    // One store for bundles and outputs, as in production: one bucket.
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a streamed cloud run with two files gets its deadline in the completion write", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-files");
    script.next = { outcome: "complete", files: TWO_FILES };
    const finishRun = vi.spyOn(db, "finishRun");

    const res = await runFlyio(app, NS, "flyio-sse-files", { mode: "sse" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(["run_start", "run_complete"]);
    const runId = (events[0]?.data as { run_id: string }).run_id;

    const run = await settledRun(db, runId);
    expect(run.status).toBe("completed");
    expect(run.files).toEqual([
      { name: "report.txt", size: 5 },
      { name: "data/table.csv", size: 8 },
    ]);
    // The objects sit where the store keeps a run's outputs.
    expect(await storage.exists(runOutputKey(runId, "report.txt"))).toBe(true);
    expect(await storage.exists(runOutputKey(runId, "data/table.csv"))).toBe(true);
    expectNoNetwork();

    expect(run.purge_after).toBe(deadlineFor(run.completed_at));
    // Written by the completion write itself, the one that carries the files.
    const completion = finishRun.mock.calls.filter(([, patch]) => patch.status === "completed");
    expect(completion).toHaveLength(1);
    expect(completion[0]?.[1]).toMatchObject({ files: run.files, purge_after: run.purge_after });
  });

  it("a streamed run whose completion cannot be recorded — its write throwing at once — is one log line per attempt, never an unhandled rejection", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-completion-throws");
    script.next = { outcome: "complete", files: TWO_FILES };
    // The write itself throws, before it returns anything, with a message that
    // quotes a file name, as an error from a parser or a driver can: each of
    // the final write's attempts is refused so, and each is one line.
    const finishRun = db.finishRun.bind(db);
    let completions = 0;
    vi.spyOn(db, "finishRun").mockImplementation((id, patch, options) => {
      if (patch.status === "completed") {
        completions++;
        throw new TypeError('cannot record "report.txt"');
      }
      return finishRun(id, patch, options);
    });
    // No SQLSTATE says the data was refused: the attempts are spaced, on the case's clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const res = await runFlyio(app, NS, "flyio-sse-completion-throws", { mode: "sse" });
    expect(res.status).toBe(200);
    const body = res.text();
    await throughTheSpacedAttempts(() => completions);
    const events = parseSseEvents(await body);
    // The caller still gets the end of the run.
    expect(events.map((e) => e.event)).toEqual(["run_start", "run_complete"]);
    const runId = (events[0]?.data as { run_id: string }).run_id;

    const writeLines = ["db_update_failed", "run_completion_failed"];
    await vi.waitFor(() =>
      expect(
        log.error.mock.calls
          .map(([fields]) => fields as Record<string, unknown>)
          .filter(
            (fields) =>
              writeLines.includes(String(fields.event)) ||
              String(fields.event).startsWith("run_final_write"),
          ),
      ).toEqual([
        { event: "db_update_failed", run_id: runId, error_name: "TypeError" },
        { event: "db_update_failed", run_id: runId, error_name: "TypeError" },
        { event: "run_final_write_failed", run_id: runId, error_name: "TypeError" },
      ]),
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("report.txt");
    expectNoNetwork();
  });

  it("a webhook cloud run with two files gets its deadline in the completion write", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-webhook-files");
    script.next = { outcome: "complete", files: TWO_FILES };
    const finishRun = vi.spyOn(db, "finishRun");

    const res = await runFlyio(app, NS, "flyio-webhook-files", { mode: "webhook" });
    expect(res.status).toBe(202);
    const { run_id: runId } = (await res.json()) as { run_id: string };
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    expect(deliverWebhook.mock.calls[0]?.[0]).toBe(FAKE_WEBHOOK_URL);
    expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({ run_id: runId, status: "completed" });

    const run = await settledRun(db, runId);
    expect(run.status).toBe("completed");
    expect(run.files).toEqual([
      { name: "report.txt", size: 5 },
      { name: "data/table.csv", size: 8 },
    ]);
    expect(await storage.exists(runOutputKey(runId, "report.txt"))).toBe(true);
    expectNoNetwork();

    expect(run.purge_after).toBe(deadlineFor(run.completed_at));
    const completion = finishRun.mock.calls.filter(([, patch]) => patch.status === "completed");
    expect(completion).toHaveLength(1);
    expect(completion[0]?.[1]).toMatchObject({ files: run.files, purge_after: run.purge_after });
  });

  it("a synchronous request is refused before any run is written: no row, so no final write and no deadline, and no output stored — what the synchronous refusal's own cases hold already, kept beside the deadline", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sync-refused");
    // Never played: the request is refused before any machine is asked for.
    script.next = { outcome: "complete", files: TWO_FILES };
    const finishRun = vi.spyOn(db, "finishRun");

    const res = await runFlyio(app, NS, "flyio-sync-refused", { mode: "sync" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SYNC_MODE_UNSUPPORTED");

    expect(await db.listRuns()).toEqual([]);
    // The write that would carry a deadline is never made, and nothing of a
    // run's outputs reaches the store.
    expect(finishRun).not.toHaveBeenCalled();
    expect(await storage.list(RUN_OUTPUTS_PREFIX)).toEqual([]);
    expectNoNetwork();
  });

  it("a cloud run that fails gets no deadline", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-error");
    script.next = { outcome: "error", code: "MACHINE_SPAWN_FAILED", message: "scripted failure" };

    const res = await runFlyio(app, NS, "flyio-sse-error", { mode: "sse" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(["run_start", "run_error"]);
    const runId = (events[0]?.data as { run_id: string }).run_id;

    const run = await settledRun(db, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("scripted failure");
    expect(run.purge_after).toBeNull();
    expectNoNetwork();
  });

  it("the clean-up a failed cloud run leaves going is handed to the server's stop, and leaves it once over", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-cleanup");
    let finish: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    script.next = {
      outcome: "error",
      code: "MACHINE_SPAWN_FAILED",
      message: "scripted failure",
      cleanup,
    };
    const before = backgroundCleanupCount();

    const res = await runFlyio(app, NS, "flyio-sse-cleanup", { mode: "sse" });
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(["run_start", "run_error"]);

    // The run is over for its caller; its clean-up is what the stop now waits for.
    expect(backgroundCleanupCount()).toBe(before + 1);
    finish();
    await vi.waitFor(() => expect(backgroundCleanupCount()).toBe(before));
    expectNoNetwork();
  });

  it("a cloud run that completes without files gets no deadline", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-no-files");
    script.next = { outcome: "complete", files: [] };

    const res = await runFlyio(app, NS, "flyio-sse-no-files", { mode: "sse" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(["run_start", "run_complete"]);
    const runId = (events[0]?.data as { run_id: string }).run_id;

    const run = await settledRun(db, runId);
    expect(run.status).toBe("completed");
    expect(run.files).toEqual([]);
    expect(run.purge_after).toBeNull();
    expectNoNetwork();
  });

  // A cloud run reads the extracted bundle only before its machine starts:
  // the sandbox fetches its own copy. It holds nothing, from start to end. A
  // synchronous request, refused before its bundle is pulled, extracts nothing
  // at all.
  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("a %s cloud request holds no bundle extraction, from its start to its end — the synchronous one, refused first, never extracts the bundle", async (mode) => {
    const name = `flyio-${mode}-no-hold`;
    await pushRunnableAgent(app, db, NS, name);
    script.next = { outcome: "complete", files: [{ name: "out.txt", content: "x" }] };
    // What this process holds when the run is recorded, after the extraction,
    // and when the scripted run writes its file mid-run.
    const heldMidRun: number[] = [];
    const admitRun = db.admitRun.bind(db);
    vi.spyOn(db, "admitRun").mockImplementation(async (admission) => {
      heldMidRun.push(bundleExtractionsInUse());
      return admitRun(admission);
    });
    const put = storage.put.bind(storage);
    vi.spyOn(storage, "put").mockImplementation(async (key, data) => {
      heldMidRun.push(bundleExtractionsInUse());
      return put(key, data);
    });
    const extractions = bundleCache.size;

    const res = await runFlyio(app, NS, name, { mode });
    expect(res.status).toBe({ sync: 400, sse: 200, webhook: 202 }[mode]);
    await res.text();
    if (mode === "webhook") await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());

    // The synchronous request is refused before the bundle is extracted, the
    // run recorded or any file written.
    expect(bundleCache.size).toBe(extractions + (mode === "sync" ? 0 : 1));
    expect(heldMidRun).toEqual(mode === "sync" ? [] : [0, 0]);
    expect(bundleExtractionsInUse()).toBe(0);
  });

  // What a cloud run reads of its agent's bundle on this process is its three
  // manifests — its instructions, its configuration, its persistent context.
  // Nothing of the bundle is written to this process's disk: no extraction to
  // hold, to date or to remove. And the cache keeps those three texts only.
  it.each([
    "sse",
    "webhook",
  ] as const)("a %s cloud run reads its agent's three manifests, keeps nothing else of the bundle, and writes nothing of it to disk", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "skrun-flyio-manifests-"));
    // `os.tmpdir()` reads these at every call: what the run writes lands here.
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
    try {
      const name = `flyio-${mode}-manifests`;
      const manifests = {
        "agent.yaml": minimalAgentYaml(name),
        "SKILL.md": `# ${name}\n`,
        "AGENTS.md": "# persistent context\n",
      };
      const bytes = await packAgentTar([
        ...Object.entries(manifests).map(([file, text]) => ({
          name: file,
          content: Buffer.from(text),
        })),
        { name: "scripts/run.py", content: Buffer.from("print(1)\n") },
        { name: "assets/blob.bin", content: Buffer.alloc(256 * 1024, 0xff) },
      ]);
      const pushed = await app.request(
        `/api/agents/${NS}/${name}/push?version=${FAKE_AGENT_VERSION}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${DEV_TOKEN}`,
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(bytes),
        },
      );
      expect(pushed.status).toBe(200);
      await db.setVersionVerified(NS, name, FAKE_AGENT_VERSION, true);
      script.next = { outcome: "complete", files: [] };
      const owned = ownedExtractionDirs().length;

      const res = await runFlyio(app, NS, name, { mode });
      expect(res.status).toBe({ sse: 200, webhook: 202 }[mode]);
      await res.text();
      if (mode === "webhook") await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());

      // The run got its manifests…
      expect(script.lastRequest?.agentConfig.name).toBe(name);
      expect(script.lastRequest?.skillContent).toBe(manifests["SKILL.md"]);
      expect(script.lastRequest?.agentsMdContent).toBe(manifests["AGENTS.md"]);
      // …the cache holds them and the configuration read from agent.yaml, and
      // nothing else: no other file, no directory.
      expect(bundleCache.get(createHash("sha256").update(bytes).digest("hex"))).toEqual({
        files: manifests,
        config: { json: JSON.stringify(parseAgentYaml(manifests["agent.yaml"]).config) },
      });
      // Nothing on disk, nothing owned, nothing for the orphan pass to remove,
      // however late it passes.
      expect(readdirSync(root).filter((entry) => entry.startsWith(BUNDLE_DIR_PREFIX))).toEqual([]);
      expect(ownedExtractionDirs()).toHaveLength(owned);
      const farFuture = Date.now() + 30 * 86_400_000;
      expect(await removeOrphanedFiles(root, farFuture, new Set())).toMatchObject({
        bundleDirs: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The cloud runtime serves a run through its event stream or a webhook, never
// as one response: a synchronous request is refused by name, by what the
// request says alone — before its agent is read, its bundle pulled, its row
// written or its seat taken.
describe("cloud runs through the route — a synchronous request, refused by name right after its body's shape", () => {
  const SYNC_REFUSAL =
    "This server's runtime does not run an agent synchronously: read the run's event stream instead — an HTTP request with the 'Accept: text/event-stream' header, skrun run, or the SDK's client.run() (both return the one-shot result) — or send a webhook_url to receive the result when the run ends.";
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    deliverWebhook.mockClear();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spies on every step a refused request must never reach — set once the agent is published. */
  function stepsAfterTheBody() {
    return {
      agentReads: vi.spyOn(db, "getAgent"),
      pulls: vi.spyOn(storage, "get"),
      admissions: vi.spyOn(db, "admitRun"),
      execute: vi.spyOn(FlyioAdapter.prototype, "execute"),
      executeStream: vi.spyOn(FlyioAdapter.prototype, "executeStream"),
    };
  }

  /**
   * `POST /run` with this body and the caller's model key; a stream header only
   * when asked; `headers` set last, over the others.
   */
  function post(
    name: string,
    body: Record<string, unknown>,
    stream = false,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.request(`/api/agents/${NS}/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
        ...(stream && { Accept: "text/event-stream" }),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  /** Everything the refusal is judged on, in one value, so a red shows all of it at once. */
  async function observe(res: Response, steps: ReturnType<typeof stepsAfterTheBody>) {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return {
      status: res.status,
      code: body.error?.code,
      message: body.error?.message,
      agentReads: steps.agentReads.mock.calls.length,
      pulls: steps.pulls.mock.calls.length,
      admissions: steps.admissions.mock.calls.length,
      adapterCalls: steps.execute.mock.calls.length + steps.executeStream.mock.calls.length,
      runs: (await db.listRuns()).map((run) => run.status),
    };
  }

  const REFUSED = {
    status: 400,
    code: "SYNC_MODE_UNSUPPORTED",
    message: SYNC_REFUSAL,
    agentReads: 0,
    pulls: 0,
    admissions: 0,
    adapterCalls: 0,
    runs: [],
  };

  it.each([
    ["with neither a stream header nor a webhook_url", {}, {}],
    // The mode is read as the route reads it: an empty webhook_url is no webhook.
    ["with an empty webhook_url", { webhook_url: "" }, {}],
    // The refusal comes before any model key header is read: a malformed one
    // is never what answers.
    [
      "whose X-LLM-API-Key header is not JSON, never INVALID_LLM_KEY_HEADER,",
      {},
      { "X-LLM-API-Key": "not json" },
    ],
    [
      "whose X-LLM-Base-URL header is not JSON, never INVALID_LLM_BASE_URL_HEADER,",
      {},
      { "X-LLM-Base-URL": "nope" },
    ],
  ] as const)("a request %s is refused 400 SYNC_MODE_UNSUPPORTED, naming what works — before the agent is read, the bundle pulled or the run admitted: no run row, no seat, no machine", async (_case, extra, headers) => {
    await pushRunnableAgent(app, db, NS, "flyio-sync-named");
    script.next = { outcome: "complete", files: [] };
    const steps = stepsAfterTheBody();

    const seen = await observe(
      await post("flyio-sync-named", { input: { q: "hello" }, ...extra }, false, headers),
      steps,
    );

    expect(seen).toEqual(REFUSED);
  });

  it("a synchronous request for an agent that does not exist gets the same refusal, never a 404 — the agent is not even read", async () => {
    const steps = stepsAfterTheBody();

    const seen = await observe(await post("flyio-sync-absent", { input: { q: "hello" } }), steps);

    expect(seen).toEqual(REFUSED);
  });

  it("a synchronous request whose body has no input is refused for its body first: 400 INVALID_REQUEST, never SYNC_MODE_UNSUPPORTED — nothing read, nothing written", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sync-no-input");
    script.next = { outcome: "complete", files: [] };
    const steps = stepsAfterTheBody();

    const seen = await observe(await post("flyio-sync-no-input", { q: "hello" }), steps);

    expect(seen).toEqual({
      ...REFUSED,
      code: "INVALID_REQUEST",
      message:
        'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.',
    });
  });

  it("the same request reading the event stream runs: 200, to its end", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sync-then-stream");
    script.next = { outcome: "complete", files: [] };

    const res = await post("flyio-sync-then-stream", { input: { q: "hello" } }, true);

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text()).map((e) => e.event);
    expect(events).toEqual(["run_start", "run_complete"]);
    const runs = await db.listRuns();
    expect(runs).toHaveLength(1);
    expect((await settledRun(db, runs[0]?.id ?? "")).status).toBe("completed");
  });

  it("the same request with a webhook_url runs: 202, the result delivered when the run ends", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sync-then-webhook");
    script.next = { outcome: "complete", files: [] };

    const res = await post("flyio-sync-then-webhook", {
      input: { q: "hello" },
      webhook_url: FAKE_WEBHOOK_URL,
    });

    expect(res.status).toBe(202);
    const { run_id: runId } = (await res.json()) as { run_id: string };
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({ run_id: runId, status: "completed" });
  });
});

// An adapter is built for each run: the budget its uploads reserve on comes from
// the cloud dependencies, built once for the process.
describe("cloud runs through the route — the output bytes budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands each run's adapter the budget its dependencies carry", async () => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const deps = fakeFlyioDeps(storage);
    const app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: deps });
    await pushRunnableAgent(app, db, NS, "flyio-bytes-budget");
    script.next = { outcome: "complete", files: [] };
    script.adapterOptions = undefined;

    const res = await runFlyio(app, NS, "flyio-bytes-budget", { mode: "sse" });
    expect(res.status).toBe(200);
    await res.text();

    expect(script.adapterOptions?.outputsBudget).toBeDefined();
    expect(script.adapterOptions?.outputsBudget).toBe(deps.outputsBudget);
  });
});

// A run's seat is held past its timeout by a margin that covers its machine's
// acquisition — and the adapter is held to the very budget the margin covers:
// one value, derived once from how many creations the process may be asked for
// at once (the instance cap, plus one while a pool refills; else the platform's
// burst), never a number copied. A pool counts only while it runs: one handed in
// but not enabled is no pool — no creation added for it, and no run admitted
// with a right to a pooled machine.
describe("cloud runs through the route — the acquisition budget, the seat's margin and the right to a pooled machine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const CAP_20 = { SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20" };
  it.each([
    [
      "an instance cap of twenty and a pool running: twenty-one creations at once, the run entitled to a pooled machine",
      CAP_20,
      "running",
      21,
    ],
    [
      "an instance cap of twenty and no pool: twenty creations at once, no right to a pooled machine",
      CAP_20,
      "none",
      20,
    ],
    [
      "an instance cap of twenty and a pool that is not enabled: twenty creations at once, no right to a pooled machine",
      CAP_20,
      "disabled",
      20,
    ],
    [
      "no cap and no pool: the platform's burst, no right to a pooled machine",
      {},
      "none",
      FLY_APP_ACTION_BURST,
    ],
    [
      "no cap and a pool running: the platform's burst, the run entitled to a pooled machine",
      {},
      "running",
      FLY_APP_ACTION_BURST,
    ],
  ] as const)("%s", async (_label, env, poolState, creations) => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const pool = {
      enabled: poolState === "running",
      start: () => undefined,
    } as unknown as RunnerPool;
    const app = createApp(storage, db, {
      runtimeMode: "flyio",
      flyioDeps: { ...fakeFlyioDeps(storage), ...(poolState !== "none" && { pool }) },
      quotaConfig: parseQuotaEnv(env),
    });
    const name = `flyio-seat-margin-${creations}-${poolState}`;
    await pushRunnableAgent(app, db, NS, name);
    script.next = { outcome: "complete", files: [] };
    script.adapterOptions = undefined;
    const at = Date.parse("2026-10-16T13:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);

    const res = await runFlyio(app, NS, name, { mode: "sse" });
    expect(res.status).toBe(200);
    await res.text();

    const budget = acquisitionBudgetMs({ concurrentCreates: creations });
    expect(script.adapterOptions?.acquisitionBudgetMs).toBe(budget);
    const [row] = await db.listRuns();
    // The agent declares no timeout: 300 s, the default.
    expect(row?.created_at).toBe(new Date(at).toISOString());
    expect(row?.deadline_at).toBe(
      new Date(at + 300_000 + seatDeadlineMarginMs({ concurrentCreates: creations })).toISOString(),
    );
    expect(Date.parse(String(row?.deadline_at)) - at).toBeGreaterThanOrEqual(300_000 + budget);
    expect(row?.pool_entitled).toBe(poolState === "running");
  });
});

// A run's machine lives as long as its seat is held, plus a grace: the route
// hands the adapter the hold its admission wrote — the same value, never a
// copy — and the adapter writes the machine's lifetime from it. A timeout no
// timer can hold is held, and lives, as long as the longest timer: a date, and
// a finite number of seconds.
describe("cloud runs through the route — the hold of a run's seat reaches its machine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * A verified agent that declares `timeout` — or, with none, pushed. One that
   * declares a timeout is written to storage directly: the cases below declare
   * one outside the range agent.yaml accepts, as a version published before
   * that range was can.
   */
  async function storeAgentWithTimeout(
    app: ReturnType<typeof createApp>,
    storage: MemoryStorage,
    db: MemoryDb,
    name: string,
    timeout: string | undefined,
  ): Promise<void> {
    if (timeout === undefined) return pushRunnableAgent(app, db, NS, name);
    const agentYaml = [
      `name: ${name}`,
      `version: ${FAKE_AGENT_VERSION}`,
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-6",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      `  timeout: "${timeout}"`,
    ].join("\n");
    await storeVersion({
      app,
      storage,
      db,
      token: DEV_TOKEN,
      namespace: NS,
      name,
      version: FAKE_AGENT_VERSION,
      agentYaml,
      verified: true,
    });
  }

  // The lifetime, derived by hand: the hold — the timeout, capped at the longest
  // timer, plus the seat's margin (633 s for the platform's burst of three
  // creations, 650 s for twenty) — plus the 300 s grace, in seconds rounded up.
  //   300 s + 633 s + 300 s = 1 233 s
  //   300 s + 650 s + 300 s = 1 250 s
  //   2 147 483 647 ms + 633 000 ms + 300 000 ms = 2 148 416 647 ms → 2 148 417 s
  it.each([
    [
      "an agent that declares no timeout: 300 s and the margin of the platform's burst",
      undefined,
      {},
      300_000,
      FLY_APP_ACTION_BURST,
      1_233,
    ],
    [
      "an instance cap of twenty: 300 s and the margin of twenty creations at once",
      undefined,
      { SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS: "20" },
      300_000,
      20,
      1_250,
    ],
    [
      "an agent whose timeout no timer can hold: held as long as the longest timer, and the margin",
      "9999999999999s",
      {},
      MAX_TIMER_DELAY_MS,
      FLY_APP_ACTION_BURST,
      2_148_417,
    ],
  ] as const)("%s", async (_label, timeout, env, heldTimeoutMs, creations, expectedLifetimeS) => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const app = createApp(storage, db, {
      runtimeMode: "flyio",
      flyioDeps: fakeFlyioDeps(storage),
      quotaConfig: parseQuotaEnv(env),
    });
    const name = `flyio-seat-hold-${creations}-${timeout === undefined ? "default" : "long"}`;
    await storeAgentWithTimeout(app, storage, db, name, timeout);
    script.next = { outcome: "complete", files: [] };
    script.adapterOptions = undefined;
    const at = Date.parse("2026-10-22T13:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);

    const res = await runFlyio(app, NS, name, { mode: "sse" });
    expect(res.status).toBe(200);
    await res.text();

    const [row] = await db.listRuns();
    const held = Date.parse(String(row?.deadline_at)) - Date.parse(String(row?.created_at));
    expect(held).toBe(heldTimeoutMs + seatDeadlineMarginMs({ concurrentCreates: creations }));
    expect(script.adapterOptions?.seatHoldMs).toBe(held);
    // The lifetime the adapter writes from it: the hold and the grace, in whole
    // seconds rounded up — a finite number, derived by hand above.
    const lifetimeS = machineLifetimeSeconds({ seatHoldMs: held });
    expect(lifetimeS).toBe(expectedLifetimeS);
    expect(Number.isSafeInteger(lifetimeS)).toBe(true);
  });
});

// The admission decides whether a run may take a pooled machine, and the route
// hands that decision to the engine — only while a pool runs: without one, no
// run has the right and the engine is told nothing. While one runs, a master
// credential is told the account's fast runs of the hour and what is left of
// them, and a run sent to the cold path for want of one is one line.
describe("cloud runs through the route — the admission's decision on the pool reaches the engine", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    log.info.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function appWith(
    env: Record<string, string>,
    poolRunning: boolean,
  ): ReturnType<typeof createApp> {
    storage = new MemoryStorage();
    db = new MemoryDb();
    const pool = { enabled: true, start: () => undefined } as unknown as RunnerPool;
    return createApp(storage, db, {
      runtimeMode: "flyio",
      flyioDeps: { ...fakeFlyioDeps(storage), ...(poolRunning && { pool }) },
      quotaConfig: parseQuotaEnv(env),
    });
  }

  /** The fast-run headers of a response; `null` for one it does not carry. */
  function fastHeaders(res: Response): { limit: string | null; remaining: string | null } {
    return {
      limit: res.headers.get("X-Quota-Fast-Runs-Limit"),
      remaining: res.headers.get("X-Quota-Fast-Runs-Remaining"),
    };
  }

  /** The `run_cold_by_quota` lines the route wrote. */
  function coldLines(): Array<Record<string, unknown>> {
    return log.info.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "run_cold_by_quota");
  }

  /**
   * One streamed run (the cloud engine's response shape), read to its end;
   * what the engine was handed, the row once settled, and what the caller was
   * told at the stream's opening.
   */
  async function runOnce(app: ReturnType<typeof createApp>, name: string) {
    script.next = { outcome: "complete", files: [] };
    script.lastRequest = undefined;
    const res = await runFlyio(app, NS, name, { mode: "sse" });
    expect(res.status).toBe(200);
    await res.text();
    const request = script.lastRequest as RunRequest | undefined;
    const row = await settledRun(db, request?.runId ?? "");
    return { request, row, headers: fastHeaders(res) };
  }

  it("a pool running and two fast runs an hour: the first two runs have the right, the third takes the cold path — told to the engine, in its row, in the headers and in one line", async () => {
    const app = appWith({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" }, true);
    await pushRunnableAgent(app, db, NS, "flyio-fast-runs");

    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await runOnce(app, "flyio-fast-runs"));

    expect(
      runs.map(({ request, row, headers }) => ({
        eligible: request?.poolEligible,
        entitled: row?.pool_entitled,
        ...headers,
      })),
    ).toEqual([
      { eligible: true, entitled: true, limit: "2", remaining: "1" },
      { eligible: true, entitled: true, limit: "2", remaining: "0" },
      { eligible: false, entitled: false, limit: "2", remaining: "0" },
    ]);
    const cold = coldLines();
    expect(cold).toHaveLength(1);
    expect(cold[0]).toMatchObject({ run_id: runs[2]?.request?.runId, plan: "free" });
  });

  it("no pool, the same variable set: no right given, the engine told nothing, no fast-run header, no line", async () => {
    const app = appWith({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" }, false);
    await pushRunnableAgent(app, db, NS, "flyio-fast-runs-no-pool");

    const { request, row, headers } = await runOnce(app, "flyio-fast-runs-no-pool");

    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("poolEligible");
    expect(row?.pool_entitled).toBe(false);
    expect(headers).toEqual({ limit: null, remaining: null });
    expect(coldLines()).toEqual([]);
  });

  it("a pool running and no fast-run variable: every run has the right, and no fast-run header is sent", async () => {
    const app = appWith({}, true);
    await pushRunnableAgent(app, db, NS, "flyio-fast-runs-unbounded");

    const { request, row, headers } = await runOnce(app, "flyio-fast-runs-unbounded");

    expect(request?.poolEligible).toBe(true);
    expect(row?.pool_entitled).toBe(true);
    expect(headers).toEqual({ limit: null, remaining: null });
    expect(coldLines()).toEqual([]);
  });

  it("a pool running and a plan that includes no fast run: the run takes the cold path, told the limit and no remaining count", async () => {
    const app = appWith({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "0" }, true);
    await pushRunnableAgent(app, db, NS, "flyio-fast-runs-none");

    const { request, row, headers } = await runOnce(app, "flyio-fast-runs-none");

    expect(request?.poolEligible).toBe(false);
    expect(row?.pool_entitled).toBe(false);
    expect(headers).toEqual({ limit: "0", remaining: null });
    expect(coldLines()).toHaveLength(1);
  });

  it("a run refused at the pre-check is told the fast runs left too — the run in flight counted, nothing consumed by the refused one", async () => {
    const app = appWith(
      { SKRUN_QUOTA_CONCURRENT_RUNS: "1", SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" },
      true,
    );
    await pushRunnableAgent(app, db, NS, "flyio-fast-runs-refused");
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    script.next = { outcome: "complete", files: [], held };
    const first = await runFlyio(app, NS, "flyio-fast-runs-refused", { mode: "sse" });
    // The run in flight ends whatever the assertions find: one left held would
    // hold its seat, and the server's stop of a later case would wait on it.
    try {
      expect(first.status).toBe(200);
      expect(fastHeaders(first)).toEqual({ limit: "2", remaining: "1" });

      const refused = await runFlyio(app, NS, "flyio-fast-runs-refused", { mode: "sse" });
      expect(refused.status).toBe(429);
      expect(refused.headers.get("X-Quota-Runs-Remaining")).toBe("0");
      expect(fastHeaders(refused)).toEqual({ limit: "2", remaining: "1" });
    } finally {
      open();
      await first.text();
    }
    expect(coldLines()).toEqual([]);
  });
});

// A run that had the right to a pooled machine gives it back once its machine
// is ready, if that machine did not come from the pool and no pooled machine
// was taken for it — read by the route on the engine's runner_spawned, before
// the caller can read that event. A run a pooled machine served keeps it, as
// does one for which a pooled machine was taken and lost; a run whose machine
// never got ready keeps it spent. A write that fails is one line, and the run
// goes on.
describe("cloud runs through the route — a fast run given back when no pooled machine was taken for the run", () => {
  const MODES = ["sse", "webhook"] as const;
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  /** A stop a case began, awaited before the next case. */
  let stopping: Promise<unknown> | undefined;

  beforeEach(() => {
    deliverWebhook.mockClear();
    log.error.mockClear();
    stopping = undefined;
  });

  afterEach(async () => {
    // A stop lasts for the process: the next case gets a server that runs.
    if (stopping) await stopping;
    _resetShutdownForTests();
    vi.restoreAllMocks();
  });

  /** An app on a fresh store, two fast runs an hour; a pool running unless told otherwise. */
  function appWith(poolRunning = true): void {
    storage = new MemoryStorage();
    db = new MemoryDb();
    const pool = { enabled: true, start: () => undefined } as unknown as RunnerPool;
    app = createApp(storage, db, {
      runtimeMode: "flyio",
      flyioDeps: { ...fakeFlyioDeps(storage), ...(poolRunning && { pool }) },
      quotaConfig: parseQuotaEnv({ SKRUN_QUOTA_FAST_RUNS_PER_HOUR: "2" }),
    });
  }

  /** `returnPoolRight` spied on, each call noted in `journal` and still reaching the store. */
  function spyGiveBack(journal: string[] = []) {
    const original = db.returnPoolRight.bind(db);
    return vi.spyOn(db, "returnPoolRight").mockImplementation((id) => {
      journal.push("give back");
      return original(id);
    });
  }

  /**
   * One run in `mode`, to its end — for a webhook run, the end of its
   * background task, its delivery made or its error logged: its id, its row
   * once settled, the events its caller read (a stream only), and the fast
   * runs left its caller was told.
   */
  async function runToEnd(name: string, mode: "sse" | "webhook", next: FakeRunScript) {
    script.next = next;
    script.lastRequest = undefined;
    const delivered = deliverWebhook.mock.calls.length;
    const res = await runFlyio(app, NS, name, { mode });
    expect(res.status).toBe(mode === "sse" ? 200 : 202);
    const body = await res.text();
    const events = mode === "sse" ? parseSseEvents(body) : [];
    if (mode === "webhook") {
      await vi.waitFor(() =>
        expect(
          deliverWebhook.mock.calls.length > delivered ||
            log.error.mock.calls.some(
              ([fields]) => (fields as { event?: string })?.event === "webhook_bg_error",
            ),
        ).toBe(true),
      );
    }
    const runId = script.lastRequest?.runId as string;
    const row = await settledRun(db, runId);
    return { runId, row, events, told: res.headers.get("X-Quota-Fast-Runs-Remaining") };
  }

  /** The fast runs the account has left now, read where its owner reads them. */
  async function fastRunsLeft(): Promise<unknown> {
    const res = await app.request("/api/usage", {
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quotas: { fast_runs: { remaining: number | null } | null } | null;
    };
    return body.quotas?.fast_runs?.remaining;
  }

  /** The `pool_right_return_failed` lines the route wrote. */
  function giveBackFailures(): Array<Record<string, unknown>> {
    return log.error.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "pool_right_return_failed");
  }

  /** The last payload a webhook run delivered. */
  function lastDelivery(): Record<string, unknown> | undefined {
    return deliverWebhook.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
  }

  it.each(
    MODES,
  )("%s: a run a pooled machine served keeps its right — and so does one whose pooled machine cold-booted instead of resuming", async (mode) => {
    appWith();
    const name = `give-back-served-${mode}`;
    await pushRunnableAgent(app, db, NS, name);
    const giveBack = spyGiveBack();

    const served = await runToEnd(name, mode, {
      outcome: "complete",
      files: [],
      spawned: { poolHit: true },
    });
    const servedDelivery = lastDelivery();
    const coldBooted = await runToEnd(name, mode, {
      outcome: "complete",
      files: [],
      spawned: { poolHit: true, resumedFromSnapshot: false },
    });

    // Both reached their machine: completed, and the engine's telemetry,
    // written after runner_spawned, on the row with the pool's indicators.
    expect([served.row.status, coldBooted.row.status]).toEqual(["completed", "completed"]);
    expect(served.row.phase_timings).toMatchObject({ pool_hit: true });
    expect(coldBooted.row.phase_timings).toMatchObject({
      pool_hit: true,
      pool_resumed_from_snapshot: false,
    });
    if (mode === "webhook") {
      expect(servedDelivery).toMatchObject({ run_id: served.runId, status: "completed" });
      expect(lastDelivery()).toMatchObject({ run_id: coldBooted.runId, status: "completed" });
    }
    expect([served.row.pool_entitled, coldBooted.row.pool_entitled]).toEqual([true, true]);
    expect(giveBack).not.toHaveBeenCalled();
    expect(await fastRunsLeft()).toBe(0);
  });

  it.each(
    MODES,
  )("%s: a run for which no pooled machine was taken — the pool empty, or only a stale machine discarded before any claim — gives its right back: its row loses it, the usage tells one more fast run left, and the header its caller was told stays the admission's", async (mode) => {
    appWith();
    const name = `give-back-cold-${mode}`;
    await pushRunnableAgent(app, db, NS, name);

    const run = await runToEnd(name, mode, { outcome: "complete", files: [], spawned: {} });

    expect(run.row.status).toBe("completed");
    expect(run.row.pool_entitled).toBe(false);
    // Told at the admission, its own right counted: a header that has left is not corrected.
    expect(run.told).toBe("1");
    expect(await fastRunsLeft()).toBe(2);
    if (mode === "sse") {
      expect(run.events.map((e) => e.event)).toEqual([
        "run_start",
        "runner_spawned",
        "run_complete",
      ]);
    }
  });

  it.each(
    MODES,
  )("%s: a run for which a pooled machine was taken, then lost to a failed handoff, keeps its right — whatever machine it then got", async (mode) => {
    appWith();
    const name = `give-back-lost-${mode}`;
    await pushRunnableAgent(app, db, NS, name);
    const giveBack = spyGiveBack();

    const run = await runToEnd(name, mode, {
      outcome: "complete",
      files: [],
      spawned: { poolHandoffsFailed: 1 },
    });

    expect(run.row.status).toBe("completed");
    expect(run.row.pool_entitled).toBe(true);
    expect(giveBack).not.toHaveBeenCalled();
    expect(await fastRunsLeft()).toBe(1);
  });

  // A run hands its agent to one pooled machine at most: one lost after its
  // handoff sends the run to a machine of its own, and that run is told one
  // machine lost — never a pool hit with it — and keeps its right.
  it.each(
    MODES,
  )("%s: a run whose pooled machine was lost after its handoff, then started on a machine of its own, keeps its right — told one machine lost, never a pool hit", async (mode) => {
    appWith();
    const name = `give-back-one-lost-${mode}`;
    await pushRunnableAgent(app, db, NS, name);
    const giveBack = spyGiveBack();

    const run = await runToEnd(name, mode, {
      outcome: "complete",
      files: [],
      spawned: { poolHandoffsFailed: 1 },
    });

    expect(run.row.status).toBe("completed");
    expect(run.row.phase_timings).toMatchObject({ pool_handoffs_failed: 1 });
    expect(run.row.phase_timings).not.toHaveProperty("pool_hit");
    if (mode === "sse") {
      const spawned = run.events.find((e) => e.event === "runner_spawned");
      expect(spawned?.data).toMatchObject({ phases: { pool_handoffs_failed: 1 } });
      expect((spawned?.data as { phases: object }).phases).not.toHaveProperty("pool_hit");
    }
    expect(run.row.pool_entitled).toBe(true);
    expect(giveBack).not.toHaveBeenCalled();
    expect(await fastRunsLeft()).toBe(1);
  });

  // A pooled machine whose /init failed for the run's own fault ends the run
  // there: discarded already, nothing created, its machine never ready.
  it.each(
    MODES,
  )("%s: a run whose pooled machine's /init failed for its own fault fails with no machine ready and keeps its right spent — no runner_spawned, nothing left to destroy", async (mode) => {
    appWith();
    const name = `give-back-own-fault-${mode}`;
    await pushRunnableAgent(app, db, NS, name);
    const giveBack = spyGiveBack();
    script.destroyed = [];

    const run = await runToEnd(name, mode, {
      outcome: "spawn-failed",
      phase: "init-rpc",
      machineName: "pooled-own-fault",
      httpStatus: 500,
      stage: "bundle-checksum",
    });

    expect(run.row.status).toBe("failed");
    expect(run.row.error).toContain('step "bundle-checksum"');
    if (mode === "sse") {
      expect(run.events.map((e) => e.event)).toEqual(["run_start", "run_error"]);
    }
    expect(script.destroyed).toEqual([]);
    expect(run.row.pool_entitled).toBe(true);
    expect(giveBack).not.toHaveBeenCalled();
    expect(await fastRunsLeft()).toBe(1);
  });

  it("a run whose machine was never created keeps its right spent", async () => {
    appWith();
    await pushRunnableAgent(app, db, NS, "give-back-create-failed");
    const giveBack = spyGiveBack();

    const run = await runToEnd("give-back-create-failed", "sse", {
      outcome: "spawn-failed",
      phase: "create",
    });

    expect(run.row.status).toBe("failed");
    expect(run.row.pool_entitled).toBe(true);
    expect(giveBack).not.toHaveBeenCalled();
    expect(await fastRunsLeft()).toBe(1);
  });

  it("a run whose caller hangs up while its machine is acquired keeps its right spent", async () => {
    appWith();
    await pushRunnableAgent(app, db, NS, "give-back-hangup");
    const giveBack = spyGiveBack();
    script.lastRequest = undefined;
    script.next = { outcome: "spawn-failed", phase: "create", untilAborted: true };
    const caller = new AbortController();

    const res = await app.request(`/api/agents/${NS}/give-back-hangup/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
      },
      body: JSON.stringify({ input: { q: "hello" } }),
      signal: caller.signal,
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(script.lastRequest).toBeDefined());
    caller.abort();
    await res.body?.cancel().catch(() => undefined);

    const row = await settledRun(db, script.lastRequest?.runId as string);
    expect(row.status).toBe("failed");
    expect(row.pool_entitled).toBe(true);
    expect(giveBack).not.toHaveBeenCalled();
  });

  it("a run the server's stop ends while its machine is acquired keeps its right spent, on the stop's path", async () => {
    appWith();
    await pushRunnableAgent(app, db, NS, "give-back-stop");
    const giveBack = spyGiveBack();
    script.lastRequest = undefined;
    script.next = {
      outcome: "spawn-failed",
      phase: "init-rpc",
      machineId: "m-give-back-stop",
      untilAborted: true,
    };
    const res = await runFlyio(app, NS, "give-back-stop", { mode: "sse" });
    expect(res.status).toBe(200);
    const body = res.text();
    await vi.waitFor(() => expect(script.lastRequest).toBeDefined());

    stopping = shutdownInFlightRuns({ drainMs: 5_000, graceMs: 10_000 });
    await body;
    await stopping;

    const row = await settledRun(db, script.lastRequest?.runId as string);
    expect(row).toMatchObject({ status: "failed", error: SHUTDOWN_RUN_ERROR, pool_entitled: true });
    expect(giveBack).not.toHaveBeenCalled();
  });

  it("a run without the right — the third of the hour — gives nothing back when its machine is ready", async () => {
    appWith();
    await pushRunnableAgent(app, db, NS, "give-back-third");
    const giveBack = spyGiveBack();
    // The first two keep their rights: no machine announced, nothing given back.
    await runToEnd("give-back-third", "sse", { outcome: "complete", files: [] });
    await runToEnd("give-back-third", "sse", { outcome: "complete", files: [] });

    const third = await runToEnd("give-back-third", "sse", {
      outcome: "complete",
      files: [],
      spawned: {},
    });

    // It reached its machine: completed, its runner_spawned read, and the
    // engine's telemetry, written after the event, on the row.
    expect(third.row.status).toBe("completed");
    expect(third.events.map((e) => e.event)).toEqual([
      "run_start",
      "runner_spawned",
      "run_complete",
    ]);
    expect(third.row.phase_timings).toMatchObject({ create_api_ms: 1 });
    expect(third.told).toBe("0");
    expect(third.row.pool_entitled).toBe(false);
    expect(giveBack).not.toHaveBeenCalled();
  });

  it("with no pool, a run gives nothing back when its machine is ready", async () => {
    appWith(false);
    await pushRunnableAgent(app, db, NS, "give-back-no-pool");
    const giveBack = spyGiveBack();

    const run = await runToEnd("give-back-no-pool", "sse", {
      outcome: "complete",
      files: [],
      spawned: {},
    });

    expect(run.row.status).toBe("completed");
    expect(run.row.pool_entitled).toBe(false);
    expect(giveBack).not.toHaveBeenCalled();
  });

  it.each(
    MODES,
  )("%s: a give-back the store rejects is one line — the run completes, its right stays spent, nothing unhandled", async (mode) => {
    appWith();
    const name = `give-back-rejected-${mode}`;
    await pushRunnableAgent(app, db, NS, name);
    // A plain function on the instance, not a spy: a spy handles the promise
    // it returns itself (to note how it settled), which would hide a rejection
    // the route leaves unhandled.
    Object.assign(db, {
      returnPoolRight: () => Promise.reject(new Error("the store is gone")),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = await runToEnd(name, mode, { outcome: "complete", files: [], spawned: {} });
      // Real: lets an unhandled rejection, if any, be reported.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(run.row.status).toBe("completed");
      expect(run.row.pool_entitled).toBe(true);
      expect(giveBackFailures()).toEqual([
        { event: "pool_right_return_failed", run_id: run.runId, error_name: "Error" },
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each([
    ["sse", "a give-back that throws at once"],
    ["sse", "a store without the method"],
    ["webhook", "a give-back that throws at once"],
    ["webhook", "a store without the method"],
  ] as const)("%s, %s: the same line — the run completes, its right stays spent, and the engine goes on past the event", async (mode, store) => {
    appWith();
    const name = `give-back-throws-${mode}-${store === "a store without the method" ? "missing" : "spy"}`;
    await pushRunnableAgent(app, db, NS, name);
    if (store === "a store without the method") {
      // A store written in JavaScript, without the method: masked on the
      // instance — a delete would leave the class's own.
      Object.assign(db, { returnPoolRight: undefined });
    } else {
      vi.spyOn(db, "returnPoolRight").mockImplementation(() => {
        throw new TypeError("the store cannot give it back");
      });
    }

    const run = await runToEnd(name, mode, { outcome: "complete", files: [], spawned: {} });

    expect(run.row.status).toBe("completed");
    expect(giveBackFailures()).toEqual([
      { event: "pool_right_return_failed", run_id: run.runId, error_name: "TypeError" },
    ]);
    expect(run.row.pool_entitled).toBe(true);
    // The engine resumed past its runner_spawned: its telemetry, written after
    // the event, is on the row; then its run_complete.
    expect(run.row.phase_timings).toMatchObject({ create_api_ms: 1 });
    if (mode === "sse") {
      expect(run.events.map((e) => e.event)).toEqual([
        "run_start",
        "runner_spawned",
        "run_complete",
      ]);
    } else {
      expect(lastDelivery()).toMatchObject({ run_id: run.runId, status: "completed" });
    }
  });

  // An engine that announces its machine without the phases — one written in
  // JavaScript, say — gives nothing to judge the right by: it stays spent,
  // and reading the missing phases throws nothing into the envelope, where
  // the engine is suspended at that event.
  it.each(
    MODES,
  )("%s: a runner_spawned without its phases is the same line — the run completes, its right stays spent, and the engine goes on past the event", async (mode) => {
    appWith();
    const name = `give-back-no-phases-${mode}`;
    await pushRunnableAgent(app, db, NS, name);
    const giveBack = spyGiveBack();
    const play = FlyioAdapter.prototype.executeStream;
    vi.spyOn(FlyioAdapter.prototype, "executeStream").mockImplementation(async function* (
      this: FlyioAdapter,
      request: RunRequest,
    ) {
      for await (const event of play.call(this, request)) {
        yield event.type === "runner_spawned"
          ? ({ ...event, phases: undefined } as unknown as RunEvent)
          : event;
      }
    });

    const run = await runToEnd(name, mode, { outcome: "complete", files: [], spawned: {} });

    expect(run.row.status).toBe("completed");
    expect(giveBackFailures()).toEqual([
      { event: "pool_right_return_failed", run_id: run.runId, error_name: "TypeError" },
    ]);
    expect(giveBack).not.toHaveBeenCalled();
    expect(run.row.pool_entitled).toBe(true);
    // The engine resumed past its runner_spawned: its telemetry, written after
    // the event, is on the row; then its run_complete.
    expect(run.row.phase_timings).toMatchObject({ create_api_ms: 1 });
    if (mode === "sse") {
      expect(run.events.map((e) => e.event)).toEqual([
        "run_start",
        "runner_spawned",
        "run_complete",
      ]);
    } else {
      expect(lastDelivery()).toMatchObject({ run_id: run.runId, status: "completed" });
    }
  });

  // The order is the give-back's call, not its write's effect: this store, in
  // memory, writes when called, so its row has lost the right by the time the
  // event arrives. A store whose write is still in flight then — Postgres —
  // may lose it after.
  it("sse: the give-back is called before the caller can read runner_spawned — on a store that writes when called, the row already without it when the event arrives", async () => {
    appWith();
    await pushRunnableAgent(app, db, NS, "give-back-order-sse");
    const journal: string[] = [];
    spyGiveBack(journal);
    const writeSSE = SSEStreamingApi.prototype.writeSSE;
    vi.spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(function (
      this: SSEStreamingApi,
      message,
    ) {
      journal.push(`write ${message.event}`);
      return writeSSE.call(this, message);
    });
    const updateRun = db.updateRun.bind(db);
    vi.spyOn(db, "updateRun").mockImplementation((id, patch) => {
      if ("phase_timings" in patch) journal.push("telemetry");
      return updateRun(id, patch);
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    script.lastRequest = undefined;
    script.next = { outcome: "complete", files: [], spawned: {}, held };

    const res = await runFlyio(app, NS, "give-back-order-sse", { mode: "sse" });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes("event: runner_spawned")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the stream ended before runner_spawned");
        text += decoder.decode(value, { stream: true });
      }
      // The caller has the event: its run's row, in this store, has already lost its right.
      const row = await db.getRun(script.lastRequest?.runId as string);
      expect(row?.pool_entitled).toBe(false);
    } finally {
      release();
    }
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      text += decoder.decode(next.value, { stream: true });
    }

    expect(journal).toEqual([
      "write run_start",
      "give back",
      "write runner_spawned",
      "telemetry",
      "write run_complete",
    ]);
  });

  it("webhook: the give-back is called before the engine resumes past runner_spawned — before its telemetry", async () => {
    appWith();
    await pushRunnableAgent(app, db, NS, "give-back-order-webhook");
    const journal: string[] = [];
    spyGiveBack(journal);
    const updateRun = db.updateRun.bind(db);
    vi.spyOn(db, "updateRun").mockImplementation((id, patch) => {
      if ("phase_timings" in patch) journal.push("telemetry");
      return updateRun(id, patch);
    });

    const run = await runToEnd("give-back-order-webhook", "webhook", {
      outcome: "complete",
      files: [],
      spawned: {},
    });

    expect(journal).toEqual(["give back", "telemetry"]);
    expect(run.row.pool_entitled).toBe(false);
  });
});

// The write that records a failed run fails too, at each of its attempts. The
// caller still gets its answer, and each log line says what failed by the
// error's class and code: never by its message, which can quote the row or the
// value a driver choked on.
describe("cloud runs through the route — a failed run whose row cannot be written", () => {
  /** A value that only the failing write's message carries. */
  const WITNESS = "witness-5c1e9a";
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let fetchSpy: MockInstance<typeof fetch>;
  /** How many writes of the run's failure the store has refused. */
  let failedWrites = 0;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access in a hermetic test"));
    deliverWebhook.mockClear();
    log.error.mockClear();
    const storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    const finishRun = db.finishRun.bind(db);
    failedWrites = 0;
    vi.spyOn(db, "finishRun").mockImplementation(async (id, patch, options) => {
      if (patch.status === "failed") {
        failedWrites++;
        throw Object.assign(new Error(`could not update run: "${WITNESS}" is locked`), {
          code: "55P03",
        });
      }
      return finishRun(id, patch, options);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The final write's failure lines logged so far, each with every argument of its call. */
  function finalWriteLines(): unknown[][] {
    return log.error.mock.calls.filter(([fields]) => {
      const event = String((fields as { event?: unknown }).event);
      return event === "db_update_failed" || event.startsWith("run_final_write");
    });
  }

  /**
   * The case's clock, from here: a lock not granted is no refusal of the data,
   * so the same write is made again, one second, then four more, later.
   */
  function takeTheClock(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }

  /**
   * One line per attempt — two that say it is made again, the last that it is
   * given up —: the witness in none, the error's class and code in their fields.
   */
  function expectTheLinesByClassAndCode(runId: string): void {
    const lines = finalWriteLines();
    expect(JSON.stringify(lines)).not.toContain(WITNESS);
    const byClassAndCode = { run_id: runId, error_name: "Error", error_code: "55P03" };
    expect(lines.map(([fields]) => fields)).toEqual([
      { event: "db_update_failed", ...byClassAndCode },
      { event: "db_update_failed", ...byClassAndCode },
      { event: "run_final_write_failed", ...byClassAndCode },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  }

  it("a streamed run: its failure logs the class and code of the write's error, never its message", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-failed-write");
    script.next = { outcome: "error", code: "MACHINE_SPAWN_FAILED", message: "scripted failure" };

    takeTheClock();

    const res = await runFlyio(app, NS, "flyio-sse-failed-write", { mode: "sse" });
    expect(res.status).toBe(200);
    const body = res.text();
    await throughTheSpacedAttempts(() => failedWrites);
    const events = parseSseEvents(await body);
    expect(events.map((e) => e.event)).toEqual(["run_start", "run_error"]);
    const runId = (events[0]?.data as { run_id: string }).run_id;

    await vi.waitFor(() => expect(finalWriteLines()).toHaveLength(3));
    expectTheLinesByClassAndCode(runId);
  });

  it("a webhook run: its failure logs the class and code of the write's error, never its message", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-webhook-failed-write");
    script.next = { outcome: "error", code: "MACHINE_SPAWN_FAILED", message: "scripted failure" };

    takeTheClock();

    const res = await runFlyio(app, NS, "flyio-webhook-failed-write", { mode: "webhook" });
    expect(res.status).toBe(202);
    const { run_id: runId } = (await res.json()) as { run_id: string };
    // The background run waits for the write — its three attempts — before it reports.
    await throughTheSpacedAttempts(() => failedWrites);
    await untilReally(() => deliverWebhook.mock.calls.length > 0);
    expect(deliverWebhook).toHaveBeenCalledOnce();
    expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({ run_id: runId, status: "failed" });

    expectTheLinesByClassAndCode(runId);
  });

  // The case leaves the time a request admitted after all would take to be
  // answered: its run's failure written first, in three attempts one second,
  // then four seconds apart on the real clock — five seconds in all. Such a
  // request fails it on its status, never on its time.
  it("a synchronous request, refused on this runtime before any write: no row, so no write to fail and no line of one — what the synchronous refusal's own cases hold already, kept beside the failed writes", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sync-failed-write");
    // Never played: the request is refused before any machine is asked for.
    script.next = { outcome: "complete", files: [] };

    const res = await runFlyio(app, NS, "flyio-sync-failed-write", { mode: "sync" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SYNC_MODE_UNSUPPORTED");

    expect(await db.listRuns()).toEqual([]);
    expect(db.finishRun).not.toHaveBeenCalled();
    expect(finalWriteLines()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 15_000);
});

// An error that escapes a streamed run once its stream has started. The web
// framework's streaming helper printed it whole to stderr — message, stack and
// whatever hangs on it. It is one log line now, by class and code, and the
// caller's stream ends exactly as it did: after the events already sent,
// with no event added.
describe("cloud runs through the route — an error that escapes a streamed run", () => {
  /** A value that only the escaping error's message carries. */
  const WITNESS = "witness-sse-7d3b";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is logged by class and code, never printed, and the stream ends as before", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    log.error.mockClear();
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    await pushRunnableAgent(app, db, NS, "flyio-sse-breaks");
    script.next = {
      outcome: "break",
      error: Object.assign(new Error(`socket closed while reading "${WITNESS}"`), {
        code: "ECONNRESET",
      }),
    };

    const res = await runFlyio(app, NS, "flyio-sse-breaks", { mode: "sse" });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The stream ends after the event already sent: nothing is added to it, and
    // the error's message never reaches the caller.
    expect(body).not.toContain(WITNESS);
    const events = parseSseEvents(body);
    expect(events.map((e) => e.event)).toEqual(["run_start"]);
    const runId = (events[0]?.data as { run_id: string }).run_id;

    // Nothing reaches stderr, where the helper printed the whole error.
    expect(inspect(printed.mock.calls, { depth: 10 })).not.toContain(WITNESS);
    expect(printed).not.toHaveBeenCalled();
    // One line, the error's class and code and the frames of its stack, never its
    // message.
    const lines = log.error.mock.calls.filter(
      ([fields]) => (fields as { event?: unknown }).event === "sse_stream_failed",
    );
    expect(lines).toEqual([
      [
        {
          event: "sse_stream_failed",
          run_id: runId,
          error_name: "Error",
          error_code: "ECONNRESET",
          error_stack: expect.any(Array),
        },
        expect.any(String),
      ],
    ]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(WITNESS);
    const frames = (lines[0]?.[0] as { error_stack: string[] }).error_stack;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => line.startsWith("at "))).toBe(true);
  });
});

describe("cloud runs through the route — no model key resolvable, primary or fallback", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    deliverWebhook.mockClear();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    // The cloud adapter's two entry points: a run that reaches either one would
    // acquire a machine in production.
    executeStream = vi.spyOn(FlyioAdapter.prototype, "executeStream");
    execute = vi.spyOn(FlyioAdapter.prototype, "execute");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `POST /run` in the given shape, as `runFlyio` sends it, but with `headers` for the model key. */
  function runIn(
    mode: "sync" | "sse" | "webhook",
    name: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const body: Record<string, unknown> = { input: { q: "hello" } };
    if (mode === "webhook") body.webhook_url = FAKE_WEBHOOK_URL;
    return app.request(`/api/agents/${NS}/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        ...(mode === "sse" && { Accept: "text/event-stream" }),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  /** Everything a refusal is judged on, in one value, so a red shows all of it at once. */
  async function observe(res: Response) {
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    const body = isJson
      ? (JSON.parse(text) as { error?: { code?: string; message?: string } })
      : undefined;
    return {
      message: body?.error?.message ?? "",
      seen: {
        status: res.status,
        code: body?.error?.code,
        events: isJson ? [] : parseSseEvents(text).map((e) => e.event),
        adapterCalls: execute.mock.calls.length + executeStream.mock.calls.length,
        runs: (await db.listRuns()).length,
      },
    };
  }

  // The synchronous request is refused by its mode first: its key is never looked at.
  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: refused with 400 before the cloud adapter — LLM_KEY_REQUIRED for a stream or a webhook, SYNC_MODE_UNSUPPORTED for a synchronous request, judged before the key — no machine, no run row", async (mode) => {
    await pushRunnableAgent(app, db, NS, `flyio-key-none-${mode}`);

    const { seen, message } = await observe(await runIn(mode, `flyio-key-none-${mode}`));

    expect(seen).toEqual({
      status: 400,
      code: mode === "sync" ? "SYNC_MODE_UNSUPPORTED" : "LLM_KEY_REQUIRED",
      events: [],
      adapterCalls: 0,
      runs: 0,
    });
    expect(deliverWebhook).not.toHaveBeenCalled();
    if (mode === "sync") {
      expect(message).not.toContain("anthropic");
      expect(message).not.toContain("X-LLM-API-Key");
    } else {
      expect(message).toContain('provider "anthropic"');
      expect(message).toContain("X-LLM-API-Key");
    }
  });

  /** Push, verified, an agent whose primary model is google and whose fallback is openai. */
  async function pushAgentWithFallback(name: string): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      `version: ${FAKE_AGENT_VERSION}`,
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "  fallback:",
      "    provider: openai",
      "    name: gpt-4o-mini",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const push = await app.request(`/api/agents/${NS}/${name}/push?version=${FAKE_AGENT_VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified(NS, name, FAKE_AGENT_VERSION, true);
  }

  it.each([
    ["the primary only, the fallback having none", "flyio-key-primary-only", { google: "k-g" }],
    // The router turns to the fallback when the primary fails for want of a
    // key: a run the fallback can serve is not refused.
    ["the fallback only, the primary having none", "flyio-key-fallback-only", { openai: "k-o" }],
  ] as const)("accepted when the caller brings a key for %s", async (_case, name, keys) => {
    await pushAgentWithFallback(name);
    script.next = { outcome: "complete", files: [] };

    const res = await runIn("sse", name, { "X-LLM-API-Key": JSON.stringify(keys) });

    expect(res.status).toBe(200);
    expect(parseSseEvents(await res.text()).map((e) => e.event)).toEqual([
      "run_start",
      "run_complete",
    ]);
    expect(executeStream).toHaveBeenCalledOnce();
    expect((executeStream.mock.calls[0]?.[0] as RunRequest).callerKeys).toEqual(keys);
  });

  it("refused when neither the primary nor the fallback has a key — no machine, no run row", async () => {
    await pushAgentWithFallback("flyio-key-none-with-fallback");

    const { seen, message } = await observe(await runIn("sse", "flyio-key-none-with-fallback"));

    expect(seen).toEqual({
      status: 400,
      code: "LLM_KEY_REQUIRED",
      events: [],
      adapterCalls: 0,
      runs: 0,
    });
    expect(message).toContain('provider "google"');
    expect(message).toContain('"openai"');
  });
});

describe("cloud runs through the route — an allowed host the sandbox cannot enforce", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    deliverWebhook.mockClear();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    executeStream = vi.spyOn(FlyioAdapter.prototype, "executeStream");
    execute = vi.spyOn(FlyioAdapter.prototype, "execute");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Push, verified, the harness's agent with an `allowed_hosts` list (none: the key omitted). */
  async function pushWithHosts(name: string, hosts?: string[]): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      `version: ${FAKE_AGENT_VERSION}`,
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
      ...(hosts
        ? [
            "environment:",
            "  networking:",
            "    allowed_hosts:",
            ...hosts.map((h) => `      - "${h}"`),
          ]
        : []),
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const push = await app.request(`/api/agents/${NS}/${name}/push?version=${FAKE_AGENT_VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified(NS, name, FAKE_AGENT_VERSION, true);
  }

  /** `POST /run` as the owner, with a caller model key, so that no key check refuses it. */
  function runIn(
    mode: "sync" | "sse" | "webhook",
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    const body: Record<string, unknown> = { input: { q: "hello" }, ...extra };
    if (mode === "webhook") body.webhook_url = FAKE_WEBHOOK_URL;
    return app.request(`/api/agents/${NS}/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
        ...(mode === "sse" && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify(body),
    });
  }

  async function observe(res: Response) {
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    const body = isJson
      ? (JSON.parse(text) as { error?: { code?: string; message?: string } })
      : undefined;
    return {
      message: body?.error?.message ?? "",
      seen: {
        status: res.status,
        code: body?.error?.code,
        events: isJson ? [] : parseSseEvents(text).map((e) => e.event),
        adapterCalls: execute.mock.calls.length + executeStream.mock.calls.length,
        runs: (await db.listRuns()).length,
      },
    };
  }

  const REFUSED = {
    status: 400,
    code: "EGRESS_HOST_UNSUPPORTED",
    events: [],
    adapterCalls: 0,
    runs: 0,
  };

  // Every form the sandbox cannot hold is refused the way a pattern is: by its
  // form, before any machine — none created, no pooled one taken.
  it.each([
    ["a host with a port", "example.com:443", "a host with a port: honoured by no runtime"],
    ["a URL", "https://x.y", "a URL: honoured by no runtime"],
    ["a host with a path", "x.y/z", "a host with a path: honoured by no runtime"],
    [
      "an internationalised name",
      "bücher.de",
      "not a host name the sandbox reads: honoured by no runtime",
    ],
  ])("%s in agent.yaml is refused with 400, by its form, before the cloud adapter — no machine, no run row", async (_what, host, words) => {
    // One agent per form, named by the form's first letters alone.
    const name = `flyio-form-${host
      .replace(/[^a-z]/gi, "")
      .slice(0, 8)
      .toLowerCase()}`;
    await pushWithHosts(name, ["api.example.com", host]);

    const { seen, message } = await observe(await runIn("sse", name));

    expect(seen).toEqual(REFUSED);
    expect(message).toContain(`${JSON.stringify(host)} (${words})`);
    expect(message).not.toContain('"api.example.com"');
  });

  it("is refused before a pooled machine is taken", async () => {
    const takeReady = vi.fn();
    const pool = {
      enabled: true,
      start: () => undefined,
      takeReady,
      stats: () => ({ ready: 1 }),
    } as unknown as RunnerPool;
    app = createApp(storage, db, {
      runtimeMode: "flyio",
      flyioDeps: { ...fakeFlyioDeps(storage), pool },
    });
    await pushWithHosts("flyio-form-pooled", ["example.com:443"]);

    const { seen } = await observe(await runIn("sse", "flyio-form-pooled"));

    expect(seen).toEqual(REFUSED);
    expect(takeReady).not.toHaveBeenCalled();
  });

  // The sandbox reads an IPv6 literal bare; an author may write it in brackets,
  // the form a URL writes it in. Either reaches the adapter bare.
  it("an IPv6 literal, bare or in brackets, reaches the cloud adapter bare, the other entries as written", async () => {
    await pushWithHosts("flyio-ipv6", ["api.example.com", "[2606:4700::1111]", "2606:4700::1111"]);
    script.next = { outcome: "complete", files: [] };
    script.lastRequest = undefined;

    const res = await runIn("sse", "flyio-ipv6");

    expect(res.status).toBe(200);
    await res.text();
    expect(executeStream).toHaveBeenCalledOnce();
    const request = executeStream.mock.calls[0]?.[0] as RunRequest | undefined;
    expect(request?.agentConfig.environment.networking.allowed_hosts).toEqual([
      "api.example.com",
      "2606:4700::1111",
      "2606:4700::1111",
    ]);
  });

  // The synchronous request is refused by its mode first: the allowed hosts of
  // its agent are never read.
  it.each([
    "sync",
    "sse",
    "webhook",
  ] as const)("%s: a pattern in agent.yaml is refused with 400 before the cloud adapter — a synchronous request, by its mode, before the pattern is judged — no machine, no run row", async (mode) => {
    await pushWithHosts(`flyio-glob-${mode}`, ["api.example.com", "*.example.com"]);

    const { seen, message } = await observe(await runIn(mode, `flyio-glob-${mode}`));

    expect(deliverWebhook).not.toHaveBeenCalled();
    if (mode === "sync") {
      expect(seen).toEqual({ ...REFUSED, code: "SYNC_MODE_UNSUPPORTED" });
      expect(message).not.toContain("*.example.com");
    } else {
      expect(seen).toEqual(REFUSED);
      expect(message).toContain("*.example.com");
      expect(message).not.toContain("api.example.com,");
      expect(message).toContain('"*"');
    }
  });

  it("a pattern, or a host with a port, brought by the owner's environment override is refused the same way", async () => {
    await pushWithHosts("flyio-glob-override", ["api.example.com"]);

    const { seen, message } = await observe(
      await runIn("sse", "flyio-glob-override", {
        environment: { networking: { allowed_hosts: ["*.slack.com", "example.com:443"] } },
      }),
    );

    expect(seen).toEqual(REFUSED);
    expect(message).toContain('"*.slack.com" (a host pattern: honoured by the local runtime only)');
    expect(message).toContain('"example.com:443" (a host with a port: honoured by no runtime)');
  });

  // Where the refusal stands: before the model-key check and before the inputs
  // are validated. Each case first shows, on a list of named hosts, the refusal
  // that would answer were the pattern judged later.
  function runWithoutKey(name: string): Promise<Response> {
    return app.request(`/api/agents/${NS}/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: { q: "hello" } }),
    });
  }

  it("is judged before the model key: with no key anywhere, the pattern's refusal answers", async () => {
    await pushWithHosts("flyio-named-nokey", ["api.example.com"]);
    expect((await observe(await runWithoutKey("flyio-named-nokey"))).seen.code).toBe(
      "LLM_KEY_REQUIRED",
    );

    await pushWithHosts("flyio-glob-nokey", ["*.example.com"]);
    const { seen } = await observe(await runWithoutKey("flyio-glob-nokey"));

    expect(seen).toEqual(REFUSED);
  });

  it("is judged before the inputs: with a required input missing, the pattern's refusal answers", async () => {
    await pushWithHosts("flyio-named-noinput", ["api.example.com"]);
    expect(
      (await observe(await runIn("sse", "flyio-named-noinput", { input: {} }))).seen.code,
    ).toBe("MISSING_INPUT");

    await pushWithHosts("flyio-glob-noinput", ["*.example.com"]);
    const { seen } = await observe(await runIn("sse", "flyio-glob-noinput", { input: {} }));

    expect(seen).toEqual(REFUSED);
  });

  it('beside "*", the refusal says the pattern adds nothing and is to be removed — it does not advise "*"', async () => {
    await pushWithHosts("flyio-glob-star", ["*", "*.slack.com"]);

    const { seen, message } = await observe(await runIn("sse", "flyio-glob-star"));

    expect(seen).toEqual(REFUSED);
    expect(message).toContain("*.slack.com");
    expect(message).toContain("remove");
    expect(message).not.toContain('or use "*"');
  });

  it.each([
    ["'*' alone", "flyio-hosts-star", ["*"]],
    ["named hosts", "flyio-hosts-named", ["api.example.com", "example.org"]],
    ["no list at all", "flyio-hosts-none", undefined],
  ] as const)("%s reach the cloud adapter", async (_case, name, hosts) => {
    await pushWithHosts(name, hosts ? [...hosts] : undefined);
    script.next = { outcome: "complete", files: [] };

    const res = await runIn("sse", name);

    expect(res.status).toBe(200);
    expect(parseSseEvents(await res.text()).map((e) => e.event)).toEqual([
      "run_start",
      "run_complete",
    ]);
    expect(executeStream).toHaveBeenCalledOnce();
  });
});

// The inputs are judged by the route, before any adapter and any machine: an
// input the agent requires that the request lacks — no field of its own, null,
// or an empty list for a file input — is refused the same way on this runtime
// as on the local one.
describe("cloud runs through the route — a missing input, refused before any machine", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  let executeStream: MockInstance;
  let execute: MockInstance;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    executeStream = vi.spyOn(FlyioAdapter.prototype, "executeStream");
    execute = vi.spyOn(FlyioAdapter.prototype, "execute");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Push, verified, an agent with a required file input `doc` and a required string input `q`. */
  async function pushWithInputs(name: string): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      `version: ${FAKE_AGENT_VERSION}`,
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-20250514",
      "inputs:",
      "  - name: doc",
      "    type: file",
      "    media: document",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const push = await app.request(`/api/agents/${NS}/${name}/push?version=${FAKE_AGENT_VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(push.status).toBe(200);
    await db.setVersionVerified(NS, name, FAKE_AGENT_VERSION, true);
  }

  const DOC = { type: "file", source: "id", file_id: "never-read" };

  it.each([
    ["a required file input sent as an empty list", { doc: [], q: "hello" }, "doc"],
    ["a required file input sent as null", { doc: null, q: "hello" }, "doc"],
    ["a required string input sent as null", { doc: DOC, q: null }, "q"],
  ])("%s: 400 MISSING_INPUT — no admission, no adapter, no run row", async (_label, input, missing) => {
    await pushWithInputs("flyio-missing-input");
    const admissions = vi.spyOn(db, "admitRun");

    const res = await app.request(`/api/agents/${NS}/flyio-missing-input/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input }),
    });

    // Read whole, whatever it is: a run that went ahead answers an event stream.
    const text = await res.text();
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    expect({ status: res.status, body: isJson ? JSON.parse(text) : text }).toEqual({
      status: 400,
      body: { error: { code: "MISSING_INPUT", message: `Missing required input: ${missing}` } },
    });
    expect(admissions).not.toHaveBeenCalled();
    expect(execute.mock.calls.length + executeStream.mock.calls.length).toBe(0);
    expect(await db.listRuns()).toEqual([]);
  });
});

// Through the HTTP server the API runs on, not `app.request`: what a caller's
// connection does to the run's signal is the server's to decide. The run hands
// its adapter that signal, joined to the stop's, and the adapter ends its
// acquisition — and its loop — on it. A webhook run's caller is gone once its
// 202 is out: that must not end the run. A streamed run's caller who hangs up
// mid-stream must. Loopback only, on a port the system picks.
describe("cloud runs through the HTTP server — what the caller's connection does to the run's signal", () => {
  const savedRequest = globalThis.Request;
  const savedResponse = globalThis.Response;
  let server: Server;
  let port: number;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access in a hermetic test"));
    deliverWebhook.mockClear();
    script.lastRequest = undefined;
    const storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    // As the server entry points do: the listener installs its own Request and
    // Response classes, restored after each case.
    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.defineProperty(globalThis, "Request", { value: savedRequest });
    Object.defineProperty(globalThis, "Response", { value: savedResponse });
    vi.restoreAllMocks();
  });

  function openConnections(): Promise<number> {
    return new Promise((resolve, reject) =>
      server.getConnections((err, count) => (err ? reject(err) : resolve(count))),
    );
  }

  /** A promise the case opens when it chooses. */
  function gate() {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  /**
   * POST a run on its own connection. `hangUp` says when the caller leaves: once
   * the whole answer has arrived, or at its first bytes. Resolves with the status
   * and what had arrived, once the connection is closed on the caller's side.
   */
  function postRun(
    name: string,
    body: Record<string, unknown>,
    hangUp: "after-answer" | "at-first-bytes",
    headers: Record<string, string> = {},
  ): Promise<{ status: number; received: string }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/api/agents/${NS}/${name}/run`,
        agent: false,
        headers: {
          Authorization: `Bearer ${DEV_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          // The caller's model key, as runFlyio sends it: the route resolves one.
          "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
          ...headers,
        },
      });
      req.on("error", reject);
      req.on("response", (res) => {
        let received = "";
        const leave = () => {
          res.socket.destroy();
          resolve({ status: res.statusCode ?? 0, received });
        };
        res.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
          if (hangUp === "at-first-bytes") leave();
        });
        res.on("end", () => {
          if (hangUp === "after-answer") leave();
        });
        res.on("error", () => {});
      });
      req.end(payload);
    });
  }

  it("a webhook run's signal stays up once its 202 is out, its caller gone: the run goes on to its delivery", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-webhook-signal");
    const release = gate();
    script.next = { outcome: "complete", files: [], held: release.opened };

    const answer = await postRun(
      "flyio-webhook-signal",
      { input: { q: "hello" }, webhook_url: FAKE_WEBHOOK_URL },
      "after-answer",
    );
    expect(answer.status).toBe(202);
    await vi.waitFor(() => expect(script.lastRequest).toBeDefined());
    // The caller's connection is closed, and the server has seen it go.
    await vi.waitFor(async () => expect(await openConnections()).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(script.lastRequest?.abortSignal?.aborted).toBe(false);
    release.open();
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledOnce());
    expect(deliverWebhook.mock.calls[0]?.[1]).toMatchObject({ status: "completed" });
    expect(script.lastRequest?.abortSignal?.aborted).toBe(false);
  });

  it("a streamed run's signal is aborted once its caller hangs up mid-stream — the server reports a gone caller", async () => {
    await pushRunnableAgent(app, db, NS, "flyio-sse-signal");
    const release = gate();
    script.next = { outcome: "complete", files: [], held: release.opened };

    const answer = await postRun("flyio-sse-signal", { input: { q: "hello" } }, "at-first-bytes", {
      Accept: "text/event-stream",
    });
    expect(answer.status).toBe(200);

    await vi.waitFor(() => expect(script.lastRequest?.abortSignal?.aborted).toBe(true));
    release.open();
    const runId = script.lastRequest?.runId ?? "";
    expect((await settledRun(db, runId)).status).not.toBe("running");
  });
});

// The time a run is charged: its end minus its admission, on the process's
// clock — but nothing for a machine that never got ready (told by the adapter
// before the run's error, whatever cut the acquisition), and nothing for a run
// the server's stop ended; a completion that replaces the stop's provisional
// failure is charged as any completion. The clock is the test's: `Date` alone
// is simulated, so every wait below is a real one, and none is tight.
describe("cloud runs through the route — the time a run is charged", () => {
  const T0 = Date.parse("2026-10-16T13:00:00.000Z");
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;
  /** A stop a case began, awaited before the next case. */
  let stopping: Promise<unknown> | undefined;

  /** What the clock reads `ms` after the run was admitted. */
  const clockAt = (ms: number) => () => vi.setSystemTime(T0 + ms);

  /**
   * Wait, in real time, until `check` passes — never through `vi.waitFor`,
   * which moves a simulated clock as it polls.
   */
  async function until(check: () => unknown): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 1000; attempt++) {
      try {
        await check();
        return;
      } catch (err) {
        last = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw last;
  }

  /** A promise, and the function that resolves it. */
  function opening(): { opened: Promise<void>; open: () => void } {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    deliverWebhook.mockClear();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    script.destroyed = [];
    stopping = undefined;
  });

  afterEach(async () => {
    // A stop lasts for the process: the next case gets a server that runs.
    if (stopping) await stopping;
    _resetShutdownForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A streamed run, its body read to its end in the background: its id, and its events once over. */
  async function streamed(name: string) {
    const res = await runFlyio(app, NS, name, { mode: "sse" });
    expect(res.status).toBe(200);
    const body = res.text();
    await until(() => expect(script.lastRequest).toBeDefined());
    const runId = script.lastRequest?.runId as string;
    return { runId, events: async () => parseSseEvents(await body) };
  }

  /** The final event a streamed run's caller read. */
  function finalEvent(events: Array<{ event: string; data: unknown }>) {
    return events.filter(({ event }) => event === "run_complete" || event === "run_error").at(-1);
  }

  it.each([
    "sse",
    "webhook",
  ] as const)("%s: a machine never created charges nothing — ninety seconds passed", async (mode) => {
    await pushRunnableAgent(app, db, NS, `charged-create-${mode}`);
    script.lastRequest = undefined;
    script.next = { outcome: "spawn-failed", phase: "create", beforeEnd: clockAt(90_000) };

    const res = await runFlyio(app, NS, `charged-create-${mode}`, { mode });
    expect(res.status).toBe(mode === "sse" ? 200 : 202);
    await res.text();
    if (mode === "webhook") await until(() => expect(deliverWebhook).toHaveBeenCalledOnce());

    const run = await settledRun(db, script.lastRequest?.runId as string);
    expect(run).toMatchObject({ status: "failed", charged_ms: 0 });
    expect(run.error).toContain('phase "create"');
    expect(script.destroyed).toEqual([]);
  });

  it("a runner whose /init failed — the agent's own MCP servers connect there — charges its time", async () => {
    await pushRunnableAgent(app, db, NS, "charged-init");
    script.lastRequest = undefined;
    script.next = {
      outcome: "spawn-failed",
      phase: "init-rpc",
      machineId: "m-init",
      beforeEnd: clockAt(90_000),
    };

    const run = await streamed("charged-init");
    const events = await run.events();

    expect(finalEvent(events)).toMatchObject({
      event: "run_error",
      data: { error: { code: "MACHINE_SPAWN_FAILED" } },
    });
    expect(await settledRun(db, run.runId)).toMatchObject({ status: "failed", charged_ms: 90_000 });
    expect(script.destroyed).toEqual(["m-init"]);
  });

  // Every phase a start can fail at, and what it charges of the ninety seconds
  // it took: nothing while none of the agent was in play — a machine never
  // made, never answering its probe, its URLs never signed, a pooled machine not
  // woken or not claimed —, all of it once the runner's /init ran. Typed on the
  // phases themselves: a phase added to the runtime is decided here too.
  const CHARGED_BY_PHASE = {
    create: 0,
    "boot-probe": 0,
    presign: 0,
    "pool-resume": 0,
    "pool-claim": 0,
    "init-rpc": 90_000,
  } satisfies Record<MachineSpawnPhase, number>;

  it.each(
    Object.entries(CHARGED_BY_PHASE) as Array<[MachineSpawnPhase, number]>,
  )("a start that failed at %s charges %d ms of the ninety seconds it took", async (phase, charged) => {
    const name = `charged-phase-${phase}`;
    await pushRunnableAgent(app, db, NS, name);
    script.lastRequest = undefined;
    script.next = {
      outcome: "spawn-failed",
      phase,
      ...(phase !== "create" && { machineId: `m-${phase}` }),
      beforeEnd: clockAt(90_000),
    };

    const run = await streamed(name);
    const events = await run.events();

    expect(finalEvent(events)).toMatchObject({
      event: "run_error",
      data: { error: { code: "MACHINE_SPAWN_FAILED" } },
    });
    const row = await settledRun(db, run.runId);
    expect(row).toMatchObject({ status: "failed", charged_ms: charged });
    expect(row.error).toContain(`phase "${phase}"`);
  });

  it("a caller who hangs up while the machine boots charges nothing: the abandon names the phase it reached", async () => {
    await pushRunnableAgent(app, db, NS, "charged-hangup");
    script.lastRequest = undefined;
    script.next = {
      outcome: "spawn-failed",
      phase: "boot-probe",
      machineId: "m-boot",
      untilAborted: true,
      beforeEnd: clockAt(90_000),
    };
    const caller = new AbortController();

    const res = await app.request(`/api/agents/${NS}/charged-hangup/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-LLM-API-Key": JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
      },
      body: JSON.stringify({ input: { q: "hello" } }),
      signal: caller.signal,
    });
    expect(res.status).toBe(200);
    await until(() => expect(script.lastRequest).toBeDefined());
    caller.abort();
    await res.body?.cancel().catch(() => undefined);

    const run = await settledRun(db, script.lastRequest?.runId as string);
    expect(run).toMatchObject({ status: "failed", charged_ms: 0 });
    expect(script.destroyed).toEqual(["m-boot"]);
  });

  describe("a run the server's stop ends", () => {
    it("(i) answering the stop's abandon during the drain: failed with the stop's phrase, never the caller's abort, charged nothing", async () => {
      await pushRunnableAgent(app, db, NS, "stop-answers");
      script.lastRequest = undefined;
      script.next = {
        outcome: "error",
        code: "ABORTED",
        message: "Run aborted by caller mid-iteration",
        untilAborted: true,
        beforeEnd: clockAt(30_000),
      };
      const run = await streamed("stop-answers");

      stopping = shutdownInFlightRuns({ drainMs: 5_000, graceMs: 10_000 });
      const events = await run.events();
      await stopping;

      expect(finalEvent(events)).toMatchObject({
        event: "run_error",
        data: { error: { code: SHUTDOWN_RUN_ERROR_CODE, message: SHUTDOWN_RUN_ERROR } },
      });
      expect(await db.getRun(run.runId)).toMatchObject({
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        charged_ms: 0,
      });
    });

    it("(ii) ignoring it: the stop's provisional failure, charged nothing — and a failure after it changes nothing", async () => {
      await pushRunnableAgent(app, db, NS, "stop-ignored");
      script.lastRequest = undefined;
      const release = opening();
      script.next = {
        outcome: "error",
        code: "EXECUTION_FAILED",
        message: "a failure of its own, after the stop",
        held: release.opened,
      };
      const run = await streamed("stop-ignored");
      vi.setSystemTime(T0 + 30_000);

      stopping = shutdownInFlightRuns({ drainMs: 50, graceMs: 10_000 });
      await until(async () =>
        expect(await db.getRun(run.runId)).toMatchObject({
          status: "failed",
          error: SHUTDOWN_RUN_ERROR,
          charged_ms: 0,
        }),
      );
      release.open();
      const events = await run.events();
      await stopping;

      expect(finalEvent(events)).toMatchObject({
        event: "run_error",
        data: { error: { code: SHUTDOWN_RUN_ERROR_CODE, message: SHUTDOWN_RUN_ERROR } },
      });
      expect(await db.getRun(run.runId)).toMatchObject({
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        charged_ms: 0,
      });
    });

    it("(iii) that run succeeding after the provisional failure: completed, and charged as any completion — its end minus its admission", async () => {
      await pushRunnableAgent(app, db, NS, "stop-then-success");
      script.lastRequest = undefined;
      const release = opening();
      script.next = {
        outcome: "complete",
        files: [],
        held: release.opened,
        beforeEnd: clockAt(38_000),
      };
      const run = await streamed("stop-then-success");
      vi.setSystemTime(T0 + 30_000);

      stopping = shutdownInFlightRuns({ drainMs: 50, graceMs: 10_000 });
      await until(async () =>
        expect(await db.getRun(run.runId)).toMatchObject({ status: "failed", charged_ms: 0 }),
      );
      release.open();
      const events = await run.events();
      await stopping;

      expect(finalEvent(events)).toMatchObject({ event: "run_complete" });
      expect(await db.getRun(run.runId)).toMatchObject({
        status: "completed",
        error: null,
        charged_ms: 38_000,
      });
    });

    it("(iv) an acquisition the stop cut at init-rpc, its machine's destruction held past the provisional failure: the row keeps the stop's phrase, charged nothing, and the caller is told the stop", async () => {
      await pushRunnableAgent(app, db, NS, "stop-cuts-init");
      script.lastRequest = undefined;
      const destroy = opening();
      script.next = {
        outcome: "spawn-failed",
        phase: "init-rpc",
        machineId: "m-cut",
        untilAborted: true,
        destroyHeld: destroy.opened,
      };
      const run = await streamed("stop-cuts-init");
      vi.setSystemTime(T0 + 30_000);

      stopping = shutdownInFlightRuns({ drainMs: 50, graceMs: 10_000 });
      await until(async () =>
        expect(await db.getRun(run.runId)).toMatchObject({
          status: "failed",
          error: SHUTDOWN_RUN_ERROR,
          charged_ms: 0,
        }),
      );
      destroy.open();
      const events = await run.events();
      await stopping;

      expect(script.destroyed).toEqual(["m-cut"]);
      expect(finalEvent(events)).toMatchObject({
        event: "run_error",
        data: { error: { code: SHUTDOWN_RUN_ERROR_CODE, message: SHUTDOWN_RUN_ERROR } },
      });
      expect(await db.getRun(run.runId)).toMatchObject({
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        charged_ms: 0,
      });
    });

    it("(iv′) the same acquisition, its error out during the drain: the stop's failure as the run's final status, charged nothing — never MACHINE_SPAWN_FAILED, never init-rpc's time", async () => {
      await pushRunnableAgent(app, db, NS, "stop-cuts-init-drain");
      script.lastRequest = undefined;
      script.next = {
        outcome: "spawn-failed",
        phase: "init-rpc",
        machineId: "m-cut-drain",
        untilAborted: true,
      };
      const run = await streamed("stop-cuts-init-drain");
      vi.setSystemTime(T0 + 30_000);

      stopping = shutdownInFlightRuns({ drainMs: 5_000, graceMs: 10_000 });
      const events = await run.events();
      await stopping;

      expect(finalEvent(events)).toMatchObject({
        event: "run_error",
        data: { error: { code: SHUTDOWN_RUN_ERROR_CODE, message: SHUTDOWN_RUN_ERROR } },
      });
      expect(await db.getRun(run.runId)).toMatchObject({
        status: "failed",
        error: SHUTDOWN_RUN_ERROR,
        charged_ms: 0,
      });
    });
  });
});

// A failed start is told to its caller — its run_error, and its row's error,
// which a later read of the run returns — in the words the cloud adapter builds:
// the phase, and a status the platform answered. Never the machine's name or
// id, which are the operator's topology, nor anything the runner answered.
// Every phase, from a cold machine and from a pooled one.
describe("cloud runs through the route — a failed start names no machine to its caller", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deliverWebhook.mockClear();
    storage = new MemoryStorage();
    db = new MemoryDb();
    app = createApp(storage, db, { runtimeMode: "flyio", flyioDeps: fakeFlyioDeps(storage) });
    script.destroyed = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A cold machine is named after its run; a pooled one by its own id. */
  const CASES = [
    ["cold", "create", undefined, 400, ", HTTP 400"],
    ["cold", "boot-probe", "m-cold-boot", null, ""],
    ["cold", "presign", "m-cold-presign", null, ""],
    ["cold", "init-rpc", "m-cold-init", 500, ""],
    ["pool", "pool-resume", "m-pooled-resume", 422, ", HTTP 422"],
    ["pool", "boot-probe", "m-pooled-boot", null, ""],
    ["pool", "pool-claim", "m-pooled-claim", 409, ""],
    ["pool", "init-rpc", "m-pooled-init", 500, ""],
  ] as const satisfies ReadonlyArray<
    readonly ["cold" | "pool", MachineSpawnPhase, string | undefined, number | null, string]
  >;

  it.each(
    CASES,
  )("%s, at %s: the run_error and the row say the phase, never the machine", async (path, phase, machineId, httpStatus, told) => {
    const name = `told-${path}-${phase}`;
    await pushRunnableAgent(app, db, NS, name);
    script.lastRequest = undefined;
    script.next = {
      outcome: "spawn-failed",
      phase,
      ...(machineId !== undefined && { machineId }),
      ...(path === "pool" && { machineName: `skrun-pool-${machineId}` }),
      ...(httpStatus !== null && { httpStatus }),
    };

    const res = await runFlyio(app, NS, name, { mode: "sse" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const runId = script.lastRequest?.runId as string;
    const row = await settledRun(db, runId);

    const expected = `The run's machine could not be started (phase "${phase}"${told}).`;
    expect(events.at(-1)).toMatchObject({
      event: "run_error",
      data: { error: { code: "MACHINE_SPAWN_FAILED", message: expected } },
    });
    expect(row).toMatchObject({ status: "failed", error: expected });
    const seen = JSON.stringify(events) + JSON.stringify(row.error);
    expect(seen).not.toContain("skrun-run-");
    expect(seen).not.toContain("skrun-pool-");
    if (machineId !== undefined) expect(seen).not.toContain(machineId);
    // The failure's cause — where a runner's answer would be — stays out too.
    expect(seen).not.toContain("scripted failed start");
  });

  // A failed /init that names its step is told by that step, in the adapter's
  // fixed words: never the runner's text, never the machine.
  it.each([
    [
      "cold",
      "bundle-incomplete",
      "the agent's bundle could not be downloaded: it arrived incomplete",
      "m-cold-step",
    ],
    [
      "pool",
      "bundle-checksum",
      "the agent's bundle does not match its recorded checksum",
      undefined,
    ],
    ["pool", "mcp-connect", "the connection to one of the agent's MCP servers failed", undefined],
  ] as const)("%s, at init-rpc, step %s: the run_error and the row say the phase, the step and its words, never the machine nor the runner's text", async (path, stage, words, machineId) => {
    const name = `told-step-${path}-${stage}`;
    await pushRunnableAgent(app, db, NS, name);
    script.lastRequest = undefined;
    script.next = {
      outcome: "spawn-failed",
      phase: "init-rpc",
      httpStatus: 500,
      stage,
      ...(machineId !== undefined && { machineId }),
      ...(path === "pool" && { machineName: "skrun-pool-step" }),
    };

    const res = await runFlyio(app, NS, name, { mode: "sse" });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    const row = await settledRun(db, script.lastRequest?.runId as string);

    const expected = `The run's machine could not be started (phase "init-rpc", step "${stage}"): ${words}.`;
    expect(events.at(-1)).toMatchObject({
      event: "run_error",
      data: { error: { code: "MACHINE_SPAWN_FAILED", message: expected } },
    });
    expect(row).toMatchObject({ status: "failed", error: expected });
    const seen = JSON.stringify(events) + JSON.stringify(row.error);
    expect(seen).not.toMatch(/skrun-run-|skrun-pool-|m-cold-step/);
    expect(seen).not.toContain("scripted failed start");
  });
});
