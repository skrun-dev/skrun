import { INLINE_BASE64_MAX_BYTES } from "@skrun-dev/runtime";
import { DEFAULT_PUSH_MAX_BODY_MB, readMbSetting } from "@skrun-dev/schema";
import type { Context, MiddlewareHandler } from "hono";
import { getMaxInputSizeBytes } from "../files/input-store.js";

/**
 * Request-body caps — one table, one cap per route that reads a body, and a
 * default for every other route.
 *
 *   push            SKRUN_PUSH_MAX_BODY_MB (50 MB)      413 BUNDLE_TOO_LARGE
 *   POST /api/files the input file limit + 1 MB         413 FILE_TOO_LARGE
 *   POST /run       RUN_BODY_MAX_BYTES (≈ 6.33 MB)      413 REQUEST_TOO_LARGE
 *   anything else   SKRUN_MAX_BODY_MB (1 MB)            413 REQUEST_TOO_LARGE
 *
 * NOTHING IS READ HERE. A declared Content-Length over the cap is refused on
 * the header alone. Without one (a chunked body), the request the routes see
 * gets a body that COUNTS as the route reads it, and fails the read at the
 * first chunk past the cap. A route reads its body itself, after its own
 * checks — its authentication, on a route that has one; the device-login
 * routes have none, and read theirs under the default cap. No route reads
 * past its cap.
 *
 * Why not hono's `bodyLimit`: without a Content-Length it reads the whole body
 * into memory, up to the cap, before calling on — that is, before the route's
 * authentication, for anyone who can reach the server.
 *
 * Routes make what they like of a failed read of their body — the run route's
 * 400 "Invalid JSON body", the upload's "Could not parse multipart", others
 * that take an unreadable body for an empty or invalid one. Once the counter
 * has tripped, the answer is replaced by the cap's 413 whatever the route made
 * of it. An error a route lets escape is answered the same way by the app's
 * error handler (`RequestBodyTooLarge`).
 *
 * The rest of an over-cap body is left to the server, never cancelled here:
 * cancelling the request stream would close the connection before the 413 is
 * written.
 *
 * THE ORIGINAL BODY IS NEVER READ HERE, and the routes' request is not built
 * from `raw` itself. On the HTTP server the API runs on (`@hono/node-server`),
 * asking a request that carries a body for it (`raw.body`), or building a
 * request from `raw`, wires a reader to the socket; a route that then answers
 * without reading its body leaves that reader stalling the server's clean-up
 * of the unread rest, and the server closes the connection instead of reading
 * the next request on it (body-limit.server.test.ts). So whether there is a
 * body is told by the framing headers first, and the body itself is asked for
 * at the route's first read. It is asked for before that only when neither
 * header is there — a request the server knows to be empty: the server then
 * builds its request around an empty body, and the connection stays reusable
 * (measured).
 */

const MIB = 1024 * 1024;

/** The default cap, in MB, of a route without a cap of its own. */
export const DEFAULT_MAX_BODY_MB = 1;
// The push's default cap is `DEFAULT_PUSH_MAX_BODY_MB` (`@skrun-dev/schema`):
// `skrun build` warns past the same value.

/**
 * The cap of `POST /run`: the base64 size of the inline file cap (4/3 of it),
 * plus 1 MB for everything else the request carries. Derived, never retyped —
 * it follows `INLINE_BASE64_MAX_BYTES`. What it bounds is the SUM of a
 * request's inline files together with the rest of the request: nothing keeps
 * the 1 MB for the rest, so base64 can take it too — three quarters of the cap
 * decoded at most, about 4.75 MB when the rest is next to nothing. Each piece
 * also stays under the per-piece cap when the input is resolved.
 */
export const RUN_BODY_MAX_BYTES = Math.ceil((INLINE_BASE64_MAX_BYTES * 4) / 3) + MIB;

/** Room for the multipart framing around the largest input file an upload may carry. */
export const UPLOAD_FRAMING_BYTES = MIB;

