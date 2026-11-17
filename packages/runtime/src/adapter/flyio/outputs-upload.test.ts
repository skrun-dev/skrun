import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentDisposition } from "../../files/content-disposition.js";
import { isSafeOutputName, readOutputLimits } from "../../files/output-rules.js";
import type { Logger } from "../../logger.js";
import type { PresignedStorageAdapter } from "./adapter.js";
import { OutputBytesBudget } from "./output-bytes-budget.js";
import { runOutputKey } from "./output-keys.js";
import { OUTPUTS_UPLOAD_BUDGET_MS, OutputsUploadError, uploadOutputs } from "./outputs-upload.js";
import { RunnerCallTimeout, RunnerRedirectRefused, RunnerResponseTooLarge } from "./runner-call.js";

const MIB = 1024 * 1024;
const UPLOAD_ERROR_MESSAGE = "The run's output files could not be stored.";

interface ManifestEntry {
  path: unknown;
  size: number;
  mimeType: string;
}

/** A runner that lists `manifest` and serves three bytes for each file. */
function runnerFetch(manifest: ManifestEntry[], extra: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/outputs/collect")) {
      return new Response(JSON.stringify({ files: manifest, ...extra }), { status: 200 });
    }
    return new Response(Buffer.from("abc"), { status: 200 });
  }) as unknown as typeof fetch;
}

/** A runner whose list is `body`, served as it is, and that serves three bytes for each file. */
function rawListFetch(body: string | ReadableStream<Uint8Array>, status = 200): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/outputs/collect")) return new Response(body, { status });
    return new Response(Buffer.from("abc"), { status: 200 });
  }) as unknown as typeof fetch;
}

function spyStorage() {
  return {
    put: vi.fn(async (_key: string, _data: Buffer, _opts?: { signal?: AbortSignal }) => {}),
    getPresignedDownloadUrl: vi.fn(async (key: string) => `https://store.example/${key}`),
    getPresignedUploadUrl: vi.fn(),
  };
}

/** A logger that keeps what it is given: the fields of each line, by level. */
function spyLogger() {
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const at = (level: string) => (fields: Record<string, unknown>) => {
    lines.push({ level, fields });
  };
  const logger = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
  } as unknown as Logger;
  return { logger, lines, events: () => lines.map((line) => line.fields) };
}

/** What a promise settled with, so that a test asserts the rejection itself. */
async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

// A server on the loopback address, in this process, for the cases that need a
// real client: a redirect is refused by the client itself.
const opened: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((server) => server.close()));
});

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.on("error", () => {});
    handler(req, res);
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  opened.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
  return { url: `http://127.0.0.1:${port}`, hits };
}

describe("uploadOutputs — every link is a download", () => {
  it("presigns each file with an attachment disposition named after it", async () => {
    // A quote and characters outside ASCII: the disposition escapes and encodes them.
    const manifest = [
      { path: "d/b.csv", size: 3, mimeType: "text/csv" },
      { path: "page.html", size: 3, mimeType: "text/html" },
      { path: 'rap"port 报告.svg', size: 3, mimeType: "image/svg+xml" },
    ];
    const storage = spyStorage();

    const { files } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerFetch(manifest),
      presignedTtlSeconds: 120,
    });

    expect(storage.getPresignedDownloadUrl.mock.calls).toEqual(
      manifest.map((f) => [
        runOutputKey("r1", f.path),
        120,
        { contentDisposition: attachmentDisposition(f.path) },
      ]),
    );
    expect(files).toEqual(
      manifest.map((f) => ({
        name: f.path,
        size: 3,
        url: `https://store.example/${runOutputKey("r1", f.path)}`,
      })),
    );
  });
});

