// Per-ecosystem script-dependency installers.
//
// One installer per ecosystem an agent's scripts can declare. Python: `pip`
// for a requirements.txt, or for a pyproject.toml without a lockfile; `uv` or
// `poetry` for a pyproject.toml locked by them, a reproducible install. Node:
// `npm`, `pnpm` or `yarn`, chosen by the lockfile — `npm` without one.
//
// All installers spawn the underlying tool with hardcoded registry env vars
// to confine network access to public package registries. The allowlist is
// not user-configurable in v1 — it is the security perimeter of the install
// stage.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";
import { ScriptDepsInstallError } from "../errors.js";
import { createLogger } from "../logger.js";

const log = createLogger("runtime:deps");

/**
 * Public package registries permitted during script-dependency install.
 *
 * Passed to the installers as `PIP_INDEX_URL`, `npm_config_registry` and
 * `YARN_NPM_REGISTRY_SERVER` in the spawn environment: where they fetch
 * packages from, not a network boundary. On the local runtime nothing at the
 * OS level confines an installer (nor a package's install script). In a cloud
 * sandbox runner, the flyio adapter passes this list as infrastructure hosts:
 * the sandbox's firewall keeps them reachable for the whole run, to every
 * process, beside what the agent's `allowed_hosts` lets through.
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

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Stops the command when aborted: the runner kills it together with every
   * process it started, then resolves with what it printed until then.
   */
  signal?: AbortSignal;
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
  options: CommandOptions,
) => Promise<CommandResult>;

/**
 * Kill a command and everything it started. An installer runs the install
 * scripts of the packages it installs, and those start processes of their own:
 * killing the installer alone would leave them running.
 *
 * On Windows the command runs under `cmd.exe` (see `shell` below), and
 * `taskkill /T` takes the tree that shell started. Elsewhere the command leads
 * its own process group (`detached` below), and the whole group is killed. A
 * process that leaves the group on purpose escapes it.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return; // never started
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
      // Best effort: a tree that already ended has nothing to kill.
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already ended.
  }
}

/**
 * How much of each output stream a command may print — enough for noisy pip /
 * npm output, far below memory pressure. Past it, the command is stopped and
 * fails, as `maxBuffer` made it fail when this runner used `execFile`.
 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Production runner. Built on `spawn` rather than `execFile`, which never
 * passes `detached` on, so that its command can lead its own process group.
 */
export const execFileRunner: CommandRunner = (command, args, options) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // Its own process group, outside Windows, so that a stopped command is
      // killed with every process it started (killProcessTree above). On
      // Windows, `detached` would open a console window instead, and
      // `taskkill /T` finds the tree without it.
      detached: process.platform !== "win32",
      // Windows-safe spawn: `npm`/`pnpm`/`yarn` are `.cmd` shell
      // scripts. Node cannot run them directly — both because it
      // doesn't consult PATHEXT (ENOENT on bare `npm`) and because Node's
      // CVE-2024-27980 fix blocks direct `.cmd` spawn with EINVAL. Setting
      // `shell: true` on Windows lets cmd.exe resolve the name via PATHEXT
      // and invoke the `.cmd` wrapper. This is Node's officially recommended
      // approach for `.bat`/`.cmd` invocation.
      //
      // DEP0190 note: passing `args` separately when `shell: true` triggers
      // a deprecation warning (args concatenated without escaping = shell
      // injection risk for untrusted args). Safe here because all args are
      // generated by Skrun (path templates with [a-zA-Z0-9/_.-] only —
      // hash + pid + hex random), never user-influenced. We accept the
      // warning to keep the simple {command, args} API surface.
      shell: process.platform === "win32",
    });

    const printed = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let overflowed = false;
    for (const name of ["stdout", "stderr"] as const) {
      let bytes = 0;
      child[name]?.on("data", (chunk: Buffer) => {
        if (overflowed) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          overflowed = true;
          killProcessTree(child);
          return;
        }
        printed[name].push(chunk);
      });
    }

    let settled = false;
    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", stop);
      resolve({
        stdout: Buffer.concat(printed.stdout).toString(),
        stderr: Buffer.concat(printed.stderr).toString(),
        exitCode,
      });
    }
    function stop(): void {
      killProcessTree(child);
    }

    // A command that could not be started (ENOENT) has no exit code; any other
    // start failure counts as a failed run.
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? null : 1);
    });
    // Ended by a signal — stopped, or past its output limit — it has no exit
    // code: it counts as failed.
    child.on("close", (code) => {
      finish(overflowed ? 1 : (code ?? 1));
    });

    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
  });
};

