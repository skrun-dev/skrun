// Bundle pages + theme CSS into kb.zip in SKRUN_OUTPUT_DIR.
//
// Input  (stdin JSON): { pages: [{ filename, title, body_html }], theme, site_title }
// Output (stdout JSON): { path, bytes, file_count }
//
// ZIP STORE method (uncompressed) implemented manually — agent bundles can't ship
// node_modules, so we avoid the JSZip dependency.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- Tiny CRC-32 (table-based) ---------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- ZIP writer (STORE method) ---------------------------------------------
interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  offset: number;
}

function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const crc = crc32(f.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // gp bit flag
    localHeader.writeUInt16LE(0, 8); // STORE method
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (Jan 1 1980)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(f.data.length, 18); // compressed size
    localHeader.writeUInt32LE(f.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    parts.push(localHeader, nameBuf, f.data);
    entries.push({ name: f.name, data: f.data, crc, offset });
    offset += localHeader.length + nameBuf.length + f.data.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4); // version made by
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(0, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0x21, 14);
    cdHeader.writeUInt32LE(e.crc, 16);
    cdHeader.writeUInt32LE(e.data.length, 20);
    cdHeader.writeUInt32LE(e.data.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30); // extra
    cdHeader.writeUInt16LE(0, 32); // comment
    cdHeader.writeUInt16LE(0, 34); // disk start
    cdHeader.writeUInt16LE(0, 36); // internal attrs
    cdHeader.writeUInt32LE(0, 38); // external attrs
    cdHeader.writeUInt32LE(e.offset, 42);
    parts.push(cdHeader, nameBuf);
    offset += cdHeader.length + nameBuf.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

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
  const t = THEMES[themeName] ?? THEMES.light!;
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

process.stdin.on("end", () => {
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

    const files = pages.map((p: { filename: string; title: string; body_html: string }) => ({
      name: p.filename,
      data: Buffer.from(htmlEnvelope(p.title, siteTitle, p.body_html), "utf-8"),
    }));
    files.push({ name: "theme.css", data: Buffer.from(themeCss(theme), "utf-8") });

    const zip = buildZip(files);

    mkdirSync(outputDir, { recursive: true });
    const fullPath = join(outputDir, "kb.zip");
    writeFileSync(fullPath, zip);

    process.stdout.write(
      JSON.stringify({ path: fullPath, bytes: zip.length, file_count: files.length }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message }));
  }
});
