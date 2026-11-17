import { describe, expect, it } from "vitest";
import { MODEL_CHOICES } from "../model-choices.js";
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
        required: false,
      },
      {
        name: "Read",
        description: "Execute Read script",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
        required: false,
      },
      {
        name: "Write",
        description: "Execute Write script",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
        required: false,
      },
    ]);
    expect(result.config.environment?.timeout).toBe("300s");
    expect(result.config.environment).not.toHaveProperty("sandbox");
    // An imported skill declares no state: the author turns it on, knowingly.
    expect(result.config.state?.type).toBe("none");
    expect(result.config.state?.scope).toBe("per_caller");
    expect(result.config.state?.ttl).toBe("30d");
  });

  it("should return exactly 3 prompts", () => {
    const result = generateAgentYaml(mockSkill);
    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0].field).toBe("model");
    expect(result.prompts[1].field).toBe("inputs");
    expect(result.prompts[2].field).toBe("environment.networking.allowed_hosts");
  });

  it("offers the shared model choices, the first one as the default", () => {
    const model = generateAgentYaml(mockSkill).prompts[0];
    const expected = MODEL_CHOICES.map((c) => `${c.provider} / ${c.name}`);
    expect(model.options).toEqual(expected);
    expect(model.default).toBe(expected[0]);
  });

  it("should handle skill without allowed-tools", () => {
    const result = generateAgentYaml(mockSkillNoTools);
    expect(result.config.tools).toEqual([]);
  });

  it("should produce a config that validates when merged with user answers", () => {
    const generated = generateAgentYaml(mockSkill);
    const fullConfig = {
      ...generated.config,
      name: "pdf-processing",
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
      name: "test-agent",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
    });

    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("test-agent");

    const roundTripped = parseAgentYaml(yaml);
    expect(roundTripped.config.name).toBe(config.name);
    expect(roundTripped.config.version).toBe(config.version);
    expect(roundTripped.config.model.provider).toBe(config.model.provider);
    expect(roundTripped.config.environment.timeout).toBe(config.environment.timeout);
  });

  // parseAgentYaml refuses an alias: an object the configuration holds twice
  // is written out twice, and the file reads back.
  it("writes out an object held in two places, never as an alias", () => {
    const config = AgentConfigSchema.parse({
      name: "shared",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
    });
    const schema = { type: "object" as const, properties: { q: { type: "string" } } };
    config.tools = [
      { name: "first", description: "d", input_schema: schema, required: false },
      { name: "second", description: "d", input_schema: schema, required: false },
    ];

    const yaml = serializeAgentYaml(config);
    expect(yaml).not.toMatch(/[&*]\w/);
    expect(parseAgentYaml(yaml).config.tools.map((t) => t.input_schema)).toEqual([schema, schema]);
  });

  it("should produce human-readable YAML", () => {
    const config = AgentConfigSchema.parse({
      name: "readable",
      version: "1.0.0",
      model: { provider: "openai", name: "gpt-4o" },
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
    });

    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("name: readable");
    expect(yaml).toContain("provider: openai");
  });
});
