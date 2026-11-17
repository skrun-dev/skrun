// Unit tests for `ScriptDepsResolver` (#57 Task 5.1).
//
// Tests inject mocked `detect` + `runner` — no filesystem reads, no spawns.
// The resolver's job is purely orchestration (detect → cache.ensure →
// dispatch installer), so testing the wiring is sufficient.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestInfo } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepsCache } from "../cache/deps-cache.js";
import { ScriptDepsInstallError } from "../errors.js";
import type { CommandResult, CommandRunner } from "./script-deps-installers.js";
import {
  linkNodeModules,
  resolveScriptDeps,
  SCRIPT_DEPS_INSTALL_TIMEOUT_MS,
  ScriptDepsResolver,
} from "./script-deps-resolver.js";

/**
 * A fault to throw from `lstat` or `symlink` instead of calling them — unset,
 * every call goes to the real function. And the lines the module's loggers
 * write, as written, so a case reads what reaches the log store.
 */
const fsFaults = vi.hoisted(() => ({
  lstat: undefined as Error | undefined,
  symlink: undefined as Error | undefined,
}));
const written = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = actual.lstat as (...args: unknown[]) => Promise<unknown>;
  const symlink = actual.symlink as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    lstat: (...args: unknown[]) =>
      fsFaults.lstat ? Promise.reject(fsFaults.lstat) : lstat(...args),
    symlink: (...args: unknown[]) =>
      fsFaults.symlink ? Promise.reject(fsFaults.symlink) : symlink(...args),
  };
});
vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      actual.createLogger(name, {
        write: (line: string) => {
          written.push(line);
        },
      }),
  };
});

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

