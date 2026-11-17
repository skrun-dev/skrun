// Unit tests for script-deps installers.
//
// Tests inject a mock `CommandRunner` rather than spawning real pip / npm —
// the dispatch logic, env hardening, and failure handling are the unit under
// test. End-to-end install behavior is exercised by the live E2E tests.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptDepsInstallError } from "../errors.js";
import {
  type CommandResult,
  type CommandRunner,
  execFileRunner,
  INSTALL_REGISTRY_ALLOWLIST,
  installNode,
  installPython,
  NPM_REGISTRY_URL,
  PYPI_INDEX_URL,
  pythonAlias,
  stripHarnessSecrets,
  withInstallDeadline,
  YARN_REGISTRY_URL,
} from "./script-deps-installers.js";

describe("stripHarnessSecrets (SEC — installer env hardening)", () => {
  it("strips harness secrets, keeps the OS + registry env installers need", () => {
    const out = stripHarnessSecrets({
      // OS env installers require (esp. behind a corporate proxy / custom CA):
      PATH: "/usr/bin",
      HOME: "/home/x",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      // Harness secrets that MUST NOT reach the untrusted installer subprocess:
      SKRUN_SECRETS_ENCRYPTION_KEY: "master-key",
      WEBHOOK_SIGNING_KEY: "sig",
      DATABASE_URL: "postgres://u:p@h/db",
      ANTHROPIC_API_KEY: "sk-ant-x",
      S3_ACCESS_KEY_ID: "AKIA-should-not-leak", // _KEY_ID — the suffix-only _KEY check misses this
      S3_SECRET_ACCESS_KEY: "secret",
      RUNNER_RPC_TOKEN: "tok",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/x");
    expect(out.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(out.NO_PROXY).toBe("localhost");
    expect(out.NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
    for (const secret of [
      "SKRUN_SECRETS_ENCRYPTION_KEY",
      "WEBHOOK_SIGNING_KEY",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "RUNNER_RPC_TOKEN",
    ]) {
      expect(out[secret]).toBeUndefined();
    }
  });

  it("strips the run's presigned URLs, which a sandbox runner holds in its environment", () => {
    // The signature is in the query: whoever holds the URL fetches the bundle,
    // or writes the run's outputs, until it expires. An installer runs the code
    // of the packages it installs.
    const out = stripHarnessSecrets({
      PATH: "/usr/bin",
      BUNDLE_URL: "https://store.example/bundle.agent?X-Amz-Signature=abc",
      OUTPUTS_PUT_URL: "https://store.example/outputs.tar.gz?X-Amz-Signature=def",
    });
    expect(out).toEqual({ PATH: "/usr/bin" });
  });
});

let depsPath: string;

beforeEach(() => {
  depsPath = mkdtempSync(join(tmpdir(), "skrun-installers-test-"));
});

afterEach(() => {
  rmSync(depsPath, { recursive: true, force: true });
});

interface RunnerCall {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds a mock runner that returns `result` for every call and records the
 * spawn arguments for assertion. Pass an array of results to script per-call
 * outcomes (first call = `results[0]`, etc.).
 */
function mockRunner(results: CommandResult[] | CommandResult): {
  runner: CommandRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const queue = Array.isArray(results) ? [...results] : [];
  const fallback = Array.isArray(results) ? { stdout: "", stderr: "", exitCode: 0 } : results;

  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    if (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      return queue.shift()!;
    }
    return fallback;
  };

  return { runner, calls };
}

const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

function pythonRequirements(content: string): Extract<ManifestInfo, { ecosystem: "python" }> {
  return { ecosystem: "python", manifestKind: "requirements", manifestContent: content };
}

function pythonPyproject(
  content: string,
  projectName?: string,
): Extract<ManifestInfo, { ecosystem: "python" }> {
  return {
    ecosystem: "python",
    manifestKind: "pyproject",
    manifestContent: content,
    ...(projectName && { pythonProjectName: projectName }),
  };
}

describe("INSTALL_REGISTRY_ALLOWLIST", () => {
  it("contains the four canonical public registry hosts", () => {
    expect(INSTALL_REGISTRY_ALLOWLIST).toEqual([
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
    ]);
  });

  it("PYPI_INDEX_URL points at pypi.org", () => {
    expect(PYPI_INDEX_URL).toBe("https://pypi.org/simple/");
  });
});

describe("pythonAlias()", () => {
  it("returns 'python' on Windows, 'python3' on Unix", () => {
    const alias = pythonAlias();
    if (process.platform === "win32") {
      expect(alias).toBe("python");
    } else {
      expect(alias).toBe("python3");
    }
  });
});

describe("installPython — requirements.txt path", () => {
  it("creates venv then runs pip install -r requirements.txt", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(depsPath, pythonRequirements("pandas==2.2.3\n"), runner);

    expect(calls).toHaveLength(2);
    // Step 1: venv create
    expect(calls[0]?.command).toBe(pythonAlias());
    expect(calls[0]?.args).toEqual(["-m", "venv", join(depsPath, "venv")]);
    // Step 2: pip install -r
    const expectedPip =
      process.platform === "win32"
        ? join(depsPath, "venv", "Scripts", "pip.exe")
        : join(depsPath, "venv", "bin", "pip");
    expect(calls[1]?.command).toBe(expectedPip);
    expect(calls[1]?.args).toEqual(["install", "-r", join(depsPath, "requirements.txt")]);
  });

  it("writes the requirements.txt content to depsPath before invoking pip", async () => {
    const { runner } = mockRunner(ok);
    const content = "pandas==2.2.3\nmatplotlib==3.9.2\n";
    await installPython(depsPath, pythonRequirements(content), runner);

    const written = readFileSync(join(depsPath, "requirements.txt"), "utf-8");
    expect(written).toBe(content);
  });

  it("pins PIP_INDEX_URL and PIP_DISABLE_PIP_VERSION_CHECK in spawn env", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(depsPath, pythonRequirements("pandas\n"), runner);

    for (const call of calls) {
      expect(call.env?.PIP_INDEX_URL).toBe(PYPI_INDEX_URL);
      expect(call.env?.PIP_DISABLE_PIP_VERSION_CHECK).toBe("1");
    }
  });

  it("does NOT set PIP_NO_CACHE_DIR (lets pip use its own HTTP cache)", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(depsPath, pythonRequirements("pandas\n"), runner);

    for (const call of calls) {
      expect(call.env?.PIP_NO_CACHE_DIR).toBeUndefined();
    }
  });

  it("uses depsPath as cwd for the pip install step", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(depsPath, pythonRequirements("pandas\n"), runner);

    // venv create has no cwd (runs from process.cwd by default).
    expect(calls[1]?.cwd).toBe(depsPath);
  });
});

