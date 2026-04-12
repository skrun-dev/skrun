import { describe, expect, it } from "vitest";
import { redactCallerKeys, redactSecretsFromString } from "./redact.js";

describe("redactCallerKeys", () => {
  it("redacts callerKeys field at top level", () => {
    const input = {
      runId: "abc",
      callerKeys: { anthropic: "sk-ant-secret" },
    };
    const result = redactCallerKeys(input);
    expect(result.callerKeys).toBe("[REDACTED]");
    expect(result.runId).toBe("abc");
  });

  it("redacts callerKeys nested in details", () => {
    const input = {
      action: "run_start",
      details: {
        input: { code: "hello" },
        callerKeys: { openai: "sk-secret" },
      },
    };
    const result = redactCallerKeys(input);
    expect((result.details as Record<string, unknown>).callerKeys).toBe("[REDACTED]");
    expect((result.details as Record<string, unknown>).input).toEqual({ code: "hello" });
  });

  it("leaves objects without callerKeys untouched", () => {
    const input = { runId: "abc", status: "completed", output: { result: "ok" } };
    const result = redactCallerKeys(input);
    expect(result).toEqual(input);
  });

  it("handles null and undefined values", () => {
    const input = { callerKeys: null, other: undefined, name: "test" };
    const result = redactCallerKeys(input as Record<string, unknown>);
    expect(result.callerKeys).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  it("handles empty objects", () => {
    const result = redactCallerKeys({});
    expect(result).toEqual({});
  });

  it("handles arrays in values", () => {
    const input = {
      items: [{ callerKeys: { google: "key" } }, { name: "safe" }],
    };
    const result = redactCallerKeys(input);
    const items = result.items as Record<string, unknown>[];
    expect(items[0].callerKeys).toBe("[REDACTED]");
    expect(items[1].name).toBe("safe");
  });

  it("does not mutate the original object", () => {
    const input = { callerKeys: { anthropic: "sk-ant-secret" } };
    redactCallerKeys(input);
    expect(input.callerKeys).toEqual({ anthropic: "sk-ant-secret" });
  });

  it("supports custom fields to redact", () => {
    const input = { apiKey: "secret", name: "test" };
    const result = redactCallerKeys(input, ["apiKey"]);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });
});

describe("redactSecretsFromString", () => {
  it("replaces secret values in a string", () => {
    const result = redactSecretsFromString(
      "Invalid API key: sk-ant-secret123. Please check your key.",
      ["sk-ant-secret123"],
    );
    expect(result).toBe("Invalid API key: [REDACTED]. Please check your key.");
  });

  it("replaces multiple secrets", () => {
    const result = redactSecretsFromString("key1=abc key2=def", ["abc", "def"]);
    expect(result).toBe("key1=[REDACTED] key2=[REDACTED]");
  });

  it("returns original string when no secrets match", () => {
    const result = redactSecretsFromString("no secrets here", ["xyz"]);
    expect(result).toBe("no secrets here");
  });

  it("handles empty secrets array", () => {
    const result = redactSecretsFromString("some text", []);
    expect(result).toBe("some text");
  });

  it("handles empty string secrets gracefully", () => {
    const result = redactSecretsFromString("some text", [""]);
    expect(result).toBe("some text");
  });
});
