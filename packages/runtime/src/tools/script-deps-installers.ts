// Per-ecosystem script-dependency installers.
//
// Phase 4 split:
//   - 4.1: error type + allowlist constants only (commit `28acdeb`).
//   - 4.2 (this commit): Python pip flow (requirements.txt + pyproject without lockfile).
//   - 4.3: Python uv + poetry flows (real reproducible install via lockfiles).
//   - 4.4: Node npm / pnpm / yarn flows.
//
// All installers spawn the underlying tool with hardcoded registry env vars
// to confine network access to public package registries. The allowlist is
// not user-configurable in v1 — it is the security perimeter of the install
// stage.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";
import { ScriptDepsInstallError } from "../errors.js";
import { createLogger } from "../logger.js";

const log = createLogger("runtime:deps");

/**
 * Public package registries permitted during script-dependency install.
 *
 * Enforced by setting `PIP_INDEX_URL`, `npm_config_registry`, and
 * `YARN_NPM_REGISTRY_SERVER` in the spawn environment. Note: this is
 * best-effort confinement at the env-var level, not OS-level network
 * isolation — true sandboxing arrives with the future cloud container image
 * (iptables-derived rules from `allowed_hosts`).
 *
 * NOT user-configurable in v1 by design — operator-level overrides (private
 * registries / corporate proxies) are a future enhancement.
 */
export const INSTALL_REGISTRY_ALLOWLIST = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
] as const;

export type InstallRegistryHost = (typeof INSTALL_REGISTRY_ALLOWLIST)[number];

// Hardcoded URLs for env injection. Same hosts as INSTALL_REGISTRY_ALLOWLIST.
export const PYPI_INDEX_URL = "https://pypi.org/simple/";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
export const YARN_REGISTRY_URL = "https://registry.yarnpkg.com/";

/** Manifest variants the Python installer accepts. */
export type PythonManifest = Extract<ManifestInfo, { ecosystem: "python" }>;

/** Manifest variants the Node installer accepts. */
export type NodeManifest = Extract<ManifestInfo, { ecosystem: "node" }>;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Runs an external command, capturing stdout/stderr and exit code without
 * throwing on non-zero exit. Spawn-failure (ENOENT, etc.) returns
 * `exitCode: null` so callers can distinguish "tool missing" from "tool ran
 * and failed."
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

/** Production runner — wraps `node:child_process.execFile`. */
export const execFileRunner: CommandRunner = (command, args, options) => {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        // Buffers up to 10 MB of combined stdout/stderr — enough for noisy
        // pip / npm output, far below memory pressure.
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // ENOENT / spawn failure: exitCode is undefined on the error object.
          // For real non-zero exits, error.code is the numeric exit code.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: null });
            return;
          }
          // Otherwise, the process ran and exited non-zero. Node sets
          // `error.code` to the numeric exit code (sometimes a string).
          const numericCode =
            typeof code === "number" ? code : Number.parseInt(String(code ?? "1"), 10);
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: Number.isFinite(numericCode) ? numericCode : 1,
          });
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 });
        }
      },
    );
  });
};

/**
 * Cross-platform Python alias.
 *
 * Windows: `python` (the canonical alias; `python3` is a Microsoft Store
 * stub by default and fails).
 * Unix: `python3` (disambiguates from a still-installed system `python2` on
 * some distros). Callers can fall back to `python` if `python3` is missing.
 */
