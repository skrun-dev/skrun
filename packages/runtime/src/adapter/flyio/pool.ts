import { randomBytes } from "node:crypto";
import type { Logger } from "../../logger.js";
import { createLogger } from "../../logger.js";
import type { FlyMachinesApi, MachineGuest } from "./fly-api.js";
import { buildPoolMachineConfig, POOL_MACHINE_NAME_PREFIX } from "./machine-config.js";
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
   * When this process created it, by its own clock. Used for expiry only.
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
  state: PooledMachineState;
}

export interface RunnerPoolOptions {
  /** Target number of ready machines. 0 disables the pool entirely. */
  size: number;
  /** Image tag pooled machines are created from — also the staleness reference. */
  imageTag: string;
  /** Fly region for pooled machines. */
  region?: string;
  /** Port the in-machine runner listens on. */
  runnerPort?: number;
  /** Per-run timeout propagated to the runner. */
  maxRunTimeoutMs?: number;
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
  /** Machines disposed of for being stale or expired — spikes after every image deploy. */
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
}

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_IDLE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_BOOT_TIME_MS = 120_000;
const DEFAULT_BOOT_POLL_INTERVAL_MS = 1_000;
/**
 * How many run-timeouts a started pool machine must sit untouched before it is
 * considered abandoned. Generous on purpose: the cost of waiting is a little
 * money, the cost of being wrong is somebody's run.
 */
const ORPHAN_RUN_TIMEOUT_FACTOR = 4;

