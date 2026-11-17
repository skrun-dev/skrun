import { describe, expect, it, vi } from "vitest";
import { deferStateWrites } from "./deferred-state.js";

function target() {
  return {
    getState: vi.fn(async () => ({ previous: true })),
    setState: vi.fn(async () => {}),
  };
}

describe("deferStateWrites", () => {
  it("reads through, and holds a write until commit", async () => {
    const real = target();
    const { callbacks, commit } = deferStateWrites(real);

    expect(await callbacks.getState("agent")).toEqual({ previous: true });
    await callbacks.setState("agent", { step: 1 });
    expect(real.setState).not.toHaveBeenCalled();

    await commit();
    expect(real.setState).toHaveBeenCalledExactlyOnceWith("agent", { step: 1 });
  });

  it("commits the last value held, once", async () => {
    const real = target();
    const { callbacks, commit } = deferStateWrites(real);
    await callbacks.setState("agent", { step: 1 });
    await callbacks.setState("agent", { step: 2 });

    await commit();
    await commit();
    expect(real.setState).toHaveBeenCalledExactlyOnceWith("agent", { step: 2 });
  });

  it("writes nothing when nothing was held, and a failed write is thrown", async () => {
    const real = target();
    const { callbacks, commit } = deferStateWrites(real);
    await commit();
    expect(real.setState).not.toHaveBeenCalled();

    real.setState.mockRejectedValueOnce(new Error("database unreachable"));
    await callbacks.setState("agent", { step: 1 });
    await expect(commit()).rejects.toThrow("database unreachable");
  });
});
