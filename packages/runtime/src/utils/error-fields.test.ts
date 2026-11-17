import { describe, expect, it } from "vitest";
import { errorFields } from "./error-fields.js";

describe("errorFields", () => {
  it("gives the class and the code, never the message", () => {
    const err = Object.assign(new TypeError("witness-7e2a"), { code: "ERR_WITNESS" });
    const fields = errorFields(err);
    expect(fields).toEqual({ error_name: "TypeError", error_code: "ERR_WITNESS" });
    expect(JSON.stringify(fields)).not.toContain("witness-7e2a");
  });

  it("gives a numeric code as text, and drops a code that could spell out a path", () => {
    expect(errorFields(Object.assign(new Error("x"), { code: 42 }))).toEqual({
      error_name: "Error",
      error_code: "42",
    });
    expect(errorFields(Object.assign(new Error("x"), { code: "/home/witness/file" }))).toEqual({
      error_name: "Error",
    });
  });

  it("names a thrown value that is not an Error by the plain class", () => {
    expect(errorFields("witness-7e2a")).toEqual({ error_name: "Error" });
    expect(errorFields(null)).toEqual({ error_name: "Error" });
  });
});

describe("errorFields and an error's HTTP status", () => {
  it("gives the status of an error that carries one, and never its message", () => {
    const err = Object.assign(new Error("witness-5c1d quota exceeded"), { status: 429 });
    const fields = errorFields(err);
    expect(fields).toEqual({ error_name: "Error", error_status: "429" });
    expect(JSON.stringify(fields)).not.toContain("witness-5c1d");
  });

  it("leaves the status out of an error that carries none, or one that is not a whole number", () => {
    expect(errorFields(new Error("witness-5c1d"))).toEqual({ error_name: "Error" });
    expect(errorFields(Object.assign(new Error("witness-5c1d"), { status: "429" }))).toEqual({
      error_name: "Error",
    });
    expect(errorFields(Object.assign(new Error("witness-5c1d"), { status: 429.5 }))).toEqual({
      error_name: "Error",
    });
  });
});

// The stack, asked for: its frames, never the header before them, which
// carries the error's name and message.
describe("errorFields with the stack", () => {
  /** Throws `err` from this file, so the first frame is known: it names this file. */
  function thrownFrom<T>(make: () => T): T {
    try {
      (function throwsTheWitness() {
        throw make();
      })();
    } catch (err) {
      return err as T;
    }
    throw new Error("nothing was thrown");
  }

  it("leaves the stack out unless it is asked for", () => {
    const err = thrownFrom(() => new Error("witness-7e2a"));
    expect(errorFields(err)).toEqual({ error_name: "Error" });
  });

  it("gives the frames, and nothing of the message", () => {
    const err = thrownFrom(() => new Error("witness-7e2a"));
    const fields = errorFields(err, { stack: true });
    expect(JSON.stringify(fields)).not.toContain("witness-7e2a");
    expect(fields.error_stack?.length).toBeGreaterThan(0);
    expect(fields.error_stack?.every((line) => line.startsWith("at "))).toBe(true);
    expect(fields.error_stack?.[0]).toContain("error-fields.test.ts");
  });

  it("removes the whole header of a message written over several lines, a frame-like line included", () => {
    const err = thrownFrom(
      () => new Error("first line\n    at witness-7e2a (witness-file:1:1)\nwitness-7e2a again"),
    );
    const fields = errorFields(err, { stack: true });
    expect(JSON.stringify(fields)).not.toContain("witness-7e2a");
    expect(fields.error_stack?.[0]).toContain("error-fields.test.ts");
  });

  it("gives the frames of an error Node throws itself, and nothing of its message", () => {
    let err: (Error & { code?: string }) | undefined;
    try {
      Buffer.alloc(-1);
    } catch (thrown) {
      err = thrown as Error & { code?: string };
    }
    expect(err?.code).toBe("ERR_OUT_OF_RANGE");
    const fields = errorFields(err, { stack: true });
    expect(fields.error_stack?.length).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toContain(err?.message);
  });

  // Plain Node writes `Name [CODE]: message` before the frames of its own
  // errors (a test runner that rewrites stacks may not): the header is rebuilt
  // here in that form, on a stack of known frames.
  it("removes the header Node writes for its own errors, `Name [CODE]: message`", () => {
    const err = thrownFrom(() => new RangeError("witness-7e2a out of range")) as RangeError & {
      code?: string;
    };
    err.code = "ERR_OUT_OF_RANGE";
    const frames = err.stack?.slice(err.stack.indexOf("\n")) ?? "";
    err.stack = `RangeError [ERR_OUT_OF_RANGE]: witness-7e2a out of range${frames}`;
    const fields = errorFields(err, { stack: true });
    expect(JSON.stringify(fields)).not.toContain("witness-7e2a");
    expect(fields.error_stack?.[0]).toContain("error-fields.test.ts");
  });

  it("writes no frame when the stack no longer starts with the header it can remove", () => {
    const err = thrownFrom(() => new Error("witness-7e2a"));
    void err.stack;
    err.message = "changed after the stack was written";
    const fields = errorFields(err, { stack: true });
    expect(fields).toEqual({ error_name: "Error" });
  });

  it("stops at the first line that is not a frame", () => {
    const err = thrownFrom(() => new Error("plain"));
    err.stack = `${err.stack}\nCaused by: Error: witness-7e2a\n    at witness-7e2a (witness-file:1:1)`;
    const fields = errorFields(err, { stack: true });
    expect(JSON.stringify(fields)).not.toContain("witness-7e2a");
    expect(fields.error_stack?.[0]).toContain("error-fields.test.ts");
  });

  it("gives no frame for a thrown value that is not an Error", () => {
    expect(errorFields("witness-7e2a", { stack: true })).toEqual({ error_name: "Error" });
  });
});
