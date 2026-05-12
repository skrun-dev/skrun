/**
 * E2E: Multimodal inputs — cross-cutting API integration scenarios.
 *
 * Covers the file lifecycle (upload → reference → retrieve → delete) and the
 * unified `/api/files` namespace mounted in the Hono test app. These tests
 * exercise the real API routes (api package) end-to-end without spinning up
 * a real LLM. Per-provider translation, IR resolution, and capability checks
 * are covered by unit tests; full vision/audio/PDF round-trips with real
 * LLMs land in the live test suite (Phase 9.2).
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inputCache } from "../../packages/api/src/cache/input-cache.js";
import {
  _clearOutputCacheForTests,
  registerOutput,
} from "../../packages/api/src/cache/output-cache.js";
import { devAuth, createTestApp as setup } from "./setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

describe("E2E: multimodal — Files API round-trip", () => {
  let app: ReturnType<typeof setup>["app"];

  beforeEach(() => {
    app = setup().app;
    inputCache.clear();
    _clearOutputCacheForTests();
    delete process.env.INPUT_FILES_MAX_SIZE_MB;
  });

  afterEach(() => {
    inputCache.clear();
    _clearOutputCacheForTests();
  });

  function uploadForm(bytes: Uint8Array, mime: string, filename: string): FormData {
    const fd = new FormData();
    fd.append("file", new Blob([bytes as unknown as ArrayBuffer], { type: mime }), filename);
    return fd;
  }

  it("upload → GET metadata → GET content → DELETE → 404 round-trip", async () => {
    const bytes = readFileSync(join(FIXTURES, "sample-image.jpg"));

    // 1. POST /api/files
    const upload = await app.request("/api/files", {
      method: "POST",
      headers: devAuth,
      body: uploadForm(bytes, "image/jpeg", "sample-image.jpg"),
    });
    expect(upload.status).toBe(201);
    const meta = (await upload.json()) as {
      file_id: string;
      size: number;
      media_type: string;
      purpose: string;
    };
    expect(meta.file_id).toMatch(/^fil_[0-9a-f]{32}$/);
    expect(meta.size).toBe(bytes.length);
    expect(meta.media_type).toBe("image/jpeg");
    expect(meta.purpose).toBe("input");

    // 2. GET /api/files/:id (metadata)
    const metaRes = await app.request(`/api/files/${meta.file_id}`);
    expect(metaRes.status).toBe(200);
    const metaBody = (await metaRes.json()) as { size: number; media_type: string };
    expect(metaBody.size).toBe(bytes.length);
    expect(metaBody.media_type).toBe("image/jpeg");

    // 3. GET /api/files/:id/content (binary)
    const contentRes = await app.request(`/api/files/${meta.file_id}/content`);
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("Content-Type")).toBe("image/jpeg");
    const contentBytes = Buffer.from(await contentRes.arrayBuffer());
    expect(contentBytes.equals(bytes)).toBe(true);

    // 4. DELETE
    const del = await app.request(`/api/files/${meta.file_id}`, {
      method: "DELETE",
      headers: devAuth,
    });
    expect(del.status).toBe(204);

    // 5. GET → 404
    const after = await app.request(`/api/files/${meta.file_id}`);
    expect(after.status).toBe(404);
  });

  it("rejects upload with text/plain (415 MIME_NOT_ALLOWED)", async () => {
    const bytes = Buffer.from("just a text file");
    const res = await app.request("/api/files", {
      method: "POST",
      headers: devAuth,
      body: uploadForm(bytes, "text/plain", "note.txt"),
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MIME_NOT_ALLOWED");
  });

  it("accepts the 3 broad media classes (image/* + application/pdf + audio/*)", async () => {
    const samples: Array<[string, string, string]> = [
      ["sample-image.jpg", "image/jpeg", "image"],
      ["sample.pdf", "application/pdf", "document"],
      ["sample.wav", "audio/wav", "audio"],
    ];
    for (const [filename, mime] of samples) {
      const bytes = readFileSync(join(FIXTURES, filename));
      const res = await app.request("/api/files", {
        method: "POST",
        headers: devAuth,
        body: uploadForm(new Uint8Array(bytes), mime, filename),
      });
      expect(res.status, `expected 201 for ${mime}`).toBe(201);
    }
  });

  it("rejects oversize upload (413 FILE_TOO_LARGE)", async () => {
    process.env.INPUT_FILES_MAX_SIZE_MB = "1";
    const oversize = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB env limit
    const res = await app.request("/api/files", {
      method: "POST",
      headers: devAuth,
      body: uploadForm(new Uint8Array(oversize), "image/jpeg", "big.jpg"),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("output file retrievable via unified /api/files/:id/content (Task 6.5)", async () => {
    // Simulate a completed run with an output dir. Use a temp dir (not the fixtures
    // dir) because output-cache's onEvict will rmSync the dir on cleanup.
    const tmpOutputDir = join(
      tmpdir(),
      `skrun-e2e-output-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpOutputDir, { recursive: true });
    copyFileSync(join(FIXTURES, "sample-image.jpg"), join(tmpOutputDir, "sample-image.jpg"));

    const fileId = "fil_e2e_output_test_padding_to_32";
    registerOutput("run_e2e_test", tmpOutputDir, [
      { name: "sample-image.jpg", size: 30331, file_id: fileId },
    ]);

    const meta = await app.request(`/api/files/${fileId}`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { purpose: string };
    expect(metaBody.purpose).toBe("output");

    const content = await app.request(`/api/files/${fileId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("Content-Type")).toBe("image/jpeg");

    // DELETE on output → 403 (peer-review B-2 fix)
    const del = await app.request(`/api/files/${fileId}`, {
      method: "DELETE",
      headers: devAuth,
    });
    expect(del.status).toBe(403);
    const delBody = (await del.json()) as { error: { code: string } };
    expect(delBody.error.code).toBe("DELETE_OUTPUT_FORBIDDEN");

    // Cleanup the temp dir we created (output-cache's onEvict would also do this
    // when _clearOutputCacheForTests runs in afterEach, but we're explicit).
    try {
      rmSync(tmpOutputDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns 401 when uploading without Authorization", async () => {
    const bytes = readFileSync(join(FIXTURES, "sample-image.jpg"));
    const res = await app.request("/api/files", {
      method: "POST",
      body: uploadForm(new Uint8Array(bytes), "image/jpeg", "sample-image.jpg"),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown file_id", async () => {
    const res = await app.request("/api/files/fil_does_not_exist_at_all_31_chars");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_NOT_FOUND");
  });
});
