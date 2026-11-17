import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import {
  AGENT_YAML_MAX_BYTES,
  DEFAULT_MAX_DECOMPRESSED_MB,
  DEFAULT_PUSH_MAX_BODY_MB,
  isExcludedEntry,
  packAgentTar,
  type ValidationResult,
  validateAgent,
} from "@skrun-dev/schema";
import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { getValidatedConfig } from "../utils/validated-config.js";
import { printValidationWarnings } from "../utils/validation-output.js";

const MIB = 1024 * 1024;

/**
 * Past this compressed size, `build` recommends a smaller bundle, when it
 * crosses no limit of a server (`sizeWarning`): the bundle travels whole at each
 * push and pull, and an account's storage counts it at that size.
 */
const RECOMMENDED_MAX_SIZE_MB = 10;

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

/**
 * Make sure the `--output` path is a directory before the bundle is written
 * there: created (with its parents) when absent — the author asked for it —
 * and refused by name when something else is in its place. Never a raw
 * filesystem error.
 */
function ensureOutputDir(outDir: string): void {
  let isDirectory: boolean | undefined;
  try {
    isDirectory = statSync(outDir).isDirectory();
  } catch {
    isDirectory = undefined; // absent, or unreachable: creating it says which
  }
  if (isDirectory === false) {
    format.error(`--output: ${outDir} is not a directory.`);
    exitWith(1);
  }
  if (isDirectory === undefined) {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? String(err);
      format.error(`--output: cannot create the directory ${outDir} (${reason}).`);
      exitWith(1);
    }
  }
}

/** A size, rounded UP to a tenth: a bundle past a limit never reads as the limit. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const tenthsUp = (value: number) => (Math.ceil(value * 10) / 10).toFixed(1);
  if (bytes < MIB) return `${tenthsUp(bytes / 1024)} KB`;
  return `${tenthsUp(bytes / MIB)} MB`;
}

/** Both sizes of a bundle, as `build` prints them. */
function formatSizes(size: number, decompressedSize: number): string {
  return `${formatSize(size)} compressed, ${formatSize(decompressedSize)} unpacked`;
}

/**
 * What a `.agent` bundle decompresses to, in bytes: the length of its tar
 * stream, tar headers and padding included — what a server's decompression cap
 * (`BUNDLE_MAX_DECOMPRESSED_MB`) counts, not the sum of the files. Counted as
 * it streams, never held.
 */
export function decompressedSize(bundle: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const gunzip = createGunzip();
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
    });
    gunzip.on("end", () => resolve(total));
    gunzip.on("error", reject);
    gunzip.end(bundle);
  });
}

/**
 * What `build` warns about a bundle's size — never a refusal: the server it is
 * pushed to decides, and `build` does not know that server's limits. Past a
 * limit of a server with the default settings, each limit crossed, the code its
 * push would be refused with and the setting its operator may have changed;
 * else, past the recommended size, the recommendation; else nothing. Both
 * sizes, always.
 */
export function sizeWarning(size: number, decompressed: number): string | undefined {
  const sizes = formatSizes(size, decompressed);
  const crossed: Array<{ limit: string; setting: string }> = [];
  if (size > DEFAULT_PUSH_MAX_BODY_MB * MIB) {
    crossed.push({
      limit: `over ${DEFAULT_PUSH_MAX_BODY_MB} MB compressed (413 BUNDLE_TOO_LARGE)`,
      setting: "SKRUN_PUSH_MAX_BODY_MB",
    });
  }
  if (decompressed > DEFAULT_MAX_DECOMPRESSED_MB * MIB) {
    crossed.push({
      limit: `over ${DEFAULT_MAX_DECOMPRESSED_MB} MB unpacked, tar headers counted (413 BUNDLE_DECOMPRESSED_TOO_LARGE)`,
      setting: "BUNDLE_MAX_DECOMPRESSED_MB",
    });
  }
  if (crossed.length > 0) {
    const limits = crossed.map((c) => c.limit).join(", and ");
    const settings = crossed.map((c) => c.setting).join(", ");
    const other = crossed.length === 1 ? "another limit" : "other limits";
    return `Bundle is ${sizes}: a server with the default limits refuses its push — ${limits}. A server's operator may set ${other} (${settings}). Leave out the files the agent does not need when it runs.`;
  }
  if (size > RECOMMENDED_MAX_SIZE_MB * MIB) {
    return `Bundle is ${sizes} (recommended < ${RECOMMENDED_MAX_SIZE_MB} MB compressed).`;
  }
  return undefined;
}

