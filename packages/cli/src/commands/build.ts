import { readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isExcludedEntry, packAgentTar, validateAgent } from "@skrun-dev/schema";
import type { Command } from "commander";
import * as format from "../utils/format.js";
import { getValidatedConfig } from "../utils/validated-config.js";

const MAX_BUNDLE_SIZE = 50 * 1024 * 1024; // 50MB
const WARN_BUNDLE_SIZE = 10 * 1024 * 1024; // 10MB

// Collect the relative paths of every file to include in the `.agent` bundle,
// applying the shared exclusion contract (`@skrun-dev/schema`). Directory/file
// exclusions (node_modules, venvs, __pycache__, dotfiles, *.secret, …) live in
// one place so the CLI writer and the server-side push writer never diverge.
export async function collectFiles(dir: string, base: string = dir): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (isExcludedEntry(entry.name)) continue;

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
  const filename = `${config.name}-${config.version}.agent`;
  const outDir = outputDir ? resolve(outputDir) : dir;
  const outPath = join(outDir, filename);

  // Collect files
  const files = await collectFiles(dir);

  if (files.length === 0) {
    format.error("No files to package.");
    process.exit(1);
  }

  // Package into a deterministic gzipped tar (entry names normalised to POSIX by
  // the codec, so a bundle built on Windows still extracts on a Linux runner).
  const entries = files.map((file) => ({ name: file, content: readFileSync(join(dir, file)) }));
  const bundle = await packAgentTar(entries);
  writeFileSync(outPath, bundle);

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