describe("uploadOutputs — the runner's file list is read bounded, and checked again", () => {
  it("asks the runner for the list under the API's own limits", async () => {
    const fetchImpl = runnerFetch([]);
    await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl,
      limits: { max_size_bytes: 1000, max_count: 3 },
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("http://runner:9000/outputs/collect");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ max_size_bytes: 1000, max_count: 3 });
  });

  it("reads its limits from the environment when it is given none", async () => {
    const fetchImpl = runnerFetch([]);
    await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl,
    });

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual(readOutputLimits(process.env));
  });

  it("stores nothing for a name the output name rule refuses: one write, for the other file, and the refusal logged by position, never by name", async () => {
    const storage = spyStorage();
    const log = spyLogger();
    const manifest = [
      { path: "../../../acme/agent/1.0.0.agent", size: 3, mimeType: "application/octet-stream" },
      { path: "ok.txt", size: 3, mimeType: "text/plain" },
    ];

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerFetch(manifest),
      logger: log.logger,
    });

    expect(storage.put.mock.calls.map((call) => call[0])).toEqual([runOutputKey("r1", "ok.txt")]);
    expect(files.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(excluded.name_refused).toBe(1);
    expect(log.events()).toContainEqual({
      event: "outputs_file_excluded",
      run_id: "r1",
      index: 0,
      size: 3,
      reason: "name_refused",
    });
    expect(JSON.stringify(log.lines)).not.toContain("acme");
  });

  // A runner's list is JSON, and JSON can carry the escape of half of a UTF-16
  // pair. Neither a URL nor a storage key holds such a name: encodeURIComponent
  // throws on it, as an S3 client does on such a key, before the network. The
  // name rule refuses it before anything is asked of the runner for it.
  it("refuses a name holding a lone surrogate before pulling it: the file left out by the name rule, the run's other file stored", async () => {
    const storage = spyStorage();
    const log = spyLogger();
    const list =
      '{"files":[{"path":"report-\\ud800.txt","size":3,"mimeType":"text/plain"},' +
      '{"path":"ok.txt","size":3,"mimeType":"text/plain"}]}';
    const fetchImpl = rawListFetch(list);

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl,
      logger: log.logger,
    });

    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      "http://runner:9000/outputs/collect",
      "http://runner:9000/outputs/file?path=ok.txt",
    ]);
    expect(storage.put.mock.calls.map((call) => call[0])).toEqual([runOutputKey("r1", "ok.txt")]);
    expect(files.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(excluded).toMatchObject({ name_refused: 1, pull_failed: 0 });
    expect(log.events()).toContainEqual({
      event: "outputs_file_excluded",
      run_id: "r1",
      index: 0,
      size: 3,
      reason: "name_refused",
    });
  });

  it("stores exactly the names the output name rule accepts — the rule the purge and the fresh link apply", async () => {
    const storage = spyStorage();
    const names = [
      "a/../b.txt",
      "/etc/passwd",
      "./x.txt",
      "back\\slash.txt",
      "bell\u0007.txt",
      "a".repeat(513),
      "d/ok.csv",
      "ok.txt",
    ];

    await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerFetch(names.map((path) => ({ path, size: 3, mimeType: "text/plain" }))),
      logger: spyLogger().logger,
    });

    const accepted = names.filter((name) => isSafeOutputName(name)).sort();
    expect(accepted).toEqual(["d/ok.csv", "ok.txt"]);
    expect(storage.put.mock.calls.map((call) => call[0])).toEqual(
      accepted.map((name) => runOutputKey("r1", name)),
    );
  });

  it("keeps the first 20 of 1,000 short names a runner lists, and counts the rest as over the count", async () => {
    const storage = spyStorage();
    const log = spyLogger();
    const manifest = Array.from({ length: 1000 }, (_, i) => ({
      path: `f-${String(i).padStart(4, "0")}.txt`,
      size: 3,
      mimeType: "text/plain",
    }));
    expect(JSON.stringify({ files: manifest }).length).toBeLessThan(MIB);

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerFetch(manifest),
      limits: { max_size_bytes: 10 * MIB, max_count: 20 },
      logger: log.logger,
    });

    expect(files.map((f) => f.name)).toEqual(manifest.slice(0, 20).map((f) => f.path));
    expect(storage.put).toHaveBeenCalledTimes(20);
    expect(excluded.over_count).toBe(980);
    expect(log.events()).toContainEqual({
      event: "files_count_exceeded",
      run_id: "r1",
      max_count: 20,
      over_count: 980,
    });
    // One line for the count, not one per file past it.
    expect(log.events().filter((e) => e.event === "outputs_file_excluded")).toEqual([]);
  });

  it("logs at most as many files it leaves out as a run may keep, then one line that counts the rest by reason: a list of 1,000 refused names", async () => {
    const storage = spyStorage();
    const log = spyLogger();
    const manifest = Array.from({ length: 1000 }, () => ({ path: ".", size: 0, mimeType: "" }));

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerFetch(manifest),
      limits: { max_size_bytes: 10 * MIB, max_count: 20 },
      logger: log.logger,
    });

    expect(files).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
    // The counts stay exact: only the lines are capped.
    expect(excluded.name_refused).toBe(1000);
    const perFile = log.events().filter((e) => e.event === "outputs_file_excluded");
    expect(perFile.map((e) => e.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(log.events().filter((e) => e.event === "outputs_files_excluded_unlogged")).toEqual([
      {
        event: "outputs_files_excluded_unlogged",
        run_id: "r1",
        name_refused: 980,
        too_large: 0,
        pull_failed: 0,
      },
    ]);
  });

  it("still writes the counts it did not log one by one when a write then fails the upload", async () => {
    const log = spyLogger();
    const storage = spyStorage();
    storage.put.mockRejectedValue(new Error("503 Slow Down"));

    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage,
        fetchImpl: runnerFetch([entry("../a"), entry("../b"), entry("x.txt")]),
        limits: { max_size_bytes: 1000, max_count: 1 },
        logger: log.logger,
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect(log.events().filter((e) => e.event === "outputs_file_excluded")).toHaveLength(1);
    expect(log.events().filter((e) => e.event === "outputs_files_excluded_unlogged")).toEqual([
      {
        event: "outputs_files_excluded_unlogged",
        run_id: "r1",
        name_refused: 1,
        too_large: 0,
        pull_failed: 0,
      },
    ]);
  });

  it("counts the files whose pull fails against the same cap as the names and sizes it refuses", async () => {
    const log = spyLogger();

    const { excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl: runnerServing(
        [
          entry("x.txt"),
          entry("../a"),
          entry("big.bin", 2000),
          entry("y.txt"),
          entry("../b"),
          entry("z.txt"),
        ],
        () => new Response("gone", { status: 404 }),
      ),
      limits: { max_size_bytes: 1000, max_count: 3 },
      logger: log.logger,
    });

    expect(excluded).toMatchObject({ name_refused: 2, too_large: 1, pull_failed: 3 });
    expect(
      log
        .events()
        .filter((e) => e.event === "outputs_file_excluded")
        .map((e) => e.reason),
    ).toEqual(["name_refused", "name_refused", "too_large"]);
    expect(log.events().filter((e) => e.event === "outputs_files_excluded_unlogged")).toEqual([
      {
        event: "outputs_files_excluded_unlogged",
        run_id: "r1",
        name_refused: 0,
        too_large: 0,
        pull_failed: 3,
      },
    ]);
  });

  it("leaves out a file the runner announces past the size limit, and counts it as too large", async () => {
    const storage = spyStorage();
    const log = spyLogger();

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerFetch([
        { path: "big.bin", size: 11, mimeType: "application/octet-stream" },
        { path: "ok.txt", size: 3, mimeType: "text/plain" },
      ]),
      limits: { max_size_bytes: 10, max_count: 20 },
      logger: log.logger,
    });

    expect(files.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(excluded.too_large).toBe(1);
    expect(log.events()).toContainEqual({
      event: "outputs_file_excluded",
      run_id: "r1",
      index: 0,
      size: 11,
      reason: "too_large",
    });
  });

  it("adds what the runner left out to what it leaves out itself, and logs the runner's counts", async () => {
    const log = spyLogger();

    const { excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl: runnerFetch(
        [
          { path: "a/../b", size: 3, mimeType: "text/plain" },
          { path: "ok.txt", size: 3, mimeType: "text/plain" },
        ],
        { excluded: { name_refused: 2, too_large: 1, over_count: 5 } },
      ),
      logger: log.logger,
    });

    expect(excluded).toEqual({
      name_refused: 3,
      too_large: 1,
      over_count: 5,
      pull_failed: 0,
      upload_budget: 0,
    });
    expect(log.events()).toContainEqual({
      event: "outputs_runner_excluded",
      run_id: "r1",
      name_refused: 2,
      too_large: 1,
      over_count: 5,
    });
  });

  it("counts nothing left out when nothing is", async () => {
    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl: runnerFetch([]),
    });

    expect(files).toEqual([]);
    expect(excluded).toEqual({
      name_refused: 0,
      too_large: 0,
      over_count: 0,
      pull_failed: 0,
      upload_budget: 0,
    });
  });

  it("fails on a list one byte past 1 MiB, never parsing it, and stores nothing", async () => {
    const storage = spyStorage();
    const head = '{"files":[],"pad":"';
    const tail = '"}';
    const body = head + "x".repeat(MIB + 1 - head.length - tail.length) + tail;
    expect(Buffer.byteLength(body)).toBe(MIB + 1);

    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage,
        fetchImpl: rawListFetch(body),
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).message).toBe(UPLOAD_ERROR_MESSAGE);
    expect((error as Error).cause).toBeInstanceOf(RunnerResponseTooLarge);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("reads a list of up to one KiB per file it may keep, when that is more than 1 MiB", async () => {
    const head = '{"files":[],"pad":"';
    const tail = '"}';
    const body = head + "x".repeat(2 * MIB - head.length - tail.length) + tail;

    const { files } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl: rawListFetch(body),
      limits: { max_size_bytes: MIB, max_count: 2048 },
    });

    expect(files).toEqual([]);
  });

  it.each([
    [
      "an entry whose path is not text",
      JSON.stringify({ files: [{ path: 42, size: 3, mimeType: "x" }] }),
    ],
    [
      "an entry whose size is not a whole number",
      JSON.stringify({ files: [{ path: "a", size: 1.5, mimeType: "x" }] }),
    ],
    ["a list that is not JSON", "not json"],
    ["an answer without a list", JSON.stringify({ ok: true })],
  ])("fails on %s, with the error of its own class and a constant message", async (_name, body) => {
    const storage = spyStorage();
    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage,
        fetchImpl: rawListFetch(body),
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).name).toBe("OutputsUploadError");
    expect((error as Error).message).toBe(UPLOAD_ERROR_MESSAGE);
    expect((error as OutputsUploadError).code).toBe("outputs_list");
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("fails on a list answered with an error status, its text never in the message nor read", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("collect failed under /mnt/session/outputs"));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: spyStorage(),
        fetchImpl: rawListFetch(body, 500),
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).message).toBe(UPLOAD_ERROR_MESSAGE);
    expect((error as OutputsUploadError).code).toBe("outputs_list");
    expect(cancelled).toBe(true);
    // Its cause is of a class of its own, which carries the status, never the text.
    const cause = (error as Error).cause as Error & { status?: unknown };
    expect({ name: cause.name, status: cause.status }).toEqual({
      name: "RunnerStatusError",
      status: 500,
    });
    expect(cause.message).not.toContain("collect failed");
  });

  it("fails on a redirect from /outputs/collect, and the address it points at is never asked", async () => {
    const runner = await serve((req, res) => {
      if (req.url === "/outputs/collect") {
        res.writeHead(302, { Location: "/internal" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('{"files":[]}');
    });

    const { error } = await outcome(
      uploadOutputs({ runId: "r1", runnerBaseUrl: runner.url, storage: spyStorage() }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).cause).toBeInstanceOf(RunnerRedirectRefused);
    expect(runner.hits).toEqual(["/outputs/collect"]);
  });

  it("fails 30 s after asking a runner that never answers its list", async () => {
    vi.useFakeTimers();
    // Never answers — until its own guard, ten times the bound, ends the request.
    const fetchImpl = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error("the test's guard")), 300_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(guard);
            reject(init.signal?.reason);
          });
        }),
    ) as unknown as typeof fetch;
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: spyStorage(),
        fetchImpl,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);

    const { error } = await pending;
    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).cause).toBeInstanceOf(RunnerCallTimeout);
  });

  it.each([
    0, 20_000,
  ])("fails 30 s after asking when the list's headers come after %i ms but its body does not end", async (headersAfterMs) => {
    vi.useFakeTimers();
    // Sends nothing of its body, then ends by itself well past the bound.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            // already cancelled
          }
        }, 300_000);
      },
    });
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response(body, { status: 200 })), headersAfterMs),
        ),
    ) as unknown as typeof fetch;
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: spyStorage(),
        fetchImpl,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);

    const { error } = await pending;
    expect(error).toBeInstanceOf(OutputsUploadError);
  });
});

