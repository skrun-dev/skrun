import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageAdapter } from "./adapter.js";

/**
 * R2Storage — S3-compatible storage backend.
 *
 * Targets two backends with the same client + code path:
 *   - Cloudflare R2 (cloud mode) — `accountId` set, `endpoint` derived
 *     to `https://${accountId}.r2.cloudflarestorage.com`, `region: "auto"`,
 *     virtual-hosted style.
 *   - MinIO (self-host mode) — `endpoint` set explicitly (e.g.
 *     `http://minio:9000`), `forcePathStyle: true` (MinIO requirement),
 *     `region` defaults to `us-east-1`.
 *
 * The class is the production materialization of the `StorageAdapter`
 * interface for the Fly.io adapter — bundles are PUT to R2 (or MinIO in
 * self-host) by the registry on push, fetched via presigned GET URL by
 * the Fly.io Machine entrypoint at run boot.
 */
export interface R2StorageConfig {
  /** Bucket name (R2 or MinIO). */
  bucket: string;
  /** Access key id (R2 token or MinIO root user). */
  accessKeyId: string;
  /** Secret access key (R2 token secret or MinIO root password). */
  secretAccessKey: string;
  /** Cloudflare R2 account id — set for R2 mode, leave undefined for MinIO. */
  accountId?: string;
  /** S3 endpoint — set explicitly for MinIO; ignored for R2 (derived from accountId). */
  endpoint?: string;
  /** Region — defaults to "auto" for R2, "us-east-1" for MinIO. */
  region?: string;
}

export class R2Storage implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2StorageConfig) {
    this.bucket = config.bucket;

    const isMinIO = config.endpoint !== undefined;
    const clientConfig: S3ClientConfig = {
      region: config.region ?? (isMinIO ? "us-east-1" : "auto"),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };

    if (isMinIO) {
      clientConfig.endpoint = config.endpoint;
      clientConfig.forcePathStyle = true;
    } else {
      if (!config.accountId) {
        throw new Error("R2Storage: either `endpoint` (MinIO) or `accountId` (R2) must be set");
      }
      clientConfig.endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
    }

    this.client = new S3Client(clientConfig);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!result.Body) return null;
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw err;
    }
  }

  async getPresignedDownloadUrl(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }

  async getPresignedUploadUrl(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }
}
