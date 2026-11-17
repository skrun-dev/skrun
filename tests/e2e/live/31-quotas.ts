/**
 * Live coverage of an account's seats and compute window, its bundle storage
 * and its live uploads, on a real registry.
 *
 * The registry is started again for this phase with quotas set — one seat, a
 * compute window of two minutes, thirty compute seconds in it, a longest
 * timeout, 1 MB of bundle storage, one live upload — and started again
 * without them at the end, whatever happened. It
 * runs on the suite's database, which may be shared: the phase signs in with a
 * dev token of its own (the account `quotas`, never the suite's `dev-token`)
 * and deletes that account first and last, so no other run counts against it
 * and none of its runs stay attached to an account.
 *
 * Compute is the sum of the runs created in the current window: the phase
 * waits for a window to begin before its first run, so every run of the phase
 * falls in the same one — each response's `X-Quota-Compute-Reset` says which.
 *
 * 1. Before the wait, a run whose environment override declares more than the
 *    longest timeout: 400 TIMEOUT_ABOVE_LIMIT, before any model call and
 *    without a row — so it spends nothing of the window.
 * 2. Before the wait too, a push past the account's bundle storage:
 *    413 STORAGE_QUOTA_EXCEEDED, and no agent created for it.
 * 3. An upload, then a second one: refused 429 INPUT_FILES_LIMIT_REACHED, told
 *    to wait until the first expires; the first deleted, an upload is taken
 *    again.
 * 4. Two streamed runs sent at once: one admitted, one refused
 *    429 CONCURRENCY_LIMIT_REACHED with its `Retry-After` and its numbers. The
 *    admitted one starts the window with all its compute left.
 * 5. A third run, sent the moment the admitted run's final event arrives:
 *    admitted — the seat was freed before that event left.
 * 6. Runs in series until 429 COMPUTE_QUOTA_EXCEEDED, told to wait until the
 *    window ends.
 * 7. `GET /api/usage`, as the account reads it: its seat free, the window's
 *    compute spent, the same window — and no fast runs: on the local engine no
 *    runner pool runs, so the route says `fast_runs: null` and no response of
 *    the phase carries a fast-run header.
 * 8. In the database: one `runs` row per admitted run and none for a refused
 *    one, each finished, its seat's deadline and its charged time written.
 *
 * Each PASS line prints what it saw — `code=`, `retry_after=`, the `x-quota-*`
 * headers — so a green run is a measurement. The proof is the statuses, the
 * headers and the rows; never what the model wrote.
 *
 * The agent is the lightest demo, `code-review` (one input, no tool, a 60 s
 * timeout), built from a copy of its directory and pushed over HTTP with the
 * phase's token: the CLI holds one session for the registry, the suite's
 * (`dev-token`, in the suite's own profile), and signing it in as the phase's
 * account would replace it for the phases after this one. The restart lost
 * every bundle pushed before it (they live in the registry's memory), so the
 * phase pushes after it.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validBundleOfSize } from "../../../packages/api/src/routes/agent-bundle.shared.js";
import { REGISTRY, ROOT, results, skrun, startRegistry, stopRegistry } from "./_ctx.js";
import { openRegistryDb, queryFailure, type RegistryDb } from "./registry-db.js";

const NS = "quotas";
const TOKEN = `${NS}-token`;
const AGENT = "code-review";
const INPUT = { code: "const x = 1;" };

const SEATS = 1;
/** Divides one day, as the window must; short, so the phase waits little for one to begin. */
const WINDOW_S = 120;
/** Enough for the first two runs of a slow model, low enough to be spent in a few runs. */
const COMPUTE_S = 30;
const MAX_TIMEOUT_S = 300;
/** The account's bundle storage, in MB — the least the setting takes; the demo is a few KB. */
const STORAGE_MB = 1;
/** The account's live uploads. */
const INPUT_FILES = 1;
/** The agent a push past the storage would have created. */
const STORAGE_PROBE = "storage-probe";
/** Runs in series at most before the refusal is called missing. */
const SERIES_MAX = 25;
/** Into the window before the first run, and kept free before its end. */
const WINDOW_MARGIN_MS = 1_000;
const WINDOW_END_GUARD_MS = 5_000;

