/**
 * The download of an agent's bundle by the runner, at `/init`, from the
 * presigned URL the harness sends.
 *
 * The body is copied to the disk by `pipeline()`, never `.pipe()`: a body that
 * fails on its way — a connection cut in the middle — must fail this download,
 * and `.pipe()` leaves the source's error with no listener, which brings the
 * whole runner down instead. It is written beside its destination first, and
 * renamed once whole: what a failure leaves behind is removed, so the bundle
 * path never holds a partial archive.
 *
 * A failure of the download itself is a `BundleFetchFailedError` whose `kind`
 * says how: no answer (`network`), an answer that refused (`status`), a body
 * that did not arrive whole (`incomplete`). A failure of the disk it writes to
 * is not a download's: it is thrown as the file system raised it, its code
 * (`ENOSPC`, …) intact.
 *
 * A leaf module: the runner's slim entry exports it (see `runner.ts`).
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { BundleFetchFailedError, type BundleFetchFailureKind } from "../errors.js";

export interface DownloadBundleOptions {
  /** Ends the download with its reason, as its caller's — never as a failure of the download. */
  signal?: AbortSignal;
  /** The fetch to download with: the global one, unless a test hands another. */
  fetch?: typeof fetch;
}

/** The system calls a file written to the disk fails on. */
const DISK_SYSCALLS = new Set(["open", "write", "writev", "close", "rename"]);

/** Whether `err` is the file system's, raised writing the bundle, rather than the body's. */
function isDiskFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, syscall } = err as { code?: unknown; syscall?: unknown };
  return typeof code === "string" && typeof syscall === "string" && DISK_SYSCALLS.has(syscall);
}

/** The host of `url`, never more of it: the rest of a presigned URL is its credential. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * The length the answer declares for the bytes it delivers: its Content-Length,
 * unless the body was sent encoded — fetch decodes it, and the declared length
 * is then the encoded one's.
 */
function declaredLength(res: Response): number | undefined {
  const encoding = res.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return undefined;
  const raw = res.headers.get("content-length");
  return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
}

/** Resolves once `file` has closed, so that what it wrote can be removed on every platform. */
function closed(file: WriteStream): Promise<void> {
  return file.closed ? Promise.resolve() : new Promise((done) => file.once("close", done));
}

/** Download the bundle at `url` to `dest`, whole, or throw and leave nothing at either path. */
export async function downloadBundle(
  url: string,
  dest: string,
  options: DownloadBundleOptions = {},
): Promise<void> {
  const { signal } = options;
  const urlHost = hostOf(url);
  const failed = (
    kind: BundleFetchFailureKind,
    httpStatus: number | null,
    bytesDownloaded: number,
    cause?: unknown,
  ) => new BundleFetchFailedError({ urlHost, httpStatus, bytesDownloaded, kind }, cause);

  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw failed("network", null, 0, err);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw failed("status", res.status, 0);
  }

  const declared = declaredLength(res);
  const part = `${dest}.part`;
  const file = createWriteStream(part);
  const body = res.body
    ? Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)
    : Readable.from([]);
  try {
    await pipeline(body, file, { signal });
  } catch (err) {
    await closed(file);
    await rm(part, { force: true });
    if (signal?.aborted) throw signal.reason;
    if (isDiskFailure(err)) throw err;
    throw failed("incomplete", res.status, file.bytesWritten, err);
  }

  if (declared !== undefined && file.bytesWritten !== declared) {
    await rm(part, { force: true });
    throw failed("incomplete", res.status, file.bytesWritten);
  }
  try {
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