// ---------------------------------------------------------------------------
// Pulling each file: one buffer no larger than the size limit.
// ---------------------------------------------------------------------------

/**
 * A body in memory that counts what its reader took. It hands a chunk only when
 * one is read (no read-ahead), so `delivered` is exactly what was read. It ends
 * by itself after `total` bytes.
 */
function countedBody(total: number, chunk = 1) {
  const state = { delivered: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.delivered >= total) {
          controller.close();
          return;
        }
        const n = Math.min(chunk, total - state.delivered);
        state.delivered += n;
        controller.enqueue(new Uint8Array(n).fill(0x61));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** A runner that lists `manifest` and answers each file pull with `answer(path)`. */
function runnerServing(
  manifest: ManifestEntry[],
  answer: (path: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/outputs/collect") {
      return new Response(JSON.stringify({ files: manifest }), { status: 200 });
    }
    return answer(url.searchParams.get("path") ?? "", init);
  }) as unknown as typeof fetch;
}

const entry = (path: string, size = 3) => ({ path, size, mimeType: "text/plain" });
const LIMIT = { max_size_bytes: 1000, max_count: 20 };

describe("uploadOutputs — each file is read into one buffer no larger than its limit", () => {
  it("reads one byte past the limit of a file that runs on, no more, leaves it out, and stores the others", async () => {
    const storage = spyStorage();
    const log = spyLogger();
    const hostile = countedBody(3 * LIMIT.max_size_bytes);

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("a.txt"), entry("hostile.bin"), entry("z.txt")], (path) =>
        path === "hostile.bin" ? new Response(hostile.stream) : new Response("abc"),
      ),
      limits: LIMIT,
      logger: log.logger,
    });

    expect(hostile.state.delivered).toBe(LIMIT.max_size_bytes + 1);
    expect(hostile.state.cancelled).toBe(true);
    expect(storage.put.mock.calls.map((call) => call[0])).toEqual([
      runOutputKey("r1", "a.txt"),
      runOutputKey("r1", "z.txt"),
    ]);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "z.txt"]);
    expect(excluded.too_large).toBe(1);
    expect(log.events()).toContainEqual({
      event: "outputs_file_excluded",
      run_id: "r1",
      index: 1,
      size: 3,
      reason: "too_large",
    });
  });

  it("stops within one chunk past a 10 MiB limit a file sent in 64 KiB chunks that runs to 30 MiB", async () => {
    const storage = spyStorage();
    const hostile = countedBody(30 * MIB, 64 * 1024);

    const { excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("hostile.bin")], () => new Response(hostile.stream)),
      limits: { max_size_bytes: 10 * MIB, max_count: 20 },
      logger: spyLogger().logger,
    });

    expect(hostile.state.delivered).toBeLessThanOrEqual(10 * MIB + 64 * 1024);
    expect(hostile.state.cancelled).toBe(true);
    expect(excluded.too_large).toBe(1);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("stores a file of exactly its limit, and leaves out one a byte longer", async () => {
    const storage = spyStorage();

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing(
        [entry("at-limit.bin"), entry("past-limit.bin")],
        (path) => new Response(Buffer.alloc(path === "at-limit.bin" ? 1000 : 1001, 0x61)),
      ),
      limits: LIMIT,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => [f.name, f.size])).toEqual([["at-limit.bin", 1000]]);
    expect(storage.put.mock.calls[0]?.[1]).toHaveLength(1000);
    expect(excluded.too_large).toBe(1);
  });

  it("leaves out a file whose Content-Length is past its limit without reading a byte of its body", async () => {
    const storage = spyStorage();
    const body = countedBody(1001);

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing(
        [entry("declared.bin")],
        () => new Response(body.stream, { headers: { "Content-Length": "1001" } }),
      ),
      limits: LIMIT,
      logger: spyLogger().logger,
    });

    expect(body.state.delivered).toBe(0);
    expect(body.state.cancelled).toBe(true);
    expect(files).toEqual([]);
    expect(excluded.too_large).toBe(1);
  });

  it("reports the size it received, never the size the runner announced", async () => {
    const storage = spyStorage();

    const { files } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("grew.txt", 3)], () => new Response("12345")),
      limits: LIMIT,
    });

    expect(files.map((f) => f.size)).toEqual([5]);
    expect(storage.put.mock.calls[0]?.[1]?.toString()).toBe("12345");
  });

  it("leaves out a file whose answer ends before its Content-Length, and stores the others", async () => {
    const storage = spyStorage();
    const log = spyLogger();

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("a.txt"), entry("shrunk.txt", 10)], (path) =>
        path === "shrunk.txt"
          ? new Response("12345", { headers: { "Content-Length": "10" } })
          : new Response("abc"),
      ),
      limits: LIMIT,
      logger: log.logger,
    });

    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(excluded.pull_failed).toBe(1);
    expect(log.events()).toContainEqual({
      event: "outputs_file_excluded",
      run_id: "r1",
      index: 1,
      size: 10,
      reason: "pull_failed",
    });
  });

  it("leaves out a file whose connection is cut before its Content-Length, and stores the others", async () => {
    const storage = spyStorage();
    const runner = await serve((req, res) => {
      if (req.url === "/outputs/collect") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files: [entry("a-shrunk.txt", 10), entry("b.txt")] }));
        return;
      }
      if (req.url?.includes("a-shrunk.txt")) {
        res.writeHead(200, { "Content-Length": "10" });
        res.write("12345", () => res.destroy());
        return;
      }
      res.writeHead(200);
      res.end("bbb");
    });

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: runner.url,
      storage,
      limits: LIMIT,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(excluded.pull_failed).toBe(1);
  });

  // The shape of a file that shrank while the runner served it, when the runner
  // ends the answer cleanly: short of its Content-Length, the connection left
  // open. What is required: that file is left out as a failed pull, and the
  // others are stored. How long it takes is not asserted. Today nothing tells
  // the client such an answer is over, so the pull waits for its own time —
  // this case's short bound, rather than the default 60 s — or for the server
  // to close the connection as idle, five seconds later by default in Node's
  // server. That wait is a limitation, not a requirement: a client that ended
  // such an answer at once would do better, and this case must stay green then.
  // Only the runner, by failing the answer and so closing the connection (the
  // case above), ends such a pull at once today.
  it("leaves out a file whose answer ends short of its Content-Length on a connection left open, and stores the others", async () => {
    const storage = spyStorage();
    const runner = await serve((req, res) => {
      if (req.url === "/outputs/collect") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files: [entry("a-shrunk.txt", 10), entry("b.txt")] }));
        return;
      }
      if (req.url?.includes("a-shrunk.txt")) {
        res.writeHead(200, { "Content-Length": "10" });
        res.end("12345");
        return;
      }
      res.writeHead(200);
      res.end("bbb");
    });
    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: runner.url,
      storage,
      limits: LIMIT,
      pullTimeoutMs: 400,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(excluded.pull_failed).toBe(1);
  });

  it("leaves out a file whose pull redirects, and the address it points at is never asked", async () => {
    const storage = spyStorage();
    const runner = await serve((req, res) => {
      if (req.url === "/outputs/collect") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ files: [entry("a.txt"), entry("b.txt")] }));
        return;
      }
      if (req.url?.includes("a.txt")) {
        res.writeHead(302, { Location: "/internal" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("bbb");
    });

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: runner.url,
      storage,
      limits: LIMIT,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(excluded.pull_failed).toBe(1);
    expect(runner.hits.filter((hit) => hit.startsWith("/internal"))).toEqual([]);
  });

  it.each([
    [413, "too_large"],
    [404, "pull_failed"],
    [500, "pull_failed"],
  ] as const)("leaves out a file the runner answers %i, as %s, reads nothing of that answer, and stores the others", async (status, reason) => {
    const storage = spyStorage();
    const refusal = countedBody(64);

    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("a.txt"), entry("b.txt")], (path) =>
        path === "a.txt" ? new Response(refusal.stream, { status }) : new Response("bbb"),
      ),
      limits: LIMIT,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(excluded[reason]).toBe(1);
    expect(refusal.state.delivered).toBe(0);
    expect(refusal.state.cancelled).toBe(true);
  });

  it("logs a file it leaves out by its position in the runner's list", async () => {
    const log = spyLogger();

    await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: spyStorage(),
      fetchImpl: runnerServing(
        [entry("z.txt"), entry("../refused"), entry("a-missing.txt")],
        (path) =>
          path === "a-missing.txt" ? new Response("gone", { status: 404 }) : new Response("zzz"),
      ),
      limits: LIMIT,
      logger: log.logger,
    });

    expect(
      log
        .events()
        .filter((e) => e.event === "outputs_file_excluded")
        .map((e) => [e.index, e.reason]),
    ).toEqual([
      [1, "name_refused"],
      [2, "pull_failed"],
    ]);
    // Every file it left out was logged one by one: nothing left to count apart.
    expect(log.events().filter((e) => e.event === "outputs_files_excluded_unlogged")).toEqual([]);
  });

  it.each([
    "headers",
    "body",
  ])("leaves out a file when the wait for its %s outlasts the pull's time, and stores the others", async (stalled) => {
    const storage = spyStorage();
    // Never sends what is stalled — until its own guard, well past the bound, ends it.
    const stall = (init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (stalled === "body") {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                try {
                  controller.close();
                } catch {
                  // already cancelled
                }
              }, 3_000);
            },
          });
          resolve(new Response(body));
          return;
        }
        const guard = setTimeout(() => reject(new Error("the test's guard")), 3_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(guard);
          reject(init.signal?.reason);
        });
      });

    const startedAt = Date.now();
    const { files, excluded } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("a.txt"), entry("b.txt")], (path, init) =>
        path === "a.txt" ? stall(init) : new Response("bbb"),
      ),
      limits: LIMIT,
      pullTimeoutMs: 200,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["b.txt"]);
    expect(excluded.pull_failed).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("reserves its limit on the bytes budget for one file at a time, and gives it back whatever became of the file", async () => {
    const budget = new OutputBytesBudget(100 * 1024);
    const heldAtPut: number[] = [];
    const storage = spyStorage();
    storage.put.mockImplementation(async () => {
      heldAtPut.push(budget.inUse);
    });

    const { files } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing(
        [entry("a.txt"), entry("b-missing.txt"), entry("c-big.bin"), entry("d.txt")],
        (path) => {
          if (path === "b-missing.txt") return new Response("gone", { status: 404 });
          if (path === "c-big.bin") return new Response(Buffer.alloc(1001));
          return new Response("abc");
        },
      ),
      limits: LIMIT,
      bytesBudget: budget,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["a.txt", "d.txt"]);
    expect(heldAtPut).toEqual([LIMIT.max_size_bytes, LIMIT.max_size_bytes]);
    expect(budget.inUse).toBe(0);
  });

  it("gives its reservation back when a write fails", async () => {
    const budget = new OutputBytesBudget(100 * 1024);
    const storage = spyStorage();
    storage.put.mockRejectedValue(new Error("store unreachable"));

    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage,
        fetchImpl: runnerServing([entry("a.txt")], () => new Response("abc")),
        limits: LIMIT,
        bytesBudget: budget,
      }),
    );

    expect(error).toBeDefined();
    expect(budget.inUse).toBe(0);
  });

  it("pulls nothing until the bytes budget has room for its limit", async () => {
    const budget = new OutputBytesBudget(1500);
    const held = await budget.reserve(1000);
    const pulled: string[] = [];
    const storage = spyStorage();

    const upload = uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl: runnerServing([entry("a.txt")], (path) => {
        pulled.push(path);
        return new Response("abc");
      }),
      limits: LIMIT,
      bytesBudget: budget,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulled).toEqual([]);
    expect(budget.waiting).toBe(1);

    held();
    const { files } = await upload;
    expect(pulled).toEqual(["a.txt"]);
    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(budget.inUse).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The upload's time budget, and what each failure does to the upload.
// ---------------------------------------------------------------------------

/** The clock these cases run on: timers and the date, never the microtask queue. */
function simulatedClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

/** An error of the given class name, its message quoting what it failed on — as a storage client's does. */
function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

interface StoreBehaviour {
  /** How the write of `key` ends, once the store holds the whole object. Default: at once. */
  put?: (key: string, signal: AbortSignal | undefined) => Promise<void>;
  /** How the signing of `key`'s link ends. Default: at once. */
  presign?: (key: string) => Promise<string>;
  /** The store's delete: present (the default), absent, or failing. */
  deletes?: "yes" | "absent" | "failing";
}

/**
 * A store that keeps what it is written, by key. A write holds the whole object
 * before it answers — so a write cut while it waits for its answer may have left
 * an object, as a real store's may. `steps` notes when each write ended and each
 * delete was asked.
 */
function objectStore(behaviour: StoreBehaviour = {}) {
  const objects = new Map<string, Buffer>();
  const steps: string[] = [];
  const store: PresignedStorageAdapter = {
    put: vi.fn(async (key: string, data: Buffer, opts?: { signal?: AbortSignal }) => {
      objects.set(key, Buffer.from(data));
      try {
        await (behaviour.put?.(key, opts?.signal) ?? Promise.resolve());
      } finally {
        steps.push(`write ended: ${key}`);
      }
    }),
    getPresignedDownloadUrl: vi.fn(async (key: string) =>
      behaviour.presign ? behaviour.presign(key) : `https://store.example/${key}`,
    ),
    getPresignedUploadUrl: vi.fn(),
  };
  if (behaviour.deletes !== "absent") {
    store.delete = vi.fn(async (key: string) => {
      steps.push(`delete: ${key}`);
      if (behaviour.deletes === "failing") throw new Error(`DELETE ${key}: 500 Internal Error`);
      objects.delete(key);
    });
  }
  return { store, objects, steps };
}

/**
 * A write that waits for its answer until its signal is aborted, then fails with
 * an error of class `name`. Never aborted, it ends by itself at ten times the
 * budget: a case where the signal is lost fails on its assertions, it does not
 * hang. `seen.interrupted` says whether the signal ended it.
 */
function writeCutBySignal(name: string, seen: { interrupted: boolean }) {
  return (_key: string, signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      const guard = setTimeout(resolve, 10 * OUTPUTS_UPLOAD_BUDGET_MS);
      const cut = () => {
        clearTimeout(guard);
        seen.interrupted = true;
        reject(namedError(name, "Request aborted"));
      };
      if (signal?.aborted) cut();
      else signal?.addEventListener("abort", cut, { once: true });
    });
}

