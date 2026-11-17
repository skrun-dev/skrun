import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { ValidationError } from "../errors.js";
import { parseAgentYaml } from "./agent-yaml.js";
import { parseAgentsMd } from "./agents-md.js";
import { parseSkillMd } from "./skill-md.js";

/** A megabyte, as the codec counts one. */
const MIB = 1024 * 1024;

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

    expect(result.config.name).toBe("seo-audit");
    expect(result.config.version).toBe("1.0.0");
    expect(result.config.model.provider).toBe("anthropic");
    expect(result.config.model.fallback?.provider).toBe("openai");
    expect(result.config.tools.map((t) => t.name)).toContain("web_search");
    expect(result.config.inputs).toHaveLength(1);
    expect(result.config.outputs).toHaveLength(2);
    expect(result.config.environment.networking.allowed_hosts).toContain("googleapis.com");
    expect(result.config.environment.max_cost).toBe(0.5);
    expect(result.config.state.type).toBe("kv");
    expect(result.config.state.scope).toBe("per_caller");
    expect(result.config.tests).toHaveLength(1);
    expect(result.raw).toContain("seo-audit");
  });

  it("should parse a minimal agent.yaml with defaults", () => {
    const yaml = `
name: simple
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
    expect(result.config.environment).not.toHaveProperty("filesystem");
    expect(result.config.environment.timeout).toBe("300s");
    expect(result.config.environment).not.toHaveProperty("sandbox");
    expect(result.config.state.type).toBe("none");
    expect(result.config.state.scope).toBe("per_caller");
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

  // VT-2 — legacy `<ns>/<slug>` form is now rejected; error message guides
  // the user to drop the prefix and explains namespace-at-push.
  it("VT-2: rejects legacy <ns>/<slug> name with a remediation hint", () => {
    const legacyYaml = `
name: acme/seo-audit
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
    expect(() => parseAgentYaml(legacyYaml)).toThrow(ValidationError);
    try {
      parseAgentYaml(legacyYaml);
      expect.fail("Should have thrown");
    } catch (err) {
      const ve = err as ValidationError;
      const nameIssue = ve.issues.find((i) => i.field?.includes("name"));
      expect(nameIssue?.message).toMatch(/remove the prefix/i);
      expect(nameIssue?.message).toMatch(/registry derives the namespace/i);
    }
  });

  // VT-3..VT-7 — slug-only regex rejects uppercase, spaces, consecutive
  // hyphens, leading/trailing hyphens, and double-slash. All variants must
  // surface as a ValidationError on the `name` field.
  function yamlWithName(invalidName: string): string {
    return `
name: ${invalidName}
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
  }

  it.each([
    ["VT-3 uppercase", "EmailDrafter"],
    ["VT-4 spaces", "foo bar"],
    ["VT-5 consecutive hyphens", "foo--bar"],
    ["VT-6a leading hyphen", "-foo"],
    ["VT-6b trailing hyphen", "foo-"],
    ["VT-7 double-slash", "a/b/c"],
  ])("rejects invalid slug %s (`%s`)", (_id, invalidName) => {
    expect(() => parseAgentYaml(yamlWithName(invalidName))).toThrow(ValidationError);
  });

  it("should throw with field-level error details", () => {
    try {
      parseAgentYaml(`
name: test-agent
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
name: test-agent
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
    const yaml = `name: test-agent
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

// The yaml library's warnings are returned — how many, the first three by
// their line, and the first one's code and place —, never emitted: a file of
// 128 KB can carry thousands.
describe("parseAgentYaml — the yaml library's warnings", () => {
  const FILE = (lines: string[]) =>
    `name: probe
version: 1.0.0
model:
  provider: anthropic
  name: claude-sonnet-4-5
outputs:
  - name: a
    type: string
inputs:
  - name: q
    type: object
    default:
${lines
  .map(
    (l) => `      ${l}
`,
  )
  .join("")}`;

  it("returns them, the first three by their line, and emits none", () => {
    const emitted = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const { warnings } = parseAgentYaml(FILE(["- !x a", "- !y b", "- !z c", "- !w d"]));
      expect(warnings).toEqual({
        count: 4,
        first: [
          "Unresolved tag: !x at line 13, column 9",
          "Unresolved tag: !y at line 14, column 9",
          "Unresolved tag: !z at line 15, column 9",
        ],
        firstAt: { code: "TAG_RESOLVE_FAILED", line: 13, column: 9 },
      });
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      emitted.mockRestore();
    }
  });

  // What the server logs of them holds nothing of the file: the first one's
  // code and place, however long the tag it could not resolve.
  it("places the first one by its code, its line and its column, never its words", () => {
    const tag = `!${"t".repeat(5_000)}`;
    const { warnings } = parseAgentYaml(FILE(["- a", `- ${tag} b`]));
    expect(warnings.firstAt).toEqual({ code: "TAG_RESOLVE_FAILED", line: 14, column: 9 });
    expect(JSON.stringify(warnings.firstAt)).not.toContain("ttt");
    expect(warnings.first[0]).toContain(tag);
  });

  it("returns none for a file that gives none", () => {
    expect(parseAgentYaml(FILE(["- a"])).warnings).toStrictEqual({ count: 0, first: [] });
  });
});

// An alias repeats the value its anchor names: refused, whatever it repeats,
// before any value is built. An anchor no alias repeats is a label, accepted.
describe("parseAgentYaml — YAML aliases", () => {
  const HEAD = `name: probe
version: 1.0.0
model:
  provider: anthropic
  name: claude-sonnet-4-5
outputs:
  - name: a
    type: string
`;
  const INPUTS = "inputs:\n  - name: q\n    type: string\n";
  const tool = (i: number, description: string) =>
    `  - name: tool_${i}\n    description: ${description}\n    input_schema:\n      type: object\n`;

  /** The issues of a refused file — or a failed expectation when it parses. */
  function issuesOf(yaml: string): ValidationError["issues"] {
    try {
      parseAgentYaml(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).issues;
    }
    return expect.fail("parsed, where it should have been refused");
  }

  it("refuses one alias, by name, with what to do", () => {
    const yaml = `${HEAD}${INPUTS}tools:\n${tool(0, "&same Looks things up.")}${tool(1, "*same")}`;
    expect(issuesOf(yaml)).toEqual([
      {
        code: "YAML_ALIAS",
        message:
          "YAML aliases are not accepted in agent.yaml: *same repeats the value anchored as &same. Write the value out in full wherever it is used.",
      },
    ]);
  });

  // The file a review measured: in 1 MB, 99 aliases of a long description
  // made a configuration of about 100 MB.
  it("refuses 99 aliases of a long text, in a file of 1 MB", () => {
    let yaml = `${HEAD}${INPUTS}tools:\n${tool(0, `&big ${"x".repeat(1_000_000)}`)}`;
    for (let i = 1; i <= 99; i++) yaml += tool(i, "*big");
    expect(Buffer.byteLength(yaml)).toBeLessThanOrEqual(1_048_576);
    expect(issuesOf(yaml).map((issue) => issue.code)).toEqual(["YAML_ALIAS"]);
  });

  // The library's own bound counts an alias of a collection of empty
  // collections as nothing: 300 of them, past its 100, made a 23 KB file a
  // configuration of 2.7 MB — growing with their product.
  it("refuses aliases of a collection of empty collections, which the library's bound lets through", () => {
    const empties = Array.from({ length: 3000 }, () => "[]").join(",");
    let inputs = `inputs:\n  - name: i0\n    type: string\n    default: &x [${empties}]\n`;
    for (let i = 1; i <= 300; i++) inputs += `  - name: i${i}\n    type: string\n    default: *x\n`;
    expect(issuesOf(`${HEAD}${inputs}`).map((issue) => issue.code)).toEqual(["YAML_ALIAS"]);
  });

  it("refuses a merge key, which repeats through an alias", () => {
    const yaml = `${HEAD}${INPUTS}environment: &env\n  timeout: 60s\nx_copy:\n  <<: *env\n`;
    expect(issuesOf(yaml).map((issue) => issue.code)).toEqual(["YAML_ALIAS"]);
  });

  it("accepts an anchor that no alias repeats", () => {
    const yaml = `${HEAD}${INPUTS}tools:\n${tool(0, "&label Looks things up.")}`;
    expect(parseAgentYaml(yaml).config.tools.map((t) => t.description)).toEqual([
      "Looks things up.",
    ]);
  });

  it("parses a file without an alias as before, the value written out twice", () => {
    const yaml = `${HEAD}${INPUTS}tools:\n${tool(0, "Looks things up.")}${tool(1, "Looks things up.")}`;
    expect(parseAgentYaml(yaml).config.tools.map((t) => t.description)).toEqual([
      "Looks things up.",
      "Looks things up.",
    ]);
  });
});

// agent.yaml is read as YAML 1.2. A %YAML directive that declares another
// version is refused before the document is read: under %YAML 1.1 the yaml
// library reads the YAML 1.1 types, its !!omap among them. That one it
// resolves in a YAML 1.2 document too, and checks by comparing each of its
// keys with every earlier one: the tag is refused, read without that check.
describe("parseAgentYaml — the YAML version, and the tag !!omap", () => {
  const HEAD = `name: probe
version: 1.0.0
model:
  provider: anthropic
  name: claude-sonnet-4-5
outputs:
  - name: a
    type: string
`;
  const INPUTS = "inputs:\n  - name: q\n    type: string\n";
  /** `lines` as the value of an input's default, which the schema takes whatever it holds. */
  const inDefault = (...lines: string[]) =>
    `${HEAD}inputs:\n  - name: q\n    type: object\n    default:\n${lines.map((line) => `      ${line}\n`).join("")}`;
  const OMAP_REFUSAL = {
    code: "YAML_TAG",
    message:
      "The YAML tag !!omap is not accepted in agent.yaml. Remove it, and write the entries as a mapping.",
  };

  /** The issues of a refused file — or a failed expectation when it parses. */
  function issuesOf(yaml: string): ValidationError["issues"] {
    try {
      parseAgentYaml(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).issues;
    }
    return expect.fail("parsed, where it should have been refused");
  }

  it("refuses %YAML 1.1: the file is read as YAML 1.2, the line to remove", () => {
    expect(issuesOf(`%YAML 1.1\n---\n${HEAD}${INPUTS}`)).toEqual([
      {
        code: "YAML_VERSION",
        message:
          "agent.yaml is read as YAML 1.2: the directive %YAML 1.1 is not accepted. Remove that line.",
      },
    ]);
  });

  it.each([
    ["%YAML 1.0", "%YAML 1.0\n---\n"],
    ["%YAML 1.3", "%YAML 1.3\n---\n"],
    ["%YAML 1.1 after a comment and %YAML 1.2", "# c\n%YAML 1.2\n%YAML 1.1\n---\n"],
    ["%YAML 1.1 after a byte-order mark", "﻿%YAML 1.1\n---\n"],
    ["%YAML 1.1 and CRLF line ends", "%YAML 1.1\r\n---\r\n"],
  ])("refuses %s", (_case, prologue) => {
    expect(issuesOf(`${prologue}${HEAD}${INPUTS}`).map((issue) => issue.code)).toEqual([
      "YAML_VERSION",
    ]);
  });

  it("judges the directive before the document: one that does not parse is refused for it", () => {
    const yaml = `%YAML 1.1\n---\n${HEAD}${INPUTS}b: [1, 2\n`;
    expect(issuesOf(yaml).map((issue) => issue.code)).toEqual(["YAML_VERSION"]);
  });

  // Only the first document's directives are read, its own lines left unread:
  // a second document is refused for being one, whatever it declares.
  it("reads the first document's directives only: a second document's is refused as a second document", () => {
    const issues = issuesOf(`${HEAD}${INPUTS}...\n%YAML 1.1\n---\nx: 1\n`);
    expect(issues.map((issue) => issue.code)).toEqual(["INVALID_YAML"]);
    expect(issues[0]?.message).toMatch(/^YAML parse error: Source contains multiple documents/);
  });

  it.each([
    ["%YAML 1.2", "%YAML 1.2\n---\n"],
    ["a %TAG directive", "%TAG !e! tag:yaml.org,2002:\n---\n"],
  ])("accepts %s, the file read as without it", (_case, prologue) => {
    expect(parseAgentYaml(`${prologue}${HEAD}${INPUTS}`).config).toEqual(
      parseAgentYaml(`${HEAD}${INPUTS}`).config,
    );
  });

  it("refuses the tag !!omap, with what to do", () => {
    expect(issuesOf(inDefault("!!omap", "  - a: 1", "  - b: 2"))).toEqual([OMAP_REFUSAL]);
  });

  it.each([
    ["a flow sequence", inDefault("!!omap [a: 1, b: 2]")],
    ["its full name", inDefault("!<tag:yaml.org,2002:omap>", "  - a: 1")],
    ["a %TAG handle", `%TAG !e! tag:yaml.org,2002:\n---\n${inDefault("!e!omap", "  - a: 1")}`],
    ["%YAML 1.2", `%YAML 1.2\n---\n${inDefault("!!omap", "  - a: 1")}`],
    ["on a mapping", inDefault("!!omap {a: 1}")],
    ["on a scalar", inDefault("!!omap x")],
    ["at the root", "--- !!omap\n- a: 1\n"],
  ])("refuses !!omap: %s", (_case, yaml) => {
    expect(issuesOf(yaml)).toEqual([OMAP_REFUSAL]);
  });

  // The library's check would have refused this repeat as its own error,
  // INVALID_YAML: the tag read without it, the file is refused for the tag.
  it("reads !!omap without the library's check of its keys", () => {
    expect(issuesOf(inDefault("!!omap [a: 1, a: 2]"))).toEqual([OMAP_REFUSAL]);
  });

  // In 1 MB, an !!omap of about 107,000 entries written as one flow sequence:
  // the library's check held the event loop 13.5 s; read without it, the
  // file is refused in 0.8 s (2026-11-16, Windows, Node 24). Past the push's
  // limit — the CLI's validation reads an agent.yaml of any size —, and at
  // 2 MB, where the check would take four times that: the bound leaves room
  // for a slow machine, not for the check. The test above holds the check
  // off whatever the machine.
  it("refuses an !!omap of 2 MB in under 10 s", () => {
    /** The `i`-th word of a, …, z, aa, …: a string YAML reads as such, each once. */
    const word = (i: number) => {
      let s = "";
      for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
      }
      return s;
    };
    // ASCII only: a character is a byte.
    const head = `${HEAD}inputs:\n  - name: q\n    type: object\n    default: !!omap [`;
    const entries: string[] = [];
    let size = head.length + "z: 0]\n".length;
    for (let entry = `k${word(0)}: 0, `; size + entry.length <= 2 * MIB; ) {
      entries.push(entry);
      size += entry.length;
      entry = `k${word(entries.length)}: 0, `;
    }
    const yaml = `${head}${entries.join("")}z: 0]\n`;
    expect(Buffer.byteLength(yaml)).toBe(size);
    expect(entries.length).toBeGreaterThan(180_000);

    const started = performance.now();
    expect(issuesOf(yaml)).toEqual([OMAP_REFUSAL]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 120_000);

  // The other YAML 1.1 types the library resolves in a YAML 1.2 document take
  // no longer to parse than a plain mapping, and are accepted as before.
  it.each([
    ["!!pairs", inDefault("!!pairs", "  - a: 1", "  - a: 2")],
    ["!!set", inDefault("!!set", "  ? a", "  ? b")],
    ["!!merge", inDefault("!!merge <<: {x: 1}", "y: 2")],
    ["!!binary", inDefault("!!binary aGk=")],
    ["!!timestamp", inDefault("!!timestamp 2001-12-14")],
  ])("accepts %s", (_case, yaml) => {
    expect(() => parseAgentYaml(yaml)).not.toThrow();
  });
});

// A key repeated in its mapping is refused as the yaml library refused it —
// the same refusal, in its words; placed at the repeated key, which is where
// the library placed it but in a few cases, and the cases below are ones where
// both agree. The library's own check compares each key with every earlier key
// of its mapping, so the parse turns it off and checks the keys in one pass.
describe("parseAgentYaml — repeated keys", () => {
  const HEAD = `name: probe
version: 1.0.0
model:
  provider: anthropic
  name: claude-sonnet-4-5
outputs:
  - name: a
    type: string
`;
  const INPUTS = "inputs:\n  - name: q\n    type: string\n";
  /** `lines` as the mapping of an input's default, which the schema takes whatever it holds. */
  const inDefault = (...lines: string[]) =>
    `${HEAD}inputs:\n  - name: q\n    type: object\n    default:\n${lines.map((line) => `      ${line}\n`).join("")}`;

  /** The message of the `INVALID_YAML` refusal of `yaml`, or `undefined`. */
  function yamlRefusal(yaml: string): string | undefined {
    try {
      parseAgentYaml(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const issue = (err as ValidationError).issues[0];
      return issue?.code === "INVALID_YAML" ? issue.message : undefined;
    }
    return undefined;
  }

  it("refuses a repeated key: INVALID_YAML, the line and column, the line pointed at", () => {
    expect(() => parseAgentYaml(`${HEAD}${INPUTS}name: again\n`)).toThrow(ValidationError);
    expect(yamlRefusal(`${HEAD}${INPUTS}name: again\n`)).toBe(
      "YAML parse error: Map keys must be unique at line 12, column 1:\n\n    type: string\nname: again\n^\n",
    );
  });

  // In 1 MB, one mapping of about 89,000 keys: the library's check held the
  // event loop 32 s, 90 s under this runner on a busy machine; the one pass,
  // 0.55 s (2026-11-16, Windows, Node 24). Past the push's limit — the CLI's
  // validation reads an agent.yaml of any size —: at 128 KB the check would
  // pass any bound a slow machine needs. The bound leaves room for a slow
  // machine, not for the quadratic check.
  it("parses an agent.yaml of 1 MB, one mapping of its many keys, in under 10 s", () => {
    /** The `i`-th word of a, …, z, aa, …: a string YAML reads as such, each once. */
    const word = (i: number) => {
      let s = "";
      for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
      }
      return s;
    };
    // ASCII only: a character is a byte.
    const lines = [`${HEAD}inputs:\n  - name: q\n    type: object\n    default:\n`];
    let size = lines[0]?.length ?? 0;
    for (let line = `      ${word(0)}:\n`; size + line.length <= MIB; ) {
      lines.push(line);
      size += line.length;
      line = `      ${word(lines.length - 1)}:\n`;
    }
    const yaml = lines.join("");
    const keys = lines.length - 1;
    expect(Buffer.byteLength(yaml)).toBe(size);
    expect(keys).toBeGreaterThan(80_000);

    const started = performance.now();
    const { config } = parseAgentYaml(yaml);
    const elapsed = performance.now() - started;

    expect(Object.keys(config.inputs[0]?.default as object)).toHaveLength(keys);
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);

  // The reference is the library itself, its check on: on each file, the
  // refusal is the first error the library gives — a repeated key or another,
  // as the third column says — or none when it gives none.
  it.each([
    ['a and "a"', inDefault("a: 1", '"a": 2'), "repeated"],
    ["a and 'a'", inDefault("a: 1", "'a': 2"), "repeated"],
    ['1 and "1"', inDefault("1: x", '"1": y'), "none"],
    ["1 and 1.0", inDefault("1: x", "1.0: y"), "repeated"],
    ["1 and 0x1", inDefault("1: x", "0x1: y"), "repeated"],
    ["null and ~", inDefault("null: x", "~: y"), "repeated"],
    ["two empty keys", inDefault(": x", ": y"), "repeated"],
    [
      "two empty keys, each after ? and an anchor",
      inDefault("? &p", ": 1", "? &q", ": 2"),
      "repeated",
    ],
    ["true and True", inDefault("true: x", "True: y"), "repeated"],
    ['true and "true"', inDefault("true: x", '"true": y'), "none"],
    [".nan and .NaN", inDefault(".nan: x", ".NaN: y"), "none"],
    ["-0 and 0", inDefault("-0: x", "0: y"), "repeated"],
    ["two equal collections", inDefault("? [a]", ": x", "? [a]", ": y"), "none"],
    ["!!str a and a", inDefault("!!str a: x", "a: y"), "repeated"],
    ["one key in two mappings", inDefault("m: {a: 1}", "n: {a: 2}"), "none"],
    ["a flow mapping", inDefault("f: {a: 1, a: 2}"), "repeated"],
    ["a flow sequence of pairs", inDefault("f: [a: 1, a: 2]"), "none"],
    [
      "a block mapping, a key repeated in a value first",
      inDefault("o:", "  x: 1", "  x: 2", "o: 3"),
      "repeated",
    ],
    [
      "a flow mapping, a key repeated in the repeated key's value",
      inDefault("f: {a: 1, a: {x: 1, x: 2}}"),
      "repeated",
    ],
    [
      "a long line, the key past column 60",
      inDefault(`f: {${Array.from({ length: 30 }, (_, i) => `k${i}: 1`).join(", ")}, k0: 2}`),
      "repeated",
    ],
    ["a long line before the key", inDefault(`a: ${"x".repeat(200)}`, "a: 2"), "repeated"],
    ["CRLF line ends", inDefault("a: 1", "a: 2").replace(/\n/g, "\r\n"), "repeated"],
    // YAML 1.1 types the library resolves in a YAML 1.2 document too.
    ["two !!merge keys", inDefault("!!merge <<: {x: 1}", "!!merge <<: {y: 2}"), "none"],
    ["two plain << keys", inDefault("<<: {x: 1}", "<<: {y: 2}"), "repeated"],
    ["!!pairs", inDefault("p: !!pairs", "  - a: 1", "  - a: 2"), "none"],
    ["!!set", inDefault("s: !!set", "  ? a", "  ? a"), "repeated"],
    ["a repeated key, then a syntax error", inDefault("a: 1", "a: 2", "b: [1, 2"), "repeated"],
    ["a syntax error, then a repeated key", inDefault('b: "\\q"', "a: 1", "a: 2"), "other"],
    ["a repeated key with no colon", inDefault("a: 1", "b: 2", "a", "c: 3"), "repeated"],
    ["a repeated key with no closing quote", `${HEAD}${INPUTS}a: 1\n"a\n`, "other"],
    ["a repeated key with an invalid escape", inDefault("a\\q: 0", '"a\\q": 1'), "other"],
    [
      "a flow mapping, an invalid escape in the repeated key's value",
      inDefault('f: {a: 1, a: "\\q"}'),
      "other",
    ],
  ])("%s: the library's refusal", (_case, yaml, first) => {
    const library = parseDocument(yaml).errors[0]?.message;
    const kind =
      library === undefined
        ? "none"
        : library.startsWith("Map keys must be unique")
          ? "repeated"
          : "other";
    expect(kind).toBe(first);
    expect(yamlRefusal(yaml)).toBe(
      library === undefined ? undefined : `YAML parse error: ${library}`,
    );
  });
});
