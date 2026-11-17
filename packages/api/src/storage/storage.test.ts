import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentDisposition } from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFlyioDeps } from "../routes/flyio-run-harness.shared.js";
import { InvalidListPrefixError, type StorageAdapter } from "./adapter.js";
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

  // MemoryStorage doesn't support presigned URLs — no remote object
  // store backs it, so any caller asking for one should get a typed throw
  // rather than a silent placeholder string. This is the structural reason
  // FlyioAdapter requires R2Storage; the typed error makes that explicit
  // at the boundary instead of failing deep in the runner with a 404.
  describe("presigned URL methods throw NotSupportedError", () => {
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

// Path traversal defense on LocalStorage.resolve.
describe("LocalStorage path validation", () => {
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

  it("rejects keys containing `..` traversal", async () => {
    await expect(storage.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(
      /resolves outside baseDir/,
    );
    await expect(storage.get("../etc/passwd")).rejects.toThrow(/resolves outside baseDir/);
  });

  it("rejects absolute paths that bypass baseDir", async () => {
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

  // LocalStorage backs a local filesystem; presigned URLs need a
  // remote object store. Callers should get a typed throw rather than a
  // misleading placeholder URL pointing at a local path.
  describe("presigned URL methods throw NotSupportedError", () => {
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

// Listing reaches every key under a folder, and nothing beside it: a neighbour
// whose name starts the same way, the run outputs folder. A prefix that could
// reach more than one folder is refused before the store is read.
describe("list: the keys under a folder, on the stores that run in process", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "skrun-local-list-"));
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore EPERM on Windows
    }
  });

  const stores: Record<string, () => StorageAdapter> = {
    memory: () => new MemoryStorage(),
    "local disk": () => new LocalStorage(baseDir),
  };

  for (const [label, make] of Object.entries(stores)) {
    it(`${label}: returns every key under the folder, sub-folders included, written with '/'`, async () => {
      const storage = make();
      for (const key of [
        "alice/tool/1.0.0.agent",
        "alice/tool/2.0.0.agent",
        "alice/deep/er/x.agent",
        "alice-2/tool/1.0.0.agent",
        "alicex",
        "_runs/r1/outputs/a.txt",
      ]) {
        await storage.put(key, Buffer.from("x"));
      }

      const listed = await storage.list("alice/");

      expect(listed.sort()).toEqual([
        "alice/deep/er/x.agent",
        "alice/tool/1.0.0.agent",
        "alice/tool/2.0.0.agent",
      ]);
      expect(await storage.list("alice/tool/")).toHaveLength(2);
    });

    it(`${label}: a folder nothing was stored under lists nothing`, async () => {
      const storage = make();
      await storage.put("bob/tool/1.0.0.agent", Buffer.from("x"));
      expect(await storage.list("alice/")).toEqual([]);
    });

    it.each([
      "",
      "alice",
      "/",
      "/alice/",
    ])(`${label}: refuses the prefix %j before reading the store`, async (prefix) => {
      const storage = make();
      await storage.put("alice/tool/1.0.0.agent", Buffer.from("x"));
      await expect(storage.list(prefix)).rejects.toBeInstanceOf(InvalidListPrefixError);
    });
  }

  it.each([
    "./",
    "alice/../",
  ])("local disk: refuses %j, which names the whole store", async (prefix) => {
    const storage = new LocalStorage(baseDir);
    await storage.put("alice/tool/1.0.0.agent", Buffer.from("x"));
    await expect(storage.list(prefix)).rejects.toBeInstanceOf(InvalidListPrefixError);
  });

  it("local disk: refuses a prefix that leaves the base folder", async () => {
    const storage = new LocalStorage(baseDir);
    await expect(storage.list("../")).rejects.toThrow(/resolves outside baseDir/);
  });

  it("local disk: a key stored as a file where the folder would be lists nothing", async () => {
    const storage = new LocalStorage(baseDir);
    await storage.put("alice", Buffer.from("x"));
    expect(await storage.list("alice/")).toEqual([]);
  });

  it("the cloud test harness lists through the store it wraps", async () => {
    const inner = new MemoryStorage();
    await inner.put("alice/tool/1.0.0.agent", Buffer.from("x"));
    await inner.put("bob/tool/1.0.0.agent", Buffer.from("x"));
    const { storage } = fakeFlyioDeps(inner);
    expect(await storage.list("alice/")).toEqual(["alice/tool/1.0.0.agent"]);
    await expect(storage.list("alice")).rejects.toBeInstanceOf(InvalidListPrefixError);
  });

  it("R2Storage refuses a bad prefix without calling the store", async () => {
    // Nothing listens on this address: a call that reached the store would fail
    // with a network error, not with the refusal.
    const storage = new R2Storage({
      bucket: "bucket",
      accessKeyId: "test",
      secretAccessKey: "test",
      endpoint: "http://127.0.0.1:9",
    });
    await expect(storage.list("")).rejects.toBeInstanceOf(InvalidListPrefixError);
    await expect(storage.list("alice")).rejects.toBeInstanceOf(InvalidListPrefixError);
  });
});

// A store that accepts the connection and then never answers — a wedged server,
// a proxy that swallows requests. Played by a TCP server on 127.0.0.1 that reads
// the request and says nothing; nothing else is reached. Without a timeout on
// the client, a call to such a store waits forever, and so does whatever awaits it.
describe("R2Storage against a store that never answers", () => {
  let server: Server;
  let endpoint: string;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a call fails once the connection has stayed silent too long, instead of waiting forever", {
    timeout: 10_000,
  }, async () => {
    const storage = new R2Storage({
      bucket: "bucket",
      accessKeyId: "test",
      secretAccessKey: "test",
      endpoint,
      timeouts: { connectionMs: 200, socketMs: 200 },
    });

    await expect(storage.delete("any/key")).rejects.toMatchObject({ name: "TimeoutError" });
    // The store took the connection and the request: this is the silence, not a refusal.
    expect(sockets.size).toBeGreaterThan(0);
  });

  it("a write ends as soon as its signal is aborted, long before the store's silence would end it", {
    timeout: 10_000,
  }, async () => {
    const storage = new R2Storage({
      bucket: "bucket",
      accessKeyId: "test",
      secretAccessKey: "test",
      endpoint,
      timeouts: { connectionMs: 5_000, socketMs: 5_000 },
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(new Error("the upload ran out of time")), 200);

    const settled = storage.put("any/key", Buffer.alloc(1024), { signal: controller.signal }).then(
      () => "stored",
      (err: unknown) => err,
    );
    // A write that ignored its signal would still be waiting on the store's silence here.
    const outcome = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3_000)),
    ]);

    expect(outcome).toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(sockets.size).toBeGreaterThan(0);
  });
});

