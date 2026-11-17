/** How the response to a presigned GET presents the object. */
export interface PresignedDownloadOptions {
  /**
   * The `Content-Disposition` the store answers the GET with, signed into the
   * URL (`response-content-disposition`), so nobody holding the URL can change
   * it. An output a run produced is presigned with an attachment disposition:
   * opened from the URL, it is saved, never rendered as a page on the store's
   * origin. Omitted, the store answers with whatever the object carries.
   */
  contentDisposition?: string;
}

/**
 * Thrown by `StorageAdapter.list` for a prefix that could reach more than one
 * folder of the store: an empty one, one without a trailing `/`, or `/` alone.
 * The message does not quote the prefix, which can carry an account's name.
 */
export class InvalidListPrefixError extends Error {
  readonly code = "STORAGE_LIST_PREFIX_INVALID";

  constructor() {
    super("storage list: the prefix must be a non-empty folder ending with '/'");
    this.name = "InvalidListPrefixError";
  }
}

/**
 * The rule every `list` applies before it reaches its store. `alice` would also
 * match `alice-2/…` and `alicex`, and an empty prefix the whole store — bundles
 * of every account and every run's outputs alike.
 */
export function assertListPrefix(prefix: string): void {
  if (prefix.length < 2 || !prefix.endsWith("/") || prefix.startsWith("/")) {
    throw new InvalidListPrefixError();
  }
}

/** How a write may be ended before it completes. */
export interface StoragePutOptions {
  /**
   * Aborting it interrupts the write: the call rejects, and whether the object
   * was stored is unknown. The cloud outputs upload passes the signal of its
   * time budget, so that a write still in flight when the budget runs out does
   * not live on — with its buffer — for as long as the store's client would
   * retry. A store that cannot interrupt a write may ignore it.
   */
  signal?: AbortSignal;
}

export interface StorageAdapter {
  /** Write an object. `opts.signal` interrupts the write (see `StoragePutOptions`). */
  put(key: string, data: Buffer, opts?: StoragePutOptions): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  /**
   * Every key stored under `prefix`, sub-folders included, in no particular
   * order; keys are written with `/` whatever the platform. Pages are followed
   * inside the call. `prefix` must name a folder — non-empty, ending with `/`,
   * not starting with one — or the call throws `InvalidListPrefixError` before
   * reaching the store (`assertListPrefix`).
   *
   * Used by an account deletion, to reach the objects stored under the
   * account's namespace that no row names any more. Nothing else lists: the
   * output purge rebuilds its keys from the rows, on purpose.
   */
  list(prefix: string): Promise<string[]>;

  /**
   * Generate a short-lived presigned URL that can be used to GET the object
   * directly from the storage backend (no proxying through the API).
   *
   * Used by `FlyioAdapter` to pass bundle download URLs to spawned
   * machines without exposing storage credentials in the machine's env
   * (the TTL must then cover the worst-case machine boot time), and to hand
   * a cloud run's output files to whoever downloads them, as an attachment.
   *
   * Backends that don't support presigning (`MemoryStorage`, `LocalStorage`)
   * throw `NotSupportedError` — those backends are local-access only and
   * the caller has direct read/write to the underlying store.
   *
   * @param key — object key in the storage backend.
   * @param expiresIn — TTL in seconds.
   * @param opts — how the store's response presents the object.
   * @returns presigned URL valid for `expiresIn` seconds.
   */
  getPresignedDownloadUrl(
    key: string,
    expiresIn: number,
    opts?: PresignedDownloadOptions,
  ): Promise<string>;

  /**
   * Generate a short-lived presigned URL that can be used to PUT an object
   * directly into the storage backend.
   *
   * Used by `FlyioAdapter` to pass outputs upload URLs to spawned
   * machines; the machine PUTs files to R2 directly when a run completes.
   * Same backend-support semantics as `getPresignedDownloadUrl`.
   *
   * @param key — object key in the storage backend.
   * @param expiresIn — TTL in seconds.
   * @returns presigned URL valid for `expiresIn` seconds.
   */
  getPresignedUploadUrl(key: string, expiresIn: number): Promise<string>;
}
