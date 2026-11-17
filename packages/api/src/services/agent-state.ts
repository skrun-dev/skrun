/**
 * The state callbacks a run hands the agent loop: which notebook the run reads
 * and writes, and until when the notebook it writes is kept — a notebook past
 * that deadline reads as absent.
 *
 * The loop calls `getState(name)` / `setState(name, state)` with the agent's
 * slug. The slug is ignored: the notebook is bound here, from what the server
 * knows and the request cannot choose — the agent's id (an agent re-created
 * under the same name does not inherit the notebook), the `state.scope` of the
 * version being run, and the caller derived from the credential
 * (`stateCaller`).
 */

import { createLogger, type Logger, type StateCallbacks } from "@skrun-dev/runtime";
import { type StateConfig, stateTtlDays } from "@skrun-dev/schema";
import type { DbAdapter } from "../db/adapter.js";
import type { StatePartition } from "../db/schema.js";
import { isMissingStateReference, StateReadError, StateWriteError } from "../db/state-errors.js";
import { errorFields } from "../utils/error-fields.js";
import type { RunCaller } from "./key-scope.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const sweepLogger = createLogger("agent-state");

/**
 * How often expired notebooks are deleted, on every instance. A code constant,
 * not an environment variable: "deleted within the hour after its deadline" is
 * a retention statement, and a window an operator could widen from the
 * environment would make it false without anyone touching this file.
 */
export const STATE_SWEEP_INTERVAL_MS = 3_600_000; // 1 hour

/**
 * Start the recurring sweep of expired notebooks: one pass now, then one every
 * `STATE_SWEEP_INTERVAL_MS`. Every instance sweeps; two concurrent deletes of
 * the same expired rows are harmless.
 *
 * Call it once a server is actually being run — never from the app factory,
 * which every test also calls. Returns its timer so a caller can observe it
 * and stop it.
 */
export function startStateSweep(
  db: Pick<DbAdapter, "purgeExpiredState">,
  log: Pick<Logger, "error"> = sweepLogger,
): NodeJS.Timeout {
  const sweep = () => {
    // A failed pass is logged, never thrown: a rejection from a timer callback
    // would take the whole process down, turning a database blip into an
    // outage. The next pass tries again. The log carries the error's class and
    // code, never its message.
    void db.purgeExpiredState().catch((err) => {
      log.error({ event: "state_sweep_failed", ...errorFields(err) }, "Expired-state sweep failed");
    });
  };

  // Once at startup, and only then on the interval: without this first pass, a
  // restart — every deploy — would leave a notebook that expired just before it
  // for nearly two intervals.
  sweep();

  const timer = setInterval(sweep, STATE_SWEEP_INTERVAL_MS);
  // Never the reason a process stays alive.
  timer.unref();
  return timer;
}

export interface StateCallbacksOptions {
  db: Pick<DbAdapter, "getState" | "setState">;
  /** The id of the agent being run. */
  agentId: string;
  /** The `state` block of the version being run. */
  state: StateConfig;
  /** Who is running it (`stateCaller`); `null` when the account has no row to attach state to. */
  caller: RunCaller | null;
  log: Pick<Logger, "info" | "warn">;
  /** The clock the deadline is computed from. */
  now?: () => Date;
}

/**
 * The partition a run's notebook lives in: `shared` for an agent that shares
 * one notebook among its callers, otherwise the caller's own — `null` when a
 * per-caller agent is run by a caller with no identity to keep state under.
 */
export function statePartitionFor(
  scope: StateConfig["scope"],
  caller: RunCaller | null,
): StatePartition | null {
  if (scope === "shared") return { kind: "shared" };
  if (caller === null) return null;
  return caller.kind === "account"
    ? { kind: "account", userId: caller.userId }
    : { kind: "key", keyId: caller.keyId };
}

/**
 * The deadline of a notebook written at `now`: `now` plus the agent's `ttl`,
 * read through `stateTtlDays` — a value below the floor counts as the floor, a
 * value above the ceiling (however large) as the ceiling, so a version already
 * published with an out-of-range `ttl` still runs.
 */
export function stateExpiresAt(ttl: string, now: Date): string {
  return new Date(now.getTime() + stateTtlDays(ttl) * DAY_MS).toISOString();
}

export function createStateCallbacks(opts: StateCallbacksOptions): StateCallbacks {
  const { db, agentId, state, caller, log } = opts;
  const now = opts.now ?? (() => new Date());
  const partition = statePartitionFor(state.scope, caller);

  // A per-caller agent run by a caller with no identity: no read, no write
  // (reading under an id that names no account would fail on Postgres anyway).
  // The run itself goes on. Said once per run, not once per call.
  let skipLogged = false;
  const logSkip = (): void => {
    if (skipLogged) return;
    skipLogged = true;
    log.info(
      { event: "state_skipped", reason: "no_account_row" },
      "Run has no account row to keep per-caller state under; state not read or written",
    );
  };

  return {
    getState: async (_agentName: string) => {
      if (partition === null) {
        logSkip();
        return null;
      }
      let stored: Awaited<ReturnType<typeof db.getState>>;
      try {
        stored = await db.getState(agentId, partition);
      } catch (err) {
        // A read is never absorbed: the run fails, under a fixed message, for the
        // same reason as a failed write — the run's error reaches the caller.
        const fields = errorFields(err);
        log.warn(
          { event: "state_read_failed", ...fields },
          "State read failed at the start of the run; the run fails",
        );
        throw new StateReadError(err, fields.error_code);
      }
      if (stored === null) return null;
      // A notebook past its deadline is absent, swept or not yet: the adapter
      // returns it with its deadline, and the decision is taken here, once,
      // for the three backends. Not deleted here: the sweep does that, and a
      // write by this run replaces it anyway.
      if (Date.parse(stored.expires_at) <= now().getTime()) return null;
      return stored.state;
    },
    setState: async (_agentName: string, newState: Record<string, unknown>) => {
      if (partition === null) {
        logSkip();
        return;
      }
      // Computed outside the try: a deadline that cannot be computed is not a
      // refusal of the write, and fails the run.
      const expiresAt = stateExpiresAt(state.ttl, now());
      try {
        await db.setState(agentId, partition, newState, expiresAt);
      } catch (err) {
        // The write is the last step of a run that has succeeded. One refusal
        // is expected: the agent deleted, or the caller's key or account gone,
        // while the run was going — the row would reference what no longer
        // exists. That one is absorbed: the run keeps its result, the log says
        // so. Any other failure (the database down, a timeout, a CHECK) fails
        // the run — under a fixed message: the run's error reaches the caller,
        // and a database's own message can name a table, a constraint, a value.
        const fields = errorFields(err);
        if (!isMissingStateReference(err)) {
          log.warn(
            { event: "state_write_failed", absorbed: false, ...fields },
            "State write failed at the end of the run; the run fails",
          );
          throw new StateWriteError(err, fields.error_code);
        }
        log.warn(
          { event: "state_write_failed", absorbed: true, ...fields },
          "State write refused at the end of the run (agent, account or key gone); the run keeps its result",
        );
      }
    },
  };
}