/** The registry's quota settings for this phase. */
const QUOTA_ENV = {
  SKRUN_QUOTA_CONCURRENT_RUNS: String(SEATS),
  SKRUN_QUOTA_WINDOW_S: String(WINDOW_S),
  SKRUN_QUOTA_COMPUTE_SECONDS: String(COMPUTE_S),
  SKRUN_RUN_MAX_TIMEOUT_S: String(MAX_TIMEOUT_S),
  SKRUN_QUOTA_STORAGE_MB: String(STORAGE_MB),
  SKRUN_QUOTA_INPUT_FILES: String(INPUT_FILES),
};

const bearer = { Authorization: `Bearer ${TOKEN}` };

function record(feature: string, passed: boolean, detail: string): void {
  results.push({ agent: "quotas", feature, passed, duration: 0, cost: 0, detail });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a response says of the account: its status and code, its wait, its numbers. */
function seen(res: Response | undefined, code?: string): string {
  if (!res) return "code=none";
  const numbers = [...res.headers.entries()]
    .filter(([name]) => name.startsWith("x-quota-"))
    .map(([name, value]) => `${name}=${value}`);
  return [
    `code=${res.status}${code ? `/${code}` : ""}`,
    `retry_after=${res.headers.get("retry-after") ?? "none"}`,
    numbers.length > 0 ? numbers.join(" ") : "x-quota-*=none",
  ].join(" ");
}

/** The error a refusal carries. */
async function errorOf(res: Response): Promise<{ code?: string; message?: string }> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return body.error ?? {};
}

/** A stream's events as they arrive. */
async function* events(
  res: Response,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data) continue;
      try {
        yield { event, data: JSON.parse(data) as Record<string, unknown> };
      } catch {
        // not JSON: not an event of a run
      }
    }
  }
}

/** Read a run's stream to its end: its id, the events' names, and its final event. */
async function drain(
  res: Response,
  onFinal?: () => Promise<void>,
): Promise<{ runId: string | null; names: string[]; final: string | null }> {
  const out = { runId: null as string | null, names: [] as string[], final: null as string | null };
  for await (const e of events(res)) {
    out.names.push(e.event);
    if (e.event === "run_start" && typeof e.data.run_id === "string") out.runId = e.data.run_id;
    if ((e.event === "run_complete" || e.event === "run_error") && out.final === null) {
      out.final = e.event;
      if (onFinal) await onFinal();
    }
  }
  return out;
}

function postRun(mode: "sse" | "sync", extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
    method: "POST",
    headers: {
      ...bearer,
      "Content-Type": "application/json",
      ...(mode === "sse" ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({ input: INPUT, ...extra }),
  });
}

/** Upload one small image as the phase's account. */
function uploadProbe(): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(16)], { type: "image/png" }), "probe.png");
  return fetch(`${REGISTRY}/api/files`, { method: "POST", headers: bearer, body: form });
}

/** The file id and deadline an upload was given. */
async function uploaded(res: Response): Promise<{ fileId?: string; expiresAt?: string }> {
  const body = (await res.json().catch(() => ({}))) as { file_id?: string; expires_at?: string };
  return { fileId: body.file_id, expiresAt: body.expires_at };
}

function deleteUpload(fileId: string | undefined): Promise<Response | undefined> {
  if (!fileId) return Promise.resolve(undefined);
  return fetch(`${REGISTRY}/api/files/${fileId}`, { method: "DELETE", headers: bearer });
}

function deleteOwnAccount(): Promise<Response> {
  return fetch(`${REGISTRY}/api/account`, {
    method: "DELETE",
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: NS }),
  });
}

/** The account id the registry gives the phase's token (it creates the account if needed). */
async function accountId(): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/api/me`, { headers: bearer });
  if (!res.ok) return null;
  return ((await res.json()) as { id?: string }).id ?? null;
}

/** The top-level `version:` of the demo's agent.yaml. */
function demoVersion(yaml: string): string {
  const match = /^version:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(yaml);
  if (!match) throw new Error(`agents/${AGENT}/agent.yaml carries no top-level version`);
  return match[1];
}

/** Build the demo from a copy of its directory, push it as the phase's account, verify it. */
async function pushDemo(
  dirs: string[],
): Promise<{ push: number; verify: number; version: string }> {
  const source = join(ROOT, "agents", AGENT);
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-31-${AGENT}-`));
  dirs.push(dir);
  for (const file of ["agent.yaml", "SKILL.md"]) copyFileSync(join(source, file), join(dir, file));
  const version = demoVersion(readFileSync(join(dir, "agent.yaml"), "utf-8"));
  skrun(["build"], dir);
  const bundle = readFileSync(join(dir, `${AGENT}-${version}.agent`));
  const pushed = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/push?version=${version}`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bundle),
  });
  if (pushed.status !== 200) return { push: pushed.status, verify: 0, version };
  const verified = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/versions/${version}/verify`, {
    method: "PATCH",
    headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ verified: true }),
  });
  return { push: pushed.status, verify: verified.status, version };
}

