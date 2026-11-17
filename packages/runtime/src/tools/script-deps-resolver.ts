// Glue between schema-level manifest detection, the disk-backed DepsCache,
// and the per-ecosystem installers. Called once per ScriptToolProvider
// instance (memoized) before the first script spawns.

import { lstat, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEcosystem, ManifestInfo } from "@skrun-dev/schema";
import { detectManifest } from "@skrun-dev/schema";
import type { DepsCache } from "../cache/deps-cache.js";
import { createLogger } from "../logger.js";
import { errorFields } from "../utils/error-fields.js";
import {
  type CommandRunner,
  execFileRunner,
  installNode,
  installPython,
  type NodeManifest,
  type PythonManifest,
  withInstallDeadline,
} from "./script-deps-installers.js";

const log = createLogger("runtime:deps");

/**
 * How long installing a bundle's dependencies may take, in total — on a server
 * that runs scripts itself as in a cloud sandbox: every install goes through
 * `resolveScriptDeps`. Each command gets the time left; once it is spent, the
 * command running is killed with what it started, and the install fails with
 * `SCRIPT_DEPS_INSTALL_FAILED`, naming the limit.
 *
 * The value comes from the sandbox. Its runner installs during its `/init`,
 * which the harness waits for at most `INIT_RPC_TIMEOUT_MS` (300 s,
 * `adapter/flyio/adapter.ts`); after the install, `/init` may still connect an
 * MCP server, for up to `DEFAULT_MCP_CONNECT_TIMEOUT_MS` (120 s,
 * `tools/mcp-provider.ts`). 300 - 120 = 180: a stopped install still leaves
 * `/init` the time to answer, and the cause reaches the first tool call instead
 * of being lost in a timed-out `/init`. A test of the adapter compares the three.
 *
 * The usual way to reach it: a package that downloads something, while it
 * installs, from a host the sandbox does not let through — the connection is
 * dropped, not refused, and waits. Not a setting: neither authors, operators
 * nor the callers of this package change it. The limit's mechanism is tested on
 * `withInstallDeadline` itself, with a limit of milliseconds; this value, on a
 * simulated clock.
 */
export const SCRIPT_DEPS_INSTALL_TIMEOUT_MS = 180_000;

export interface ResolvedDeps {
  ecosystem: ManifestEcosystem;
  /** Absolute path to the cached deps root (`<rootDir>/<hash>/`). */
  depsPath: string;
}

export interface ResolveOptions {
  /**
   * Inject a custom command runner (for tests or future cloud sandboxing).
   * Defaults to `execFileRunner` (real child processes).
   */
  runner?: CommandRunner;
  /**
   * Override the manifest detector — used by tests to bypass filesystem reads.
   * Defaults to `@skrun-dev/schema`'s `detectManifest`.
   */
  detect?: (bundleRoot: string) => ManifestInfo;
}

/**
 * Resolve script dependencies for the bundle at `bundleRoot`.
 *
 * Returns:
 *   - `null` when the bundle declares no manifest (`ecosystem: "none"`) —
 *     callers spawn scripts with the system runtime.
 *   - `{ ecosystem, depsPath }` when a manifest is present — callers spawn
 *     scripts with the cached deps (Node: `NODE_PATH=<depsPath>/node_modules`,
 *     plus the `<bundleRoot>/node_modules` link of `linkNodeModules`;
 *     Python: `<depsPath>/venv/{bin,Scripts}/python`).
 *
 * Throws `ScriptDepsInstallError` (propagated from the installer) when the
 * install fails; `ScriptToolProvider` catches this and surfaces it to the
 * LLM tool-call loop without spawning the script.
 *
 * Idempotent on cache hits: the underlying `DepsCache.ensure` short-circuits
 * to a path lookup if `<rootDir>/<hash>/` already exists.
 */
