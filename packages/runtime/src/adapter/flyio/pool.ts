import { randomBytes } from "node:crypto";
import { MachineSpawnError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import { createLogger } from "../../logger.js";
import { HealthzResultSchema, type InfraHostsCheck } from "../../runner-contract.js";
import { errorFields } from "../../utils/error-fields.js";
import {
  CUT_CREATE_STEP_MS,
  STEP_CUT,
  searchCutCreation,
  withinStep,
} from "./cut-creation-search.js";
import {
  type CreateProgress,
  createWorstCaseMs,
  FLY_ATTEMPT_TIMEOUT_MS,
  type FlyMachinesApi,
  type Machine,
  type MachineDestroyOutcome,
  type MachineGuest,
  type MachineState,
  POOL_LABEL_KEY,
} from "./fly-api.js";
import {
  buildPoolMachineConfig,
  machineNameForPool,
  POOL_MACHINE_NAME_PREFIX,
} from "./machine-config.js";
import { declaredLifetimeEndMs, runLabelOf } from "./machine-lifetime.js";
import {
  callRunner,
  discardRunnerBody,
  RUNNER_CALL_BOUNDS,
  RunnerBodyTimeout,
  RunnerResponseTooLarge,
  readRunnerJson,
} from "./runner-call.js";
import { buildRunnerBaseUrl } from "./runner-url.js";

/**
 * Pre-warm pool of runner machines.
 *
 * WHY IT EXISTS
 * Creating a machine per run means paying, on the caller's request, for the image
 * to be materialised on a cold host and for the runner to start — the dominant part
 * of a cold start, and a cost that grows with the image rather than shrinking with
 * tuning. A machine can instead be created, booted and suspended ahead of time, so a
 * run wakes one in about a second and those costs are paid in the background.
 *
 * THE INVARIANT THIS MODULE PROTECTS
 * A pooled machine is **blank**: created, booted, never assigned to anything. It
 * serves exactly one run and is then destroyed, never returned to the pool. A stock
 * of never-used machines is not a stock of recycled ones, and that distinction is
 * the whole reason the pool is compatible with a single-use sandbox model.
 *
 * FLY IS THE SOURCE OF TRUTH, THIS MAP IS A CACHE
 * Machines are discoverable from the platform by name prefix, and their platform
 * state is visible to every process. This registry is a local view for fast
 * decisions; anything that DESTROYS a machine must consult the platform's own state
 * instead, because another instance of this process may legitimately be using a
 * machine this one has never heard of.
 */

/** Where a machine is in its short life, from this process's point of view. */
export type PooledMachineState =
  /** Being created, booted and suspended. Never offered to a run. */
  | "filling"
  /** Suspended and verified — the only state a run may take. */
  | "ready"
  /** Taken by a run. It will be destroyed at the end of that run, never reused. */
  | "claimed"
  /** Being disposed of (stale, over capacity, expired). Not offerable. */
  | "draining";

export interface PooledMachine {
  machineId: string;
  /** Private address the harness reaches the runner on. */
  privateIp: string;
  /** Per-machine credential authorising exactly one assignment. Dies with the machine. */
  claimToken: string;
  /** Image this machine was created from — compared against the configured tag to spot staleness. */
  imageTag: string;
  /** The harness address baked into its firewall rules; undefined off-platform. */
  harness6pn: string | undefined;
  /**
   * When this process registered it, by its own clock. Used for expiry, and to
   * tell a listing sent before it from one that should list it.
   * **Never** for deciding whether a machine is safe to destroy: a pooled machine
   * is old by design, so age says nothing about whether a run is using it.
   */
  createdAt: number;
  /**
   * Identifies the runner process this machine was paused with, as it reported
   * itself when it became ready. Compared against the value returned at
   * assignment to tell a genuine wake from a silent cold boot. Undefined against
   * a runner image too old to report one, in which case the question is answered
   * "unknown" rather than guessed at.
   */
  processId?: string;
  /**
   * How many listings in a row, each sent after this machine was registered,
   * have not returned it. A listing that returns it starts the count again; at
   * two, it is forgotten and counted as vanished — see {@link RunnerPool.reconcile}.
   * Absent until a listing misses it.
   */
  absentListings?: number;
  state: PooledMachineState;
}

export interface RunnerPoolOptions {
  /**
   * Target number of ready machines. 0 keeps no stock and never makes one; the
   * maintenance still runs once started, and empties a stock an earlier process
   * left behind.
   */
  size: number;
  /** Image tag pooled machines are created from — also the staleness reference. */
  imageTag: string;
  /** Fly region for pooled machines. */
  region?: string;
  /** Port the in-machine runner listens on. */
  runnerPort?: number;
  /** DNS re-resolve interval for short-TTL hosts. */
  dnsResolveIntervalSeconds?: number;
  /** VM spec. Must stay within the platform's suspend eligibility. */
  guest?: MachineGuest;
  /**
   * Harness-controlled hostnames the runner may reach — run-independent, applied
   * at fill rather than at assignment.
   *
   * Accepts a resolver because one of them is not knowable up front: the object
   * store's hostname is only visible on a presigned URL, and no run exists yet
   * when the pool fills. The resolver is awaited on the first fill and its result
   * reused, so the cost is paid once rather than per machine.
   */
  infraHosts?: string[] | (() => Promise<string[]>);
  /** This harness's own private address — run-independent, applied at fill. */
  harness6pn?: string;
  /** Recycle a machine that has sat unused this long. */
  maxIdleMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** How long a machine may take to boot during a fill before it is written off. */
  maxBootTimeMs?: number;
  /** Interval between readiness polls during a fill. */
  bootPollIntervalMs?: number;
  /** Injectable sleep for tests — keeps fill tests instant. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * How often the background loop reconciles and tops the pool up once
   * {@link RunnerPool.start} has been called. Default 60s.
   */
  maintenanceIntervalMs?: number;
  /**
   * The longest one pass's reconciliation, retirement and sweep may take
   * together, in ms: their calls share one signal, aborted past it. Default
   * {@link POOL_MAINTENANCE_PASS_BUDGET_MS}.
   */
  maintenancePassBudgetMs?: number;
  /**
   * The longest the fill may spend on one machine — its creation, its boot,
   * its pause —, in ms: those calls share one signal, aborted past it. Default
   * derived from the client's bounds and `maxBootTimeMs` — see
   * {@link POOL_FILL_STEP_BUDGET_MS}.
   */
  fillStepBudgetMs?: number;
  /**
   * The longest one step of a fill's clean-up may take, in ms — the destruction
   * of the machine it made, a read of its label, the destruction of a machine
   * that read found —: each under a signal of its own, aborted past it, the
   * step then logged and never sent again. Default {@link CUT_CREATE_STEP_MS}.
   */
  cleanupStepMs?: number;
}

/** Counters an operator reads to tell a working pool from a silently dead one. */
export interface RunnerPoolStats {
  size: number;
  filling: number;
  ready: number;
  claimed: number;
  draining: number;
  /** Machines written off during a fill — a rising count means the pool cannot refill. */
  fillErrors: number;
  /**
   * Pooled machines retired for their age or for being stale, each counted once
   * the platform destroyed it: a ready one of this process past the idle limit —
   * or whose image or harness address is not this process's, which never happens
   * within one process —, and one an earlier process left from another image.
   * After a deploy it moves only for a stock its own server did not destroy — a
   * server that stops cleanly destroys its ready machines itself.
   */
  drains: number;
  /** Abandoned pool-named machines reclaimed — should normally stay at zero. */
  orphansDestroyed: number;
  /** Runs served from the pool. */
  hits: number;
  /**
   * Runs that fell back to creating their own machine. Counted separately from
   * `hits` because the ratio is the single number that says whether the pool is
   * doing its job — a pool that quietly stopped serving looks healthy by every
   * other measure.
   */
  misses: number;
  /**
   * Runs that passed the pool over on purpose — not entitled to a pre-created
   * machine — and created their own. Apart from `misses`: a pool that runs
   * pass over is not a pool that failed to serve — counted together, a full
   * pool that quotas send runs around would read like a broken one.
   */
  skipped: number;
  /**
   * Destructions that failed: the end of a run, the search for the machine of a
   * run's abandoned creation, a machine refused at its claim, a fill, a
   * retirement, a reconciliation, a sweep of the run machines, the server's stop
   * — not those the platform client tries itself, for a machine its own label
   * search found and did not adopt. Each one leaves a machine billing until
   * something else removes it, and the log line it writes is what nobody reads.
   */
  destroyFailures: number;
  /**
   * Maintenance passes that found the previous one still reconciling, and
   * skipped. A rising count means a pass outlasts the interval.
   */
  skippedPasses: number;
  /**
   * Pooled machines this process held that the platform stopped listing without
   * this process destroying them — forgotten once two listings in a row, both
   * sent after the machine was registered, have missed it.
   */
  vanished: number;
  /**
   * Sweeps of the run machines that returned — one its pass's bound cut midway
   * included: it stops where it stands and hands back what it did. One that
   * throws is logged (`pool_sweep_failed`), not counted.
   */
  sweepPasses: number;
  /** Run machines a sweep destroyed. */
  sweepDestroyed: number;
  /**
   * Run machines a sweep spared because their run could not be read — a fault,
   * never taken for a run that does not exist.
   */
  sweepReadFailures: number;
  /**
   * Assignments whose pooled machine reported at its `/init`, successful or
   * failed, an infrastructure host — the object store, a package registry —
   * resolving now to an address its boot opened no rule for: a rule gone stale
   * while the machine slept, which nothing re-resolves. Each is also a `warn`
   * line, `pool_infra_hosts_changed`. No rule moves for it.
   */
  infraHostsChanged: number;
  /**
   * Assignments whose pooled machine had nothing to say of its infrastructure
   * hosts at its `/init`: its measurement not written yet, a host that resolved
   * to nothing, or a runner too old to measure. An `/init` that got no answer is
   * not counted.
   */
  infraHostsUnmeasured: number;
}

/** What one sweep of the run machines reports to the pool's counters. */
export interface RunnerPoolSweepResult {
  /** Run machines it destroyed. */
  destroyed: number;
  /** Run machines it spared because their run could not be read. */
  readFailures: number;
}

/**
 * A sweep of the run machines, run inside the pool's maintenance: handed the
 * listing the pass reconciled on — never a second listing — and the pass's
 * signal.
 */
export type RunnerPoolSweep = (
  live: Machine[],
  signal: AbortSignal,
) => Promise<RunnerPoolSweepResult>;

/**
 * A listing of the app's machines, and when it was sent, on the pool's clock —
 * the instant taken before the request left. A machine registered after that
 * instant may not be in it yet, however it came back.
 */
export interface RunnerPoolListing {
  machines: Machine[];
  sentAt: number;
}

/** What the composition root hands the maintenance when it starts it. */
export interface RunnerPoolStartOptions {
  /**
   * Run on every pass after the reconciliation, on its listing. One that throws
   * is logged and cuts nothing: the pass goes on, the fill too. Given one, the
   * reconciliation leaves to it a pooled machine labelled with the run it was
   * assigned to.
   */
  sweep?: RunnerPoolSweep;
  /**
   * How long a started pooled machine nobody holds may sit untouched before the
   * reconciliation takes it for abandoned, in ms: one may be serving another
   * instance's run — one labelled with that run is left to the sweep, when the
   * maintenance has one. The composition derives it from the longest a run may last —
   * the instance's maximum timeout, the seat's margin and the lifetime's grace.
   * Default {@link DEFAULT_STARTED_ORPHAN_WINDOW_MS}.
   */
  startedOrphanWindowMs?: number;
}

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_IDLE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_BOOT_TIME_MS = 120_000;
const DEFAULT_BOOT_POLL_INTERVAL_MS = 1_000;
/**
 * How many listings in a row must miss a machine this process holds before it
 * is forgotten. A machine is listed some seconds after the request that made
 * it, and nobody knows how many at most: two listings a maintenance interval
 * apart only assume less than an interval, and a real disappearance counted
 * one pass later costs nothing.
 */
const VANISHED_AFTER_LISTINGS = 2;

/**
 * The bound of one pass's guarded half — its listing, its reconciliation, the
 * retirement and the sweep —, in ms. Past it, the pass's signal aborts: what
 * is in flight ends, what is left is not started, and the next pass picks up.
 */
export const POOL_MAINTENANCE_PASS_BUDGET_MS = 600_000;

/**
 * The attempts one call of the client may make on a network failure: the
 * first, and three more — the client's retries, or a creation's direct
 * retries of a request that never left.
 */
const ATTEMPTS_PER_CALL = 4;

/**
 * The bound of the fill of one machine, in ms, for a boot budget of
 * `maxBootTimeMs`: the longest one creation waits in the client on its own
 * (`createWorstCaseMs`), its attempts each cut at their bound, the boot budget,
 * then the attempts of its pause each cut at theirs.
 */
function poolFillStepBudgetMs(maxBootTimeMs: number): number {
  return (
    createWorstCaseMs({ concurrentCreates: 1 }) +
    ATTEMPTS_PER_CALL * FLY_ATTEMPT_TIMEOUT_MS.create +
    maxBootTimeMs +
    ATTEMPTS_PER_CALL * FLY_ATTEMPT_TIMEOUT_MS.suspend
  );
}

/**
 * The bound of the fill of one machine on the default boot budget — about
 * 12 min. The fill may hold its guard that long for one machine, plus, after a
 * failure that bound did not cut, three steps of its clean-up at most
 * (`cleanupStepMs`, {@link CUT_CREATE_STEP_MS} by default): 753 s on the
 * defaults — bounded, never for as long as a call hangs.
 */
export const POOL_FILL_STEP_BUDGET_MS = poolFillStepBudgetMs(DEFAULT_MAX_BOOT_TIME_MS);

/**
 * The steps of its clean-up a fill takes at most, after a failure its bound did
 * not cut: a creation sent twice at most makes two machines — the read of its
 * label, and two destructions when the fill kept none.
 */
const FILL_CLEANUP_MAX_STEPS = 3;

/**
 * How long a started pooled machine nobody holds may sit untouched before it is
 * taken for abandoned, unless {@link RunnerPool.start} is given a window of its
 * own. Generous on purpose: the cost of waiting is a little money, the cost of
 * being wrong is somebody's run.
 */
export const DEFAULT_STARTED_ORPHAN_WINDOW_MS = 1_200_000;

/**
 * The platform states in which no run can be on a machine: it is not running.
 * A machine in a passing state — starting, stopping, being replaced — or in one
 * this client does not read is left to a later pass, which will see it settled.
 */
const NOT_STARTED_STATES: ReadonlySet<MachineState> = new Set([
  "created",
  "stopped",
  "suspended",
  "failed",
]);

export class RunnerPool {
  protected readonly machines = new Map<string, PooledMachine>();
  protected readonly logger: Logger;
  protected readonly now: () => number;
  /**
   * When this pool was built, on its own clock. A pooled machine the platform
   * says was created earlier cannot be a newer process's: only this process may
   * then judge it on what it holds, never the other way round.
   */
  protected readonly startedAt: number;
  /** Handle for the background maintenance loop; null until {@link start}. */
  protected maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected readonly flyApi: FlyMachinesApi,
    protected readonly options: RunnerPoolOptions,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger("runner-pool");
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  get size(): number {
    return this.options.size;
  }

  /**
   * Whether this pool keeps a stock (size above 0) — and so whether a run may be
   * offered a machine. Not whether it runs: the maintenance runs at any size.
   */
  get enabled(): boolean {
    return this.options.size > 0;
  }

  /** Record a machine that is being created. It is not offerable until {@link markReady}. */
  register(machine: Omit<PooledMachine, "state" | "createdAt">): PooledMachine {
    const entry: PooledMachine = { ...machine, state: "filling", createdAt: this.now() };
    this.machines.set(entry.machineId, entry);
    return entry;
  }

  get(machineId: string): PooledMachine | undefined {
    return this.machines.get(machineId);
  }

  all(): PooledMachine[] {
    return [...this.machines.values()];
  }

  /**
   * Promote a machine to offerable. Only ever from `filling`, and only the caller
   * that has confirmed the machine is actually suspended should call it — offering
   * a machine mid-fill would hand a run something that is not ready to be woken.
   */
  markReady(machineId: string): boolean {
    const entry = this.machines.get(machineId);
    if (!entry || entry.state !== "filling") return false;
    entry.state = "ready";
    return true;
  }

  /**
   * Take one ready machine and mark it claimed, in a single synchronous step.
   *
   * The absence of `await` in here is the point: two runs arriving at the same time
   * cannot both be handed the same machine, because neither can interleave with the
   * other between the read and the write. Across separate harness processes the
   * guarantee comes from elsewhere — the machine itself refuses a second assignment
   * — so this is a local efficiency, not the safety mechanism.
   */
  takeReady(): PooledMachine | undefined {
    for (const entry of this.machines.values()) {
      if (entry.state === "ready") {
        entry.state = "claimed";
        return entry;
      }
    }
    return undefined;
  }

  /** Mark a machine as being disposed of. It stops being offerable immediately. */
  markDraining(machineId: string): boolean {
    const entry = this.machines.get(machineId);
    if (!entry) return false;
    entry.state = "draining";
    return true;
  }

  /** Forget a machine. Called once it has actually been destroyed. */
  forget(machineId: string): boolean {
    return this.machines.delete(machineId);
  }

  /**
   * Whether a machine no longer matches the configuration it must match to serve a
   * run. Both arms are correctness matters rather than tidiness: a machine built
   * from a superseded image would quietly run superseded code — including anything
   * shipped to fix a security problem — and one pointing at a previous harness
   * address has firewall rules that no longer admit this one.
   */
  isStale(machine: PooledMachine): boolean {
    if (machine.imageTag !== this.options.imageTag) return true;
    if ((machine.harness6pn ?? undefined) !== (this.options.harness6pn ?? undefined)) return true;
    return false;
  }

  /**
   * Whether a woken machine genuinely resumed from its snapshot, or quietly
   * cold-booted instead. `undefined` when the question cannot be answered — an
   * image too old to identify its process — because recording nothing beats
   * recording a guess in the field whose whole job is to raise an alarm.
   *
   * Identity, not timing: the machine reports which process it is when it becomes
   * ready and again when it is assigned. A cold boot necessarily runs a NEW
   * process, so the values differ; a genuine wake resumes the same one.
   *
   * ⚠️ This replaced an uptime comparison that was wrong in a way worth
   * remembering: it read `uptime * 2 >= age-since-fill`, which assumes the clock
   * keeps running while the machine is paused. It does not — the machine is
   * frozen with its memory, so uptime measures time SPENT RUNNING, not age. The
   * two diverge by exactly the pause, which is the entire point of a pre-created
   * machine, so the longer one waited (the better the pool worked) the more
   * certainly the field reported "cold-booted". Measured on the first cloud run:
   * a machine that had run 48s before being paused, woken 470s later in 441ms —
   * unmistakably a resume — was classified as a cold boot. A stuck alarm is worse
   * than no alarm, because it also cannot fire when something is genuinely wrong.
   */
  classifyResume(
    machine: PooledMachine,
    reportedProcessId: string | undefined,
  ): boolean | undefined {
    if (!machine.processId || !reportedProcessId) return undefined;
    return machine.processId === reportedProcessId;
  }

  /** Whether a machine has sat unused long enough to be recycled. */
  isExpired(machine: PooledMachine): boolean {
    const maxIdle = this.options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    return this.now() - machine.createdAt >= maxIdle;
  }

  /** How many more machines the pool wants, counting those still being built. */
  deficit(): number {
    const usable = this.all().filter((m) => m.state === "filling" || m.state === "ready").length;
    return Math.max(0, this.options.size - usable);
  }

  stats(): RunnerPoolStats {
    const stats: RunnerPoolStats = {
      size: this.options.size,
      filling: 0,
      ready: 0,
      claimed: 0,
      draining: 0,
      fillErrors: this.fillErrors,
      drains: this.drains,
      orphansDestroyed: this.orphansDestroyed,
      hits: this.hits,
      misses: this.misses,
      skipped: this.skipped,
      destroyFailures: this.destroyFailures,
      skippedPasses: this.skippedPasses,
      vanished: this.vanished,
      sweepPasses: this.sweepPasses,
      sweepDestroyed: this.sweepDestroyed,
      sweepReadFailures: this.sweepReadFailures,
      infraHostsChanged: this.infraHostsChanged,
      infraHostsUnmeasured: this.infraHostsUnmeasured,
    };
    for (const entry of this.machines.values()) stats[entry.state] += 1;
    return stats;
  }

  private destroyFailures = 0;
  private skippedPasses = 0;
  private vanished = 0;
  private sweepPasses = 0;
  private sweepDestroyed = 0;
  private sweepReadFailures = 0;
  private infraHostsChanged = 0;
  private infraHostsUnmeasured = 0;

  /**
   * Record a destruction that failed. The pool calls it for its own; the end of a
   * run, the search for the machine of a run's abandoned creation and the sweep of
   * the run machines call it for theirs, so one counter says every machine left
   * billing.
   */
  recordDestroyFailure(): void {
    this.destroyFailures += 1;
  }

  /**
   * Record a sweep of the run machines that returned — its pass's bound may have
   * cut it midway —, and what it did.
   */
  recordSweep(result: RunnerPoolSweepResult): void {
    this.sweepPasses += 1;
    this.sweepDestroyed += result.destroyed;
    this.sweepReadFailures += result.readFailures;
  }

  /**
   * Record what a pooled machine's runner reported of its infrastructure hosts
   * in its answer to `/init` — nothing, from a runner too old to measure, says
   * as much as `unmeasured` —, and hand back the word counted. The adapter
   * calls it on the pool's path only: a machine created for its run measures
   * nothing.
   */
  recordInfraHosts(check: InfraHostsCheck | undefined): InfraHostsCheck {
    const word = check ?? "unmeasured";
    if (word === "changed") this.infraHostsChanged += 1;
    else if (word === "unmeasured") this.infraHostsUnmeasured += 1;
    return word;
  }

  // ---------------------------------------------------------------------------
  // Fill
  // ---------------------------------------------------------------------------

  private filling = false;
  private fillErrors = 0;

  /**
   * Top the pool back up to its target.
   *
   * Runs in the background and is never awaited by a request: the whole point is
   * that creating and booting a machine happens off the caller's path. A caller
   * that finds the pool empty falls back to creating its own machine rather than
   * waiting for this.
   *
   * Machines are built ONE AT A TIME, and that is a constraint rather than a
   * simplification: the platform advises against suspending many machines at once,
   * so a top-up that fanned out would hit exactly that.
   *
   * Re-entrant calls are ignored — a second fill while one is running would race
   * the first on the deficit and overshoot the target.
   */
  /**
   * Begin keeping the pool at depth, and keep doing it.
   *
   * This exists because nothing else calls {@link fill}: every other caller of
   * this class consumes machines. Without a start, the pool stays empty forever
   * and every run falls back to creating its own — which is *correct* behaviour
   * and therefore invisible. Nothing errors, nothing warns, the counters just
   * read `ready: 0` and `misses: n`, exactly as they would for a pool that is
   * merely busy. That failure mode is the reason this is a method and not an
   * implicit side effect of the constructor: starting the background work is a
   * decision the composition root makes, once, where it can be seen.
   *
   * The cycle is reconcile-then-fill: dispose of what the platform says is
   * abandoned, then rebuild the deficit. Both are safe alongside a live claim —
   * {@link fill} is re-entrancy-guarded, and reconciliation keys on platform
   * state rather than on this process's registry. `options.sweep`, when given,
   * runs after the reconciliation, on its listing.
   *
   * At any size, 0 included: a pool parked at 0 keeps no stock and never fills,
   * but the stock an earlier process left — paused, billing — is still there,
   * and only a running maintenance empties it.
   *
   * Idempotent. The timer is unref'd, so it never keeps a process alive on its
   * own — a server that is shutting down does not linger for a pool top-up.
   */
  start(options: RunnerPoolStartOptions = {}): void {
    if (this.maintenanceTimer) return;
    this.stopped = false;
    this.sweep = options.sweep;
    this.startedOrphanWindowMs = options.startedOrphanWindowMs ?? DEFAULT_STARTED_ORPHAN_WINDOW_MS;
    const intervalMs = this.options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.logger.info(
      { event: "pool_started", size: this.options.size, interval_ms: intervalMs },
      "pre-warm pool maintenance started",
    );
    // Now rather than one interval from now: at boot the pool is empty, and
    // waiting a full interval would send the first runs down the cold path.
    this.runPass();
    this.maintenanceTimer = setInterval(() => this.runPass(), intervalMs);
    this.maintenanceTimer.unref?.();
  }

  /** The sweep of the run machines {@link start} was given, if any. */
  private sweep: RunnerPoolSweep | undefined;

  /** The window of a started pooled machine nobody holds — see {@link RunnerPoolStartOptions}. */
  private startedOrphanWindowMs = DEFAULT_STARTED_ORPHAN_WINDOW_MS;

  /**
   * One pass, from the timer. Every step of a pass is fail-soft already; this
   * catch is for whatever is not, because an unhandled rejection from a timer
   * takes the whole server down rather than one pool cycle.
   */
  private runPass(): void {
    void this.maintain().catch((err) => {
      this.logger.warn(
        { event: "pool_pass_failed", ...errorFields(err) },
        "maintenance pass failed",
      );
    });
  }

  /** Whether {@link stop} was called since the last {@link start}: nothing is filled then. */
  private stopped = false;

  /**
   * Stop the background loop — and the fill with it: a fill under way ends with
   * the machine it is making, and none starts after, whatever the deficit says
   * (the server's stop destroys the ready machines, which reopens it). Safe to
   * call when it was never started.
   */
  stop(): void {
    this.stopped = true;
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.logger.info({ event: "pool_stopped" }, "pre-warm pool maintenance stopped");
  }

  /**
   * At the server's stop: destroy the ready machines this process holds. They
   * serve no one once it is gone — their assignment credential lives in its
   * memory —, and, paused, they bill their storage until another process's
   * reconciliation judges them. Each leaves the inventory before its
   * destruction is asked, as at a run's end; a destruction that fails is
   * counted (`destroyFailures`) and logged. A machine still being filled is
   * left to the next process, one a run holds to its run.
   *
   * `signal` is what is left of the stop's grace: a destruction still
   * unanswered when it aborts is given up, and none is asked once it has —
   * both counted as failed, the machine left billing. The destructions go out
   * together: the platform client paces them.
   */
  async destroyOwnReady(signal?: AbortSignal): Promise<{ destroyed: number; failed: number }> {
    const ready = this.all().filter((machine) => machine.state === "ready");
    // Forgotten, never set "draining" first: nothing would read that state.
    for (const { machineId } of ready) this.forget(machineId);
    let destroyed = 0;
    let failed = 0;
    await Promise.all(
      ready.map(async ({ machineId }) => {
        try {
          if (signal?.aborted) throw signal.reason;
          const asked = this.flyApi.destroy(machineId, { signal });
          await (signal ? untilAborted(asked, signal) : asked);
          destroyed += 1;
          this.logger.info(
            { event: "pool_stop_destroyed", machine_id: machineId },
            "destroyed a ready pooled machine at the server's stop",
          );
        } catch (err) {
          failed += 1;
          this.recordDestroyFailure();
          this.logger.warn(
            {
              event: "pool_destroy_failed",
              machine_id: machineId,
              at_stop: true,
              ...errorFields(err),
            },
            "pooled machine destroy failed at the server's stop — manual cleanup may be required",
          );
        }
      }),
    );
    return { destroyed, failed };
  }

  /**
   * Ask for a top-up without waiting for the next tick — used right after a run
   * takes a machine, so the deficit is not carried for a whole interval. Never
   * awaited by the caller: a request must not pay for the next run's machine.
   *
   * Inert until {@link start} has run, and at size 0. This is an *acceleration*
   * of the maintenance loop's fill, so with no loop, or a loop that never fills,
   * there is nothing to accelerate — and it keeps the rule that a pool nobody
   * started never creates anything on its own.
   */
  requestTopUp(): void {
    if (!this.enabled || !this.maintenanceTimer) return;
    void this.fill().catch((err) => {
      this.logger.warn(
        { event: "pool_fill_failed", ...errorFields(err) },
        "top-up after a claim failed",
      );
    });
  }

  /** Whether a reconciliation, retirement and sweep are running — see {@link maintain}. */
  private maintaining = false;

  /**
   * One maintenance pass: reconcile, retire and sweep at any size, fill only a
   * pool that keeps a stock.
   *
   * **One reconciliation at a time.** The timer starts a pass every interval
   * without waiting for the last one, and two reconciliations at once would read
   * the same listing and destroy the same machine twice. A pass that finds the
   * last one still reconciling skips it, counted, and goes on to the fill.
   *
   * **Not a guard on the whole pass.** The fill has its own, and it is not
   * waited for: a fill holds each machine through its creation, its boot and its
   * pause — minutes — and a guard around it would skip as many reconciliations
   * and sweeps as the top-up has machines to make.
   *
   * **Both halves are bounded.** The guarded half within one bound for the pass
   * (`maintenancePassBudgetMs`), the fill within one per machine
   * (`fillStepBudgetMs`) plus, after a failure that bound did not cut, three
   * steps of its clean-up at most (`cleanupStepMs`): a platform call that never
   * answers ends at its bound, and neither guard is held for as long as it hangs.
   *
   * Each step is fail-soft: a catch of its own, logged by the error's class.
   */
  protected async maintain(): Promise<void> {
    if (this.maintaining) {
      this.skippedPasses += 1;
      this.logger.warn(
        { event: "pool_pass_skipped" },
        "the last reconciliation is still running — this one skipped",
      );
    } else {
      this.maintaining = true;
      try {
        await this.reconcileRetireSweep();
      } finally {
        this.maintaining = false;
      }
    }
    if (!this.enabled) return;
    try {
      await this.fill();
    } catch (err) {
      this.logger.warn({ event: "pool_fill_failed", ...errorFields(err) }, "fill pass failed");
    }
  }

  /**
   * The guarded half of a pass: one listing, the reconciliation on it, the
   * retirement, then the sweep on the same listing, under the pass's signal. A
   * listing that fails skips the reconciliation and the sweep — never a guess on
   * an empty listing, which would forget every machine this process holds — and
   * the retirement, which reads only this process's own machines, still runs.
   *
   * The pass's signal aborts at its bound: the call in flight ends there, and no
   * step is started after it — logged once (`pool_pass_cut`). The next pass
   * starts from a fresh listing.
   */
  private async reconcileRetireSweep(): Promise<void> {
    const budgetMs = this.options.maintenancePassBudgetMs ?? POOL_MAINTENANCE_PASS_BUDGET_MS;
    const pass = armedBound("pass", budgetMs);
    try {
      const sentAt = this.now();
      const live = await this.listMachines(pass.signal);
      if (live) {
        try {
          await this.reconcile({ machines: live, sentAt }, pass.signal);
        } catch (err) {
          this.logger.warn(
            { event: "pool_reconcile_failed", ...errorFields(err) },
            "reconciliation pass failed",
          );
        }
      }
      // A pass already cut retires nothing: its signal stops the retirement.
      try {
        await this.drainStale(pass.signal);
      } catch (err) {
        this.logger.warn({ event: "pool_drain_failed", ...errorFields(err) }, "retirement failed");
      }
      if (live && this.sweep && !pass.signal.aborted) {
        try {
          this.recordSweep(await this.sweep(live, pass.signal));
        } catch (err) {
          this.logger.warn(
            { event: "pool_sweep_failed", ...errorFields(err) },
            "sweep of the run machines failed",
          );
        }
      }
    } finally {
      pass.end();
      if (pass.signal.aborted) {
        this.logger.warn(
          { event: "pool_pass_cut", budget_ms: budgetMs },
          "a maintenance pass reached its bound — what was left of it waits for the next pass",
        );
      }
    }
  }

  async fill(): Promise<void> {
    if (!this.enabled || this.filling) return;
    this.filling = true;
    try {
      while (!this.stopped && this.deficit() > 0) {
        const added = await this.addOne();
        // A failing platform should not be hammered in a tight loop: one failure
        // ends this round, and the next scheduled fill tries again.
        if (!added) break;
      }
    } finally {
      this.filling = false;
    }
  }

  /**
   * Create one machine, boot it, verify it answers, then suspend it.
   *
   * It becomes offerable only after the suspend is confirmed. Offering it earlier
   * would hand a run a machine that is not actually ready to be woken — and the
   * caller would discover that at the worst moment, on the request path.
   *
   * Any failure destroys the machine rather than leaving it behind: a half-built
   * pooled machine is indistinguishable from a working one by name alone, and it
   * would bill for as long as it survives.
   *
   * A creation the client had to send twice may have made a second machine of
   * this fill's label — see {@link destroyLabelledDuplicates}, called when the
   * fill ends, whatever it ends on.
   *
   * **Within one bound** (`fillStepBudgetMs`): the creation, the boot and the
   * pause share one signal, aborted past it. A step its bound cut ends there, and
   * what it leaves — the machine it made, or the one a creation cut mid-flight
   * may have made — is cleaned up in the background ({@link cleanUpCutFill}),
   * never awaited: the fill's guard is not held past the bound. A failure the
   * bound did not cut is cleaned up before the fill goes on — the machine it made
   * destroyed, a second machine of its label looked for and destroyed —, each
   * step within `cleanupStepMs`: three at most.
   */
  protected async addOne(): Promise<boolean> {
    const claimToken = randomBytes(32).toString("hex");
    const poolId = randomBytes(8).toString("hex");
    const port = this.options.runnerPort ?? 9000;
    let machineId: string | null = null;
    const creation: CreateProgress = { resent: false, adopted: false };
    const step = armedBound("fill", this.fillStepBudgetMs());
    let cut = false;

    try {
      const createFrom = this.now();
      const machine = await this.flyApi.create(
        buildPoolMachineConfig({
          poolId,
          image: this.options.imageTag,
          claimToken,
          region: this.options.region,
          runnerPort: port,
          dnsResolveIntervalSeconds: this.options.dnsResolveIntervalSeconds,
          guest: this.options.guest,
          infraHosts: await this.resolveInfraHosts(),
          harness6pn: this.options.harness6pn,
        }),
        creation,
        { signal: step.signal },
      );
      const createMs = this.now() - createFrom;
      machineId = machine.id;
      const privateIp = machine.private_ip;
      if (!privateIp) throw new Error("create response carried no private address");

      this.register({
        machineId,
        privateIp,
        claimToken,
        imageTag: this.options.imageTag,
        harness6pn: this.options.harness6pn,
      });

      // Captured BEFORE the suspend: this is the process the machine is paused
      // with, and the one a genuine wake brings back.
      const processId = await this.waitForReady(buildRunnerBaseUrl(privateIp, port), step.signal);
      const entry = this.machines.get(machineId);
      if (entry) entry.processId = processId;
      const suspendFrom = this.now();
      await this.flyApi.suspend(machineId, { signal: step.signal });
      const suspendMs = this.now() - suspendFrom;
      this.markReady(machineId);

      this.logger.info(
        {
          event: "pool_fill",
          machine_id: machineId,
          ready: this.stats().ready,
          create_ms: createMs,
          suspend_ms: suspendMs,
        },
        "pooled machine ready",
      );
      return true;
    } catch (err) {
      this.fillErrors += 1;
      cut = step.signal.aborted;
      this.logger.warn(
        {
          event: "pool_fill_failed",
          machine_id: machineId,
          ...(cut ? { cut: true } : {}),
          ...errorFields(err),
        },
        "pooled machine could not be prepared",
      );
      if (machineId) this.forget(machineId);
      if (cut) {
        void this.cleanUpCutFill({ poolId, machineId, creation });
      } else if (machineId) {
        await this.destroyFilled(machineId);
      }
      return false;
    } finally {
      step.end();
      // A cut fill's cleanup looks for the second machine of its label too.
      if (creation.resent && !cut) {
        await this.destroyLabelledDuplicates(poolId, machineId);
      }
    }
  }

  /** The bound of the fill of one machine — see {@link RunnerPoolOptions.fillStepBudgetMs}. */
  private fillStepBudgetMs(): number {
    return (
      this.options.fillStepBudgetMs ??
      poolFillStepBudgetMs(this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS)
    );
  }

  /** The bound of one step of a fill's clean-up — see {@link RunnerPoolOptions.cleanupStepMs}. */
  private cleanupStepMs(): number {
    return this.options.cleanupStepMs ?? CUT_CREATE_STEP_MS;
  }

  /**
   * The longest a fill of this process holds one machine, in ms: its bound
   * ({@link fillStepBudgetMs}), then, after a failure that bound did not cut,
   * {@link FILL_CLEANUP_MAX_STEPS} steps of its clean-up ({@link cleanupStepMs})
   * — 753 s on the defaults. Past it, a fill has left the machine it made, and a
   * machine created and never started that long is one no fill will start: the
   * reconciliation then destroys it with force. The processes sharing a runners
   * app run the same code, and this process's bound stands for theirs.
   */
  private fillHoldBoundMs(): number {
    return this.fillStepBudgetMs() + FILL_CLEANUP_MAX_STEPS * this.cleanupStepMs();
  }

  /**
   * Destroy a machine a fill made — or a second machine of its label — within
   * one step of its clean-up; a destruction refused, or cut at the step's bound,
   * is counted and logged.
   */
  private async destroyFilled(machineId: string): Promise<void> {
    let cut = false;
    try {
      const done = await withinStep(
        (signal) => this.flyApi.destroy(machineId, { signal }),
        this.cleanupStepMs(),
      );
      if (done !== STEP_CUT) return;
      cut = true;
    } catch {
      // Refused: counted below.
    }
    this.recordDestroyFailure();
    this.logger.warn(
      { event: "pool_destroy_failed", machine_id: machineId, ...(cut ? { cut: true } : {}) },
      "pooled machine destroy failed — manual cleanup may be required",
    );
  }

  /**
   * What a fill its bound cut leaves behind, cleaned up in the background — the
   * fill never awaits it. A machine the fill made is destroyed, then any second
   * one of its label when its creation was sent twice. A creation cut mid-flight
   * may have made a machine the platform never answered for, and the client sends
   * nothing more for a caller that abandoned: its label is read a second apart, at
   * least `SEARCH_READS` times and until a read leaves `CUT_CREATE_SEARCH_MS` after
   * its last request — `CUT_CREATE_MAX_READS` times at most —, and every machine of
   * its label and name not on its way out is destroyed — two at most, a creation
   * sent twice. Each read, each destruction found, within `CUT_CREATE_STEP_MS`:
   * what is cut is logged, never sent again. The search is the adapter's for a
   * run's abandoned creation (`searchCutCreation`, cut-creation-search.ts). A
   * creation whose request never left made nothing: one line, no read. Best
   * effort: what it misses is an unknown pooled machine to the reconciliation.
   *
   * Returns the work; it never rejects.
   */
  protected cleanUpCutFill(cut: {
    poolId: string;
    machineId: string | null;
    creation: CreateProgress;
  }): Promise<void> {
    return this.cleanUpCut(cut).catch((err: unknown) => {
      this.logger.warn(
        { event: "pool_cut_fill_cleanup_failed", ...errorFields(err) },
        "could not finish cleaning up after a fill its bound cut — manual cleanup may be required",
      );
    });
  }

  private async cleanUpCut(cut: {
    poolId: string;
    machineId: string | null;
    creation: CreateProgress;
  }): Promise<void> {
    if (cut.machineId) {
      await this.destroyFilled(cut.machineId);
      if (cut.creation.resent) await this.destroyLabelledDuplicates(cut.poolId, cut.machineId);
      return;
    }
    const lastSentAt = cut.creation.lastSentAt;
    if (lastSentAt === undefined) {
      this.logger.info(
        { event: "pool_cut_create_cleanup", found: 0, destroyed: 0 },
        "a fill's creation was cut before its request left: nothing to look for",
      );
      return;
    }
    const { found, destroyed } = await searchCutCreation({
      flyApi: this.flyApi,
      label: { key: POOL_LABEL_KEY, value: cut.poolId },
      name: machineNameForPool(cut.poolId),
      lastSentAt,
      now: this.now,
      sleep: (ms) => this.sleepFor(ms),
      stepMs: this.cleanupStepMs(),
      onReadCut: (read) => {
        this.logger.warn(
          { event: "pool_cut_create_read_cut", read },
          "a read of a cut creation's label reached its bound",
        );
      },
      onDestroyed: (machineId) => {
        this.logger.info(
          { event: "pool_cut_create_destroyed", machine_id: machineId },
          "destroyed the machine of a fill's creation its bound cut",
        );
      },
      onDestroyFailed: (machineId, failure) => {
        this.recordDestroyFailure();
        if (failure.cut) {
          this.logger.warn(
            { event: "pool_destroy_failed", machine_id: machineId, cut: true },
            "the destruction of a cut creation's machine reached its bound — manual cleanup may be required",
          );
          return;
        }
        this.logger.warn(
          { event: "pool_destroy_failed", machine_id: machineId },
          "pooled machine destroy failed — manual cleanup may be required",
        );
      },
    });
    this.logger.info(
      { event: "pool_cut_create_cleanup", found, destroyed },
      "looked for the machine of a fill's creation its bound cut",
    );
  }

  /**
   * After a creation sent a second time, destroy every machine of this fill's
   * label and name but the one it kept, or already destroyed. Two requests that
   * cross make two machines of one name and one label, and only the label finds
   * the second — started, billing, until reconciliation judged it abandoned,
   * past the window of a started machine. Called once the fill ends, so that a first creation still
   * in flight has landed. Best effort, like every destroy here: a search that
   * fails is logged and the fill ends as it would have. Never for a fill whose
   * creation went once: it costs a listing.
   *
   * The read, and each destruction, within one step of the clean-up
   * (`cleanupStepMs`): a creation sent twice at most makes two machines, so
   * this holds the fill's guard three steps at most — the read, and two
   * destructions when the fill kept none.
   */
  protected async destroyLabelledDuplicates(
    poolId: string,
    keptOrDestroyed: string | null,
  ): Promise<void> {
    let labelled: Machine[] | typeof STEP_CUT;
    try {
      labelled = await withinStep(
        (signal) => this.flyApi.listByLabel(POOL_LABEL_KEY, poolId, { signal }),
        this.cleanupStepMs(),
      );
    } catch (err) {
      this.logger.warn(
        { event: "pool_duplicate_search_failed", machine_id: keptOrDestroyed, ...errorFields(err) },
        "could not search for a second machine of a fill sent twice — manual cleanup may be required",
      );
      return;
    }
    if (labelled === STEP_CUT) {
      this.logger.warn(
        { event: "pool_duplicate_search_failed", machine_id: keptOrDestroyed, cut: true },
        "the search for a second machine of a fill sent twice reached its bound — manual cleanup may be required",
      );
      return;
    }
    const name = machineNameForPool(poolId);
    for (const machine of labelled) {
      if (machine.name !== name || machine.id === keptOrDestroyed) continue;
      if (machine.state === "destroying" || machine.state === "destroyed") continue;
      this.logger.info(
        { event: "pool_duplicate_destroyed", machine_id: machine.id, machine_state: machine.state },
        "destroying a second machine of a fill sent twice",
      );
      await this.destroyFilled(machine.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Drain
  // ---------------------------------------------------------------------------

  private drains = 0;

  /**
   * Dispose of machines that must no longer serve a run: built from a superseded
   * image, pointing at a previous harness address, or sat unused past the idle
   * limit.
   *
   * The first two are correctness rather than housekeeping. A machine from an
   * older image would quietly run older code — including anything shipped to fix
   * a security problem — and one whose firewall rules admit a previous harness
   * address cannot be reached by this one at all. Serving from either is worse
   * than serving nothing.
   *
   * A machine already serving a run is never touched: it is destroyed by the run
   * that holds it, when that run ends.
   *
   * Runs arriving mid-drain are not blocked. Each machine leaves the offerable
   * set before it is destroyed, so a caller simply finds fewer ready machines and
   * falls back to creating its own — which is the normal empty-pool path.
   *
   * Every maintenance pass runs it. Within one process the first two never fire:
   * a machine's image and harness address are copied from this process's own
   * when it is registered. What it retires in practice is a machine past the idle
   * limit; the stock of a superseded image is an earlier process's, unknown to
   * this one, and {@link reconcile} judges it on the image the platform lists.
   *
   * `signal`, a pass's: each destruction takes it, and none is started once it
   * has aborted.
   *
   * Returns, and counts in `drains`, the machines the platform destroyed: a
   * destruction that fails is counted in `destroyFailures` instead.
   */
  async drainStale(signal?: AbortSignal): Promise<number> {
    let drained = 0;
    for (const machine of this.all()) {
      if (signal?.aborted) break;
      if (machine.state === "claimed" || machine.state === "draining") continue;
      const stale = this.isStale(machine);
      if (!stale && !this.isExpired(machine)) continue;

      this.markDraining(machine.machineId);
      this.forget(machine.machineId);
      this.logger.info(
        {
          event: "pool_drain",
          machine_id: machine.machineId,
          reason: stale ? "stale" : "expired",
        },
        "draining a pooled machine",
      );
      try {
        await this.flyApi.destroy(machine.machineId, { signal });
      } catch {
        this.recordDestroyFailure();
        this.logger.warn(
          { event: "pool_destroy_failed", machine_id: machine.machineId },
          "pooled machine destroy failed — manual cleanup may be required",
        );
        continue;
      }
      // Counted once destroyed, as the reconciliation's are — a failure counts in
      // destroyFailures alone.
      this.drains += 1;
      drained += 1;
    }
    return drained;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  private orphansDestroyed = 0;
  private hits = 0;
  private misses = 0;
  private skipped = 0;

  /** Record that a run was served from the pool. */
  recordHit(): void {
    this.hits += 1;
  }

  /**
   * Record that a run passed the pool over on purpose — it was not entitled to
   * a pre-created machine — and went straight to creating its own. Nothing else:
   * no counter read, no line written (the server that decided says why).
   */
  recordSkip(): void {
    this.skipped += 1;
  }

  /**
   * Record that a run had to create its own machine.
   *
   * `reason` separates "there was nothing to give" from "there was something and
   * it would not work" — without that split, a pool that is full of unusable
   * machines is indistinguishable from a busy one.
   */
  recordMiss(reason: "empty" | "unusable"): void {
    this.misses += 1;
    this.logger.info(
      { event: "pool_miss", reason, ready: this.stats().ready },
      "run fell back to creating its own machine",
    );
  }

  /**
   * Dispose of pool-named machines nobody can still be using, and forget machines
   * the platform no longer has.
   *
   * **A machine this process holds is forgotten only on two listings.** Each
   * listing sent after the machine was registered that does not return it adds
   * one to its count, one that returns it starts the count again, and one sent
   * before it was registered says nothing of it — a machine is listed only some
   * seconds after the request that made it. At two in a row it is forgotten and
   * counted as vanished: the platform stopped listing it without this process
   * destroying it. Never on one: a listing that missed a machine still billing
   * would lose its trace, and the pool would fill on top of it.
   *
   * ⚠️ **Not keyed on "this process does not know it".** More than one harness may
   * run at a time, each holding its own inventory, and the machines are
   * indistinguishable by name. "I have never heard of it" would therefore include
   * another instance's ready machine — and, worse, another instance's machine
   * *currently serving a run*. Destroying on that basis would kill live runs.
   *
   * The predicate is instead the platform's own state plus age, which every
   * instance sees identically and neither can misread:
   *
   *  - **not started and past the idle limit** — paused, stopped, failed, or
   *    created and never started: no run can be on it, and no instance would
   *    still want it, since any of them would have expired it too.
   *  - **started and untouched past the window of a started machine** — longer
   *    than a run may last, its margin and its grace, as the composition derives
   *    it ({@link RunnerPoolStartOptions.startedOrphanWindowMs}): nothing is using
   *    it; a machine serving a run was touched when it was woken.
   *  - **at size 0, not started and created before this process** — a pool
   *    parked at 0 wants no stock, and no run can be on a machine that is not
   *    running. Created before this process, it is the stock an earlier one left;
   *    created after, it may be a newer process's, filling for a larger size,
   *    and is left to it. The platform's creation time, never its last update.
   *  - **not started, created before this process, of another image** — the stock
   *    an earlier process left from a superseded image, which would serve
   *    superseded code. Counted with the retirements. Only the newer process
   *    acts: during a rolling deploy or a rollback, two processes on two images
   *    see each other's stock, and the older one never touches the newer one's.
   *    The image the platform lists, its digest set aside — the same image is
   *    listed with or without one, depending on how the machine was last
   *    updated. A listing that does not carry it says nothing: the machine is
   *    left, never judged different. Never the harness address: every API
   *    machine has its own, and comparing it would make each instance empty the
   *    others' stock.
   *
   * **A machine assigned to a run is not judged here** while the maintenance has
   * a sweep: once its runner answered the assignment, it carries the label of the
   * run it serves and the end of its life, and the sweep judges it on that run's
   * row — the window of a started machine guesses at how long a run lasts, the
   * row says it. One that carries the label without a readable end — the two
   * are written separately, and the second can fail — is judged here as any
   * other: the sweep would never take it past a fallback, having no end to count
   * from. A reconciliation with no sweep to leave it to judges each as any other.
   *
   * Anything else is left alone. Being conservative here costs a little money;
   * being wrong costs someone's run.
   *
   * **The listing is old by the time a destruction leaves.** The machines are
   * destroyed one after the other, and another instance may wake one it holds
   * for a run in between: a machine judged not started is therefore destroyed
   * without force, which the platform refuses for a machine running by then —
   * spared, never counted —, and one created and never started only once no
   * fill can start it any more ({@link destroyOrphan}). Only a destruction the
   * platform did is counted, in `destroyed` and in the pool's counters.
   *
   * `signal`, a pass's: each destruction takes it, and none is started once it
   * has aborted.
   */
  async reconcile(
    listing?: RunnerPoolListing,
    signal?: AbortSignal,
  ): Promise<{ destroyed: number; forgotten: number }> {
    let destroyed = 0;
    let forgotten = 0;

    // A maintenance pass hands the listing it shares with the sweep; a direct
    // caller gets one of its own.
    const own = listing ?? (await this.listSent());
    if (!own) return { destroyed: 0, forgotten: 0 };
    const live = own.machines;

    const liveIds = new Set(live.map((m) => m.id));
    for (const known of this.all()) {
      if (liveIds.has(known.machineId)) {
        if (known.absentListings !== undefined) known.absentListings = 0;
        continue;
      }
      if (own.sentAt < known.createdAt) continue; // sent before it was registered
      known.absentListings = (known.absentListings ?? 0) + 1;
      if (known.absentListings < VANISHED_AFTER_LISTINGS) continue;
      this.forget(known.machineId);
      forgotten += 1;
      this.vanished += 1;
      this.logger.warn(
        {
          event: "pool_machine_vanished",
          machine_id: known.machineId,
          machine_state: known.state,
        },
        "a pooled machine this process held is no longer listed, and this process did not destroy it",
      );
    }

    const idleLimit = this.options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    const startedWindow = this.startedOrphanWindowMs;

    for (const machine of live) {
      if (signal?.aborted) break;
      if (!machine.name.startsWith(POOL_MACHINE_NAME_PREFIX)) continue;
      if (this.machines.has(machine.id)) continue; // ours — its own lifecycle applies
      // Assigned to a run, and declaring the end of its life: the sweep judges
      // it on that run's row, its end past the grace for a fallback.
      if (
        this.sweep &&
        runLabelOf(machine) !== undefined &&
        declaredLifetimeEndMs(machine) !== undefined
      ) {
        continue;
      }

      const reason = this.orphanReason(machine, idleLimit, startedWindow);
      if (!reason) continue;

      if (await this.destroyOrphan(machine, reason, signal)) destroyed += 1;
    }

    return { destroyed, forgotten };
  }

  /**
   * Destroy a pooled machine the reconciliation judged, counted only once the
   * platform has destroyed it; whether it did. Its listing is already old when
   * the destruction leaves — another process may have woken the machine for a
   * run since —, so a machine judged not started goes without force, which the
   * platform refuses for a machine running by then (the `force` option of
   * {@link FlyMachinesApi.destroy}):
   *
   *  - listed stopped, suspended or failed: without force. A refusal is a
   *    machine woken since the listing, or no longer destructible so: spared —
   *    one `pool_orphan_spared` line, never a failure, never a destruction;
   *  - listed created and never started: the platform refuses it without force
   *    whatever happens, and only its fill starts it — a fill this process's
   *    bound holds ({@link fillHoldBoundMs}). Created longer ago than that
   *    bound, the platform says, no fill can start it any more: with force.
   *    Younger, or with no creation time to read: spared, left to a later pass;
   *  - abandoned — started, untouched past the window of a started machine: with
   *    force, as before. The window is what protects it.
   *
   * A destruction that fails is counted (`destroyFailures`) and logged. One
   * without force the platform refused with a 412 the client did not read as a
   * refusal in the machine's state — its body cut on every attempt, or another
   * — is a refusal still: the machine may have been woken since the listing, and
   * its line says to check it before destroying it by hand, never that a manual
   * cleanup may be required.
   */
  private async destroyOrphan(
    machine: Machine,
    reason: "parked" | "image" | "idle" | "abandoned",
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let force = true;
    if (reason !== "abandoned") {
      if (machine.state !== "created") {
        force = false;
      } else if (!this.createdBeforeFillBound(machine)) {
        this.logSpared(machine, reason, "created_within_fill_bound");
        return false;
      }
    }
    let outcome: MachineDestroyOutcome;
    try {
      outcome = await this.flyApi.destroy(machine.id, { signal, force });
    } catch (err) {
      this.recordDestroyFailure();
      if (!force && err instanceof MachineSpawnError && err.details.httpStatus === 412) {
        this.logger.warn(
          {
            event: "pool_destroy_failed",
            machine_id: machine.id,
            machine_state: machine.state,
            ...errorFields(err),
          },
          "orphan destroy refused (412) without a reason this server reads — the machine may " +
            "have been woken since the listing: check it before destroying it by hand",
        );
        return false;
      }
      this.logger.warn(
        { event: "pool_destroy_failed", machine_id: machine.id },
        "orphan destroy failed — manual cleanup may be required",
      );
      return false;
    }
    if (outcome === "refused-in-state") {
      this.logSpared(machine, reason, "refused_in_state");
      return false;
    }
    if (reason === "image") {
      this.drains += 1;
      this.logger.info(
        {
          event: "pool_drain",
          machine_id: machine.id,
          machine_state: machine.state,
          reason: "image",
        },
        "drained a pooled machine an older process left from another image",
      );
    } else {
      this.orphansDestroyed += 1;
      this.logger.info(
        {
          event: "pool_orphan_destroyed",
          machine_id: machine.id,
          machine_state: machine.state,
          reason,
          age_ms: elapsedSince(machine.updated_at ?? machine.created_at, this.now()),
        },
        "destroyed an unreachable pooled machine",
      );
    }
    return true;
  }

  /** One line for a pooled machine the reconciliation judged and did not destroy — and why. */
  private logSpared(
    machine: Machine,
    reason: "parked" | "image" | "idle" | "abandoned",
    spared: "refused_in_state" | "created_within_fill_bound",
  ): void {
    this.logger.info(
      {
        event: "pool_orphan_spared",
        machine_id: machine.id,
        machine_state: machine.state,
        reason,
        spared,
      },
      spared === "refused_in_state"
        ? "the platform refused to destroy a pooled machine in its current state — woken since it was listed; spared"
        : "a pooled machine created and never started is younger than a fill's bound; left to a later pass",
    );
  }

  /**
   * Whether the platform created a machine longer ago than a fill can hold one
   * ({@link fillHoldBoundMs}): no fill can start it any more. Its creation time,
   * never its last update; unreadable, it is not.
   */
  private createdBeforeFillBound(machine: Machine): boolean {
    const age = elapsedSince(machine.created_at, this.now());
    return age !== undefined && age >= this.fillHoldBoundMs();
  }

  /** A listing of its own, with when it was sent, for a direct call of {@link reconcile}. */
  private async listSent(): Promise<RunnerPoolListing | undefined> {
    const sentAt = this.now();
    const machines = await this.listMachines();
    return machines ? { machines, sentAt } : undefined;
  }

  /** Every machine of the app, or undefined — logged — when the platform cannot be listed. */
  private async listMachines(signal?: AbortSignal): Promise<Machine[] | undefined> {
    try {
      return await this.flyApi.list({ signal });
    } catch (err) {
      this.logger.warn(
        { event: "pool_reconcile_failed", ...errorFields(err) },
        "could not list machines — skipping reconciliation",
      );
      return undefined;
    }
  }

  /** Why a pooled machine this process does not hold is to be destroyed, or undefined to leave it. */
  private orphanReason(
    machine: Machine,
    idleLimit: number,
    startedWindow: number,
  ): "parked" | "image" | "idle" | "abandoned" | undefined {
    const notStarted = NOT_STARTED_STATES.has(machine.state);
    if (notStarted && !this.enabled && this.createdBeforeThisProcess(machine)) return "parked";
    if (notStarted && this.createdBeforeThisProcess(machine) && this.imageDiffers(machine)) {
      return "image";
    }
    const age = elapsedSince(machine.updated_at ?? machine.created_at, this.now());
    if (age === undefined) return undefined; // no usable timestamp — leave it alone
    if (notStarted && age >= idleLimit) return "idle";
    if (machine.state === "started" && age >= startedWindow) return "abandoned";
    return undefined;
  }

  /**
   * Whether the platform created a machine before this pool was built. Its
   * creation time, never its last update: a machine paused or relabelled since
   * is no younger for it. Unreadable, it is not.
   */
  protected createdBeforeThisProcess(machine: Machine): boolean {
    const createdAt =
      machine.created_at === undefined ? Number.NaN : Date.parse(machine.created_at);
    return Number.isFinite(createdAt) && createdAt < this.startedAt;
  }

  /**
   * Whether the platform lists a machine with an image other than this
   * process's. False when the listing does not carry its image: unknown is
   * never "different".
   */
  protected imageDiffers(machine: Machine): boolean {
    const listed = machine.config?.image ?? "";
    if (listed === "") return false;
    return !sameImage(listed, this.options.imageTag);
  }

  private cachedInfraHosts: string[] | undefined;

  /** Resolve the infrastructure hosts once, then reuse — see {@link RunnerPoolOptions.infraHosts}. */
  protected async resolveInfraHosts(): Promise<string[]> {
    if (this.cachedInfraHosts) return this.cachedInfraHosts;
    const configured = this.options.infraHosts;
    this.cachedInfraHosts =
      typeof configured === "function" ? await configured() : (configured ?? []);
    return this.cachedInfraHosts;
  }

  /**
   * Poll the runner's health endpoint until it answers or the budget runs out,
   * and return the process it identified itself as. That value is what later
   * tells a genuine wake from a silent cold boot — see {@link classifyResume}.
   * Undefined against an image that does not report one.
   *
   * `signal`, the fill's: once it aborts, the probe in flight and the wait
   * between two probes end, and the call rejects with its reason.
   */
  protected async waitForReady(baseUrl: string, signal?: AbortSignal): Promise<string | undefined> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const interval = this.options.bootPollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS;
    const deadline = this.now() + (this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS);

    const bounds = RUNNER_CALL_BOUNDS.healthz;
    let lastError: unknown;
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      // Each probe within its own bound, its body included; the budget is
      // checked between probes.
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await callRunner(
          fetchImpl,
          `${baseUrl}/healthz`,
          { method: "GET" },
          { headersTimeoutMs: bounds.timeoutMs, signal },
        );
      } catch (err) {
        signal?.throwIfAborted();
        lastError = err;
        await this.sleepFor(interval, signal);
        continue;
      }
      if (res.ok) {
        // The machine answered: read the process it says it is, within what is
        // left of the probe's bound, against the contract's answer. An answer
        // past the bounds — too large, or still coming at the deadline — writes
        // the fill off. Any other failure of the read does not, nor an answer
        // that cannot be parsed or is not the contract's: the machine answered,
        // and "cannot tell" is better than writing it off.
        let body: unknown = null;
        try {
          body = await readRunnerJson(res, {
            maxBytes: bounds.maxBytes,
            deadlineMs: Math.max(0, bounds.timeoutMs - (Date.now() - startedAt)),
            what: "/healthz",
            signal,
          });
        } catch (err) {
          signal?.throwIfAborted();
          if (err instanceof RunnerResponseTooLarge || err instanceof RunnerBodyTimeout) throw err;
        }
        const answer = HealthzResultSchema.safeParse(body);
        return answer.success ? answer.data.process_id : undefined;
      }
      discardRunnerBody(res);
      lastError = new Error(`/healthz returned HTTP ${res.status}`);
      await this.sleepFor(interval, signal);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "runner never became ready"));
  }

  /**
   * Wait `ms` — on the injected sleep when there is one —, ended early, and
   * rejected with its reason, once `signal` aborts.
   */
  protected sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
    const injected = this.options.sleepImpl;
    if (!injected) return pause(ms, signal);
    return signal ? untilAborted(injected(ms), signal) : injected(ms);
  }
}

