import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  McpToolProvider,
  ScriptToolProvider,
  type ToolDefinition,
  type ToolResult,
} from "@skrun-dev/runtime/runner";
import type { McpServer, ToolConfig } from "@skrun-dev/schema";

const BUNDLE_ROOT = "/mnt/agent";
const SCRIPTS_DIR = "/mnt/agent/scripts";
const OUTPUTS_DIR = "/mnt/session/outputs";
const BUNDLE_TMP_PATH = "/tmp/skrun-bundle.tgz";

export interface InitOptions {
  bundleUrl: string;
  // Accepted for forward-compat with the outputs-upload work — currently
  // unused; outputs are returned as a manifest only.
  outputsPutUrl?: string;
  tools: ToolConfig[];
  mcpServers: McpServer[];
  allowedHosts: string[];
}

export interface OutputFileInfo {
  path: string;
  size: number;
  mimeType: string;
}

interface RunnerState {
  scriptProvider: ScriptToolProvider;
  mcpProviders: McpToolProvider[];
  mcpToolMap: Map<string, McpToolProvider>;
}

let state: RunnerState | null = null;

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function mimeFor(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

async function downloadBundle(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`bundle fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("bundle fetch failed: empty response body");
  }
  await new Promise<void>((resolve, reject) => {
    // Node 22's fetch returns a web ReadableStream — convert to a Node stream.
    // biome-ignore lint/suspicious/noExplicitAny: web/node stream interop
    Readable.fromWeb(res.body as any)
      .pipe(createWriteStream(dest))
      .on("finish", () => resolve())
      .on("error", reject);
  });
}

async function extractBundle(tarballPath: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarballPath, "-C", dest], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed: exit code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function initRunner(opts: InitOptions): Promise<{
  tools: ToolDefinition[];
  // Per-phase in-VM timings (ms) for cold-start telemetry, returned to the
  // harness in the /init response. Matches the runtime `InitResult["phases"]`.
  phases: { bundle_ms: number; extract_ms: number; mcp_ms: number };
}> {
  if (state) {
    throw new Error("runner already initialized");
  }

  const t0 = Date.now();
  await downloadBundle(opts.bundleUrl, BUNDLE_TMP_PATH);
  const t1 = Date.now();
  await extractBundle(BUNDLE_TMP_PATH, BUNDLE_ROOT);
  const t2 = Date.now();
  await mkdir(OUTPUTS_DIR, { recursive: true });

  const scriptProvider = new ScriptToolProvider(
    SCRIPTS_DIR,
    opts.tools,
    opts.allowedHosts,
    OUTPUTS_DIR,
    { bundleRoot: BUNDLE_ROOT },
  );

  const mcpProviders: McpToolProvider[] = [];
  const mcpToolMap = new Map<string, McpToolProvider>();
  const allTools: ToolDefinition[] = await scriptProvider.listTools();

  const mcpStart = Date.now();
  for (const server of opts.mcpServers) {
    const provider = new McpToolProvider(server, undefined, opts.allowedHosts);
    await provider.connect();
    const mcpTools = await provider.listTools();
    for (const t of mcpTools) {
      mcpToolMap.set(t.name, provider);
      allTools.push(t);
    }
    mcpProviders.push(provider);
  }
  const mcpMs = Date.now() - mcpStart;

  state = { scriptProvider, mcpProviders, mcpToolMap };

  return {
    tools: allTools,
    phases: { bundle_ms: t1 - t0, extract_ms: t2 - t1, mcp_ms: mcpMs },
  };
}

export async function dispatchTool(
  kind: "script" | "mcp",
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!state) {
    throw new Error("runner not initialized — call POST /init first");
  }
  if (kind === "script") {
    return state.scriptProvider.callTool(name, args);
  }
  const provider = state.mcpToolMap.get(name);
  if (!provider) {
    return { content: `unknown MCP tool: ${name}`, isError: true };
  }
  return provider.callTool(name, args);
}

export async function collectOutputs(): Promise<{ files: OutputFileInfo[] }> {
  // Tolerant of missing OUTPUTS_DIR (agent never wrote anything) — return empty.
  const files: OutputFileInfo[] = [];

  async function walk(dir: string, relBase: string): Promise<void> {
    // @types/node 25 splits Dirent into Dirent<string> vs Dirent<NonSharedBuffer>
    // overloads depending on the encoding option. Pre-declaring `entries` with
    // `Awaited<ReturnType<typeof readdir>>` resolves to the WIDE UNION, which
    // breaks downstream entry.name typing. Keep the consumption inside the try
    // block so TS infers the narrow Dirent<string>[] from the readdir call.
    try {
      const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.isFile()) {
          const s = await stat(abs);
          files.push({ path: rel, size: s.size, mimeType: mimeFor(entry.name) });
        }
      }
    } catch (err) {
      // ENOENT on first call = no outputs were produced → return empty.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  await walk(OUTPUTS_DIR, "");
  return { files };
}

/**
 * Resolve a user-supplied relative path under OUTPUTS_DIR, refusing any
 * result that escapes the directory. The harness `outputs-upload` flow
 * calls this once per file in the manifest — the manifest itself is
 * produced by walking OUTPUTS_DIR, but the path round-trips through HTTP
 * so we MUST re-validate.
 */
function resolveOutputPath(relPath: string): string {
  const resolved = resolve(OUTPUTS_DIR, relPath);
  if (resolved !== OUTPUTS_DIR && !resolved.startsWith(OUTPUTS_DIR + sep)) {
    throw new Error(`path "${relPath}" escapes the outputs directory`);
  }
  return resolved;
}

/**
 * Open a stream over an output file. Used by the harness to pull each
 * file via `GET /outputs/file?path=X` for sync upload to R2.
 */
export async function openOutputFile(
  relPath: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number; mimeType: string }> {
  const abs = resolveOutputPath(relPath);
  const s = await stat(abs);
  if (!s.isFile()) {
    throw new Error(`path "${relPath}" is not a regular file`);
  }
  return {
    stream: createReadStream(abs),
    size: s.size,
    mimeType: mimeFor(relPath),
  };
}

/**
 * Read an output file fully into memory. Convenience for the rare small-file
 * caller; harness should prefer `openOutputFile` to stream.
 */
export async function readOutputFile(relPath: string): Promise<Buffer> {
  const abs = resolveOutputPath(relPath);
  const s = await stat(abs);
  if (!s.isFile()) {
    throw new Error(`path "${relPath}" is not a regular file`);
  }
  return readFile(abs);
}

export async function shutdownRunner(): Promise<void> {
  if (!state) return;
  await state.scriptProvider.disconnect().catch(() => {});
  for (const provider of state.mcpProviders) {
    await provider.disconnect().catch(() => {});
  }
  state = null;
}
