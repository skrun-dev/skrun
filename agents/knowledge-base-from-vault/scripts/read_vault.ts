// Scan a directory for `.md` files. Returns each note's path, slug, title,
// front-matter, headings, and internal links.
//
// Input  (stdin JSON): { vault_dir }
// Output (stdout JSON): { files: [{ path, slug, title, frontmatter, headings, internal_links, content_preview }] }

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

interface VaultFile {
  path: string;
  slug: string;
  title: string;
  frontmatter: Record<string, string>;
  headings: { level: number; text: string }[];
  internal_links: string[];
  content_preview: string;
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
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) fm[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: match[2]! };
}

function extractHeadings(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim() });
  }
  return out;
}

function extractInternalLinks(body: string): string[] {
  const out = new Set<string>();
  // [[wiki-style]] and [[wiki|alias]]
  for (const m of body.matchAll(/\[\[([^\]|\n]+?)(?:\|[^\]\n]*)?\]\]/g)) {
    out.add(m[1]!.trim());
  }
  // [text](url) — only relative .md links
  for (const m of body.matchAll(/\[([^\]\n]+?)\]\(([^)\n]+?\.md)(?:#[^)\n]*)?\)/g)) {
    out.add(m[2]!.replace(/\\/g, "/"));
  }
  return [...out];
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
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1].trim();
  return fallback.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
});

process.stdin.on("end", () => {
  try {
    const args = JSON.parse(buf);
    const vaultDir: string = args.vault_dir;

    if (!vaultDir || typeof vaultDir !== "string") {
      throw new Error("vault_dir is required and must be a string");
    }
    if (!existsSync(vaultDir)) {
      process.stdout.write(JSON.stringify({ files: [] }));
      return;
    }
    const s = statSync(vaultDir);
    if (!s.isDirectory()) {
      throw new Error(`vault_dir is not a directory: ${vaultDir}`);
    }

    const relPaths = walk(vaultDir).sort();
    const files: VaultFile[] = relPaths.map((rel) => {
      const full = join(vaultDir, rel);
      const raw = readFileSync(full, "utf-8");
      const { fm, body } = parseFrontmatter(raw);
      const slug = deriveSlug(rel);
      const title = deriveTitle(body, fm, basename(rel, ".md"));
      const headings = extractHeadings(body);
      const internalLinks = extractInternalLinks(body);
      const preview = body.slice(0, 280).replace(/\s+/g, " ").trim();
      return {
        path: rel,
        slug,
        title,
        frontmatter: fm,
        headings,
        internal_links: internalLinks,
        content_preview: preview,
      };
    });

    process.stdout.write(JSON.stringify({ files }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message, files: [] }));
  }
});
