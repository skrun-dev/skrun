/**
 * The runs this process is serving, and how a stop of the server ends them.
 *
 * Three stocks, all in this process's memory and nowhere else — a restart
 * loses them by construction, and a second instance has its own:
 *
 * - **the admissions under way**: a run whose row is being written, not yet
 *   registered (`beginAdmission`, by the run route, ended in a `finally` once
 *   the run is registered, refused, or its write has failed);
 * - **the runs in flight**: every run is registered once its row is written
 *   (`registerInFlightRun`, by the run route) and leaves once it has
 *   **settled** — its final status written or given up on, its hold given
 *   back, and on the cloud runtime its machine destroyed. The entry is the
 *   run's claim on its final status (`FinalStatusClaim`), which `finalizeRun`
 *   moves, and the controller whose signal the run's adapter is handed with
 *   its caller's. It also watches the run's seat's deadline (*the deadline*,
 *   below);
 * - **the detached clean-ups**: work a run leaves going after it has ended,
 *   and that the stop waits for within its grace (`trackBackgroundCleanup`).
 *   Each leaves the set as it ends, whichever way.
 *
 * The stop (`shutdownInFlightRuns`), in this order: every run still without a
 * final status is abandoned — its controller aborted, its claim marked
 * (`reason: "shutdown"`), which makes every failure of it that follows the
 * stop's (`finalizeRun`), charged nothing; a short drain, `SHUTDOWN_DRAIN_MS`, lets the runs
 * that answer end by themselves; every run still without a final status then
 * gets the stop's failure at once, `SHUTDOWN_RUN_ERROR`, as a provisional
 * one — the row is right a few seconds after the signal, and a completion that
 * comes before the process exits still replaces it; last, the wait: the
 * provisional writes, the admissions under way, the runs settling, then the
 * clean-ups, read again until all are empty — the run of an admission that
 * ends while the stop waits, and a clean-up a run hands over then, are waited
 * for too —, until `SHUTDOWN_GRACE_MS` after the signal at most. On the cloud
 * runtime the stop holds the pool too (`StoppablePool`): its maintenance is
 * stopped first, before any run is abandoned, and last, within what is left of
 * the grace, the ready machines this process holds are destroyed. The signal
 * handlers that call it, and exit after it, are `installShutdownHandlers`.
 *
 * A stop lasts until the process exits: once begun, it is never over for the
 * process (`isServerStopping`). The run route refuses a run sent from then on
 * before writing its row — a connection kept alive across the signal still
 * carries requests after the server's close. A run whose row was being written
 * as the stop began still reaches the registry — the stop waits for its
 * admission —: abandoned at once, and, past the drain, given the stop's
 * provisional failure at once too.
 *
 * The deadline. A run registered with its seat's deadline (`deadlineAt`, the
 * `deadline_at` its admission wrote) has a timer armed for it: past that
 * instant the run holds no seat and charges nothing, so the process must not
 * serve it any longer. A run still in flight then — a streamed run whose
 * caller stopped reading waits on its write, and nothing of it moves on, its
 * timeout included — is stopped: the deadline's failure written if it has no
 * final status yet, its controller aborted, and its stream closed
 * `DEADLINE_STREAM_GRACE_MS` later if it has not settled by then (`expire`).
 * The timer is a chain of links of at most `MAX_TIMER_DELAY_MS`; neither it
 * nor the stream's holds the process up, and both are cleared when the run
 * settles.
 */
import {
  createLogger,
  type Logger,
  MAX_TIMER_DELAY_MS,
  type MachineSpawnPhase,
  type RunnerPool,
} from "@skrun-dev/runtime";
import { type DbAdapter, SHUTDOWN_RUN_ERROR } from "../db/adapter.js";
import {
  type FinalClaimState,
  type FinalizeRunResult,
  type FinalStatusClaim,
  finalizeRun,
  RUN_DEADLINE_ERROR,
} from "../routes/_helpers.js";
import { errorFields } from "../utils/error-fields.js";
import type { RuntimeMode } from "./adapter-selection.js";

/**
 * The longest delay a timer of this process accepts, in ms (2^31 − 1): Node
 * arms a longer one for 1 ms. A deadline further away is reached by a chain of
 * timers, each at most this long. The runtime's, re-exported for this module's
 * readers: one value for the seat's hold, the deadline's chain and a machine's
 * lifetime.
 */
export { MAX_TIMER_DELAY_MS };

