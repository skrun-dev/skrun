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
const SCRIPT_MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB (Node default is 1 MB)
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
  // When set, scripts are spawned with this as their cwd so relative paths
  // (e.g. `./fixtures/sample.csv`) resolve from the bundle root, not from the
  // registry's own cwd. Optional for back-compat with callers that don't pass
  // a bundle (legacy in-memory tests). When unset, scripts inherit the parent
  // process's cwd as before.
  private bundleRoot?: string;
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
    this.bundleRoot = options.bundleRoot;
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
    // `.ts` scripts run through Node's native type-stripping
    // (`--experimental-strip-types`; native + default from Node 22.18/23.6 — the
    // runner is pinned to Node 22.12 where the flag is still required). Without
    // it, `node script.ts` fails with ERR_UNKNOWN_FILE_EXTENSION. `.js`/`.py`
    // take no extra flag. (The legacy `--input-type=module` flag is rejected by
    // Node v24 and was dropped.)
    const cmdArgs = buildInterpreterArgs(script.ext, script.path);
    const spawnEnv = buildSpawnEnv(this.allowedHosts, this.outputDir, resolvedDeps);

    return new Promise((resolve) => {
      const child = execFile(
        command,
        cmdArgs,
        {
          timeout: SCRIPT_TIMEOUT,
          env: spawnEnv,
          // When bundleRoot is set, spawn the script with cwd anchored at the
          // bundle root so relative paths (e.g. `./fixtures/sample.csv`) in
          // user-authored scripts resolve from the bundle, not from the
          // registry's own process.cwd(). Falls back to the parent process's
          // cwd when bundleRoot is unset (legacy in-memory tests).
          cwd: this.bundleRoot,
          // Explicit 5MB cap on combined stdout+stderr. Node's default is
          // 1MB which silently buffer-overflows on large outputs; capping
          // explicitly + surfacing ENOBUFS as a clear message avoids opaque
          // "stdout maxBuffer length exceeded" errors leaking to the LLM.
          maxBuffer: SCRIPT_MAX_BUFFER_BYTES,
        },
        (error, stdout, stderr) => {
          if (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            if (errno === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(error.message)) {
              resolve({
                content: `Script output exceeded the ${SCRIPT_MAX_BUFFER_BYTES} byte (${SCRIPT_MAX_BUFFER_BYTES / (1024 * 1024)}MB) buffer cap — truncate the script's output or write to disk via SKRUN_OUTPUT_DIR.`,
                isError: true,
              });
              return;
            }
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
  // .js / .ts — always spawn `node` (interpreter only; the `.ts` type-stripping
  // flag is added in buildInterpreterArgs below, not here).
  return "node";
}

/**
 * Build the spawn arguments for a script (interpreter flags + the script path).
 *
 * `.ts` scripts are run through Node's native type-stripping
 * (`--experimental-strip-types`) — required on the runner's pinned Node 22.12,
 * a no-op default from Node 22.18/23.6. Without it, `node script.ts` fails with
 * `ERR_UNKNOWN_FILE_EXTENSION`. `.js`/`.py` take no extra flag. Erasable syntax
 * only: `enum`/`namespace` throw a clear error (escalate to
 * `--experimental-transform-types` if a real need ever arises).
 */
export function buildInterpreterArgs(ext: string, scriptPath: string): string[] {
  if (ext === ".ts") {
    return ["--experimental-strip-types", scriptPath];
  }
  return [scriptPath];
}

/**
 * Env vars passed to spawned scripts. The previous behaviour spread
 * `process.env` wholesale, which exfiltrated every server secret (LLM API
 * keys, OAuth client secret, webhook signing key, DB credentials) to the
 * script — a self-verified malicious agent could echo
 * `process.env.ANTHROPIC_API_KEY` to stdout and the LLM tool-loop would
 * surface it back to the caller. Now strict allowlist:
 *
 *   - OS/runtime essentials (PATH, HOME, temp/profile, locale).
 *   - Python interop (PYTHONPATH, PYTHONIOENCODING).
 *   - All `SKRUN_*` vars (advisory context the runtime already publishes).
 *   - NODE_PATH (conditional on resolved Node deps, set below).
 *   - `SKRUN_ALLOWED_HOSTS` + `SKRUN_OUTPUT_DIR` (always set explicitly).
 */
const SCRIPT_SAFE_ENV_VARS = [
  // OS-required for binary discovery + temp / home
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USERPROFILE",
  // Locale (UTF-8 default for Python and Node)
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Python interop
  "PYTHONPATH",
  "PYTHONIOENCODING",
] as const;

function buildSpawnEnv(
  allowedHosts: string[],
  outputDir: string,
  resolvedDeps: ResolvedDeps | null,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};

  // 1. Allowlisted OS / locale / Python vars.
  for (const name of SCRIPT_SAFE_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }

  // 2. Explicit SKRUN_* contract vars the runtime publishes for scripts. The
  //    former blanket `SKRUN_*` copy was removed: it also swept secret-shaped
  //    vars such as SKRUN_SECRETS_ENCRYPTION_KEY (the AES master key that
  //    decrypts creators' LLM keys) into untrusted script processes. Only the
  //    documented contract vars below are exposed.
  base.SKRUN_ALLOWED_HOSTS = allowedHosts.join(",");
  base.SKRUN_OUTPUT_DIR = outputDir;

  // 3. NODE_PATH when Node deps were resolved.
  if (resolvedDeps?.ecosystem === "node") {
    base.NODE_PATH = join(resolvedDeps.depsPath, "node_modules");
  }
  return base;
}
