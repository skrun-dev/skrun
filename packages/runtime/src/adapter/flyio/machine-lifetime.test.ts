import { EnvironmentConfigSchema, TIMEOUT_MAX_S, TIMEOUT_MIN_S } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { parseTimeout } from "../../security/timeout.js";
import { seatDeadlineMarginMs } from "./acquisition-budget.js";
import { FLY_APP_ACTION_BURST, type Machine } from "./fly-api.js";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  declaredLifetimeEndMs,
  declaredLifetimeMs,
  LIFETIME_END_KEY,
  lifetimeEndValue,
  MACHINE_LIFETIME_GRACE_MS,
  MAX_TIMER_DELAY_MS,
  machineLifetimeSeconds,
  RUNNER_LIFETIME_ENV,
  runLabelOf,
  undeclaredLifetimeFallbackMs,
} from "./machine-lifetime.js";

/** A listed machine whose environment is `env` — or that has no configuration at all. */
function listed(env?: Record<string, string>): Pick<Machine, "config"> {
  return env === undefined ? {} : { config: { image: "img", env } };
}

describe("a run machine's lifetime", () => {
  it("keeps a grace of five minutes", () => {
    expect(MACHINE_LIFETIME_GRACE_MS).toBe(5 * 60 * 1000);
  });

  it("is carried in a variable the machine reads in seconds", () => {
    expect(RUNNER_LIFETIME_ENV).toBe("RUNNER_LIFETIME_S");
  });

  it("never derives from a timer longer than the longest one a process can arm", () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
  });

  // The schema bounds the timeout an agent declares, and cannot import this
  // package: the two numbers are held equal here, where both are read.
  it("the longest timeout agent.yaml accepts is the longest delay a timer arms, in whole seconds", () => {
    expect(TIMEOUT_MAX_S).toBe(Math.floor(MAX_TIMER_DELAY_MS / 1000));
    expect(TIMEOUT_MIN_S).toBe(1);
  });

  it("counts a run that declares no timeout at the default an agent's environment declares", () => {
    const declared = EnvironmentConfigSchema.parse({}).timeout;
    expect(parseTimeout(declared)).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it("is the seat's hold plus the grace, in whole seconds rounded up", () => {
    expect(machineLifetimeSeconds({ seatHoldMs: 900_000 })).toBe(
      (900_000 + MACHINE_LIFETIME_GRACE_MS) / 1000,
    );
    // A millisecond past a whole second is one more second, never one less.
    expect(machineLifetimeSeconds({ seatHoldMs: 900_001 })).toBe(
      (900_000 + MACHINE_LIFETIME_GRACE_MS) / 1000 + 1,
    );
  });

  it("stays a finite number of seconds for a seat held as long as a timer can last", () => {
    const seconds = machineLifetimeSeconds({
      seatHoldMs:
        MAX_TIMER_DELAY_MS + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST }),
    });
    expect(Number.isSafeInteger(seconds)).toBe(true);
    expect(seconds).toBe(
      Math.ceil(
        (MAX_TIMER_DELAY_MS +
          seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST }) +
          MACHINE_LIFETIME_GRACE_MS) /
          1000,
      ),
    );
  });
});

describe("the lifetime a listed machine declares", () => {
  it("is read from its environment, in seconds, as milliseconds", () => {
    expect(declaredLifetimeMs(listed({ [RUNNER_LIFETIME_ENV]: "1233" }))).toBe(1_233_000);
    expect(declaredLifetimeMs(listed({ [RUNNER_LIFETIME_ENV]: "1" }))).toBe(1_000);
  });

  it("is none for a machine with no configuration, or without the variable", () => {
    expect(declaredLifetimeMs(listed())).toBeUndefined();
    expect(declaredLifetimeMs(listed({}))).toBeUndefined();
    // Another number in the environment is not a lifetime.
    expect(declaredLifetimeMs(listed({ RUNNER_PORT: "9000" }))).toBeUndefined();
  });

  it.each([
    ["an empty value", ""],
    ["zero", "0"],
    ["a sign", "-5"],
    ["a plus sign", "+5"],
    ["a decimal point", "12.5"],
    ["an exponent", "1e3"],
    ["a space", " 12"],
    ["a trailing space", "12 "],
    ["letters", "abc"],
    ["a hexadecimal number", "0x10"],
    ["more seconds than can be counted in milliseconds exactly", "99999999999999999999"],
  ])("is none for %s", (_label, value) => {
    expect(declaredLifetimeMs(listed({ [RUNNER_LIFETIME_ENV]: value }))).toBeUndefined();
  });
});

