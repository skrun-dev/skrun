import { describe, expect, it } from "vitest";
import { parseAgentYaml } from "../parsers/agent-yaml.js";
import type { ParsedSkill } from "../parsers/skill-md.js";
import { AgentConfigSchema } from "../schemas/agent-config.js";
import { generateAgentYaml } from "./skill-importer.js";
import { serializeAgentYaml } from "./yaml-serializer.js";

const mockSkill: ParsedSkill = {
  frontmatter: {
    name: "pdf-processing",
    description: "Extract PDF text, fill forms, merge files.",
    "allowed-tools": "Bash(git:*) Read Write",
  },
  body: "# Instructions\n\nDo things.",
};

const mockSkillNoTools: ParsedSkill = {
  frontmatter: {
    name: "simple-skill",
    description: "A simple skill.",
  },
  body: "Instructions.",
};

describe("generateAgentYaml", () => {
  it("should generate config with inferred fields", () => {
    const result = generateAgentYaml(mockSkill);
    expect(result.config.version).toBe("1.0.0");
    expect(result.config.context_mode).toBe("skill");
    expect(result.config.tools).toEqual([
      {
        name: "Bash",
        description: "Execute Bash script",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      },
      {
        name: "Read",
        description: "Execute Read script",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      },
      {
        name: "Write",
        description: "Execute Write script",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      },
    ]);
    expect(result.config.environment?.timeout).toBe("300s");
    expect(result.config.environment?.sandbox).toBe("strict");
    expect(result.config.state?.type).toBe("kv");
    expect(result.config.state?.ttl).toBe("30d");
  });

  it("should return exactly 3 prompts", () => {
    const result = generateAgentYaml(mockSkill);
    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0].field).toBe("model");
    expect(result.prompts[1].field).toBe("inputs");
    expect(result.prompts[2].field).toBe("environment.networking.allowed_hosts");
  });

  it("should handle skill without allowed-tools", () => {
    const result = generateAgentYaml(mockSkillNoTools);
    expect(result.config.tools).toEqual([]);
  });

  it("should produce a config that validates when merged with user answers", () => {
    const generated = generateAgentYaml(mockSkill);
    const fullConfig = {
      ...generated.config,
      name: "acme/pdf-processing",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      inputs: [{ name: "query", type: "string", required: true }],
      outputs: [{ name: "result", type: "string" }],
    };
    const result = AgentConfigSchema.safeParse(fullConfig);
    expect(result.success).toBe(true);
  });
});

describe("serializeAgentYaml", () => {
  it("should serialize and round-trip a config", () => {
    const config = AgentConfigSchema.parse({
      name: "acme/test",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
    });

    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("acme/test");

    const roundTripped = parseAgentYaml(yaml);
    expect(roundTripped.config.name).toBe(config.name);
    expect(roundTripped.config.version).toBe(config.version);
    expect(roundTripped.config.model.provider).toBe(config.model.provider);
    expect(roundTripped.config.environment.timeout).toBe(config.environment.timeout);
  });

  it("should produce human-readable YAML", () => {
    const config = AgentConfigSchema.parse({
      name: "acme/readable",
      version: "1.0.0",
      model: { provider: "openai", name: "gpt-4o" },
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
    });

    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("name: acme/readable");
    expect(yaml).toContain("provider: openai");
  });
});