/**
 * How long a run stopped at its deadline has, from it, to send its final event
 * to a caller who reads and to settle, before its stream is closed: the write
 * a caller who stopped reading holds is let go then, and the run ends.
 */
export const DEADLINE_STREAM_GRACE_MS = 10_000;

/**
 * The reason a run's controller is aborted with when its seat's deadline came
 * while it was in flight — neither the server's stop (an abort with no reason)
 * nor the caller's hang-up (its own signal).
 */
export class RunDeadlineReached extends Error {
  constructor() {
    super(RUN_DEADLINE_ERROR);
    this.name = "RunDeadlineReached";
  }
}

/** How long the stop lets abandoned runs end by themselves before it writes their failure. */
export const SHUTDOWN_DRAIN_MS = 3_000;

/**
 * How long the stop waits in all, from its signal, for the runs to settle and
 * the clean-ups to end: under the platform's `kill_timeout` (30 s) and the
 * compose stack's `stop_grace_period` (30 s).
 */
export const SHUTDOWN_GRACE_MS = 20_000;

/** What a run's entry needs to write the stop's failure into it. */
export interface InFlightRunInit {
  runId: string;
  db: DbAdapter;
  /** The run's logger. */
  log: Logger;
  mode: "sse" | "webhook" | "sync";
  runtimeMode: RuntimeMode;
  /**
   * The instant the run was admitted — its row's creation: its charged time
   * counts from it. A run registered without it is written no charged time,
   * save the zeros of the stop's path and of a machine that never got ready,
   * which are decided without it.
   */
  admittedAt?: Date;
  /**
   * The instant the run's seat expires — the deadline its admission wrote
   * (`runs.deadline_at`). A run still in flight then is stopped
   * (`InFlightRun`, *the deadline*). Absent, no deadline is watched.
   */
  deadlineAt?: Date;
}

/** A run in flight: its claim on its final status, the controller of its signal, its settling. */
export class InFlightRun implements FinalStatusClaim {
  readonly runId: string;
  /**
   * Aborted by the stop, and at the run's deadline: the run's adapter is
   * handed its signal, with its caller's.
   */
  readonly controller = new AbortController();
  /**
   * Set by the stop's abandon: every failure of the run from then on is the
   * stop's, charged nothing — its provisional failure included. Or set at the
   * run's deadline, as the deadline's failure is written.
   */
  reason?: "shutdown" | "deadline";
  readonly admittedAt?: Date;
  spawnFailure?: { phase: MachineSpawnPhase | undefined };
  /** Resolved once the run has settled, and has left the registry. */
  readonly settled: Promise<void>;
  /** Resolved once the run's claim has left `none`: the drain waits for nothing more of it. */
  readonly claimed: Promise<void>;
  private state: FinalClaimState = "none";
  private isSettled = false;
  private resolveSettled: () => void = () => {};
  private resolveClaimed: () => void = () => {};
  private readonly init: InFlightRunInit;
  /** The timer armed for the deadline, or for the next link of its chain. */
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** The timer that closes the run's stream, `DEADLINE_STREAM_GRACE_MS` after the deadline. */
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the run's stream was closed by its deadline. */
  private streamClosed = false;
  /** What closes the run's stream. */
  private readonly closers: Array<() => void> = [];

  constructor(init: InFlightRunInit) {
    this.init = init;
    this.runId = init.runId;
    this.admittedAt = init.admittedAt;
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    this.claimed = new Promise<void>((resolve) => {
      this.resolveClaimed = resolve;
    });
    if (init.deadlineAt !== undefined) this.armDeadline(init.deadlineAt.getTime());
  }

  get claim(): FinalClaimState {
    return this.state;
  }

  set claim(next: FinalClaimState) {
    this.state = next;
    if (next !== "none") this.resolveClaimed();
  }

  /**
   * The run has ended, for this process: its final status written or given
   * up on, its hold given back, its machine destroyed. Called once, by the
   * outermost `finally` of the run; a second call does nothing.
   */
  settle(): void {
    if (this.isSettled) return;
    this.isSettled = true;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.closers.length = 0;
    if (runs.get(this.runId) === this) runs.delete(this.runId);
    this.resolveSettled();
  }

  /**
   * What closes the stream the run's caller reads: called
   * `DEADLINE_STREAM_GRACE_MS` after the deadline if the run has not settled
   * by then — at once if that has already passed. A write the stream waits on
   * is then let go, and the run moves on to its end.
   */
  closeAtDeadline(close: () => void): void {
    if (this.isSettled) return;
    if (this.streamClosed) {
      runCloser(close, this.init.log, this.runId);
      return;
    }
    this.closers.push(close);
  }