/** A listed machine whose metadata is `metadata` — or that has no configuration at all. */
function labelled(metadata?: Record<string, unknown>): Pick<Machine, "config"> {
  return metadata === undefined ? {} : { config: { image: "img", metadata } };
}

// An assigned pooled machine declares the end of its life as an instant: the
// harness writes it, the sweep and the operator's cleanup read it back.
describe("the end of its life a listed machine declares", () => {
  it("is written under its own key, as an ISO 8601 instant in UTC, to the millisecond", () => {
    expect(LIFETIME_END_KEY).toBe("skrun_lifetime_end");
    expect(lifetimeEndValue(Date.UTC(2026, 9, 28, 12, 0, 0, 5))).toBe("2026-10-28T12:00:00.005Z");
  });

  it("reads back what is written, to the millisecond", () => {
    const end = Date.UTC(2026, 9, 28, 12, 0, 0, 5);
    expect(declaredLifetimeEndMs(labelled({ [LIFETIME_END_KEY]: lifetimeEndValue(end) }))).toBe(
      end,
    );
  });

  it("is none for a machine with no configuration, no metadata, or without the key", () => {
    expect(declaredLifetimeEndMs(labelled())).toBeUndefined();
    expect(declaredLifetimeEndMs({ config: { image: "img" } })).toBeUndefined();
    expect(declaredLifetimeEndMs(labelled({ skrun_run_id: "r1" }))).toBeUndefined();
  });

  it.each([
    ["an empty value", ""],
    ["a number", 1_793_225_000_000],
    ["a date without its time", "2026-10-28"],
    ["no milliseconds", "2026-10-28T12:00:00Z"],
    ["another zone", "2026-10-28T12:00:00.000+01:00"],
    ["a date that does not exist", "2026-02-30T12:00:00.000Z"],
    ["words", "in an hour"],
    ["a space around it", " 2026-10-28T12:00:00.000Z"],
  ])("is none for %s", (_label, value) => {
    expect(declaredLifetimeEndMs(labelled({ [LIFETIME_END_KEY]: value }))).toBeUndefined();
  });
});

describe("the run a listed machine's metadata names", () => {
  it("is its run label's text, whatever else the metadata holds", () => {
    expect(runLabelOf(labelled({ skrun_run_id: "r1", skrun_pool_id: "p1" }))).toBe("r1");
  });

  it.each([
    ["no configuration", labelled()],
    ["no label", labelled({ skrun_pool_id: "p1" })],
    ["an empty label", labelled({ skrun_run_id: "" })],
    ["a label that is not text", labelled({ skrun_run_id: 7 })],
  ])("is none for a machine with %s", (_label, machine) => {
    expect(runLabelOf(machine)).toBeUndefined();
  });
});

// Every expected value is recomputed from the exported bounds: a number copied
// here would stay right while the bounds it came from moved.
describe("the fallback for a machine that declares no lifetime", () => {
  it("is the default timeout, the seat's margin on the platform's burst, and the grace", () => {
    expect(undeclaredLifetimeFallbackMs()).toBe(
      DEFAULT_RUN_TIMEOUT_MS +
        seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST }) +
        MACHINE_LIFETIME_GRACE_MS,
    );
    // The same figures written out, as a reading aid: 300 + 633 + 300.
    expect(undeclaredLifetimeFallbackMs()).toBe(1_233_000);
  });

  it("is the lifetime a run of the default timeout is created with", () => {
    const seatHoldMs =
      DEFAULT_RUN_TIMEOUT_MS + seatDeadlineMarginMs({ concurrentCreates: FLY_APP_ACTION_BURST });
    expect(undeclaredLifetimeFallbackMs()).toBe(machineLifetimeSeconds({ seatHoldMs }) * 1000);
  });
});
