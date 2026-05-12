import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ToolConfig } from "@skrun-dev/schema";
import Ajv, { type ValidateFunction } from "ajv";
import type { DepsCache } from "../cache/deps-cache.js";
import type { ResolvedDeps } from "./script-deps-resolver.js";
import { ScriptDepsResolver } from "./script-deps-resolver.js";
import type { ToolDefinition, ToolProvider, ToolResult } from "./types.js";

const SCRIPT_TIMEOUT = 30_000; // 30 seconds
const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".py"]);

/** Optional dependencies for script-deps resolution. */
export interface ScriptToolProviderOptions {
  /**
   * Absolute path to the bundle root (the directory containing
   * `agent.yaml` + the manifest, NOT the `scripts/` subdir). When set
   * together with `depsCache`, the provider resolves dependencies before
   * spawning scripts. Leave undefined to keep the legacy behavior of
   * spawning scripts with the system runtime.
   */
  bundleRoot?: string;
  /** Disk-backed deps cache. Required if `bundleRoot` is set. */
  depsCache?: DepsCache;
}

export class ScriptToolProvider implements ToolProvider {
  private scripts = new Map<string, { path: string; ext: string }>();
  private toolConfigs = new Map<string, ToolConfig>();
  private validators = new Map<string, ValidateFunction>();
  private ajv: Ajv;

  private allowedHosts: string[];
  private outputDir: string;
  private depsResolver?: ScriptDepsResolver;
  // Memoized resolution promise. Cached for both success AND failure:
  // retrying every tool call after a persistent install failure would hammer
  // registries. The rejection is rethrown until the provider is reconstructed.
  private depsResolved?: Promise<ResolvedDeps | null>;

  constructor(
    private scriptsDir: string,
    toolConfigs: ToolConfig[] = [],
    allowedHosts: string[] = [],
    outputDir = "",
    options: ScriptToolProviderOptions = {},
  ) {
    this.allowedHosts = allowedHosts;
    this.outputDir = outputDir;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    for (const cfg of toolConfigs) {
      this.toolConfigs.set(cfg.name, cfg);
      this.validators.set(cfg.name, this.ajv.compile(cfg.input_schema));
    }
    this.scanScripts();

    // Wire up deps resolver only when both bundleRoot + depsCache are
    // provided. Either one alone is meaningless — leave deps disabled.
    if (options.bundleRoot && options.depsCache) {
      this.depsResolver = new ScriptDepsResolver(options.bundleRoot, options.depsCache);
    }
  }

  /**
   * Resolve script-deps once per provider instance. Cached for the lifetime
   * of the provider — re-throws the cached rejection on persistent failure.
   * Returns `null` when no manifest is declared (legacy system-runtime path).
   */
  protected getDepsResolved(): Promise<ResolvedDeps | null> {
    if (!this.depsResolver) return Promise.resolve(null);
    if (!this.depsResolved) {
      this.depsResolved = this.depsResolver.resolve();
    }
    return this.depsResolved;
  }

