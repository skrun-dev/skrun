// Build the whole knowledge base in one call: read every `.md` note of the
// vault, render one HTML page per note plus `index.html`, bundle them with the
// theme stylesheet as `kb.zip` in SKRUN_OUTPUT_DIR, merge this run's concepts
// into the concept graph carried across runs, and return every count the agent
// reports. The model passes the run's input and copies this result: nothing it
// answers is written or counted by the model itself.
//
// Input  (stdin JSON): { vault_dir, site_title?, theme?, previous_state? }
// Output (stdout JSON): { site_zip_path, pages_count, concept_count, link_count,
//   runs_processed, file_count, bytes, _state } — or { error } when nothing was built.
//
// - pages_count:    the HTML pages in the zip, read back from it: the notes + the
//                   index (a build short of a page is an error, never a count).
// - file_count:     the files in the zip, the pages plus `theme.css`.
// - link_count:     internal links that resolve to a note of the vault, counted
//                   per occurrence across all notes (code excluded).
// - concept_count:  distinct concepts in the graph after this run.
// - runs_processed: the previous state's value + 1.
// - _state:         { runs_processed, concepts: [{ id, label, count,
//                   first_seen_run, last_seen_run }] } — the next run's previous_state.
//                   A previous state of the 0.2 shape ({ concept_graph: { id: {...} } })
//                   is read too.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, posix, relative } from "node:path";
import JSZip from "jszip";

// --- Vault -----------------------------------------------------------------
interface Note {
  /** Path relative to the vault, forward slashes: `concepts/event-sourcing.md`. */
  path: string;
  /** `path` without `.md`, lower-cased — what a relative link resolves to. */
  key: string;
  /** File name without `.md`, lower-cased — what a `[[wiki]]` link names. */
  base: string;
  /** Flat page name in the zip: `concepts-event-sourcing.html`. */
  page: string;
  title: string;
  /** The Markdown without its front-matter. */
  body: string;
}

interface Vault {
  notes: Note[];
  byKey: Map<string, Note>;
  byBase: Map<string, Note>;
  byTitle: Map<string, Note>;
  bySlug: Map<string, Note>;
}

function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walk(full, base));
    } else if (extname(entry).toLowerCase() === ".md") {
      out.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m?.[1]) fm[m[1]] = m[2]?.trim().replace(/^["']|["']$/g, "") ?? "";
  }
  return { fm, body: match[2] ?? "" };
}