// A write takes an optional signal: the outputs upload of a cloud run interrupts
// the write in flight when its time runs out, rather than leave it and its buffer
// alive for as long as the store's client would retry.
describe("put — a write can be interrupted", () => {
  it("R2Storage hands the write's signal to its client as the request's abort signal", async () => {
    const storage = new R2Storage({
      bucket: "bucket",
      accessKeyId: "test",
      secretAccessKey: "test",
      endpoint: "http://127.0.0.1:9",
    });
    const client = (storage as unknown as { client: { send: (...args: unknown[]) => unknown } })
      .client;
    const send = vi.spyOn(client, "send").mockResolvedValue({});
    const controller = new AbortController();

    await storage.put("runs/r1/out.txt", Buffer.from("x"), { signal: controller.signal });

    expect(send).toHaveBeenCalledTimes(1);
    const options = send.mock.calls[0]?.[1] as { abortSignal?: AbortSignal } | undefined;
    expect(options?.abortSignal).toBe(controller.signal);
  });

  it("the cloud harness's store hands the write's signal to the store it wraps", async () => {
    const inner = new MemoryStorage();
    const put = vi.spyOn(inner, "put");
    const { storage } = fakeFlyioDeps(inner);
    const controller = new AbortController();

    await storage.put("runs/r1/out.txt", Buffer.from("x"), { signal: controller.signal });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
  });
});

