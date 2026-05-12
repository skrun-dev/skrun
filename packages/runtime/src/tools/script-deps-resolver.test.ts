// Unit tests for `ScriptDepsResolver` (#57 Task 5.1).
//
// Tests inject mocked `detect` + `runner` — no filesystem reads, no spawns.
// The resolver's job is purely orchestration (detect → cache.ensure →
// dispatch installer), so testing the wiring is sufficient.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepsCache } from "../cache/deps-cache.js";
import { ScriptDepsInstallError } from "../errors.js";
import type { CommandResult, CommandRunner } from "./script-deps-installers.js";
import { resolveScriptDeps, ScriptDepsResolver } from "./script-deps-resolver.js";

let rootDir: string;
let cache: DepsCache;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "skrun-resolver-test-"));
  cache = new DepsCache({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

function passingRunner(): CommandRunner {
  return async () => ok;
}

function failingRunner(stderr: string, exitCode = 1): CommandRunner {
  return async () => ({ stdout: "", stderr, exitCode });
}

describe("resolveScriptDeps — none ecosystem", () => {
  it("returns null when detectManifest reports no manifest", async () => {
    const result = await resolveScriptDeps("/any/bundle", cache, {
      detect: () => ({ ecosystem: "none" }),
    });
    expect(result).toBeNull();
  });

  it("never invokes the runner when ecosystem is 'none'", async () => {
    const runner = vi.fn(passingRunner());
    await resolveScriptDeps("/any/bundle", cache, {
      detect: () => ({ ecosystem: "none" }),
      runner,
    });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("resolveScriptDeps — Python dispatch", () => {
  it("returns ecosystem 'python' and a depsPath under cache rootDir", async () => {
    const manifest: ManifestInfo = {
      ecosystem: "python",
      manifestKind: "requirements",
      manifestContent: "pandas==2.2.3\n",
    };
    const result = await resolveScriptDeps("/any/bundle", cache, {
      detect: () => manifest,
      runner: passingRunner(),
    });

    expect(result?.ecosystem).toBe("python");
    expect(result?.depsPath.startsWith(rootDir)).toBe(true);
    // Hash dir was actually populated (DepsCache.ensure renamed the tmp).
    const hash = result?.depsPath.split(/[/\\]/).pop() ?? "";
    expect(cache.has(hash)).toBe(true);
  });

  it("invokes the Python installer (venv create + pip install -r) via the runner", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return ok;
    };
    const manifest: ManifestInfo = {
      ecosystem: "python",
      manifestKind: "requirements",
      manifestContent: "pandas\n",
    };

    await resolveScriptDeps("/any/bundle", cache, { detect: () => manifest, runner });

    // First call = venv create (python -m venv ...).
    expect(calls[0]).toContain("-m venv");
    // Second call = pip install -r requirements.txt.
    expect(calls[1]).toContain("install -r");
    expect(calls[1]).toContain("requirements.txt");
  });
});

describe("resolveScriptDeps — Node dispatch", () => {
  it("returns ecosystem 'node' and a depsPath under cache rootDir", async () => {
    const manifest: ManifestInfo = {
      ecosystem: "node",
      manifestContent: '{"name":"x","dependencies":{"jszip":"^3"}}',
    };
    const result = await resolveScriptDeps("/any/bundle", cache, {
      detect: () => manifest,
      runner: passingRunner(),
    });

    expect(result?.ecosystem).toBe("node");
    expect(result?.depsPath.startsWith(rootDir)).toBe(true);
  });

  it("invokes `npm install --prefix=<depsPath>` when no lockfile is present", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return ok;
    };
    const manifest: ManifestInfo = { ecosystem: "node", manifestContent: '{"name":"x"}' };

    await resolveScriptDeps("/any/bundle", cache, { detect: () => manifest, runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.args[0]).toBe("install");
  });

  it("invokes `pnpm install --frozen-lockfile` when pnpm-lock.yaml is detected", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return ok;
    };
    const manifest: ManifestInfo = {
      ecosystem: "node",
      manifestContent: '{"name":"x"}',
      lockfileKind: "pnpm",
      lockfileContent: "lockfileVersion: '9.0'\n",
    };

    await resolveScriptDeps("/any/bundle", cache, { detect: () => manifest, runner });

    expect(calls[0]?.command).toBe("pnpm");
    expect(calls[0]?.args).toContain("--frozen-lockfile");
  });
});

describe("resolveScriptDeps — failure propagation", () => {
  it("propagates ScriptDepsInstallError when the Python installer fails", async () => {
    const manifest: ManifestInfo = {
      ecosystem: "python",
      manifestKind: "requirements",
      manifestContent: "broken==1.0\n",
    };
    const runner = failingRunner("ERROR: distribution not found");

    await expect(
      resolveScriptDeps("/any/bundle", cache, { detect: () => manifest, runner }),
    ).rejects.toBeInstanceOf(ScriptDepsInstallError);
  });

  it("propagates ScriptDepsInstallError when the Node installer fails", async () => {
    const manifest: ManifestInfo = {
      ecosystem: "node",
      manifestContent: '{"name":"x","dependencies":{"missing":"1.0"}}',
    };
    const runner = failingRunner("npm ERR! 404 not found");

    await expect(
      resolveScriptDeps("/any/bundle", cache, { detect: () => manifest, runner }),
    ).rejects.toBeInstanceOf(ScriptDepsInstallError);
  });

  it("does NOT leave a cache entry behind when install fails (cleanup via DepsCache)", async () => {
    const manifest: ManifestInfo = {
      ecosystem: "python",
      manifestKind: "requirements",
      manifestContent: "broken\n",
    };

    await expect(
      resolveScriptDeps("/any/bundle", cache, {
        detect: () => manifest,
        runner: failingRunner("fail"),
      }),
    ).rejects.toBeInstanceOf(ScriptDepsInstallError);

    const entries = await cache.listEntries();
    expect(entries).toEqual([]);
  });
});

describe("ScriptDepsResolver — memoized resolve()", () => {
  it("caches the resolution promise (detect + install run once across N calls)", async () => {
    const detect = vi.fn(
      (): ManifestInfo => ({
        ecosystem: "python",
        manifestKind: "requirements",
        manifestContent: "pandas\n",
      }),
    );
    const runner = vi.fn(passingRunner());
    const resolver = new ScriptDepsResolver("/any/bundle", cache, { detect, runner });

    const [a, b, c] = await Promise.all([
      resolver.resolve(),
      resolver.resolve(),
      resolver.resolve(),
    ]);

    expect(a).toEqual(b);
    expect(a).toEqual(c);
    // detect called once — the resolver memoizes the promise itself.
    expect(detect).toHaveBeenCalledTimes(1);
    // runner called twice (venv + pip), not 6 times (3 calls × 2 spawns).
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("caches the rejection so persistent failure does not retry on every call", async () => {
    const detect = vi.fn(
      (): ManifestInfo => ({
        ecosystem: "python",
        manifestKind: "requirements",
        manifestContent: "broken\n",
      }),
    );
    const runner = vi.fn(failingRunner("install failed"));
    const resolver = new ScriptDepsResolver("/any/bundle", cache, { detect, runner });

    await expect(resolver.resolve()).rejects.toBeInstanceOf(ScriptDepsInstallError);
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ScriptDepsInstallError);
    // detect called once, even though the promise rejected — the rejection is cached.
    expect(detect).toHaveBeenCalledTimes(1);
    // runner called once (the venv create that failed) — not retried.
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("returns null on every call when ecosystem is 'none' (cached lookup)", async () => {
    const detect = vi.fn((): ManifestInfo => ({ ecosystem: "none" }));
    const resolver = new ScriptDepsResolver("/any/bundle", cache, { detect });

    expect(await resolver.resolve()).toBeNull();
    expect(await resolver.resolve()).toBeNull();
    expect(detect).toHaveBeenCalledTimes(1);
  });
});
