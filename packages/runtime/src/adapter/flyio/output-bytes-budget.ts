/**
 * The output bytes the API holds at once, across every run of the process.
 *
 * A cloud run's output files are pulled from its runner one after the other,
 * each into a buffer as large as the size limit — 10 MiB by default. One run
 * holds one such buffer at a time; but the runs of a process upload at the
 * same time, and nothing else bounds how many do: an operator who sets no
 * instance cap has no cap at all. Before each pull, an upload therefore
 * reserves the size limit on this budget — the limit, not the size the runner
 * announced — and gives it back once the file is stored, left out or failed.
 * Past the budget, an upload waits for room; it does not fail.
 *
 * The line is served first come, first served: a reservation never passes one
 * that waits ahead of it, so a large one is never starved by smaller ones.
 * A reservation larger than the whole budget takes the whole budget, and is
 * served alone. A waiting reservation whose signal is aborted — its upload ran
 * out of time — leaves the line at once: granted later, it would hold bytes
 * nobody gives back, and after enough of them every upload would wait until
 * its own time ran out.
 *
 * One budget per process, shared by every adapter: an adapter is built for
 * each run, and a budget per adapter would bound nothing. That one is
 * {@link processOutputBytesBudget}; an upload or an adapter handed no budget
 * reserves on it.
 */

/** The most output bytes the API holds at once in one process: 256 MiB. */
export const OUTPUT_BYTES_BUDGET = 256 * 1024 * 1024;

/** Gives a reservation back. Calling it again gives nothing back twice. */
export type ReleaseOutputBytes = () => void;

interface Waiter {
  bytes: number;
  grant: (release: ReleaseOutputBytes) => void;
  /** Stops listening to the waiter's signal, once it is granted or gone. */
  detach: () => void;
}

export class OutputBytesBudget {
  /** The most bytes held at once. */
  readonly capacity: number;
  #inUse = 0;
  readonly #line: Waiter[] = [];

  constructor(capacity: number = OUTPUT_BYTES_BUDGET) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("an output bytes budget is a whole number of bytes, at least 1");
    }
    this.capacity = capacity;
  }

  /** The bytes reserved now. */
  get inUse(): number {
    return this.#inUse;
  }

  /** The reservations waiting for room. */
  get waiting(): number {
    return this.#line.length;
  }

  /**
   * Reserve `bytes` — at most the whole budget — and resolve, once they are
   * granted, with the function that gives them back. Waits behind every
   * reservation that came before. Rejects with the signal's reason, granting
   * nothing, when `signal` is aborted before the bytes are granted.
   */
  reserve(bytes: number, signal?: AbortSignal): Promise<ReleaseOutputBytes> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("a reservation is a whole number of bytes, zero or more");
    }
    const amount = Math.min(bytes, this.capacity);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#line.length === 0 && this.#fits(amount)) {
      return Promise.resolve(this.#take(amount));
    }
    return new Promise<ReleaseOutputBytes>((resolve, reject) => {
      const onAbort = () => {
        const at = this.#line.indexOf(waiter);
        if (at !== -1) this.#line.splice(at, 1);
        reject(signal?.reason);
        // The one that left may have been the head of the line.
        this.#serve();
      };
      const waiter: Waiter = {
        bytes: amount,
        grant: resolve,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#line.push(waiter);
    });
  }

  #fits(bytes: number): boolean {
    return this.#inUse + bytes <= this.capacity;
  }

  #take(bytes: number): ReleaseOutputBytes {
    this.#inUse += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse -= bytes;
      this.#serve();
    };
  }

  /** Grant the head of the line while it fits — never one behind it. */
  #serve(): void {
    for (;;) {
      const head = this.#line[0];
      if (head === undefined || !this.#fits(head.bytes)) return;
      this.#line.shift();
      head.detach();
      head.grant(this.#take(head.bytes));
    }
  }
}

let processBudget: OutputBytesBudget | undefined;

/**
 * The process's budget, of {@link OUTPUT_BYTES_BUDGET}: built on first use, then
 * the same instance for every adapter and every run of the process — the API's
 * cloud dependencies carry it, and an adapter or an upload handed none uses it.
 */
export function processOutputBytesBudget(): OutputBytesBudget {
  processBudget ??= new OutputBytesBudget();
  return processBudget;
}
