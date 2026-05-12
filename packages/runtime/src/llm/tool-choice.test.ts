import type { AgentConfig } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";
import { resolveToolChoice } from "./tool-choice.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "dev/test-agent",
    version: "0.1.0",
    model: { provider: "anthropic", name: "claude-3-7-sonnet" },
    tools: [],
    mcp_servers: [],
    inputs: [{ name: "q", type: "string", required: true }],
    outputs: [{ name: "answer", type: "string" }],
    environment: {},
    context_mode: "skill",
    state: {},
    tests: [],
    tool_choice: "auto",
    parallel_tools: true,
    ...overrides,
  } as AgentConfig;
}

function tool(name: string, required = false) {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: "object" as const, properties: {} },
    required,
  };
}

describe("resolveToolChoice", () => {
  it("returns { mode: auto } when nothing is configured (default)", () => {
    const result = resolveToolChoice(makeAgent());
    expect(result).toEqual({ mode: "auto" });
  });

  it("returns { mode: auto } with tool_choice: 'auto' explicit and no required tools", () => {
    const result = resolveToolChoice(makeAgent({ tool_choice: "auto", tools: [tool("foo")] }));
    expect(result).toEqual({ mode: "auto" });
  });

  it("returns { mode: none } when tool_choice: 'none'", () => {
    const result = resolveToolChoice(makeAgent({ tool_choice: "none", tools: [tool("foo")] }));
    expect(result).toEqual({ mode: "none" });
  });

  it("returns { mode: required } when tool_choice: 'required' and no per-tool flags", () => {
    const result = resolveToolChoice(makeAgent({ tool_choice: "required", tools: [tool("foo")] }));
    expect(result).toEqual({ mode: "required" });
  });

  it("returns { mode: specific, tool } when tool_choice names an existing tool", () => {
    const result = resolveToolChoice(
      makeAgent({ tool_choice: "write_artifact", tools: [tool("write_artifact"), tool("other")] }),
    );
    expect(result).toEqual({ mode: "specific", tool: "write_artifact" });
  });

  it("VT-16: top-level 'none' overrides per-tool required:true", () => {
    const result = resolveToolChoice(
      makeAgent({ tool_choice: "none", tools: [tool("foo", true), tool("bar")] }),
    );
    expect(result).toEqual({ mode: "none" });
  });

  it("VT-17: top-level <name> overrides per-tool required:true on other tools", () => {
    const result = resolveToolChoice(
      makeAgent({ tool_choice: "bar", tools: [tool("foo", true), tool("bar")] }),
    );
    expect(result).toEqual({ mode: "specific", tool: "bar" });
  });

  it("VT-18: top-level 'required' + per-tool required:true → subset of required tools only", () => {
    const result = resolveToolChoice(
      makeAgent({
        tool_choice: "required",
        tools: [tool("foo", true), tool("bar"), tool("baz", true)],
      }),
    );
    expect(result).toEqual({ mode: "subset", tools: ["foo", "baz"] });
  });

  it("collapses single required:true tool to { mode: specific }", () => {
    const result = resolveToolChoice(
      makeAgent({ tool_choice: "required", tools: [tool("foo", true), tool("bar")] }),
    );
    expect(result).toEqual({ mode: "specific", tool: "foo" });
  });

  it("respects per-tool required:true even when top-level is auto (declarative invariant)", () => {
    const result = resolveToolChoice(
      makeAgent({ tool_choice: "auto", tools: [tool("audit_log", true), tool("other")] }),
    );
    expect(result).toEqual({ mode: "specific", tool: "audit_log" });
  });

  it("forms subset of multiple required:true tools when top-level is auto", () => {
    const result = resolveToolChoice(
      makeAgent({
        tool_choice: "auto",
        tools: [tool("audit_log", true), tool("validate", true), tool("other")],
      }),
    );
    expect(result).toEqual({ mode: "subset", tools: ["audit_log", "validate"] });
  });
});
