import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, statfs } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type ReadableStream, TransformStream } from "node:stream/web";
import {
  assertNoLinkInPath,
  DEFAULT_OUTPUT_LIMITS,
  DepsCache,
  downloadBundle,
  type InitRequest,
  type InitResult,
  InitStepError,
  McpToolProvider,
  type OutputExclusionCounts,
  type OutputLimits,
  outputFileReadRange,
  ScriptToolProvider,
  type ToolDefinition,
  type ToolResult,
  walkAndSelectOutputFiles,
} from "@skrun-dev/runtime/runner";
import type { McpServer, ToolConfig } from "@skrun-dev/schema";

const BUNDLE_ROOT = "/mnt/agent";
const SCRIPTS_DIR = "/mnt/agent/scripts";
const OUTPUTS_DIR = "/mnt/session/outputs";
const BUNDLE_TMP_PATH = "/tmp/skrun-bundle.tgz";
/**
 * Where the agent's declared script dependencies are installed. /tmp is
 * writable by this process on a runner machine — the bundle archive above lands
 * there too — and a machine serves a single run, so nothing in it is shared
 * between runs. Not under BUNDLE_ROOT, which stays the image of what the author
 * published; and never the cache's own default, the home directory.
 */
const DEPS_DIR = "/tmp/skrun-deps";

/** How much of a failed installer's error output the log line keeps: its end, where the cause is. */
const DEPS_FAILURE_TAIL_LINES = 20;
const DEPS_FAILURE_TAIL_CHARS = 4000;

/**
 * What `/init` prepares the agent from: its body as the shared contract parses
 * it. `bundleSha256` is the hex sha256 the downloaded bundle must match, as
 * recorded when the version was published: the harness verifies its own copy of
 * the object, but this process fetches the object again, and it is this second
 * copy whose scripts actually run. Absent for a bundle published before
 * checksums were kept. `outputsPutUrl` is accepted and unused: outputs are
 * returned as a manifest only.
 */
export type InitOptions = InitRequest;

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

/**
 * Compare the downloaded tarball against the checksum recorded when the
 * version was published, in constant time.
 *
 * Called BEFORE extraction, and that ordering is the whole point: a check that
 * ran afterwards would have already written the scripts it rejects into the
 * directory the tool runner reads from.
 */
async function verifyBundleChecksum(tarballPath: string, expectedHex: string): Promise<void> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(tarballPath), hash);
  const actual = hash.digest();
  const expected = Buffer.from(expectedHex, "hex");
  // timingSafeEqual throws on differing lengths, so length is settled first.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    const shown = (hex: string) => `${hex.slice(0, 12)}...`;
    throw new InitStepError(
      "bundle-checksum",
      `bundle checksum mismatch: expected ${shown(expectedHex)}, downloaded ${shown(
        actual.toString("hex"),
      )} - refusing to extract`,
    );
  }
}

/**
 * Whether the file system under `path` has no block, or no inode, left for this
 * process. tar says a write the disk refused only in its error output, which it
 * writes to this process's own; so a failed extraction asks the file system
 * instead. Unknown — the call itself failing — is not full.
 */
async function diskIsFull(path: string): Promise<boolean> {
  try {
    const fs = await statfs(path);
    return fs.bavail === 0 || fs.ffree === 0;
  } catch {
    return false;
  }
}

/**
 * Extract the downloaded bundle. A tar that fails names the step it failed at:
 * the disk, when the file system has nothing left — a full disk is no fault of
 * the bundle's —, the extraction when tar exited on its own. A tar ended by a
 * signal said nothing of the bundle — killed for its memory, say —: its failure
 * names no step of the bundle's, and another machine may extract it. A tar that
 * does not start is thrown as it failed.
 */
async function extractBundle(tarballPath: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarballPath, "-C", dest], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    child.on("error", reject);
  });
  if (code === 0) return;
  if (await diskIsFull(dest)) {
    throw new InitStepError(
      "disk-full",
      `tar extract failed: ${code === null ? `ended by ${signal}` : `exit code ${code}`}, the disk is full`,
    );
  }
  if (code === null) {
    throw new Error(`tar extract failed: ended by ${signal ?? "a signal"}`);
  }
  throw new InitStepError("bundle-extract", `tar extract failed: exit code ${code}`);
}

/**
 * Replace each known run-scoped value — the run credential, the claim
 * credential, this run's presigned URLs — wherever it appears in `text`.
 */