export function pythonAlias(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/** Path to the venv-local pip binary, platform-aware. */
function venvPipPath(depsPath: string): string {
  return process.platform === "win32"
    ? join(depsPath, "venv", "Scripts", "pip.exe")
    : join(depsPath, "venv", "bin", "pip");
}

/** Path to a venv-local executable (`uv`, `poetry`, etc.), platform-aware. */
function venvBinaryPath(depsPath: string, name: string): string {
  return process.platform === "win32"
    ? join(depsPath, "venv", "Scripts", `${name}.exe`)
    : join(depsPath, "venv", "bin", name);
}

/** Env vars layered on top of `process.env` for every Python install spawn. */
function pythonInstallEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Confine network to PyPI's public mirror. NOT user-configurable in v1.
    PIP_INDEX_URL: PYPI_INDEX_URL,
    // Suppress `pip is out of date` chatter — purely cosmetic, fills logs.
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

function failWithCommandResult(
  ecosystem: "node" | "python",
  command: string,
  result: CommandResult,
): never {
  throw new ScriptDepsInstallError({
    ecosystem,
    command,
    exitCode: result.exitCode,
    stderr: result.stderr || result.stdout,
  });
}

/**
 * Install a Python manifest's dependencies into `<depsPath>/venv/`.
 *
 * Dispatch by (manifestKind, lockfileKind):
 *   - `requirements` → `pip install -r requirements.txt`
 *   - `pyproject` no lockfile → `pip install <depsPath>` (non-editable;
 *     pip 21.3+ resolves PEP 517 against the local dir; `-e` is REJECTED
 *     to avoid polluting the source with `*.egg-info/`).
 *   - `pyproject` + `uv.lock` → `uv sync --frozen` (real reproducible
 *     install — strict reproducibility honored).
 *   - `pyproject` + `poetry.lock` → `poetry install --no-root` against the
 *     pre-created venv (POETRY_VIRTUALENVS_CREATE=false).
 *
 * The function writes the manifest content (and lockfile content if any) to
 * `depsPath` before calling the resolver — pip / uv / poetry all require
 * the files to exist on the filesystem at well-known paths inside the
 * install target.
 */
export async function installPython(
  depsPath: string,
  manifest: PythonManifest,
  runner: CommandRunner = execFileRunner,
): Promise<void> {
  // Step 1: create venv at <depsPath>/venv (used by every path below).
  const pythonCmd = pythonAlias();
  const venvPath = join(depsPath, "venv");
  const venvResult = await runner(pythonCmd, ["-m", "venv", venvPath], {
    env: pythonInstallEnv(),
  });
  if (venvResult.exitCode !== 0) {
    failWithCommandResult("python", `${pythonCmd} -m venv ${venvPath}`, venvResult);
  }

  const pip = venvPipPath(depsPath);

  // Step 2: requirements.txt path.
  if (manifest.manifestKind === "requirements") {
    const requirementsPath = join(depsPath, "requirements.txt");
    await writeFile(requirementsPath, manifest.manifestContent, "utf-8");

    const installResult = await runner(pip, ["install", "-r", requirementsPath], {
      cwd: depsPath,
      env: pythonInstallEnv(),
    });
    if (installResult.exitCode !== 0) {
      failWithCommandResult("python", `${pip} install -r ${requirementsPath}`, installResult);
    }
    return;
  }

  // manifestKind === "pyproject" — write pyproject.toml in all sub-paths.
  const pyprojectPath = join(depsPath, "pyproject.toml");
  await writeFile(pyprojectPath, manifest.manifestContent, "utf-8");

  // Step 3a: pyproject + uv.lock — bootstrap uv in venv, then `uv sync --frozen`.
  if (manifest.lockfileKind === "uv") {
    const uvLockPath = join(depsPath, "uv.lock");
    await writeFile(uvLockPath, manifest.lockfileContent ?? "", "utf-8");

    const bootstrapResult = await runner(pip, ["install", "uv"], {
      cwd: depsPath,
      env: pythonInstallEnv(),
    });
    if (bootstrapResult.exitCode !== 0) {
      failWithCommandResult("python", `${pip} install uv`, bootstrapResult);
    }

    const uvBin = venvBinaryPath(depsPath, "uv");
    const uvResult = await runner(uvBin, ["sync", "--frozen"], {
      cwd: depsPath,
      env: {
        ...pythonInstallEnv(),
        // Force uv to install into our pre-created venv instead of creating
        // its own. This keeps the venv layout predictable for the cache.
        UV_PROJECT_ENVIRONMENT: venvPath,
        // Pin uv's index to the same public PyPI mirror as pip.
        UV_INDEX_URL: PYPI_INDEX_URL,
      },
    });
    if (uvResult.exitCode !== 0) {
      failWithCommandResult("python", `${uvBin} sync --frozen`, uvResult);
    }
    return;
  }

  // Step 3b: pyproject + poetry.lock — bootstrap poetry, then install with
  // POETRY_VIRTUALENVS_CREATE=false to use our pre-created venv.
  if (manifest.lockfileKind === "poetry") {
    const poetryLockPath = join(depsPath, "poetry.lock");
    await writeFile(poetryLockPath, manifest.lockfileContent ?? "", "utf-8");

    const bootstrapResult = await runner(pip, ["install", "poetry"], {
      cwd: depsPath,
      env: pythonInstallEnv(),
    });
    if (bootstrapResult.exitCode !== 0) {
      failWithCommandResult("python", `${pip} install poetry`, bootstrapResult);
    }

    const poetryBin = venvBinaryPath(depsPath, "poetry");
    const poetryResult = await runner(poetryBin, ["install", "--no-root"], {
      cwd: depsPath,
      env: {
        ...pythonInstallEnv(),
        // Disable poetry's own venv creation — we provide one already.
        POETRY_VIRTUALENVS_CREATE: "false",
        // Activate our venv so poetry installs into it.
        VIRTUAL_ENV: venvPath,
      },
    });
    if (poetryResult.exitCode !== 0) {
      failWithCommandResult("python", `${poetryBin} install --no-root`, poetryResult);
    }
    return;
  }

  // Step 3c: pyproject without lockfile — pip install the local directory.
  const pyprojectResult = await runner(pip, ["install", depsPath], {
    cwd: depsPath,
    env: pythonInstallEnv(),
  });
  if (pyprojectResult.exitCode !== 0) {
    failWithCommandResult("python", `${pip} install ${depsPath}`, pyprojectResult);
  }
}

// --- Node installer ---------------------------------------------------------

/** Map a Node lockfile kind to its on-disk filename inside the bundle root. */
const NODE_LOCKFILE_FILENAMES: Record<NonNullable<NodeManifest["lockfileKind"]>, string> = {
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  npm: "package-lock.json",
};

/** Env vars layered on top of `process.env` for every Node install spawn. */
function nodeInstallEnv(forYarn: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Confine npm / pnpm to the public npm registry. NOT user-configurable in v1.
    npm_config_registry: NPM_REGISTRY_URL,
    // yarn (classic v1 + Berry) reads YARN_NPM_REGISTRY_SERVER for npm-protocol fetches.
    ...(forYarn && { YARN_NPM_REGISTRY_SERVER: YARN_REGISTRY_URL }),
  };
}

