/**
 * SSRF-safe fetch for harness-side outbound requests (webhook delivery,
 * file-input URL fetch, remote-MCP connect, an agent-declared model `base_url`).
 *
 * The host allowlist in `network.ts` is string-only, and callers apply it to the
 * URL they are handed — not to where that URL redirects. Two things defeat it on
 * their own: a hostname that *resolves* to a private/internal IP
 * (169.254.169.254, 127.0.0.1, ::1, ::, …), and a redirect, which reaches a host
 * nobody checked. This guard checks at the one place every request passes, the
 * opening of a connection — the first request's and each redirect hop's:
 *
 *   - the address. A name is resolved, EVERY resolved IP validated against
 *     `isPrivateHost`, and the socket opened only to a validated IP — the
 *     dispatcher's `lookup` performs the resolution, so there is no
 *     re-resolution window between check and connect (closes DNS rebinding). An
 *     IP literal is validated as it is: undici connects to one without any
 *     lookup, so the resolver alone never sees it.
 *   - the host list, when the caller passes one (the agent's `allowed_hosts`):
 *     the host of every connection must match it, so a URL the caller vetted
 *     cannot redirect off the list.
 *
 * Why the connection is the right place: the dispatcher is new for each call,
 * and undici keeps one pool per origin in it, so a redirect to another origin
 * always opens a new connection, through these checks; a connection it reuses
 * within the call is one it opened to an origin already checked. The dispatcher
 * connects directly — it is a plain `Agent`, not a proxy agent — so the host it
 * checks is the host it reaches. A redirect to a scheme other than http(s) is a
 * network error in fetch itself.
 *
 * A refusal of an address or of the list names the host, and one of a scheme
 * the URL — never an address a name resolved to: the message reaches whoever
 * handed the URL in — the caller of a run, for a file input — and that address
 * belongs to the network the server runs on. It travels in a field of the error
 * instead (`SsrfBlockedError.privateResolution`). Only a file input's refusal is
 * logged with it, by the API; every other caller in this repository logs only
 * the error's class, code and status.
 *
 * We use undici's OWN `fetch`, not the Node global `fetch`: the global fetch
 * bundles a different undici version and rejects a dispatcher built from this
 * package ("invalid onRequestStart method"). undici's exported `fetch` honors
 * the `dispatcher` option from the same package version.
 *
 * The package is loaded on first use, not at import, and Node's global
 * dispatcher slot is handed back afterwards — see `loadUndici`.
 */

import { lookup as dnsLookupCb } from "node:dns";
import { isIP } from "node:net";
import { ReadableStream, type ReadableStreamReadResult } from "node:stream/web";
import type {
  Agent as UndiciAgent,
  RequestInit as UndiciRequestInit,
  Response as UndiciResponse,
} from "undici";
import { hostMatchesAllowlist, isPrivateHost } from "./network.js";

/**
 * Node's built-in fetch reads its dispatcher from this well-known symbol. The
 * npm `undici` writes there too, at import, whenever the slot it reads
 * (`…globalDispatcher.2`) is still empty (`lib/global.js`): its own agent under
 * `.2` and a compatibility wrapper under this legacy slot — so after a plain
 * `import "undici"` the built-in fetch runs on the npm package. That coupling
 * is what broke the GitHub sign-in on 2026-09-22 (8.11.0 stopped forcing
 * HTTP/1.1 in the wrapper, 8.11.1 forced it again, and in between the built-in
 * fetch received gzip it could not decode), and it discards whatever an
 * operator put there first — an `EnvHttpProxyAgent` from `NODE_USE_ENV_PROXY=1`
 * included.
 *
 * Whether `.2` is still empty depends on Node, and on order. Up to Node 24.12,
 * Node fills only `.1`, so the write always happens. From Node 24.20 (bundled
 * undici 7.29), Node fills both slots itself — at its first fetch, and, on
 * 24.22, as soon as `node:http` loads — and a package loaded after that writes
 * nothing; a package loaded before still writes both, and only the snapshot
 * below gives Node its slot back. Measured with undici 8.10: written on Node
 * 22.12, 22.23, 24.12 and 24.14, not on 24.20 after Node's first fetch. With
 * 8.12.3: written on 22.23.4 in every order; on 24.22 only when the package
 * loads first.
 */