function blankRunValues(text: string, values: readonly (string | undefined)[]): string {
  let out = text;
  for (const value of values) {
    if (value && value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out;
}

/**
 * One line for the operator when the agent's dependencies fail to install:
 * the ecosystem, the command, its exit code — or the time limit it was stopped
 * at — and the last lines of what it printed on its error output. The model
 * sees none of it — the first tool call returns the typed cause instead.
 *
 * The machine holds no secret of the harness's, but this process does hold its
 * run credential and the presigned URLs of this run, and an installer runs code
 * from the packages it installs, which can print whatever it can read. Those
 * values are blanked out of every field before the line is written — and out of
 * the whole error output before its end is cut. Cut first, a value the cut runs
 * through is no longer whole, nothing matches it any more, and its end — the
 * signature of a presigned URL — reaches the log.
 */
function logDepsInstallFailed(error: unknown, runValues: readonly (string | undefined)[]): void {
  const details = (
    error as
      | {
          details?: {
            ecosystem?: string;
            command?: string;
            exitCode?: number | null;
            stderr?: string;
            timeoutMs?: number;
          };
        }
      | undefined
  )?.details;
  const blank = (text: string | undefined) =>
    text === undefined ? undefined : blankRunValues(text, runValues);
  const tail = (blank(details?.stderr) ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-DEPS_FAILURE_TAIL_LINES)
    .join("\n")
    .slice(-DEPS_FAILURE_TAIL_CHARS);
  const record = details
    ? {
        event: "deps_install_failed",
        ecosystem: details.ecosystem,
        command: blank(details.command),
        exit_code: details.exitCode,
        // Present when the install was stopped for running out of time.
        timed_out_after_ms: details.timeoutMs,
        stderr_tail: tail,
      }
    : {
        event: "deps_install_failed",
        message: blank(error instanceof Error ? error.message : String(error)),
      };
  process.stderr.write(`[skrun-runner] deps_install_failed ${JSON.stringify(record)}\n`);
}

/**
 * Prepare the agent, and say what it took: its tools, and the per-phase in-VM
 * timings (ms) for cold-start telemetry — the `tools` and `phases` of the /init
 * answer, which the caller sends to the harness.
 */
export async function initRunner(
  opts: InitOptions,
): Promise<Required<Pick<InitResult, "tools" | "phases">>> {
  if (state) {
    throw new Error("runner already initialized");
  }

  const t0 = Date.now();
  // The runtime's download: a body cut on its way fails this step, typed by how
  // it failed, and leaves no partial archive behind — never this process.
  await downloadBundle(opts.bundleUrl, BUNDLE_TMP_PATH);
  // Between the download and the extraction, and nowhere else. A bundle
  // published before checksums were kept arrives without one and still runs —
  // but it says so, because the alternative is a run that looks verified and
  // is not, and no reader can tell those two apart from silence.
  // It sits inside the bundle phase rather than after it, so `bundle_ms` below
  // reads as "time to obtain a bundle worth extracting" and `extract_ms` stays
  // the tar alone.
  if (opts.bundleSha256) {
    await verifyBundleChecksum(BUNDLE_TMP_PATH, opts.bundleSha256);
  } else {
    process.stderr.write(
      "[skrun-runner] bundle served without a checksum - extracting unverified " +
        "(published before checksums were recorded, or sent by an older harness)\n",
    );
  }
  const t1 = Date.now();
  await extractBundle(BUNDLE_TMP_PATH, BUNDLE_ROOT);
  const t2 = Date.now();
  await mkdir(OUTPUTS_DIR, { recursive: true });

  // The harness relays the agent's tools and servers as its validated
  // configuration declares them; the contract checks their names and keeps the
  // rest whole, for the provider that runs each.
  const scriptProvider = new ScriptToolProvider(
    SCRIPTS_DIR,
    opts.tools as ToolConfig[],
    opts.allowedHosts,
    OUTPUTS_DIR,
    { bundleRoot: BUNDLE_ROOT, depsCache: new DepsCache({ rootDir: DEPS_DIR }) },
  );

  // Install the agent's declared dependencies now, while the caller is still
  // waiting for a runner, rather than at the first tool call: an install can
  // outlast the bound of a tool request by far. The runtime bounds the install
  // itself, under the harness's bound on this request. A failure — a timed-out
  // install included — does not fail /init: it stays with the provider, and the
  // first tool call returns it, typed, to the agent's model; the operator gets
  // the line below.
  const deps = await scriptProvider.prepareDependencies();
  if (deps.failed) {
    logDepsInstallFailed(deps.error, [
      process.env.RUNNER_RPC_TOKEN,
      process.env.RUNNER_CLAIM_TOKEN,
      process.env.BUNDLE_URL,
      process.env.OUTPUTS_PUT_URL,
      opts.bundleUrl,
      opts.outputsPutUrl,
    ]);
  }

  const mcpProviders: McpToolProvider[] = [];
  const mcpToolMap = new Map<string, McpToolProvider>();
  const allTools: ToolDefinition[] = await scriptProvider.listTools();

  const mcpStart = Date.now();
  for (const server of opts.mcpServers) {
    const provider = new McpToolProvider(server as McpServer, undefined, opts.allowedHosts);
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
    phases: { bundle_ms: t1 - t0, extract_ms: t2 - t1, deps_ms: deps.ms, mcp_ms: mcpMs },
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

/**
 * What the last collect request settled: the limits it carried, which bound
 * every file served from then on, and the size each file it kept was listed
 * at. Before the first one, the defaults and an empty list.
 */
let lastList: { limits: Readonly<OutputLimits>; sizes: ReadonlyMap<string, number> } = {
  limits: DEFAULT_OUTPUT_LIMITS,
  sizes: new Map(),
};

/**
 * The files the run left under OUTPUTS_DIR that the selection rule keeps under
 * `limits` — the harness's, validated by the route — each with its size and
 * type, and what the rule left out, counted by reason and never named. The
 * walk and the rule are the runtime's, the ones the local engine applies: a
 * link is not listed, a name the output name rule refuses is not either, and a
 * missing directory lists nothing.
 */
export async function collectOutputs(
  limits: OutputLimits,
): Promise<{ files: OutputFileInfo[]; excluded: OutputExclusionCounts }> {
  const { kept, excluded } = await walkAndSelectOutputFiles(OUTPUTS_DIR, limits);
  lastList = { limits, sizes: new Map(kept.map((file) => [file.path, file.size])) };
  return {
    files: kept.map((file) => ({ path: file.path, size: file.size, mimeType: mimeFor(file.path) })),
    excluded,
  };
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

/** What `GET /outputs/file` serves for one path. */
export type OpenedOutputFile =
  | { kind: "stream"; body: ReadableStream<Uint8Array>; length: number; mimeType: string }
  | { kind: "empty"; mimeType: string }
  | { kind: "too_large"; maxBytes: number };

/**
 * An output file, opened for the harness to pull it (`GET /outputs/file?path=X`)
 * and upload it — within two bounds.
 *
 * Never past the size the last list gave it: a file that grew since is served
 * as it was listed, one that shrank as it is now. A file that list did not keep
 * is taken at its size now. And never past the size limit of the last list
 * (the defaults before one): a larger file is refused, not cut. An empty file
 * is nothing to stream — the range a stream would take for it is an error.
 *
 * The body is a web stream, made by Node from the file's own. A Node stream
 * handed to the server as it is, once read to the end of its file, brought the
 * whole process down ("ReadableStream is already closed") after an answer
 * served whole — every time for an empty file, now and then for another — and
 * the next file asked for found no runner. A read bounded to its range stops
 * short of that end, and a web stream reaches it safely: either holds alone,
 * and both are kept, since a file can still shrink while it is read.
 *
 * A file that shrinks while it is read ends short of the Content-Length
 * already sent: the stream then fails at its end (`failsIfShort`), and the
 * server closes the connection.
 */
export async function openOutputFile(relPath: string): Promise<OpenedOutputFile> {
  const abs = resolveOutputPath(relPath);
  // No link at any level of the path the file is opened at — the outputs
  // directory, a directory on the way, the file itself: the walk follows none,
  // and a path sent by hand must not either.
  await assertNoLinkInPath(OUTPUTS_DIR, relative(OUTPUTS_DIR, abs));
  // `lstat`, as the walk: a link is not a file here, whatever it points to.
  const s = await lstat(abs);
  if (!s.isFile()) {
    throw new Error(`path "${relPath}" is not a regular file`);
  }
  const listed = lastList.sizes.get(relPath);
  const size = listed === undefined ? s.size : Math.min(listed, s.size);
  const mimeType = mimeFor(relPath);
  const maxBytes = lastList.limits.max_size_bytes;
  const range = outputFileReadRange(size, maxBytes);
  if (range.kind === "too_large") return { kind: "too_large", maxBytes };
  if (range.kind === "empty") return { kind: "empty", mimeType };
  const stream = createReadStream(abs, { start: range.start, end: range.end });
  const length = range.end - range.start + 1;
  return {
    kind: "stream",
    body: failsIfShort(Readable.toWeb(stream) as ReadableStream<Uint8Array>, length),
    length,
    mimeType,
  };
}

/**
 * `body`, failing at its end when it carried fewer than `length` bytes. The
 * Content-Length is sent before the file is read: an answer that ended cleanly
 * short of it would leave the connection open, the harness waiting for bytes
 * that never come — until the server closes the connection as idle, five
 * seconds later by default, or the pull's own time runs out. A stream that
 * fails makes the server close the connection at once, and the harness leaves
 * that file out at once.
 */
function failsIfShort(
  body: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  let served = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        served += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (served < length) {
          controller.error(new Error(`output file ended after ${served} of ${length} bytes`));
        }
      },
    }),
  );
}

export async function shutdownRunner(): Promise<void> {
  if (!state) return;
  await state.scriptProvider.disconnect().catch(() => {});
  for (const provider of state.mcpProviders) {
    await provider.disconnect().catch(() => {});
  }
  state = null;
}
