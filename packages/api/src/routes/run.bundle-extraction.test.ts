import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { packAgentTar } from "@skrun-dev/schema";
import { type Headers, pack as tarPack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCache, bundleExtractionsInUse } from "../cache/bundle-cache.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import { BUNDLE_DIR_PREFIX } from "../utils/bundle.js";
import { agentYamlOfSize, minimalAgentYaml } from "./agent-bundle.shared.js";
import { fakeFlyioDeps } from "./flyio-run-harness.shared.js";
import { storeVersion } from "./stored-version.shared.js";

// A run whose stored bundle does not extract — past the cap the server has
// when it runs, not a readable archive, or a write that fails — is
// answered before anything of the run is written, and each way writes one log
// line that names its cause. The logger factory is replaced by one that
// records every call with the bindings of the child logger it was made on;
// `writeFileSync` is the real one, watched, so a case can make the disk refuse
// the extraction's writes. vi.mock is hoisted above every import: what its
// factory reads is declared with vi.hoisted.
interface LoggedCall {
  level: string;
  bindings: Record<string, unknown>;
  args: unknown[];
}

const { logged } = vi.hoisted(() => ({ logged: [] as LoggedCall[] }));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const loggerWith = (bindings: Record<string, unknown>): unknown => {
    const write =
      (level: string) =>
      (...args: unknown[]) => {
        logged.push({ level, bindings, args });
      };
    return {
      trace: write("trace"),
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      fatal: write("fatal"),
      level: "info",
      child: (more: Record<string, unknown>) => loggerWith({ ...bindings, ...more }),
    };
  };
  return { ...actual, createLogger: () => loggerWith({}) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const DEV_TOKEN = "dev-token";
const VERSION = "1.0.0";
const MIB = 1024 * 1024;

/**
 * A gzipped tar of `entries` as given — a directory entry included, as the
 * standard `tar` writes one per directory; `packAgentTar` writes files only.
 */
function packRaw(
  entries: Array<{ name: string; type?: Headers["type"]; content?: Buffer }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
    for (const e of entries) {
      const content = e.content ?? Buffer.alloc(0);
      pack.entry(
        { name: e.name, type: e.type ?? "file", size: content.length, mtime: new Date(0) },
        content,
      );
    }
    pack.finalize();
  });
}

type Runtime = "local" | "flyio";