  /**
   * One link of the deadline's chain: a timer at most `MAX_TIMER_DELAY_MS`
   * long, which arms the next one while the deadline is still ahead. It
   * holds the process up for nothing (`unref`), and `settle` clears it.
   */
  private armDeadline(deadlineMs: number): void {
    const delay = Math.max(0, deadlineMs - Date.now());
    this.deadlineTimer = setTimeout(
      () => {
        this.deadlineTimer = undefined;
        if (deadlineMs > Date.now()) this.armDeadline(deadlineMs);
        else this.expire();
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.deadlineTimer.unref?.();
  }

  /**
   * The deadline came while the run was in flight — whatever its seat says, it
   * no longer holds one, and a run the process still serves must not outlive
   * it. A run without a final status gets the deadline's failure, written as
   * any final status (`finalizeRun`), charged from its admission — the caller
   * stalled, not the server — and marked before it, so that every end of the
   * run that follows is told as that failure; a run that has one, or the
   * stop's provisional failure, keeps it. Either way the run is stopped: its
   * controller aborted (`RunDeadlineReached`), so that its adapter comes to
   * its end — the cloud one destroying its machine — and a caller who reads
   * gets its final event; and, `DEADLINE_STREAM_GRACE_MS` later if it has not
   * settled by then, its stream closed — a write that waits on a caller who
   * stopped reading let go. The write is handed to the stop as a clean-up: a
   * stop waits for it within its grace.
   */
  private expire(): void {
    if (this.isSettled) return;
    const { db, log, mode, runtimeMode } = this.init;
    const writes = this.state === "none" && this.reason === undefined;
    log.warn(
      { event: "run_deadline_reached", run_id: this.runId, claim: this.state, written: writes },
      "A run was still in flight at its deadline: it is stopped",
    );
    if (writes) {
      this.reason = "deadline";
      trackBackgroundCleanup(
        finalizeRun(db, log, this.runId, this, {
          status: "failed",
          error: RUN_DEADLINE_ERROR,
          now: new Date(),
          mode,
          runtimeMode,
        }).catch((err) => {
          // The write's own failure is finalizeRun's line; this is anything else it threw.
          log.error(
            { event: "run_deadline_write_failed", run_id: this.runId, ...errorFields(err) },
            "The failure of a run stopped at its deadline could not be recorded; the run may remain in 'running' state",
          );
        }),
      );
    }
    this.controller.abort(new RunDeadlineReached());
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.streamClosed = true;
      for (const close of this.closers.splice(0)) runCloser(close, log, this.runId);
    }, DEADLINE_STREAM_GRACE_MS);
    this.closeTimer.unref?.();
  }

  /** The stop abandons the run, if it has no final status yet; whether it did. */
  abandonForShutdown(): boolean {
    if (this.reason === "shutdown" || this.state !== "none") return false;
    // Marked before the abort: what the abort sets off finds the run abandoned.
    this.reason = "shutdown";
    this.controller.abort();
    return true;
  }

  /** The stop's provisional failure, through the one function that writes a final status. */
  writeProvisionalFailure(): Promise<FinalizeRunResult | null> {
    const { db, log, mode, runtimeMode } = this.init;
    return finalizeRun(db, log, this.runId, this, {
      status: "failed",
      error: SHUTDOWN_RUN_ERROR,
      provisional: true,
      now: new Date(),
      mode,
      runtimeMode,
    }).catch((err) => {
      // The write's own failure is finalizeRun's line; this is anything else it threw.
      log.error(
        { event: "shutdown_provisional_write_failed", run_id: this.runId, ...errorFields(err) },
        "The stop's provisional failure of a run could not be recorded; the run may remain in 'running' state",
      );
      return null;
    });
  }
}

/** A run's stream closed at its deadline: a closer that throws is a line, never an escape. */
function runCloser(close: () => void, log: Logger, runId: string): void {
  try {
    close();
  } catch (err) {
    log.error(
      { event: "run_deadline_close_failed", run_id: runId, ...errorFields(err) },
      "The stream of a run stopped at its deadline could not be closed",
    );
  }
}

