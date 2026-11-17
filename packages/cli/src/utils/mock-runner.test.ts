import type { AgentConfig } from "@skrun-dev/schema";
import { ValidationError } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { mockRun } from "./mock-runner.js";

const baseConfig: AgentConfig = {
  name: "test-agent",
  version: "1.0.0",
  model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
  tools: [],
  mcp_servers: [],
  inputs: [
    { name: "query", type: "string", required: true },
    { name: "count", type: "number", required: false },
  ],
  outputs: [
    { name: "result", type: "string" },
    { name: "score", type: "number" },
    { name: "data", type: "object" },
  ],
  environment: {
    networking: { allowed_hosts: [] },
    secrets: [],
    timeout: "300s",
  },
  context_mode: "skill",
  state: { type: "kv", ttl: "30d" },
  tests: [],
};

describe("mockRun", () => {
  it("should return mock output with correct types", () => {
    const result = mockRun(baseConfig, { query: "test" });
    expect(result.status).toBe("completed");
    expect(result.run_id).toBeTruthy();
    expect(result.output.result).toBe("mock_value");
    expect(result.output.score).toBe(0);
    expect(result.output.data).toEqual({});
    expect(result.duration_ms).toBe(0);
  });

  it("should throw on missing required input", () => {
    expect(() => mockRun(baseConfig, {})).toThrow(ValidationError);
    expect(() => mockRun(baseConfig, {})).toThrow("Missing required input: query");
  });

  it("should accept optional inputs as missing", () => {
    const result = mockRun(baseConfig, { query: "test" });
    expect(result.status).toBe("completed");
  });

  it("should generate unique run_ids", () => {
    const r1 = mockRun(baseConfig, { query: "a" });
    const r2 = mockRun(baseConfig, { query: "b" });
    expect(r1.run_id).not.toBe(r2.run_id);
  });

  it("should handle all output types", () => {
    const config: AgentConfig = {
      ...baseConfig,
      outputs: [
        { name: "s", type: "string" },
        { name: "n", type: "number" },
        { name: "b", type: "boolean" },
        { name: "o", type: "object" },
        { name: "a", type: "array" },
      ],
    };
    const result = mockRun(config, { query: "test" });
    expect(result.output.s).toBe("mock_value");
    expect(result.output.n).toBe(0);
    expect(result.output.b).toBe(true);
    expect(result.output.o).toEqual({});
    expect(result.output.a).toEqual([]);
  });
});

describe("mockRun — a required input missing as the API judges it, and no type checked", () => {
  /** The base agent, its inputs replaced by these. */
  function withInputs(inputs: unknown[]): AgentConfig {
    return { ...baseConfig, inputs: inputs as AgentConfig["inputs"] };
  }
  const doc = { name: "doc", type: "file", media: "document", max_count: 1, required: true };

  it.each([
    ["toString", "the empty object", {}],
    ["constructor", "the empty object", {}],
    ["toString", "an object of other fields", { other: "x" }],
  ])("throws for a required input named %s that %s does not carry as a field of its own", (name, _label, input) => {
    const config = withInputs([{ name, type: "string", required: true }]);
    expect(() => mockRun(config, input)).toThrow(ValidationError);
    expect(() => mockRun(config, input)).toThrow(`Missing required input: ${name}`);
  });

  it("runs a required input named toString carried as a field of its own", () => {
    const config = withInputs([{ name: "toString", type: "string", required: true }]);
    expect(mockRun(config, { toString: "x" }).status).toBe("completed");
  });

  it.each([
    ["a required file input sent as null", [doc], { doc: null }, "doc"],
    ["a required file input sent as an empty list", [doc], { doc: [] }, "doc"],
    [
      "a required string input sent as null",
      [{ name: "query", type: "string", required: true }],
      { query: null },
      "query",
    ],
  ])("throws for %s, in the API's words", (_label, inputs, input, name) => {
    const config = withInputs(inputs);
    expect(() => mockRun(config, input)).toThrow(ValidationError);
    expect(() => mockRun(config, input)).toThrow(`Missing required input: ${name}`);
  });

  it.each([
    [
      "a required string input sent as 5",
      [{ name: "query", type: "string", required: true }],
      { query: 5 },
    ],
    ["a required file input sent as anything present", [doc], { doc: 5 }],
    [
      "an optional string input sent as null",
      [{ name: "query", type: "string", required: false }],
      { query: null },
    ],
  ])("runs %s: no type is checked", (_label, inputs, input) => {
    expect(mockRun(withInputs(inputs), input).status).toBe("completed");
  });
});