/**
 * Install a Node manifest's dependencies into `<depsPath>/node_modules/`.
 *
 * Dispatch by lockfile kind:
 *   - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile --dir=<depsPath>`
 *   - `yarn.lock`      → `yarn install --frozen-lockfile --cwd=<depsPath>`
 *   - `package-lock.json` → `npm ci --prefix=<depsPath>`
 *   - no lockfile        → `npm install --prefix=<depsPath>` + warning logged
 *     (build is non-reproducible — recommend committing a lockfile).
 *
 * Pre-step: the manifest (and lockfile if present) is written to `depsPath`
 * before invoking the package manager. npm / pnpm / yarn all install relative
 * to a directory containing `package.json`, so their `--prefix` / `--dir` /
 * `--cwd` flags only work once the manifest is in place.
 */
export async function installNode(
  depsPath: string,
  manifest: NodeManifest,
  runner: CommandRunner = execFileRunner,
): Promise<void> {
  // Pre-step: copy package.json (and lockfile) into depsPath. npm/pnpm/yarn
  // require `<depsPath>/package.json` to exist before --prefix/--dir/--cwd.
  await writeFile(join(depsPath, "package.json"), manifest.manifestContent, "utf-8");
  if (manifest.lockfileKind) {
    const lockFilename = NODE_LOCKFILE_FILENAMES[manifest.lockfileKind];
    await writeFile(join(depsPath, lockFilename), manifest.lockfileContent ?? "", "utf-8");
  }

  let command: string;
  let args: string[];
  let forYarn = false;

  switch (manifest.lockfileKind) {
    case "pnpm":
      command = "pnpm";
      args = ["install", "--frozen-lockfile", `--dir=${depsPath}`];
      break;
    case "yarn":
      command = "yarn";
      args = ["install", "--frozen-lockfile", `--cwd=${depsPath}`];
      forYarn = true;
      break;
    case "npm":
      command = "npm";
      args = ["ci", `--prefix=${depsPath}`];
      break;
    default: {
      // No lockfile — non-reproducible build, log a warning and continue.
      log.warn(
        { event: "node_deps_no_lockfile", depsPath },
        "Node deps install without lockfile — build is non-reproducible. Add package-lock.json / pnpm-lock.yaml / yarn.lock to your bundle for stable installs.",
      );
      command = "npm";
      args = ["install", `--prefix=${depsPath}`];
      break;
    }
  }

  const result = await runner(command, args, {
    cwd: depsPath,
    env: nodeInstallEnv(forYarn),
  });
  if (result.exitCode !== 0) {
    failWithCommandResult("node", `${command} ${args.join(" ")}`, result);
  }
}
