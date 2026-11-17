import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The user reference, read on any host. docs/api.md, docs/cli.md,
 * docs/agent-yaml.md and docs/concepts.md describe what a user of any Skrun
 * server does — the one on their machine, one their company runs, one hosted
 * for them — and are read as pages wherever that server is. An example that
 * names this machine's address is false everywhere else, so none of these
 * pages names `localhost:4000`: the examples name the server `$SKRUN_URL`,
 * which docs/api.md defines once, at its top.
 *
 * One exception, and one only: the sentence of docs/cli.md that states the
 * CLI's default server, recognized by its exact text, never by a line number.
 * It must be there, once, and the address must appear nowhere else in that
 * page — not even a second time on the same line. Copied into another page of
 * the reference, it is reported there like any other mention.
 *
 * What it reads: the whole text of each page, code blocks included — the
 * examples live there. What it does not see: another spelling of this
 * machine's address (`127.0.0.1`, another port).
 *
 * Every page of the docs folder is classified by name: a page of the user
 * reference, or one of the pages that are not — the guides for whoever runs a
 * server, the local tutorial, the index of the docs. A page in neither list,
 * or listed twice, is reported by name: a page taken out of the reference, or
 * added to the folder later, never leaves the guard unseen. A new page is
 * classified by a change to this test, which review reads.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The pages of the user reference, relative to the repository root. */
const REFERENCE = ["docs/api.md", "docs/cli.md", "docs/agent-yaml.md", "docs/concepts.md"] as const;

/**
 * The pages of the docs folder that are not the user reference: the guides
 * for whoever runs a server, the local tutorial, and the index of the docs.
 */
const OUTSIDE_REFERENCE = [
  "docs/self-hosting.md",
  "docs/self-hosting-docker.md",
  "docs/getting-started.md",
  "docs/README.md",
] as const;

const LOCAL_ADDRESS = "localhost:4000";

/** The page that states the CLI's default server, and the sentence that does. */
const DEFAULT_PAGE = "docs/cli.md";
const DEFAULT_SENTENCE =
  "When none of these sets the server, the CLI talks to its default, `http://localhost:4000`.";

/**
 * Each mention of `localhost:4000` in the pages, as `<page>:<line>`, and a
 * line for the page of the CLI's default when its sentence is not there once.
 * The one allowed mention is the address inside that sentence, once.
 */
function localAddressFindings(pages: Readonly<Record<string, string>>): string[] {
  const findings: string[] = [];
  for (const [page, text] of Object.entries(pages)) {
    let rest = text;
    if (page === DEFAULT_PAGE) {
      const times = text.split(DEFAULT_SENTENCE).length - 1;
      if (times !== 1) {
        findings.push(
          `${page}: the sentence of the CLI's default appears ${times} times, once expected`,
        );
      }
      rest = text.replace(DEFAULT_SENTENCE, "");
    }
    rest.split(/\r?\n/).forEach((line, i) => {
      const mentions = line.split(LOCAL_ADDRESS).length - 1;
      for (let k = 0; k < mentions; k++) findings.push(`${page}:${i + 1} ${LOCAL_ADDRESS}`);
    });
  }
  return findings;
}

/**
 * Each page of the docs folder that is not classified once, as `<page>: …`:
 * in neither list, or in the lists more than once.
 */
function classificationFindings(
  pages: readonly string[],
  reference: readonly string[],
  outside: readonly string[],
): string[] {
  const findings: string[] = [];
  for (const page of pages) {
    const times = [...reference, ...outside].filter((listed) => listed === page).length;
    if (times === 0) {
      findings.push(`${page}: in neither list — classify it, as the user reference or not`);
    } else if (times > 1) {
      findings.push(`${page}: listed ${times} times, once expected`);
    }
  }
  return findings;
}