export class RunnerPool {
  protected readonly machines = new Map<string, PooledMachine>();
  protected readonly logger: Logger;
  protected readonly now: () => number;
  /** Handle for the background maintenance loop; null until {@link start}. */
  protected maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected readonly flyApi: FlyMachinesApi,
    protected readonly options: RunnerPoolOptions,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger("runner-pool");
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.options.size;
  }

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
    };
    for (const entry of this.machines.values()) stats[entry.state] += 1;
    return stats;
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
   * state rather than on this process's registry.
   *
   * Idempotent. The timer is unref'd, so it never keeps a process alive on its
   * own — a server that is shutting down does not linger for a pool top-up.
   */
  start(): void {
    if (!this.enabled || this.maintenanceTimer) return;
    const intervalMs = this.options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.logger.info(
      { event: "pool_started", size: this.options.size, interval_ms: intervalMs },
      "pre-warm pool maintenance started",
    );
    // Fill now rather than one interval from now: at boot the pool is empty, and
    // waiting a full interval would send the first runs down the cold path.
    void this.maintain();
    this.maintenanceTimer = setInterval(() => void this.maintain(), intervalMs);
    this.maintenanceTimer.unref?.();
  }

  /** Stop the background loop. Safe to call when it was never started. */
  stop(): void {
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.logger.info({ event: "pool_stopped" }, "pre-warm pool maintenance stopped");
  }

  /**
   * Ask for a top-up without waiting for the next tick — used right after a run
   * takes a machine, so the deficit is not carried for a whole interval. Never
   * awaited by the caller: a request must not pay for the next run's machine.
   *
   * Inert until {@link start} has run. This is an *acceleration* of the
   * maintenance loop, so with no loop there is nothing to accelerate — and it
   * keeps the rule that a pool nobody started never creates anything on its own.
   */
  requestTopUp(): void {
    if (!this.enabled || !this.maintenanceTimer) return;
    void this.fill().catch((err) => {
      this.logger.warn(
        { event: "pool_fill_failed", error: err instanceof Error ? err.message : String(err) },
        "top-up after a claim failed",
      );
    });
  }

  /**
   * One maintenance pass. Both halves are already fail-soft internally; the
   * belt-and-braces catch here is because this runs from a timer, where an
   * unhandled rejection takes the whole server down rather than one pool cycle.
   */
  protected async maintain(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.logger.warn(
        { event: "pool_reconcile_failed", error: err instanceof Error ? err.message : String(err) },
        "reconciliation pass failed",
      );
    }
    try {
      await this.fill();
    } catch (err) {
      this.logger.warn(
        { event: "pool_fill_failed", error: err instanceof Error ? err.message : String(err) },
        "fill pass failed",
      );
    }
  }

  async fill(): Promise<void> {
    if (!this.enabled || this.filling) return;
    this.filling = true;
    try {
      while (this.deficit() > 0) {
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
   */
  protected async addOne(): Promise<boolean> {
    const claimToken = randomBytes(32).toString("hex");
    const poolId = randomBytes(8).toString("hex");
    const port = this.options.runnerPort ?? 9000;
    let machineId: string | null = null;

    try {
      const machine = await this.flyApi.create(
        buildPoolMachineConfig({
          poolId,
          image: this.options.imageTag,
          claimToken,
          region: this.options.region,
          runnerPort: port,
          maxRunTimeoutMs: this.options.maxRunTimeoutMs,
          dnsResolveIntervalSeconds: this.options.dnsResolveIntervalSeconds,
          guest: this.options.guest,
          infraHosts: await this.resolveInfraHosts(),
          harness6pn: this.options.harness6pn,
        }),
      );
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
      const processId = await this.waitForReady(buildRunnerBaseUrl(privateIp, port));
      const entry = this.machines.get(machineId);
      if (entry) entry.processId = processId;
      await this.flyApi.suspend(machineId);
      this.markReady(machineId);

      this.logger.info(
        { event: "pool_fill", machine_id: machineId, ready: this.stats().ready },
        "pooled machine ready",
      );
      return true;
    } catch (err) {
      this.fillErrors += 1;
      this.logger.warn(
        {
          event: "pool_fill_failed",
          machine_id: machineId,
          error: err instanceof Error ? err.message : String(err),
        },
        "pooled machine could not be prepared",
      );
      if (machineId) {
        this.forget(machineId);
        await this.flyApi.destroy(machineId).catch(() => {
          this.logger.warn(
            { event: "pool_destroy_failed", machine_id: machineId },
            "pooled machine destroy failed — manual cleanup may be required",
          );
        });
      }
      return false;
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
   */
  async drainStale(): Promise<number> {
    let drained = 0;
    for (const machine of this.all()) {
      if (machine.state === "claimed" || machine.state === "draining") continue;
      const stale = this.isStale(machine);
      if (!stale && !this.isExpired(machine)) continue;

      this.markDraining(machine.machineId);
      this.forget(machine.machineId);
      this.drains += 1;
      drained += 1;
      this.logger.info(
        {
          event: "pool_drain",
          machine_id: machine.machineId,
          reason: stale ? "stale" : "expired",
        },
        "draining a pooled machine",
      );
      await this.flyApi.destroy(machine.machineId).catch(() => {
        this.logger.warn(
          { event: "pool_destroy_failed", machine_id: machine.machineId },
          "pooled machine destroy failed — manual cleanup may be required",
        );
      });
    }
    return drained;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  private orphansDestroyed = 0;
  private hits = 0;
  private misses = 0;

  /** Record that a run was served from the pool. */
  recordHit(): void {
    this.hits += 1;
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
   * ⚠️ **Not keyed on "this process does not know it".** More than one harness may
   * run at a time, each holding its own inventory, and the machines are
   * indistinguishable by name. "I have never heard of it" would therefore include
   * another instance's ready machine — and, worse, another instance's machine
   * *currently serving a run*. Destroying on that basis would kill live runs.
   *
   * The predicate is instead the platform's own state plus age, which every
   * instance sees identically and neither can misread:
   *
   *  - **suspended and past the idle limit** — no run can be on it, and no
   *    instance would still want it, since any of them would have expired it too.
   *  - **started and untouched for far longer than a run may last** — nothing is
   *    using it; a machine serving a run was touched when it was woken.
   *
   * Anything else is left alone. Being conservative here costs a little money;
   * being wrong costs someone's run.
   */
  async reconcile(): Promise<{ destroyed: number; forgotten: number }> {
    let destroyed = 0;
    let forgotten = 0;

    let live: Awaited<ReturnType<FlyMachinesApi["list"]>>;
    try {
      live = await this.flyApi.list();
    } catch (err) {
      this.logger.warn(
        { event: "pool_reconcile_failed", error: err instanceof Error ? err.message : String(err) },
        "could not list machines — skipping reconciliation",
      );
      return { destroyed: 0, forgotten: 0 };
    }

    const liveIds = new Set(live.map((m) => m.id));
    for (const known of this.all()) {
      if (!liveIds.has(known.machineId)) {
        this.forget(known.machineId);
        forgotten += 1;
      }
    }

    const idleLimit = this.options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
    const runLimit = (this.options.maxRunTimeoutMs ?? 300_000) * ORPHAN_RUN_TIMEOUT_FACTOR;

    for (const machine of live) {
      if (!machine.name.startsWith(POOL_MACHINE_NAME_PREFIX)) continue;
      if (this.machines.has(machine.id)) continue; // ours — its own lifecycle applies

      const age = elapsedSince(machine.updated_at ?? machine.created_at, this.now());
      if (age === undefined) continue; // no usable timestamp — leave it alone

      const disposable =
        (machine.state === "suspended" && age >= idleLimit) ||
        (machine.state === "started" && age >= runLimit);
      if (!disposable) continue;

      this.orphansDestroyed += 1;
      destroyed += 1;
      this.logger.info(
        {
          event: "pool_orphan_destroyed",
          machine_id: machine.id,
          machine_state: machine.state,
          age_ms: age,
        },
        "destroying an unreachable pooled machine",
      );
      await this.flyApi.destroy(machine.id).catch(() => {
        this.logger.warn(
          { event: "pool_destroy_failed", machine_id: machine.id },
          "orphan destroy failed — manual cleanup may be required",
        );
      });
    }

    return { destroyed, forgotten };
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
   */
  protected async waitForReady(baseUrl: string): Promise<string | undefined> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const sleep = this.options.sleepImpl ?? defaultSleep;
    const interval = this.options.bootPollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS;
    const deadline = this.now() + (this.options.maxBootTimeMs ?? DEFAULT_MAX_BOOT_TIME_MS);

    let lastError: unknown;
    while (this.now() < deadline) {
      try {
        const res = await fetchImpl(`${baseUrl}/healthz`, { method: "GET" });
        if (res.ok) {
          // A body we cannot read is not a boot failure: the machine answered.
          // Degrade to "cannot tell" rather than writing the fill off.
          const body = (await res.json().catch(() => ({}))) as { process_id?: unknown };
          return typeof body.process_id === "string" ? body.process_id : undefined;
        }
        lastError = new Error(`/healthz returned HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await sleep(interval);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "runner never became ready"));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Milliseconds since an ISO timestamp, or undefined when it is missing or unparseable. */
function elapsedSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now - at : undefined;
}