/** An answer that comes after `ms`, or fails with the request's reason when it is aborted first. */
function answerAfter(ms: number, init: RequestInit | undefined, body = "abc"): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const served = setTimeout(() => resolve(new Response(body)), ms);
    const signal = init?.signal;
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(served);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

describe("uploadOutputs — a failure before the budget runs out", () => {
  it.each([
    "TimeoutError",
    "AbortError",
    "Error",
  ])("fails with an error of its own and a constant message when a write fails with %s, the key never in it", async (name) => {
    const { store } = objectStore({
      put: (key) => Promise.reject(namedError(name, `PUT ${key}: 503 Slow Down`)),
    });

    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing([entry("report.txt")], () => new Response("abc")),
        limits: LIMIT,
        logger: spyLogger().logger,
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).name).toBe("OutputsUploadError");
    expect((error as Error).message).toBe(UPLOAD_ERROR_MESSAGE);
    expect((error as OutputsUploadError).code).toBe("outputs_put");
    expect(((error as Error).cause as Error).name).toBe(name);
  });

  it("fails with an error of its own and a constant message when a stored file's link cannot be signed", async () => {
    const { store } = objectStore({
      presign: (key) => Promise.reject(new Error(`cannot sign ${key}`)),
    });

    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing([entry("report.txt")], () => new Response("abc")),
        limits: LIMIT,
        logger: spyLogger().logger,
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).message).toBe(UPLOAD_ERROR_MESSAGE);
    expect((error as OutputsUploadError).code).toBe("outputs_presign");
  });

  it("fails with an error of its own, named after the reservation, when the bytes budget refuses one before the upload's time is spent", async () => {
    const storage = spyStorage();
    const refusing = {
      reserve: () => Promise.reject(new RangeError("a reservation is a whole number of bytes")),
    } as unknown as OutputBytesBudget;

    const { error } = await outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage,
        fetchImpl: runnerServing([entry("report.txt")], () => new Response("abc")),
        limits: LIMIT,
        logger: spyLogger().logger,
        bytesBudget: refusing,
      }),
    );

    expect(error).toBeInstanceOf(OutputsUploadError);
    expect((error as Error).message).toBe(UPLOAD_ERROR_MESSAGE);
    expect((error as OutputsUploadError).code).toBe("outputs_reserve");
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("logs what it stored, the bytes, how many files it left out and how long it took", async () => {
    const log = spyLogger();

    await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: objectStore().store,
      fetchImpl: runnerServing([entry("a.txt"), entry("../refused"), entry("b.txt")], () =>
        Promise.resolve(new Response("abc")),
      ),
      limits: LIMIT,
      logger: log.logger,
    });

    expect(log.events()).toContainEqual({
      event: "outputs_uploaded",
      run_id: "r1",
      files: 2,
      bytes: 6,
      excluded: 1,
      duration_ms: expect.any(Number),
    });
  });
});

