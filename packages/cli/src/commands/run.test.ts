import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRunAgentRef, readRunInput } from "./run.js";

describe("parseRunAgentRef", () => {
  it("parses <namespace>/<name>@<version>", () => {
    expect(parseRunAgentRef("ops/agent@1.0.0")).toEqual({
      namespace: "ops",
      name: "agent",
      version: "1.0.0",
    });
  });

  it("parses <namespace>/<name> (no version → resolves to latest at run time)", () => {
    expect(parseRunAgentRef("ops/agent")).toEqual({
      namespace: "ops",
      name: "agent",
    });
  });

  it("rejects malformed input", () => {
    expect(parseRunAgentRef("")).toBeNull();
    expect(parseRunAgentRef("not-an-agent")).toBeNull();
    expect(parseRunAgentRef("Ops/Agent")).toBeNull();
    expect(parseRunAgentRef("ops/agent@")).toBeNull();
  });
});

describe("readRunInput (AC-27c — input flag handling)", () => {
  // process.exit is called on validation failures; intercept it so the tests
  // can assert without aborting the runner.
  const originalExit = process.exit;
  beforeEach(() => {
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;
  });
  afterEach(() => {
    process.exit = originalExit;
  });

  it("UAT-37b: -i '<inline-json>' parses JSON object", () => {
    const result = readRunInput({ input: '{"foo":"bar","count":3}' });
    expect(result).toEqual({ foo: "bar", count: 3 });
  });

  it("UAT-37b: -f <filepath> reads and parses JSON from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "skrun-run-test-"));
    const filePath = join(dir, "input.json");
    writeFileSync(filePath, JSON.stringify({ from: "file" }));

    const result = readRunInput({ file: filePath });
    expect(result).toEqual({ from: "file" });

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects when no input source is provided", () => {
    expect(() => readRunInput({})).toThrow("process.exit(1)");
  });

  it("rejects when both -i and -f are provided (mutually exclusive)", () => {
    expect(() => readRunInput({ input: "{}", file: "/tmp/x.json" })).toThrow("process.exit(1)");
  });

  it("rejects when -i and --stdin are both provided", () => {
    expect(() => readRunInput({ input: "{}", stdin: true })).toThrow("process.exit(1)");
  });

  it("rejects invalid JSON in -i", () => {
    expect(() => readRunInput({ input: "{not valid json" })).toThrow("process.exit(1)");
  });

  it("rejects JSON arrays (input must be a JSON object)", () => {
    expect(() => readRunInput({ input: "[1,2,3]" })).toThrow("process.exit(1)");
  });

  it("rejects JSON primitives (input must be a JSON object)", () => {
    expect(() => readRunInput({ input: '"just a string"' })).toThrow("process.exit(1)");
    expect(() => readRunInput({ input: "42" })).toThrow("process.exit(1)");
    expect(() => readRunInput({ input: "null" })).toThrow("process.exit(1)");
  });

  it("rejects missing file path (clear error, no stack)", () => {
    expect(() => readRunInput({ file: "/this/path/does/not/exist.json" })).toThrow(
      "process.exit(1)",
    );
  });

  // Smoke: --stdin reads from fd 0. We can't easily inject stdin in a unit
  // test, so we just verify the validation path (mutual exclusivity) — the
  // actual read is exercised by live tests (8.18) when the binary is piped.
  it("rejects -f + --stdin combo", () => {
    expect(() => readRunInput({ file: "/tmp/x.json", stdin: true })).toThrow("process.exit(1)");
  });
});

describe("readRunInput (AC-27c — security hygiene)", () => {
  it("does not write anything to stdout (silent on successful parse)", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    readRunInput({ input: '{"k":"v"}' });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