describe("installPython — pyproject without lockfile path", () => {
  it("creates venv then runs pip install <depsPath> (non-editable)", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(
      depsPath,
      pythonPyproject('[project]\nname = "myagent"\nversion = "0.1.0"\n', "myagent"),
      runner,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(["install", depsPath]);
    // Critical: NO `-e` flag.
    expect(calls[1]?.args).not.toContain("-e");
  });

  it("writes the pyproject.toml content to depsPath before invoking pip", async () => {
    const { runner } = mockRunner(ok);
    const content = '[project]\nname = "myagent"\nversion = "0.1.0"\n';
    await installPython(depsPath, pythonPyproject(content, "myagent"), runner);

    const written = readFileSync(join(depsPath, "pyproject.toml"), "utf-8");
    expect(written).toBe(content);
  });

  it("does NOT write a requirements.txt file in pyproject mode", async () => {
    const { runner } = mockRunner(ok);
    await installPython(
      depsPath,
      pythonPyproject('[project]\nname = "myagent"\n', "myagent"),
      runner,
    );

    expect(existsSync(join(depsPath, "requirements.txt"))).toBe(false);
  });
});

describe("installPython — failure handling", () => {
  it("throws ScriptDepsInstallError when venv creation fails", async () => {
    const { runner } = mockRunner({
      stdout: "",
      stderr: "Error: Python is not installed",
      exitCode: 1,
    });

    await expect(
      installPython(depsPath, pythonRequirements("pandas\n"), runner),
    ).rejects.toBeInstanceOf(ScriptDepsInstallError);
  });

  it("throws ScriptDepsInstallError when pip install fails (requirements path)", async () => {
    const { runner } = mockRunner([
      ok, // venv create succeeds
      { stdout: "", stderr: "ERROR: No matching distribution for nonexistent==1.0", exitCode: 1 },
    ]);

    const error = await installPython(depsPath, pythonRequirements("nonexistent==1.0\n"), runner)
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    expect(error?.code).toBe("SCRIPT_DEPS_INSTALL_FAILED");
    expect(error?.details.ecosystem).toBe("python");
    expect(error?.details.exitCode).toBe(1);
    expect(error?.details.stderr).toContain("ERROR: No matching distribution");
    expect(error?.details.command).toContain("install -r");
  });

  it("throws ScriptDepsInstallError when pip install fails (pyproject path)", async () => {
    const { runner } = mockRunner([
      ok,
      { stdout: "", stderr: "ERROR: backend not found", exitCode: 1 },
    ]);

    const error = await installPython(depsPath, pythonPyproject('[project]\nname = "x"\n'), runner)
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    expect(error?.details.ecosystem).toBe("python");
    expect(error?.details.command).toContain(depsPath);
  });

  it("propagates exitCode = null when the process did not spawn (ENOENT)", async () => {
    const { runner } = mockRunner({ stdout: "", stderr: "", exitCode: null });

    const error = await installPython(depsPath, pythonRequirements("pandas\n"), runner)
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error?.details.exitCode).toBeNull();
  });
});