/** The Markdown pages at the top of the docs folder, as `docs/<name>.md`, read from the disk. */
function docsPagesOnDisk(): string[] {
  return readdirSync(join(REPO_ROOT, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `docs/${entry.name}`)
    .sort();
}

describe("what the guard of the user reference reports", () => {
  const clean = {
    "docs/api.md":
      "Base URL: `$SKRUN_URL`.\n\n```bash\ncurl -X POST $SKRUN_URL/api/agents/dev/a/run\n```\n",
    "docs/cli.md": `## Login\n\n${DEFAULT_SENTENCE} Then sign in.\n`,
    "docs/agent-yaml.md": "# agent.yaml\n",
    "docs/concepts.md": "# Concepts\n",
  };

  it("passes the reference when its only mention is the sentence of the CLI's default", () => {
    expect(localAddressFindings(clean)).toEqual([]);
  });

  it("reports a second localhost:4000 on the line of the sentence of the default", () => {
    const pages = {
      ...clean,
      "docs/cli.md": `## Login\n\n${DEFAULT_SENTENCE} Or try \`http://localhost:4000/health\`.\n`,
    };
    expect(localAddressFindings(pages)).toEqual(["docs/cli.md:3 localhost:4000"]);
  });

  it("reports the sentence of the default copied into another page of the reference", () => {
    const pages = { ...clean, "docs/concepts.md": `# Concepts\n\n${DEFAULT_SENTENCE}\n` };
    expect(localAddressFindings(pages)).toEqual(["docs/concepts.md:3 localhost:4000"]);
  });

  it("reports an example that names localhost:4000, in a code block too", () => {
    const pages = {
      ...clean,
      "docs/api.md": "```bash\ncurl -X POST http://localhost:4000/api/agents/dev/a/run\n```\n",
    };
    expect(localAddressFindings(pages)).toEqual(["docs/api.md:2 localhost:4000"]);
  });

  it("reports a page of the CLI that no longer states its default, or states it twice", () => {
    expect(localAddressFindings({ ...clean, "docs/cli.md": "## Login\n" })).toEqual([
      "docs/cli.md: the sentence of the CLI's default appears 0 times, once expected",
    ]);
    const twice = `${DEFAULT_SENTENCE}\n${DEFAULT_SENTENCE}\n`;
    expect(localAddressFindings({ ...clean, "docs/cli.md": twice })).toEqual([
      "docs/cli.md: the sentence of the CLI's default appears 2 times, once expected",
      "docs/cli.md:2 localhost:4000",
    ]);
  });
});

describe("what the classification of the pages of the docs folder reports", () => {
  const classified = [...REFERENCE, ...OUTSIDE_REFERENCE];

  it("passes the folder when each page is in one list, once", () => {
    expect(classificationFindings(classified, REFERENCE, OUTSIDE_REFERENCE)).toEqual([]);
  });

  it("reports a page of the folder that is in neither list, by name", () => {
    const pages = [...classified, "docs/notes.md"];
    expect(classificationFindings(pages, REFERENCE, OUTSIDE_REFERENCE)).toEqual([
      "docs/notes.md: in neither list — classify it, as the user reference or not",
    ]);
  });

  it("reports a page that is listed twice, by name", () => {
    const outside = [...OUTSIDE_REFERENCE, "docs/api.md"];
    expect(classificationFindings(classified, REFERENCE, outside)).toEqual([
      "docs/api.md: listed 2 times, once expected",
    ]);
  });
});

describe("the user reference, read on any host", () => {
  const pages = Object.fromEntries(
    REFERENCE.map((page) => [page, readFileSync(join(REPO_ROOT, ...page.split("/")), "utf-8")]),
  ) as Record<string, string>;

  it("reads each page of the reference, none of them empty", () => {
    expect(REFERENCE.filter((page) => (pages[page] ?? "").trim() === "")).toEqual([]);
  });

  it("names no localhost:4000, save the sentence of docs/cli.md that states the CLI's default", () => {
    expect(localAddressFindings(pages)).toEqual([]);
  });

  it("lists the pages of the docs folder from the disk, the pages of the reference among them", () => {
    const onDisk = docsPagesOnDisk();
    expect(REFERENCE.filter((page) => !onDisk.includes(page))).toEqual([]);
  });

  it("classifies each page of the docs folder by name, as the user reference or not", () => {
    expect(classificationFindings(docsPagesOnDisk(), REFERENCE, OUTSIDE_REFERENCE)).toEqual([]);
  });
});
