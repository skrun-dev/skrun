import { type FlyMachinesApi, type Machine, SEARCH_READS, SEARCH_SPACING_MS } from "./fly-api.js";

/**
 * The search for the machine a creation cut mid-flight may have made. The
 * platform client sends nothing more for a caller that abandoned a creation —
 * no search by its label, no destruction —, so the caller looks for it itself:
 * the adapter, for the creation of a run its acquisition abandoned
 * (adapter.ts), and the pool, for the creation of a fill its bound cut
 * (pool.ts). One definition for both, and its constants with it.
 */

/**
 * How long after a creation's last request its label is still read: a machine
 * is listed some seconds after the request that made it — up to 8.4 s measured
 * —, and a creation sent again makes its machine with its last request. Read at
 * least `SEARCH_READS` times, and until one read leaves this long after that
 * request.
 */
export const CUT_CREATE_SEARCH_MS = 10_000;

/**
 * The most reads the search makes, whatever its clock says: in real time it
 * ends long before, and a clock that does not move — or one behind the clock
 * the creation's last request was dated on — never holds it forever.
 */
export const CUT_CREATE_MAX_READS =
  SEARCH_READS + Math.ceil(CUT_CREATE_SEARCH_MS / SEARCH_SPACING_MS);

/**
 * The longest one step of the search may take — a read, or the destruction of
 * a machine it found —, the client's own patience with a refusal included. A
 * step cut there is reported, never sent again. With five slow reads and two
 * machines (a creation sent twice), the search ends within 75 s.
 */
export const CUT_CREATE_STEP_MS = 10_000;

/** What a step comes to when its bound cut it. */
export const STEP_CUT: unique symbol = Symbol("step cut");

/**
 * `step`, handed a signal that aborts once `ms` have passed: its value, or
 * {@link STEP_CUT} when the bound cut it — any other failure is thrown. Its
 * timer never holds the process open, and is cleared however the step ends.
 */
export async function withinStep<T>(
  step: (signal: AbortSignal) => Promise<T>,
  ms: number = CUT_CREATE_STEP_MS,
): Promise<T | typeof STEP_CUT> {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), ms);
  timer.unref?.();
  try {
    return await step(bound.signal);
  } catch (err) {
    if (bound.signal.aborted) return STEP_CUT;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A destruction the search tried and that left its machine: refused, or cut at its bound. */
export type CutCreationDestroyFailure = { cut: true } | { cut: false; error: unknown };

/** What the search is given: the creation it looks for, its clock, and where it reports. */
export interface CutCreationSearch {
  /** The platform client: only its label reads and its destructions are sent. */
  flyApi: Pick<FlyMachinesApi, "listByLabel" | "destroy">;
  /** The label the creation carried. */
  label: { key: string; value: string };
  /** The name the creation asked for: a machine of its label under another name is not its. */
  name: string;
  /** When the creation's last request left, on the clock of `now`. */
  lastSentAt: number;
  /** The clock a read is dated on when it leaves. */
  now: () => number;
  /** The wait before each read, `SEARCH_SPACING_MS` long. */
  sleep: (ms: number) => Promise<void>;
  /** The bound of one step, in ms. Default {@link CUT_CREATE_STEP_MS}. */
  stepMs?: number;
  /** A read its bound cut, by its rank: it is not sent again. */
  onReadCut(read: number): void;
  /** A machine of the creation, destroyed. */
  onDestroyed(machineId: string): void;
  /**
   * A machine of the creation whose destruction was refused, or cut at its
   * bound: left billing. Called for every one, in both cases — the caller
   * counts it among its failed destructions.
   */
  onDestroyFailed(machineId: string, failure: CutCreationDestroyFailure): void;
}

/** What the search found, and destroyed. */
export interface CutCreationSearchResult {
  found: number;
  destroyed: number;
}

/**
 * Look for the machine a creation cut mid-flight may have made, and destroy it.
 * The creation's label is read a second apart, at least `SEARCH_READS` times
 * and until a read leaves {@link CUT_CREATE_SEARCH_MS} after the creation's
 * last request — {@link CUT_CREATE_MAX_READS} times at most —, and every
 * machine of its label and name not on its way out is destroyed, once — two at
 * most, a creation sent twice. Each read, each destruction, within one step
 * (`stepMs`): what is cut is reported, never sent again. A read that fails
 * otherwise ends the search: it rejects with that failure. Best effort: what it
 * misses is left to the platform-side sweep or the reconciliation.
 */
export async function searchCutCreation(
  search: CutCreationSearch,
): Promise<CutCreationSearchResult> {
  const stepMs = search.stepMs ?? CUT_CREATE_STEP_MS;
  const found = new Set<string>();
  let destroyed = 0;
  for (let read = 1; read <= CUT_CREATE_MAX_READS; read++) {
    await search.sleep(SEARCH_SPACING_MS);
    const leftAt = search.now();
    const listed: Machine[] | typeof STEP_CUT = await withinStep(
      (signal) => search.flyApi.listByLabel(search.label.key, search.label.value, { signal }),
      stepMs,
    );
    if (listed === STEP_CUT) {
      search.onReadCut(read);
    } else {
      for (const machine of listed) {
        if (machine.name !== search.name || found.has(machine.id)) continue;
        if (machine.state === "destroying" || machine.state === "destroyed") continue;
        found.add(machine.id);
        if (await destroyFound(search, machine.id, stepMs)) destroyed += 1;
      }
    }
    if (read >= SEARCH_READS && leftAt >= search.lastSentAt + CUT_CREATE_SEARCH_MS) break;
  }
  return { found: found.size, destroyed };
}

/** Destroy a machine the search found, within one step; whether it was. */
async function destroyFound(
  search: CutCreationSearch,
  machineId: string,
  stepMs: number,
): Promise<boolean> {
  try {
    const done = await withinStep((signal) => search.flyApi.destroy(machineId, { signal }), stepMs);
    if (done === STEP_CUT) {
      search.onDestroyFailed(machineId, { cut: true });
      return false;
    }
    search.onDestroyed(machineId);
    return true;
  } catch (error) {
    search.onDestroyFailed(machineId, { cut: false, error });
    return false;
  }
}