describe("POST /run — a stored bundle that does not extract", () => {
  let storage: MemoryStorage;
  let db: MemoryDb;
  let root: string;
  let actualWriteFileSync: typeof writeFileSync;

  beforeEach(async () => {
    logged.length = 0;
    storage = new MemoryStorage();
    db = new MemoryDb();
    // A temp root of the case's own, so what an extraction leaves is read
    // there alone: `os.tmpdir()` reads these at every call.
    root = mkdtempSync(join(tmpdir(), "skrun-extraction-case-"));
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, root);
    actualWriteFileSync = (await vi.importActual<typeof import("node:fs")>("node:fs"))
      .writeFileSync;
  });

  afterEach(() => {
    vi.mocked(writeFileSync).mockImplementation(actualWriteFileSync);
    bundleCache.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function appFor(runtime: Runtime): ReturnType<typeof createApp> {
    return runtime === "flyio"
      ? createApp(storage, db, {
          runtimeMode: "flyio",
          flyioDeps: fakeFlyioDeps(storage),
          verificationPolicy: "owner",
        })
      : createApp(storage, db, { runtimeMode: "local", verificationPolicy: "owner" });
  }

  /** Push `files` with a minimal agent.yaml, by the route, under the cap it has now. */
  async function push(
    app: ReturnType<typeof createApp>,
    name: string,
    files: Array<{ name: string; content: Buffer }> = [],
  ): Promise<void> {
    await pushBundle(
      app,
      name,
      await packAgentTar([
        { name: "agent.yaml", content: Buffer.from(minimalAgentYaml(name)) },
        { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
        ...files,
      ]),
    );
  }

  /** Push `bundle` as it is, by the route: the push accepts it. */
  async function pushBundle(
    app: ReturnType<typeof createApp>,
    name: string,
    bundle: Buffer,
  ): Promise<void> {
    const res = await app.request(`/api/agents/dev/${name}/push?version=${VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
  }

  /** A run as the cloud runtime takes one — a stream —, and as the local one does — synchronously. */
  function run(app: ReturnType<typeof createApp>, runtime: Runtime, name: string) {
    return app.request(`/api/agents/dev/${name}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DEV_TOKEN}`,
        "Content-Type": "application/json",
        ...(runtime === "flyio" && { Accept: "text/event-stream" }),
      },
      body: JSON.stringify({ input: { q: "hi" } }),
    });
  }

  /** The lines of an extraction that failed, each with its child's bindings. */
  const extractionLines = () =>
    logged.filter(
      ({ args: [fields] }) =>
        (fields as { event?: string } | undefined)?.event === "bundle_extraction_failed",
    );

  const extractionDirs = () => readdirSync(root).filter((n) => n.startsWith(BUNDLE_DIR_PREFIX));

  it.each([
    "local",
    "flyio",
  ] as const)("%s: a version stored past the cap the server now has is refused 422 BUNDLE_DECOMPRESSED_TOO_LARGE, and a warn line names the cause and the cap", async (runtime) => {
    const app = appFor(runtime);
    const name = `too-large-${runtime}`;
    // Pushed under the default cap; then the operator lowers it to 1 MB.
    await push(app, name, [{ name: "data/table.csv", content: Buffer.alloc(2 * MIB, "a") }]);
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "1");
    const heldBefore = bundleExtractionsInUse();

    const res = await run(app, runtime, name);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: {
        code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
        message: `Agent dev/${name} version ${VERSION} decompresses to more than 1 MB, the most this server now unpacks (BUNDLE_MAX_DECOMPRESSED_MB). Its creator can push a smaller version — leaving out the files the agent does not need when it runs —, or the server's operator raise BUNDLE_MAX_DECOMPRESSED_MB.`,
      },
    });
    expect(extractionLines()).toEqual([
      {
        level: "warn",
        bindings: {},
        args: [
          {
            event: "bundle_extraction_failed",
            agent: `dev/${name}`,
            agent_version: VERSION,
            cause: "too_large",
            max_decompressed_bytes: MIB,
            error_name: "BundleDecompressedTooLargeError",
            error_code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
          },
          "A run was refused: its agent's bundle decompresses past this server's cap",
        ],
      },
    ]);
    // Nothing held, nothing cached, nothing left on disk.
    expect(bundleExtractionsInUse()).toBe(heldBefore);
    expect(bundleCache.size).toBe(0);
    expect(extractionDirs()).toEqual([]);
  });

  it.each([
    "local",
    "flyio",
  ] as const)("%s: a stored bundle that is not a readable archive stays 500 BUNDLE_CORRUPT, and an error line names the cause", async (runtime) => {
    const app = appFor(runtime);
    const name = `unreadable-${runtime}`;
    // As a push stored one before it refused such a body.
    await storeVersion({
      app,
      storage,
      db,
      token: DEV_TOKEN,
      namespace: "dev",
      name,
      version: VERSION,
      bundle: Buffer.from("not a bundle"),
    });

    const res = await run(app, runtime, name);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "BUNDLE_CORRUPT", message: "Failed to extract agent bundle" },
    });
    expect(extractionLines()).toEqual([
      {
        level: "error",
        bindings: {},
        args: [
          {
            event: "bundle_extraction_failed",
            agent: `dev/${name}`,
            agent_version: VERSION,
            cause: "unreadable",
            error_name: "Error",
            error_code: "Z_DATA_ERROR",
          },
          "A run's bundle could not be extracted: it is not a readable archive",
        ],
      },
    ]);
    expect(extractionDirs()).toEqual([]);
  });

  it("local: a write the disk refuses stays 500 BUNDLE_CORRUPT, an error line carries the filesystem's code — never the path — and the directory written so far is gone", async () => {
    const app = appFor("local");
    const name = "disk-full";
    await push(app, name, [
      { name: "scripts/private-report-builder.py", content: Buffer.from("print(1)\n") },
    ]);
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (String(file).includes(BUNDLE_DIR_PREFIX)) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), {
          code: "ENOSPC",
          errno: -28,
          syscall: "write",
        });
      }
      actualWriteFileSync(file, data, options);
    });

    const res = await run(app, "local", name);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "BUNDLE_CORRUPT", message: "Failed to extract agent bundle" },
    });
    expect(extractionLines()).toEqual([
      {
        level: "error",
        bindings: {},
        args: [
          {
            event: "bundle_extraction_failed",
            agent: `dev/${name}`,
            agent_version: VERSION,
            cause: "filesystem",
            error_name: "BundleWriteError",
            error_code: "ENOSPC",
          },
          "A run's bundle could not be extracted: a file or directory of it could not be written out on this server",
        ],
      },
    ]);
    // No line, no response carries a file name of the bundle.
    expect(JSON.stringify(logged)).not.toContain("private-report-builder");
    expect(extractionDirs()).toEqual([]);
    expect(bundleCache.size).toBe(0);
  });

  // A bundle made by the standard tar carries an entry for each directory —
  // skrun build writes none. The local runtime makes each directory, and the
  // run goes on to its next steps: here, with no model key anywhere, the
  // key's refusal.
  it.each([
    "local",
    "flyio",
  ] as const)("%s: a bundle with directory entries, as the standard tar makes, is extracted and its run goes on", async (runtime) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const app = appFor(runtime);
    const name = `tar-made-${runtime}`;
    await pushBundle(
      app,
      name,
      await packRaw([
        { name: "agent.yaml", content: Buffer.from(minimalAgentYaml(name)) },
        { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
        { name: "scripts/", type: "directory" },
        { name: "scripts/run.py", content: Buffer.from("print(1)\n") },
      ]),
    );

    const res = await run(app, runtime, name);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LLM_KEY_REQUIRED");
    expect(extractionLines()).toEqual([]);
  });

  // A file `scripts/run`, then `scripts/run/helper.py`: a valid archive no
  // filesystem can write out — the cloud sandbox's tar no more than this
  // server. The push refuses it; one stored before it did is refused by the
  // codec at the run, before any write and before any machine, on both
  // runtimes. The line carries the codec's class and code, its words no file
  // name.
  it.each([
    "local",
    "flyio",
  ] as const)("%s: an archive whose entries contradict each other is refused at push; stored before, its run answers 500 BUNDLE_CORRUPT, nothing written", async (runtime) => {
    const app = appFor(runtime);
    const name = `contradicts-${runtime}`;
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(minimalAgentYaml(name)) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
      { name: "scripts/run", content: Buffer.from("#!/bin/sh\n") },
      { name: "scripts/run/helper.py", content: Buffer.from("print(1)\n") },
    ]);
    const pushed = await app.request(`/api/agents/dev/${name}/push?version=${VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(pushed.status).toBe(400);
    expect(await pushed.json()).toEqual({
      error: {
        code: "BUNDLE_CORRUPT",
        message:
          'This bundle cannot be written out where an agent runs: The entry "scripts/run/helper.py" needs "scripts/run" to be a directory, and the bundle makes it a file.',
      },
    });
    expect(await storage.list("dev/")).toEqual([]);

    const stored = { app, storage, db, token: DEV_TOKEN, namespace: "dev", name, version: VERSION };
    await storeVersion({ ...stored, bundle });
    vi.mocked(writeFileSync).mockClear();
    const res = await run(app, runtime, name);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "BUNDLE_CORRUPT", message: "Failed to extract agent bundle" },
    });
    expect(extractionLines()).toEqual([
      {
        level: "error",
        bindings: {},
        args: [
          {
            event: "bundle_extraction_failed",
            agent: `dev/${name}`,
            agent_version: VERSION,
            cause: "unreadable",
            error_name: "BundleEntryError",
            error_code: "BUNDLE_ENTRY_UNWRITABLE",
          },
          "A run's bundle could not be extracted: it is not a readable archive",
        ],
      },
    ]);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(extractionDirs()).toEqual([]);
  });

  // The push refuses an agent.yaml past 128 KB; a run never judges its size. A
  // version stored before that refusal is read as it was, and goes on to the
  // run's next steps — here, with no model key anywhere, the key's refusal.
  it.each([
    "local",
    "flyio",
  ] as const)("%s: an agent.yaml past 128 KB, stored before the push refused it, is read as before — no CONFIG_TOO_LARGE at run", async (runtime) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const app = appFor(runtime);
    const name = `wordy-${runtime}`;
    await storeVersion({
      app,
      storage,
      db,
      token: DEV_TOKEN,
      namespace: "dev",
      name,
      version: VERSION,
      agentYaml: agentYamlOfSize(MIB + 1, minimalAgentYaml(name)),
    });

    const res = await run(app, runtime, name);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LLM_KEY_REQUIRED");
    expect(extractionLines()).toEqual([]);
  });
});
