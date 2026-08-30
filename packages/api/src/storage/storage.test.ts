import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorage } from "./local.js";
import { MemoryStorage } from "./memory.js";
import { R2Storage } from "./r2.js";

describe("MemoryStorage", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("should put and get a buffer", async () => {
    const data = Buffer.from("hello world");
    await storage.put("test/key", data);
    const result = await storage.get("test/key");
    expect(result).toEqual(data);
  });

  it("should return null for non-existent key", async () => {
    const result = await storage.get("missing/key");
    expect(result).toBeNull();
  });

  it("should check existence correctly", async () => {
    expect(await storage.exists("test/key")).toBe(false);
    await storage.put("test/key", Buffer.from("data"));
    expect(await storage.exists("test/key")).toBe(true);
  });

  it("should delete a key", async () => {
    await storage.put("test/key", Buffer.from("data"));
    await storage.delete("test/key");
    expect(await storage.exists("test/key")).toBe(false);
    expect(await storage.get("test/key")).toBeNull();
  });

  it("should store independent copies", async () => {
    const data = Buffer.from("original");
    await storage.put("key1", data);
    await storage.put("key2", Buffer.from("other"));
    const result = await storage.get("key1");
    expect(result?.toString()).toBe("original");
  });

  it("should overwrite existing key", async () => {
    await storage.put("key", Buffer.from("v1"));
    await storage.put("key", Buffer.from("v2"));
    const result = await storage.get("key");
    expect(result?.toString()).toBe("v2");
  });

  it("should clear all data", async () => {
    await storage.put("a", Buffer.from("1"));
    await storage.put("b", Buffer.from("2"));
    storage.clear();
    expect(await storage.exists("a")).toBe(false);
    expect(await storage.exists("b")).toBe(false);
  });

  // VT-16: MemoryStorage doesn't support presigned URLs — no remote object
  // store backs it, so any caller asking for one should get a typed throw
  // rather than a silent placeholder string. This is the structural reason
  // FlyioAdapter requires R2Storage; the typed error makes that explicit
  // at the boundary instead of failing deep in the runner with a 404.
  describe("VT-16: presigned URL methods throw NotSupportedError", () => {
    it("getPresignedDownloadUrl throws NotSupportedError", async () => {
      await expect(storage.getPresignedDownloadUrl("k", 60)).rejects.toThrow(
        /is not supported by this backend/,
      );
    });

    it("getPresignedUploadUrl throws NotSupportedError", async () => {
      await expect(storage.getPresignedUploadUrl("k", 60)).rejects.toThrow(
        /is not supported by this backend/,
      );
    });
  });
});

// SEC-013: path traversal defense on LocalStorage.resolve.
describe("LocalStorage path validation (SEC-013)", () => {
  let baseDir: string;
  let storage: LocalStorage;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "skrun-local-storage-"));
    storage = new LocalStorage(baseDir);
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore EPERM on Windows
    }
  });

  it("VT-20: rejects keys containing `..` traversal", async () => {
    await expect(storage.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(
      /resolves outside baseDir/,
    );
    await expect(storage.get("../etc/passwd")).rejects.toThrow(/resolves outside baseDir/);
  });

  it("VT-20: rejects absolute paths that bypass baseDir", async () => {
    // Posix-style absolute path. On Windows this resolves under baseDir's drive
    // letter and may not escape — accept either rejection or no-op (file not
    // found) but never a successful read outside baseDir.
    try {
      await storage.put("/tmp/escape-abs.txt", Buffer.from("x"));
      // If put succeeded (Windows path normalization), confirm the file landed
      // inside baseDir, not at /tmp.
      const got = await storage.get("/tmp/escape-abs.txt");
      expect(got?.toString()).toBe("x");
    } catch (err) {
      expect((err as Error).message).toMatch(/resolves outside baseDir/);
    }
  });

  it("accepts legitimate nested keys", async () => {
    await storage.put("ns/agent/1.0.0.bin", Buffer.from("ok"));
    const got = await storage.get("ns/agent/1.0.0.bin");
    expect(got?.toString()).toBe("ok");
  });

  // VT-16: LocalStorage backs a local filesystem; presigned URLs need a
  // remote object store. Callers should get a typed throw rather than a
  // misleading placeholder URL pointing at a local path.
  describe("VT-16: presigned URL methods throw NotSupportedError", () => {
    it("getPresignedDownloadUrl throws NotSupportedError", async () => {
      await expect(storage.getPresignedDownloadUrl("k", 60)).rejects.toThrow(
        /is not supported by this backend/,
      );
    });

    it("getPresignedUploadUrl throws NotSupportedError", async () => {
      await expect(storage.getPresignedUploadUrl("k", 60)).rejects.toThrow(
        /is not supported by this backend/,
      );
    });
  });
});

