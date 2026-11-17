import { describe, expect, it, vi } from "vitest";
import { TimeoutError, withGeneratorTimeout } from "./timeout.js";

async function* events(count: number): AsyncGenerator<{ i: number; payload: string }> {
  for (let i = 0; i < count; i++) yield { i, payload: "x".repeat(1024) };
}

/**
 * Drains on a simulated clock: it counts exactly the timers armed since it was
 * installed — none of the test runner's — and fires none of them unless told
 * to. A drain over, every timer the wrapper armed must have been cleared: the
 * count is exactly 0, whichever way the source ended. The real timers are put
 * back whatever happens.
 */
async function onSimulatedClock(drain: () => Promise<void>): Promise<number> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    await drain();
    return vi.getTimerCount();
  } finally {
    vi.useRealTimers();
  }
}

describe("withGeneratorTimeout — the deadline timer of each event", () => {
  it("a run of 1,000 events drained before its deadline leaves no timer behind", async () => {
    let seen = 0;
    const timersLeft = await onSimulatedClock(async () => {
      for await (const _event of withGeneratorTimeout(events(1000), 300_000)) seen++;
    });

    // The last timer is the one of the next() that answers `done`: it too is cleared.
    expect(timersLeft).toBe(0);
    expect(seen).toBe(1000);
  });

  it("a source that fails after 100 events passes its error on, and leaves no timer behind", async () => {
    async function* failing(): AsyncGenerator<number> {
      for (let i = 0; i < 100; i++) yield i;
      throw new Error("source failed");
    }
    let seen = 0;
    let failure: unknown;
    const timersLeft = await onSimulatedClock(async () => {
      try {
        for await (const _event of withGeneratorTimeout(failing(), 300_000)) seen++;
      } catch (error) {
        failure = error;
      }
    });

    // The last timer is the one of the next() that rejects: it too is cleared.
    expect(timersLeft).toBe(0);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("source failed");
    expect(seen).toBe(100);
  });

  it("a source that never yields still ends on TimeoutError once its deadline passes", async () => {
    async function* silent(): AsyncGenerator<number> {
      await new Promise<never>(() => {});
      yield 0;
    }
    let seen = 0;
    const drain = async () => {
      for await (const _event of withGeneratorTimeout(silent(), 40)) seen++;
    };

    await expect(drain()).rejects.toBeInstanceOf(TimeoutError);
    expect(seen).toBe(0);
  });
});