describe("resolveScriptDeps — the install's time limit", () => {
  // The limit's mechanism is tested on `withInstallDeadline` itself, with a
  // limit of milliseconds (script-deps-installers.test.ts). This case holds the
  // value the resolver gives every install, 180 s, without waiting for it: no
  // real process runs here, so the clock can be a simulated one.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives every install SCRIPT_DEPS_INSTALL_TIMEOUT_MS, 180 s, on a simulated clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const nodeManifest: ManifestInfo = {
      ecosystem: "node",
      manifestContent: '{"name":"x","dependencies":{"slow":"1.0.0"}}',
    };
    let signal: AbortSignal | undefined;
    let started: () => void = () => {};
    const installStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    // An installer that hands back control only once it is told to stop.
    const untilStopped: CommandRunner = (_command, _args, options) => {
      signal = options.signal;
      started();
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () =>
          resolve({ stdout: "", stderr: "", exitCode: null }),
        );
      });
    };

    const outcome = resolveScriptDeps("/any/bundle", cache, {
      detect: () => nodeManifest,
      runner: untilStopped,
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    await installStarted;

    await vi.advanceTimersByTimeAsync(SCRIPT_DEPS_INSTALL_TIMEOUT_MS - 1);
    expect(signal?.aborted, "the install, stopped before its limit").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted, "the install, still running at its limit").toBe(true);

    const error = await outcome;
    expect(error).toBeInstanceOf(ScriptDepsInstallError);
    const typed = error as ScriptDepsInstallError;
    expect(typed.details).toMatchObject({
      ecosystem: "node",
      exitCode: null,
      timeoutMs: SCRIPT_DEPS_INSTALL_TIMEOUT_MS,
    });
    expect(typed.message).toContain("timed out: the install did not finish within 180 s");
    // Nothing half-installed is kept.
    expect(await cache.listEntries()).toEqual([]);
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

describe("the bundle-root node_modules link", () => {
  // These cases touch the filesystem: the link is a filesystem effect. The
  // installer is still simulated — it writes one tiny package where npm would.
  let bundleRoot: string;

  beforeEach(() => {
    bundleRoot = mkdtempSync(join(tmpdir(), "skrun-link-bundle-"));
  });

  afterEach(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  const nodeManifest: ManifestInfo = {
    ecosystem: "node",
    manifestContent: '{"name":"x","dependencies":{"witness":"1.0.0"}}',
  };

  /** Writes `<cwd>/node_modules/witness` the way an install would. */
  const installingRunner: CommandRunner = async (_command, _args, options) => {
    const pkg = join(options.cwd ?? "", "node_modules", "witness");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "index.js"), "module.exports = 'installed';");
    return ok;
  };

  const linkPath = () => join(bundleRoot, "node_modules");

  it("links <bundleRoot>/node_modules to the installed tree", async () => {
    const result = await resolveScriptDeps(bundleRoot, cache, {
      detect: () => nodeManifest,
      runner: installingRunner,
    });

    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath())).toBe(
      realpathSync(join(result?.depsPath ?? "", "node_modules")),
    );
    expect(readFileSync(join(linkPath(), "witness", "index.js"), "utf-8")).toBe(
      "module.exports = 'installed';",
    );
  });

  it("links on a cache hit too — a second bundle reusing the same install", async () => {
    await resolveScriptDeps(bundleRoot, cache, {
      detect: () => nodeManifest,
      runner: installingRunner,
    });
    const secondBundle = mkdtempSync(join(tmpdir(), "skrun-link-bundle-2-"));
    try {
      const runner = vi.fn(installingRunner);
      await resolveScriptDeps(secondBundle, cache, { detect: () => nodeManifest, runner });
      expect(runner).not.toHaveBeenCalled();
      expect(lstatSync(join(secondBundle, "node_modules")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(secondBundle, { recursive: true, force: true });
    }
  });

  it("keeps a node_modules directory the bundle ships, untouched", async () => {
    mkdirSync(join(linkPath(), "shipped"), { recursive: true });
    writeFileSync(join(linkPath(), "shipped", "index.js"), "module.exports = 'shipped';");

    const result = await resolveScriptDeps(bundleRoot, cache, {
      detect: () => nodeManifest,
      runner: installingRunner,
    });

    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(false);
    expect(readdirSync(linkPath())).toEqual(["shipped"]);
    expect(readFileSync(join(linkPath(), "shipped", "index.js"), "utf-8")).toBe(
      "module.exports = 'shipped';",
    );
    // The resolution itself still succeeded: NODE_PATH serves require().
    expect(result?.ecosystem).toBe("node");
  });

  it("keeps a link the bundle ships, dangling or not, and never follows it", async () => {
    const elsewhere = join(bundleRoot, "elsewhere");
    symlinkSync(elsewhere, linkPath(), process.platform === "win32" ? "junction" : "dir");

    const depsPath = await cache.ensure(nodeManifest, async (tmp) => {
      await installingRunner("npm", [], { cwd: tmp });
    });
    const outcome = await linkNodeModules(bundleRoot, depsPath);

    expect(outcome).toBe("kept-existing");
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    // Nothing was created through it.
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("links nothing when the install produced no node_modules", async () => {
    await resolveScriptDeps(bundleRoot, cache, {
      detect: () => nodeManifest,
      runner: passingRunner(),
    });
    expect(existsSync(linkPath())).toBe(false);
    expect(() => lstatSync(linkPath())).toThrow();
  });

  it("links nothing for Python dependencies", async () => {
    await resolveScriptDeps(bundleRoot, cache, {
      detect: () => ({
        ecosystem: "python",
        manifestKind: "requirements",
        manifestContent: "six\n",
      }),
      runner: passingRunner(),
    });
    expect(() => lstatSync(linkPath())).toThrow();
  });

  it("deleting the bundle directory removes the link, never the installed tree", async () => {
    const result = await resolveScriptDeps(bundleRoot, cache, {
      detect: () => nodeManifest,
      runner: installingRunner,
    });
    const installedFile = join(result?.depsPath ?? "", "node_modules", "witness", "index.js");

    rmSync(bundleRoot, { recursive: true, force: true });

    expect(existsSync(bundleRoot)).toBe(false);
    expect(readFileSync(installedFile, "utf-8")).toBe("module.exports = 'installed';");
  });

  // A filesystem error's message quotes the paths it failed on: the line says
  // its class and code, and the bundle root, a temporary directory of ours.
  describe("a link that cannot be made is logged by the error's class and code", () => {
    const LEAK = "leak-91c4";

    afterEach(() => {
      fsFaults.lstat = undefined;
      fsFaults.symlink = undefined;
      written.length = 0;
    });

    const installed = () =>
      cache.ensure(nodeManifest, async (tmp) => {
        await installingRunner("npm", [], { cwd: tmp });
      });

    const linkFailedLine = () => {
      const line = written.find((l) => l.includes('"event":"node_modules_link_failed"'));
      return { raw: line ?? "", fields: JSON.parse(line ?? "{}") as Record<string, unknown> };
    };

    it("when the bundle's entry cannot be inspected", async () => {
      const depsPath = await installed();
      written.length = 0;
      fsFaults.lstat = Object.assign(new Error(`EACCES: permission denied, lstat '/${LEAK}'`), {
        code: "EACCES",
      });

      expect(await linkNodeModules(bundleRoot, depsPath)).toBe("failed");

      const line = linkFailedLine();
      expect(line.raw).not.toContain(LEAK);
      expect(line.fields).not.toHaveProperty("error");
      expect(line.fields).toMatchObject({ bundleRoot, error_name: "Error", error_code: "EACCES" });
    });

    it("when the link cannot be created", async () => {
      const depsPath = await installed();
      written.length = 0;
      fsFaults.symlink = Object.assign(
        new Error(`EPERM: operation not permitted, symlink '/${LEAK}'`),
        { code: "EPERM" },
      );

      expect(await linkNodeModules(bundleRoot, depsPath)).toBe("failed");

      const line = linkFailedLine();
      expect(line.raw).not.toContain(LEAK);
      expect(line.fields).not.toHaveProperty("error");
      expect(line.fields).toMatchObject({ bundleRoot, error_name: "Error", error_code: "EPERM" });
    });
  });
});