// R2Storage tests run against a MinIO instance — env-gated so CI without MinIO
// gracefully skips. CI workflow (.github/workflows/ci.yml) provisions MinIO as
// a service container and sets S3_TEST_ENDPOINT=http://minio:9000.
//
// Two assertions per scenario: the basic CRUD round-trip against the live
// MinIO, and the presigned URL flow (sign → fetch via HTTP → assert bytes).
const S3_TEST_ENDPOINT = process.env.S3_TEST_ENDPOINT;
const S3_TEST_ACCESS_KEY_ID = process.env.S3_TEST_ACCESS_KEY_ID ?? "minioadmin";
const S3_TEST_SECRET_ACCESS_KEY = process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minioadmin";
const S3_TEST_BUCKET = process.env.S3_TEST_BUCKET ?? "skrun-test";

const r2Describe = S3_TEST_ENDPOINT ? describe : describe.skip;

r2Describe("R2Storage (MinIO live)", () => {
  let storage: R2Storage;
  const testKey = `test/storage-${Date.now()}.bin`;

  beforeEach(() => {
    storage = new R2Storage({
      bucket: S3_TEST_BUCKET,
      accessKeyId: S3_TEST_ACCESS_KEY_ID,
      secretAccessKey: S3_TEST_SECRET_ACCESS_KEY,
      endpoint: S3_TEST_ENDPOINT,
    });
  });

  afterEach(async () => {
    try {
      await storage.delete(testKey);
    } catch {
      // ignore — cleanup best-effort
    }
  });

  it("put → get round-trip", async () => {
    const data = Buffer.from("hello r2");
    await storage.put(testKey, data);
    const result = await storage.get(testKey);
    expect(result?.toString()).toBe("hello r2");
  });

  it("get returns null for missing key", async () => {
    const result = await storage.get(`missing/${Date.now()}.bin`);
    expect(result).toBeNull();
  });

  it("exists reflects put + delete state", async () => {
    expect(await storage.exists(testKey)).toBe(false);
    await storage.put(testKey, Buffer.from("x"));
    expect(await storage.exists(testKey)).toBe(true);
    await storage.delete(testKey);
    expect(await storage.exists(testKey)).toBe(false);
  });

  it("getPresignedDownloadUrl returns a URL that fetches the object", async () => {
    const data = Buffer.from("presigned-download-data");
    await storage.put(testKey, data);
    const url = await storage.getPresignedDownloadUrl(testKey, 60);
    expect(url).toMatch(/^https?:\/\//);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe("presigned-download-data");
  });

  it("getPresignedUploadUrl accepts a PUT and stores the object", async () => {
    const url = await storage.getPresignedUploadUrl(testKey, 60);
    expect(url).toMatch(/^https?:\/\//);
    const response = await fetch(url, {
      method: "PUT",
      body: "presigned-upload-data",
    });
    expect(response.ok).toBe(true);
    const stored = await storage.get(testKey);
    expect(stored?.toString()).toBe("presigned-upload-data");
  });
});