const LEGACY_GLOBAL_DISPATCHER_SLOT = Symbol.for("undici.globalDispatcher.1");

type UndiciModule = typeof import("undici");
let undiciLoad: Promise<UndiciModule> | undefined;

/**
 * Load the npm `undici` on first use and give Node its slot back:
 * snapshot the legacy slot, import, restore the snapshot. Node then keeps — or
 * lazily rebuilds — its own agent, and the built-in fetch (first-party LLM
 * SDKs, the GitHub OAuth exchange, third-party code) never runs on this
 * package. The guard itself never needs the global slot: every call below
 * passes its dispatcher explicitly. Loading lazily also keeps the snapshot in
 * code order, independent of ESM import evaluation order, and makes importing
 * this module side-effect free for library consumers.
 *
 * Restoring is an assignment, not a `delete`: undici defines the property
 * non-configurable but writable. The slot name is an undici-internal contract
 * shared between versions, not a public API: if Node moves to another slot,
 * restoring this one protects nothing, and no test here promises to notice.
 * What the tests pin is the restoration itself — the assertions on the slot,
 * in `safe-fetch.test.ts` and `safe-fetch-slot.test.ts`, fail when the
 * snapshot is not written back. The other half of the first test, the built-in
 * fetch decoding gzip from an HTTP/2 origin, is the only check that reads that
 * fetch rather than the slot; it sees a coupling only through a wrapper that
 * breaks the fetch, which the wrapper of 8.10.2 and of 8.11.1 to 8.12.3 does
 * not: it forces HTTP/1.1.
 *
 * `undici` is declared as a range in package.json, not an exact version. The
 * version our builds run is fixed by lockfiles: pnpm-lock.yaml, and the two
 * package-lock.json files the runtime image installs from with `npm ci`, whose
 * manifests pin it exactly. A newer undici reaches them only through a
 * deliberate change to those lockfiles, which those tests then run against. The
 * range is for projects that install this package as a library: they receive
 * undici's fixes without waiting for a release of ours.
 */
