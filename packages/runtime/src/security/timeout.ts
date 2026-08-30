import { SkrunError } from "@skrun-dev/schema";

export class TimeoutError extends SkrunError {
  constructor(timeoutMs: number) {
    super("TIMEOUT", `Execution timed out after ${timeoutMs / 1000}s`);
    this.name = "TimeoutError";
  }
}

export function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)s$/);
  if (!match) throw new Error(`Invalid timeout format: "${timeout}". Expected "Ns" (e.g., "300s")`);
  return Number.parseInt(match[1], 10) * 1000;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Generator-aware timeout: forwards events from `gen` as they arrive,
 * but throws `TimeoutError` if no event has arrived within the remaining
 * budget. On timeout the source generator is told to clean up via
 * `gen.return()` (best-effort).
 *
 * Unlike `withTimeout(Promise)` which only fires on the wrapped promise,
 * this wrapper preserves live streaming — each yield flushes through to
 * the consumer immediately, which is what makes `run_heartbeat` actually
 * keep an SSE connection alive.
 */
export async function* withGeneratorTimeout<T>(
  gen: AsyncGenerator<T>,
  timeoutMs: number,
): AsyncGenerator<T> {
  const deadline = Date.now() + timeoutMs;
  const timeoutSentinel = Symbol("timeout");
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new TimeoutError(timeoutMs);
      }
      const nextPromise = gen.next();
      const timerPromise = new Promise<typeof timeoutSentinel>((resolve) => {
        setTimeout(() => resolve(timeoutSentinel), remainingMs);
      });
      const winner = await Promise.race([nextPromise, timerPromise]);
      if (winner === timeoutSentinel) {
        throw new TimeoutError(timeoutMs);
      }
      const { value, done } = winner;
      if (done) return;
      yield value;
    }
  } finally {
    // Best-effort cleanup of the source generator. Fire-and-forget — if
    // the source is blocked on an unresponsive promise (e.g. a hanging
    // LLM call after timeout), awaiting return() would never resolve.
    gen.return(undefined).catch(() => {});
  }
}