/** Until a window begins (plus a margin), on this machine's clock — the registry's. */
async function waitForWindow(): Promise<{ startMs: number; endMs: number }> {
  const windowMs = WINDOW_S * 1000;
  const waitMs = windowMs - (Date.now() % windowMs) + WINDOW_MARGIN_MS;
  console.log(`  waiting ${Math.ceil(waitMs / 1000)}s for the next ${WINDOW_S}s compute window`);
  await sleep(waitMs);
  const startMs = Math.floor(Date.now() / windowMs) * windowMs;
  return { startMs, endMs: startMs + windowMs };
}

export async function run(): Promise<void> {
  const dirs: string[] = [];
  let db: RegistryDb | null = null;
  try {
    stopRegistry();
    await startRegistry({ extraEnv: QUOTA_ENV });
    console.log(`  registry started again with ${Object.keys(QUOTA_ENV).join(", ")}`);

    // A clean slate: the account and its runs from an earlier run are gone.
    await deleteOwnAccount();
    const pushed = await pushDemo(dirs);
    const id = await accountId();
    if (pushed.push !== 200 || pushed.verify !== 200 || id === null) {
      record(
        "setup: the demo is pushed and verified by the phase's own account",
        false,
        `push=${pushed.push} verify=${pushed.verify} version=${pushed.version} account=${id ? "yes" : "no"}`,
      );
      return;
    }

    // ── 1. A timeout above the longest one: refused before any model call ─
    const tooLong = await postRun("sync", {
      environment: { timeout: `${MAX_TIMEOUT_S * 2}s` },
    });
    const tooLongError = await errorOf(tooLong);
    record(
      "a run whose environment override declares more than the longest timeout is refused 400 TIMEOUT_ABOVE_LIMIT",
      tooLong.status === 400 && tooLongError.code === "TIMEOUT_ABOVE_LIMIT",
      `${seen(tooLong, tooLongError.code)} message="${tooLongError.message ?? ""}"`,
    );

    // ── 2. A push past the account's storage: refused, no agent created ─
    // A bundle the push accepts — one that did not load would be refused
    // before the storage is read — one byte past the account's storage.
    const big = await fetch(`${REGISTRY}/api/agents/${NS}/${STORAGE_PROBE}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundleOfSize(STORAGE_MB * 1024 * 1024 + 1, STORAGE_PROBE)),
    });
    const bigError = await errorOf(big);
    const probe = await fetch(`${REGISTRY}/api/agents/${NS}/${STORAGE_PROBE}`, { headers: bearer });
    record(
      "storage: a push past the account's bundle storage is refused 413 STORAGE_QUOTA_EXCEEDED, and no agent is created for it",
      big.status === 413 && bigError.code === "STORAGE_QUOTA_EXCEEDED" && probe.status === 404,
      `${seen(big, bigError.code)} message="${bigError.message ?? ""}" agent_after=${probe.status}`,
    );

    // ── 3. Live uploads: the account's one place, taken then freed ──────
    const uploadFirst = await uploadProbe();
    const firstUpload = await uploaded(uploadFirst);
    const uploadSecond = await uploadProbe();
    const secondError = await errorOf(uploadSecond);
    const expectedWait = firstUpload.expiresAt
      ? Math.ceil((Date.parse(firstUpload.expiresAt) - Date.now()) / 1000)
      : Number.NaN;
    const uploadWait = Number(uploadSecond.headers.get("retry-after"));
    record(
      "uploads: with the account's one live upload taken, the next is refused 429 INPUT_FILES_LIMIT_REACHED, told to wait until the first expires",
      uploadFirst.status === 201 &&
        uploadSecond.status === 429 &&
        secondError.code === "INPUT_FILES_LIMIT_REACHED" &&
        Math.abs(uploadWait - expectedWait) <= 2,
      `first: code=${uploadFirst.status} expires_at=${firstUpload.expiresAt ?? "none"} | second: ${seen(uploadSecond, secondError.code)} expected_retry_after≈${expectedWait} message="${secondError.message ?? ""}"`,
    );
    const freed = await deleteUpload(firstUpload.fileId);
    const uploadAgain = await uploadProbe();
    const again = await uploaded(uploadAgain);
    await deleteUpload(again.fileId);
    record(
      "uploads: once the first upload is deleted, an upload is taken again",
      freed?.status === 204 && uploadAgain.status === 201,
      `delete=${freed?.status ?? "none"} upload=${uploadAgain.status}`,
    );

    const window = await waitForWindow();
    const resets = new Set<string>();
    /** The fast-run headers any answer of the phase carried: none is expected without a pool. */
    const fastHeaders = new Set<string>();
    const noteReset = (res: Response | undefined) => {
      const reset = res?.headers.get("x-quota-compute-reset");
      if (reset) resets.add(reset);
      for (const [name, value] of res?.headers.entries() ?? []) {
        if (name.startsWith("x-quota-fast-runs-")) fastHeaders.add(`${name}=${value}`);
      }
    };
    /** The ids of the runs admitted, as their streams or answers named them. */
    const admittedIds: string[] = [];

    // ── 4. Two streamed runs at once: one seat ─────────────────────────
    const pair = await Promise.all([postRun("sse"), postRun("sse")]);
    const admitted = pair.find((res) => res.status === 200);
    const refused = pair.find((res) => res !== admitted);
    const refusal = refused && refused.status !== 200 ? await errorOf(refused) : {};
    // A second stream, were both admitted, is not read: closed, so it holds nothing.
    if (refused?.status === 200) await refused.body?.cancel();
    noteReset(admitted);
    noteReset(refused);
    record(
      "seats: of two streamed runs sent at once, one is admitted and the other refused 429 CONCURRENCY_LIMIT_REACHED",
      pair.filter((res) => res.status === 200).length === 1 &&
        refused?.status === 429 &&
        refusal.code === "CONCURRENCY_LIMIT_REACHED" &&
        refused.headers.get("retry-after") === "10" &&
        refused.headers.get("x-quota-runs-limit") === String(SEATS) &&
        refused.headers.get("x-quota-runs-remaining") === "0",
      `admitted: ${seen(admitted)} | refused: ${seen(refused, refusal.code)} message="${refusal.message ?? ""}"`,
    );
    record(
      "seats: the admitted run holds the only seat, and starts the window with all its compute",
      admitted?.headers.get("x-quota-runs-remaining") === "0" &&
        admitted.headers.get("x-quota-compute-limit") === String(COMPUTE_S) &&
        admitted.headers.get("x-quota-compute-remaining") === String(COMPUTE_S),
      seen(admitted),
    );
    if (!admitted) return;

    // ── 5. The next run, sent on the admitted run's final event ─────────
    let third: Response | undefined;
    const first = await drain(admitted, async () => {
      third = await postRun("sse");
    });
    if (first.runId) admittedIds.push(first.runId);
    const thirdRead = third?.status === 200 ? await drain(third) : null;
    const thirdError = third && third.status !== 200 ? await errorOf(third) : {};
    if (thirdRead?.runId) admittedIds.push(thirdRead.runId);
    noteReset(third);
    record(
      "seats: a run sent the moment the admitted run's final event arrives is admitted",
      third?.status === 200 && thirdRead?.final === "run_complete",
      `${seen(third, thirdError.code)} first_final=${first.final} third_events=[${thirdRead?.names.join(",") ?? ""}]`,
    );

    // ── 6. Runs in series until the window's compute is spent ───────────
    const series: string[] = [];
    let spent: Response | undefined;
    let windowRanOut = false;
    for (let i = 0; i < SERIES_MAX; i++) {
      if (Date.now() > window.endMs - WINDOW_END_GUARD_MS) {
        windowRanOut = true;
        break;
      }
      const res = await postRun("sync");
      noteReset(res);
      if (res.status !== 200) {
        spent = res;
        break;
      }
      const body = (await res.json().catch(() => ({}))) as { run_id?: string; status?: string };
      if (body.run_id) admittedIds.push(body.run_id);
      series.push(`#${i + 1} ${body.status} ${seen(res)}`);
    }
    const spentError = spent ? await errorOf(spent) : {};
    const nowS = Math.floor(Date.now() / 1000);
    const reset = Number(spent?.headers.get("x-quota-compute-reset"));
    const retryAfter = Number(spent?.headers.get("retry-after"));
    record(
      "compute: runs in series are admitted while the window has compute left",
      !windowRanOut && spent !== undefined,
      `runs=${series.length} [${series.join("; ")}]${windowRanOut ? " — the window ran out first" : ""}`,
    );
    record(
      "compute: then a run is refused 429 COMPUTE_QUOTA_EXCEEDED, told to wait until the window ends",
      spent?.status === 429 &&
        spentError.code === "COMPUTE_QUOTA_EXCEEDED" &&
        spent.headers.get("x-quota-compute-remaining") === "0" &&
        retryAfter >= 1 &&
        retryAfter <= WINDOW_S &&
        Math.abs(retryAfter - (reset - nowS)) <= 2,
      `${seen(spent, spentError.code)} expected_retry_after≈${reset - nowS} message="${spentError.message ?? ""}"`,
    );
    record(
      "compute: every answer of the phase names the same window",
      resets.size === 1 && [...resets][0] === String(window.endMs / 1000),
      `x-quota-compute-reset=[${[...resets].join(",")}] window_end=${window.endMs / 1000}`,
    );

    // ── 7. The account reads its own usage ──────────────────────────────
    const usageRes = await fetch(`${REGISTRY}/api/usage`, { headers: bearer });
    const usage = (await usageRes.json().catch(() => ({}))) as {
      plan?: string;
      quotas?: {
        concurrent_runs: { limit: number; in_use: number } | null;
        compute: {
          limit_seconds: number;
          used_seconds: number;
          window: { start: string; end: string };
        } | null;
        fast_runs: unknown;
      } | null;
    };
    const quotas = usage.quotas ?? null;
    record(
      "usage: GET /api/usage tells the account its numbers — its seat free, the window's compute spent — and, no runner pool running, no fast runs",
      usageRes.status === 200 &&
        usage.plan === "free" &&
        quotas?.concurrent_runs?.limit === SEATS &&
        quotas.concurrent_runs.in_use === 0 &&
        quotas.compute?.limit_seconds === COMPUTE_S &&
        quotas.compute.used_seconds >= COMPUTE_S &&
        quotas.compute.window.end === new Date(window.endMs).toISOString() &&
        quotas.fast_runs === null &&
        fastHeaders.size === 0,
      `code=${usageRes.status} plan=${usage.plan ?? "none"} concurrent_runs=${JSON.stringify(quotas?.concurrent_runs)} compute=${JSON.stringify(quotas?.compute)} fast_runs=${JSON.stringify(quotas?.fast_runs)} fast_headers=[${[...fastHeaders].join(",")}]`,
    );

    // ── 8. The rows ─────────────────────────────────────────────────────
    db = openRegistryDb();
    if (!db) {
      record("rows: the registry's database is readable", false, "no database to read");
      return;
    }
    try {
      const rows = await db.all(
        "SELECT id, status, deadline_at, charged_ms FROM runs WHERE user_id = ? ORDER BY created_at",
        [id],
      );
      const charged = rows.map((row) => (row.charged_ms === null ? null : Number(row.charged_ms)));
      const sum = charged.reduce<number>((total, ms) => total + (ms ?? 0), 0);
      const ids = rows.map((row) => String(row.id)).sort();
      record(
        "rows: one finished row per admitted run, none for a refused one, each with its deadline and its charged time",
        ids.length === admittedIds.length &&
          ids.every((rowId, i) => rowId === [...admittedIds].sort()[i]) &&
          rows.every((row) => row.status !== "running" && row.deadline_at !== null) &&
          charged.every((ms) => ms !== null) &&
          sum >= COMPUTE_S * 1000,
        `db=${db.kind} rows=${rows.length} admitted=${admittedIds.length} statuses=[${rows.map((row) => row.status).join(",")}] charged_ms=[${charged.join(",")}] sum=${sum}`,
      );
    } catch (err) {
      record("rows: the phase's runs read from the database", false, queryFailure(err));
    }
  } catch (err) {
    record(
      "the quota phase",
      false,
      err instanceof Error ? err.message.slice(0, 300) : String(err),
    );
  } finally {
    await deleteOwnAccount().catch(() => {});
    await db?.close().catch(() => {});
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore temp-dir cleanup errors
      }
    }
    // The registry again as every other phase knows it: no quota set.
    stopRegistry();
    try {
      await startRegistry();
      record("the registry runs again without the quota settings", true, "health=ok");
    } catch (err) {
      record(
        "the registry runs again without the quota settings",
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