function loadUndici(): Promise<UndiciModule> {
  if (!undiciLoad) {
    const slots = globalThis as unknown as Record<symbol, unknown>;
    const before = slots[LEGACY_GLOBAL_DISPATCHER_SLOT];
    undiciLoad = import("undici").then((mod) => {
      slots[LEGACY_GLOBAL_DISPATCHER_SLOT] = before;
      return mod;
    });
  }
  return undiciLoad;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolve a hostname to all of its addresses. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  /** Abort the request after this many ms (default 30 000). */
  timeoutMs?: number;
  /**
   * Follow redirects (default true). Each hop opens its connection through the
   * same checks as the first request — address, and `allowedHosts` when given.
   * `false` returns a 3xx as it is.
   */
  followRedirects?: boolean;
  /**
   * Skip the private-address block, on resolved addresses and address literals
   * alike. An operator opt-in ONLY (`SKRUN_ALLOW_LOCAL_WEBHOOKS`,
   * `SKRUN_ALLOW_LOCAL_MODEL_HOSTS`); never enable it for caller-controlled URLs.
   * It does not relax `allowedHosts`.
   */
  allowPrivateHosts?: boolean;
  /**
   * The hosts a connection may be opened to — the agent's `allowed_hosts`,
   * matched as `isHostAllowed` matches them (exact, `*.` subdomains, `*`), in the
   * form `URL.hostname` gives. Checked at EVERY connection, redirect hops
   * included. Omitted: no host list applies (the address checks still do); `[]`
   * refuses every connection.
   */
  allowedHosts?: readonly string[];
  /** Injectable DNS resolver — the test seam (do NOT stub the global fetch). */
  resolver?: HostResolver;
  /**
   * Whether an address is private/reserved — `isPrivateHost` by default. A test
   * seam, so that a local server can stand for a public host: no production
   * caller passes it.
   * @internal
   */
  isPrivateAddress?: (address: string) => boolean;
  /**
   * The most bytes one response body may carry, counted once decoded — a
   * compressed body is counted as it decompresses. Reading past it fails with
   * `ResponseBodyTooLargeError`, raised by the body's stream and never by the
   * fetch: the response is returned, its status and headers readable, and only
   * its body refuses to be read further — an error body (`4xx`, `5xx`)
   * included. A `Content-Length` above it refuses at the first read, before a
   * byte of the body is read — on a body sent as it is (no `Content-Encoding`,
   * or `identity`) only: the length of a compressed body counts its encoded
   * bytes, not the decoded ones the bound counts, so such a body is judged as
   * it is read. No default: without it, a body is read whatever its size.
   */
  maxResponseBytes?: number;
  /**
   * The instant (ms, `Date.now()`'s clock) past which the request is
   * abandoned — the wait for its headers and the read of its body alike.
   * Combined with the signal the request already has, never put in its place:
   * either one aborts it. Already past, the request is abandoned before it is
   * sent. Its timer lasts no longer than the request: cleared once the body is
   * read to its end or cancelled, or the request fails or is aborted.
   */
  deadline?: number;
  /**
   * Remove `retry-after`, `retry-after-ms` and `x-should-retry` from the
   * response. A client that honours them — the OpenAI SDK waits as long as
   * `retry-after` says, and retries as `x-should-retry` says — then retries on
   * its own rules only: the statuses it retries, after its own bounded wait.
   */
  stripRetryHeaders?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MIB = 1024 * 1024;
/** The longest delay a timer holds: past it, Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
/** The headers through which a server tells its client when, and whether, to retry. */
const RETRY_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"] as const;

/** The signal of a request under a deadline, and the end of what watches it. */
interface DeadlineWatch {
  /** Aborts at the deadline, or when the request's own signal does, with its reason. */
  readonly signal: AbortSignal;
  /**
   * The request is decided — its body read to its end, cancelled, failed, or
   * the request abandoned: the deadline's timer is cleared and the request's
   * own signal no longer listened to. Idempotent.
   */
  readonly settle: () => void;
}

/**
 * A signal that aborts at `deadline` — what is left of it, held to the longest
 * delay a timer takes, a deadline further off would otherwise fire at once —
 * or when the request's own signal aborts, whichever comes first. Its timer is
 * the request's own, cleared by `settle` as soon as the request is decided: no
 * timer outlives the request (`AbortSignal.timeout`, joined by
 * `AbortSignal.any`, holds its timer until the deadline, however soon the
 * request ended). Unref'd, like the timer of `AbortSignal.timeout`: it keeps no
 * process alive. Already past: a signal already aborted, no timer armed.
 */
function watchDeadline(deadline: number, own: AbortSignal | undefined): DeadlineWatch {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    clearTimeout(timer);
    own?.removeEventListener("abort", onOwnAbort);
  };
  function onOwnAbort(): void {
    controller.abort(own?.reason);
    settle();
  }
  const left = deadline - Date.now();
  if (left <= 0) {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  } else if (own?.aborted) {
    controller.abort(own.reason);
  } else {
    timer = setTimeout(
      () => {
        controller.abort(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        );
        settle();
      },
      Math.min(left, MAX_TIMER_MS),
    );
    timer.unref?.();
    own?.addEventListener("abort", onOwnAbort, { once: true });
  }
  return { signal: controller.signal, settle };
}

/** A size as the refusals say it: in MiB when it is a whole number of them, with its bytes. */
function sizeInWords(bytes: number): string {
  return bytes > 0 && bytes % MIB === 0 ? `${bytes / MIB} MiB (${bytes} bytes)` : `${bytes} bytes`;
}