function deriveSlug(relPath: string): string {
  return relPath
    .replace(/\.md$/i, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function deriveTitle(body: string, fm: Record<string, string>, fallback: string): string {
  if (fm.title) return fm.title;
  const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  if (h1?.[1]) return h1[1].trim();
  return fallback.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function readVault(vaultDir: string): Vault {
  const vault: Vault = {
    notes: [],
    byKey: new Map(),
    byBase: new Map(),
    byTitle: new Map(),
    bySlug: new Map(),
  };
  // `index` is the site's own landing page: a note of that name gets another.
  const taken = new Set<string>(["index"]);
  for (const rel of walk(vaultDir).sort()) {
    const { fm, body } = parseFrontmatter(readFileSync(join(vaultDir, rel), "utf-8"));
    const fileBase = basename(rel, extname(rel));
    let slug = deriveSlug(rel) || "note";
    for (let n = 2; taken.has(slug); n++) slug = `${deriveSlug(rel) || "note"}-${n}`;
    taken.add(slug);
    const note: Note = {
      path: rel,
      key: rel.replace(/\.md$/i, "").toLowerCase(),
      base: fileBase.toLowerCase(),
      page: `${slug}.html`,
      title: deriveTitle(body, fm, fileBase),
      body,
    };
    vault.notes.push(note);
    vault.byKey.set(note.key, note);
    if (!vault.byBase.has(note.base)) vault.byBase.set(note.base, note);
    if (!vault.byTitle.has(note.title.toLowerCase()))
      vault.byTitle.set(note.title.toLowerCase(), note);
    vault.bySlug.set(slug, note);
  }
  return vault;
}

// --- Links -----------------------------------------------------------------
/** `[[target]]`: by path, then file name, then title, then slug — as Obsidian finds a note. */
function resolveWiki(target: string, vault: Vault): Note | undefined {
  const t = target.trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
  if (!t) return undefined;
  return (
    vault.byKey.get(t) ??
    vault.byBase.get(t.slice(t.lastIndexOf("/") + 1)) ??
    vault.byTitle.get(t) ??
    vault.bySlug.get(deriveSlug(t))
  );
}

/** `[text](../other.md)`: relative to the linking note, or to the vault root when it starts with `/`. */
function resolveRelative(href: string, from: Note, vault: Vault): Note | undefined {
  const dir = posix.dirname(from.path);
  const joined = href.startsWith("/") ? href.slice(1) : posix.join(dir === "." ? "" : dir, href);
  const norm = posix.normalize(joined);
  if (norm.startsWith("../")) return undefined;
  const withExt = /\.md$/i.test(norm) ? norm : `${norm}.md`;
  return vault.byKey.get(withExt.replace(/\.md$/i, "").toLowerCase());
}

// --- Concepts --------------------------------------------------------------
const MAX_CONCEPTS_PER_NOTE = 7;
const GENERIC_CONCEPTS = new Set([
  "see-also",
  "related",
  "introduction",
  "intro",
  "overview",
  "summary",
  "references",
  "notes",
  "contents",
  "table-of-contents",
  "steps",
  "prerequisites",
  "faq",
  "example",
  "examples",
  "conclusion",
  "background",
  "next-steps",
  "todo",
  "glossary",
  "concepts",
]);
const STOPWORDS = new Set(
  "the and for with from this that these those into onto your you our its are was were why how what when where who not use all any but can has have had one two via per out off own".split(
    " ",
  ),
);

/** Kebab-case id of a concept; keeps letters of every script. */
function conceptId(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** The words of a heading or a bold term, without Markdown and trailing punctuation. */
function plainLabel(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/[\s:;,.!?]+$/g, "")
    .trim();
}

interface Candidate {
  id: string;
  label: string;
}

const QUESTION_WORDS = new Set(["why", "how", "what", "when", "where", "who", "which"]);

/**
 * A concept from a link target, a heading or a bold term — or null when it is
 * too short, too long, generic, only stopwords, a heading phrased as a question
 * ("Why use it"), or a single lower-case bold word (emphasis, not a term).
 */
function asCandidate(label: string, kind: "link" | "heading" | "bold"): Candidate | null {
  const clean = plainLabel(label);
  const id = conceptId(clean);
  if (id.length < 3 || clean.length > 60 || GENERIC_CONCEPTS.has(id)) return null;
  const words = id.split("-");
  if (words.length > 5) return null;
  if (words.every((w) => w.length < 3 || STOPWORDS.has(w))) return null;
  if (kind === "heading" && QUESTION_WORDS.has(words[0] ?? "")) return null;
  if (kind === "bold" && words.length === 1 && clean === clean.toLowerCase()) return null;
  return { id, label: clean };
}

// --- Markdown → HTML -------------------------------------------------------
interface RenderContext {
  vault: Vault;
  from: Note;
  /** Internal links of this note that resolved, per occurrence. */
  links: number;
  /** Notes this note links to (its backlinks' source). */
  targets: Set<Note>;
  wikiConcepts: Candidate[];
  headingConcepts: Candidate[];
  boldConcepts: Candidate[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?![_\w])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([^~]+?)~~/g, "<del>$1</del>");
}

// Code spans, wiki links (and embeds), images, Markdown links, autolinks.
const INLINE_TOKEN =
  /`([^`\n]+)`|!?\[\[([^\]\n]+?)\]\]|!\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^>\s]+)>/g;

function wikiLink(inner: string, ctx: RenderContext): string {
  const [targetPart = "", alias] = inner.split("|");
  const [notePart = "", heading] = targetPart.split("#");
  const shown = (alias ?? (notePart || heading || inner)).trim();
  const anchor = heading ? `#${conceptId(heading)}` : "";
  if (!notePart.trim()) {
    return heading ? `<a href="${anchor}">${escapeHtml(shown)}</a>` : escapeHtml(shown);
  }
  const note = resolveWiki(notePart, ctx.vault);
  if (!note) {
    const unresolved = asCandidate(notePart, "link");
    if (unresolved) ctx.wikiConcepts.push(unresolved);
    return `<code>[[${escapeHtml(inner)}]]</code>`;
  }
  ctx.links++;
  if (note !== ctx.from) ctx.targets.add(note);
  const concept = asCandidate(note.title, "link");
  if (concept) ctx.wikiConcepts.push(concept);
  return `<a href="${escapeHtml(note.page + anchor)}">${escapeHtml(shown)}</a>`;
}