function pythonPyprojectWithLock(
  manifestContent: string,
  lockfileKind: "uv" | "poetry",
  lockfileContent: string,
): Extract<ManifestInfo, { ecosystem: "python" }> {
  return {
    ecosystem: "python",
    manifestKind: "pyproject",
    manifestContent,
    lockfileKind,
    lockfileContent,
  };
}

describe("installPython — uv.lock path (real reproducible install)", () => {
  it("creates venv, bootstraps uv via pip, then runs uv sync --frozen", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "uv", "version = 1\n"),
      runner,
    );

    expect(calls).toHaveLength(3);
    // 1. venv create
    expect(calls[0]?.command).toBe(pythonAlias());
    expect(calls[0]?.args).toEqual(["-m", "venv", join(depsPath, "venv")]);
    // 2. bootstrap uv via venv pip
    const expectedPip =
      process.platform === "win32"
        ? join(depsPath, "venv", "Scripts", "pip.exe")
        : join(depsPath, "venv", "bin", "pip");
    expect(calls[1]?.command).toBe(expectedPip);
    expect(calls[1]?.args).toEqual(["install", "uv"]);
    // 3. uv sync --frozen via venv-local uv binary
    const expectedUv =
      process.platform === "win32"
        ? join(depsPath, "venv", "Scripts", "uv.exe")
        : join(depsPath, "venv", "bin", "uv");
    expect(calls[2]?.command).toBe(expectedUv);
    expect(calls[2]?.args).toEqual(["sync", "--frozen"]);
  });

  it("writes both pyproject.toml and uv.lock to depsPath", async () => {
    const { runner } = mockRunner(ok);
    const manifestContent = '[project]\nname = "myagent"\n';
    const lockContent = 'version = 1\n[[package]]\nname = "pandas"\n';
    await installPython(
      depsPath,
      pythonPyprojectWithLock(manifestContent, "uv", lockContent),
      runner,
    );

    expect(readFileSync(join(depsPath, "pyproject.toml"), "utf-8")).toBe(manifestContent);
    expect(readFileSync(join(depsPath, "uv.lock"), "utf-8")).toBe(lockContent);
  });

  it("sets UV_PROJECT_ENVIRONMENT and UV_INDEX_URL on the uv sync spawn", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "uv", "version = 1\n"),
      runner,
    );

    const uvCall = calls[2];
    expect(uvCall?.env?.UV_PROJECT_ENVIRONMENT).toBe(join(depsPath, "venv"));
    expect(uvCall?.env?.UV_INDEX_URL).toBe(PYPI_INDEX_URL);
    expect(uvCall?.cwd).toBe(depsPath);
  });

  it("throws ScriptDepsInstallError when uv bootstrap fails", async () => {
    const { runner } = mockRunner([
      ok, // venv create
      { stdout: "", stderr: "ERROR: pip install uv failed", exitCode: 1 },
    ]);

    const error = await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "uv", "version = 1\n"),
      runner,
    )
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    expect(error?.details.command).toContain("install uv");
  });

  it("throws ScriptDepsInstallError when uv sync fails", async () => {
    const { runner } = mockRunner([
      ok, // venv create
      ok, // pip install uv
      { stdout: "", stderr: "ERROR: uv lockfile mismatch", exitCode: 1 },
    ]);

    const error = await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "uv", "version = 1\n"),
      runner,
    )
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    expect(error?.details.command).toContain("sync --frozen");
    expect(error?.details.stderr).toContain("uv lockfile mismatch");
  });
});

