import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, Help } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";

/**
 * The CLI reference covers the real command tree: the one the binary parses,
 * walked from buildProgram(), never read from the source text.
 *   - every top-level command has its `## skrun <name>` in docs/cli.md;
 *   - every subcommand has its `### skrun <parent> <name>` there;
 *   - every top-level command has its row in the command table of the
 *     package README, the page npm shows.
 * Commander's implicit `help` command is not part of the tree, so it is not
 * asked for.
 */

const REFERENCE = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docs", "cli.md"),
  "utf-8",
);
const README = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf-8");

/**
 * Commands hidden on purpose, which the reference may leave out, keyed by
 * their path (`<name>`, or `<parent> <name>`), each with its reason. Closed:
 * an entry that names no hidden command fails. Empty: no command is hidden.
 */
const HIDDEN_COMMANDS: Readonly<Record<string, string>> = {};

interface TreeEntry {
  /** The names from the top: `["keys"]`, `["keys", "create"]`. */
  names: string[];
  /** The same, space-separated: how the reference titles it after `skrun `. */
  path: string;
  /** Left out of `--help` on purpose (commander's `hidden`). */
  hidden: boolean;
}

/** Every command of the tree, at any depth, in declaration order. */
function walk(parent: Command, prefix: string[] = []): TreeEntry[] {
  const visible = new Set(new Help().visibleCommands(parent));
  return parent.commands.flatMap((command) => {
    const names = [...prefix, command.name()];
    const entry = { names, path: names.join(" "), hidden: !visible.has(command) };
    return [entry, ...walk(command, names)];
  });
}

/**
 * The headings of a Markdown document, read outside fenced code blocks: a
 * `# comment` in a bash example is not a heading.
 */
function headingsOutsideFences(markdown: string): Set<string> {
  const headings = new Set<string>();
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) fence = marker;
      else if (/^#{1,6} /.test(line)) headings.add(line.trimEnd());
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      fence = undefined;
    }
  }
  return headings;
}

/**
 * The first cells of the table headed `| Command | Description |`, or
 * undefined when the document has no such table.
 */
function commandTableFirstCells(markdown: string): string[] | undefined {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\|\s*Command\s*\|\s*Description\s*\|\s*$/.test(line));
  if (header === -1) return undefined;
  const cells: string[] = [];
  // Skip the header and its |---| separator; the table ends at its first non-row.
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    cells.push(line.split("|")[1]?.trim() ?? "");
  }
  return cells;
}

/** A row names `skrun <name>`: its first cell starts with it, then a space or the closing backtick. */
function hasRow(cells: string[], name: string): boolean {
  return cells.some(
    (cell) => cell.startsWith(`\`skrun ${name} `) || cell.startsWith(`\`skrun ${name}\``),
  );
}

const tree = walk(buildProgram());
const documented = tree.filter((entry) => !Object.hasOwn(HIDDEN_COMMANDS, entry.path));
const topLevel = documented.filter((entry) => entry.names.length === 1);
const subcommands = documented.filter((entry) => entry.names.length > 1);
const headings = headingsOutsideFences(REFERENCE);
const readmeCells = commandTableFirstCells(README);

describe("the CLI reference covers the real command tree", () => {
  it("walks the tree the binary parses, and finds the README command table", () => {
    expect(tree.map((entry) => entry.path)).toContain("run");
    expect(readmeCells, "the README table headed | Command | Description |").toBeDefined();
  });

  it("gives every top-level command its ## section in docs/cli.md", () => {
    const missing = topLevel
      .map((entry) => `## skrun ${entry.path}`)
      .filter((heading) => !headings.has(heading));
    expect(missing).toEqual([]);
  });

  it("gives every subcommand its ### section in docs/cli.md", () => {
    const missing = subcommands
      .map((entry) => `### skrun ${entry.path}`)
      .filter((heading) => !headings.has(heading));
    expect(missing).toEqual([]);
  });

  it("gives every top-level command its row in the README command table", () => {
    const missing = topLevel
      .filter((entry) => !hasRow(readmeCells ?? [], entry.path))
      .map((entry) => `| \`skrun ${entry.path}\` |`);
    expect(missing).toEqual([]);
  });

  it("allowlists only commands that are hidden", () => {
    const hidden = new Set(tree.filter((entry) => entry.hidden).map((entry) => entry.path));
    const stale = Object.keys(HIDDEN_COMMANDS).filter((path) => !hidden.has(path));
    expect(stale).toEqual([]);
  });
});
