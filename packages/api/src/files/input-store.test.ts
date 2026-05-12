import { existsSync, readFileSync, rmSync } from "node:fs";
import { SkrunError } from "@skrun-dev/schema";
import { afterEach, describe, expect, it } from "vitest";
import { getInputStoreDir, getMaxInputSizeBytes, writeInputFile } from "./input-store.js";

describe("InputStore", () => {
  const writtenPaths: string[] = [];

  afterEach(() => {
    for (const path of writtenPaths) {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
    writtenPaths.length = 0;
    delete process.env.INPUT_FILES_MAX_SIZE_MB;
  });

  it("writes a file and returns a fil_-prefixed id + path + size", () => {
    const bytes = Buffer.from("hello world");
    const result = writeInputFile(bytes);
    writtenPaths.push(result.path);

    expect(result.file_id).toMatch(/^fil_[0-9a-f]{32}$/);
    expect(result.size).toBe(11);
    expect(result.path.startsWith(getInputStoreDir())).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path)).toEqual(bytes);
  });

  it("generates unique file_ids across calls", () => {
    const a = writeInputFile(Buffer.from("a"));
    const b = writeInputFile(Buffer.from("b"));
    writtenPaths.push(a.path, b.path);
    expect(a.file_id).not.toBe(b.file_id);
  });

  it("throws FILE_TOO_LARGE when bytes exceed default 25 MB limit", () => {
    const oversize = Buffer.alloc(26 * 1024 * 1024);
    expect(() => writeInputFile(oversize)).toThrow(SkrunError);
    try {
      writeInputFile(oversize);
    } catch (err) {
      expect(err).toBeInstanceOf(SkrunError);
      expect((err as SkrunError).code).toBe("FILE_TOO_LARGE");
    }
  });

  it("respects INPUT_FILES_MAX_SIZE_MB env override", () => {
    process.env.INPUT_FILES_MAX_SIZE_MB = "1";
    const oversize = Buffer.alloc(2 * 1024 * 1024);
    expect(() => writeInputFile(oversize)).toThrow(SkrunError);

    const ok = writeInputFile(Buffer.alloc(512 * 1024));
    writtenPaths.push(ok.path);
    expect(ok.size).toBe(512 * 1024);
  });

  it("getMaxInputSizeBytes returns 25MB default in bytes", () => {
    delete process.env.INPUT_FILES_MAX_SIZE_MB;
    expect(getMaxInputSizeBytes()).toBe(25 * 1024 * 1024);
  });

  it("getMaxInputSizeBytes reads INPUT_FILES_MAX_SIZE_MB env", () => {
    process.env.INPUT_FILES_MAX_SIZE_MB = "10";
    expect(getMaxInputSizeBytes()).toBe(10 * 1024 * 1024);
  });

  it("getMaxInputSizeBytes falls back to default for invalid env value", () => {
    process.env.INPUT_FILES_MAX_SIZE_MB = "not-a-number";
    expect(getMaxInputSizeBytes()).toBe(25 * 1024 * 1024);
  });
});