describe("installPython — poetry.lock path", () => {
  it("creates venv, bootstraps poetry, then runs poetry install --no-root", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "poetry", "# poetry\n"),
      runner,
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]?.args).toEqual(["install", "poetry"]);
    const expectedPoetry =
      process.platform === "win32"
        ? join(depsPath, "venv", "Scripts", "poetry.exe")
        : join(depsPath, "venv", "bin", "poetry");
    expect(calls[2]?.command).toBe(expectedPoetry);
    expect(calls[2]?.args).toEqual(["install", "--no-root"]);
  });

  it("writes both pyproject.toml and poetry.lock to depsPath", async () => {
    const { runner } = mockRunner(ok);
    const manifestContent = '[project]\nname = "myagent"\n';
    const lockContent =
      '# This file is automatically @generated by Poetry\n[[package]]\nname = "pandas"\n';
    await installPython(
      depsPath,
      pythonPyprojectWithLock(manifestContent, "poetry", lockContent),
      runner,
    );

    expect(readFileSync(join(depsPath, "pyproject.toml"), "utf-8")).toBe(manifestContent);
    expect(readFileSync(join(depsPath, "poetry.lock"), "utf-8")).toBe(lockContent);
  });

  it("sets POETRY_VIRTUALENVS_CREATE=false and VIRTUAL_ENV on poetry install", async () => {
    const { runner, calls } = mockRunner(ok);
    await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "poetry", "# poetry\n"),
      runner,
    );

    const poetryCall = calls[2];
    expect(poetryCall?.env?.POETRY_VIRTUALENVS_CREATE).toBe("false");
    expect(poetryCall?.env?.VIRTUAL_ENV).toBe(join(depsPath, "venv"));
    expect(poetryCall?.cwd).toBe(depsPath);
  });

  it("throws ScriptDepsInstallError when poetry install fails", async () => {
    const { runner } = mockRunner([
      ok, // venv create
      ok, // pip install poetry
      { stdout: "", stderr: "ERROR: lockfile out of date", exitCode: 1 },
    ]);

    const error = await installPython(
      depsPath,
      pythonPyprojectWithLock('[project]\nname = "x"\n', "poetry", "# poetry\n"),
      runner,
    )
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    expect(error?.details.command).toContain("install --no-root");
  });
});

// ============================================================================
// Node installer tests (Task 4.4)
// ============================================================================

function nodeManifest(
  manifestContent: string,
  lockfile?: { kind: "npm" | "pnpm" | "yarn"; content: string },
): Extract<ManifestInfo, { ecosystem: "node" }> {
  return {
    ecosystem: "node",
    manifestContent,
    ...(lockfile && { lockfileKind: lockfile.kind, lockfileContent: lockfile.content }),
  };
}

describe("installNode — pre-step: copy manifest + lockfile", () => {
  it("writes package.json to depsPath before invoking the package manager", async () => {
    const { runner } = mockRunner(ok);
    const manifestContent = '{"name":"x","dependencies":{"jszip":"^3"}}';
    await installNode(depsPath, nodeManifest(manifestContent), runner);
    expect(readFileSync(join(depsPath, "package.json"), "utf-8")).toBe(manifestContent);
  });

  it("writes pnpm-lock.yaml when lockfileKind is pnpm", async () => {
    const { runner } = mockRunner(ok);
    const lockContent = "lockfileVersion: '9.0'\n";
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "pnpm", content: lockContent }),
      runner,
    );
    expect(readFileSync(join(depsPath, "pnpm-lock.yaml"), "utf-8")).toBe(lockContent);
  });

  it("writes yarn.lock when lockfileKind is yarn", async () => {
    const { runner } = mockRunner(ok);
    const lockContent = "# yarn lockfile v1\n";
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "yarn", content: lockContent }),
      runner,
    );
    expect(readFileSync(join(depsPath, "yarn.lock"), "utf-8")).toBe(lockContent);
  });

  it("writes package-lock.json when lockfileKind is npm", async () => {
    const { runner } = mockRunner(ok);
    const lockContent = '{"lockfileVersion":3}';
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "npm", content: lockContent }),
      runner,
    );
    expect(readFileSync(join(depsPath, "package-lock.json"), "utf-8")).toBe(lockContent);
  });
});

