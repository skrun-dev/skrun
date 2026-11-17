import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTLCache } from "@skrun-dev/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteInputFile,
  evictInputFilesOfOwner,
  getInputFile,
  getInputRetentionSeconds,
  type InputFileMetadata,
  inputCache,
  inputFilesHeldBy,
  registerInputFile,
} from "./input-cache.js";

function makeTempFile(): { path: string; size: number; mediaType: string } {
  const dir = join(
    tmpdir(),
    `skrun-input-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "input.bin");
  const content = Buffer.from("test content");
  writeFileSync(path, content);
  return { path, size: content.length, mediaType: "image/jpeg" };
}

describe("InputCache", () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    inputCache.clear();
    for (const path of tempPaths) {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
    tempPaths.length = 0;
  });

  it("registerInputFile + getInputFile round-trip", () => {
    const { path, size, mediaType } = makeTempFile();
    tempPaths.push(path);
    const expiresAt = new Date(Date.now() + 86_400_000);
    registerInputFile("fil_test1", {
      path,
      size,
      media_type: mediaType,
      purpose: "input",
      expires_at: expiresAt,
      owner_id: "test-owner",
      uploaded_by_key_id: "test-key",
    });
    const result = getInputFile("fil_test1");
    expect(result).toBeDefined();
    expect(result?.path).toBe(path);
    expect(result?.size).toBe(size);
    expect(result?.media_type).toBe(mediaType);
    expect(result?.purpose).toBe("input");
    expect(result?.expires_at).toEqual(expiresAt);
    expect(result?.owner_id).toBe("test-owner");
    expect(result?.uploaded_by_key_id).toBe("test-key");
  });

  it("getInputFile returns undefined for unknown file_id", () => {
    expect(getInputFile("fil_unknown")).toBeUndefined();
  });

  it("deleteInputFile removes from cache and disk", () => {
    const { path, size, mediaType } = makeTempFile();
    expect(existsSync(path)).toBe(true);

    registerInputFile("fil_test2", {
      path,
      size,
      media_type: mediaType,
      purpose: "input",
      expires_at: new Date(Date.now() + 86_400_000),
      owner_id: "test-owner",
    });
    expect(getInputFile("fil_test2")).toBeDefined();

    const deleted = deleteInputFile("fil_test2");
    expect(deleted).toBe(true);
    expect(getInputFile("fil_test2")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("deleteInputFile returns false for unknown file_id", () => {
    expect(deleteInputFile("fil_does_not_exist")).toBe(false);
  });

  it("VT-10: TTL eviction removes file from disk after retention period", async () => {
    // Use a fresh cache with a 50ms TTL to avoid coupling the test to the singleton's
    // 24h default. This validates the eviction contract (TTL elapsed → onEvict fires
    // → file deleted from disk).
    const shortCache = new TTLCache<string, InputFileMetadata>({
      ttlMs: 50,
      maxEntries: 10,
      onEvict: (_key, meta) => {
        try {
          rmSync(meta.path, { force: true });
        } catch {
          // ignore
        }
      },
    });

    const { path, size, mediaType } = makeTempFile();
    expect(existsSync(path)).toBe(true);

    shortCache.set("fil_evict", {
      path,
      size,
      media_type: mediaType,
      purpose: "input",
      expires_at: new Date(Date.now() + 50),
      owner_id: "test-owner",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = shortCache.get("fil_evict");
    expect(result).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  /** Register a fresh temp file as an upload of `owner`; returns its path. */
  function upload(fileId: string, owner: string): string {
    const { path, size, mediaType } = makeTempFile();
    tempPaths.push(path);
    registerInputFile(fileId, {
      path,
      size,
      media_type: mediaType,
      purpose: "input",
      expires_at: new Date(Date.now() + 86_400_000),
      owner_id: owner,
      uploaded_by_key_id: null,
    });
    return path;
  }

  it("evicts every upload of one account, files included, and leaves another account's", () => {
    const a1 = upload("fil_owner_a1", "owner-a");
    const a2 = upload("fil_owner_a2", "owner-a");
    const b1 = upload("fil_owner_b1", "owner-b");

    expect(evictInputFilesOfOwner("owner-a")).toBe(2);

    expect(getInputFile("fil_owner_a1")).toBeUndefined();
    expect(getInputFile("fil_owner_a2")).toBeUndefined();
    expect(existsSync(a1)).toBe(false);
    expect(existsSync(a2)).toBe(false);
    expect(getInputFile("fil_owner_b1")?.owner_id).toBe("owner-b");
    expect(existsSync(b1)).toBe(true);
    expect(inputFilesHeldBy("owner-a")).toBe(0);
    expect(inputFilesHeldBy("owner-b")).toBe(1);
    expect(evictInputFilesOfOwner("owner-a")).toBe(0);
  });

  it("an account with no upload here evicts nothing", () => {
    upload("fil_owner_b2", "owner-b");
    expect(evictInputFilesOfOwner("owner-nobody")).toBe(0);
    expect(getInputFile("fil_owner_b2")).toBeDefined();
  });

  it("an upload that leaves the cache by expiry, deletion or replacement leaves the owner index too", () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    upload("fil_owner_expires", "owner-a");
    upload("fil_owner_deleted", "owner-a");
    upload("fil_owner_moved", "owner-a");
    expect(inputFilesHeldBy("owner-a")).toBe(3);

    deleteInputFile("fil_owner_deleted");
    upload("fil_owner_moved", "owner-b");
    expect(inputFilesHeldBy("owner-a")).toBe(1);
    expect(inputFilesHeldBy("owner-b")).toBe(1);

    now.mockReturnValue(start + getInputRetentionSeconds() * 1000 + 1);
    expect(inputCache.sweep()).toBe(2);
    expect(inputFilesHeldBy("owner-a")).toBe(0);
    expect(inputFilesHeldBy("owner-b")).toBe(0);
  });

  it("getInputRetentionSeconds returns default (86400) when env unset", () => {
    delete process.env.INPUT_FILES_RETENTION_S;
    expect(getInputRetentionSeconds()).toBe(86_400);
  });

  it("getInputRetentionSeconds reads INPUT_FILES_RETENTION_S env var", () => {
    process.env.INPUT_FILES_RETENTION_S = "3600";
    expect(getInputRetentionSeconds()).toBe(3600);
    delete process.env.INPUT_FILES_RETENTION_S;
  });

  it("getInputRetentionSeconds falls back to default for invalid env value", () => {
    process.env.INPUT_FILES_RETENTION_S = "not-a-number";
    expect(getInputRetentionSeconds()).toBe(86_400);
    delete process.env.INPUT_FILES_RETENTION_S;
  });

  it("getInputRetentionSeconds falls back to default for non-positive env value", () => {
    process.env.INPUT_FILES_RETENTION_S = "-10";
    expect(getInputRetentionSeconds()).toBe(86_400);
    delete process.env.INPUT_FILES_RETENTION_S;
  });

  // The retention is read as at most a hundred years, which keep an upload's
  // deadline far from the years where it would leave the four-digit form (past
  // 9999) or stop being a date (past about 275760). The value at the cap is
  // taken as it is, the next one is capped. Written in digits —
  // Number.parseInt reads "1e13" as 1.
  it.each([
    ["3153599999", 3_153_599_999],
    ["3153600000", 3_153_600_000],
    ["3153600001", 3_153_600_000],
    ["10000000000000", 3_153_600_000],
  ] as const)("INPUT_FILES_RETENTION_S=%s is read as %i seconds", (configured, seconds) => {
    vi.stubEnv("INPUT_FILES_RETENTION_S", configured);
    expect(getInputRetentionSeconds()).toBe(seconds);
  });

  // The cache that holds the uploads is built when the module loads, from the
  // same reading: it keeps an upload for the capped retention, never the raw
  // value. Hence a fresh copy of the module, loaded under the setting.
  it("the cache of uploads is built from the capped retention too", async () => {
    vi.stubEnv("INPUT_FILES_RETENTION_S", "10000000000000");
    vi.resetModules();
    const fresh = await import("./input-cache.js");

    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    fresh.registerInputFile("fil_capped", {
      path: join(tmpdir(), `skrun-input-capped-${start}.bin`),
      size: 1,
      media_type: "image/jpeg",
      purpose: "input",
      expires_at: new Date(start),
      owner_id: "test-owner",
    });

    now.mockReturnValue(start + 3_153_600_000 * 1000);
    expect(fresh.getInputFile("fil_capped")).toBeDefined();
    now.mockReturnValue(start + 3_153_600_000 * 1000 + 1);
    expect(fresh.getInputFile("fil_capped")).toBeUndefined();
  });
});
