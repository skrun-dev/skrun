/**
 * The sweep of the run machines: every machine the cloud runtime created for a
 * run, judged on its run's row in the database — never on what this process
 * remembers. Several processes share one app of machines and one database, and
 * each knows only its own runs: a machine this process does not know may be
 * serving another's.
 *
 * It runs inside the pool's maintenance, on the listing the pass reconciled on
 * and under the pass's signal. A machine is a run's when its name is
 * `skrun-run-<run id>` — its label (`skrun_run_id`) names the run when it
 * carries one, its name otherwise —, or when it is a pooled machine
 * (`skrun-pool-…`) that carries the label of the run it was assigned to,
 * written once its runner answered the assignment; a pooled machine that
 * carries none is the reconciliation's. A destruction under way or done is not
 * judged again. Every other state is — a machine the platform left stopped
 * still bills its disk. For each:
 *
 * - **younger than the read floor** — the longest a run spends acquiring its
 *   machine —: not read; its run is still getting it. A run's machine is aged
 *   from its creation; a pooled one from its last update — its creation dates
 *   its fill, and the write of its labels moved its last update to its
 *   assignment;
 * - **its run finished** more than a grace ago → destroyed (`finished`);
 * - **its run still running**, its seat's deadline more than a grace past →
 *   destroyed (`deadline`); before that, spared whatever its age;
 * - **no row** (`no_row`), **a row without a deadline** (`no_deadline`), **a
 *   finished row without its end** (`finished`): destroyed only past its
 *   fallback — for a run's machine, the lifetime it declares plus the grace,
 *   or, declaring none, the fallback for a machine without one; for a pooled
 *   one, the end of its life it declares plus the grace, and, declaring none,
 *   never: its age says nothing of its run. A run id that is not a uuid has no
 *   row by construction — the route mints every run id as one — and is judged
 *   so without asking a database that would refuse it. A machine whose age the
 *   listing does not give is read, and spared when the row cannot judge it.
 *
 * **A read that fails spares the machine**, counted (`readFailures`) and logged
 * (`run_machine_sweep_read_failed`, by the error's class): a database fault is
 * never taken for a run that does not exist, which would destroy runs in
 * flight. Each destruction is logged (`run_machine_swept`, with its reason); one
 * that fails is counted on the pool's counter of failed destructions and logged
 * (`run_machine_sweep_destroy_failed`). A machine already gone is a destruction
 * done — the platform's client says so.
 *
 * **The pass's signal ends the sweep where it stands.** The pool does not race
 * the sweep against its bound, so the sweep does: a read in flight when the
 * signal aborts is not waited for — the machine spared, counted as a read that
 * failed — and nothing more is read or destroyed. The sweep then hands back what
 * it did, which the pool counts.
 *
 * An app of runner machines belongs to one database: a second database sharing
 * it would find every row absent, and destroy every machine past its fallback.
 */
import {
  createLogger,
  declaredLifetimeEndMs,
  declaredLifetimeMs,
  type FlyMachinesApi,
  type Logger,
  type Machine,
  machineNameForRun,
  POOL_MACHINE_NAME_PREFIX,
  type RunnerPool,
  runLabelOf,
} from "@skrun-dev/runtime";
import type { DbAdapter } from "../db/adapter.js";
import type { Run } from "../db/schema.js";
import { errorFields } from "../utils/error-fields.js";

/** The hook the pool's maintenance runs a sweep through. */
export type RunnerPoolSweep = NonNullable<NonNullable<Parameters<RunnerPool["start"]>[0]>["sweep"]>;

/** What a sweep of the run machines is built on. */
export interface RunMachineSweepOptions {
  /** Where each machine's run is read — the database every process shares. */
  db: Pick<DbAdapter, "getRun">;
  /** The platform's client: the destructions go through it. */
  flyApi: Pick<FlyMachinesApi, "destroy">;
  /** The pool whose counter of failed destructions a failed one is counted on. */
  pool: Pick<RunnerPool, "recordDestroyFailure">;
  logger?: Logger;
  /** The clock machines' ages and rows' instants are read on. Default `Date.now`. */
  now?: () => number;
  /** How old a machine must be before its run is read, in ms: the longest acquisition. */
  readFloorMs: number;
  /** The grace past a run's end, a seat's deadline or a machine's lifetime, in ms. */
  graceMs: number;
  /** How old a machine that declares no lifetime must be before it goes without a row, in ms. */
  fallbackMs: number;
}

/** Why a run machine was destroyed. */
export type RunMachineSweptReason = "finished" | "deadline" | "no_row" | "no_deadline";

/** The name prefix of a run's machine — derived from the name the runtime gives one. */
const RUN_MACHINE_NAME_PREFIX = machineNameForRun("");

/** A run id the route mints (`randomUUID`) — the only form a run's row can carry. */
const RUN_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** States a machine is in once its destruction has begun: nothing left to judge. */
const BEING_DESTROYED: ReadonlySet<string> = new Set(["destroying", "destroyed"]);

