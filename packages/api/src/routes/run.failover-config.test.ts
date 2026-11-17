import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

// The run route's model router, as the app builds it. The router is replaced by
// a subclass that notes what each one is built with — the rest of the runtime
// left as it is. A file of its own: the replacement reaches no other test.
const { built } = vi.hoisted(() => ({ built: [] as unknown[] }));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  class NotedRouter extends actual.LLMRouter {
    constructor(...args: ConstructorParameters<typeof actual.LLMRouter>) {
      super(...args);
      built.push(args[1]);
    }
  }
  return { ...actual, LLMRouter: NotedRouter };
});

describe("SKRUN_PRIMARY_FAILOVER_MS: read at the start of the API, its value given to the run route's model router", () => {
  const refusal = (raw: string) =>
    `SKRUN_PRIMARY_FAILOVER_MS must be a whole number of milliseconds from 1 to 2147483647 (got "${raw}"). Unset it to use the 45000 ms default.`;
  const start = () => createApp(new MemoryStorage(), new MemoryDb());

  beforeEach(() => {
    built.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "-5",
    "0",
    "abc",
    "",
    " 1.5",
    "2147483648",
  ])("SKRUN_PRIMARY_FAILOVER_MS=%j refuses to start, naming the variable", (raw) => {
    vi.stubEnv("SKRUN_PRIMARY_FAILOVER_MS", raw);
    expect(start).toThrow(refusal(raw));
  });

  it("set to 1000: the run route's router is built with it, once, when the app is", () => {
    vi.stubEnv("SKRUN_PRIMARY_FAILOVER_MS", "1000");
    start();
    expect(built).toEqual([{ primaryFailoverMs: 1_000 }]);
  });

  it("unset: the run route's router is built with the 45000 ms default", () => {
    vi.stubEnv("SKRUN_PRIMARY_FAILOVER_MS", undefined);
    start();
    expect(built).toEqual([{ primaryFailoverMs: 45_000 }]);
  });
});
