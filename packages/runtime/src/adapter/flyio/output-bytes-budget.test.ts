import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  OUTPUT_BYTES_BUDGET,
  OutputBytesBudget,
  type ReleaseOutputBytes,
} from "./output-bytes-budget.js";

const MIB = 1024 * 1024;

/** Lets every promise that can settle now settle: the budget grants on its own, without a timer. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** A reservation in the making: its position in the line, and how it ended. */
interface Pending {
  id: number;
  release?: ReleaseOutputBytes;
  rejected?: unknown;
}

function reserveTracked(
  budget: OutputBytesBudget,
  id: number,
  bytes: number,
  granted: number[],
  signal?: AbortSignal,
): Pending {
  const pending: Pending = { id };
  budget.reserve(bytes, signal).then(
    (release) => {
      pending.release = release;
      granted.push(id);
    },
    (err: unknown) => {
      pending.rejected = err;
    },
  );
  return pending;
}

describe("OutputBytesBudget — the output bytes the API holds at once", () => {
  it("is 256 MiB for the process", () => {
    expect(OUTPUT_BYTES_BUDGET).toBe(256 * MIB);
    expect(new OutputBytesBudget().capacity).toBe(256 * MIB);
  });

  it("grants at most 25 reservations of 10 MiB out of 256 MiB, and serves the others in the order they came", async () => {
    const budget = new OutputBytesBudget(256 * MIB);
    const granted: number[] = [];
    const all = Array.from({ length: 30 }, (_, id) =>
      reserveTracked(budget, id, 10 * MIB, granted),
    );
    await settle();

    expect(granted).toEqual(Array.from({ length: 25 }, (_, id) => id));
    expect(budget.inUse).toBe(250 * MIB);
    expect(budget.waiting).toBe(5);

    // Each release lets in the first one still waiting, and never more than fits.
    for (let next = 25; next < 30; next++) {
      all[next - 25]?.release?.();
      await settle();
      expect(granted.at(-1)).toBe(next);
      expect(budget.inUse).toBeLessThanOrEqual(256 * MIB);
    }
    expect(granted).toEqual(Array.from({ length: 30 }, (_, id) => id));

    for (const pending of all) pending.release?.();
    expect(budget.inUse).toBe(0);
    expect(budget.waiting).toBe(0);
  });

  it("never lets a smaller reservation pass one that waits ahead of it", async () => {
    const budget = new OutputBytesBudget(100);
    const granted: number[] = [];
    const first = reserveTracked(budget, 0, 90, granted);
    reserveTracked(budget, 1, 50, granted);
    reserveTracked(budget, 2, 5, granted);
    await settle();

    // 5 would fit beside the 90, but the 50 came first.
    expect(granted).toEqual([0]);
    first.release?.();
    await settle();
    expect(granted).toEqual([0, 1, 2]);
  });

  it("takes a waiting reservation out of the line when its signal is aborted, rejects it with the reason, and the count goes back to 0", async () => {
    const budget = new OutputBytesBudget(256 * MIB);
    const granted: number[] = [];
    const held = Array.from({ length: 25 }, (_, id) =>
      reserveTracked(budget, id, 10 * MIB, granted),
    );
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const abandoned = controllers.map((controller, i) =>
      reserveTracked(budget, 25 + i, 10 * MIB, granted, controller.signal),
    );
    const after = [
      reserveTracked(budget, 30, 10 * MIB, granted),
      reserveTracked(budget, 31, 10 * MIB, granted),
    ];
    await settle();
    expect(budget.waiting).toBe(7);

    const reason = new Error("the upload ran out of time");
    for (const controller of controllers) controller.abort(reason);
    await settle();

    for (const pending of abandoned) {
      expect(pending.rejected).toBe(reason);
      expect(pending.release).toBeUndefined();
    }
    expect(budget.waiting).toBe(2);

    // The two behind them are served next, as places free up.
    held[0]?.release?.();
    held[1]?.release?.();
    await settle();
    expect(granted.slice(25)).toEqual([30, 31]);

    for (const pending of [...held, ...after]) pending.release?.();
    expect(budget.inUse).toBe(0);
    expect(budget.waiting).toBe(0);
  });

  it("lets in at once the reservation that fits behind one that leaves the head of the line", async () => {
    const budget = new OutputBytesBudget(100);
    const granted: number[] = [];
    reserveTracked(budget, 0, 60, granted);
    const controller = new AbortController();
    const head = reserveTracked(budget, 1, 50, granted, controller.signal);
    reserveTracked(budget, 2, 30, granted);
    await settle();
    expect(granted).toEqual([0]);

    controller.abort(new Error("the upload ran out of time"));
    await settle();

    expect(head.rejected).toBeInstanceOf(Error);
    expect(granted).toEqual([0, 2]);
    expect(budget.inUse).toBe(90);
  });

  it("stops listening to a waiting reservation's signal once it is granted", async () => {
    const budget = new OutputBytesBudget(100);
    const first = await budget.reserve(100);
    const controller = new AbortController();
    const waiting = budget.reserve(10, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    first();
    const release = await waiting;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    // An abort after the grant takes nothing back: giving the bytes back is the holder's.
    controller.abort(new Error("late"));
    expect(budget.inUse).toBe(10);
    release();
    expect(budget.inUse).toBe(0);
  });

  it("rejects at once a reservation whose signal is already aborted, and never grants it", async () => {
    const budget = new OutputBytesBudget(100);
    const controller = new AbortController();
    const reason = new Error("gone");
    controller.abort(reason);

    await expect(budget.reserve(10, controller.signal)).rejects.toBe(reason);
    expect(budget.inUse).toBe(0);
    expect(budget.waiting).toBe(0);
  });

  it("gives a reservation larger than the budget the whole budget, served alone", async () => {
    const budget = new OutputBytesBudget(100);
    const granted: number[] = [];
    const small = reserveTracked(budget, 0, 10, granted);
    const large = reserveTracked(budget, 1, 300, granted);
    const next = reserveTracked(budget, 2, 1, granted);
    await settle();
    expect(granted).toEqual([0]);

    small.release?.();
    await settle();
    expect(granted).toEqual([0, 1]);
    expect(budget.inUse).toBe(100);

    large.release?.();
    await settle();
    expect(granted).toEqual([0, 1, 2]);
    next.release?.();
    expect(budget.inUse).toBe(0);
  });

  it("gives a reservation back once, however many times it is released", async () => {
    const budget = new OutputBytesBudget(100);
    const one = await budget.reserve(30);
    const other = await budget.reserve(20);

    one();
    one();
    expect(budget.inUse).toBe(20);
    other();
    expect(budget.inUse).toBe(0);
  });

  it("refuses a number of bytes that is not a whole number of zero or more", () => {
    const budget = new OutputBytesBudget(100);
    for (const bytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => budget.reserve(bytes)).toThrow(RangeError);
    }
    expect(() => new OutputBytesBudget(0)).toThrow(RangeError);
  });
});