describe("installNode — package-manager dispatch", () => {
  it("calls `pnpm install --frozen-lockfile --dir=<depsPath>` when pnpm-lock.yaml is present", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "pnpm", content: "lockfileVersion: '9.0'\n" }),
      runner,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("pnpm");
    expect(calls[0]?.args).toEqual(["install", "--frozen-lockfile", `--dir=${depsPath}`]);
  });

  it("calls `yarn install --frozen-lockfile --cwd=<depsPath>` when yarn.lock is present", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "yarn", content: "# yarn\n" }),
      runner,
    );
    expect(calls[0]?.command).toBe("yarn");
    expect(calls[0]?.args).toEqual(["install", "--frozen-lockfile", `--cwd=${depsPath}`]);
  });

  it("calls `npm ci --prefix=<depsPath>` when package-lock.json is present", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "npm", content: '{"lockfileVersion":3}' }),
      runner,
    );
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.args).toEqual(["ci", `--prefix=${depsPath}`]);
  });

  it("calls `npm install --prefix=<depsPath>` (NOT npm ci) when no lockfile is present", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(depsPath, nodeManifest('{"name":"x"}'), runner);
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.args).toEqual(["install", `--prefix=${depsPath}`]);
  });
});

describe("real execFileRunner on Windows", () => {
  it("spawns npm via shell on Windows (real spawn, not mocked)", async () => {
    // This is an integration test that uses the REAL execFileRunner against
    // the real `npm` binary. It verifies that Node 24's CVE-2024-27980 fix
    // (which blocks direct .cmd spawn with EINVAL) is handled correctly by
    // execFileRunner's `shell: true` on Windows.
    //
    // Skipped on non-Windows (npm exists as a real binary there, no CMD).
    if (process.platform !== "win32") {
      // eslint-disable-next-line no-console
      return; // No-op on Linux/macOS — bare `npm` works directly.
    }
    // Import dynamically to avoid the eager import in non-Windows runners
    // accidentally pulling Windows-only code paths.
    const { execFileRunner } = await import("./script-deps-installers.js");
    const result = await execFileRunner("npm", ["--version"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/); // semver
  });
});

/** Whether a process is still running; a zombie, on Linux, is not. */
function isRunning(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // The state follows the parenthesised command name.
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe("execFileRunner — the real runner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-runner-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function script(name: string, lines: string[]): string {
    const path = join(dir, name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  it("hands back what a command printed, and its exit code", async () => {
    const prints = script("prints.cjs", [
      'process.stdout.write("on stdout");',
      'process.stderr.write("on stderr");',
      "process.exitCode = 3;",
    ]);
    const result = await execFileRunner("node", [prints], {});
    expect(result).toEqual({ stdout: "on stdout", stderr: "on stderr", exitCode: 3 });
  });

  // On Windows the command runs under cmd.exe, which starts and reports an
  // unknown name as a failed command instead.
  it.skipIf(process.platform === "win32")(
    "reports a command that cannot be started without an exit code",
    async () => {
      const result = await execFileRunner(join(dir, "no-such-command"), [], {});
      expect(result.exitCode).toBeNull();
    },
  );

  it("stopped by its signal, kills the command and every process it started", async () => {
    // The shape of an install: the installer starts a package's install
    // script, which starts a download of its own, and none of them returns.
    const pids = { parent: join(dir, "parent.pid"), grandchild: join(dir, "grandchild.pid") };
    const sleeper = script("sleeper.cjs", ["setInterval(() => {}, 1000);"]);
    const parent = script("parent.cjs", [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const grandchild = spawn(process.execPath, [${JSON.stringify(sleeper)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(pids.grandchild)}, String(grandchild.pid));`,
      `writeFileSync(${JSON.stringify(pids.parent)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ]);
    const readPid = (file: string) =>
      existsSync(file) ? Number.parseInt(readFileSync(file, "utf-8"), 10) : Number.NaN;

    const controller = new AbortController();
    const result = execFileRunner("node", [parent], { signal: controller.signal });
    try {
      expect(await waitUntil(() => Number.isInteger(readPid(pids.parent)), 10_000)).toBe(true);
      const grandchild = readPid(pids.grandchild);
      expect(isRunning(grandchild)).toBe(true);

      controller.abort();

      expect(
        await waitUntil(() => !isRunning(grandchild), 5_000),
        "the process the command started is still running",
      ).toBe(true);
      const settled = await Promise.race([
        result.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("still pending"), 5_000)),
      ]);
      expect(settled).toBe("settled");
      // Read once the command has settled: on POSIX the killed command is this
      // process's own child, and until Node has reaped it, a signal-0 probe
      // still finds it (a zombie) — read earlier, a dead process looks alive.
      expect(isRunning(readPid(pids.parent)), "the command itself is still running").toBe(false);
    } finally {
      // Whatever the outcome, nothing this test started outlives it.
      for (const file of [pids.grandchild, pids.parent]) {
        const pid = readPid(file);
        if (Number.isInteger(pid) && isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    }
  }, 30_000);
});

/** How a promise ended within `ms` — or that it had not, yet. */
async function outcomeWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<
  | { state: "resolved"; value: unknown }
  | { state: "rejected"; error: unknown }
  | { state: "still pending" }
> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<{ state: "still pending" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "still pending" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ state: "resolved" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error }),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("withInstallDeadline — the install's time limit, on a limit of milliseconds", () => {
  // The mechanism, called directly. The value every install gets, 180 s, is
  // held by a test of the resolver on a simulated clock.
  const slowPackage = '{"name":"x","dependencies":{"slow":"1.0.0"}}';

  it("stops an install that never returns, and names the time limit as its cause", async () => {
    const signals: AbortSignal[] = [];
    // An installer that never hands back control — a package fetching from a
    // host whose packets are dropped. It only records the signal it is given.
    const neverReturns: CommandRunner = (_command, _args, options) => {
      if (options.signal) signals.push(options.signal);
      return new Promise(() => {});
    };

    const outcome = await outcomeWithin(
      installNode(
        depsPath,
        nodeManifest(slowPackage),
        withInstallDeadline(neverReturns, "node", 50),
      ),
      4_000,
    );

    expect(outcome.state).toBe("rejected");
    const error = outcome.state === "rejected" ? outcome.error : undefined;
    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    const typed = error as ScriptDepsInstallError;
    expect(typed.code).toBe("SCRIPT_DEPS_INSTALL_FAILED");
    expect(typed.details).toMatchObject({ ecosystem: "node", exitCode: null, timeoutMs: 50 });
    expect(typed.details.command).toContain("npm install");
    expect(typed.message).toContain("timed out: the install did not finish within 50 ms");
    // The installer was told to stop — the production runner kills its tree.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  }, 10_000);

  it("keeps what a stopped installer printed before it stopped", async () => {
    const printsThenStops: CommandRunner = (_command, _args, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () =>
          resolve({
            stdout: "",
            stderr: "fetching https://unreachable.example/bin",
            exitCode: null,
          }),
        );
      });

    const outcome = await outcomeWithin(
      installNode(
        depsPath,
        nodeManifest(slowPackage),
        withInstallDeadline(printsThenStops, "node", 50),
      ),
      4_000,
    );

    expect(outcome.state).toBe("rejected");
    const error = (
      outcome.state === "rejected" ? outcome.error : undefined
    ) as ScriptDepsInstallError;
    expect(error.details.stderr).toBe("fetching https://unreachable.example/bin");
  }, 10_000);

  it("gives each command the time left: the limit is the install's, not one command's", async () => {
    const started: string[] = [];
    // The venv takes 120 ms, the pip install would take 120 ms more: each alone
    // fits in 200 ms, the two together do not.
    const slow: CommandRunner = (command, args) => {
      started.push([command, ...args].join(" "));
      return new Promise((resolve) => setTimeout(() => resolve(ok), 120));
    };

    const outcome = await outcomeWithin(
      installPython(
        depsPath,
        pythonRequirements("slow==1.0\n"),
        withInstallDeadline(slow, "python", 200),
      ),
      4_000,
    );

    expect(outcome.state).toBe("rejected");
    const error = (
      outcome.state === "rejected" ? outcome.error : undefined
    ) as ScriptDepsInstallError;
    expect(error.details.timeoutMs).toBe(200);
    expect(error.details.command).toContain("install -r");
    expect(started).toHaveLength(2);
  }, 10_000);

  it("lets an install that finishes in time through, untouched", async () => {
    const quick: CommandRunner = () => new Promise((resolve) => setTimeout(() => resolve(ok), 20));

    const outcome = await outcomeWithin(
      installNode(depsPath, nodeManifest(slowPackage), withInstallDeadline(quick, "node", 5_000)),
      4_000,
    );

    expect(outcome.state).toBe("resolved");
  }, 10_000);
});

describe("installNode — env hardening (registry allowlist)", () => {
  it("pins npm_config_registry to registry.npmjs.org for pnpm/npm", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "pnpm", content: "lockfileVersion: '9.0'\n" }),
      runner,
    );
    expect(calls[0]?.env?.npm_config_registry).toBe(NPM_REGISTRY_URL);
    // YARN_NPM_REGISTRY_SERVER is not relevant for pnpm.
    expect(calls[0]?.env?.YARN_NPM_REGISTRY_SERVER).toBeUndefined();
  });

  it("pins YARN_NPM_REGISTRY_SERVER and npm_config_registry for yarn", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "yarn", content: "# yarn\n" }),
      runner,
    );
    expect(calls[0]?.env?.YARN_NPM_REGISTRY_SERVER).toBe(YARN_REGISTRY_URL);
    expect(calls[0]?.env?.npm_config_registry).toBe(NPM_REGISTRY_URL);
  });

  it.each([
    ["npm install", undefined],
    ["npm ci", { kind: "npm" as const, content: '{"lockfileVersion":3}' }],
    ["pnpm install", { kind: "pnpm" as const, content: "lockfileVersion: '9.0'\n" }],
  ])("turns off npm's update check for %s, so a failed install prints only its own output", async (_label, lockfile) => {
    const { runner, calls } = mockRunner(ok);
    await installNode(depsPath, nodeManifest('{"name":"x"}', lockfile), runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.npm_config_update_notifier).toBe("false");
  });

  it("uses depsPath as cwd for the install spawn", async () => {
    const { runner, calls } = mockRunner(ok);
    await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "npm", content: '{"lockfileVersion":3}' }),
      runner,
    );
    expect(calls[0]?.cwd).toBe(depsPath);
  });
});

