// How long a run's machine may live — what the harness writes into it, and what
// the sweep of the run machines and the operator's cleanup read back — one
// definition for the three.
//
// A machine is billed for as long as it exists. The run that asked for it
// destroys it when it ends, but a process that dies, sleeps or loses its
// database destroys nothing: past its lifetime a machine is judged dead by
// whoever looks, and past it plus a grace it is fair game.
//
// The adapter imports this module, and `acquisition-budget.ts` reads the
// adapter's constants: so nothing here calls into it while the module loads —
// the fallback for a machine that declares no lifetime is a function, read at
// call time, for the reason `acquisition-budget.ts` gives.

import { seatDeadlineMarginMs } from "./acquisition-budget.js";
import { FLY_APP_ACTION_BURST, type Machine, RUN_LABEL_KEY } from "./fly-api.js";

/**
 * The grace past a machine's lifetime, in ms — five minutes. Added to the hold
 * of its run's seat to make the lifetime a machine is created with, and past
 * that lifetime again before the sweep or the cleanup takes the machine for
 * abandoned: a machine is never judged dead on a clock that runs a little
 * late, nor while its run is writing its end.
 */
export const MACHINE_LIFETIME_GRACE_MS = 300_000;

/**
 * The environment variable a run's machine carries its lifetime in, in whole
 * seconds. Seconds rather than milliseconds: what reads it inside the machine
 * counts elapsed seconds, never a timer.
 */
export const RUNNER_LIFETIME_ENV = "RUNNER_LIFETIME_S";

/**
 * The metadata key a pooled machine carries the end of its life under, once
 * assigned to a run — beside the run's own label (`RUN_LABEL_KEY`). A pooled
 * machine is created long before its run, with no lifetime: the one it learns at
 * its assignment counts from there, and the end is written as an instant
 * because nothing listed says when that was — a metadata write moves the
 * machine's last update.
 */
export const LIFETIME_END_KEY = "skrun_lifetime_end";

/**
 * The end of a machine's life as its metadata carries it: an instant in ISO
 * 8601, in UTC, to the millisecond (`Date.prototype.toISOString`).
 */
export function lifetimeEndValue(endMs: number): string {
  return new Date(endMs).toISOString();
}

/**
 * The end of its life a listed machine declares in its metadata
 * ({@link LIFETIME_END_KEY}), in ms since the epoch — read only in the form
 * {@link lifetimeEndValue} writes, and only an instant that form names exactly.
 * Anything else — no configuration, no such key, another form, a date that does
 * not exist — is no declaration at all: `undefined`.
 */
export function declaredLifetimeEndMs(machine: Pick<Machine, "config">): number | undefined {
  const raw = machine.config?.metadata?.[LIFETIME_END_KEY];
  if (typeof raw !== "string") return undefined;
  // Written back, it must be the very text read: any other form, or a date
  // that does not exist, reads otherwise.
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || lifetimeEndValue(ms) !== raw) return undefined;
  return ms;
}

/**
 * The run a listed machine's metadata names ({@link RUN_LABEL_KEY}): a machine
 * created for a run carries it from its creation, a pooled one once its runner
 * has answered its assignment. Any non-empty text; `undefined` when it names
 * none — a pooled machine still in stock, or one whose label was never written.
 */
export function runLabelOf(machine: Pick<Machine, "config">): string | undefined {
  const label = machine.config?.metadata?.[RUN_LABEL_KEY];
  return typeof label === "string" && label !== "" ? label : undefined;
}

/**
 * The longest delay a timer of this process accepts, in ms (2^31 − 1): Node
 * arms a longer one for 1 ms. A run's seat is held for its timeout at most this
 * long, so the lifetime of its machine never derives from a longer one.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The timeout of a run whose agent declares none, in ms: the default of the
 * `timeout` an agent's environment declares (`"300s"`).
 */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/** What a machine's lifetime is derived from. */
export interface MachineLifetimeInput {
  /**
   * How long the run's seat is held, in ms: its timeout, capped at the longest
   * timer, plus the margin the seat keeps for the acquisition of its machine and
   * the upload of its outputs.
   */
  seatHoldMs: number;
}

/**
 * The lifetime a run's machine is created with, in whole seconds: the hold of
 * its run's seat plus the grace, rounded up — never a second short.
 */
export function machineLifetimeSeconds({ seatHoldMs }: MachineLifetimeInput): number {
  return Math.ceil((seatHoldMs + MACHINE_LIFETIME_GRACE_MS) / 1000);
}

/**
 * The lifetime a listed machine declares, in ms — read from its environment
 * (`RUNNER_LIFETIME_S`), and only when it is a whole, positive number of
 * seconds. Anything else — no configuration, no such variable, a sign, a
 * decimal point, an exponent, a space, zero, or more than can be counted
 * exactly — is no declaration at all: `undefined`.
 */
export function declaredLifetimeMs(machine: Pick<Machine, "config">): number | undefined {
  const raw = machine.config?.env?.[RUNNER_LIFETIME_ENV];
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
  const ms = Number(raw) * 1000;
  if (ms <= 0 || !Number.isSafeInteger(ms)) return undefined;
  return ms;
}

/**
 * How old a run's machine that declares no lifetime must be before the sweep
 * takes it for abandoned, when its run's row cannot judge it, in ms: the
 * lifetime a run of the default timeout gets, on the platform's burst of
 * creations — its timeout, its seat's margin, the grace. Such a machine was
 * created by a harness from before lifetimes were written. Nothing checks that
 * that harness is gone: the machine's environment is all that is read, so a run
 * it still serves that outlasts the fallback, its row without a deadline, loses
 * its machine. The operator's cleanup, which reads no row, does not use it: it
 * leaves such a machine unless given an age.
 */
export function undeclaredLifetimeFallbackMs(): number {
  return (
    DEFAULT_RUN_TIMEOUT_MS +
    seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST }) +
    MACHINE_LIFETIME_GRACE_MS
  );
}
