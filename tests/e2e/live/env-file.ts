// Where the live suite finds its `.env`.
//
// The file is unversioned and lives only in the main checkout, so a git worktree
// has none of its own and `node --env-file=.env` fails there before a single test
// runs. This resolves it instead: an explicit SKRUN_ENV_FILE, then the working
// directory, then the main checkout — found through git's common directory, which
// every worktree shares with the checkout it was created from.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface EnvFileCandidates {
  /** SKRUN_ENV_FILE — wins when set, and must exist. */
  override?: string;
  cwd: string;
  /** Absolute path of `.git` for the main checkout (`git rev-parse --git-common-dir`). */
  gitCommonDir?: string;
}

/** Pure precedence, no git call: override, then `<cwd>/.env`, then `<main checkout>/.env`. */
export function resolveEnvFile(c: EnvFileCandidates): string | undefined {
  if (c.override) return resolve(c.override);
  const local = join(c.cwd, ".env");
  if (existsSync(local)) return local;
  if (c.gitCommonDir) {
    const shared = join(dirname(resolve(c.gitCommonDir)), ".env");
    if (existsSync(shared)) return shared;
  }
  return undefined;
}

function gitCommonDir(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

let loaded = false;

/**
 * Load the suite's `.env` into `process.env` once. Variables the shell already
 * set keep their value, exactly like `--env-file`. Returns the file used, or
 * `undefined` when there is none (the suite then skips the providers whose key is
 * missing, as it already does).
 */
export function loadLiveEnv(cwd = process.cwd()): string | undefined {
  if (loaded) return undefined;
  loaded = true;
  const file = resolveEnvFile({
    override: process.env.SKRUN_ENV_FILE,
    cwd,
    gitCommonDir: gitCommonDir(cwd),
  });
  if (!file) {
    console.warn(
      "[live] no .env found (SKRUN_ENV_FILE, the working directory, the main checkout) — provider keys must come from the shell",
    );
    return undefined;
  }
  if (!existsSync(file)) {
    throw new Error(`SKRUN_ENV_FILE points to a missing file: ${file}`);
  }
  // Present on every Node this repo supports (engines >= 22); typed here because
  // the installed type definitions may predate it.
  const proc = process as NodeJS.Process & { loadEnvFile?: (path?: string) => void };
  if (typeof proc.loadEnvFile !== "function") {
    throw new Error(`this Node cannot load ${file} itself — run with --env-file=${file}`);
  }
  proc.loadEnvFile(file);
  console.log(`[live] env loaded from ${file}`);
  return file;
}
