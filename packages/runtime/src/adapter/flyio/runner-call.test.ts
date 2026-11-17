import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  callRunner,
  discardRunnerBody,
  fetchWithDeadline,
  RUNNER_ERROR_BODY_MAX_BYTES,
  RunnerBodyTimeout,
  RunnerCallTimeout,
  RunnerRedirectRefused,
  RunnerResponseTooLarge,
  readRunnerBody,
  readRunnerBodyInto,
  readRunnerErrorText,
  readRunnerJson,
} from "./runner-call.js";

// ---------------------------------------------------------------------------
// A server on the loopback address, in this process. The client cancels the
// answers it stops reading: a reset or a broken pipe on the server's side is
// the expected end of such an answer, never a failure of the test.
// ---------------------------------------------------------------------------

interface LocalServer {
  url: string;
  /** The path of every request it received, in order. */
  hits: string[];
  /** Bytes it managed to hand to its sockets, per request path. */
  written: Map<string, number>;
  close(): Promise<void>;
}

const opened: LocalServer[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((server) => server.close()));
});

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, server: LocalServer) => void,
): Promise<LocalServer> {
  const hits: string[] = [];
  const written = new Map<string, number>();
  let local: LocalServer | undefined;
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.on("error", () => {});
    if (local) handler(req, res, local);
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  local = {
    url: `http://127.0.0.1:${port}`,
    hits,
    written,
    close: () =>
      new Promise<void>((resolve) => {
        // Stop accepting first, then end every connection: the order Node documents.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  opened.push(local);
  return local;
}

/**
 * Writes `total` bytes in chunks of `chunk`, as fast as the client takes them,
 * then ends: an answer that would be endless for a reader without a bound, and
 * that still stops by itself.
 */
function writeBytes(res: ServerResponse, server: LocalServer, path: string, total: number): void {
  const piece = Buffer.alloc(16 * 1024, 0x61);
  let sent = 0;
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  const pump = (): void => {
    while (sent < total) {
      if (res.destroyed) return;
      const n = Math.min(piece.length, total - sent);
      sent += n;
      server.written.set(path, sent);
      if (!res.write(piece.subarray(0, n))) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

/**
 * A body in memory that counts what its reader took. It hands a chunk only when
 * one is read (no read-ahead), so `delivered` is exactly what was read. It ends
 * by itself after `total` bytes, or after `endAfterMs` when it never delivers.
 */
function countedBody(
  total: number,
  options: { chunk?: number; never?: boolean; endAfterMs?: number } = {},
) {
  const chunk = options.chunk ?? 1024;
  const state = { delivered: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (options.never) {
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          }, options.endAfterMs ?? 1_000);
        }
      },
      pull(controller) {
        if (options.never) return new Promise<void>(() => {});
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

/** What a promise settled with, so that a test asserts the rejection itself. */
async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

const KIB = 1024;

// ---------------------------------------------------------------------------

describe("callRunner — a redirect from the runner is refused, never followed", () => {
  it.each([
    301, 302, 303, 307, 308,
  ])("fails the call on a %i, and the address it points at is never asked", async (status) => {
    const target = await serve((_req, res) => res.end("an internal answer"));
    const runner = await serve((_req, res) => {
      res.writeHead(status, { Location: `${target.url}/internal` });
      res.end("moved");
    });

    const { error } = await outcome(
      callRunner(fetch, `${runner.url}/tool`, { method: "POST" }, { headersTimeoutMs: 5_000 }),
    );

    expect(target.hits).toEqual([]);
    expect(error).toBeInstanceOf(RunnerRedirectRefused);
    expect((error as Error).message).toBe(
      "/tool answered with a redirect, which is never followed",
    );
    expect(runner.hits).toEqual(["/tool"]);
  });

  it("refuses it even when the caller asked to follow redirects", async () => {
    const target = await serve((_req, res) => res.end("an internal answer"));
    const runner = await serve((_req, res) => {
      res.writeHead(302, { Location: `${target.url}/internal` });
      res.end();
    });

    const { error } = await outcome(
      callRunner(fetch, `${runner.url}/init`, { redirect: "follow" }, { headersTimeoutMs: 5_000 }),
    );

    expect(target.hits).toEqual([]);
    expect(error).toBeInstanceOf(RunnerRedirectRefused);
  });

  it("names the call by its path, never by the query it carries", async () => {
    const runner = await serve((_req, res) => {
      res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
      res.end();
    });

    const { error } = await outcome(
      callRunner(
        fetch,
        `${runner.url}/outputs/file?path=report-of-acme.pdf`,
        {},
        {
          headersTimeoutMs: 5_000,
        },
      ),
    );

    expect((error as Error).message).toBe(
      "/outputs/file answered with a redirect, which is never followed",
    );
  });

  it("hands back an answer that does not redirect, its body unread", async () => {
    const runner = await serve((_req, res) => res.end('{"ok":true}'));

    const response = await callRunner(
      fetch,
      `${runner.url}/healthz`,
      {},
      {
        headersTimeoutMs: 5_000,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });
});

describe("callRunner — the wait for the answer's headers is bounded", () => {
  /**
   * A fetch that does not answer, and stops when aborted, as the platform's
   * does. It gives up by itself after 2 s, so that a call with no bound fails
   * an assertion here rather than the test's own timeout.
   */
  function silent(seen: { signal?: AbortSignal | null; init?: RequestInit }): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.signal = init?.signal;
      seen.init = init;
      return new Promise<Response>((_resolve, reject) => {
        const gaveUp = setTimeout(
          () => reject(new Error("the fake fetch gave up by itself")),
          2_000,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(gaveUp);
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
  }

  it("aborts a call still unanswered at its bound, and names the wait by the call's path", async () => {
    const seen: { signal?: AbortSignal | null } = {};

    const { error } = await outcome(
      callRunner(
        silent(seen),
        "http://[fdaa::1]:9000/claim",
        { method: "POST" },
        {
          headersTimeoutMs: 50,
        },
      ),
    );

    expect(seen.signal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(RunnerCallTimeout);
    expect((error as Error).message).toBe("/claim did not answer within 50 ms: timed out");
  });

  it("always asks the client to refuse redirects", async () => {
    const seen: { init?: RequestInit } = {};

    await outcome(
      callRunner(
        silent(seen),
        "http://[fdaa::1]:9000/init",
        { redirect: "manual" },
        {
          headersTimeoutMs: 10,
        },
      ),
    );

    expect(seen.init?.redirect).toBe("error");
  });

  it("ends the call when the caller's own signal is aborted, never as a timeout of its own", async () => {
    const seen: { signal?: AbortSignal | null } = {};
    const caller = new AbortController();
    const reason = new Error("the run was cancelled");

    const pending = outcome(
      callRunner(
        silent(seen),
        "http://[fdaa::1]:9000/tool",
        {},
        {
          headersTimeoutMs: 5_000,
          signal: caller.signal,
        },
      ),
    );
    caller.abort(reason);
    const { error } = await pending;

    expect(seen.signal?.aborted).toBe(true);
    expect(error).not.toBeInstanceOf(RunnerCallTimeout);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("fetchWithDeadline — the bound on the wait for an answer, on a bound of milliseconds", () => {
  // The mechanism, called directly. The value the adapter puts on /init, 300 s,
  // is held by the adapter's test, on a simulated clock.
  const url = "http://[fdaa::1]:9000/init";

  /** A fetch that answers after `answerMs` — never when null — and stops when aborted, as the platform's does. */
  function answeringAfter(answerMs: number | null, seen: { signal?: AbortSignal | null }) {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.signal = init?.signal;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
        if (answerMs !== null) {
          setTimeout(() => resolve(new Response("{}", { status: 200 })), answerMs);
        }
      });
    }) as unknown as typeof fetch;
  }

  it("aborts a request still unanswered at its bound, and names the wait", async () => {
    const seen: { signal?: AbortSignal | null } = {};

    const outcome = await Promise.race([
      fetchWithDeadline(answeringAfter(null, seen), url, { method: "POST" }, 50, "/init").then(
        () => "answered",
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 3_000)),
    ]);

    expect(outcome).not.toBe("still waiting");
    expect(seen.signal?.aborted).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("/init did not answer within 50 ms: timed out");
    // The client's own error is kept as its cause.
    expect(((outcome as Error).cause as Error | undefined)?.name).toBe("AbortError");
  });

  it("lifts the bound once the answer arrives", async () => {
    const seen: { signal?: AbortSignal | null } = {};

    const response = await fetchWithDeadline(answeringAfter(10, seen), url, {}, 50, "/init");

    expect(response.status).toBe(200);
    // Past the bound, the request that answered is still not aborted: its body
    // is read under a deadline of its own.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.signal?.aborted).toBe(false);
  });

  it("passes any other failure through as it is", async () => {
    const refused = new TypeError("fetch failed");
    const failing = (async () => {
      throw refused;
    }) as unknown as typeof fetch;

    await expect(fetchWithDeadline(failing, url, {}, 50, "/init")).rejects.toBe(refused);
  });
});

describe("readRunnerBody — an answer is read up to its bound, and no further", () => {
  it("reads an answer of exactly its bound", async () => {
    const body = countedBody(KIB);

    const bytes = await readRunnerBody(new Response(body.stream), {
      maxBytes: KIB,
      deadlineMs: 5_000,
    });

    expect(bytes.length).toBe(KIB);
  });

  it("refuses an answer one byte past its bound, and cancels it", async () => {
    const body = countedBody(KIB + 1);

    const { error } = await outcome(
      readRunnerBody(new Response(body.stream), {
        maxBytes: KIB,
        deadlineMs: 5_000,
        what: "/claim",
      }),
    );

    expect(error).toBeInstanceOf(RunnerResponseTooLarge);
    expect((error as Error).message).toBe("/claim answered more than 1 KiB");
    expect(body.state.cancelled).toBe(true);
  });

  it("stops at its bound an answer three times as long: what it read stays within one chunk of the bound", async () => {
    const max = 64 * KIB;
    const body = countedBody(3 * max, { chunk: 4 * KIB });

    const { error } = await outcome(
      readRunnerBody(new Response(body.stream), { maxBytes: max, deadlineMs: 5_000 }),
    );

    expect(error).toBeInstanceOf(RunnerResponseTooLarge);
    expect(body.state.delivered).toBeLessThanOrEqual(max + 4 * KIB);
    expect((error as RunnerResponseTooLarge).bytesRead).toBe(body.state.delivered);
    expect(body.state.cancelled).toBe(true);
  });

  it("stops at its bound the same answer sent by a server, and reads no more than one chunk past it", async () => {
    const max = 64 * KIB;
    const runner = await serve((req, res, server) =>
      writeBytes(res, server, req.url ?? "", 3 * max),
    );
    const response = await callRunner(fetch, `${runner.url}/init`, {}, { headersTimeoutMs: 5_000 });

    const { error } = await outcome(readRunnerBody(response, { maxBytes: max, deadlineMs: 5_000 }));

    expect(error).toBeInstanceOf(RunnerResponseTooLarge);
    const read = (error as RunnerResponseTooLarge).bytesRead;
    expect(read).toBeGreaterThan(max);
    // One chunk of the socket at most: never the three times the bound that was sent.
    expect(read).toBeLessThanOrEqual(max + 64 * KIB);
  });

  it("cuts an answer that drips past its deadline", async () => {
    // One byte every 50 ms, ending by itself after 3 s; a deadline of 200 ms —
    // four intervals, never a tight race.
    const runner = await serve((_req, res) => {
      res.writeHead(200);
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (res.destroyed || ticks > 60) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write("x");
      }, 50);
      res.on("close", () => clearInterval(timer));
    });
    const response = await callRunner(fetch, `${runner.url}/init`, {}, { headersTimeoutMs: 5_000 });
    const startedAt = Date.now();

    const { error } = await outcome(
      readRunnerBody(response, { maxBytes: KIB, deadlineMs: 200, what: "/init" }),
    );

    expect(error).toBeInstanceOf(RunnerBodyTimeout);
    expect((error as Error).message).toBe("/init did not finish its answer within 200 ms");
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect((error as RunnerBodyTimeout).bytesRead).toBeLessThan(KIB);
  });

  it("ends the read with the caller's reason when the caller's signal is aborted, and cancels the answer", async () => {
    const body = countedBody(0, { never: true, endAfterMs: 1_500 });
    const caller = new AbortController();
    const reason = new Error("the run was cancelled");

    const pending = outcome(
      readRunnerBody(new Response(body.stream), {
        maxBytes: KIB,
        deadlineMs: 5_000,
        signal: caller.signal,
      }),
    );
    caller.abort(reason);
    const { error } = await pending;

    expect(error).toBe(reason);
    expect(body.state.cancelled).toBe(true);
  });

  it.each([
    [
      "readRunnerBody",
      (response: Response, signal: AbortSignal) =>
        readRunnerBody(response, { maxBytes: 64 * KIB, deadlineMs: 5_000, signal }),
    ],
    [
      "readRunnerBodyInto",
      (response: Response, signal: AbortSignal) =>
        readRunnerBodyInto(response, Buffer.alloc(64 * KIB), { deadlineMs: 5_000, signal }),
    ],
  ])("%s ends before its first byte when the caller's signal is already aborted, and cancels the answer", async (_name, read) => {
    const body = countedBody(4 * KIB);
    // The answer is ready before the read starts, each chunk at hand as soon as it is asked
    // for: an abort that comes first must still win over it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const caller = new AbortController();
    const reason = new Error("the run was cancelled");
    caller.abort(reason);

    const { value, error } = await outcome(read(new Response(body.stream), caller.signal));

    expect(value).toBeUndefined();
    expect(error).toBe(reason);
    expect(body.state.delivered).toBe(0);
    expect(body.state.cancelled).toBe(true);
  });

  it("stops at the chunk at hand when the caller's signal is aborted while the answer's chunks are all ready", async () => {
    const caller = new AbortController();
    const reason = new Error("the run was cancelled");
    const state = { delivered: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.delivered >= 8 * KIB) {
            controller.close();
            return;
          }
          state.delivered += KIB;
          controller.enqueue(new Uint8Array(KIB).fill(0x61));
          // The caller gives up as the second chunk is handed over.
          if (state.delivered === 2 * KIB) caller.abort(reason);
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { value, error } = await outcome(
      readRunnerBody(new Response(stream), {
        maxBytes: 64 * KIB,
        deadlineMs: 5_000,
        signal: caller.signal,
      }),
    );

    expect(value).toBeUndefined();
    expect(error).toBe(reason);
    expect(state.delivered).toBe(2 * KIB);
    expect(state.cancelled).toBe(true);
  });

  it("reads an answer without a body as empty", async () => {
    const bytes = await readRunnerBody(new Response(null, { status: 204 }), {
      maxBytes: KIB,
      deadlineMs: 5_000,
    });

    expect(bytes.length).toBe(0);
  });
});

describe("readRunnerBodyInto — one buffer, filled, never written past its end", () => {
  it("fills the buffer it is given, and says how much it read", async () => {
    const buffer = Buffer.alloc(KIB);

    const read = await readRunnerBodyInto(new Response(countedBody(KIB).stream), buffer, {
      deadlineMs: 5_000,
    });

    expect(read).toBe(KIB);
    expect(buffer.every((byte) => byte === 0x61)).toBe(true);
  });

  it("reads a shorter answer and says how much", async () => {
    const buffer = Buffer.alloc(KIB);

    const read = await readRunnerBodyInto(new Response("abc"), buffer, { deadlineMs: 5_000 });

    expect(read).toBe(3);
    expect(buffer.subarray(0, 3).toString()).toBe("abc");
  });

  it("refuses an answer one byte longer than the buffer, and writes nothing past its end", async () => {
    const backing = Buffer.alloc(16, 0xee);
    const buffer = backing.subarray(0, 8);
    const body = countedBody(9, { chunk: 3 });

    const { error } = await outcome(
      readRunnerBodyInto(new Response(body.stream), buffer, { deadlineMs: 5_000 }),
    );

    expect(error).toBeInstanceOf(RunnerResponseTooLarge);
    expect((error as RunnerResponseTooLarge).maxBytes).toBe(8);
    expect([...backing.subarray(8)]).toEqual(new Array(8).fill(0xee));
    expect(body.state.cancelled).toBe(true);
  });
});

describe("readRunnerErrorText — an error answer is told by its first 4 KiB", () => {
  it("reads 4 KiB of a 1 MiB error answer, and cancels the rest", async () => {
    const body = countedBody(1024 * KIB);

    const text = await readRunnerErrorText(new Response(body.stream, { status: 500 }), {
      deadlineMs: 5_000,
    });

    expect(RUNNER_ERROR_BODY_MAX_BYTES).toBe(4 * KIB);
    expect(text.length).toBe(4 * KIB);
    expect(body.state.delivered).toBeLessThanOrEqual(4 * KIB + KIB);
    expect(body.state.cancelled).toBe(true);
  });

  it("reads a short error answer whole", async () => {
    const text = await readRunnerErrorText(new Response("upstream timeout", { status: 503 }), {
      deadlineMs: 5_000,
    });

    expect(text).toBe("upstream timeout");
  });

  it("tells what it read when the answer stops before its end, and never throws", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode("partial "));
          return;
        }
        controller.error(new Error("connection reset"));
      },
    });

    const text = await readRunnerErrorText(new Response(stream, { status: 502 }), {
      deadlineMs: 5_000,
    });

    expect(text).toBe("partial ");
  });
});

describe("readRunnerJson — an answer parsed, within its bound", () => {
  it("parses an answer within its bound", async () => {
    const parsed = await readRunnerJson(new Response('{"process_id":"p-1"}'), {
      maxBytes: KIB,
      deadlineMs: 5_000,
    });

    expect(parsed).toEqual({ process_id: "p-1" });
  });

  it("reads an answer it cannot parse as null", async () => {
    const parsed = await readRunnerJson(new Response("not json"), {
      maxBytes: KIB,
      deadlineMs: 5_000,
    });

    expect(parsed).toBeNull();
  });

  it("refuses an answer past its bound rather than parsing it", async () => {
    const { error } = await outcome(
      readRunnerJson(new Response(`{"pad":"${"x".repeat(2 * KIB)}"}`), {
        maxBytes: KIB,
        deadlineMs: 5_000,
      }),
    );

    expect(error).toBeInstanceOf(RunnerResponseTooLarge);
  });
});

describe("discardRunnerBody — an answer whose body is not needed is cancelled unread", () => {
  it("reads nothing of it", async () => {
    const body = countedBody(64 * KIB);

    discardRunnerBody(new Response(body.stream));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(body.state.delivered).toBe(0);
    expect(body.state.cancelled).toBe(true);
  });
});
