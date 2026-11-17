import { NotSupportedError } from "@skrun-dev/runtime";
import {
  assertListPrefix,
  type PresignedDownloadOptions,
  type StorageAdapter,
  type StoragePutOptions,
} from "./adapter.js";

export class MemoryStorage implements StorageAdapter {
  private store = new Map<string, Buffer>();

  async list(prefix: string): Promise<string[]> {
    assertListPrefix(prefix);
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }

  /** The write is done before the call returns: there is nothing in flight for a signal to end. */
  async put(key: string, data: Buffer, _opts?: StoragePutOptions): Promise<void> {
    this.store.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async getPresignedDownloadUrl(
    _key: string,
    _expiresIn: number,
    _opts?: PresignedDownloadOptions,
  ): Promise<string> {
    throw new NotSupportedError(
      "MemoryStorage.getPresignedDownloadUrl",
      "presigned URLs require an S3-compatible backend — use R2Storage",
    );
  }

  async getPresignedUploadUrl(_key: string, _expiresIn: number): Promise<string> {
    throw new NotSupportedError(
      "MemoryStorage.getPresignedUploadUrl",
      "presigned URLs require an S3-compatible backend — use R2Storage",
    );
  }

  clear(): void {
    this.store.clear();
  }
}