const runs = new Map<string, InFlightRun>();
const cleanups = new Set<Promise<unknown>>();
/** The admissions under way, each the promise its end resolves. */
const admissions = new Set<Promise<void>>();
/** Whether the stop has begun: never cleared in a process. */
let stopBegun = false;
/** The stop, once begun. */
let stopping: Promise<ShutdownSummary> | undefined;
/** Whether the stop is still under way: begun, not returned yet. */
let stopUnderWay = false;
/** Whether the stop's drain is over: from then on, a run without a final status gets the stop's failure at once. */
let provisionalBegun = false;
/** The stop's provisional writes — at the drain's end, and for every run registered after it. */
const provisionalWrites: Array<Promise<FinalizeRunResult | null>> = [];
/** Of those, the writes that landed. */
let provisionalWritten = 0;

/** The stop's provisional failure for `run`, its write kept for the stop to wait for and count. */
function writeProvisional(run: InFlightRun): void {
  const write = run.writeProvisionalFailure();
  provisionalWrites.push(write);
  void write.then((result) => {
    if (result?.written === true) provisionalWritten++;
  });
}

/**
 * Whether the server's stop has begun — in which case it lasts until the
 * process exits. The run route refuses a run while it does.
 */
export function isServerStopping(): boolean {
  return stopBegun;
}

/**
 * Count an admission under way — a run whose row is being written, and which
 * reaches the registry only once it is: the stop waits for it within its
 * grace. Begun with no wait since the route's last look at the stop; the
 * function returned ends it, once the run is registered, refused, or its write
 * has failed — called in a `finally`, never left armed: the stop would wait
 * for it its whole grace. A second call does nothing.
 */
export function beginAdmission(): () => void {
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  admissions.add(ended);
  return () => {
    if (!admissions.delete(ended)) return;
    resolveEnded();
  };
}

/** How many admissions are under way. */
export function admissionCount(): number {
  return admissions.size;
}

/**
 * Register a run whose row has just been written. A run registered once the
 * stop has begun is abandoned at once — a run whose row was being written as
 * the stop began —, and, once the stop's drain is over, given the stop's
 * provisional failure at once: no later step of the stop would write it.
 */
export function registerInFlightRun(init: InFlightRunInit): InFlightRun {
  const run = new InFlightRun(init);
  runs.set(run.runId, run);
  if (stopBegun) {
    run.abandonForShutdown();
    if (provisionalBegun) writeProvisional(run);
  }
  return run;
}

/**
 * For tests only: forget a stop, as a new process would. Never called by the
 * server. Refused while a stop is still under way — left running, it would
 * write its provisional failures on the runs of whatever comes next.
 */
export function _resetShutdownForTests(): void {
  if (stopUnderWay) {
    throw new Error("A stop is still under way: await it before resetting the stop's state");
  }
  stopBegun = false;
  stopping = undefined;
  provisionalBegun = false;
  provisionalWrites.length = 0;
  provisionalWritten = 0;
}

/** The ids of the runs in flight, oldest first. */
export function inFlightRunIds(): string[] {
  return [...runs.keys()];
}

/**
 * Hand the stop a clean-up a run leaves going after it has ended: the stop
 * waits for it within its grace. It leaves the set as it ends, resolved or
 * rejected; a rejection is the clean-up's own to log — it never escapes here.
 */
export function trackBackgroundCleanup(cleanup: Promise<unknown>): void {
  cleanups.add(cleanup);
  const done = () => {
    cleanups.delete(cleanup);
  };
  cleanup.then(done, done);
}

/** How many detached clean-ups are still going. */
export function backgroundCleanupCount(): number {
  return cleanups.size;
}

/** What a stop did, for its log line. Counts, and a duration. */
export interface ShutdownSummary {
  /** Runs registered when the stop began. */
  in_flight: number;
  /** Admissions under way when the stop began: their runs were not registered yet. */
  admitting: number;
  /** Of those, the runs without a final status, abandoned. */
  abandoned: number;
  /**
   * Runs given the stop's provisional failure once the drain was over — a run
   * registered after it included —, its write landed.
   */
  finalized: number;
  /** How long the drain lasted, from the stop's start. */
  drained_ms: number;
  /** Runs still not settled when the stop returned: its grace was over. */
  unsettled: number;
  /** Admissions still under way when the stop returned: its grace was over. */
  admissions_pending: number;
  /** Detached clean-ups still going when the stop returned. */
  cleanups_pending: number;
  /** With a pool: its ready machines the stop destroyed. */
  pool_destroyed?: number;
  /**
   * With a pool: its ready machines whose destruction failed, or that the
   * grace's end cut — left billing until another process's reconciliation ends
   * them: past the idle limit, or at the first pass of a process parked at 0 or
   * on another image. A pooled machine declares no lifetime.
   */
  pool_destroy_failed?: number;
}

