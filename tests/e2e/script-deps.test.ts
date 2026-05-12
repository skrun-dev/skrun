/**
 * E2E integration: script dependency resolution (#57).
 *
 * Exercises the full schema → DepsCache → installer → resolver chain on real
 * fixture bundles, with `child_process.spawn` replaced by an injectable
 * `CommandRunner` that simulates pip / npm without touching the network or
 * the actual local Python / Node toolchain.
 *
 * Per-module unit tests already cover the individual contracts; this file
 * verifies the cross-package wiring: schema's `detectManifest` produces a
 * `ManifestInfo` that the runtime cache can hash and the runtime installer
 * can dispatch on.
 *
 * Live install behavior (real pip + real npm) is exercised by the live E2E
 * tests in `tests/e2e.ts` (Tasks 8.2 + 8.3).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepsCache } from "../../packages/runtime/src/cache/deps-cache.js";
import { ScriptDepsInstallError } from "../../packages/runtime/src/errors.js";
import type {
  CommandResult,
  CommandRunner,
} from "../../packages/runtime/src/tools/script-deps-installers.js";
import {
  resolveScriptDeps,
  ScriptDepsResolver,
} from "../../packages/runtime/src/tools/script-deps-resolver.js";
import { detectManifest } from "../../packages/schema/src/manifests.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const PYTHON_FIXTURE = join(FIXTURES, "script-deps-python");
const NODE_FIXTURE = join(FIXTURES, "script-deps-node");
const NONE_FIXTURE = join(FIXTURES, "script-deps-none");

let cacheDir: string;
let cache: DepsCache;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "skrun-e2e-deps-cache-"));
  cache = new DepsCache({ rootDir: cacheDir });
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

interface RecordedCall {
  command: string;
  args: string[];
}

function recorderRunner(result: CommandResult = ok): {
  runner: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    return result;
  };
  return { runner, calls };
}

/**
 * Pose the pip/npm install actually populated the install target — the
 * injected runner doesn't actually create files, but the cache's atomic
 * rename only succeeds if the tmp dir exists. We simulate the install by
 * writing a marker file when the runner is called.
 */
function recorderRunnerWithFakeInstall(): {
  runner: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args] });
    // The cwd is the tmp install dir on the second-and-later calls (after venv
    // create). For Python: write a tiny venv layout. For Node: write a marker.
    const cwd = options.cwd;
    if (cwd && existsSync(cwd)) {
      // Python venv create: `python -m venv <venvPath>`.
      if (args[0] === "-m" && args[1] === "venv" && args[2]) {
        const venvPath = args[2];
        mkdirSync(join(venvPath, "bin"), { recursive: true });
        writeFileSync(join(venvPath, "bin", "python"), "#!");
        writeFileSync(join(venvPath, "bin", "pip"), "#!");
      }
      // npm install --prefix=<dir> / pnpm install --dir=<dir>: write node_modules.
      if (command === "npm" || command === "pnpm" || command === "yarn") {
        mkdirSync(join(cwd, "node_modules", "marker"), { recursive: true });
      }
      // pip install (any flavor): write a site-packages marker.
      if (command.endsWith("pip") || command.endsWith("pip.exe")) {
        const venvLib = join(cwd, "venv", "lib", "python3.11", "site-packages", "marker");
        mkdirSync(venvLib, { recursive: true });
      }
    }
    return ok;
  };
  return { runner, calls };
}

describe("E2E: script-deps — schema-detected manifest content shape", () => {
  it("Python fixture: detectManifest returns content-only ManifestInfo", () => {
    const manifest = detectManifest(PYTHON_FIXTURE);
    expect(manifest.ecosystem).toBe("python");
    if (manifest.ecosystem !== "python") throw new Error("narrowing failed");
    expect(manifest.manifestKind).toBe("requirements");
    expect(manifest.manifestContent).toContain("pandas==2.2.3");
    expect(manifest.manifestContent).toContain("matplotlib==3.10.0");
    // Confirm no path leakage in the public shape.
    expect(Object.keys(manifest)).not.toContain("manifestPath");
    expect(Object.keys(manifest)).not.toContain("bundleRoot");
  });

  it("Node fixture: detects package.json + package-lock.json", () => {
    const manifest = detectManifest(NODE_FIXTURE);
    if (manifest.ecosystem !== "node") throw new Error("narrowing failed");
    expect(manifest.manifestContent).toContain("jszip");
    expect(manifest.lockfileKind).toBe("npm");
    expect(manifest.lockfileContent).toContain("lockfileVersion");
  });

  it("None fixture: detects ecosystem 'none'", () => {
    const manifest = detectManifest(NONE_FIXTURE);
    expect(manifest.ecosystem).toBe("none");
  });
});

