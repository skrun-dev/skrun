import type { AgentConfig } from "@skrun-dev/schema";
import { ValidationError } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { mockRun } from "./mock-runner.js";

const baseConfig: AgentConfig = {
  name: "test/agent",
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
    filesystem: "read-only",
    secrets: [],
    timeout: "300s",
    sandbox: "strict",
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
