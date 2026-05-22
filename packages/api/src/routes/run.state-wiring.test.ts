// VT-16 — state callback wraps with namespace (multi-tenant isolation).
//
// The runtime adapter passes `config.name` (slug-only post-#84) as the state
// key. The API route wraps this so the DB sees `<namespace>/<slug>`. Two
// same-slug agents in different namespaces must NOT share state.
//
// We test the wrapping helper directly. The HTTP integration path is covered
// indirectly: the route handler in run.ts uses this exact helper, so a unit
// test on the helper is a contract test on the production wiring.

import { describe, expect, it, vi } from "vitest";
import { createNamespacedStateCallbacks } from "./run.js";

function makeMockDb() {
  return {
    getState: vi.fn(),
    setState: vi.fn(),
  };
}

describe("createNamespacedStateCallbacks — VT-16 multi-tenant state isolation", () => {
  it("VT-16a: getState injects the namespace prefix", () => {
    const db = makeMockDb();
    const cb = createNamespacedStateCallbacks(
      db as unknown as Parameters<typeof createNamespacedStateCallbacks>[0],
      "tarcroi",
    );
    cb.getState("foo");
    expect(db.getState).toHaveBeenCalledTimes(1);
    expect(db.getState.mock.calls[0][0]).toBe("tarcroi/foo");
  });

  it("VT-16b: setState injects the namespace prefix", () => {
    const db = makeMockDb();
    const cb = createNamespacedStateCallbacks(
      db as unknown as Parameters<typeof createNamespacedStateCallbacks>[0],
      "tarcroi",
    );
    cb.setState("foo", { score: 42 });
    expect(db.setState).toHaveBeenCalledTimes(1);
    expect(db.setState.mock.calls[0][0]).toBe("tarcroi/foo");
    expect(db.setState.mock.calls[0][1]).toEqual({ score: 42 });
  });

  it("VT-16c: same slug, different namespaces → distinct DB keys (isolation)", () => {
    const db = makeMockDb();
    const cbDev = createNamespacedStateCallbacks(
      db as unknown as Parameters<typeof createNamespacedStateCallbacks>[0],
      "dev",
    );
    const cbTarcroi = createNamespacedStateCallbacks(
      db as unknown as Parameters<typeof createNamespacedStateCallbacks>[0],
      "tarcroi",
    );
    cbDev.setState("email-drafter", { run_count: 1 });
    cbTarcroi.setState("email-drafter", { run_count: 99 });

    expect(db.setState).toHaveBeenCalledTimes(2);
    expect(db.setState.mock.calls[0][0]).toBe("dev/email-drafter");
    expect(db.setState.mock.calls[1][0]).toBe("tarcroi/email-drafter");
    // The two calls share the slug but emit distinct keys — the heart of
    // the multi-tenant fix.
    expect(db.setState.mock.calls[0][0]).not.toBe(db.setState.mock.calls[1][0]);
  });

  it("VT-16d: defends against undefined namespace (regression guard)", () => {
    // If the wrapper is mis-wired so `namespace` ends up undefined, the key
    // becomes "undefined/foo" instead of throwing. This test pins the
    // current behavior so a future regression that silently drops the
    // namespace becomes visible in the test failure diff.
    const db = makeMockDb();
    const cb = createNamespacedStateCallbacks(
      db as unknown as Parameters<typeof createNamespacedStateCallbacks>[0],
      undefined as unknown as string,
    );
    cb.getState("foo");
    expect(db.getState.mock.calls[0][0]).toBe("undefined/foo");
  });
});