/** How long a stopped command is given to hand back what it printed. */
const STOPPED_OUTPUT_WAIT_MS = 2_000;

/**
 * A runner whose commands share one deadline, `limitMs` from now: each command
 * gets the time left. One still running when the time is spent is stopped —
 * through its signal, so the runner kills it with what it started — and the
 * install fails with a `ScriptDepsInstallError` that names the limit; a command
 * that would start after it does not start. What the stopped command printed
 * is kept when the runner hands it back within `STOPPED_OUTPUT_WAIT_MS`.
 *
 * Internal: neither of the package's entry points exports it. The resolver
 * gives every install `SCRIPT_DEPS_INSTALL_TIMEOUT_MS`; its tests call this
 * function directly, on a limit of milliseconds.
 */
export function withInstallDeadline(
  runner: CommandRunner,
  ecosystem: "node" | "python",
  limitMs: number,
): CommandRunner {
  const deadline = Date.now() + limitMs;
  return async (command, args, options) => {
    const commandLine = [command, ...args].join(" ");
    const timedOut = (printed: CommandResult | null) =>
      new ScriptDepsInstallError({
        ecosystem,
        command: commandLine,
        exitCode: null,
        stderr: printed ? printed.stderr || printed.stdout : "",
        timeoutMs: limitMs,
      });
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut(null);

    const controller = new AbortController();
    const running = runner(command, args, { ...options, signal: controller.signal });
    const finished = await settledWithin(running, left);
    if (finished !== null) return finished;
    controller.abort();
    throw timedOut(await settledWithin(running, STOPPED_OUTPUT_WAIT_MS).catch(() => null));
  };
}

/** `promise`'s value if it settles within `ms`, else null; its rejection passes through. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * Harness secrets that must NOT reach the (untrusted) dependency-installer
 * subprocess (pip/npm run arbitrary postinstall scripts of untrusted deps).
 * Installers need a wide OS env (PATH, HOME, proxies, CA bundles), so we
 * DENYLIST secret-shaped names rather than allowlist. The `_KEY_ID$` /
 * `ACCESS_KEY` arms catch S3 access-key IDs that a suffix-only `_KEY` check misses.
 * `BUNDLE_URL` and `OUTPUTS_PUT_URL` are the presigned URLs an earlier harness
 * put in a sandbox runner's environment — this one sends them in the body of
 * `/init` only, but a runner of this image may still meet one that does: their
 * names say nothing of a secret, their query carries the signature that opens
 * the run's objects.
 */
const INSTALL_SECRET_DENYLIST = new Set([
  "SKRUN_SECRETS_ENCRYPTION_KEY",
  "WEBHOOK_SIGNING_KEY",
  "DATABASE_URL",
  "BUNDLE_URL",
  "OUTPUTS_PUT_URL",
]);
const INSTALL_SECRET_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|ENCRYPTION|ACCESS_KEY|_KEY$|_KEY_ID$)/i;

/** Clone `env` minus secret-shaped names — keeps the OS env pip/npm require. */
export function stripHarnessSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (INSTALL_SECRET_DENYLIST.has(name) || INSTALL_SECRET_PATTERN.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

/** Env vars layered on top of `process.env` for every Python install spawn. */
function pythonInstallEnv(): NodeJS.ProcessEnv {
  return {
    ...stripHarnessSecrets(process.env),
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
    ...stripHarnessSecrets(process.env),
    // Confine npm / pnpm to the public npm registry. NOT user-configurable in v1.
    npm_config_registry: NPM_REGISTRY_URL,
    // yarn (classic v1 + Berry) reads YARN_NPM_REGISTRY_SERVER for npm-protocol fetches.
    ...(forYarn && { YARN_NPM_REGISTRY_SERVER: YARN_REGISTRY_URL }),
    // No check for a newer npm: nothing in a sandbox can act on that notice, the check is one
    // more request per install, and npm prints the notice only when its check wins a race
    // against its own exit, so a failed install's output would vary from one run to the next.
    npm_config_update_notifier: "false",
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
      // Bare command name works on all platforms.
      // execFileRunner sets `shell: true` on Windows to resolve `.cmd`
      // wrappers via cmd.exe + PATHEXT (Node's CVE-2024-27980 blocks direct
      // `.cmd` spawn with EINVAL).
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
