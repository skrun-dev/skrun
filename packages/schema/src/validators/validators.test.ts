import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CAPABILITIES } from "../capability.js";
import { RETIRED_MODELS, type RetiredModel } from "../schemas/retired-models.js";
import { validateAgent } from "./combined.js";

const FIXTURES = resolve(import.meta.dirname, "../../tests/fixtures");

const MINIMAL_SKILL_MD = `---
name: test-agent
description: A test agent for #57 script-deps validation
---

# Test agent

Body.
`;

const MINIMAL_AGENT_YAML = `name: test-agent
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
  // The yaml library's warnings, said as warnings of the validation — the
  // first three by their line, then how many more —, never emitted: a file
  // can carry thousands, each a line on the terminal.
  it("says the yaml library's warnings, the first three and how many more, and emits none", async () => {
    const emitted = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const dir = createBundle();
    try {
      const tags = ["a", "b", "c", "d", "e"].map((t) => `      - !${t} x`).join("\n");
      writeIn(
        dir,
        "agent.yaml",
        MINIMAL_AGENT_YAML.replace(
          "    type: string\n    required: true\n",
          `    type: object\n    default:\n${tags}\n`,
        ),
      );
      const result = await validateAgent(dir);
      expect(result.errors).toEqual([]);
      expect(result.warnings.filter((w) => w.code === "YAML_WARNING")).toEqual([
        {
          code: "YAML_WARNING",
          message: "Unresolved tag: !a at line 10, column 9",
          file: "agent.yaml",
        },
        {
          code: "YAML_WARNING",
          message: "Unresolved tag: !b at line 11, column 9",
          file: "agent.yaml",
        },
        {
          code: "YAML_WARNING",
          message: "Unresolved tag: !c at line 12, column 9",
          file: "agent.yaml",
        },
        {
          code: "YAML_WARNING",
          message: "2 more YAML warnings of the same file.",
          file: "agent.yaml",
        },
      ]);
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      emitted.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should validate a valid agent directory", async () => {
    const result = await validateAgent(resolve(FIXTURES, "valid-agent-dir"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed?.skill.frontmatter.name).toBe("pdf-processing");
    expect(result.parsed?.agentConfig.config.name).toBe("seo-audit");
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

  // VT-12 — NAME_MISMATCH warning fires when SKILL.md and agent.yaml names
  // differ. valid-agent-dir has SKILL.md name "pdf-processing" but agent.yaml
  // name "seo-audit", so the warning is expected.
  it("VT-12: NAME_MISMATCH warning fires on real name divergence", async () => {
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

  // The push refuses an agent.yaml that holds an alias; skrun build, push and
  // deploy refuse it first, here, with the same words.
  it("refuses an agent.yaml that holds a YAML alias, as the push does", async () => {
    const dir = createBundle();
    try {
      writeIn(
        dir,
        "agent.yaml",
        `${MINIMAL_AGENT_YAML}environment: &env\n  timeout: 60s\nx_copy: *env\n`,
      );
      const result = await validateAgent(dir);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          code: "INVALID_AGENT_YAML",
          message:
            "YAML aliases are not accepted in agent.yaml: *env repeats the value anchored as &env. Write the value out in full wherever it is used.",
          file: "agent.yaml",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an agent.yaml that declares %YAML 1.1, as the push does", async () => {
    const dir = createBundle();
    try {
      writeIn(dir, "agent.yaml", `%YAML 1.1\n---\n${MINIMAL_AGENT_YAML}`);
      const result = await validateAgent(dir);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          code: "INVALID_AGENT_YAML",
          message:
            "agent.yaml is read as YAML 1.2: the directive %YAML 1.1 is not accepted. Remove that line.",
          file: "agent.yaml",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The validation reads agent.yaml twice: once to validate it, once more for
  // its retired fields. The second read, with the yaml library's own check of
  // repeated keys, compared each key with every earlier one: 40,000 keys held
  // it 15 s; without that check, 0.5 s, and 1 s for a file of 1 MB
  // (2026-11-16, Windows, Node 24). Past the push's limit: the validation
  // reads an agent.yaml of any size — `skrun build` warns past the limit, and
  // validates first —, and at 1 MB the check would take far past the bound,
  // which leaves room for a slow machine.
  it("validates an agent.yaml of 1 MB, one mapping of its many keys, in under 10 s", async () => {
    /** The `i`-th word of a, …, z, aa, …: a string YAML reads as such, each once. */
    const word = (i: number) => {
      let s = "";
      for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
      }
      return s;
    };
    const head =
      "name: test-agent\nversion: 0.1.0\nmodel:\n  provider: anthropic\n  name: claude-3-7-sonnet\noutputs:\n  - name: answer\n    type: string\ninputs:\n  - name: q\n    type: object\n    default:\n";
    // ASCII only: a character is a byte.
    const lines = [head];
    let size = head.length;
    for (let line = `      ${word(0)}:\n`; size + line.length <= 1_048_576; ) {
      lines.push(line);
      size += line.length;
      line = `      ${word(lines.length - 1)}:\n`;
    }
    expect(lines.length - 1).toBeGreaterThan(80_000);
    const dir = createBundle();
    try {
      writeIn(dir, "agent.yaml", lines.join(""));
      const started = performance.now();
      const result = await validateAgent(dir);
      const elapsed = performance.now() - started;
      expect(result.errors).toEqual([]);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// VT-13 — NAME_MISMATCH must NOT fire when SKILL.md.name === agent.yaml.name
// (both slug-only post-#84; the comparison is exact equality).
describe("validateAgent — NAME_MISMATCH (post-#84)", () => {
  let bundle: string;

  beforeEach(() => {
    bundle = createBundle();
  });

  afterEach(() => {
    rmSync(bundle, { recursive: true, force: true });
  });

  it("VT-13: does NOT fire NAME_MISMATCH when SKILL.md and agent.yaml names match", async () => {
    // createBundle() uses test-agent in both files — exact match.
    const result = await validateAgent(bundle);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "NAME_MISMATCH")).toBe(false);
  });

  it("fires NAME_MISMATCH when only one of the two names is changed", async () => {
    // Override agent.yaml with a different slug than SKILL.md says.
    writeIn(
      bundle,
      "agent.yaml",
      `name: different-slug
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
`,
    );
    const result = await validateAgent(bundle);
    expect(result.warnings.some((w) => w.code === "NAME_MISMATCH")).toBe(true);
    expect(result.valid).toBe(true);
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

// An allowed host the cloud sandbox cannot enforce is valid: a host pattern is
// honoured by the local runtime, any other such form by none, and the cloud
// runtime refuses the run before any machine. The validator says so at build,
// naming each entry by its form.
describe("validateAgent — an allowed host the cloud sandbox cannot enforce", () => {
  async function validateWithHosts(hosts: string[]) {
    const bundle = createBundle();
    try {
      const lines = hosts.map((h) => `      - "${h}"`).join("\n");
      writeIn(
        bundle,
        "agent.yaml",
        `${MINIMAL_AGENT_YAML}environment:\n  networking:\n    allowed_hosts:\n${lines}\n`,
      );
      return await validateAgent(bundle);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  }

  it("warns EGRESS_HOST_UNSUPPORTED once, naming each such entry by its form, and only them", async () => {
    const result = await validateWithHosts([
      "api.example.com",
      "*.slack.com",
      "example.com:443",
      "https://x.y",
      "x.y/z",
      "user@example.com",
    ]);
    expect(result.valid).toBe(true);
    const found = result.warnings.filter((w) => w.code === "EGRESS_HOST_UNSUPPORTED");
    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe("environment.networking.allowed_hosts");
    const message = found[0]?.message ?? "";
    expect(message).toContain('"*.slack.com" (a host pattern: honoured by the local runtime only)');
    expect(message).toContain('"example.com:443" (a host with a port: honoured by no runtime)');
    expect(message).toContain('"https://x.y" (a URL: honoured by no runtime)');
    expect(message).toContain('"x.y/z" (a host with a path: honoured by no runtime)');
    expect(message).toContain(
      '"user@example.com" (not a host name the sandbox reads: honoured by no runtime)',
    );
    expect(message).not.toContain('"api.example.com"');
    expect(message).toContain("The cloud runtime refuses the run before any machine.");
  });

  it('beside "*", says the entries add nothing and are to be removed — it does not advise "*"', async () => {
    const result = await validateWithHosts(["*", "*.slack.com"]);
    const found = result.warnings.filter((w) => w.code === "EGRESS_HOST_UNSUPPORTED");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("*.slack.com");
    expect(found[0]?.message).toContain("remove");
    expect(found[0]?.message).not.toContain('or use "*"');
  });

  it.each([
    ["'*' alone", ["*"]],
    ["named hosts", ["api.example.com", "example.org"]],
    ["a name surrounded by spaces", ["  api.example.com  "]],
    ["an IPv6 literal, bare and in brackets", ["2606:4700::1111", "[2606:4700::1111]"]],
  ])("warns nothing for %s", async (_case, hosts) => {
    const result = await validateWithHosts(hosts);
    expect(result.warnings.some((w) => w.code === "EGRESS_HOST_UNSUPPORTED")).toBe(false);
  });
});

// A temperature the model refuses: valid, not sent by the runtime, and said
// here, by the model's name, before the first call.
describe("validateAgent — a temperature the model refuses", () => {
  /** Validates the minimal agent with its model block replaced by `model` (YAML lines). */
  async function validateWithModel(...model: string[]) {
    const bundle = createBundle();
    try {
      const yaml = MINIMAL_AGENT_YAML.replace(
        ["model:", "  provider: anthropic", "  name: claude-3-7-sonnet", ""].join("\n"),
        ["model:", ...model, ""].join("\n"),
      );
      writeIn(bundle, "agent.yaml", yaml);
      return await validateAgent(bundle);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  }
  const refusals = (result: Awaited<ReturnType<typeof validateWithModel>>) =>
    result.warnings.filter((w) => w.code === "TEMPERATURE_UNSUPPORTED");

  it("warns TEMPERATURE_UNSUPPORTED on a model that refuses one, naming it, and stays valid", async () => {
    const result = await validateWithModel(
      "  provider: anthropic",
      "  name: claude-opus-4-7-20260416",
      "  temperature: 0.3",
    );
    expect(result.valid).toBe(true);
    const found = refusals(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe("agent.yaml");
    expect(found[0]?.field).toBe("model.temperature");
    expect(found[0]?.message).toContain("anthropic/claude-opus-4-7-20260416");
    expect(found[0]?.message).toContain("0.3");
  });

  it("names the fallback when it is the one that refuses it", async () => {
    const result = await validateWithModel(
      "  provider: google",
      "  name: gemini-2.5-flash",
      "  temperature: 0.3",
      "  fallback:",
      "    provider: openai",
      "    name: gpt-5",
    );
    const found = refusals(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("openai/gpt-5");
    expect(found[0]?.message).not.toContain("gemini-2.5-flash");
  });

  it.each([
    ["a model that accepts one", ["  provider: anthropic", "  name: claude-sonnet-4-6"]],
    [
      "a model the matrix does not know, of a provider that gets it as declared",
      ["  provider: openai", "  name: llama3.1:8b", "  base_url: http://localhost:11434/v1"],
    ],
  ])("warns nothing for %s", async (_case, model) => {
    expect(refusals(await validateWithModel(...model, "  temperature: 0.3"))).toEqual([]);
  });

  it.each([
    ["anthropic", "claude-unlisted-9"],
    ["google", "gemini-9.9-flash"],
    ["openai", "gpt-9-unlisted"],
  ])("warns on an unlisted %s model, saying the matrix does not list it", async (provider, name) => {
    const found = refusals(
      await validateWithModel(`  provider: ${provider}`, `  name: ${name}`, "  temperature: 0.3"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`${provider}/${name}`);
    expect(found[0]?.message).toContain("not in the capability matrix");
  });

  it("warns nothing for an unlisted model behind a declared base_url, whatever the provider", async () => {
    const result = await validateWithModel(
      "  provider: anthropic",
      "  name: llama3.1:8b",
      "  base_url: http://localhost:11434/v1",
      "  temperature: 0.3",
    );
    expect(refusals(result)).toEqual([]);
  });

  it("warns nothing when no temperature is declared, whatever the model", async () => {
    const result = await validateWithModel("  provider: anthropic", "  name: claude-opus-4-7");
    expect(refusals(result)).toEqual([]);
  });
});

// A forced tool choice the model refuses: valid, sent as `auto` by the runtime,
// and said here, by the model's name. The model is a witness row of the
// capability matrix, marked for the duration of each case.
describe("validateAgent — a forced tool choice the model refuses", () => {
  const WITNESS = "claude-witness-unforced";
  const TOOL = [
    "tools:",
    "  - name: write_artifact",
    "    description: Write an artifact file",
    "    input_schema:",
    "      type: object",
  ];

  beforeEach(() => {
    MODEL_CAPABILITIES.anthropic[WITNESS] = {
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
      forcedToolChoice: false,
    };
  });

  afterEach(() => {
    delete MODEL_CAPABILITIES.anthropic[WITNESS];
  });

  /** Validates the minimal agent with its model block replaced, then `extra` lines appended. */
  async function validateWith(model: string[], extra: string[]) {
    const bundle = createBundle();
    try {
      const yaml = MINIMAL_AGENT_YAML.replace(
        ["model:", "  provider: anthropic", "  name: claude-3-7-sonnet", ""].join("\n"),
        ["model:", ...model, ""].join("\n"),
      );
      writeIn(bundle, "agent.yaml", `${yaml}${[...extra, ""].join("\n")}`);
      return await validateAgent(bundle);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  }
  const refusals = (result: Awaited<ReturnType<typeof validateWith>>) =>
    result.warnings.filter((w) => w.code === "TOOL_CHOICE_UNSUPPORTED");
  const ON_WITNESS = ["  provider: anthropic", `  name: ${WITNESS}`];

  it.each([
    ["tool_choice: required", [...TOOL, "tool_choice: required"]],
    ["a tool named in tool_choice", [...TOOL, "tool_choice: write_artifact"]],
    ["a tool marked required", [...TOOL, "    required: true"]],
  ])("warns TOOL_CHOICE_UNSUPPORTED for %s on a model that refuses a forced choice, naming it, and stays valid", async (_case, extra) => {
    const result = await validateWith(ON_WITNESS, extra);
    expect(result.valid).toBe(true);
    const found = refusals(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe("agent.yaml");
    expect(found[0]?.field).toBe("tool_choice");
    expect(found[0]?.message).toContain(`anthropic/${WITNESS}`);
  });

  // Anthropic's page on thinking names them among the models that reject a
  // forced tool choice; their ids extend claude-fable-5 and claude-mythos-5,
  // which accept one.
  it.each([
    "claude-fable-5-2",
    "claude-mythos-5-2",
  ])("warns TOOL_CHOICE_UNSUPPORTED for a forced choice on %s", async (model) => {
    const result = await validateWith(
      ["  provider: anthropic", `  name: ${model}`],
      [...TOOL, "tool_choice: required"],
    );
    expect(result.valid).toBe(true);
    const found = refusals(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`anthropic/${model}`);
  });

  it("names the fallback when it is the one that refuses it", async () => {
    const result = await validateWith(
      [
        "  provider: anthropic",
        "  name: claude-sonnet-4-6",
        "  fallback:",
        "    provider: anthropic",
        `    name: ${WITNESS}`,
      ],
      [...TOOL, "tool_choice: required"],
    );
    const found = refusals(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`anthropic/${WITNESS}`);
    expect(found[0]?.message).not.toContain("claude-sonnet-4-6");
  });

  it.each([
    ["tool_choice: auto", ON_WITNESS, [...TOOL, "tool_choice: auto"]],
    ["tool_choice: none", ON_WITNESS, [...TOOL, "tool_choice: none"]],
    [
      "a model that accepts a forced choice",
      ["  provider: anthropic", "  name: claude-sonnet-4-6"],
      [...TOOL, "tool_choice: required"],
    ],
  ])("warns nothing for %s", async (_case, model, extra) => {
    expect(refusals(await validateWith(model, extra))).toEqual([]);
  });
});

// A retired field stays valid in agent.yaml: it is ignored, and the validator
// says so by name, since the schema alone would drop it without a word.
describe("validateAgent — a retired field", () => {
  it("accepts environment.sandbox with a RETIRED_FIELD warning that names it", async () => {
    const result = await validateAgent(resolve(FIXTURES, "retired-field-dir"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    const retired = result.warnings.filter((w) => w.code === "RETIRED_FIELD");
    expect(retired).toHaveLength(1);
    expect(retired[0]?.field).toBe("environment.sandbox");
    expect(retired[0]?.message).toMatch(/environment\.sandbox.*no effect.*ignored/);
  });

  it.each([
    "none",
    "read-only",
    "read-write",
  ])("accepts environment.filesystem: %s with a RETIRED_FIELD warning that names it, and drops it", async (value) => {
    const bundle = createBundle();
    try {
      writeIn(
        bundle,
        "agent.yaml",
        `${MINIMAL_AGENT_YAML}environment:\n  timeout: 300s\n  filesystem: ${value}\n`,
      );
      const result = await validateAgent(bundle);
      expect(result.warnings.filter((w) => w.code === "RETIRED_FIELD")).toEqual([
        {
          code: "RETIRED_FIELD",
          message: "environment.filesystem has no effect and is ignored — remove it.",
          field: "environment.filesystem",
          file: "agent.yaml",
        },
      ]);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.parsed?.agentConfig.config.environment).not.toHaveProperty("filesystem");
      expect(result.parsed?.agentConfig.config.environment.timeout).toBe("300s");
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it("drops the retired field from the parsed configuration", async () => {
    const result = await validateAgent(resolve(FIXTURES, "retired-field-dir"));
    expect(result.parsed?.agentConfig.config.environment).not.toHaveProperty("sandbox");
    expect(result.parsed?.agentConfig.config.environment.timeout).toBe("300s");
  });

  it("warns about nothing when no retired field is present", async () => {
    const bundle = createBundle();
    try {
      const result = await validateAgent(bundle);
      expect(result.warnings.some((w) => w.code === "RETIRED_FIELD")).toBe(false);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it("still refuses the legacy top-level runtime block, sandbox inside it or not", async () => {
    const bundle = createBundle();
    try {
      writeIn(bundle, "agent.yaml", `${MINIMAL_AGENT_YAML}runtime:\n  sandbox: strict\n`);
      const result = await validateAgent(bundle);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("runtime"))).toBe(true);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});

// A retired model stays valid in agent.yaml: the call fails at the provider,
// so the validator says so first, by the model's name, with the day and the
// replacement. The models are witness entries of the retired-model list,
// listed for the duration of each case.
describe("validateAgent — a retired model", () => {
  const WITNESSES: RetiredModel[] = [
    {
      provider: "openai",
      id: "gpt-witness-retired",
      retiredOn: "2020-01-15",
      replacement: "gpt-witness-current",
    },
    { provider: "openai", id: "gpt-witness-retiring", retiredOn: "2999-01-15" },
  ];
  const list = RETIRED_MODELS as RetiredModel[];

  beforeEach(() => {
    list.push(...WITNESSES);
  });

  afterEach(() => {
    for (const witness of WITNESSES) list.splice(list.indexOf(witness), 1);
  });

  async function validateWithModel(...model: string[]) {
    const bundle = createBundle();
    try {
      const yaml = MINIMAL_AGENT_YAML.replace(
        ["model:", "  provider: anthropic", "  name: claude-3-7-sonnet", ""].join("\n"),
        ["model:", ...model, ""].join("\n"),
      );
      writeIn(bundle, "agent.yaml", yaml);
      return await validateAgent(bundle);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  }
  const retired = (result: Awaited<ReturnType<typeof validateWithModel>>) =>
    result.warnings.filter((w) => w.code === "MODEL_RETIRED");

  it("warns MODEL_RETIRED on a retired model, naming it, its day and its replacement, and stays valid", async () => {
    const result = await validateWithModel("  provider: openai", "  name: gpt-witness-retired");
    expect(result.valid).toBe(true);
    const found = retired(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe("agent.yaml");
    expect(found[0]?.field).toBe("model.name");
    expect(found[0]?.message).toContain("openai/gpt-witness-retired");
    expect(found[0]?.message).toContain("2020-01-15");
    expect(found[0]?.message).toContain("openai/gpt-witness-current");
  });

  it("names the fallback when it is the one retired, and a day still to come as one", async () => {
    const result = await validateWithModel(
      "  provider: openai",
      "  name: gpt-witness-current",
      "  fallback:",
      "    provider: openai",
      "    name: gpt-witness-retiring",
    );
    const found = retired(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe("model.fallback.name");
    expect(found[0]?.message).toContain("retires on 2999-01-15");
    expect(found[0]?.message).not.toContain("gpt-witness-current");
  });

  it.each([
    [
      "a model that extends a retired id",
      ["  provider: openai", "  name: gpt-witness-retired-mini"],
    ],
    ["a retired id under another provider", ["  provider: groq", "  name: gpt-witness-retired"]],
    ["a current model", ["  provider: openai", "  name: gpt-witness-current"]],
  ])("warns nothing for %s", async (_case, model) => {
    expect(retired(await validateWithModel(...model))).toEqual([]);
  });
});

// A state ttl is read between 1 and 365 days by the server, so that a version
// already published still runs; before publishing, a value outside that range
// is refused, whatever the state type — a declared field is a validated field.
describe("validateAgent — a state ttl outside 1 to 365 days", () => {
  async function validateWithState(state: string[]) {
    const bundle = createBundle();
    try {
      writeIn(bundle, "agent.yaml", `${MINIMAL_AGENT_YAML}state:\n${state.join("\n")}\n`);
      return await validateAgent(bundle);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  }
  const outOfRange = (result: Awaited<ReturnType<typeof validateAgent>>) =>
    result.errors.filter((e) => e.code === "STATE_TTL_OUT_OF_RANGE");

  it.each([
    ["0d", "0d"],
    ["366d", "366d"],
    ["99999999999d", "99999999999d"],
    ["a 400-digit number of days", `${"9".repeat(400)}d`],
  ])("refuses ttl %s, naming the bounds", async (_label, ttl) => {
    const result = await validateWithState(["  type: kv", `  ttl: ${ttl}`]);
    expect(result.valid).toBe(false);
    const found = outOfRange(result);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe("agent.yaml");
    expect(found[0]?.field).toBe("state.ttl");
    // The exact wording: the live author path looks for it in the CLI's output.
    expect(found[0]?.message).toContain("between 1 and 365 days");
  });

  it("refuses an out-of-range ttl on an agent whose state is off", async () => {
    const result = await validateWithState(["  type: none", "  ttl: 0d"]);
    expect(result.valid).toBe(false);
    expect(outOfRange(result)).toHaveLength(1);
  });

  it.each([["1d"], ["30d"], ["365d"]])("accepts ttl %s", async (ttl) => {
    const result = await validateWithState(["  type: kv", `  ttl: ${ttl}`]);
    expect(outOfRange(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts a stateful agent that leaves its ttl to the default", async () => {
    const result = await validateWithState(["  type: kv"]);
    expect(outOfRange(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// A setting the schema accepts and no code honours — an MCP server's auth, a
// secret, meta without an endpoint — or a timeout no timer can hold is refused
// by name, before anything is published: an agent declaring it is invalid.
describe("validateAgent — a setting that no code honours", () => {
  async function validateWithYaml(yaml: string) {
    const bundle = createBundle();
    try {
      writeIn(bundle, "agent.yaml", yaml);
      return await validateAgent(bundle);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  }
  const withModel = (...model: string[]) =>
    MINIMAL_AGENT_YAML.replace(
      ["model:", "  provider: anthropic", "  name: claude-3-7-sonnet", ""].join("\n"),
      ["model:", ...model, ""].join("\n"),
    );
  const withServer = (...server: string[]) =>
    `${MINIMAL_AGENT_YAML}mcp_servers:\n  - name: search\n    url: https://mcp.example.com/sse\n${server.join("\n")}\n`;
  const withEnvironment = (...environment: string[]) =>
    `${MINIMAL_AGENT_YAML}environment:\n${environment.join("\n")}\n`;
  const REFUSED = ["UNSUPPORTED_FIELD", "MODEL_BASE_URL_REQUIRED", "TIMEOUT_OUT_OF_RANGE"];

  it.each([
    [
      "an MCP server's auth other than none",
      withServer("    auth: api_key"),
      "UNSUPPORTED_FIELD",
      "mcp_servers[0].auth",
    ],
    [
      "a secrets list that names a secret",
      withEnvironment("  secrets: [X]"),
      "UNSUPPORTED_FIELD",
      "environment.secrets",
    ],
    [
      "meta without a base_url",
      withModel("  provider: meta", "  name: llama"),
      "MODEL_BASE_URL_REQUIRED",
      "model.provider",
    ],
    [
      "a meta fallback",
      withModel(
        "  provider: anthropic",
        "  name: claude-3-7-sonnet",
        "  fallback:",
        "    provider: meta",
        "    name: llama",
      ),
      "MODEL_BASE_URL_REQUIRED",
      "model.fallback.provider",
    ],
    [
      "a timeout of 0s",
      withEnvironment("  timeout: 0s"),
      "TIMEOUT_OUT_OF_RANGE",
      "environment.timeout",
    ],
  ])("refuses %s, by its code and its field", async (_case, yaml, code, field) => {
    const result = await validateWithYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ code, field, file: "agent.yaml" })]);
    expect(result.errors[0]?.message.startsWith(field)).toBe(true);
    expect(result.parsed).toBeNull();
  });

  it.each([
    ["an MCP server's auth written none", withServer("    auth: none")],
    ["an empty secrets list", withEnvironment("  secrets: []")],
    [
      "meta served at a base_url",
      withModel("  provider: meta", "  name: llama", "  base_url: http://localhost:8080/v1"),
    ],
    ["a timeout of 1s", withEnvironment("  timeout: 1s")],
    ["a timeout of 2147483s", withEnvironment("  timeout: 2147483s")],
  ])("accepts %s", async (_case, yaml) => {
    const result = await validateWithYaml(yaml);
    expect(result.errors.filter((e) => REFUSED.includes(e.code))).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