/**
 * Raised by the body of a response that carries more than `maxResponseBytes` —
 * on reading it (`json()`, `text()`, its stream), never by the fetch, so that a
 * client which retries a failed fetch does not ask again for what it was
 * refused. Its message says the bound, never the URL the response came from: a
 * URL may carry a path or a token, and the message travels to whoever reads
 * the error.
 */
export class ResponseBodyTooLargeError extends Error {
  /** The bound that was passed, in bytes. */
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(
      `The response body is larger than ${sizeInWords(limitBytes)}, the most this request may read. It was not read further.`,
    );
    this.name = "ResponseBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * The body of a response, read through to its reader. Pulled only when its
 * reader asks (`highWaterMark: 0`): nothing is read ahead of the reader. Under
 * `limitBytes`, its bytes are counted — an announced length past the bound
 * judged at the first read —, and past the bound the stream fails with
 * `ResponseBodyTooLargeError` and the source is cancelled, which closes the
 * connection. Cancelled by its reader, it cancels the source. `onSettled` is
 * called once the body is decided: read to its end, refused, failed, or
 * cancelled.
 */
function readThrough(
  source: ReadableStream<Uint8Array>,
  opts: { limitBytes?: number; announcedBytes?: number; onSettled?: () => void },
): ReadableStream<Uint8Array> {
  const { limitBytes, announcedBytes, onSettled } = opts;
  const reader = source.getReader();
  let readBytes = 0;
  const refuse = (controller: { error: (reason: unknown) => void }, limit: number): void => {
    const refusal = new ResponseBodyTooLargeError(limit);
    controller.error(refusal);
    reader.cancel(refusal).catch(() => undefined);
    onSettled?.();
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // A length announced past the bound refuses before a byte is read. Only
        // a body sent as it is has one here (`announcedLength`): a compressed
        // body is judged as it is read, on its decoded bytes.
        if (
          limitBytes !== undefined &&
          announcedBytes !== undefined &&
          announcedBytes > limitBytes
        ) {
          refuse(controller, limitBytes);
          return;
        }
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          // A source that fails — its connection cut, its signal aborted — fails
          // this stream with its own reason: a pull that rejects errors the stream.
          onSettled?.();
          throw err;
        }
        if (chunk.done) {
          controller.close();
          onSettled?.();
          return;
        }
        if (limitBytes !== undefined) {
          readBytes += chunk.value.byteLength;
          if (readBytes > limitBytes) {
            refuse(controller, limitBytes);
            return;
          }
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        onSettled?.();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The `Content-Length` a response announces, when it is a plain count of bytes
 * and the body is sent as it is — no `Content-Encoding`, or `identity` (case and
 * spaces aside). Any other encoding (`gzip`, `br`, `deflate`, a list): none, the
 * announced length being that of the encoded bytes, which says nothing of the
 * decoded ones the bound counts.
 */
function announcedLength(headers: UndiciResponse["headers"]): number | undefined {
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
  const value = headers.get("content-length")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * The response a caller who bounds its body, sets a deadline, or strips its
 * retry headers receives: a new undici `Response` with the same status and
 * status text, the headers copied — the retry headers left out under
 * `stripRetryHeaders` —, and the decoded body of the one fetched, read through
 * `readThrough`: under `maxResponseBytes`, bounded; under a deadline, watched
 * to its end, when `onSettled` is called. A response without a body (`204`, a
 * `HEAD`) keeps none. Being new, it carries no `url` and no `redirected` of its
 * own.
 */
function shapedResponse(
  undici: UndiciModule,
  response: UndiciResponse,
  opts: Pick<SafeFetchOptions, "maxResponseBytes" | "stripRetryHeaders">,
  onSettled: (() => void) | undefined,
): UndiciResponse {
  const headers = new undici.Headers(response.headers);
  if (opts.stripRetryHeaders) {
    for (const name of RETRY_HEADERS) headers.delete(name);
  }
  const watched = opts.maxResponseBytes !== undefined || onSettled !== undefined;
  const body =
    response.body && watched
      ? readThrough(response.body, {
          limitBytes: opts.maxResponseBytes,
          announcedBytes: announcedLength(response.headers),
          onSettled,
        })
      : response.body;
  if (!response.body) onSettled?.();
  return new undici.Response(body, {
    status: response.status,
    // A phrase the constructor would refuse is left empty: the status stands,
    // and the fetch is never rejected for it.
    ...(isReasonPhrase(response.statusText) && { statusText: response.statusText }),
    headers,
  });
}

/**
 * Whether `text` may be a response's status text — an HTTP reason phrase: tab,
 * space, visible ASCII and obs-text (0x80 to 0xFF), the characters a
 * `Response`'s constructor accepts. undici's fetch hands back the phrase a
 * server wrote in UTF-8 decoded as such: one character past 0xFF, and the
 * constructor throws.
 */
function isReasonPhrase(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const allowed =
      code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
    if (!allowed) return false;
  }
  return true;
}

const defaultResolver: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookupCb(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family })));
    });
  });

