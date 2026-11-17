/**
 * The one module that talks to a runner.
 *
 * A runner is the process the harness started on a machine it created — but the
 * same machine runs the agent's code, under the runner's own user, able to stop
 * it and take its port. Whatever answers there is therefore untrusted. Two ways
 * such an answer could reach past it:
 *
 * - **A redirect.** Followed, it turns an answer into a destination: the harness
 *   would read whatever the redirect names — an internal address, say — and the
 *   outputs upload would store that body and hand it to the caller.
 * - **A body read whole.** Its length, and how slowly it comes, would be the
 *   answerer's to choose — and so would the memory and the time the API spends.
 *
 * So every call to a runner goes through here. `callRunner` always refuses a
 * redirect, whatever the caller asked, and bounds the wait for the answer's
 * headers. `readRunnerBody` and its variants read the answer chunk by chunk,
 * under a number of bytes and a deadline of their own, and cancel it at the
 * first byte too many or at the deadline. Nothing else under `adapter/flyio/`
 * reaches the network but the platform's client (`fly-api.ts`): a test reads the
 * sources to keep it so.
 */

import { describeBytes } from "../../files/output-rules.js";

/**
 * The most read of an error answer's body. Enough for a message; an error
 * answer is told by its first bytes, cut there rather than refused.
 */
export const RUNNER_ERROR_BODY_MAX_BYTES = 4 * 1024;

/**
 * What each call to a runner may take, and read. An error answer's body is read
 * under its call's body deadline, up to {@link RUNNER_ERROR_BODY_MAX_BYTES}.
 *
 * - `claim` — the assignment of a pooled machine: 30 s for the headers, 10 s for
 *   the body, 64 KiB. Past either, the claim is dropped and the run creates a
 *   machine of its own. A body whose read fails otherwise — a cut connection —
 *   keeps the claim, its process id unknown, as an answer that cannot be parsed
 *   does.
 * - `healthz` — each readiness probe, cold or fill: 5 s in all, inside the boot
 *   budget that is checked between probes. The cold path reads nothing of the
 *   answer; the fill reads its process id, up to 64 KiB, and a fill past that —
 *   or still reading at the probe's bound — fails. A read that fails otherwise
 *   keeps the machine, its process id unknown.
 * - `init` — its headers wait `INIT_RPC_TIMEOUT_MS` (adapter.ts), its body 30 s,
 *   1 MiB. Past either, the start fails at `init-rpc`.
 *
 * A tool call keeps its own bound for the whole call, and its answer the bound
 * the runner cuts a tool result to (rpc-script-provider.ts).
 */
export const RUNNER_CALL_BOUNDS = {
  claim: { headersTimeoutMs: 30_000, bodyTimeoutMs: 10_000, maxBytes: 64 * 1024 },
  healthz: { timeoutMs: 5_000, maxBytes: 64 * 1024 },
  init: { bodyTimeoutMs: 30_000, maxBytes: 1024 * 1024 },
} as const;

/** A runner answered with a redirect. Never followed: the call fails. */
export class RunnerRedirectRefused extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`${what} answered with a redirect, which is never followed`, options);
    this.name = "RunnerRedirectRefused";
  }
}

/**
 * A runner answered with an error status. It carries the status, a number, and
 * nothing of the answer's body: of a class of its own, it is told on a log line
 * by its name — apart from an answer that is not in its shape.
 */
export class RunnerStatusError extends Error {
  readonly status: number;

  constructor(what: string, status: number) {
    super(`${what} answered HTTP ${status}`);
    this.name = "RunnerStatusError";
    this.status = status;
  }
}

/** A runner did not send the headers of its answer within the call's bound. */
export class RunnerCallTimeout extends Error {
  readonly timeoutMs: number;

  constructor(what: string, timeoutMs: number, options?: ErrorOptions) {
    super(`${what} did not answer within ${describeMs(timeoutMs)}: timed out`, options);
    this.name = "RunnerCallTimeout";
    this.timeoutMs = timeoutMs;
  }
}

/** A runner's answer ran past the number of bytes its reader takes. */
export class RunnerResponseTooLarge extends Error {
  readonly maxBytes: number;
  /** What was read when the read stopped: the bound, and at most one chunk more. */
  readonly bytesRead: number;