  private scanScripts(): void {
    if (!existsSync(this.scriptsDir)) return;

    const files = readdirSync(this.scriptsDir);
    for (const file of files) {
      const ext = extname(file);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      const name = basename(file, ext);
      this.scripts.set(name, { path: join(this.scriptsDir, file), ext });
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [...this.toolConfigs.values()].map((cfg) => ({
      name: cfg.name,
      description: cfg.description,
      parameters: cfg.input_schema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const cfg = this.toolConfigs.get(name);
    if (!cfg) {
      return { content: `Tool "${name}" not declared in agent.yaml`, isError: true };
    }

    const validate = this.validators.get(name);
    if (validate && !validate(args)) {
      return {
        content: `Invalid arguments for tool '${name}': ${ajvErrorsToString(validate.errors)}`,
        isError: true,
      };
    }

    const script = this.scripts.get(name);
    if (!script) {
      return {
        content: `Script "${name}" declared in agent.yaml not found in scripts/`,
        isError: true,
      };
    }

    // Resolve script-deps before spawn. On install failure, surface the
    // typed error to the LLM tool-call loop without ever spawning the script
    // structured error to the LLM tool-call loop. On cache hit / no-manifest, this is a near-zero-cost
    // path lookup.
    let resolvedDeps: ResolvedDeps | null;
    try {
      resolvedDeps = await this.getDepsResolved();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      return { content: `[${code}] ${message}`, isError: true };
    }

    // Choose the spawn command + env. Three branches:
    //   - resolvedDeps null → legacy system runtime (back-compat).
    //   - resolvedDeps Python → venv-local python.
    //   - resolvedDeps Node → system node + NODE_PATH=<depsPath>/node_modules.
    const command = resolveCommand(script.ext, resolvedDeps);
    // Node v24+ has native TypeScript support (type stripping) and auto-detects
    // module type from file extension / package.json. The legacy
    // `--input-type=module` flag is rejected by Node v24 ("--input-type can
    // only be used with string input via --eval, --print, or STDIN").
    const cmdArgs = [script.path];
    const spawnEnv = buildSpawnEnv(this.allowedHosts, this.outputDir, resolvedDeps);

    return new Promise((resolve) => {
      const child = execFile(
        command,
        cmdArgs,
        {
          timeout: SCRIPT_TIMEOUT,
          env: spawnEnv,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ content: stderr || error.message, isError: true });
          } else {
            resolve({ content: stdout.trim(), isError: false });
          }
        },
      );

      // Pass args via stdin
      if (child.stdin) {
        child.stdin.write(JSON.stringify(args));
        child.stdin.end();
      }
    });
  }

  async disconnect(): Promise<void> {
    // Nothing to disconnect
  }
}

function ajvErrorsToString(errors: ValidateFunction["errors"]): string {
  if (!errors || errors.length === 0) return "validation failed";
  return errors
    .map((err) => {
      const path = err.instancePath || "(root)";
      return `${path} ${err.message}`;
    })
    .join("; ");
}

/**
 * Pick the spawn command for a script, taking deps resolution into account.
 *
 * - Python script + resolved Python deps → venv-local `python` interpreter.
 * - Python script + no deps               → system `python` / `python3`.
 * - Node script (any deps state)          → system `node` (NODE_PATH carries
 *   the resolved `node_modules` to the spawned process).
 */
function resolveCommand(ext: string, resolvedDeps: ResolvedDeps | null): string {
  if (ext === ".py") {
    if (resolvedDeps?.ecosystem === "python") {
      return process.platform === "win32"
        ? join(resolvedDeps.depsPath, "venv", "Scripts", "python.exe")
        : join(resolvedDeps.depsPath, "venv", "bin", "python");
    }
    // Legacy / no-manifest path: system Python alias. On Windows the standard
    // alias is `python` (not `python3` — that name is a Microsoft Store stub
    // by default and fails). Linux/macOS canonically use `python3` to
    // disambiguate from system `python2` still present on some distros.
    return process.platform === "win32" ? "python" : "python3";
  }
  // .js / .ts / .mjs / .cjs — always spawn `node`.
  return "node";
}

/**
 * Build the env passed to the spawned script. Always inherits `process.env`
 * + skrun-specific advisory vars (allowed_hosts, output_dir). Adds NODE_PATH
 * pointing at the resolved `node_modules` when Node deps are present —
 * Node's module resolution then sees the cached deps without polluting
 * the bundle directory itself.
 */
function buildSpawnEnv(
  allowedHosts: string[],
  outputDir: string,
  resolvedDeps: ResolvedDeps | null,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    SKRUN_ALLOWED_HOSTS: allowedHosts.join(","),
    SKRUN_OUTPUT_DIR: outputDir,
  };
  if (resolvedDeps?.ecosystem === "node") {
    base.NODE_PATH = join(resolvedDeps.depsPath, "node_modules");
  }
  return base;
}