/** A name refused for what it resolves to: the name, and the private or reserved address. */
export interface PrivateResolution {
  readonly host: string;
  readonly address: string;
}

/**
 * Thrown when a request is blocked by the SSRF guard: a bad scheme, a private or
 * reserved address, or a host outside the caller's `allowedHosts`. Its message
 * names the host — the URL, for a scheme — never an address a name resolved to;
 * that address, with the name, is in `privateResolution` — set only for that
 * refusal.
 */
export class SsrfBlockedError extends Error {
  readonly privateResolution: PrivateResolution | undefined;
  constructor(message: string, privateResolution?: PrivateResolution) {
    super(message);
    this.name = "SsrfBlockedError";
    this.privateResolution = privateResolution;
  }
}

interface GuardPolicy {
  allowPrivateHosts: boolean;
  allowedHosts: readonly string[] | undefined;
  resolver: HostResolver;
  isPrivateAddress: (address: string) => boolean;
}

/**
 * Why a connection to `hostname` must not be opened, or null. `hostname` is the
 * one undici connects to: the origin's host, an IPv6 literal without brackets.
 * Brackets are stripped here too, should a version of undici keep them: `isIP`
 * reads a bracketed literal as a name, and the literal check would pass it by.
 */
function connectionRefusal(hostname: string, policy: GuardPolicy): SsrfBlockedError | null {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  // URL.hostname's form — the one a caller vetted the first URL in. The list
  // matches an IPv6 literal in it however the list writes the address.
  const urlHost = family === 6 ? `[${bare}]` : bare;
  if (family !== 0 && !policy.allowPrivateHosts && policy.isPrivateAddress(bare)) {
    return new SsrfBlockedError(`Blocked '${urlHost}': a private/reserved address`);
  }
  if (policy.allowedHosts && !hostMatchesAllowlist(urlHost, policy.allowedHosts)) {
    return new SsrfBlockedError(`Blocked '${urlHost}': not in the allowed hosts`);
  }
  return null;
}

function guardedAgent(undici: UndiciModule, policy: GuardPolicy): UndiciAgent {
  // The connector undici would build itself from `connect: { lookup }`; the
  // agent's `connect` below runs the checks, then hands it the connection. One
  // thing a connector function does not get at build time is the per-connection
  // `allowH2: false` undici's fetch asks for on a WebSocket handshake falling
  // back to HTTP/1.1 — a request that never goes through this guard.
  const connector = undici.buildConnector({
    // undici invokes this with the node:dns.lookup signature and passes
    // { all: true } (verified). Resolve, validate EVERY address, and return
    // the validated set — undici then connects to one of these exact IPs.
    lookup(hostname, _options, callback) {
      policy.resolver(hostname).then(
        (addresses) => {
          if (addresses.length === 0) {
            callback(new Error(`No DNS records for '${hostname}'`), []);
            return;
          }
          if (!policy.allowPrivateHosts) {
            const blocked = addresses.find((a) => policy.isPrivateAddress(a.address));
            if (blocked) {
              callback(
                new SsrfBlockedError(
                  `Blocked '${hostname}': resolves to a private/reserved address`,
                  {
                    host: hostname,
                    address: blocked.address,
                  },
                ),
                [],
              );
              return;
            }
          }
          callback(null, addresses);
        },
        (err: Error) => callback(err, []),
      );
    },
  });
  return new undici.Agent({
    connect(options, callback) {
      const refusal = connectionRefusal(options.hostname, policy);
      if (refusal) {
        callback(refusal, null);
        return;
      }
      connector(options, callback);
    },
  });
}

