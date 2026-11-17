import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  assertListPrefix,
  type PresignedDownloadOptions,
  type StorageAdapter,
  type StoragePutOptions,
} from "./adapter.js";

/** How long a call may take to open its connection to the store, in milliseconds. */
export const R2_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * How long an open connection may stay silent, in milliseconds — no byte sent
 * or received. Not how long a call may last: a large bundle pushed at any speed
 * keeps its bytes moving and never trips it. A store that took the connection
 * and never answers fails the call instead of holding it, and whatever awaits
 * it, forever. The client retries a call that timed out, so one call can wait
 * about three times this long before it fails.
 *
 * Not a request timeout: that one counts until the response headers, which
 * includes sending the whole body, so a value short enough to catch a silent
 * store would also fail a slow push.
 */
export const R2_SOCKET_TIMEOUT_MS = 60_000;

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
  /**
   * The two timeouts, in milliseconds. Defaults: `R2_CONNECTION_TIMEOUT_MS` and
   * `R2_SOCKET_TIMEOUT_MS`. Tests shorten them; nothing else sets them.
   */
  timeouts?: { connectionMs: number; socketMs: number };
}

export class R2Storage implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2StorageConfig) {
    this.bucket = config.bucket;

    const isMinIO = config.endpoint !== undefined;
    const timeouts = config.timeouts ?? {
      connectionMs: R2_CONNECTION_TIMEOUT_MS,
      socketMs: R2_SOCKET_TIMEOUT_MS,
    };
    const clientConfig: S3ClientConfig = {
      region: config.region ?? (isMinIO ? "us-east-1" : "auto"),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Without these the client waits on a silent store forever: its defaults
      // set no connection, socket or request timeout.
      requestHandler: {
        connectionTimeout: timeouts.connectionMs,
        socketTimeout: timeouts.socketMs,
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

  /** The signal reaches the client as the request's abort signal: aborting it ends the request. */
  async put(key: string, data: Buffer, opts?: StoragePutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
      }),
      { abortSignal: opts?.signal },
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

  /**
   * One `ListObjectsV2` call per page of at most 1000 keys, following the
   * continuation token until the store says the listing is complete.
   */
  async list(prefix: string): Promise<string[]> {
    assertListPrefix(prefix);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return keys;
  }

  /**
   * A disposition rides in the query as `response-content-disposition`, which
   * the signature covers: the store answers with it, and a changed value fails
   * the signature check. Computed locally — no call to the store.
   */
  async getPresignedDownloadUrl(
    key: string,
    expiresIn: number,
    opts?: PresignedDownloadOptions,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(opts?.contentDisposition !== undefined && {
        ResponseContentDisposition: opts.contentDisposition,
      }),
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async getPresignedUploadUrl(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }
}