/**
 * A wait of `ms` that never holds the process open on its own, ended early —
 * its timer cleared, the wait rejected with the signal's reason — once `signal`
 * aborts.
 */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `work`, or a rejection with the signal's reason once `signal` aborts — whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** What a pass's, or a fill's, signal aborts with once its bound is spent. */
class PoolBoundSpent extends Error {
  constructor(what: "pass" | "fill", boundMs: number) {
    super(
      `${what === "pass" ? "the maintenance pass" : "the fill of one machine"} reached its bound (${Math.ceil(boundMs / 1000)}s)`,
    );
    this.name = "PoolBoundSpent";
  }
}

/**
 * A signal that aborts with {@link PoolBoundSpent} once `ms` have passed. Its
 * timer never holds the process open; `end()` clears it, and is called once the
 * work it bounds has ended, whatever it ended on.
 */
function armedBound(what: "pass" | "fill", ms: number): { signal: AbortSignal; end(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PoolBoundSpent(what, ms)), ms);
  timer.unref?.();
  return { signal: controller.signal, end: () => clearTimeout(timer) };
}

/** Milliseconds since an ISO timestamp, or undefined when it is missing or unparseable. */
function elapsedSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now - at : undefined;
}

/** A digest that ends an image reference: `repo:tag@sha256:<hex>`. */
const IMAGE_DIGEST = /@sha256:[0-9a-f]+$/i;

/**
 * Whether a listed image is the configured one. The platform lists the same
 * image with its digest or without it, depending on how the machine was last
 * updated: the listed digest is set aside when the configured reference names
 * none. A configured reference that pins a digest is compared whole.
 */
function sameImage(listed: string, configured: string): boolean {
  return listed === configured || listed.replace(IMAGE_DIGEST, "") === configured;
}