/** `decodeURIComponent`, or the text as written when its escapes are malformed. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function markdownLink(text: string, rawHref: string, ctx: RenderContext): string {
  const shown = emphasis(escapeHtml(text));
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref)) {
    return /^(https?|mailto):/i.test(rawHref)
      ? `<a href="${escapeHtml(rawHref)}">${shown}</a>`
      : shown;
  }
  if (rawHref.startsWith("#")) return `<a href="${escapeHtml(rawHref)}">${shown}</a>`;
  // Editors write `[x](my%20note.md#Part%20Two)`: both parts are decoded.
  const hashAt = rawHref.indexOf("#");
  const pathPart = (hashAt >= 0 ? rawHref.slice(0, hashAt) : rawHref).split("?")[0] ?? "";
  const fragment = hashAt >= 0 ? `#${conceptId(safeDecode(rawHref.slice(hashAt + 1)))}` : "";
  const decoded = safeDecode(pathPart);
  const isNoteLink = /\.md$/i.test(decoded) || !/\.[a-z0-9]+$/i.test(decoded);
  if (!isNoteLink) return shown; // an attachment the site does not carry
  const note = resolveRelative(decoded, ctx.from, ctx.vault);
  if (!note) return `<code>${shown}</code>`;
  ctx.links++;
  if (note !== ctx.from) ctx.targets.add(note);
  return `<a href="${escapeHtml(note.page + fragment)}">${shown}</a>`;
}

// Placeholders of the inline tokens: two private-use characters, U+E000 and U+E001.
const HOLD_OPEN = String.fromCharCode(0xe000);
const HOLD_CLOSE = String.fromCharCode(0xe001);
const HOLD_CHARS = new RegExp(`[${HOLD_OPEN}${HOLD_CLOSE}]`, "g");
const HOLD_TOKEN = new RegExp(`${HOLD_OPEN}([0-9]+)${HOLD_CLOSE}`, "g");

function inline(raw: string, ctx: RenderContext): string {
  // Bold terms, outside code, are concept candidates.
  for (const m of raw.replace(/`[^`\n]+`/g, "").matchAll(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g)) {
    const c = asCandidate(m[1] ?? m[2] ?? "", "bold");
    if (c) ctx.boldConcepts.push(c);
  }
  // Tokens become placeholders (two private-use characters, removed from the
  // note first), the rest is escaped, emphasis applies to the whole line (so
  // `**[a link](x.md)**` is bold), then the tokens come back.
  const tokens: string[] = [];
  const hold = (html: string): string => `${HOLD_OPEN}${tokens.push(html) - 1}${HOLD_CLOSE}`;
  const text = raw
    .replace(HOLD_CHARS, "")
    .replace(INLINE_TOKEN, (_all, code, wiki, imgAlt, _imgSrc, linkText, linkHref, auto) => {
      if (code !== undefined) return hold(`<code>${escapeHtml(code)}</code>`);
      if (wiki !== undefined) return hold(wikiLink(wiki, ctx));
      if (imgAlt !== undefined) return hold(escapeHtml(imgAlt));
      if (linkText !== undefined) return hold(markdownLink(linkText, linkHref, ctx));
      return hold(`<a href="${escapeHtml(auto)}">${escapeHtml(auto)}</a>`);
    });
  return emphasis(escapeHtml(text)).replace(HOLD_TOKEN, (_m, i: string) => tokens[Number(i)] ?? "");
}

/**
 * Block-level Markdown: front-matter already stripped; headings, paragraphs,
 * `-`/`*`/`+` and numbered lists (one level), block quotes, rules and fenced
 * code. Anything else is rendered as paragraph text, escaped.
 */
