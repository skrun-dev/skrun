// Glue between schema-level manifest detection, the disk-backed DepsCache,
// and the per-ecosystem installers. Called once per ScriptToolProvider
// instance (memoized) before the first script spawns.

import type { ManifestEcosystem, ManifestInfo } from "@skrun-dev/schema";
import { detectManifest } from "@skrun-dev/schema";
import type { DepsCache } from "../cache/deps-cache.js";
import {
  type CommandRunner,
  execFileRunner,
  installNode,
  installPython,
  type NodeManifest,
  type PythonManifest,
} from "./script-deps-installers.js";

export interface ResolvedDeps {
  ecosystem: ManifestEcosystem;
  /** Absolute path to the cached deps root (`<rootDir>/<hash>/`). */
  depsPath: string;
}

export interface ResolveOptions {
  /**
   * Inject a custom command runner (for tests or future cloud sandboxing).
   * Defaults to `execFileRunner` (real `child_process.execFile`).
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
 *     scripts with the cached deps (Node: `NODE_PATH=<depsPath>/node_modules`;
 *     Python: `<depsPath>/venv/{bin,Scripts}/python`).
 *
 * Throws `ScriptDepsInstallError` (propagated from the installer) when the
 * install fails; `ScriptToolProvider` catches this and surfaces it to the
 * LLM tool-call loop without spawning the script.
 *
 * Idempotent on cache hits: the underlying `DepsCache.ensure` short-circuits
 * to a path lookup if `~/.skrun/deps/<hash>/` already exists.
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
    if (manifest.ecosystem === "python") {
      await installPython(tmpPath, manifest as PythonManifest, runner);
    } else {
      await installNode(tmpPath, manifest as NodeManifest, runner);
    }
  });

  return { ecosystem: manifest.ecosystem, depsPath };
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
