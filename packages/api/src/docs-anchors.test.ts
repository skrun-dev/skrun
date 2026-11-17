import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import GithubSlugger from "github-slugger";
import { describe, expect, it } from "vitest";

/**
 * Every anchor link of the published docs resolves. A Markdown link
 * `[text](page.md#anchor)` or `[text](#anchor)` names a heading of the page it
 * points to — by the anchor GitHub gives that heading — or an explicit
 * `<a id="…">` of that page. A link that names neither drops its reader at the
 * top of the page, and nothing says so.
 *
 * What counts as a link: that inline syntax, outside fenced code blocks and
 * outside inline code — an anchor quoted between backticks is text, not a
 * link. A relative path resolves from the folder of the page that holds the
 * link. A link to these same pages on GitHub,
 * `https://github.com/skrun-dev/skrun/blob/main/<path>#<anchor>` — the form a
 * README published with a package uses, where a relative link would not
 * resolve — is read as the link `<path>#<anchor>` from the repository's root:
 * nothing is fetched. A link to any other site (`https://…`, any scheme) is
 * never followed nor read, another branch or another repository on GitHub
 * included.
 *
 * What counts as a target: an ATX heading (`#` to `######`) outside fenced
 * code blocks, slugged by github-slugger — the rule GitHub applies — with one
 * slugger per page, so a repeated heading gets `-1`, `-2` as it does there;
 * or an `<a id="…">` of the page.
 *
 * What it does not see: reference-style links (`[text][ref]` and
 * `[ref]: page.md#anchor`), autolinks, links written in HTML, and a link to a
 * page that is not Markdown. A heading underlined with `===` or `---` is not
 * read, and a heading is slugged from its Markdown text: a heading that holds
 * a link or an `_emphasis_` gets another anchor on GitHub — a link to it is
 * reported, never passed in silence.
 *
 * Sources — the pages published with the code: the README, the CHANGELOG and
 * the READMEs of the CLI and SDK packages; and, read from the disk, every
 * Markdown page at the top of the docs folder — the pages the guard of the
 * user reference classifies — and the README of every demo agent, so that a
 * page added there is read without a change to this test.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** This repository's pages on GitHub, as an absolute link names them. */
const REPO_ON_GITHUB = "https://github.com/skrun-dev/skrun/blob/main/";

/** The pages read whatever the folders hold, relative to the repository root. */
const FIXED_SOURCES = [
  "README.md",
  "CHANGELOG.md",
  "packages/cli/README.md",
  "packages/sdk/README.md",
] as const;

/** One entry of a folder: its name, and whether it is a file or a folder. */
interface FolderEntry {
  name: string;
  file: boolean;
  folder: boolean;
}

/** The entries of a folder of the repository, by its path from the root; none when there is none. */
type ListFolder = (folder: string) => FolderEntry[];

/**
 * The pages whose links are checked, relative to the repository root, among
 * what `list` shows: the fixed ones, each Markdown file at the top of `docs/`,
 * and the `README.md` of each folder of `agents/` that has one.
 */
function sourcesOf(list: ListFolder): string[] {
  const docs = list("docs")
    .filter((entry) => entry.file && entry.name.endsWith(".md"))
    .map((entry) => `docs/${entry.name}`)
    .sort();
  const agents = list("agents")
    .filter((entry) => entry.folder)
    .filter((entry) =>
      list(`agents/${entry.name}`).some((inside) => inside.file && inside.name === "README.md"),
    )
    .map((entry) => `agents/${entry.name}/README.md`)
    .sort();
  return [...FIXED_SOURCES, ...docs, ...agents];
}

/** A folder of the repository, read from the disk; none when it does not exist. */
function listOnDisk(folder: string): FolderEntry[] {
  const dir = join(REPO_ROOT, ...folder.split("/"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    file: entry.isFile(),
    folder: entry.isDirectory(),
  }));
}

/** One line of a page, read outside fenced code blocks, with its number. */
interface ProseLine {
  text: string;
  line: number;
}

/**
 * The lines of a Markdown document outside fenced code blocks: a `# comment`
 * in a bash example is not a heading, a link in an example is not a link.
 */
function linesOutsideFences(markdown: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let fence: string | undefined;
  markdown.split(/\r?\n/).forEach((text, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) fence = marker;
      else lines.push({ text, line: i + 1 });
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      text.trim() === marker
    ) {
      fence = undefined;
    }
  });
  return lines;
}