describe("uploadOutputs — a time budget for the whole upload", () => {
  it("is two minutes", () => {
    expect(OUTPUTS_UPLOAD_BUDGET_MS).toBe(120_000);
  });

  it("stops at its budget during the pull of the third of twenty files each served just under 60 s: two stored, the rest left out", async () => {
    simulatedClock();
    const { store, objects } = objectStore();
    const log = spyLogger();
    const bytesBudget = new OutputBytesBudget();
    const names = Array.from({ length: 20 }, (_, i) => `f-${String(i).padStart(2, "0")}.txt`);
    const pulls: Array<AbortSignal | null | undefined> = [];
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing(
          names.map((name) => entry(name)),
          (_path, init) => {
            pulls.push(init?.signal);
            return answerAfter(59_000, init);
          },
        ),
        limits: LIMIT,
        logger: log.logger,
        bytesBudget,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const { value, error } = await pending;
    expect(error).toBeUndefined();
    expect(value?.files.map((f) => f.name)).toEqual(["f-00.txt", "f-01.txt"]);
    expect(value?.excluded.upload_budget).toBe(18);
    expect(value?.excluded.pull_failed).toBe(0);
    // The third pull was the one under way: it was told to stop.
    expect(pulls).toHaveLength(3);
    expect(pulls[2]?.aborted).toBe(true);
    expect([...objects.keys()]).toEqual([
      runOutputKey("r1", "f-00.txt"),
      runOutputKey("r1", "f-01.txt"),
    ]);
    expect(log.events()).toContainEqual({
      event: "outputs_upload_budget_exhausted",
      run_id: "r1",
      stage: "pull",
      uploaded: 2,
      excluded: 18,
    });
    expect(
      log.events().filter((e) => e.event === "outputs_file_excluded"),
      "a file the budget left out is not a failed pull",
    ).toEqual([]);
    expect(bytesBudget.inUse).toBe(0);
  });

  it.each([
    "AbortError",
    "TimeoutError",
  ])("stops at its budget during a write that then fails with %s: the file before it stored, it and the one after left out, its object erased once it ended", async (name) => {
    simulatedClock();
    const seen = { interrupted: false };
    const cutKey = runOutputKey("r1", "b.txt");
    const { store, objects, steps } = objectStore({
      put: (key, signal) =>
        key === cutKey ? writeCutBySignal(name, seen)(key, signal) : Promise.resolve(),
    });
    const log = spyLogger();
    const bytesBudget = new OutputBytesBudget();
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing([entry("a.txt"), entry("b.txt"), entry("c.txt")], () =>
          Promise.resolve(new Response("abc")),
        ),
        limits: LIMIT,
        logger: log.logger,
        bytesBudget,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, "the write was cut by the budget, not left to end by itself").toBe(true);

    const { value, error } = await pending;
    expect(error).toBeUndefined();
    expect(seen.interrupted).toBe(true);
    expect(value?.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(value?.excluded.upload_budget).toBe(2);
    expect(log.events()).toContainEqual({
      event: "outputs_upload_budget_exhausted",
      run_id: "r1",
      stage: "put",
      uploaded: 1,
      excluded: 2,
    });
    // The cut write's object is erased, once the write has ended; c.txt is never written.
    expect(steps.filter((step) => step.endsWith(cutKey))).toEqual([
      `write ended: ${cutKey}`,
      `delete: ${cutKey}`,
    ]);
    expect([...objects.keys()]).toEqual([runOutputKey("r1", "a.txt")]);
    expect(bytesBudget.inUse).toBe(0);
  });

  it("waits for a write that ignores its signal to end, then stops: that file left out, its object erased", async () => {
    simulatedClock();
    const slowKey = runOutputKey("r1", "b.txt");
    const { store, objects, steps } = objectStore({
      // A store that cannot be interrupted: its write ends 10 s past the budget.
      put: (key) =>
        key === slowKey
          ? new Promise<void>((resolve) => setTimeout(resolve, OUTPUTS_UPLOAD_BUDGET_MS + 10_000))
          : Promise.resolve(),
    });
    const log = spyLogger();
    const bytesBudget = new OutputBytesBudget();
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing([entry("a.txt"), entry("b.txt"), entry("c.txt")], () =>
          Promise.resolve(new Response("abc")),
        ),
        limits: LIMIT,
        logger: log.logger,
        bytesBudget,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS);
    // Its buffer is still the write's: nothing is given back before it ends.
    expect(settled).toBe(false);
    expect(bytesBudget.inUse).toBe(LIMIT.max_size_bytes);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);

    const { value } = await pending;
    expect(value?.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(value?.excluded.upload_budget).toBe(2);
    expect(log.events()).toContainEqual({
      event: "outputs_upload_budget_exhausted",
      run_id: "r1",
      stage: "put",
      uploaded: 1,
      excluded: 2,
    });
    expect(steps.filter((step) => step.endsWith(slowKey))).toEqual([
      `write ended: ${slowKey}`,
      `delete: ${slowKey}`,
    ]);
    expect([...objects.keys()]).toEqual([runOutputKey("r1", "a.txt")]);
    expect(bytesBudget.inUse).toBe(0);
  });

  it("leaves no timer behind once it is done", async () => {
    simulatedClock();

    const { files } = await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage: objectStore().store,
      fetchImpl: runnerServing([entry("a.txt")], () => Promise.resolve(new Response("abc"))),
      limits: LIMIT,
      logger: spyLogger().logger,
    });

    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at its budget while it waits for room on the bytes budget: nothing pulled, every file left out, its place in the line given up", async () => {
    simulatedClock();
    const bytesBudget = new OutputBytesBudget(1500);
    const held = await bytesBudget.reserve(1000);
    const pulled: string[] = [];
    const log = spyLogger();
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: objectStore().store,
        fetchImpl: runnerServing([entry("a.txt"), entry("b.txt"), entry("c.txt")], (path) => {
          pulled.push(path);
          return new Response("abc");
        }),
        limits: LIMIT,
        logger: log.logger,
        bytesBudget,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS - 1);
    expect(settled).toBe(false);
    expect(bytesBudget.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const { value, error } = await pending;
    expect(error).toBeUndefined();
    expect(value?.files).toEqual([]);
    expect(value?.excluded.upload_budget).toBe(3);
    expect(pulled).toEqual([]);
    expect(bytesBudget.waiting).toBe(0);
    expect(log.events()).toContainEqual({
      event: "outputs_upload_budget_exhausted",
      run_id: "r1",
      stage: "reserve",
      uploaded: 0,
      excluded: 3,
    });
    held();
    expect(bytesBudget.inUse).toBe(0);
  });

  it("stops at its budget while a stored file's link is signed: that file left out, its object erased", async () => {
    simulatedClock();
    const slowKey = runOutputKey("r1", "b.txt");
    const { store, objects, steps } = objectStore({
      // Ends by itself well past the budget.
      presign: (key) =>
        new Promise<string>((resolve) =>
          setTimeout(
            () => resolve(`https://store.example/${key}`),
            key === slowKey ? 10 * OUTPUTS_UPLOAD_BUDGET_MS : 0,
          ),
        ),
    });
    const log = spyLogger();
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing([entry("a.txt"), entry("b.txt")], () =>
          Promise.resolve(new Response("abc")),
        ),
        limits: LIMIT,
        logger: log.logger,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS);
    expect(settled).toBe(true);

    const { value } = await pending;
    expect(value?.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(value?.excluded.upload_budget).toBe(1);
    expect(log.events()).toContainEqual({
      event: "outputs_upload_budget_exhausted",
      run_id: "r1",
      stage: "presign",
      uploaded: 1,
      excluded: 1,
    });
    expect(steps).toContain(`delete: ${slowKey}`);
    expect([...objects.keys()]).toEqual([runOutputKey("r1", "a.txt")]);
    await vi.advanceTimersByTimeAsync(10 * OUTPUTS_UPLOAD_BUDGET_MS);
  });

  it.each([
    ["has no delete", "absent", { reason: "no_delete" }],
    ["fails to delete", "failing", { reason: "delete_failed", error_name: "Error" }],
  ] as const)("logs the object a cut write may have left when the store %s, by its position and never its key", async (_what, deletes, fields) => {
    simulatedClock();
    const seen = { interrupted: false };
    const { store } = objectStore({
      put: (key, signal) =>
        key.endsWith("b.txt")
          ? writeCutBySignal("AbortError", seen)(key, signal)
          : Promise.resolve(),
      deletes,
    });
    const log = spyLogger();
    let settled = false;
    const pending = outcome(
      uploadOutputs({
        runId: "r1",
        runnerBaseUrl: "http://runner:9000",
        storage: store,
        fetchImpl: runnerServing([entry("a.txt"), entry("b.txt")], () =>
          Promise.resolve(new Response("abc")),
        ),
        limits: LIMIT,
        logger: log.logger,
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(OUTPUTS_UPLOAD_BUDGET_MS);
    expect(settled).toBe(true);
    const { value } = await pending;
    expect(value?.files.map((f) => f.name)).toEqual(["a.txt"]);
    await vi.waitFor(() =>
      expect(log.events()).toContainEqual({
        event: "outputs_interrupted_object_left",
        run_id: "r1",
        index: 1,
        ...fields,
      }),
    );
    expect(JSON.stringify(log.events())).not.toContain("b.txt");
  });
});