/** One route's cap, and the answer that refuses a body over it. */
export interface BodyCap {
  maxBytes: number;
  code: "REQUEST_TOO_LARGE" | "FILE_TOO_LARGE" | "BUNDLE_TOO_LARGE";
  message: string;
}

/** The operator settings the table is built from, read once at startup. */
export interface BodyLimitConfig {
  defaultMaxBodyMb: number;
  pushMaxBodyMb: number;
}

/** A read of a request body went past its route's cap. */
export class RequestBodyTooLarge extends Error {
  readonly code: BodyCap["code"];
  readonly status = 413;

  constructor(readonly cap: BodyCap) {
    super(cap.message);
    this.name = "RequestBodyTooLarge";
    this.code = cap.code;
  }
}

/**
 * Read the two caps an operator sets, each a positive size in MB, spaces around
 * it ignored; unset, its default. Throws on a malformed value — the empty
 * string, `0x10`, `1e3`, a value that rounds down to zero bytes —, naming the
 * variable: a boot refusal. Read by `readMbSetting` (`@skrun-dev/schema`), as
 * `BUNDLE_MAX_DECOMPRESSED_MB` is — not every size in MB the server reads: the
 * bundle cache's budget, the files' and the quotas' sizes are read otherwise.
 */
export function readBodyLimitConfig(env: NodeJS.ProcessEnv = process.env): BodyLimitConfig {
  return {
    pushMaxBodyMb: readMbSetting(
      env.SKRUN_PUSH_MAX_BODY_MB,
      "SKRUN_PUSH_MAX_BODY_MB",
      DEFAULT_PUSH_MAX_BODY_MB,
    ),
    defaultMaxBodyMb: readMbSetting(
      env.SKRUN_MAX_BODY_MB,
      "SKRUN_MAX_BODY_MB",
      DEFAULT_MAX_BODY_MB,
    ),
  };
}

function mb(bytes: number): string {
  const value = bytes / MIB;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const BODILESS_METHODS = new Set(["GET", "HEAD", "TRACE"]);

const PUSH_PATH = /^\/api\/agents\/[^/]+\/[^/]+\/push$/;
const RUN_PATH = /^\/api\/agents\/[^/]+\/[^/]+\/run$/;
const UPLOAD_PATH = /^\/api\/files$/;

/** The cap of the route a request is for. */
export function bodyCapFor(config: BodyLimitConfig, method: string, path: string): BodyCap {
  if (method === "POST" && PUSH_PATH.test(path)) {
    return {
      maxBytes: Math.floor(config.pushMaxBodyMb * MIB),
      code: "BUNDLE_TOO_LARGE",
      message:
        `Bundle exceeds the ${config.pushMaxBodyMb} MB request-body cap (compressed). ` +
        "Set SKRUN_PUSH_MAX_BODY_MB to adjust, and BUNDLE_MAX_DECOMPRESSED_MB with it: " +
        "a bundle that unpacks past that cap is refused too.",
    };
  }
  if (method === "POST" && UPLOAD_PATH.test(path)) {
    // Read per request, from the same function the upload route checks the file
    // against: the two limits cannot disagree.
    const fileBytes = getMaxInputSizeBytes();
    const maxBytes = fileBytes + UPLOAD_FRAMING_BYTES;
    return {
      maxBytes,
      code: "FILE_TOO_LARGE",
      message:
        `Upload exceeds the ${mb(maxBytes)} MB request-body cap (${maxBytes} bytes): a file of at ` +
        `most ${mb(fileBytes)} MB (INPUT_FILES_MAX_SIZE_MB) plus 1 MB of multipart framing.`,
    };
  }
  if (method === "POST" && RUN_PATH.test(path)) {
    return {
      maxBytes: RUN_BODY_MAX_BYTES,
      code: "REQUEST_TOO_LARGE",
      message:
        `Request body exceeds the ${mb(RUN_BODY_MAX_BYTES)} MB cap of a run (${RUN_BODY_MAX_BYTES} bytes), ` +
        "inline files included. Upload larger files with POST /api/files and pass their file_id.",
    };
  }
  const maxBytes = Math.floor(config.defaultMaxBodyMb * MIB);
  return {
    maxBytes,
    code: "REQUEST_TOO_LARGE",
    message:
      `Request body exceeds the ${mb(maxBytes)} MB cap (${maxBytes} bytes). ` +
      "Set SKRUN_MAX_BODY_MB to adjust.",
  };
}

/**
 * The body `source()` returns, counted as it is read. Nothing is asked of the
 * original request until the consumer reads: high-water mark 0, and `source`
 * called at the first pull, not before. The first chunk past the cap errors
 * the stream instead of being handed on.
 */
function countedBody(
  source: () => ReadableStream<Uint8Array> | null,
  cap: BodyCap,
  state: { overflowed: boolean },
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let seen = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!reader) {
          const body = source();
          if (body === null) {
            controller.close();
            return;
          }
          reader = body.getReader();
        }
        // A failed read of the source (the client gone) rejects this pull,
        // which errors the stream with the same reason.
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        seen += next.value.byteLength;
        if (seen > cap.maxBytes) {
          state.overflowed = true;
          controller.error(new RequestBodyTooLarge(cap));
          return;
        }
        controller.enqueue(next.value);
      },
      // Deliberately not forwarded to the source: see the module note.
      cancel() {},
    },
    { highWaterMark: 0 },
  );
}