/**
 * What `build` warns about the size of `agent.yaml` — never a refusal: past
 * `AGENT_YAML_MAX_BYTES`, a fixed limit of every server and no setting, the
 * push is refused (`413 CONFIG_TOO_LARGE`); else nothing.
 */
export function configSizeWarning(bytes: number): string | undefined {
  if (bytes <= AGENT_YAML_MAX_BYTES) return undefined;
  return `agent.yaml is ${formatSize(bytes)}: every server refuses its push past ${AGENT_YAML_MAX_BYTES / 1024} KB (413 CONFIG_TOO_LARGE) — a fixed limit, no setting. agent.yaml holds the agent's configuration: put long content — instructions, context, data — in SKILL.md, AGENTS.md or other files of the agent.`;
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
  const built = await buildBundle(process.cwd(), { outputDir });
  format.success(`Built ${built.filename}`);
  format.info(`Files: ${built.files} | Size: ${formatSizes(built.size, built.decompressedSize)}`);
}

export interface BuildBundleOptions {
  /** Where the bundle is written; the agent's directory when absent. */
  outputDir?: string;
  /**
   * The agent's validation, when the caller already ran it (and printed what it
   * had to say). Absent, the agent is validated here, its errors and warnings
   * printed.
   */
  validation?: ValidationResult;
}

export interface BuiltBundle {
  /** The bundle's file name: `<name>-<version>.agent`. */
  filename: string;
  /** Where it was written. */
  path: string;
  /** How many files it packs. */
  files: number;
  /** Its size, in bytes: the compressed archive, as it is pushed. */
  size: number;
  /** What it decompresses to, in bytes: its tar stream, headers included (`decompressedSize`). */
  decompressedSize: number;
}

/**
 * Build the agent in `dir` into its `.agent` bundle — the one function `skrun
 * build` and `skrun deploy` share, run in the calling process, from any
 * directory. Validates (unless given a validation), collects the files under
 * the shared exclusion contract, packs them with the shared codec, measures
 * both of its sizes and warns about them (`sizeWarning`), and about the size
 * of its `agent.yaml` (`configSizeWarning`) — never refusing on size. On a
 * failure, prints why and exits.
 */
export async function buildBundle(
  dir: string,
  opts: BuildBundleOptions = {},
): Promise<BuiltBundle> {
  let result = opts.validation;
  if (!result) {
    result = await validateAgent(dir);
    if (!result.valid) {
      for (const err of result.errors) {
        format.error(`${err.file ?? ""}: ${err.message}`);
      }
      format.error("Build failed.");
      exitWith(1);
    }
    printValidationWarnings(result);
  }

  const config = getValidatedConfig(result);
  const filename = `${config.name}-${config.version}.agent`;
  const outDir = opts.outputDir ? resolve(opts.outputDir) : dir;
  const outPath = join(outDir, filename);

  // Collect files
  const files = await collectFiles(dir);

  if (files.length === 0) {
    format.error("No files to package.");
    exitWith(1);
  }

  // Package into a deterministic gzipped tar (entry names normalised to POSIX by
  // the codec, so a bundle built on Windows still extracts on a Linux runner).
  const entries = files.map((file) => ({ name: file, content: readFileSync(join(dir, file)) }));
  const bundle = await packAgentTar(entries);
  // Measured before it is written, from the bytes that are.
  const size = bundle.length;
  const unpacked = await decompressedSize(bundle);
  // Only now, after the files are collected: an output directory inside the
  // agent's own never changes what is packed.
  if (opts.outputDir) ensureOutputDir(outDir);
  writeFileSync(outPath, bundle);

  const warning = sizeWarning(size, unpacked);
  if (warning) format.warn(warning);
  const configWarning = configSizeWarning(
    entries.find((entry) => entry.name === "agent.yaml")?.content.length ?? 0,
  );
  if (configWarning) format.warn(configWarning);

  return { filename, path: outPath, files: files.length, size, decompressedSize: unpacked };
}
