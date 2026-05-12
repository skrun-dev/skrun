// Bundle pages + theme CSS into kb.zip in SKRUN_OUTPUT_DIR.
//
// Input  (stdin JSON): { pages: [{ filename, title, body_html }], theme, site_title }
// Output (stdout JSON): { path, bytes, file_count }
//
// v0.2.0: switched from a hand-rolled STORE-method ZIP writer to `jszip`. The
// runtime resolves the dep via `package.json` automatically (#57). The output
// is functionally identical (zip extracts to the same files); deflate-default
// compression now produces slightly smaller archives than the prior STORE.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

// --- HTML envelope + theme CSS ---------------------------------------------
const THEMES: Record<
  string,
  { bg: string; fg: string; muted: string; link: string; nav_bg: string }
> = {
  light: { bg: "#ffffff", fg: "#1a1a1a", muted: "#666666", link: "#0366d6", nav_bg: "#f6f8fa" },
  dark: { bg: "#0d1117", fg: "#e6edf3", muted: "#8b949e", link: "#58a6ff", nav_bg: "#161b22" },
  sepia: { bg: "#f5efdc", fg: "#3c2f1f", muted: "#7a6649", link: "#9b4f1f", nav_bg: "#ebe1c5" },
};

function themeCss(themeName: string): string {
  const fallback = THEMES.light;
  if (!fallback) throw new Error("THEMES.light is missing");
  const t = THEMES[themeName] ?? fallback;
  return `:root{--bg:${t.bg};--fg:${t.fg};--muted:${t.muted};--link:${t.link};--nav-bg:${t.nav_bg}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.6}
nav{background:var(--nav-bg);padding:12px 24px;border-bottom:1px solid var(--muted);font-size:14px}
nav a{color:var(--fg);text-decoration:none;margin-right:16px}nav a:hover{color:var(--link)}
main{max-width:760px;margin:0 auto;padding:32px 24px}
h1{font-size:28px;margin-top:0}h2{font-size:22px;margin-top:32px}h3{font-size:18px}
a{color:var(--link)}p{margin:12px 0}ul{padding-left:24px}li{margin:4px 0}
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- Main ------------------------------------------------------------------
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
});

process.stdin.on("end", async () => {
  try {
    const args = JSON.parse(buf);
    const pages = args.pages;
    const theme: string = args.theme ?? "light";
    const siteTitle: string = args.site_title ?? "Knowledge Base";

    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error("pages must be a non-empty array");
    }
    for (const p of pages) {
      if (!p.filename || typeof p.filename !== "string" || !p.filename.endsWith(".html")) {
        throw new Error(`each page.filename must be a string ending in .html (got: ${p.filename})`);
      }
      if (p.filename.includes("..") || p.filename.startsWith("/") || p.filename.includes("\\")) {
        throw new Error(`page.filename must be a flat name (got: ${p.filename})`);
      }
    }
    if (!THEMES[theme]) {
      throw new Error(`unknown theme: ${theme} (allowed: ${Object.keys(THEMES).join(", ")})`);
    }

    const outputDir = process.env.SKRUN_OUTPUT_DIR;
    if (!outputDir) {
      throw new Error("SKRUN_OUTPUT_DIR is not set — runtime is responsible for providing this");
    }

    // Build the zip via jszip — replaces the ~95-line hand-rolled STORE-method
    // writer that v0.1.0 had to ship because Skrun couldn't resolve npm deps.
    const zip = new JSZip();
    let fileCount = 0;
    for (const p of pages as { filename: string; title: string; body_html: string }[]) {
      zip.file(p.filename, htmlEnvelope(p.title, siteTitle, p.body_html));
      fileCount++;
    }
    zip.file("theme.css", themeCss(theme));
    fileCount++;

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    mkdirSync(outputDir, { recursive: true });
    const fullPath = join(outputDir, "kb.zip");
    writeFileSync(fullPath, zipBuffer);

    process.stdout.write(
      JSON.stringify({ path: fullPath, bytes: zipBuffer.length, file_count: fileCount }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message }));
  }
});