describe("E2E: script-deps — full resolve chain (Python)", () => {
  it("VT-12 cold install: invokes Python installer + populates cache", async () => {
    const { runner, calls } = recorderRunnerWithFakeInstall();
    const result = await resolveScriptDeps(PYTHON_FIXTURE, cache, { runner });

    expect(result?.ecosystem).toBe("python");
    expect(result?.depsPath.startsWith(cacheDir)).toBe(true);
    // Two spawn calls: venv create + pip install -r.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("-m");
    expect(calls[0]?.args).toContain("venv");
    expect(calls[1]?.args).toContain("install");
    expect(calls[1]?.args).toContain("-r");
    // Cache directory exists on disk.
    expect(existsSync(result?.depsPath ?? "")).toBe(true);
  });

  it("VT-13 warm install: second resolve hits cache, skips installer", async () => {
    const r1 = recorderRunnerWithFakeInstall();
    await resolveScriptDeps(PYTHON_FIXTURE, cache, { runner: r1.runner });
    expect(r1.calls).toHaveLength(2);

    // Second resolve via a fresh runner — should not be invoked at all.
    const r2 = recorderRunner();
    await resolveScriptDeps(PYTHON_FIXTURE, cache, { runner: r2.runner });
    expect(r2.calls).toHaveLength(0);
  });
});

describe("E2E: script-deps — full resolve chain (Node)", () => {
  it("VT-1 cold install: invokes npm ci with lockfile and writes manifest to depsPath", async () => {
    const { runner, calls } = recorderRunnerWithFakeInstall();
    const result = await resolveScriptDeps(NODE_FIXTURE, cache, { runner });

    expect(result?.ecosystem).toBe("node");
    expect(result?.depsPath.startsWith(cacheDir)).toBe(true);
    // package-lock.json present → `npm ci --prefix=<depsPath>`.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.args[0]).toBe("ci");
    expect(calls[0]?.args[1]).toMatch(/--prefix=/);
  });
});

describe("E2E: script-deps — none ecosystem (RT-1 backward compat)", () => {
  it("VT-4 returns null without invoking the runner", async () => {
    const { runner, calls } = recorderRunner();
    const result = await resolveScriptDeps(NONE_FIXTURE, cache, { runner });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("E2E: script-deps — install failure (VT-19, SC-19)", () => {
  it("propagates ScriptDepsInstallError + leaves no cache entry behind", async () => {
    const failingRunner: CommandRunner = async () => ({
      stdout: "",
      stderr: "ERROR: package not found",
      exitCode: 1,
    });

    await expect(
      resolveScriptDeps(PYTHON_FIXTURE, cache, { runner: failingRunner }),
    ).rejects.toBeInstanceOf(ScriptDepsInstallError);

    // No leftover cache entry.
    const entries = await cache.listEntries();
    expect(entries).toEqual([]);
  });

  it("memoizes failure across multiple resolver.resolve() calls (VT-20 prep)", async () => {
    const failingRunner = recorderRunner({
      stdout: "",
      stderr: "ERROR: distribution missing",
      exitCode: 1,
    });
    const resolver = new ScriptDepsResolver(PYTHON_FIXTURE, cache, {
      runner: failingRunner.runner,
    });

    await expect(resolver.resolve()).rejects.toBeInstanceOf(ScriptDepsInstallError);
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ScriptDepsInstallError);
    // Only ONE installer attempt across the two resolve calls (failure cached).
    expect(failingRunner.calls).toHaveLength(1);
  });
});