/**
 * What the stop needs of the cloud runtime's pool: its maintenance stopped, and
 * the ready machines it holds destroyed within a signal — `RunnerPool`'s own.
 */
export type StoppablePool = Pick<RunnerPool, "stop" | "destroyOwnReady">;

/**
 * Stop the runs this process serves — the order is the module's header's.
 * Returns once every admission under way has ended, every run has settled and
 * every clean-up has ended — and, with a pool, its ready machines are
 * destroyed —, or at the grace's end, whichever is first; no timer of its own
 * is left armed. The stop then stays for the process's life: a later call is
 * that same stop, and hands back what it did.
 *
 * What the pool's background work leaves going is not waited for — a fill in
 * progress, the search for the machine of a fill its bound cut: the
 * reconciliation of another process takes what it leaves, on the platform's
 * state and age alone — a pooled machine declares no lifetime.
 */
export function shutdownInFlightRuns(
  options: { drainMs?: number; graceMs?: number; pool?: StoppablePool } = {},
): Promise<ShutdownSummary> {
  if (stopping) return stopping;
  // Begun before its first step: what the abandon sets off already finds the server stopping.
  stopBegun = true;
  stopUnderWay = true;
  stopping = stop(options).finally(() => {
    stopUnderWay = false;
  });
  return stopping;
}

async function stop({
  drainMs = SHUTDOWN_DRAIN_MS,
  graceMs = SHUTDOWN_GRACE_MS,
  pool,
}: {
  drainMs?: number;
  graceMs?: number;
  pool?: StoppablePool;
}): Promise<ShutdownSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + graceMs;
  // The pool's maintenance first: no pass, no fill, no top-up from here on.
  pool?.stop();
  const atSignal = [...runs.values()];
  const admittingAtSignal = admissions.size;

  // Every run without a final status is abandoned.
  let abandoned = 0;
  for (const run of atSignal) {
    if (run.abandonForShutdown()) abandoned++;
  }

  // The drain: until every run has a final status or has settled, or its bound.
  await within(
    Math.min(drainMs, graceMs),
    Promise.all(atSignal.map((run) => Promise.race([run.claimed, run.settled]))),
  );
  const drainedMs = Date.now() - startedAt;

  // The stop's provisional failure, at once, for every run still without a
  // final status — and, from here on, for every run registered late.
  provisionalBegun = true;
  for (const run of [...runs.values()]) {
    if (run.claim === "none") writeProvisional(run);
  }

  // The wait, within what is left of the grace: the provisional writes, then
  // the admissions under way, then the runs settling, then the clean-ups, read
  // again until all are empty.
  await waitUntil(deadline, async (graceOver) => {
    for (;;) {
      // A write added meanwhile is a late run's: the runs' wait below covers it,
      // and the next turn reads the writes again.
      if ((await graceOver(Promise.all([...provisionalWrites]))) === undefined) return;
      // An admission ends once its run is registered — abandoned, and given
      // the provisional failure, the drain being over —, or refused: the next
      // turn reads that run with the others.
      const pendingAdmissions = [...admissions];
      if (pendingAdmissions.length > 0) {
        if ((await graceOver(Promise.all(pendingAdmissions))) === undefined) return;
        continue;
      }
      const pendingRuns = [...runs.values()].map((run) => run.settled);
      if (pendingRuns.length > 0) {
        if ((await graceOver(Promise.all(pendingRuns))) === undefined) return;
        continue;
      }
      const pendingCleanups = [...cleanups];
      if (pendingCleanups.length > 0) {
        if ((await graceOver(Promise.allSettled(pendingCleanups))) === undefined) return;
        continue;
      }
      return;
    }
  });

  // Last, once the runs are done with their machines: the pool's ready
  // machines, within what is left of the grace.
  const destroyed = pool ? await destroyReadyWithin(pool, deadline) : undefined;

  return {
    in_flight: atSignal.length,
    admitting: admittingAtSignal,
    abandoned,
    finalized: provisionalWritten,
    drained_ms: drainedMs,
    unsettled: runs.size,
    admissions_pending: admissions.size,
    cleanups_pending: cleanups.size,
    ...(destroyed && {
      pool_destroyed: destroyed.destroyed,
      pool_destroy_failed: destroyed.failed,
    }),
  };
}