  constructor(what: string, maxBytes: number, bytesRead: number) {
    super(`${what} answered more than ${describeBytes(maxBytes)}`);
    this.name = "RunnerResponseTooLarge";
    this.maxBytes = maxBytes;
    this.bytesRead = bytesRead;
  }
}

/** A runner's answer did not end within the deadline of its body. */
export class RunnerBodyTimeout extends Error {
  readonly deadlineMs: number;
  /** What had arrived when the deadline passed. */
  readonly bytesRead: number;

  constructor(what: string, deadlineMs: number, bytesRead: number) {
    super(`${what} did not finish its answer within ${describeMs(deadlineMs)}`);
    this.name = "RunnerBodyTimeout";
    this.deadlineMs = deadlineMs;
    this.bytesRead = bytesRead;
  }
}

export interface RunnerCallOptions {
  /**
   * How long to wait for the answer's headers. Lifted once they arrive: the body
   * is read under its own deadline, by one of the readers below.
   */
  headersTimeoutMs: number;
  /**
   * The caller's own signal. Aborting it ends the call with the caller's reason —
   * and the read of the body too, when it is passed to the reader as well.
   */
  signal?: AbortSignal;
}

/**
 * Call a runner. Redirects are always refused — `redirect: "error"` replaces
 * whatever the caller set — and a redirect fails the call with
 * {@link RunnerRedirectRefused}, its target never asked. The wait for the
 * headers is bounded ({@link RunnerCallTimeout}). The body is left unread: the
 * caller reads it with {@link readRunnerBody}, {@link readRunnerBodyInto},
 * {@link readRunnerJson} or {@link readRunnerErrorText}, or drops it with
 * {@link discardRunnerBody}.
 *
 * Errors name the call by its path, never by its query — a query can carry a
 * name the agent chose.
 */
export async function callRunner(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: RunnerCallOptions,
): Promise<Response> {
  const what = describeCall(url);
  const signal = options.signal ?? init.signal ?? undefined;
  try {
    return await fetchWithDeadline(
      fetchImpl,
      url,
      { ...init, redirect: "error", signal },
      options.headersTimeoutMs,
      what,
    );
  } catch (err) {
    if (isRefusedRedirect(err)) throw new RunnerRedirectRefused(what, { cause: err });
    throw err;
  }
}

/**
 * `fetch`, with a bound on the wait for the answer. Past `timeoutMs` without
 * the response headers, the request is aborted and the call fails with an error
 * that names the wait — `<what> did not answer within <duration>: timed out` —,
 * the client's own error as its cause; any other failure passes through as it
 * is, an abort of the caller's own signal (`init.signal`) included. The bound is
 * lifted once the headers arrive: the body is read under a deadline of its own.
 *
 * Internal: neither of the package's entry points exports it. `callRunner` is
 * built on it; its tests call it directly, on a bound of milliseconds.
 */
