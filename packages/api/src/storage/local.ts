import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { NotSupportedError } from "@skrun-dev/runtime";
import {
  assertListPrefix,
  InvalidListPrefixError,
  type PresignedDownloadOptions,
  type StorageAdapter,
  type StoragePutOptions,
} from "./adapter.js";

export class LocalStorage implements StorageAdapter {
  private readonly baseDirResolved: string;

  constructor(private baseDir: string) {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    this.baseDirResolved = resolvePath(baseDir);
  }

  /**
   * Validate the resolved storage path stays inside baseDir.
   * Defends against keys containing `..`, absolute paths, or URL-encoded
   * slashes that decode upstream into traversal sequences (e.g. a
   * namespace like `..` reaching the storage layer despite route-level
   * regex). Uses the trailing-separator containment trick to avoid the
   * `/tmp/storage` vs `/tmp/storage-attacker` startsWith collision.
   */
  private resolve(key: string): string {
    const joined = join(this.baseDir, key);
    const full = resolvePath(joined);
    if (full !== this.baseDirResolved && !full.startsWith(this.baseDirResolved + sep)) {
      throw new Error(`Storage key "${key}" resolves outside baseDir — refusing access`);
    }
    return joined;
  }

  /** The write is done before the call returns: there is nothing in flight for a signal to end. */
  async put(key: string, data: Buffer, _opts?: StoragePutOptions): Promise<void> {
    const path = this.resolve(key);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, data);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.resolve(key);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  async delete(key: string): Promise<void> {
    const path = this.resolve(key);
    if (existsSync(path)) {
      rmSync(path);
    }
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.resolve(key));
  }

  /**
   * The files under the folder `prefix` names, walked depth-first. A prefix
   * that resolves to the base folder itself (`./`, `a/../`) is refused like an
   * empty one, and one that leaves it like any other key. Keys are rebuilt from
   * the folder names with `/`, whatever separator the platform uses. A symbolic
   * link is neither followed nor listed: nothing this store writes is one.
   */
  async list(prefix: string): Promise<string[]> {
    assertListPrefix(prefix);
    const dir = this.resolve(prefix);
    if (resolvePath(dir) === this.baseDirResolved) throw new InvalidListPrefixError();
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    const keys: string[] = [];
    const walk = (absDir: string, keyPrefix: string): void => {
      for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(absDir, entry.name), `${keyPrefix}${entry.name}/`);
        else if (entry.isFile()) keys.push(`${keyPrefix}${entry.name}`);
      }
    };
    walk(dir, prefix);
    return keys;
  }

  async getPresignedDownloadUrl(
    _key: string,
    _expiresIn: number,
    _opts?: PresignedDownloadOptions,
  ): Promise<string> {
    throw new NotSupportedError(
      "LocalStorage.getPresignedDownloadUrl",
      "presigned URLs require an S3-compatible backend — use R2Storage",
    );
  }

  async getPresignedUploadUrl(_key: string, _expiresIn: number): Promise<string> {
    throw new NotSupportedError(
      "LocalStorage.getPresignedUploadUrl",
      "presigned URLs require an S3-compatible backend — use R2Storage",
    );
  }
}
