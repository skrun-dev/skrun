export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  /**
   * Generate a short-lived presigned URL that can be used to GET the object
   * directly from the storage backend (no proxying through the API).
   *
   * Used by `FlyioAdapter` to pass bundle download URLs to spawned
   * machines without exposing storage credentials in the machine's env.
   * The TTL must cover the worst-case machine boot time.
   *
   * Backends that don't support presigning (`MemoryStorage`, `LocalStorage`)
   * throw `NotSupportedError` — those backends are local-access only and
   * the caller has direct read/write to the underlying store.
   *
   * @param key — object key in the storage backend.
   * @param expiresIn — TTL in seconds.
   * @returns presigned URL valid for `expiresIn` seconds.
   */
  getPresignedDownloadUrl(key: string, expiresIn: number): Promise<string>;

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
