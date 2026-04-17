import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { parseAgentYaml } from "./agent-yaml.js";
import { parseAgentsMd } from "./agents-md.js";
import { parseSkillMd } from "./skill-md.js";

const FIXTURES = resolve(import.meta.dirname, "../../tests/fixtures");

// --- SKILL.md Parser ---

describe("parseSkillMd", () => {
  it("should parse a valid skill with all fields", async () => {
    const content = await readFile(resolve(FIXTURES, "valid-skill.md"), "utf-8");
    const result = parseSkillMd(content);

    expect(result.frontmatter.name).toBe("pdf-processing");
    expect(result.frontmatter.description).toContain("Extract PDF text");
    expect(result.frontmatter.license).toBe("Apache-2.0");
    expect(result.frontmatter.compatibility).toContain("Python");
    expect(result.frontmatter.metadata?.author).toBe("example-org");
    expect(result.frontmatter["allowed-tools"]).toBe("Bash(git:*) Read");
    expect(result.body).toContain("# PDF Processing Skill");
  });

  it("should parse a minimal skill", async () => {
    const content = await readFile(resolve(FIXTURES, "minimal-skill.md"), "utf-8");
    const result = parseSkillMd(content);

    expect(result.frontmatter.name).toBe("simple-skill");
    expect(result.frontmatter.license).toBeUndefined();
    expect(result.body).toBe("Do the thing.");
  });

  it("should handle empty body", () => {
    const content = "---\nname: test\ndescription: Test skill.\n---\n";
    const result = parseSkillMd(content);
    expect(result.body).toBe("");
  });

  it("should throw on missing frontmatter", () => {
    expect(() => parseSkillMd("# Just markdown")).toThrow(ValidationError);
  });

  it("should throw on invalid YAML in frontmatter", () => {
    const content = "---\n: invalid: yaml:\n---\nBody";
    expect(() => parseSkillMd(content)).toThrow(ValidationError);
  });

  it("should throw on invalid name (uppercase)", () => {
    const content = "---\nname: Invalid-Name\ndescription: Test.\n---\n";
    expect(() => parseSkillMd(content)).toThrow(ValidationError);
  });

  it("should throw on missing description", () => {
    const content = "---\nname: test\n---\nBody";
    expect(() => parseSkillMd(content)).toThrow(ValidationError);
  });

  it("should strip unknown fields", () => {
    const content = "---\nname: test\ndescription: Test.\nunknown_field: value\n---\n";
    const result = parseSkillMd(content);
    expect(result.frontmatter).not.toHaveProperty("unknown_field");
  });
});

// --- AGENTS.md Parser ---

describe("parseAgentsMd", () => {
  it("should parse valid content", () => {
    const result = parseAgentsMd("# My Agent Context\n\nSome instructions.");
    expect(result.content).toBe("# My Agent Context\n\nSome instructions.");
  });

  it("should trim whitespace", () => {
    const result = parseAgentsMd("  \n  content  \n  ");
    expect(result.content).toBe("content");
  });

  it("should throw on empty content", () => {
    expect(() => parseAgentsMd("")).toThrow(ValidationError);
  });

  it("should throw on whitespace-only content", () => {
    expect(() => parseAgentsMd("   \n\n  ")).toThrow(ValidationError);
  });

  it("should handle large content", () => {
    const large = "x".repeat(50000);
    const result = parseAgentsMd(large);
    expect(result.content).toHaveLength(50000);
  });
});

// --- agent.yaml Parser ---

describe("parseAgentYaml", () => {
  it("should parse a valid agent.yaml with all fields", async () => {
    const content = await readFile(resolve(FIXTURES, "valid-agent.yaml"), "utf-8");
    const result = parseAgentYaml(content);

    expect(result.config.name).toBe("acme/seo-audit");
    expect(result.config.version).toBe("1.0.0");
    expect(result.config.model.provider).toBe("anthropic");
    expect(result.config.model.fallback?.provider).toBe("openai");
    expect(result.config.tools.map((t) => t.name)).toContain("web_search");
    expect(result.config.inputs).toHaveLength(1);
    expect(result.config.outputs).toHaveLength(2);
    expect(result.config.environment.networking.allowed_hosts).toContain("googleapis.com");
    expect(result.config.environment.max_cost).toBe(0.5);
    expect(result.config.state.type).toBe("kv");
    expect(result.config.tests).toHaveLength(1);
    expect(result.raw).toContain("acme/seo-audit");
  });

  it("should parse a minimal agent.yaml with defaults", () => {
    const yaml = `
name: acme/simple
version: 1.0.0
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
inputs:
  - name: query
    type: string
outputs:
  - name: result
    type: string
`;
    const result = parseAgentYaml(yaml);
    expect(result.config.tools).toEqual([]);
    expect(result.config.environment.filesystem).toBe("read-only");
    expect(result.config.environment.timeout).toBe("300s");
    expect(result.config.environment.sandbox).toBe("strict");
    expect(result.config.state.type).toBe("kv");
    expect(result.config.state.ttl).toBe("30d");
    expect(result.config.context_mode).toBe("skill");
  });

  it("should throw on invalid YAML", () => {
    expect(() => parseAgentYaml("not: valid: yaml:")).toThrow(ValidationError);
  });

  it("should throw on empty content", () => {
    expect(() => parseAgentYaml("")).toThrow(ValidationError);
  });

  it("should throw on missing name", () => {
    const yaml = `
version: 1.0.0
model:
  provider: anthropic
  name: test
inputs:
  - name: q
    type: string
outputs:
  - name: r
    type: string
`;
    expect(() => parseAgentYaml(yaml)).toThrow(ValidationError);
  });

  it("should throw on invalid name format (no namespace)", () => {
    const yaml = `
name: no-namespace
version: 1.0.0
model:
  provider: anthropic
  name: test
inputs:
  - name: q
    type: string
outputs:
  - name: r
    type: string
`;
    expect(() => parseAgentYaml(yaml)).toThrow(ValidationError);
  });

  it("should throw with field-level error details", () => {
    try {
      parseAgentYaml(`
name: acme/test
version: bad
model:
  provider: anthropic
  name: test
inputs:
  - name: q
    type: string
outputs:
  - name: r
    type: string
`);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.issues.some((i) => i.field === "version")).toBe(true);
    }
  });

  it("should throw on empty inputs array", () => {
    const yaml = `
name: acme/test
version: 1.0.0
model:
  provider: anthropic
  name: test
inputs: []
outputs:
  - name: r
    type: string
`;
    expect(() => parseAgentYaml(yaml)).toThrow(ValidationError);
  });

  it("should throw on scalar YAML content", () => {
    expect(() => parseAgentYaml("just a string")).toThrow(ValidationError);
  });

  it("should preserve raw content", () => {
    const yaml = `name: acme/test
version: 1.0.0
model:
  provider: anthropic
  name: test
inputs:
  - name: q
    type: string
outputs:
  - name: r
    type: string
`;
    const result = parseAgentYaml(yaml);
    expect(result.raw).toBe(yaml);
  });
});