/** The anchors of a page: each heading's slug, in order, and each `<a id="…">`. */
function anchorsOf(markdown: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  for (const { text } of linesOutsideFences(markdown)) {
    const heading = /^#{1,6} (.*)$/.exec(text)?.[1];
    if (heading !== undefined) {
      anchors.add(slugger.slug(heading.replace(/\s+#+\s*$/, "").trim()));
    }
    for (const match of text.matchAll(/<a\s+id="([^"]+)"/g)) anchors.add(match[1] as string);
  }
  return anchors;
}

/** A line with its inline code spans taken out: what is quoted there is text. */
function withoutInlineCode(text: string): string {
  return text.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
}

/** One anchor link: where it is written, and the page and anchor it names. */
interface AnchorLink {
  source: string;
  line: number;
  href: string;
  /** The page it points to, relative to the repository root. */
  page: string;
  anchor: string;
  /** Written as a link to this repository's pages on GitHub. */
  onGitHub: boolean;
}

/** The anchor links of a page; `source` is its path relative to the repository root. */
function anchorLinksOf(source: string, markdown: string): AnchorLink[] {
  const links: AnchorLink[] = [];
  for (const { text, line } of linesOutsideFences(markdown)) {
    for (const match of withoutInlineCode(text).matchAll(
      /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    )) {
      const href = match[1] as string;
      const onGitHub = href.startsWith(REPO_ON_GITHUB);
      if (!onGitHub && /^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // another site: never followed
      // On GitHub, the path after the branch is the page's path from the repository's root.
      const target = onGitHub ? href.slice(REPO_ON_GITHUB.length) : href;
      const hash = target.indexOf("#");
      if (hash === -1) continue;
      const path = target.slice(0, hash);
      if ((onGitHub || path !== "") && !path.endsWith(".md")) continue;
      const page = onGitHub
        ? posix.normalize(path)
        : path === ""
          ? source
          : posix.normalize(posix.join(posix.dirname(source), path));
      links.push({
        source,
        line,
        href,
        page,
        anchor: decodeAnchor(target.slice(hash + 1)),
        onGitHub,
      });
    }
  }
  return links;
}

/** The anchor as a browser matches it: percent-escapes decoded, when they decode. */
function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}

/**
 * The links of `sources` whose anchor names nothing in the page they point
 * to, as `<source>:<line> <href>` — and why, when the page itself is missing.
 * `read` gives a page's text by its path, or undefined when there is none.
 */
function deadLinks(
  sources: Readonly<Record<string, string>>,
  read: (page: string) => string | undefined,
): string[] {
  const anchorsByPage = new Map<string, Set<string> | undefined>();
  const anchors = (page: string): Set<string> | undefined => {
    if (!anchorsByPage.has(page)) {
      const text = read(page);
      anchorsByPage.set(page, text === undefined ? undefined : anchorsOf(text));
    }
    return anchorsByPage.get(page);
  };
  const dead: string[] = [];
  for (const [source, markdown] of Object.entries(sources)) {
    for (const link of anchorLinksOf(source, markdown)) {
      const found = anchors(link.page);
      if (found === undefined)
        dead.push(`${link.source}:${link.line} ${link.href} (no page ${link.page})`);
      else if (!found.has(link.anchor)) dead.push(`${link.source}:${link.line} ${link.href}`);
    }
  }
  return dead;
}

/** A page of the repository by its path, or undefined when there is none. */
function readPage(page: string): string | undefined {
  const file = join(REPO_ROOT, ...page.split("/"));
  return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
}

/** A folder listing written by hand, for the cases in memory. */
function listing(folders: Readonly<Record<string, readonly string[]>>): ListFolder {
  return (folder) =>
    (folders[folder] ?? []).map((name) =>
      name.endsWith("/")
        ? { name: name.slice(0, -1), file: false, folder: true }
        : { name, file: true, folder: false },
    );
}

describe("what the anchor check counts as a link, and as a target", () => {
  it("reports the one dead link of two pages, and passes the live one, one written with percent-escapes, the quoted anchor and the example", () => {
    const pages: Record<string, string> = {
      "docs/guide.md": [
        "# Guide",
        "",
        "See [the setup](other.md#setup) first, then [the cleanup](other.md#cleanup).",
        "An anchor written as a browser sends it, [the café](other.md#caf%C3%A9), names its heading.",
        "An anchor quoted as text, `[gone](other.md#nowhere)`, is not a link.",
        "",
        "```markdown",
        "[an example](other.md#not-a-heading)",
        "```",
      ].join("\n"),
      "docs/other.md": ["# Other", "", "## Setup", "", "## Café", "", "Text."].join("\n"),
    };
    const sources = { "docs/guide.md": pages["docs/guide.md"] as string };

    expect(deadLinks(sources, (page) => pages[page])).toEqual(["docs/guide.md:3 other.md#cleanup"]);
  });

  it("slugs like GitHub — a repeated heading takes -1 then -2, an <a id> is a target, a link to the same page resolves there", () => {
    const page = [
      "# Notes",
      '<a id="kept-name"></a>',
      "## Example",
      "## Example",
      "## Example",
      "",
      "[one](#example) [two](#example-1) [three](#example-2) [four](#example-3) [kept](#kept-name)",
      "[elsewhere](https://example.com/page.md#nothing) [no anchor](notes.md)",
    ].join("\n");

    expect(deadLinks({ "notes.md": page }, (p) => (p === "notes.md" ? page : undefined))).toEqual([
      "notes.md:7 #example-3",
    ]);
  });

  it("reads a link to these pages on GitHub as the link to the page from the repository's root, and follows no other branch nor repository", () => {
    const github = "https://github.com/skrun-dev/skrun/blob/main/docs/other.md";
    const pages: Record<string, string> = {
      "packages/cli/README.md": [
        "# CLI",
        "",
        `See [the setup](${github}#setup), then [the cleanup](${github}#cleanup).`,
        "Not these pages: [a branch](https://github.com/skrun-dev/skrun/blob/next/docs/other.md#nothing),",
        "[a fork](https://github.com/someone/skrun/blob/main/docs/other.md#nothing).",
        "[A page since removed](https://github.com/skrun-dev/skrun/blob/main/docs/gone.md#top).",
      ].join("\n"),
      "docs/other.md": ["# Other", "", "## Setup"].join("\n"),
    };
    const sources = { "packages/cli/README.md": pages["packages/cli/README.md"] as string };

    expect(deadLinks(sources, (page) => pages[page])).toEqual([
      `packages/cli/README.md:3 ${github}#cleanup`,
      "packages/cli/README.md:6 https://github.com/skrun-dev/skrun/blob/main/docs/gone.md#top (no page docs/gone.md)",
    ]);
  });

  it("names a link to a page that does not exist", () => {
    expect(deadLinks({ "docs/a.md": "[x](../missing.md#top)" }, () => undefined)).toEqual([
      "docs/a.md:1 ../missing.md#top (no page missing.md)",
    ]);
  });

  it("gives our own headings the anchors GitHub gives them: an emoji, a route, a variable name", () => {
    // Looked up in every page read, wherever the heading lives.
    const anchors = new Set(
      sourcesOf(listOnDisk).flatMap((source) => [...anchorsOf(readPage(source) ?? "")]),
    );
    const witnesses = [
      "-features",
      "get-apifilesid--file-metadata",
      "runtime-selection-skrun_runtime",
    ];
    expect(witnesses.filter((anchor) => !anchors.has(anchor))).toEqual([]);
  });
});

describe("which pages the anchor check reads", () => {
  it("reads each Markdown file at the top of the docs folder, one added later included, and nothing else there", () => {
    const list = listing({
      docs: ["api.md", "notes.md", "diagram.png", "assets/"],
      "docs/assets": ["deep.md"],
    });
    expect(sourcesOf(list).filter((source) => source.startsWith("docs/"))).toEqual([
      "docs/api.md",
      "docs/notes.md",
    ]);
  });

  it("reads the README of each demo agent that has one, an agent added later included", () => {
    const list = listing({
      agents: ["seo-audit/", "new-agent/", "no-readme/", "README.md"],
      "agents/seo-audit": ["README.md", "agent.yaml"],
      "agents/new-agent": ["README.md", "SKILL.md"],
      "agents/no-readme": ["agent.yaml"],
    });
    expect(sourcesOf(list).filter((source) => source.startsWith("agents/"))).toEqual([
      "agents/new-agent/README.md",
      "agents/seo-audit/README.md",
    ]);
  });
});

describe("the anchor links of the published docs", () => {
  const sources = Object.fromEntries(
    sourcesOf(listOnDisk).map((source) => [source, readPage(source) ?? ""]),
  ) as Record<string, string>;

  it("finds every page it reads — pages of the docs folder and demo agents' READMEs among them — and links of the three forms in them", () => {
    const read = Object.keys(sources);
    expect(read.filter((source) => readPage(source) === undefined)).toEqual([]);
    expect(read.some((source) => /^docs\/[^/]+\.md$/.test(source))).toBe(true);
    expect(read.some((source) => /^agents\/[^/]+\/README\.md$/.test(source))).toBe(true);
    const links = Object.entries(sources).flatMap(([source, text]) => anchorLinksOf(source, text));
    expect(links.some((link) => link.page === link.source)).toBe(true);
    expect(links.some((link) => link.page !== link.source && !link.onGitHub)).toBe(true);
    expect(links.some((link) => link.onGitHub)).toBe(true);
  });

  it("each names a heading or an <a id> of the page it points to", () => {
    expect(deadLinks(sources, readPage)).toEqual([]);
  });
});
