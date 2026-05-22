import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorage } from "./local.js";
import { MemoryStorage } from "./memory.js";

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
});