// Presigning is computed locally from the credentials: no store is reached, so
// these run everywhere. Endpoints point at addresses nothing listens on.
describe("R2Storage presigned GET with a disposition, computed without a store", () => {
  const SIGNED_AT = new Date("2026-10-01T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SIGNED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const clients = {
    "an S3-compatible endpoint": () =>
      new R2Storage({
        bucket: "bucket",
        accessKeyId: "test",
        secretAccessKey: "test",
        endpoint: "http://127.0.0.1:9",
      }),
    "an R2 account": () =>
      new R2Storage({
        bucket: "bucket",
        accessKeyId: "test",
        secretAccessKey: "test",
        accountId: "0123456789abcdef",
      }),
  };

  for (const [label, make] of Object.entries(clients)) {
    it(`carries the disposition in the signed query (${label})`, async () => {
      const disposition = attachmentDisposition("report.html");
      const url = new URL(
        await make().getPresignedDownloadUrl("_runs/r1/outputs/report.html", 60, {
          contentDisposition: disposition,
        }),
      );

      expect(url.searchParams.get("response-content-disposition")).toBe(disposition);
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("signs the disposition: another value gives another signature", async () => {
    const storage = clients["an S3-compatible endpoint"]();
    const sign = async (disposition: string) =>
      new URL(
        await storage.getPresignedDownloadUrl("k", 60, { contentDisposition: disposition }),
      ).searchParams.get("X-Amz-Signature");

    const first = await sign(attachmentDisposition("a.txt"));
    // Same instant, same inputs: the signature is a function of them.
    expect(await sign(attachmentDisposition("a.txt"))).toBe(first);
    expect(await sign(attachmentDisposition("b.txt"))).not.toBe(first);
  });

  it("adds no disposition when none is asked for", async () => {
    const url = new URL(
      await clients["an S3-compatible endpoint"]().getPresignedDownloadUrl("k", 60),
    );
    expect(url.searchParams.has("response-content-disposition")).toBe(false);
  });

  // Names a sandbox can write: a quote, a line break, a NUL, a path, non-ASCII.
  it.each([
    'quote"d.html',
    "line\r\nbreak.txt",
    "nul\u0000byte.txt",
    "../outside.txt",
    "d/b.csv",
    "报告 résumé.pdf",
  ])("carries the disposition of %j intact, on one line of the URL", async (name) => {
    const disposition = attachmentDisposition(name);
    const raw = await clients["an S3-compatible endpoint"]().getPresignedDownloadUrl(
      `_runs/r1/outputs/${name}`,
      60,
      { contentDisposition: disposition },
    );

    expect(new URL(raw).searchParams.get("response-content-disposition")).toBe(disposition);
    expect(raw).not.toMatch(/[\s"]/);
    expect(raw).not.toContain("\u0000");
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

  it("a write whose signal is aborted rejects, and stores nothing", async () => {
    const controller = new AbortController();
    controller.abort(new Error("the upload ran out of time"));
    await expect(
      storage.put(testKey, Buffer.from("never stored"), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await storage.exists(testKey)).toBe(false);
  });

  // The output purge deletes, for every run, an archive key that is almost
  // always absent. A store that answered an error here would leave every run
  // unmarked, and the same runs would be retried forever.
  it("delete resolves for a key that does not exist", async () => {
    await expect(storage.delete(`missing/${Date.now()}.bin`)).resolves.toBeUndefined();
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

  // The store must honour the signed disposition: a store that ignored it would
  // serve a cloud run's output as a page on its own origin.
  it.each([
    "report.html",
    'rap"port 报告.html',
  ])("answers a presigned GET of %j with the signed disposition", async (name) => {
    await storage.put(testKey, Buffer.from("<h1>output</h1>"));
    const disposition = attachmentDisposition(name);
    const url = await storage.getPresignedDownloadUrl(testKey, 60, {
      contentDisposition: disposition,
    });

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(disposition);
    expect(await response.text()).toBe("<h1>output</h1>");
  });

  // A folder of its own per run, so a bucket shared with earlier runs adds
  // nothing to the listing; a neighbour whose name starts the same way stays out.
  it("list returns the keys under a folder and none beside it", async () => {
    const folder = `list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inside = [`${folder}/a.agent`, `${folder}/b/c.agent`, `${folder}/b/d/e.agent`];
    const beside = `${folder}-2/a.agent`;
    try {
      for (const key of [...inside, beside]) await storage.put(key, Buffer.from("x"));

      expect((await storage.list(`${folder}/`)).sort()).toEqual([...inside].sort());
    } finally {
      for (const key of [...inside, beside]) await storage.delete(key);
    }
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