function renderMarkdown(body: string, ctx: RenderContext): { html: string; hasH1: boolean } {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  const headingIds = new Map<string, number>();
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];
  let hasH1 = false;

  const flushPara = (): void => {
    if (para.length > 0) out.push(`<p>${inline(para.join(" "), ctx)}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map((item) => `<li>${inline(item, ctx)}</li>`).join("");
      out.push(`<${list.tag}>${items}</${list.tag}>`);
    }
    list = null;
  };
  const flushQuote = (): void => {
    if (quote.length > 0)
      out.push(`<blockquote><p>${inline(quote.join(" "), ctx)}</p></blockquote>`);
    quote = [];
  };
  const flushAll = (): void => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      flushAll();
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(marker); i++) {
        code.push(lines[i] ?? "");
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      if (level === 1) hasH1 = true;
      if (level === 2 || level === 3) {
        const c = asCandidate(text, "heading");
        if (c) ctx.headingConcepts.push(c);
      }
      const baseId = conceptId(plainLabel(text)) || "section";
      const seen = headingIds.get(baseId) ?? 0;
      headingIds.set(baseId, seen + 1);
      const id = seen === 0 ? baseId : `${baseId}-${seen + 1}`;
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(text, ctx)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1] ?? "");
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const item = bullet ?? numbered;
    if (item) {
      flushPara();
      flushQuote();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(item[1] ?? "");
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // An indented line continues the list item above it.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return { html: out.join("\n"), hasH1 };
}

// --- Concept graph ---------------------------------------------------------
interface ConceptEntry {
  id: string;
  label: string;
  count: number;
  first_seen_run: string;
  last_seen_run: string;
}

interface PreviousState {
  runs: number;
  concepts: Map<string, ConceptEntry>;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** Read the previous state leniently: an unreadable entry is skipped, never fatal. */
function readPreviousState(raw: unknown, today: string): PreviousState {
  const state: PreviousState = { runs: 0, concepts: new Map() };
  if (!raw || typeof raw !== "object") return state;
  const prev = raw as Record<string, unknown>;
  state.runs = nonNegative(prev.runs_processed);
  const add = (id: string, entry: Record<string, unknown>): void => {
    const key = conceptId(id);
    if (!key) return;
    const first = text(entry.first_seen_run, today);
    state.concepts.set(key, {
      id: key,
      label: text(entry.label, id),
      count: Math.max(1, nonNegative(entry.count)),
      first_seen_run: first,
      last_seen_run: text(entry.last_seen_run, first),
    });
  };
  if (Array.isArray(prev.concepts)) {
    for (const entry of prev.concepts) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e.id === "string") add(e.id, e);
      }
    }
  }
  // The 0.2 shape: { concept_graph: { "event-sourcing": { count, first_seen_run, … } } }.
  if (prev.concept_graph && typeof prev.concept_graph === "object") {
    for (const [id, entry] of Object.entries(prev.concept_graph as Record<string, unknown>)) {
      if (!state.concepts.has(conceptId(id))) {
        add(id, entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {});
      }
    }
  }
  return state;
}

// --- Site ------------------------------------------------------------------
const THEMES: Record<
  string,
  { bg: string; fg: string; muted: string; link: string; nav_bg: string }
> = {
  light: { bg: "#ffffff", fg: "#1a1a1a", muted: "#666666", link: "#0366d6", nav_bg: "#f6f8fa" },
  dark: { bg: "#0d1117", fg: "#e6edf3", muted: "#8b949e", link: "#58a6ff", nav_bg: "#161b22" },
  sepia: { bg: "#f5efdc", fg: "#3c2f1f", muted: "#7a6649", link: "#9b4f1f", nav_bg: "#ebe1c5" },
};

/** The theme of a call that names none. */
const DEFAULT_THEME = "light";
const DEFAULT_SITE_TITLE = "Knowledge Base";

function themeCss(themeName: string): string {
  const t = THEMES[themeName] ?? THEMES[DEFAULT_THEME];
  if (!t) throw new Error(`THEMES.${DEFAULT_THEME} is missing`);
  return `:root{--bg:${t.bg};--fg:${t.fg};--muted:${t.muted};--link:${t.link};--nav-bg:${t.nav_bg}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.6}
nav{background:var(--nav-bg);padding:12px 24px;border-bottom:1px solid var(--muted);font-size:14px}
nav a{color:var(--fg);text-decoration:none;margin-right:16px}nav a:hover{color:var(--link)}
main{max-width:760px;margin:0 auto;padding:32px 24px}
h1{font-size:28px;margin-top:0}h2{font-size:22px;margin-top:32px}h3{font-size:18px}
a{color:var(--link)}p{margin:12px 0}ul,ol{padding-left:24px}li{margin:4px 0}
blockquote{margin:12px 0;padding-left:16px;border-left:3px solid var(--muted);color:var(--muted)}
code{background:var(--nav-bg);padding:2px 6px;border-radius:4px;font-size:0.9em}
pre{background:var(--nav-bg);padding:16px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
.muted{color:var(--muted);font-size:13px}
.badge{display:inline-block;background:var(--nav-bg);color:var(--muted);padding:0 6px;border-radius:10px;font-size:12px;margin-left:6px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--muted);color:var(--muted);font-size:13px}`;
}

function htmlEnvelope(title: string, siteTitle: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(siteTitle)}</title>
<link rel="stylesheet" href="theme.css">
</head>
<body>
<nav><a href="index.html">${escapeHtml(siteTitle)}</a><span class="muted">·</span> <a href="index.html#all-notes">All notes</a> <a href="index.html#concepts">Concepts</a></nav>
<main>${body}</main>
</body>
</html>`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- Main ------------------------------------------------------------------
async function build(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const vaultDir = args.vault_dir;
  if (typeof vaultDir !== "string" || vaultDir.trim() === "") {
    throw new Error("vault_dir is required and must be a non-empty string");
  }
  if (!existsSync(vaultDir)) throw new Error(`vault_dir not found: ${vaultDir}`);
  if (!statSync(vaultDir).isDirectory())
    throw new Error(`vault_dir is not a directory: ${vaultDir}`);
  const siteTitle = text(args.site_title, DEFAULT_SITE_TITLE).trim();
  const theme = text(args.theme, DEFAULT_THEME).trim().toLowerCase();
  if (!THEMES[theme]) {
    throw new Error(`unknown theme: ${theme} (allowed: ${Object.keys(THEMES).join(", ")})`);
  }
  const outputDir = process.env.SKRUN_OUTPUT_DIR;
  if (!outputDir) {
    throw new Error("SKRUN_OUTPUT_DIR is not set — runtime is responsible for providing this");
  }

  const today = new Date().toISOString().slice(0, 10);
  const vault = readVault(vaultDir);

  // One page per note, its concepts and its outgoing links.
  let linkCount = 0;
  const rendered = new Map<Note, string>();
  const backlinks = new Map<Note, Note[]>();
  const runConcepts = new Map<string, { label: string; notes: Note[] }>();
  for (const note of vault.notes) {
    const ctx: RenderContext = {
      vault,
      from: note,
      links: 0,
      targets: new Set(),
      wikiConcepts: [],
      headingConcepts: [],
      boldConcepts: [],
    };
    const { html, hasH1 } = renderMarkdown(note.body, ctx);
    rendered.set(note, hasH1 ? html : `<h1>${escapeHtml(note.title)}</h1>\n${html}`);
    linkCount += ctx.links;
    for (const target of ctx.targets) {
      const list = backlinks.get(target) ?? [];
      list.push(note);
      backlinks.set(target, list);
    }
    // Explicit links first, then the note's structure, then what it stresses.
    const picked = new Map<string, string>();
    for (const c of [...ctx.wikiConcepts, ...ctx.headingConcepts, ...ctx.boldConcepts]) {
      if (picked.size >= MAX_CONCEPTS_PER_NOTE) break;
      if (!picked.has(c.id)) picked.set(c.id, c.label);
    }
    for (const [id, label] of picked) {
      const entry = runConcepts.get(id) ?? { label, notes: [] };
      entry.notes.push(note);
      runConcepts.set(id, entry);
    }
  }

  // Merge this run's concepts into the graph: each one seen counts once per run.
  const previous = readPreviousState(args.previous_state, today);
  const graph = previous.concepts;
  for (const [id, { label }] of runConcepts) {
    const known = graph.get(id);
    if (known) {
      known.count += 1;
      known.last_seen_run = today;
      if (known.label === known.id) known.label = label;
    } else {
      graph.set(id, { id, label, count: 1, first_seen_run: today, last_seen_run: today });
    }
  }
  const runsProcessed = previous.runs + 1;
  const byCount = (a: ConceptEntry, b: ConceptEntry): number =>
    b.count - a.count || a.label.localeCompare(b.label);
  const concepts = [...graph.values()].sort(byCount);
  const pagesCount = vault.notes.length + 1;

  // The index: every note, the concepts of this run ranked by the graph, the stats.
  const index: string[] = [`<h1>${escapeHtml(siteTitle)}</h1>`];
  if (vault.notes.length === 0) {
    index.push("<p>No notes yet — drop a <code>.md</code> file in the vault directory.</p>");
  } else {
    index.push(
      `<p>${plural(vault.notes.length, "note", "notes")} from this vault, ${plural(linkCount, "internal link", "internal links")} between them.</p>`,
    );
  }
  index.push('<h2 id="all-notes">All notes</h2>');
  index.push(
    vault.notes.length === 0
      ? '<p class="muted">None.</p>'
      : `<ul>${vault.notes
          .map(
            (n) =>
              `<li><a href="${escapeHtml(n.page)}">${escapeHtml(n.title)}</a> <span class="muted">${escapeHtml(n.path)}</span></li>`,
          )
          .join("")}</ul>`,
  );
  index.push('<h2 id="concepts">Concept index</h2>');
  const seenNow = concepts.filter((c) => runConcepts.has(c.id));
  index.push(
    seenNow.length === 0
      ? '<p class="muted">No concepts found in this vault.</p>'
      : `<ul>${seenNow
          .map((c) => {
            const pages = (runConcepts.get(c.id)?.notes ?? [])
              .map((n) => `<a href="${escapeHtml(n.page)}">${escapeHtml(n.title)}</a>`)
              .join(", ");
            return `<li id="concept-${escapeHtml(c.id)}">${escapeHtml(c.label)}<span class="badge">${plural(c.count, "run", "runs")}</span> — ${pages}</li>`;
          })
          .join("")}</ul>`,
  );
  const earlier = concepts.filter((c) => !runConcepts.has(c.id)).slice(0, 20);
  if (earlier.length > 0) {
    index.push(
      `<p class="muted">Also in the concept graph, from earlier runs: ${earlier
        .map((c) => `${escapeHtml(c.label)} (${plural(c.count, "run", "runs")})`)
        .join(", ")}.</p>`,
    );
  }
  index.push(
    `<footer>${plural(pagesCount, "page", "pages")} · ${plural(concepts.length, "concept", "concepts")} in the graph · ${plural(linkCount, "internal link", "internal links")} · run ${runsProcessed}</footer>`,
  );

  // The zip: the index, one page per note, the stylesheet.
  const zip = new JSZip();
  zip.file("index.html", htmlEnvelope(siteTitle, siteTitle, index.join("\n")));
  for (const note of vault.notes) {
    let body = rendered.get(note) ?? "";
    const from = backlinks.get(note) ?? [];
    if (from.length > 0) {
      body += `\n<h2 id="backlinks">Backlinks</h2><ul>${from
        .map((n) => `<li><a href="${escapeHtml(n.page)}">${escapeHtml(n.title)}</a></li>`)
        .join("")}</ul>`;
    }
    zip.file(note.page, htmlEnvelope(note.title, siteTitle, body));
  }
  zip.file("theme.css", themeCss(theme));
  // The counts are read back from the zip: a site that lacks a page is never reported.
  const files = Object.values(zip.files).filter((f) => !f.dir);
  const pagesBuilt = files.filter((f) => f.name.endsWith(".html")).length;
  if (pagesBuilt !== pagesCount) {
    throw new Error(`built ${pagesBuilt} pages for ${vault.notes.length} notes and the index`);
  }
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  mkdirSync(outputDir, { recursive: true });
  const zipPath = join(outputDir, "kb.zip");
  writeFileSync(zipPath, zipBuffer);

  return {
    site_zip_path: zipPath,
    pages_count: pagesBuilt,
    concept_count: concepts.length,
    link_count: linkCount,
    runs_processed: runsProcessed,
    file_count: files.length,
    bytes: zipBuffer.length,
    _state: { runs_processed: runsProcessed, concepts },
  };
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
});

process.stdin.on("end", async () => {
  try {
    const args = JSON.parse(buf || "{}");
    process.stdout.write(JSON.stringify(await build(args)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message }));
  }
});