export async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    throw new RunnerCallTimeout(what, timeoutMs, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export interface RunnerBodyOptions {
  /** How long the whole body may take, counted from the start of the read. */
  deadlineMs: number;
  /** The caller's own signal: aborting it ends the read with the caller's reason. */
  signal?: AbortSignal;
  /** Names the answer in the errors — `"/init"`. */
  what?: string;
}

export interface RunnerBoundedBodyOptions extends RunnerBodyOptions {
  /** The most bytes read. The first byte past it cancels the answer and fails the read. */
  maxBytes: number;
}

/**
 * Read a runner's answer, up to `maxBytes` and within `deadlineMs`. Past either,
 * the answer is cancelled and the read fails ({@link RunnerResponseTooLarge},
 * {@link RunnerBodyTimeout}); what was read by then is the bound and at most one
 * chunk more, never kept. An answer without a body reads as empty.
 */
export async function readRunnerBody(
  response: Response,
  options: RunnerBoundedBodyOptions,
): Promise<Buffer> {
  const what = options.what ?? DEFAULT_WHAT;
  const chunks: Uint8Array[] = [];
  let total = 0;
  await pumpBody(response, options, (chunk) => {
    if (total + chunk.byteLength > options.maxBytes) {
      throw new RunnerResponseTooLarge(what, options.maxBytes, total + chunk.byteLength);
    }
    chunks.push(chunk);
    total += chunk.byteLength;
    return true;
  });
  return Buffer.concat(chunks, total);
}

/**
 * Read a runner's answer into a buffer the caller allocated, and say how many
 * bytes it holds. The buffer's length is the bound: an answer longer than it
 * fails the read ({@link RunnerResponseTooLarge}) and nothing is written past
 * its end. The buffer is never grown, and nothing else is allocated for the body.
 */
export async function readRunnerBodyInto(
  response: Response,
  buffer: Buffer,
  options: RunnerBodyOptions,
): Promise<number> {
  const what = options.what ?? DEFAULT_WHAT;
  let filled = 0;
  await pumpBody(response, options, (chunk) => {
    if (filled + chunk.byteLength > buffer.length) {
      throw new RunnerResponseTooLarge(what, buffer.length, filled + chunk.byteLength);
    }
    buffer.set(chunk, filled);
    filled += chunk.byteLength;
    return true;
  });
  return filled;
}

/**
 * Read a runner's answer as JSON, within its bounds. An answer that cannot be
 * parsed reads as `null`, for the caller to judge; one past its bounds fails the
 * read, as {@link readRunnerBody} does — it is never parsed.
 */
export async function readRunnerJson(
  response: Response,
  options: RunnerBoundedBodyOptions,
): Promise<unknown> {
  const bytes = await readRunnerBody(response, options);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * The text of a runner's error answer, cut at {@link RUNNER_ERROR_BODY_MAX_BYTES}:
 * the rest is cancelled unread. Never throws — an answer that fails, stalls past
 * the deadline or is aborted is told by what had arrived.
 */
export async function readRunnerErrorText(
  response: Response,
  options: RunnerBodyOptions,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    await pumpBody(response, options, (chunk) => {
      const room = RUNNER_ERROR_BODY_MAX_BYTES - total;
      if (chunk.byteLength >= room) {
        chunks.push(chunk.subarray(0, room));
        total += room;
        return false;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      return true;
    });
  } catch {
    // What had arrived is what is told.
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Drop a runner's answer unread: its body is cancelled, not a byte of it taken. */
export function discardRunnerBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

// ---------------------------------------------------------------------------

const DEFAULT_WHAT = "the runner";

/**
 * Read a body chunk by chunk, handing each to `take`, which says whether to go
 * on. Ends at the body's end, at `take`'s word, at the deadline, at the caller's
 * abort, or at the first error `take` throws — and in every case but the first,
 * the body is cancelled, so the answer is never read further.
 */
async function pumpBody(
  response: Response,
  options: RunnerBodyOptions,
  take: (chunk: Uint8Array) => boolean,
): Promise<void> {
  const body = response.body;
  if (body === null) return;
  const what = options.what ?? DEFAULT_WHAT;
  const signal = options.signal;
  const reader = body.getReader();
  let bytesRead = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Why the read stopped, once it has. Looked at before each chunk is asked for: a
  // chunk already at hand settles the race below before a stop that came first, so
  // the race alone would read on through every chunk the answer has ready.
  let halted: { reason: unknown } | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = (reason: unknown) => {
      halted ??= { reason };
      reject(reason);
    };
    timer = setTimeout(
      () => stop(new RunnerBodyTimeout(what, options.deadlineMs, bytesRead)),
      options.deadlineMs,
    );
    if (signal) {
      onAbort = () => stop(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // Settled by the race below, or never looked at once the body has ended.
  stopped.catch(() => {});
  try {
    for (;;) {
      if (halted) throw halted.reason;
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) return;
      bytesRead += value.byteLength;
      if (!take(value)) return;
    }
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
}

/**
 * Whether `fetch` failed because it was told to refuse a redirect: Node's client
 * fails such a request with a network error whose cause says so.
 */
function isRefusedRedirect(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && /\bredirect\b/i.test(cause.message);
}

/** The call's path: `/init`, `/outputs/file` — never its query. */
function describeCall(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return DEFAULT_WHAT;
  }
}

/** A duration as a message says it: whole seconds when it is a whole number of them. */
function describeMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}
