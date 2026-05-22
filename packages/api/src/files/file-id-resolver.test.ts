import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inputCache, registerInputFile } from "../cache/input-cache.js";
import { _clearOutputCacheForTests, registerOutput } from "../cache/output-cache.js";
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
    _clearOutputCacheForTests();
    for (const path of tempPaths) {
      try {
        rmSync(path, { force: true, recursive: true });
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
      owner_id: "test-owner",
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

  // VT-13 (SEC-009): output-side file_ids whose backing path is a symlink (or
  // realpath-escapes the registered output dir) must resolve to null. Defense
  // in depth against a malicious script that side-channels a symlink into the
  // output dir between collector run and resolver call.
  it("VT-13: returns null when the registered output file is a symlink to outside the dir", () => {
    const outDir = join(
      tmpdir(),
      `skrun-out-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(outDir, { recursive: true });
    tempPaths.push(outDir);

    // Target lives outside outDir on purpose
    const externalDir = join(
      tmpdir(),
      `skrun-external-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(externalDir, { recursive: true });
    tempPaths.push(externalDir);
    const externalFile = join(externalDir, "secret.txt");
    writeFileSync(externalFile, "shhhhh");

    // Symlink inside outDir that points outside
    const linkInsideDir = join(outDir, "leak.txt");
    try {
      symlinkSync(externalFile, linkInsideDir);
    } catch (err) {
      // Windows: skip when symlink creation requires elevation.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    // Manually wire the output cache as if the run had registered this file_id
    // (bypasses collectOutputFiles which would have already filtered the symlink).
    registerOutput("run-symlink-test", outDir, [
      { name: "leak.txt", size: 0, file_id: "fil_symlink_leak" },
    ]);

    const result = resolveFileId("fil_symlink_leak");
    expect(result).toBeNull();
  });
});
