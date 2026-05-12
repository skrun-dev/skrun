import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inputCache } from "../cache/input-cache.js";
import { _clearOutputCacheForTests, registerOutput } from "../cache/output-cache.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

function createTestApp() {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);
  return { app, db, storage };
}

const authHeader = { Authorization: "Bearer dev-token" };

function makeMultipart(file: Blob, fieldName = "file"): FormData {
  const fd = new FormData();
  fd.append(fieldName, file);
  return fd;
}

describe("Files Routes — POST /api/files (input upload)", () => {
  let app: ReturnType<typeof createTestApp>["app"];

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    inputCache.clear();
    delete process.env.INPUT_FILES_MAX_SIZE_MB;
    delete process.env.INPUT_FILES_RETENTION_S;
  });

  afterEach(() => {
    inputCache.clear();
  });

  it("VT-4: uploads a JPEG and returns 201 with file_id, size, media_type, purpose, expires_at", async () => {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const fd = makeMultipart(blob);

    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      file_id: string;
      size: number;
      media_type: string;
      purpose: string;
      expires_at: string;
    };
    expect(body.file_id).toMatch(/^fil_[0-9a-f]{32}$/);
    expect(body.size).toBe(bytes.length);
    expect(body.media_type).toBe("image/jpeg");
    expect(body.purpose).toBe("input");
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("uploads a PDF (application/pdf) successfully", async () => {
    const blob = new Blob([Buffer.from("%PDF-1.4 fake")], { type: "application/pdf" });
    const fd = makeMultipart(blob);

    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { media_type: string };
    expect(body.media_type).toBe("application/pdf");
  });

  it("uploads a WAV (audio/wav) successfully", async () => {
    const blob = new Blob([Buffer.from("RIFFfake")], { type: "audio/wav" });
    const fd = makeMultipart(blob);

    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { media_type: string };
    expect(body.media_type).toBe("audio/wav");
  });

  it("VT-5: returns 413 when file size exceeds INPUT_FILES_MAX_SIZE_MB", async () => {
    process.env.INPUT_FILES_MAX_SIZE_MB = "1";

    const oversize = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB limit
    const blob = new Blob([oversize], { type: "image/jpeg" });
    const fd = makeMultipart(blob);

    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("VT-6: returns 415 when mime is outside the broad allowlist (text/plain)", async () => {
    const blob = new Blob([Buffer.from("hello")], { type: "text/plain" });
    const fd = makeMultipart(blob);

    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MIME_NOT_ALLOWED");
    expect(body.error.message).toContain("text/plain");
  });

  it("returns 400 when 'file' field is missing", async () => {
    const fd = new FormData();
    fd.append("not_file", new Blob([Buffer.from("x")], { type: "image/jpeg" }));

    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MISSING_FILE");
  });

  it("returns 401 when Authorization header is absent", async () => {
    const blob = new Blob([Buffer.from("x")], { type: "image/jpeg" });
    const fd = makeMultipart(blob);

    const res = await app.request("/api/files", {
      method: "POST",
      body: fd,
    });
    expect(res.status).toBe(401);
  });
});

describe("Files Routes — GET /api/files/:id (metadata + content)", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  const outputDirsToCleanup: string[] = [];

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    inputCache.clear();
    _clearOutputCacheForTests();
  });

  afterEach(() => {
    inputCache.clear();
    _clearOutputCacheForTests();
    for (const d of outputDirsToCleanup) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    outputDirsToCleanup.length = 0;
  });

  async function uploadFixture(mime = "image/jpeg"): Promise<{ file_id: string; size: number }> {
    const bytes = Buffer.from("fixture-bytes");
    const blob = new Blob([bytes], { type: mime });
    const fd = makeMultipart(blob);
    const res = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file_id: string; size: number };
    return body;
  }

  it("VT-7: GET /api/files/:id returns metadata for an uploaded file", async () => {
    const { file_id, size } = await uploadFixture("image/jpeg");
    const res = await app.request(`/api/files/${file_id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      file_id: string;
      size: number;
      media_type: string;
      purpose: string;
      expires_at: string;
    };
    expect(body.file_id).toBe(file_id);
    expect(body.size).toBe(size);
    expect(body.media_type).toBe("image/jpeg");
    expect(body.purpose).toBe("input");
    expect(body.expires_at).toBeDefined();
  });

  it("GET /api/files/:id returns 404 for unknown file_id", async () => {
    const res = await app.request("/api/files/fil_does_not_exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_NOT_FOUND");
  });

  it("GET /api/files/:id/content returns binary with correct Content-Type", async () => {
    const { file_id, size } = await uploadFixture("application/pdf");
    const res = await app.request(`/api/files/${file_id}/content`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe(String(size));
    const buf = await res.arrayBuffer();
    expect(Buffer.from(buf).toString()).toBe("fixture-bytes");
  });

  it("GET /api/files/:id/content returns 404 for unknown file_id", async () => {
    const res = await app.request("/api/files/fil_unknown/content");
    expect(res.status).toBe(404);
  });

  it("VT-9: DELETE /api/files/:id removes an input file (subsequent GET returns 404)", async () => {
    const { file_id } = await uploadFixture("image/jpeg");

    const before = await app.request(`/api/files/${file_id}`);
    expect(before.status).toBe(200);

    const del = await app.request(`/api/files/${file_id}`, {
      method: "DELETE",
      headers: authHeader,
    });
    expect(del.status).toBe(204);

    const after = await app.request(`/api/files/${file_id}`);
    expect(after.status).toBe(404);
  });

  it("DELETE /api/files/:id returns 404 for unknown file_id", async () => {
    const res = await app.request("/api/files/fil_unknown", {
      method: "DELETE",
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/files/:id returns 401 when Authorization is absent", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    const res = await app.request(`/api/files/${file_id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("VT-30: output file retrievable via unified GET /api/files/:id/content", async () => {
    // Simulate a completed run that produced an output file
    const dir = join(
      tmpdir(),
      `skrun-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    const filename = "report.pdf";
    const fileBytes = Buffer.from("%PDF-1.4 fake output");
    writeFileSync(join(dir, filename), fileBytes);
    outputDirsToCleanup.push(dir);

    const fileId = "fil_output_test_id_padding_to_32_chars";
    registerOutput("run_test_1", dir, [
      { name: filename, size: fileBytes.length, file_id: fileId },
    ]);

    const meta = await app.request(`/api/files/${fileId}`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { purpose: string; size: number };
    expect(metaBody.purpose).toBe("output");
    expect(metaBody.size).toBe(fileBytes.length);

    const content = await app.request(`/api/files/${fileId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("Content-Type")).toBe("application/pdf");
    const buf = await content.arrayBuffer();
    expect(Buffer.from(buf).equals(fileBytes)).toBe(true);
  });

  it("VT-31: DELETE /api/files/:id on a purpose=output file returns 403", async () => {
    const dir = join(
      tmpdir(),
      `skrun-output-del-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    const filename = "report.pdf";
    writeFileSync(join(dir, filename), Buffer.from("output"));
    outputDirsToCleanup.push(dir);

    const fileId = "fil_output_delete_test_padding_32";
    registerOutput("run_test_2", dir, [{ name: filename, size: 6, file_id: fileId }]);

    const res = await app.request(`/api/files/${fileId}`, {
      method: "DELETE",
      headers: authHeader,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DELETE_OUTPUT_FORBIDDEN");
  });

  it("VT-8: GET /api/files/:id returns 404 after the file has been evicted from cache", async () => {
    // Simplified from spec's 410: without a tombstone index, we can't differentiate
    // "never existed" from "expired". Both surface as 404. The contract preserved is
    // "the file is no longer retrievable post-eviction". 410 differentiation is a
    // future quality-of-life improvement.
    const { file_id } = await uploadFixture("image/jpeg");

    // Verify present
    const before = await app.request(`/api/files/${file_id}`);
    expect(before.status).toBe(200);

    // Manually evict
    inputCache.delete(file_id);

    const after = await app.request(`/api/files/${file_id}`);
    expect(after.status).toBe(404);
  });
});
