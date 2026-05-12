import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAgent } from "./combined.js";

const FIXTURES = resolve(import.meta.dirname, "../../tests/fixtures");

const MINIMAL_SKILL_MD = `---
name: test-agent
description: A test agent for #57 script-deps validation
---

# Test agent

Body.
`;

const MINIMAL_AGENT_YAML = `name: dev/test-agent
version: 0.1.0
model:
  provider: anthropic
  name: claude-3-7-sonnet
inputs:
  - name: q
    type: string
    required: true
outputs:
  - name: answer
    type: string
`;

function createBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "skrun-validator-test-"));
  writeFileSync(join(dir, "SKILL.md"), MINIMAL_SKILL_MD);
  writeFileSync(join(dir, "agent.yaml"), MINIMAL_AGENT_YAML);
  return dir;
}

function writeIn(bundleDir: string, relativePath: string, content: string): void {
  const fullPath = join(bundleDir, relativePath);
  const parent = dirname(fullPath);
  if (parent !== bundleDir) mkdirSync(parent, { recursive: true });
  writeFileSync(fullPath, content);
}

describe("validateAgent", () => {
  it("should validate a valid agent directory", async () => {
    const result = await validateAgent(resolve(FIXTURES, "valid-agent-dir"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed?.skill.frontmatter.name).toBe("pdf-processing");
    expect(result.parsed?.agentConfig.config.name).toBe("acme/seo-audit");
  });

  it("should return error for missing SKILL.md", async () => {
    const result = await validateAgent(resolve(FIXTURES, "missing-skill-dir"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_SKILL_MD")).toBe(true);
    expect(result.parsed).toBeNull();
  });

  it("should return error for missing agent.yaml", async () => {
    // Create a temp dir with just SKILL.md — use a non-existent path
    const result = await validateAgent(resolve(FIXTURES, "nonexistent-dir"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_SKILL_MD")).toBe(true);
    expect(result.errors.some((e) => e.code === "MISSING_AGENT_YAML")).toBe(true);
  });

  it("should return error for persistent mode without AGENTS.md", async () => {
    const result = await validateAgent(resolve(FIXTURES, "persistent-no-agents-dir"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "CONTEXT_MODE_NO_AGENTS_MD")).toBe(true);
  });

  it("should return name mismatch warning", async () => {
    // valid-agent-dir has SKILL.md name "pdf-processing" but agent.yaml slug "seo-audit"
    const result = await validateAgent(resolve(FIXTURES, "valid-agent-dir"));
    expect(result.warnings.some((w) => w.code === "NAME_MISMATCH")).toBe(true);
    expect(result.valid).toBe(true); // warnings don't block
  });

  it("should not return warnings as errors", async () => {
    const result = await validateAgent(resolve(FIXTURES, "valid-agent-dir"));
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("validateAgent — SCRIPTS_NO_MANIFEST warning (#57)", () => {
  let bundle: string;

  beforeEach(() => {
    bundle = createBundle();
  });

  afterEach(() => {
    rmSync(bundle, { recursive: true, force: true });
  });

  it("warns when scripts/ has non-stdlib imports (Python) and no manifest is present", async () => {
    writeIn(bundle, "scripts/process.py", "import pandas as pd\nimport os\n");
    const result = await validateAgent(bundle);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(true);
  });

  it("warns when scripts/ has non-stdlib imports (Node) and no manifest is present", async () => {
    writeIn(bundle, "scripts/zip.js", "const JSZip = require('jszip');\n");
    const result = await validateAgent(bundle);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(true);
  });

  it("does NOT warn when scripts/ uses only stdlib", async () => {
    writeIn(bundle, "scripts/util.py", "import os\nimport json\nfrom pathlib import Path\n");
    writeIn(
      bundle,
      "scripts/util.js",
      "const fs = require('node:fs');\nconst path = require('path');\n",
    );
    const result = await validateAgent(bundle);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(false);
  });

  it("does NOT warn when a Python manifest is present", async () => {
    writeIn(bundle, "scripts/process.py", "import pandas as pd\n");
    writeIn(bundle, "requirements.txt", "pandas==2.2.3\n");
    const result = await validateAgent(bundle);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(false);
  });

  it("does NOT warn when a Node manifest is present", async () => {
    writeIn(bundle, "scripts/zip.js", "const JSZip = require('jszip');\n");
    writeIn(bundle, "package.json", '{"name":"x","dependencies":{"jszip":"^3"}}');
    const result = await validateAgent(bundle);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(false);
  });

  it("does NOT warn when scripts/ does not exist", async () => {
    const result = await validateAgent(bundle);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(false);
  });

  it("does NOT warn when scripts/ exists but is empty", async () => {
    mkdirSync(join(bundle, "scripts"), { recursive: true });
    const result = await validateAgent(bundle);
    expect(result.warnings.some((w) => w.code === "SCRIPTS_NO_MANIFEST")).toBe(false);
  });
});

describe("validateAgent — TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL (#58)", () => {
  let bundle: string;

  beforeEach(() => {
    bundle = createBundle();
  });

  afterEach(() => {
    rmSync(bundle, { recursive: true, force: true });
  });

  function writeAgentYaml(extra: string): void {
    writeFileSync(join(bundle, "agent.yaml"), `${MINIMAL_AGENT_YAML}${extra}`);
  }

  it("does NOT error when tool_choice is 'auto' (default)", async () => {
    const result = await validateAgent(bundle);
    expect(result.errors.some((e) => e.code === "TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL")).toBe(
      false,
    );
  });

  it("does NOT error when tool_choice is 'required'", async () => {
    writeAgentYaml(`tool_choice: required\n`);
    const result = await validateAgent(bundle);
    expect(result.errors.some((e) => e.code === "TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL")).toBe(
      false,
    );
  });

  it("does NOT error when tool_choice is 'none'", async () => {
    writeAgentYaml(`tool_choice: none\n`);
    const result = await validateAgent(bundle);
    expect(result.errors.some((e) => e.code === "TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL")).toBe(
      false,
    );
  });

  it("does NOT error when tool_choice references a declared tool (SC-2)", async () => {
    writeAgentYaml(`tools:
  - name: write_artifact
    description: Write an artifact file
    input_schema:
      type: object
      properties:
        path: { type: string }
        content: { type: string }
      required: [path, content]
tool_choice: write_artifact
`);
    const result = await validateAgent(bundle);
    expect(result.errors.some((e) => e.code === "TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL")).toBe(
      false,
    );
    expect(result.valid).toBe(true);
  });

  it("errors when tool_choice references an undeclared tool (SC-3)", async () => {
    writeAgentYaml(`tool_choice: ghost_tool\n`);
    const result = await validateAgent(bundle);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.code === "TOOL_CHOICE_REFERENCES_UNDECLARED_TOOL");
    expect(err).toBeDefined();
    expect(err?.message).toContain("ghost_tool");
  });
});
