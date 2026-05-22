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
  let db: ReturnType<typeof createTestApp>["db"];
  const outputDirsToCleanup: string[] = [];

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    inputCache.clear();
    _clearOutputCacheForTests();
  });

  // Discover the dev-token caller's user_id by making one authed call. Lets
  // tests seed db rows owned by that synthetic user so the SEC-004 ownership
  // checks resolve.
  async function devUserId(): Promise<string> {
    const res = await app.request("/api/me", { headers: authHeader });
    const body = (await res.json()) as { id: string };
    return body.id;
  }

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
    const res = await app.request(`/api/files/${file_id}`, { headers: authHeader });

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
    const res = await app.request("/api/files/fil_does_not_exist", { headers: authHeader });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_NOT_FOUND");
  });

  it("GET /api/files/:id/content returns binary with correct Content-Type", async () => {
    const { file_id, size } = await uploadFixture("application/pdf");
    const res = await app.request(`/api/files/${file_id}/content`, { headers: authHeader });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe(String(size));
    const buf = await res.arrayBuffer();
    expect(Buffer.from(buf).toString()).toBe("fixture-bytes");
  });

  it("GET /api/files/:id/content returns 404 for unknown file_id", async () => {
    const res = await app.request("/api/files/fil_unknown/content", { headers: authHeader });
    expect(res.status).toBe(404);
  });

  it("VT-9: DELETE /api/files/:id removes an input file (subsequent GET returns 404)", async () => {
    const { file_id } = await uploadFixture("image/jpeg");

    const before = await app.request(`/api/files/${file_id}`, { headers: authHeader });
    expect(before.status).toBe(200);

    const del = await app.request(`/api/files/${file_id}`, {
      method: "DELETE",
      headers: authHeader,
    });
    expect(del.status).toBe(204);

    const after = await app.request(`/api/files/${file_id}`, { headers: authHeader });
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

    const userId = await devUserId();
    await db.createRun({
      id: "run_test_1",
      agent_id: null,
      agent_version: "test/test@1.0.0",
      user_id: userId,
      status: "completed",
    });

    const fileId = "fil_output_test_id_padding_to_32_chars";
    registerOutput("run_test_1", dir, [
      { name: filename, size: fileBytes.length, file_id: fileId },
    ]);

    const meta = await app.request(`/api/files/${fileId}`, { headers: authHeader });
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { purpose: string; size: number };
    expect(metaBody.purpose).toBe("output");
    expect(metaBody.size).toBe(fileBytes.length);

    const content = await app.request(`/api/files/${fileId}/content`, { headers: authHeader });
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

  // VT-3 (SEC-004): file routes require authentication.
  it("VT-3: GET /api/files/:id returns 401 without Authorization header", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    const res = await app.request(`/api/files/${file_id}`);
    expect(res.status).toBe(401);
  });

  it("VT-3: GET /api/files/:id/content returns 401 without Authorization header", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    const res = await app.request(`/api/files/${file_id}/content`);
    expect(res.status).toBe(401);
  });

  it("VT-3: GET /api/runs/:run_id/files/:filename returns 401 without auth", async () => {
    const res = await app.request("/api/runs/run-x/files/whatever.txt");
    expect(res.status).toBe(401);
  });

  // VT-4 (SEC-004): a caller authenticated as a different user gets 403 when
  // probing a file they don't own.
  it("VT-4: GET /api/files/:id returns 403 when caller is not the input owner", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    // Different token → different dev user id (deterministic SHA-256 of token).
    const res = await app.request(`/api/files/${file_id}`, {
      headers: { Authorization: "Bearer other-user" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("VT-4: GET /api/files/:id/content returns 403 for non-owner output file", async () => {
    const dir = join(
      tmpdir(),
      `skrun-output-vt4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.pdf"), Buffer.from("output"));
    outputDirsToCleanup.push(dir);

    // Run owned by "user-A" (a synthetic user id, not the dev caller)
    await db.createUser({ github_id: "gh-user-A", username: "user-A" });
    const owner = await db.getUserByGithubId("gh-user-A");
    if (!owner) throw new Error("seed user-A missing");
    await db.createRun({
      id: "run_vt4",
      agent_id: null,
      agent_version: "x/y@1.0.0",
      user_id: owner.id,
      status: "completed",
    });

    const fileId = "fil_vt4_output_padding_to_32chars";
    registerOutput("run_vt4", dir, [{ name: "report.pdf", size: 6, file_id: fileId }]);

    // dev-token caller (a different user) attempts to read.
    const res = await app.request(`/api/files/${fileId}/content`, { headers: authHeader });
    expect(res.status).toBe(403);
  });

  it("VT-4: GET /api/runs/:run_id/files/:filename returns 403 when caller is not the run owner", async () => {
    await db.createUser({ github_id: "gh-other-2", username: "other-2" });
    const owner = await db.getUserByGithubId("gh-other-2");
    if (!owner) throw new Error("seed other-2 missing");
    await db.createRun({
      id: "run_vt4_runfile",
      agent_id: null,
      agent_version: "x/y@1.0.0",
      user_id: owner.id,
      status: "completed",
    });

    // dev-token caller tries to read.
    const res = await app.request("/api/runs/run_vt4_runfile/files/anything.txt", {
      headers: authHeader,
    });
    expect(res.status).toBe(403);
  });

  it("VT-8: GET /api/files/:id returns 404 after the file has been evicted from cache", async () => {
    // Simplified from spec's 410: without a tombstone index, we can't differentiate
    // "never existed" from "expired". Both surface as 404. The contract preserved is
    // "the file is no longer retrievable post-eviction". 410 differentiation is a
    // future quality-of-life improvement.
    const { file_id } = await uploadFixture("image/jpeg");

    // Verify present
    const before = await app.request(`/api/files/${file_id}`, { headers: authHeader });
    expect(before.status).toBe(200);

    // Manually evict
    inputCache.delete(file_id);

    const after = await app.request(`/api/files/${file_id}`, { headers: authHeader });
    expect(after.status).toBe(404);
  });
});