function refusal(cap: BodyCap): { error: { code: string; message: string } } {
  return { error: { code: cap.code, message: cap.message } };
}

/**
 * The middleware. Mounted once, on every route, after the per-address limiters
 * (the counter is the cheaper check) and before the routers.
 */
export function createBodyLimits(config: BodyLimitConfig): MiddlewareHandler {
  return async (c: Context, next) => {
    const raw = c.req.raw;
    // No body a route can read: the HTTP server hands a TRACE on as a GET.
    if (BODILESS_METHODS.has(raw.method)) return next();
    const cap = bodyCapFor(config, c.req.method, c.req.path);

    // Whether there is a body, and its declared size, come from the framing
    // headers first; `raw.body` is asked for only when neither is there
    // (module note).
    const chunked = raw.headers.has("transfer-encoding");
    const declared = raw.headers.get("content-length");
    if (declared !== null && !chunked) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > cap.maxBytes) return c.json(refusal(cap), 413);
      if (length === 0) return next();
    }
    // Neither header. A request the HTTP server parsed has no body then, yet
    // its `raw.body` is never null here: the server builds its request around
    // an empty body, which leaves the connection reusable, and the request
    // goes on below with that empty body counted. The test serves a request
    // built in the process (`app.request`, in tests), whose body nothing else
    // tells apart: null when it carries none, a stream when it does.
    if (declared === null && !chunked && raw.body === null) return next();

    const state = { overflowed: false };
    // Same method, URL, headers and signal: the request is the client's, only
    // its body is counted. Its signal follows the original, so a client gone
    // mid-request still aborts what the route listens to. Built from the
    // parts, never from `raw` itself, and the body asked for at the first read.
    c.req.raw = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      signal: raw.signal,
      body: countedBody(() => raw.body, cap, state),
      duplex: "half",
    } as RequestInit);
    await next();
    if (state.overflowed) {
      // Whatever the route answered from a body it could not read whole, the
      // answer is the cap's. Its headers stay — the cookies among them: the
      // authentication erases a duplicated session cookie before any route
      // reads, and that erasure must reach the browser whatever the answer.
      // Only a length that measured another body goes. No route sets a cookie
      // once its read has failed.
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      // Cleared first: hono's setter would otherwise merge the route's answer
      // back in, its length included.
      c.res = undefined;
      c.res = new Response(JSON.stringify(refusal(cap)), { status: 413, headers });
    }
  };
}
