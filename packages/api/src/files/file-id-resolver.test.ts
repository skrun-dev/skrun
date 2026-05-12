import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inputCache, registerInputFile } from "../cache/input-cache.js";
import { resolveFileId } from "./file-id-resolver.js";

function makeTempFile(): { path: string; size: number } {
  const dir = join(
    tmpdir(),
    `skrun-resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "data.bin");
  const content = Buffer.from("payload");
  writeFileSync(path, content);
  return { path, size: content.length };
}

describe("resolveFileId", () => {
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

  it("resolves a registered input file with source=input and metadata", () => {
    const { path, size } = makeTempFile();
    tempPaths.push(path);
    const expiresAt = new Date(Date.now() + 86_400_000);
    registerInputFile("fil_resolved", {
      path,
      size,
      media_type: "image/jpeg",
      purpose: "input",
      expires_at: expiresAt,
    });

    const result = resolveFileId("fil_resolved");
    expect(result).not.toBeNull();
    expect(result?.source).toBe("input");
    expect(result?.path).toBe(path);
    expect(result?.metadata.size).toBe(size);
    expect(result?.metadata.media_type).toBe("image/jpeg");
    expect(result?.metadata.purpose).toBe("input");
    expect(result?.metadata.expires_at).toEqual(expiresAt);
  });

  it("returns null for an unknown file_id", () => {
    expect(resolveFileId("fil_does_not_exist")).toBeNull();
  });

  it("returns null for an output-purpose file_id (Task 6.5 not yet wired)", () => {
    // Until Task 6.5 lands the output reverse index, output-side resolution returns null.
    // VT-30 (output retrieval via /api/files/:id) will flip green when 6.5 commits.
    expect(resolveFileId("fil_pretend_output_id")).toBeNull();
  });
});