describe("installNode — failure handling", () => {
  it("throws ScriptDepsInstallError when pnpm install fails", async () => {
    const { runner } = mockRunner({
      stdout: "",
      stderr: "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE",
      exitCode: 1,
    });

    const error = await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "pnpm", content: "lockfileVersion: '9.0'\n" }),
      runner,
    )
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    expect(error?.details.ecosystem).toBe("node");
    expect(error?.details.exitCode).toBe(1);
    expect(error?.details.stderr).toContain("FROZEN_LOCKFILE");
    expect(error?.details.command).toContain("pnpm install --frozen-lockfile");
  });

  it("throws ScriptDepsInstallError when npm ci fails", async () => {
    const { runner } = mockRunner({
      stdout: "",
      stderr: "npm ERR! lockfile out of date",
      exitCode: 1,
    });

    const error = await installNode(
      depsPath,
      nodeManifest('{"name":"x"}', { kind: "npm", content: '{"lockfileVersion":3}' }),
      runner,
    )
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);

    expect(error?.details.ecosystem).toBe("node");
    expect(error?.details.command).toContain("npm ci");
  });

  it("propagates exitCode = null when npm did not spawn (ENOENT)", async () => {
    const { runner } = mockRunner({ stdout: "", stderr: "", exitCode: null });
    const error = await installNode(depsPath, nodeManifest('{"name":"x"}'), runner)
      .then(() => null)
      .catch((e) => e as ScriptDepsInstallError);
    expect(error?.details.exitCode).toBeNull();
  });
});