/** Whether a listed machine is a pooled one — made ahead of any run. */
function isPooled(machine: Machine): boolean {
  return machine.name.startsWith(POOL_MACHINE_NAME_PREFIX);
}

/**
 * The run a listed machine serves, or undefined when it is not a run's machine:
 * a run's machine by its label, else its name; a pooled one by the label of the
 * run it was assigned to only.
 */
function runIdOf(machine: Machine): string | undefined {
  if (isPooled(machine)) return runLabelOf(machine);
  if (!machine.name.startsWith(RUN_MACHINE_NAME_PREFIX)) return undefined;
  const label = runLabelOf(machine);
  if (label !== undefined) return label;
  const fromName = machine.name.slice(RUN_MACHINE_NAME_PREFIX.length);
  return fromName === "" ? undefined : fromName;
}

/** An instant written as text, in ms — undefined when absent or unreadable. */
function instantOf(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The sweep's own read was cut by the pass's signal. */
class ReadCut extends Error {
  constructor() {
    super("the read of the run's row was cut by the maintenance pass's bound");
    this.name = "ReadCut";
  }
}

/**
 * `work`, or a rejection as soon as `signal` aborts — whichever comes first. The
 * work is not cancelled: a read in flight answers to no one.
 */
function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ReadCut());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ReadCut());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The sweep of the run machines, for the pool's maintenance to run on each pass. */
export function createRunMachineSweep(options: RunMachineSweepOptions): RunnerPoolSweep {
  const logger = options.logger ?? createLogger("machine-sweep");
  const now = options.now ?? Date.now;

  /**
   * Whether a machine is past its fallback. A pooled one: the end of its life it
   * declares plus the grace — one that declares none never is. A run's machine:
   * the lifetime it declares plus the grace, or the fallback for one that
   * declares none — one whose age is unknown never is.
   */
  const pastFallback = (machine: Machine, at: number, ageMs: number | undefined): boolean => {
    if (isPooled(machine)) {
      const end = declaredLifetimeEndMs(machine);
      return end !== undefined && at - end > options.graceMs;
    }
    if (ageMs === undefined) return false;
    const declared = declaredLifetimeMs(machine);
    const limit = declared === undefined ? options.fallbackMs : declared + options.graceMs;
    return ageMs > limit;
  };

  /** Why the machine goes, judged on its run's row — undefined to spare it. */
  const verdict = (
    machine: Machine,
    run: Run | null,
    at: number,
    ageMs: number | undefined,
  ): RunMachineSweptReason | undefined => {
    if (run === null) return pastFallback(machine, at, ageMs) ? "no_row" : undefined;
    if (run.status !== "running") {
      const end = instantOf(run.completed_at);
      if (end === undefined) return pastFallback(machine, at, ageMs) ? "finished" : undefined;
      return at - end > options.graceMs ? "finished" : undefined;
    }
    const deadline = instantOf(run.deadline_at);
    if (deadline === undefined) return pastFallback(machine, at, ageMs) ? "no_deadline" : undefined;
    return at - deadline > options.graceMs ? "deadline" : undefined;
  };

  return async (live, signal) => {
    let destroyed = 0;
    let readFailures = 0;
    for (const machine of live) {
      if (signal.aborted) break;
      const runId = runIdOf(machine);
      if (runId === undefined || BEING_DESTROYED.has(machine.state)) continue;
      const at = now();
      // A pooled machine's creation dates its fill: aged from its last update,
      // which the write of its labels moved to its assignment.
      const since = instantOf(
        isPooled(machine) ? (machine.updated_at ?? machine.created_at) : machine.created_at,
      );
      const ageMs = since === undefined ? undefined : at - since;
      if (ageMs !== undefined && ageMs < options.readFloorMs) continue;

      let run: Run | null;
      if (!RUN_ID_FORM.test(runId)) {
        run = null;
      } else {
        try {
          run = await untilAborted(() => options.db.getRun(runId), signal);
        } catch (err) {
          readFailures += 1;
          logger.warn(
            {
              event: "run_machine_sweep_read_failed",
              run_id: runId,
              machine_id: machine.id,
              machine_state: machine.state,
              ...errorFields(err),
            },
            "the run of a run machine could not be read — the machine is spared",
          );
          continue;
        }
      }

      const reason = verdict(machine, run, at, ageMs);
      if (reason === undefined) continue;
      try {
        await options.flyApi.destroy(machine.id, { signal });
      } catch (err) {
        options.pool.recordDestroyFailure();
        logger.warn(
          {
            event: "run_machine_sweep_destroy_failed",
            run_id: runId,
            machine_id: machine.id,
            machine_state: machine.state,
            reason,
            ...errorFields(err),
          },
          "a run machine the sweep judged done could not be destroyed",
        );
        continue;
      }
      destroyed += 1;
      logger.info(
        {
          event: "run_machine_swept",
          run_id: runId,
          machine_id: machine.id,
          machine_state: machine.state,
          reason,
        },
        "run machine destroyed by the sweep",
      );
    }
    return { destroyed, readFailures };
  };
}
