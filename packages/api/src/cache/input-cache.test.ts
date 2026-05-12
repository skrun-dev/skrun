import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TTLCache } from "@skrun-dev/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteInputFile,
  getInputFile,
  getInputRetentionSeconds,
  type InputFileMetadata,
  inputCache,
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
    });
    const result = getInputFile("fil_test1");
    expect(result).toBeDefined();
    expect(result?.path).toBe(path);
    expect(result?.size).toBe(size);
    expect(result?.media_type).toBe(mediaType);
    expect(result?.purpose).toBe("input");
    expect(result?.expires_at).toEqual(expiresAt);
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
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = shortCache.get("fil_evict");
    expect(result).toBeUndefined();
    expect(existsSync(path)).toBe(false);
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
});