/**
 * The pool's ready machines destroyed under a signal that aborts at `deadline`
 * — at once when it has passed. Its timer holds the process up for nothing,
 * and is cleared however the destructions end.
 */
async function destroyReadyWithin(
  pool: StoppablePool,
  deadline: number,
): Promise<{ destroyed: number; failed: number }> {
  const left = new AbortController();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) left.abort();
  const timer = setTimeout(() => left.abort(), Math.max(0, remainingMs));
  timer.unref?.();
  try {
    return await pool.destroyOwnReady(left.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** `work`, or `ms` — whichever ends first; the timer cleared either way. */
async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `body` until `deadline`: `graceOver(p)` resolves to `p`'s value, or to
 * undefined once the deadline has passed. One timer for the whole wait,
 * cleared however it ends.
 */
async function waitUntil(
  deadline: number,
  body: (graceOver: <T>(work: Promise<T>) => Promise<T | undefined>) => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
  });
  try {
    await body((work) => Promise.race([work, over]));
  } finally {
    clearTimeout(timer);
  }
}

/** The HTTP server, as the stop needs it: no new connection once it begins. */
export interface StoppableServer {
  close(callback?: (err?: Error) => void): unknown;
  /** Present on Node's HTTP servers: drops the keep-alive connections no request is using. */
  closeIdleConnections?: () => void;
}

/** What the signal handlers listen on and exit through: the process, unless a test hands its own. */
export interface ShutdownProcess {
  on(signal: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

/**
 * Stop the server on `SIGTERM` (a deploy, `docker compose stop`) and `SIGINT`
 * (Ctrl+C), in this order: the server takes no new connection; the runs in
 * flight are stopped (`shutdownInFlightRuns`, whose order is the module's
 * header's); a line says what the stop did (`server_shutdown`); the responses
 * still on their way get what is left of the grace to go out — the idle
 * connections dropped, the server's close waited for; the log flushed; the
 * process exits 0. A second signal during the stop exits at once, 1. No
 * variable sets any of it. Called by both entry points, `server.ts` and
 * `dev.ts`, with the server their `serve()` returned and the pool of the
 * runtime they run — on the cloud runtime, the stop stops its maintenance and
 * destroys its ready machines; on the local one there is none.
 */
export function installShutdownHandlers({
  server,
  pool,
  log = createLogger("api"),
  proc = process,
  drainMs = SHUTDOWN_DRAIN_MS,
  graceMs = SHUTDOWN_GRACE_MS,
}: {
  server: StoppableServer;
  pool?: StoppablePool;
  log?: Logger;
  proc?: ShutdownProcess;
  drainMs?: number;
  graceMs?: number;
}): void {
  let begun = false;
  /** The last lines out first: the default destination writes asynchronously. */
  const exitAfterFlush = (code: number): void => {
    if (typeof log.flush !== "function") {
      proc.exit(code);
      return;
    }
    try {
      log.flush(() => proc.exit(code));
    } catch {
      // A destination that cannot flush: the exit does not wait for it.
      proc.exit(code);
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (begun) {
      log.warn(
        { event: "server_shutdown_forced", signal },
        "A second signal during the stop: the server exits now",
      );
      proc.exit(1);
      return;
    }
    begun = true;
    const startedAt = Date.now();
    log.info(
      { event: "server_stopping", signal, in_flight: runs.size },
      "The server is stopping: no new connection, the runs in flight are being ended",
    );
    let closed = false;
    const serverClosed = new Promise<void>((resolve) => {
      try {
        server.close(() => {
          closed = true;
          resolve();
        });
      } catch {
        // Not listening: nothing to wait for.
        closed = true;
        resolve();
      }
    });
    void shutdownInFlightRuns({ drainMs, graceMs, pool })
      .then(async (summary) => {
        log.info(
          { event: "server_shutdown", signal, ...summary },
          "The server stopped its runs in flight; it exits",
        );
        // The last responses go out on connections that end with them; the
        // idle ones are dropped. Within what is left of the grace, at most.
        if (!closed) {
          server.closeIdleConnections?.();
          await within(startedAt + graceMs - Date.now(), serverClosed);
        }
        exitAfterFlush(0);
      })
      .catch((err) => {
        log.error(
          { event: "server_shutdown_failed", ...errorFields(err) },
          "The stop of the server failed; it exits",
        );
        exitAfterFlush(1);
      });
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
}
