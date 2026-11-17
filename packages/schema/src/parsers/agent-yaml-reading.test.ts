import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse, parseDocument } from "yaml";
import { validateAgent } from "../validators/combined.js";
import { parseAgentYaml } from "./agent-yaml.js";

// The yaml library's two parsers, watched: each still parses as it does.
vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return {
    ...actual,
    parse: vi.fn(actual.parse),
    parseDocument: vi.fn(actual.parseDocument),
  };
});

const AGENT_DIR = resolve(import.meta.dirname, "../../tests/fixtures/valid-agent-dir");

// An agent.yaml is read as YAML 1.2, with the core schema, by each of its
// reads — named to the library, not left to its defaults. Today the library's
// defaults are those very values: no file is read otherwise without them, and
// only the options the library receives can show that they are named.
describe("agent.yaml — the YAML version and schema, named to the library", () => {
  const READING = { version: "1.2", schema: "core" };

  beforeEach(() => {
    vi.mocked(parse).mockClear();
    vi.mocked(parseDocument).mockClear();
  });

  it("parseAgentYaml reads the file as YAML 1.2, with the core schema", async () => {
    const content = await readFile(resolve(AGENT_DIR, "agent.yaml"), "utf-8");
    parseAgentYaml(content);
    expect(vi.mocked(parseDocument).mock.calls).toEqual([
      [content, expect.objectContaining(READING)],
    ]);
  });

  it("validateAgent's second read of the file reads it as the parse does", async () => {
    const content = await readFile(resolve(AGENT_DIR, "agent.yaml"), "utf-8");
    const result = await validateAgent(AGENT_DIR);
    expect(result.valid).toBe(true);
    expect(vi.mocked(parseDocument).mock.calls).toEqual([
      [content, expect.objectContaining(READING)],
    ]);
    // SKILL.md's front matter is read by `parse` too: the agent.yaml read only.
    const reads = vi.mocked(parse).mock.calls.filter(([source]) => source === content);
    expect(reads).toEqual([[content, expect.objectContaining(READING)]]);
  });
});
