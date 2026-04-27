// Scan a directory for existing ADR files (`NNNN-<slug>.md`).
// Input (stdin JSON): { adrs_dir }
// Output (stdout JSON): { adrs: [{ number, slug, title, status, filename }] }

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const ADR_FILE_REGEX = /^(\d{4})-([a-z0-9][a-z0-9-]*)\.md$/i;

interface AdrEntry {
  number: number;
  slug: string;
  title: string;
  status: string;
  filename: string;
}

function parseTitle(content: string, slug: string): string {
  // First H1 in the file. Strip leading "ADR-NNNN: " prefix if present.
  const h1 = content.match(/^#\s+(.+)$/m);
  if (!h1?.[1]) return slug;
  return h1[1].replace(/^ADR-\d+:\s*/i, "").trim();
}

function parseStatus(content: string): string {
  // Look for a "## Status" section and return the first non-empty line after it.
  const match = content.match(/^##\s+Status\s*$/im);
  if (!match || match.index === undefined) return "unknown";
  const after = content.slice(match.index + match[0].length);
  for (const line of after.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.toLowerCase();
  }
  return "unknown";
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
});

process.stdin.on("end", () => {
  try {
    const args = JSON.parse(buf);
    const adrsDir: string = args.adrs_dir;

    if (!adrsDir || typeof adrsDir !== "string") {
      throw new Error("adrs_dir is required and must be a string");
    }

    if (!existsSync(adrsDir)) {
      // Empty / non-existent directory is a valid "no ADRs yet" state.
      process.stdout.write(JSON.stringify({ adrs: [] }));
      return;
    }

    const stat = statSync(adrsDir);
    if (!stat.isDirectory()) {
      throw new Error(`adrs_dir is not a directory: ${adrsDir}`);
    }

    const adrs: AdrEntry[] = [];
    for (const entry of readdirSync(adrsDir)) {
      const match = ADR_FILE_REGEX.exec(basename(entry));
      if (!match) continue;
      const [, numStr, slug] = match;
      const filename = entry;
      const fullPath = join(adrsDir, filename);
      let content = "";
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }
      adrs.push({
        number: Number.parseInt(numStr!, 10),
        slug: slug!,
        title: parseTitle(content, slug!),
        status: parseStatus(content),
        filename,
      });
    }

    adrs.sort((a, b) => a.number - b.number);
    process.stdout.write(JSON.stringify({ adrs }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message, adrs: [] }));
  }
});
