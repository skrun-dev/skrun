import { createWriteStream, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { validateAgent } from "@skrun-dev/schema";
import type { Command } from "commander";
import * as format from "../utils/format.js";
import { getValidatedConfig } from "../utils/validated-config.js";

const MAX_BUNDLE_SIZE = 50 * 1024 * 1024; // 50MB
const WARN_BUNDLE_SIZE = 10 * 1024 * 1024; // 10MB

// Directories and filenames excluded from the .agent bundle.
//
// `__pycache__` / `.pytest_cache` / `venv` / `.venv` were added in #57 so that
// dev-machine venvs and Python build caches never leak into the tar — agents
// declare `requirements.txt` / `pyproject.toml` and the runtime resolves deps
// from the manifest at first run, not from a bundled venv.
export const EXCLUDE_PATTERNS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".env",
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv",
]);

function isExcluded(name: string): boolean {
  if (EXCLUDE_PATTERNS.has(name)) return true;
  if (name.startsWith(".") && name !== ".") return true;
  if (name.endsWith(".secret")) return true;
  return false;
}

export async function collectFiles(dir: string, base: string = dir): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await collectFiles(fullPath, base);
      files.push(...subFiles);
    } else {
      files.push(relative(base, fullPath));
    }
  }

  return files.sort();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Simple tar archive creator (POSIX ustar format)
function createTarEntry(filePath: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const nameBytes = Buffer.from(filePath, "utf-8");
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));

  // Mode
  Buffer.from("0000644\0").copy(header, 100);
  // UID
  Buffer.from("0001000\0").copy(header, 108);
  // GID
  Buffer.from("0001000\0").copy(header, 116);
  // Size (octal)
  Buffer.from(`${content.length.toString(8).padStart(11, "0")}\0`).copy(header, 124);
  // Mtime (fixed for determinism)
  Buffer.from("00000000000\0").copy(header, 136);
  // Type flag: regular file
  header[156] = 48; // '0'
  // Magic
  Buffer.from("ustar\0").copy(header, 257);
  // Version
  Buffer.from("00").copy(header, 263);

  // Compute checksum
  // Fill checksum field with spaces first
  Buffer.from("        ").copy(header, 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);

  // Pad content to 512-byte blocks
  const paddingSize = (512 - (content.length % 512)) % 512;
  const padding = Buffer.alloc(paddingSize);

  return Buffer.concat([header, content, padding]);
}

function createTarBuffer(dir: string, files: string[]): Buffer {
  const parts: Buffer[] = [];

  for (const file of files) {
    const fullPath = join(dir, file);
    const content = readFileSync(fullPath);
    parts.push(createTarEntry(file, content));
  }

  // End-of-archive: two 512-byte blocks of zeros
  parts.push(Buffer.alloc(1024));

  return Buffer.concat(parts);
}

export function registerBuildCommand(program: Command): void {
  program
    .command("build")
    .description("Package agent into a .agent bundle")
    .option("--output <path>", "Output directory")
    .action(async (opts) => {
      await runBuild(opts.output);
    });
}

async function runBuild(outputDir?: string): Promise<void> {
  const dir = process.cwd();

  // Validate agent
  const result = await validateAgent(dir);
  if (!result.valid) {
    for (const err of result.errors) {
      format.error(`${err.file ?? ""}: ${err.message}`);
    }
    format.error("Build failed.");
    process.exit(1);
  }

  const config = getValidatedConfig(result);
  const slug = config.name.split("/")[1] ?? config.name;
  const filename = `${slug}-${config.version}.agent`;
  const outDir = outputDir ? resolve(outputDir) : dir;
  const outPath = join(outDir, filename);

  // Collect files
  const files = await collectFiles(dir);

  if (files.length === 0) {
    format.error("No files to package.");
    process.exit(1);
  }

  // Create tar.gz
  const tarBuffer = createTarBuffer(dir, files);
  const tarStream = Readable.from(tarBuffer);
  const gzip = createGzip();
  const output = createWriteStream(outPath);

  await pipeline(tarStream, gzip, output);

  // Check size
  const stat = statSync(outPath);

  if (stat.size > MAX_BUNDLE_SIZE) {
    format.error(
      `Bundle exceeds 50MB limit (${formatSize(stat.size)}). Remove large files or use external references.`,
    );
    process.exit(1);
  }

  if (stat.size > WARN_BUNDLE_SIZE) {
    format.warn(`Bundle size is ${formatSize(stat.size)} (recommended < 10 MB)`);
  }

  format.success(`Built ${filename}`);
  format.info(`Files: ${files.length} | Size: ${formatSize(stat.size)}`);
}
