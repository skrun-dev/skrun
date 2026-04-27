import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ToolConfig } from "@skrun-dev/schema";
import Ajv, { type ValidateFunction } from "ajv";
import type { ToolDefinition, ToolProvider, ToolResult } from "./types.js";

const SCRIPT_TIMEOUT = 30_000; // 30 seconds
const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".py"]);

export class ScriptToolProvider implements ToolProvider {
  private scripts = new Map<string, { path: string; ext: string }>();
  private toolConfigs = new Map<string, ToolConfig>();
  private validators = new Map<string, ValidateFunction>();
  private ajv: Ajv;

  private allowedHosts: string[];
  private outputDir: string;

  constructor(
    private scriptsDir: string,
    toolConfigs: ToolConfig[] = [],
    allowedHosts: string[] = [],
    outputDir = "",
  ) {
    this.allowedHosts = allowedHosts;
    this.outputDir = outputDir;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    for (const cfg of toolConfigs) {
      this.toolConfigs.set(cfg.name, cfg);
      this.validators.set(cfg.name, this.ajv.compile(cfg.input_schema));
    }
    this.scanScripts();
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

    // On Windows, the standard alias is `python` (not `python3` — that name is
    // a Microsoft Store stub by default and fails). Linux/macOS canonically use
    // `python3` to disambiguate from system python2 still present on some distros.
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const command = script.ext === ".py" ? pythonCmd : "node";
    const cmdArgs = script.ext === ".py" ? [script.path] : ["--input-type=module", script.path];

    return new Promise((resolve) => {
      const child = execFile(
        command,
        cmdArgs,
        {
          timeout: SCRIPT_TIMEOUT,
          env: {
            ...process.env,
            SKRUN_ALLOWED_HOSTS: this.allowedHosts.join(","),
            SKRUN_OUTPUT_DIR: this.outputDir,
          },
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