export async function resolveScriptDeps(
  bundleRoot: string,
  depsCache: DepsCache,
  options: ResolveOptions = {},
): Promise<ResolvedDeps | null> {
  const detect = options.detect ?? detectManifest;
  const runner = options.runner ?? execFileRunner;

  const manifest = detect(bundleRoot);
  if (manifest.ecosystem === "none") return null;

  const depsPath = await depsCache.ensure(manifest, async (tmpPath) => {
    // The limit counts from here, where the install starts: a cache hit
    // installs nothing, and a call that joins an install of the same manifest
    // already running in this process waits on that install's own limit.
    const bounded = withInstallDeadline(runner, manifest.ecosystem, SCRIPT_DEPS_INSTALL_TIMEOUT_MS);
    if (manifest.ecosystem === "python") {
      await installPython(tmpPath, manifest as PythonManifest, bounded);
    } else {
      await installNode(tmpPath, manifest as NodeManifest, bounded);
    }
  });

  if (manifest.ecosystem === "node") {
    await linkNodeModules(bundleRoot, depsPath);
  }

  return { ecosystem: manifest.ecosystem, depsPath };
}

/** What `linkNodeModules` did — returned for its callers' tests and logs. */
export type NodeModulesLinkOutcome = "linked" | "kept-existing" | "nothing-installed" | "failed";

/**
 * Make installed Node dependencies visible to ES-module scripts.
 *
 * `NODE_PATH`, set on every script spawn, only reaches `require()`: Node's ES
 * module resolver ignores it, and finds a bare `import x from "pkg"` by walking
 * up from the script's directory to a `node_modules` directory. A link named
 * `node_modules` at the bundle root, pointing at the installed tree, is on that
 * walk for every script of the bundle — CommonJS and ES modules then load the
 * same files.
 *
 * It never replaces anything. When the bundle root already holds an entry of
 * that name — a directory the agent shipped, a file, a link, dangling or not —
 * it is left as it is and nothing is created; `lstat`, because an existence
 * check follows links and reports a dangling one as absent. The link's path is
 * fixed (`<bundleRoot>/node_modules`) and its target is the cache entry just
 * resolved, never a path read from the bundle; creating a link never follows
 * one. A directory junction on Windows (no privilege needed), a symlink
 * elsewhere: deleting the bundle directory removes the link, not its target.
 *
 * Best effort: a link that cannot be made is logged and resolution still
 * succeeds — CommonJS scripts keep working through `NODE_PATH`.
 */
export async function linkNodeModules(
  bundleRoot: string,
  depsPath: string,
): Promise<NodeModulesLinkOutcome> {
  const target = join(depsPath, "node_modules");
  const linkPath = join(bundleRoot, "node_modules");

  // An install that produced no tree (a manifest without dependencies) has
  // nothing to point at.
  const installed = await stat(target).catch(() => null);
  if (!installed?.isDirectory()) return "nothing-installed";

  const existing = await lstat(linkPath).catch((err: NodeJS.ErrnoException) =>
    err.code === "ENOENT" ? null : err,
  );
  // A filesystem error's message quotes the paths it failed on: the lines below
  // say its class and code (EPERM, EACCES…), and the bundle root.
  if (existing !== null) {
    if (existing instanceof Error) {
      log.warn(
        { event: "node_modules_link_failed", bundleRoot, ...errorFields(existing) },
        "Could not inspect the bundle's node_modules entry — ES-module scripts may not find their dependencies",
      );
      return "failed";
    }
    return "kept-existing";
  }

  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return "linked";
  } catch (err) {
    // Created between the check and here: still never replaced.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "kept-existing";
    log.warn(
      { event: "node_modules_link_failed", bundleRoot, ...errorFields(err) },
      "Could not link the installed node_modules into the bundle — ES-module scripts may not find their dependencies",
    );
    return "failed";
  }
}

/**
 * Stateful wrapper for the common `ScriptToolProvider` pattern: resolve once
 * per bundle, memoize the promise (success OR failure). On
 * persistent install failure, retrying every tool call would hammer
 * registries — the cached rejection is rethrown until the provider is
 * reconstructed.
 */
export class ScriptDepsResolver {
  private resolved?: Promise<ResolvedDeps | null>;

  constructor(
    private readonly bundleRoot: string,
    private readonly depsCache: DepsCache,
    private readonly options: ResolveOptions = {},
  ) {}

  /** Returns the cached resolution, lazy-creating it on first call. */
  async resolve(): Promise<ResolvedDeps | null> {
    if (!this.resolved) {
      this.resolved = resolveScriptDeps(this.bundleRoot, this.depsCache, this.options);
    }
    return this.resolved;
  }
}
