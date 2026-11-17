// State writes held back until the run has really succeeded.
//
// The agent loop writes the run's state as its last step, once its own checks
// have passed. But the run is not over then: each adapter still handles the
// output files — the cloud uploads them to object storage, the local runtime
// collects them from the output directory — and either can fail, ending the run
// on run_error. A notebook written before that would outlive a failed run.
//
// So the loop is handed callbacks whose `setState` only holds the value, and
// the adapter calls `commit()` once the loop is drained and the files are
// handled, just before it emits run_complete. On an error of the loop, a
// deadline reached during it, an abort during it, or a failure of the files,
// nothing commits and nothing is written. The run's deadline and the cloud
// abort watch the loop only: the files and the commit that follow are not
// bounded by them. Reads pass straight through.

import type { StateCallbacks } from "./local.js";

export interface DeferredStateWrites {
  /** What the loop is given: `getState` reads through, `setState` holds the value. */
  callbacks: StateCallbacks;
  /**
   * Write the held state, if any, through the real callbacks — once. A failure
   * is thrown to the caller: the adapter turns it into the run's failure.
   */
  commit(): Promise<void>;
}

export function deferStateWrites(target: StateCallbacks): DeferredStateWrites {
  let held: { agentName: string; state: Record<string, unknown> } | null = null;
  return {
    callbacks: {
      getState: (agentName) => target.getState(agentName),
      setState: async (agentName, state) => {
        held = { agentName, state };
      },
    },
    commit: async () => {
      if (held === null) return;
      const { agentName, state } = held;
      held = null;
      await target.setState(agentName, state);
    },
  };
}
