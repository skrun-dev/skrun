import { describe, expect, it } from "vitest";
import { checkCost } from "./cost-checker.js";
import { parseTimeout, TimeoutError, withTimeout } from "./timeout.js";

describe("parseTimeout", () => {
  it("should parse seconds to milliseconds", () => {
    expect(parseTimeout("300s")).toBe(300_000);
    expect(parseTimeout("60s")).toBe(60_000);
    expect(parseTimeout("5s")).toBe(5_000);
  });

  it("should throw on invalid format", () => {
    expect(() => parseTimeout("5m")).toThrow("Invalid timeout format");
    expect(() => parseTimeout("300")).toThrow("Invalid timeout format");
  });
});

describe("withTimeout", () => {
  it("should resolve if promise completes in time", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("should reject with TimeoutError if too slow", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50)).rejects.toThrow(TimeoutError);
  });

  it("should propagate original error", async () => {
    const failing = Promise.reject(new Error("original"));
    await expect(withTimeout(failing, 1000)).rejects.toThrow("original");
  });
});

describe("checkCost", () => {
  it("should not exceed when no max set", () => {
    const result = checkCost(0.5);
    expect(result.exceeded).toBe(false);
    expect(result.estimated).toBe(0.5);
  });

  it("should not exceed when under max", () => {
    const result = checkCost(0.3, 0.5);
    expect(result.exceeded).toBe(false);
  });

  it("should exceed when over max", () => {
    const result = checkCost(0.6, 0.5);
    expect(result.exceeded).toBe(true);
  });
});