/**
 * SSRF-safe fetch. Rejects non-http(s) schemes; and, at every connection — the
 * initial host's and each redirect hop's — a private/reserved address, literal
 * or resolved (any of its addresses), and a host outside `allowedHosts` when
 * given. Returns an undici `Response`: the one undici's fetch returned, as it
 * is, unless the caller bounds its body (`maxResponseBytes`), sets a deadline
 * (`deadline`, whose timer goes as soon as the body is read to its end, its
 * reader cancels it, or the request fails) or strips its retry headers
 * (`stripRetryHeaders`).
 */
export async function safeFetch(
  url: string | URL,
  init?: UndiciRequestInit,
  opts: SafeFetchOptions = {},
): Promise<UndiciResponse> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfBlockedError(
      `Blocked '${parsed.href}': scheme '${parsed.protocol}' is not allowed (only http/https)`,
    );
  }
  const undici = await loadUndici();
  const undiciFetch = undici.fetch;
  const agent = guardedAgent(undici, {
    allowPrivateHosts: opts.allowPrivateHosts ?? false,
    allowedHosts: opts.allowedHosts,
    resolver: opts.resolver ?? defaultResolver,
    isPrivateAddress: opts.isPrivateAddress ?? isPrivateHost,
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // timeoutMs === 0 means "no fetch-level timeout" — for long-lived streams (MCP
  // SSE) where a fixed abort would kill the connection; the caller owns timeouts.
  const ownSignal = init?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  // A deadline joins the signal the request already has — the caller's own,
  // which still aborts on its own terms — and never takes its place. Aborted
  // once the response is back, the signal still cuts the read of its body.
  const watch =
    opts.deadline === undefined ? undefined : watchDeadline(opts.deadline, ownSignal ?? undefined);
  try {
    const response = await undiciFetch(parsed, {
      ...init,
      dispatcher: agent,
      redirect: opts.followRedirects === false ? "manual" : "follow",
      signal: watch?.signal ?? ownSignal,
    });
    // With nothing to change in it, nor a deadline to watch to the body's end,
    // the response goes back untouched: no stream in between.
    if (opts.maxResponseBytes === undefined && !opts.stripRetryHeaders && !watch) return response;
    return shapedResponse(undici, response, opts, watch?.settle);
  } catch (err) {
    watch?.settle();
    throw err;
  } finally {
    void agent.close();
  }
}

/**
 * A `fetch`-shaped function backed by the SSRF guard, for injecting into clients
 * that accept a custom fetch (e.g. the MCP SDK transports). Imposes NO
 * fetch-level timeout — a fixed timeout would abort long-lived SSE streams; the
 * caller's protocol layer owns request timeouts. Each call checks its connections
 * through a fresh guarded dispatcher (graceful close keeps active streams open),
 * and follows redirects whatever `init.redirect` asks — each hop held to the same
 * checks, `allowedHosts` included. A bound on each response's body
 * (`maxResponseBytes`), a deadline (`deadline`) and the removal of the retry
 * headers (`stripRetryHeaders`) apply to every call, when given.
 */
export function createGuardedFetch(
  opts: Pick<
    SafeFetchOptions,
    | "allowPrivateHosts"
    | "allowedHosts"
    | "resolver"
    | "isPrivateAddress"
    | "maxResponseBytes"
    | "deadline"
    | "stripRetryHeaders"
  > = {},
): (url: string | URL, init?: UndiciRequestInit) => Promise<UndiciResponse> {
  return (url, init) => safeFetch(url, init, { ...opts, timeoutMs: 0, followRedirects: true });
}
