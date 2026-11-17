import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAgent } from "@skrun-dev/schema";
import { describe, expect, it } from "vitest";

/**
 * The full example of docs/agent-yaml.md validates. The page tells an author
 * what an `agent.yaml` may say; its full example is the one they copy whole. An
 * example that validation refuses — a namespace prefix in its name, a setting
 * no code honours — teaches the error it then reports.
 *
 * What it reads: the first ```yaml block under the "## Full Example" heading,
 * before the next heading of the same level or above. That block is written as
 * the `agent.yaml` of an agent directory made for the test, with a `SKILL.md`
 * of the agent's name, and the directory is judged by `validateAgent`, as
 * `skrun build` judges it: no error, and no warning that the example carries a
 * field retired from `agent.yaml`. The directory is deleted afterwards.
 *
 * The `SKILL.md` carries the agent's slug — the name after any namespace
 * prefix —, so that a prefix is reported by the check of `agent.yaml`'s name,
 * not by the `SKILL.md` this test writes.
 *
 * What it does not see: the other examples of the page, which show one section
 * each, not an agent.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const AGENT_YAML_DOC = join(REPO_ROOT, "docs", "agent-yaml.md");

/** The first ```yaml block under the "## Full Example" heading of `markdown`. */
function fullExample(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const headings = lines.flatMap((line, i) => (line.trim() === "## Full Example" ? [i] : []));
  if (headings.length !== 1) {
    throw new Error(`expected one "## Full Example" heading, found ${headings.length}`);
  }
  let open = (headings[0] ?? 0) + 1;
  while (open < lines.length && lines[open]?.trim() !== "```yaml") {
    if (/^#{1,2} /.test(lines[open] ?? "")) break;
    open++;
  }
  if (lines[open]?.trim() !== "```yaml") {
    throw new Error('no ```yaml block under the "## Full Example" heading');
  }
  let close = open + 1;
  while (close < lines.length && lines[close]?.trim() !== "```") close++;
  if (close === lines.length) {
    throw new Error('the ```yaml block under "## Full Example" is never closed');
  }
  return lines.slice(open + 1, close).join("\n");
}

/** What `validateAgent` says of the full example of `markdown`, and the name the block declares. */
async function judgeFullExample(markdown: string) {
  const agentYaml = fullExample(markdown);
  const name = /^name:[ \t]*(\S+)[ \t]*$/m.exec(agentYaml)?.[1];
  if (name === undefined) throw new Error("the full example declares no top-level name");
  const slug = name.slice(name.lastIndexOf("/") + 1);
  const dir = mkdtempSync(join(tmpdir(), "skrun-full-example-"));
  try {
    writeFileSync(join(dir, "agent.yaml"), agentYaml);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${slug}\ndescription: The agent of the full example of the agent.yaml reference.\n---\n\nFollow the agent's inputs.\n`,
    );
    const result = await validateAgent(dir);
    return {
      name,
      valid: result.valid,
      errors: result.errors,
      retired: result.warnings.filter((warning) => warning.code === "RETIRED_FIELD"),
      parsedName: result.parsed?.agentConfig.config.name,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A page whose full example is `agentYaml`. */
function pageWith(agentYaml: string): string {
  return `# agent.yaml\n\n## Full Example\n\n\`\`\`yaml\n${agentYaml}\n\`\`\`\n\n## After\n`;
}

/** An agent the schema accepts, to which a witness adds one line. */
const WITNESS = [
  "name: witness",
  "version: 1.0.0",
  "model:",
  "  provider: anthropic",
  "  name: claude-sonnet-4-6",
  "mcp_servers:",
  "  - name: search",
  "    url: https://mcp.example.com/mcp",
  "inputs:",
  "  - name: query",
  "    type: string",
  "outputs:",
  "  - name: answer",
  "    type: string",
  "environment:",
  "  timeout: 300s",
].join("\n");

describe("what the check of the full example reports", () => {
  it("passes an example that validates, and reads its name", async () => {
    const judged = await judgeFullExample(pageWith(WITNESS));
    expect(judged).toEqual({
      name: "witness",
      valid: true,
      errors: [],
      retired: [],
      parsedName: "witness",
    });
  });

  it("reports an MCP server's auth that no code honours", async () => {
    const withAuth = WITNESS.replace(
      "    url: https://mcp.example.com/mcp",
      "    url: https://mcp.example.com/mcp\n    auth: oauth2",
    );
    const { errors } = await judgeFullExample(pageWith(withAuth));
    expect(errors.map(({ code, field }) => ({ code, field }))).toEqual([
      { code: "UNSUPPORTED_FIELD", field: "mcp_servers[0].auth" },
    ]);
  });

  it("reports a name with a namespace prefix, by the check of agent.yaml's name", async () => {
    const prefixed = WITNESS.replace("name: witness", "name: acme/witness");
    const { errors } = await judgeFullExample(pageWith(prefixed));
    expect(errors).toEqual([
      expect.objectContaining({
        code: "INVALID_AGENT_YAML",
        file: "agent.yaml",
        message: expect.stringContaining("no namespace prefix"),
      }),
    ]);
  });

  it("reports a field retired from agent.yaml, by its warning", async () => {
    const retired = WITNESS.replace("  timeout: 300s", "  filesystem: read-only\n  timeout: 300s");
    const judged = await judgeFullExample(pageWith(retired));
    expect(judged.errors).toEqual([]);
    expect(judged.retired.map(({ field }) => field)).toEqual(["environment.filesystem"]);
  });

  it("reads the first yaml block under the heading, not one of another section", async () => {
    const page = `# agent.yaml\n\n\`\`\`yaml\nname: acme/elsewhere\n\`\`\`\n\n${pageWith(WITNESS)}`;
    expect((await judgeFullExample(page)).name).toBe("witness");
    expect(() => fullExample("# agent.yaml\n\n## Full Example\n\nNo block.\n\n## After\n")).toThrow(
      'no ```yaml block under the "## Full Example" heading',
    );
  });
});

describe("the full example of docs/agent-yaml.md", () => {
  it("validates: no error, no retired field, and the name it declares is read", async () => {
    const judged = await judgeFullExample(readFileSync(AGENT_YAML_DOC, "utf-8"));
    expect(judged.errors).toEqual([]);
    expect(judged.retired).toEqual([]);
    expect(judged.valid).toBe(true);
    expect(judged.parsedName).toBe(judged.name);
  });
});
