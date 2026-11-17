import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentDisposition, runOutputKey } from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { createSession, sessionCookieName } from "../auth/session.js";
import { inputCache } from "../cache/input-cache.js";
import { _clearOutputCacheForTests, registerOutput } from "../cache/output-cache.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { ACCOUNT_LIMIT_MESSAGE } from "../quotas/admission.js";
import { parseQuotaEnv, type QuotaEnv } from "../quotas/thresholds.js";
import type { FlyioRuntimeDeps } from "../runtime/adapter-selection.js";
import type { PresignedDownloadOptions } from "../storage/adapter.js";
import { MemoryStorage } from "../storage/memory.js";

// The server's log lines, captured: a refused upload writes one, and a plan no
// setting names one more. Only `createLogger` is replaced; the rest of
// @skrun-dev/runtime is left as it is.
const { logInfoSpy, logWarnSpy } = vi.hoisted(() => ({
  logInfoSpy: vi.fn(),
  logWarnSpy: vi.fn(),
}));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const quiet = { error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), level: "info" };
  const child = () => ({ ...quiet, info: logInfoSpy, warn: logWarnSpy, child });
  return {
    ...actual,
    createLogger: () => ({ ...quiet, info: logInfoSpy, warn: vi.fn(), child }),
  };
});

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
    vi.unstubAllEnvs();
    inputCache.clear();
  });

  it("uploads a JPEG and returns 201 with file_id, size, media_type, purpose, expires_at", async () => {
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

  it("returns 413 when file size exceeds INPUT_FILES_MAX_SIZE_MB", async () => {
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

  it("returns 415 when mime is outside the broad allowlist (text/plain)", async () => {
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

  // A retention past a hundred years is read as a hundred years: the upload
  // succeeds, and its deadline is that far out, a date with a four-digit year.
  // The value at the cap is taken as it is, the next one is capped. Written in
  // digits — Number.parseInt reads "1e13" as 1.
  it.each([
    ["10000000000000", 3_153_600_000],
    ["3153600001", 3_153_600_000],
    ["3153600000", 3_153_600_000],
    ["3153599999", 3_153_599_999],
  ] as const)("an upload with INPUT_FILES_RETENTION_S=%s answers 201 and expires %i seconds out", async (configured, seconds) => {
    vi.stubEnv("INPUT_FILES_RETENTION_S", configured);
    const fd = makeMultipart(new Blob([Buffer.from("x")], { type: "image/jpeg" }));

    const before = Date.now();
    const res = await app.request("/api/files", { method: "POST", headers: authHeader, body: fd });
    const after = Date.now();

    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { expires_at: string };
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const expiresMs = Date.parse(body.expires_at);
    expect(expiresMs).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + seconds * 1000);
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
  // tests seed db rows owned by that synthetic user so the ownership
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

  it("GET /api/files/:id returns metadata for an uploaded file", async () => {
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

  it("DELETE /api/files/:id removes an input file (subsequent GET returns 404)", async () => {
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

  it("output file retrievable via unified GET /api/files/:id/content", async () => {
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

  it("DELETE /api/files/:id on a purpose=output file returns 403", async () => {
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

  // The ownership check, extended to the delete path: a different authenticated user
  // must not be able to delete an input file they don't own (cross-user IDOR).
  it("DELETE /api/files/:id returns 403 when caller is not the input owner", async () => {
    const { file_id } = await uploadFixture("image/jpeg");

    // Different token → different dev user id (deterministic SHA-256 of token).
    const res = await app.request(`/api/files/${file_id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer other-user" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    // The file must still exist for its real owner (delete was rejected).
    const after = await app.request(`/api/files/${file_id}`, { headers: authHeader });
    expect(after.status).toBe(200);
  });

  // File routes require authentication.
  it("GET /api/files/:id returns 401 without Authorization header", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    const res = await app.request(`/api/files/${file_id}`);
    expect(res.status).toBe(401);
  });

  it("GET /api/files/:id/content returns 401 without Authorization header", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    const res = await app.request(`/api/files/${file_id}/content`);
    expect(res.status).toBe(401);
  });

  it("GET /api/runs/:run_id/files/:filename returns 401 without auth", async () => {
    const res = await app.request("/api/runs/run-x/files/whatever.txt");
    expect(res.status).toBe(401);
  });

  // A caller authenticated as a different user gets 403 when
  // probing a file they don't own.
  it("GET /api/files/:id returns 403 when caller is not the input owner", async () => {
    const { file_id } = await uploadFixture("image/jpeg");
    // Different token → different dev user id (deterministic SHA-256 of token).
    const res = await app.request(`/api/files/${file_id}`, {
      headers: { Authorization: "Bearer other-user" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("GET /api/files/:id/content returns 403 for non-owner output file", async () => {
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

  it("GET /api/runs/:run_id/files/:filename returns an opaque 404 when caller is not the run owner", async () => {
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
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("RUN_NOT_FOUND");
  });

  it("GET /api/files/:id returns 404 after the file has been evicted from cache", async () => {
    // A 404, not a 410: without a tombstone index, we can't differentiate
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

describe("Files Routes — one MIME table, every download an attachment", () => {
  let app: ReturnType<typeof createTestApp>["app"];
  let db: ReturnType<typeof createTestApp>["db"];
  let dir: string;
  const RUN_ID = "run_mime_disposition";

  beforeEach(async () => {
    const ctx = createTestApp();
    app = ctx.app;
    db = ctx.db;
    inputCache.clear();
    _clearOutputCacheForTests();
    dir = join(tmpdir(), `skrun-output-mime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const me = await app.request("/api/me", { headers: authHeader });
    const { id: userId } = (await me.json()) as { id: string };
    await db.createRun({
      id: RUN_ID,
      agent_id: null,
      agent_version: "test/test@1.0.0",
      user_id: userId,
      status: "completed",
    });
  });

  afterEach(() => {
    inputCache.clear();
    _clearOutputCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An output file of the run, on disk and registered under `fileId`. */
  function output(name: string, fileId: string): void {
    writeFileSync(join(dir, name), Buffer.from("output-bytes"));
    registerOutput(RUN_ID, dir, [{ name, size: 12, file_id: fileId }]);
  }

  it.each([
    ["picture.webp", "image/webp", "fil_mime_webp_padding_to_32_chars_"],
    ["diagram.svg", "image/svg+xml", "fil_mime_svg_padding_to_32_chars__"],
  ])("serves %s by file_id with its type, as an attachment", async (name, type, fileId) => {
    output(name, fileId);

    const res = await app.request(`/api/files/${fileId}/content`, { headers: authHeader });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(type);
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${name}"; filename*=UTF-8''${name}`,
    );
  });

  it.each([
    ["picture.webp", "image/webp"],
    ["diagram.svg", "image/svg+xml"],
  ])("serves %s by run and name with the same type", async (name, type) => {
    output(name, `fil_${name.replace(".", "_")}_padding_to_32_chars`);

    const res = await app.request(`/api/runs/${RUN_ID}/files/${name}`, { headers: authHeader });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(type);
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${name}"; filename*=UTF-8''${name}`,
    );
  });

  it("serves an uploaded input by file_id as an attachment named by its id", async () => {
    const fd = makeMultipart(new Blob([Buffer.from("jpeg-bytes")], { type: "image/jpeg" }));
    const upload = await app.request("/api/files", {
      method: "POST",
      headers: authHeader,
      body: fd,
    });
    const { file_id } = (await upload.json()) as { file_id: string };

    const res = await app.request(`/api/files/${file_id}/content`, { headers: authHeader });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${file_id}"; filename*=UTF-8''${file_id}`,
    );
  });

  it("serves a file whose name is not ASCII, by run and name, with one header line", async () => {
    // A name any file system accepts, with characters beyond Latin-1: written raw
    // into a header, it cannot even be sent.
    const name = "报告.txt";
    output(name, "fil_mime_cjk_padding_to_32_chars__");

    const res = await app.request(`/api/runs/${RUN_ID}/files/${encodeURIComponent(name)}`, {
      headers: authHeader,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="__.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt`,
    );
  });
});

// ── A fresh link to a run's output file ───────────────────────────────

/** The instant the link tests run at: the route reads the clock to bound a link. */
const LINK_T0 = new Date("2026-10-01T12:00:00.000Z");
const HOUR_MS = 3_600_000;

interface LinkWorld {
  app: ReturnType<typeof createApp>;
  db: MemoryDb;
  /** The object store's presigning, recorded; nothing is reached. */
  presign: ReturnType<typeof vi.fn>;
}

/** An app on `mode`, with an object store that presigns without a network. */
function linkWorld(mode: "flyio" | "local"): LinkWorld {
  const db = new MemoryDb();
  const presign = vi.fn(
    async (key: string, expiresIn: number, _opts?: PresignedDownloadOptions) =>
      `https://objects.example/${encodeURIComponent(key)}?expires=${expiresIn}`,
  );
  if (mode === "local") {
    return { app: createApp(new MemoryStorage(), db, { runtimeMode: "local" }), db, presign };
  }
  const objectStore = {
    put: vi.fn(),
    getPresignedDownloadUrl: presign,
    getPresignedUploadUrl: vi.fn(),
  };
  const app = createApp(new MemoryStorage(), db, {
    runtimeMode: "flyio",
    flyioDeps: {
      flyApi: {} as FlyioRuntimeDeps["flyApi"],
      storage: objectStore as unknown as FlyioRuntimeDeps["storage"],
      runtimeImageTag: "test-runner-image",
      outputsBudget: {} as FlyioRuntimeDeps["outputsBudget"],
    },
  });
  return { app, db, presign };
}

/** A user and an account-wide key of theirs. */
async function accountKey(db: MemoryDb, username: string): Promise<{ id: string; key: string }> {
  const user = await db.createUser({ github_id: `gh-${username}`, username });
  const { key, keyHash, keyPrefix } = generateApiKey();
  await db.createApiKey({ user_id: user.id, key_hash: keyHash, key_prefix: keyPrefix, name: "a" });
  return { id: user.id, key };
}

/** A resource-scoped key of `userId`'s, limited to running agents. */
async function delegatedKey(db: MemoryDb, userId: string): Promise<string> {
  const { key, keyHash, keyPrefix } = generateApiKey();
  await db.createApiKey({
    user_id: userId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: "scoped",
    scopes: ["agent:run"],
    scope_kind: "agents",
    agents: [],
  });
  return key;
}

/** A completed run of `userId`'s whose row lists `names`, with `deadline` as its purge_after. */
async function completedRun(
  db: MemoryDb,
  userId: string,
  id: string,
  names: string[],
  deadline: Date | null,
): Promise<void> {
  await db.createRun({
    id,
    agent_id: null,
    agent_version: "acme/agent@1.0.0",
    user_id: userId,
    status: "running",
  });
  await db.updateRun(id, {
    status: "completed",
    files: names.map((name) => ({ name, size: 3 })),
    completed_at: LINK_T0.toISOString(),
    ...(deadline !== null && { purge_after: deadline.toISOString() }),
  });
}

/** GET the link route; `rawName` goes into the path exactly as given. */
function getLink(world: LinkWorld, key: string, runId: string, rawName: string) {
  return world.app.request(`/api/runs/${runId}/files/${rawName}/link`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

/** The error code of a JSON error body, or null for any other text. */
function codeOf(text: string): string | null {
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
}

/** The error code of a JSON error answer, or null for any other body. */
async function errorCode(res: Response): Promise<string | null> {
  return codeOf(await res.text());
}

describe("Files Routes — a fresh link to a cloud run's output file", () => {
  let world: LinkWorld;
  let owner: { id: string; key: string };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LINK_T0);
    world = linkWorld("flyio");
    owner = await accountKey(world.db, "owner");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a presigned link that downloads as an attachment, and is never cached", async () => {
    await completedRun(
      world.db,
      owner.id,
      "run_fresh",
      ["report.html"],
      new Date(+LINK_T0 + HOUR_MS),
    );

    const res = await getLink(world, owner.key, "run_fresh", "report.html");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const key = runOutputKey("run_fresh", "report.html");
    expect(world.presign.mock.calls).toEqual([
      [key, 900, { contentDisposition: attachmentDisposition("report.html") }],
    ]);
    expect(await res.json()).toEqual({
      url: `https://objects.example/${encodeURIComponent(key)}?expires=900`,
      expires_at: new Date(+LINK_T0 + 900_000).toISOString(),
    });
  });

  it("never hands a link that outlives the run's deadline", async () => {
    await completedRun(world.db, owner.id, "run_soon", ["a.txt"], new Date(+LINK_T0 + 120_000));

    const res = await getLink(world, owner.key, "run_soon", "a.txt");

    expect(res.status).toBe(200);
    expect(world.presign.mock.calls[0]?.[1]).toBe(120);
    expect(((await res.json()) as { expires_at: string }).expires_at).toBe(
      new Date(+LINK_T0 + 120_000).toISOString(),
    );
  });

  it("answers 410 FILE_EXPIRED once the deadline has passed, and presigns nothing more", async () => {
    const deadline = new Date(+LINK_T0 + HOUR_MS);
    await completedRun(world.db, owner.id, "run_late", ["a.txt"], deadline);
    expect((await getLink(world, owner.key, "run_late", "a.txt")).status).toBe(200);

    // Less than a second left, the deadline itself, and past it.
    for (const at of [+deadline - 500, +deadline, +deadline + 1_000]) {
      vi.setSystemTime(at);
      const res = await getLink(world, owner.key, "run_late", "a.txt");
      expect(res.status).toBe(410);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await errorCode(res)).toBe("FILE_EXPIRED");
    }
    expect(world.presign).toHaveBeenCalledTimes(1);
  });

  it("answers 410 FILE_EXPIRED once the purge has deleted the objects, deadline or not", async () => {
    await completedRun(world.db, owner.id, "run_purged", ["a.txt"], new Date(+LINK_T0 + HOUR_MS));
    await world.db.markRunOutputsPurged("run_purged", LINK_T0.toISOString());

    const res = await getLink(world, owner.key, "run_purged", "a.txt");

    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("FILE_EXPIRED");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("answers 410 FILE_EXPIRED for a run whose files carry no deadline", async () => {
    await completedRun(world.db, owner.id, "run_undated", ["a.txt"], null);

    const res = await getLink(world, owner.key, "run_undated", "a.txt");

    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("FILE_EXPIRED");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("answers another account the opaque 404 of a run that does not exist", async () => {
    await completedRun(world.db, owner.id, "run_mine", ["a.txt"], new Date(+LINK_T0 + HOUR_MS));
    const other = await accountKey(world.db, "other");

    const theirs = await getLink(world, other.key, "run_mine", "a.txt");
    const missing = await getLink(world, other.key, "run_nobody", "a.txt");

    expect([theirs.status, missing.status]).toEqual([404, 404]);
    const [theirsBody, missingBody] = [await theirs.text(), await missing.text()];
    expect(codeOf(theirsBody)).toBe("RUN_NOT_FOUND");
    expect(theirsBody.replace("run_mine", "<id>")).toBe(missingBody.replace("run_nobody", "<id>"));
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("refuses a delegated key with 403 KEY_SCOPE_FORBIDDEN, on its owner's own run", async () => {
    await completedRun(world.db, owner.id, "run_scoped", ["a.txt"], new Date(+LINK_T0 + HOUR_MS));
    const scoped = await delegatedKey(world.db, owner.id);

    const res = await getLink(world, scoped, "run_scoped", "a.txt");

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("KEY_SCOPE_FORBIDDEN");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("answers 404 FILE_NOT_FOUND for a name the run does not list", async () => {
    await completedRun(world.db, owner.id, "run_named", ["a.txt"], new Date(+LINK_T0 + HOUR_MS));

    const res = await getLink(world, owner.key, "run_named", "b.txt");

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("FILE_NOT_FOUND");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("answers 401 without credentials", async () => {
    const res = await world.app.request("/api/runs/run_x/files/a.txt/link");
    expect(res.status).toBe(401);
  });
});

describe("Files Routes — a fresh link to a local run's output file", () => {
  let world: LinkWorld;
  let owner: { id: string; key: string };
  let dir: string;

  beforeEach(async () => {
    _clearOutputCacheForTests();
    world = linkWorld("local");
    owner = await accountKey(world.db, "owner");
    dir = join(tmpdir(), `skrun-output-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.txt"), "abc");
  });

  afterEach(() => {
    _clearOutputCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the run-scoped route of this API, which serves the file as an attachment", async () => {
    await completedRun(world.db, owner.id, "run_local", ["report.txt"], null);
    registerOutput("run_local", dir, [{ name: "report.txt", size: 3 }]);

    const res = await getLink(world, owner.key, "run_local", "report.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { url: string; expires_at: string | null };
    expect(body).toEqual({ url: "/api/runs/run_local/files/report.txt", expires_at: null });

    const file = await world.app.request(body.url, {
      headers: { Authorization: `Bearer ${owner.key}` },
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Disposition")).toBe(attachmentDisposition("report.txt"));
    expect(await file.text()).toBe("abc");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("answers 410 FILE_EXPIRED once the run's outputs are no longer kept", async () => {
    await completedRun(world.db, owner.id, "run_gone", ["report.txt"], null);

    const res = await getLink(world, owner.key, "run_gone", "report.txt");

    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("FILE_EXPIRED");
  });

  it("answers another account 404 RUN_NOT_FOUND, and a delegated key 403", async () => {
    await completedRun(world.db, owner.id, "run_local_mine", ["report.txt"], null);
    registerOutput("run_local_mine", dir, [{ name: "report.txt", size: 3 }]);
    const other = await accountKey(world.db, "other");
    const scoped = await delegatedKey(world.db, owner.id);

    const theirs = await getLink(world, other.key, "run_local_mine", "report.txt");
    const delegated = await getLink(world, scoped, "run_local_mine", "report.txt");

    expect(theirs.status).toBe(404);
    expect(await errorCode(theirs)).toBe("RUN_NOT_FOUND");
    expect(delegated.status).toBe(403);
    expect(await errorCode(delegated)).toBe("KEY_SCOPE_FORBIDDEN");
  });
});

// The names a run lists: a file, a file in a directory, and a name that is
// itself percent-encoded text — the one that shows how often the path is decoded.
const LISTED_NAMES = ["a.txt", "d/b.csv", "%41.txt"];

/**
 * Path segments that must not reach any key, each as sent on the wire, with
 * what it tries. None is one of the listed names once the router has decoded
 * it, so each must answer 404 FILE_NOT_FOUND, and nothing may be presigned.
 */
const ADVERSARIAL_SEGMENTS: ReadonlyArray<readonly [string, string]> = [
  ["..%2Fx", "a path up out of the run's outputs"],
  ["%2Fetc%2Fpasswd", "an absolute path"],
  ["a%2F..%2Fa.txt", "a listed name reached through a dot-dot segment"],
  ["%252e%252e%252fx", "a dot-dot path encoded twice"],
  ["A.TXT", "a listed name in another case"],
  ["a.txt%00", "a listed name followed by a NUL byte"],
  ["%41.txt", "a listed name's text decoded one time too many"],
  ["absent.txt", "a name the run does not list"],
];

describe("Files Routes — the cloud link presigns only a name the run lists, exactly", () => {
  let world: LinkWorld;
  let owner: { id: string; key: string };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LINK_T0);
    world = linkWorld("flyio");
    owner = await accountKey(world.db, "owner");
    await completedRun(world.db, owner.id, "run_names", LISTED_NAMES, new Date(+LINK_T0 + HOUR_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Measured, not assumed: the router decodes a path segment exactly once —
  // `%2F` becomes `/`, and `%25` becomes `%` but what follows it stays as text.
  it("decodes the path segment once: an encoded slash names a file in a directory", async () => {
    const inDirectory = await getLink(world, owner.key, "run_names", "d%2Fb.csv");
    const encodedText = await getLink(world, owner.key, "run_names", "%2541.txt");

    expect([inDirectory.status, encodedText.status]).toEqual([200, 200]);
    expect(world.presign.mock.calls.map((call) => call[0])).toEqual([
      "_runs/run_names/outputs/d/b.csv",
      "_runs/run_names/outputs/%41.txt",
    ]);
  });

  it.each(
    ADVERSARIAL_SEGMENTS,
  )("answers 404 FILE_NOT_FOUND to %s (%s), presigning nothing", async (segment) => {
    const res = await getLink(world, owner.key, "run_names", segment);

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("FILE_NOT_FOUND");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("answers 404 to a name the run lists but the safe-name rule refuses", async () => {
    // A row no completion writes: a dot-dot name, put there by hand.
    await completedRun(
      world.db,
      owner.id,
      "run_handwritten",
      ["../x", "a.txt"],
      new Date(+LINK_T0 + HOUR_MS),
    );

    const res = await getLink(world, owner.key, "run_handwritten", "..%2Fx");

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("FILE_NOT_FOUND");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("refuses a listed name with a line break: the output name rule refuses control characters", async () => {
    // A row no completion writes once the upload applies the same rule: put there by hand.
    const name = 'rap"port\r\n报告.html';
    await completedRun(world.db, owner.id, "run_line_break", [name], new Date(+LINK_T0 + HOUR_MS));

    const res = await getLink(world, owner.key, "run_line_break", encodeURIComponent(name));

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("FILE_NOT_FOUND");
    expect(world.presign).not.toHaveBeenCalled();
  });

  it("hands a name with a quote and non-ASCII a disposition on one safe line", async () => {
    // A line break in a name is refused before any disposition is built (the case
    // above); the disposition's own handling of one is tested where it is defined.
    const name = 'rap"port; 报告 é.html';
    await completedRun(world.db, owner.id, "run_odd_name", [name], new Date(+LINK_T0 + HOUR_MS));

    const res = await getLink(world, owner.key, "run_odd_name", encodeURIComponent(name));

    expect(res.status).toBe(200);
    const [key, , opts] = world.presign.mock.calls[0] ?? [];
    expect(key).toBe(runOutputKey("run_odd_name", name));
    expect(opts).toEqual({ contentDisposition: attachmentDisposition(name) });
    const disposition = (opts as PresignedDownloadOptions).contentDisposition ?? "";
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(disposition).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''[^"]*$/);
  });
});

describe("Files Routes — the local link names only a file the run lists, exactly", () => {
  let world: LinkWorld;
  let owner: { id: string; key: string };
  let dir: string;

  beforeEach(async () => {
    _clearOutputCacheForTests();
    world = linkWorld("local");
    owner = await accountKey(world.db, "owner");
    dir = join(tmpdir(), `skrun-output-names-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "d"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "d", "b.csv"), "b");
    await completedRun(world.db, owner.id, "run_local_names", LISTED_NAMES, null);
    registerOutput("run_local_names", dir, []);
  });

  afterEach(() => {
    _clearOutputCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the route of a file in a directory, encoded", async () => {
    const res = await getLink(world, owner.key, "run_local_names", "d%2Fb.csv");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe(
      "/api/runs/run_local_names/files/d%2Fb.csv",
    );
  });

  it.each(
    ADVERSARIAL_SEGMENTS,
  )("answers 404 FILE_NOT_FOUND to %s (%s), with no url", async (segment) => {
    const res = await getLink(world, owner.key, "run_local_names", segment);
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(codeOf(text)).toBe("FILE_NOT_FOUND");
    expect(text).not.toContain('"url"');
  });
});

// A run's output files, by run and name: a full-access credential reads those of
// every run of its account; any other key that is not delegated, only those of
// the runs it launched itself. A run it did not launch answers the same opaque
// 404 as a run that does not exist. A delegated key keeps its 403.
describe("Files Routes — a run's files are read by the key that launched the run", () => {
  let world: LinkWorld;
  let ownerId: string;
  let dir: string;

  async function mint(scope_kind: "account" | "agents", operations: string[]) {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const row = await world.db.createApiKey({
      user_id: ownerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
      scopes: operations,
      scope_kind,
      agents: [],
    });
    return { key, id: row.id };
  }

  /** A completed local run of the owner's, launched by `keyId` (null: a session). */
  async function runOf(id: string, keyId: string | null): Promise<void> {
    await world.db.createRun({
      id,
      agent_id: null,
      agent_version: "acme/agent@1.0.0",
      user_id: ownerId,
      api_key_id: keyId,
      status: "running",
    });
    await world.db.updateRun(id, {
      status: "completed",
      files: [{ name: "report.txt", size: 3 }],
      completed_at: new Date().toISOString(),
    });
    registerOutput(id, dir, [{ name: "report.txt", size: 3 }]);
  }

  function read(headers: Record<string, string>, runId: string) {
    return world.app.request(`/api/runs/${runId}/files/report.txt`, { headers });
  }
  function link(headers: Record<string, string>, runId: string) {
    return world.app.request(`/api/runs/${runId}/files/report.txt/link`, { headers });
  }
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  beforeEach(async () => {
    _clearOutputCacheForTests();
    world = linkWorld("local");
    ownerId = (await world.db.createUser({ github_id: "gh-owner", username: "owner" })).id;
    dir = join(
      tmpdir(),
      `skrun-output-caller-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.txt"), "abc");
  });

  afterEach(() => {
    _clearOutputCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["an account key that may only run agents", ["agent:run"]],
    ["an account key with no operation", []],
  ])("%s reads the file of the run it launched, by both routes", async (_label, operations) => {
    const mine = await mint("account", operations);
    await runOf("run_mine", mine.id);

    const file = await read(bearer(mine.key), "run_mine");
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("abc");
    const res = await link(bearer(mine.key), "run_mine");
    expect(res.status).toBe(200);
  });

  it.each([
    ["the file route", "an account key that may only run agents", ["agent:run"]],
    ["the file route", "an account key with no operation", []],
    ["the link route", "an account key that may only run agents", ["agent:run"]],
    ["the link route", "an account key with no operation", []],
  ])("%s answers %s the opaque 404 on a run another credential launched", async (route, _label, operations) => {
    const fetchIt = route === "the file route" ? read : link;
    const mine = await mint("account", operations);
    const other = await mint("account", ["agent:run"]);
    await runOf("run_other_key", other.id);
    await runOf("run_session", null);

    // A run of another key, a run of a session, and a run that does not exist:
    // byte for byte the same answer.
    const bodies: string[] = [];
    for (const runId of ["run_other_key", "run_session", "run_nobody"]) {
      const res = await fetchIt(bearer(mine.key), runId);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(codeOf(text)).toBe("RUN_NOT_FOUND");
      bodies.push(text.replace(runId, "<id>"));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("a session and a full account key read the files of every run of the account", async () => {
    const reduced = await mint("account", ["agent:run"]);
    const full = await mint("account", ["agent:run", "agent:push", "agent:verify"]);
    await runOf("run_reduced", reduced.id);
    await runOf("run_session", null);
    const cookie = { Cookie: `${sessionCookieName()}=${await createSession(world.db, ownerId)}` };

    for (const headers of [cookie, bearer(full.key)]) {
      for (const runId of ["run_reduced", "run_session"]) {
        const file = await read(headers, runId);
        expect(file.status).toBe(200);
        expect(await file.text()).toBe("abc");
        expect((await link(headers, runId)).status).toBe(200);
      }
    }
  });

  it("the dev token reads the files of its account's runs", async () => {
    ownerId = (
      (await (await world.app.request("/api/me", { headers: bearer("dev-token") })).json()) as {
        id: string;
      }
    ).id;
    const reduced = await mint("account", ["agent:run"]);
    await runOf("run_dev", reduced.id);

    const file = await read(bearer("dev-token"), "run_dev");
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("abc");
    expect((await link(bearer("dev-token"), "run_dev")).status).toBe(200);
  });

  it("a delegated key keeps its 403, on the run it launched itself", async () => {
    const delegated = await mint("agents", ["agent:run"]);
    await runOf("run_delegated", delegated.id);

    for (const res of [
      await read(bearer(delegated.key), "run_delegated"),
      await link(bearer(delegated.key), "run_delegated"),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("KEY_SCOPE_FORBIDDEN");
    }
  });
});

// Files by id: a full-access credential uses every file of its account; any
// other key — delegated included — only the outputs of the runs it launched and
// the files it uploaded. Two clients of one account must not read each other's.
describe("Files Routes — a key reads only the files of its own runs and uploads", () => {
  let world: LinkWorld;
  let ownerId: string;
  let dir: string;
  let clientA: { key: string; id: string };
  let clientB: { key: string; id: string };

  async function mint(scope_kind: "account" | "agents", operations: string[]) {
    const { key, keyHash, keyPrefix } = generateApiKey();
    const row = await world.db.createApiKey({
      user_id: ownerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
      scopes: operations,
      scope_kind,
      agents: [],
    });
    return { key, id: row.id };
  }
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  /** A completed local run launched by `keyId`, with one output file; returns its file id. */
  async function outputOf(runId: string, keyId: string): Promise<string> {
    await world.db.createRun({
      id: runId,
      agent_id: null,
      agent_version: "acme/agent@1.0.0",
      user_id: ownerId,
      api_key_id: keyId,
      status: "completed",
    });
    const fileId = `fil_${runId.padEnd(32, "0")}`;
    registerOutput(runId, dir, [{ name: "report.txt", size: 3, file_id: fileId }]);
    return fileId;
  }

  /** Upload one file with `headers`; returns its file id. */
  async function upload(headers: Record<string, string>): Promise<string> {
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from("upload")], { type: "image/png" }));
    const res = await world.app.request("/api/files", { method: "POST", headers, body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { file_id: string }).file_id;
  }

  beforeEach(async () => {
    inputCache.clear();
    _clearOutputCacheForTests();
    world = linkWorld("local");
    ownerId = (await world.db.createUser({ github_id: "gh-owner", username: "owner" })).id;
    dir = join(tmpdir(), `skrun-output-byid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.txt"), "abc");
    clientA = await mint("agents", ["agent:run"]);
    clientB = await mint("agents", ["agent:run"]);
  });

  afterEach(() => {
    inputCache.clear();
    _clearOutputCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a delegated client reads its own output and upload, by metadata and content", async () => {
    const output = await outputOf("run_a", clientA.id);
    const uploaded = await upload(bearer(clientA.key));

    for (const id of [output, uploaded]) {
      expect(
        (await world.app.request(`/api/files/${id}`, { headers: bearer(clientA.key) })).status,
      ).toBe(200);
      const content = await world.app.request(`/api/files/${id}/content`, {
        headers: bearer(clientA.key),
      });
      expect(content.status).toBe(200);
    }
  });

  it.each([
    ["metadata", ""],
    ["content", "/content"],
  ])("a delegated client is refused another client's output and upload (%s)", async (_label, suffix) => {
    const output = await outputOf("run_b", clientB.id);
    const uploaded = await upload(bearer(clientB.key));

    for (const id of [output, uploaded]) {
      const res = await world.app.request(`/api/files/${id}${suffix}`, {
        headers: bearer(clientA.key),
      });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("FORBIDDEN");
    }
  });

  it("a reduced account key is refused another key's output and upload, and reads its own", async () => {
    const reduced = await mint("account", ["agent:run"]);
    const theirs = [await outputOf("run_b", clientB.id), await upload(bearer(clientB.key))];
    const mine = [await outputOf("run_r", reduced.id), await upload(bearer(reduced.key))];

    for (const id of theirs) {
      expect(
        (await world.app.request(`/api/files/${id}/content`, { headers: bearer(reduced.key) }))
          .status,
      ).toBe(403);
    }
    for (const id of mine) {
      expect(
        (await world.app.request(`/api/files/${id}/content`, { headers: bearer(reduced.key) }))
          .status,
      ).toBe(200);
    }
  });

  it("a session and a full account key read every client's output and upload", async () => {
    const full = await mint("account", ["agent:run", "agent:push", "agent:verify"]);
    const ids = [
      await outputOf("run_a", clientA.id),
      await outputOf("run_b", clientB.id),
      await upload(bearer(clientA.key)),
      await upload(bearer(clientB.key)),
    ];
    const cookie = { Cookie: `${sessionCookieName()}=${await createSession(world.db, ownerId)}` };

    for (const headers of [cookie, bearer(full.key)]) {
      for (const id of ids) {
        const res = await world.app.request(`/api/files/${id}/content`, { headers });
        expect(res.status).toBe(200);
      }
    }
  });

  it("a session's upload is used by a full-access credential, not by a client", async () => {
    const cookie = { Cookie: `${sessionCookieName()}=${await createSession(world.db, ownerId)}` };
    // A browser's upload: same origin, as the CSRF guard asks of a cookie.
    const uploaded = await upload({ ...cookie, Origin: "http://localhost" });

    expect((await world.app.request(`/api/files/${uploaded}`, { headers: cookie })).status).toBe(
      200,
    );
    expect(
      (await world.app.request(`/api/files/${uploaded}`, { headers: bearer(clientA.key) })).status,
    ).toBe(403);
  });

  it("a delegated client deletes its own upload, and not another client's", async () => {
    const theirs = await upload(bearer(clientB.key));
    const mine = await upload(bearer(clientA.key));

    const refused = await world.app.request(`/api/files/${theirs}`, {
      method: "DELETE",
      headers: bearer(clientA.key),
    });
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("FORBIDDEN");
    // Still there for the client that uploaded it.
    expect(
      (await world.app.request(`/api/files/${theirs}`, { headers: bearer(clientB.key) })).status,
    ).toBe(200);

    const deleted = await world.app.request(`/api/files/${mine}`, {
      method: "DELETE",
      headers: bearer(clientA.key),
    });
    expect(deleted.status).toBe(204);
  });
});

// An account holds at most its plan's number of live uploads, counted in this
// process: an upload counts until it expires or is deleted, whether or not the
// cache has dropped it yet. The next one is refused 429
// INPUT_FILES_LIMIT_REACHED — before its body is read, and again just before
// it would be kept — and told to wait until the account holds fewer: until its
// oldest upload expires, or, past its number (its plan lowered), until enough
// of them have. The account's numbers go to a master credential only.
describe("Files Routes — an account's live uploads, bounded by its plan", () => {
  const T0 = Date.parse("2026-10-18T12:00:00.000Z");
  /** How long an upload lives: the default retention, which these tests leave as it is. */
  const WINDOW_MS = 86_400_000;
  const CHUNK = 64 * 1024;
  const MIB = 1024 * 1024;
  const dev = { Authorization: "Bearer dev-token" };
  let db: MemoryDb;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    inputCache.clear();
    logInfoSpy.mockClear();
    logWarnSpy.mockClear();
    db = new MemoryDb();
  });

  afterEach(() => {
    inputCache.clear();
    vi.useRealTimers();
  });

  function appWith(env: QuotaEnv) {
    return createApp(new MemoryStorage(), db, { quotaConfig: parseQuotaEnv(env) });
  }
  type App = ReturnType<typeof appWith>;

  /** Upload one small file with `headers`, and what the server answered. */
  async function upload(app: App, headers: Record<string, string> = dev) {
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from("upload")], { type: "image/png" }));
    const res = await app.request("/api/files", { method: "POST", headers, body: fd });
    return answerOf(res);
  }

  async function answerOf(res: Response) {
    const body = (await res.json()) as {
      file_id?: string;
      error?: { code: string; message: string };
    };
    return {
      status: res.status,
      code: body.error?.code,
      message: body.error?.message,
      retryAfter: res.headers.get("Retry-After"),
      fileId: body.file_id,
    };
  }

  /**
   * An upload of `fileBytes` whose multipart body the server pulls in 64 KiB
   * chunks, without a Content-Length. `pulls()` counts the chunks asked for —
   * one at once: the reserve a stream fills when it is built. With `holdAt`,
   * that pull waits for `release()`, and `reading` settles as it starts: by
   * then the route is reading the body.
   */
  async function streamedUpload(fileBytes: number, holdAt?: number) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(fileBytes)], { type: "image/png" }));
    const encoded = new Response(fd);
    const contentType = encoded.headers.get("Content-Type") ?? "";
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let sent = 0;
    let pulls = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === holdAt) {
          started();
          await released;
        }
        if (sent >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(sent, sent + CHUNK));
        sent += CHUNK;
      },
    });
    return { contentType, stream, pulls: () => pulls, reading, release };
  }

  function postStreamed(
    app: App,
    body: Awaited<ReturnType<typeof streamedUpload>>,
    headers: Record<string, string> = dev,
  ) {
    return app.request("/api/files", {
      method: "POST",
      headers: { ...headers, "Content-Type": body.contentType },
      body: body.stream,
      duplex: "half",
    } as RequestInit);
  }

  /** An account with `plan`: its master key, a key reduced to running, and one delegated to no agent. */
  async function account(username: string, plan?: string) {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    if (plan) await db.updateUser(user.id, { plan });
    const mint = async (scope?: { scopes: string[]; scope_kind: "account" | "agents" }) => {
      const k = generateApiKey();
      await db.createApiKey({
        user_id: user.id,
        key_hash: k.keyHash,
        key_prefix: k.keyPrefix,
        name: "k",
        ...(scope ? { ...scope, agents: [] } : {}),
      });
      return { Authorization: `Bearer ${k.key}` };
    };
    return {
      id: user.id,
      master: await mint(),
      reduced: await mint({ scopes: ["agent:run"], scope_kind: "account" }),
      delegated: await mint({ scopes: ["agent:run"], scope_kind: "agents" }),
    };
  }

  const refusals = () =>
    logInfoSpy.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "quota_refused");
  const unknownPlanLines = () =>
    logWarnSpy.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields?.event === "quota_plan_unknown");

  it("past its plan's number, an account's next upload is refused 429 INPUT_FILES_LIMIT_REACHED, told to wait until its oldest expires; nothing of it kept, one line", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "2" });
    expect((await upload(app)).status).toBe(201);
    vi.setSystemTime(T0 + 10_000);
    expect((await upload(app)).status).toBe(201);
    vi.setSystemTime(T0 + 1_000_000);

    expect(await upload(app)).toEqual({
      status: 429,
      code: "INPUT_FILES_LIMIT_REACHED",
      message:
        "2 live uploads on this account; your plan's limit is 2. The oldest expires at 2026-10-19T12:00:00.000Z; an upload deleted (DELETE /api/files/:id) frees its place sooner.",
      retryAfter: String((WINDOW_MS - 1_000_000) / 1000),
      fileId: undefined,
    });
    expect(inputCache.size).toBe(2);
    expect(refusals()).toEqual([
      expect.objectContaining({ bound: "input_files", plan: "free", user_id: expect.any(String) }),
    ]);
  });

  it("an upload stops counting at its expiry, before any sweep drops it from the cache", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "1" });
    expect((await upload(app)).status).toBe(201);
    vi.setSystemTime(T0 + WINDOW_MS - 1_000);
    expect(await upload(app)).toMatchObject({ status: 429, retryAfter: "1" });

    vi.setSystemTime(T0 + WINDOW_MS);
    expect((await upload(app)).status).toBe(201);
    // The expired upload is still in the cache: nothing has swept it.
    expect(inputCache.size).toBe(2);
  });

  it("an account holding more than its plan's number — its plan lowered — is told to wait until it holds fewer, and an upload passes then", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "free=1,pro=3" });
    const alice = await account("alice", "pro");
    for (const hour of [0, 1, 2]) {
      vi.setSystemTime(T0 + hour * 3_600_000);
      expect((await upload(app, alice.master)).status).toBe(201);
    }
    await db.updateUser(alice.id, { plan: "free" });
    vi.setSystemTime(T0 + 3 * 3_600_000);

    // Three live, one allowed: a place frees once the three have expired, the
    // last at 2 h + 24 h — not when the oldest does.
    expect(await upload(app, alice.master)).toEqual({
      status: 429,
      code: "INPUT_FILES_LIMIT_REACHED",
      message:
        "3 live uploads on this account; your plan's limit is 1. A place frees at 2026-10-19T14:00:00.000Z, once the oldest 3 have expired; 3 uploads deleted (DELETE /api/files/:id) free one sooner.",
      retryAfter: String(23 * 3600),
      fileId: undefined,
    });
    expect(await upload(app, alice.delegated)).toMatchObject({
      status: 429,
      message: ACCOUNT_LIMIT_MESSAGE,
      retryAfter: String(23 * 3600),
    });

    vi.setSystemTime(T0 + 26 * 3_600_000 - 1_000);
    expect(await upload(app, alice.master)).toMatchObject({ status: 429, retryAfter: "1" });
    vi.setSystemTime(T0 + 26 * 3_600_000);
    expect((await upload(app, alice.master)).status).toBe(201);
  });

  it("uploads leave in the order they expire, not the order they were made: the clock stepped back between two", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "free=1,pro=2" });
    const bob = await account("bob", "pro");
    vi.setSystemTime(T0 + 2 * 3_600_000);
    expect((await upload(app, bob.master)).status).toBe(201);
    // The clock stepped back an hour: the second upload expires first.
    vi.setSystemTime(T0 + 3_600_000);
    expect((await upload(app, bob.master)).status).toBe(201);
    await db.updateUser(bob.id, { plan: "free" });

    // Two live, one allowed: a place frees once both have expired — at the
    // first upload's deadline, 2 h + 24 h, the later of the two.
    expect(await upload(app, bob.master)).toMatchObject({
      status: 429,
      retryAfter: String(25 * 3600),
    });
  });

  it("a deleted upload frees its place at once", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "1" });
    const first = await upload(app);
    expect(first.status).toBe(201);
    expect((await upload(app)).status).toBe(429);

    const deleted = await app.request(`/api/files/${first.fileId}`, {
      method: "DELETE",
      headers: dev,
    });
    expect(deleted.status).toBe(204);
    expect((await upload(app)).status).toBe(201);
  });

  it("another account's uploads take none of its places", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "1" });
    const bob = await account("bob");
    expect((await upload(app)).status).toBe(201);
    expect((await upload(app)).status).toBe(429);
    expect((await upload(app, bob.master)).status).toBe(201);
  });

  it("an account at its number is refused before the server reads the upload's body", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "1" });
    expect((await upload(app)).status).toBe(201);

    const body = await streamedUpload(MIB);
    const res = await postStreamed(app, body);
    expect((await answerOf(res)).code).toBe("INPUT_FILES_LIMIT_REACHED");
    // One chunk: the reserve the stream filled when it was built. Nothing was
    // pulled on the server's side.
    expect(body.pulls()).toBe(1);
  });

  it("two uploads in flight at once cannot both take the last place", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "1" });
    const slow = await streamedUpload(MIB, 4);
    const pending = postStreamed(app, slow);
    // Its body is being read: it found the account with room before its body.
    await slow.reading;
    expect((await upload(app)).status).toBe(201);

    slow.release();
    expect(await answerOf(await pending)).toMatchObject({
      status: 429,
      code: "INPUT_FILES_LIMIT_REACHED",
    });
    expect(inputCache.size).toBe(1);
  });

  it("the account's numbers go to a master credential only; a reduced and a delegated key are told the bound, with the same wait", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "1" });
    const alice = await account("alice");
    // An upload made by any key of the account counts for the account.
    expect((await upload(app, alice.reduced)).status).toBe(201);
    vi.setSystemTime(T0 + 1_000_000);

    const seen = {
      master: await upload(app, alice.master),
      reduced: await upload(app, alice.reduced),
      delegated: await upload(app, alice.delegated),
    };
    const others = {
      status: 429,
      code: "INPUT_FILES_LIMIT_REACHED",
      message: ACCOUNT_LIMIT_MESSAGE,
      retryAfter: "85400",
      fileId: undefined,
    };
    expect(seen).toEqual({
      master: {
        ...others,
        message:
          "1 live upload on this account; your plan's limit is 1. The oldest expires at 2026-10-19T12:00:00.000Z; an upload deleted (DELETE /api/files/:id) frees its place sooner.",
      },
      reduced: others,
      delegated: others,
    });
    expect(refusals()).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ bound: "input_files", plan: "free", user_id: alice.id }),
      ),
    );
  });

  it("the number of the caller's plan applies: its own, free's for a plan no setting names, with one line each time", async () => {
    const app = appWith({ SKRUN_QUOTA_INPUT_FILES: "free=1,team=2" });
    const team = await account("team-account", "team");
    const ghost = await account("ghost-account", "ghost");

    expect((await upload(app, team.master)).status).toBe(201);
    expect((await upload(app, team.master)).status).toBe(201);
    expect((await upload(app, team.master)).status).toBe(429);
    expect(unknownPlanLines()).toEqual([]);

    expect((await upload(app, ghost.master)).status).toBe(201);
    expect((await upload(app, ghost.master)).status).toBe(429);
    expect(unknownPlanLines()).toEqual([
      expect.objectContaining({ plan: "ghost" }),
      expect.objectContaining({ plan: "ghost" }),
    ]);
  });

  it("with no setting, uploads are not counted, and no plan is read — not even one no setting names", async () => {
    const app = appWith({ SKRUN_QUOTA_CONCURRENT_RUNS: "free=2,pro=5" });
    const ghost = await account("ghost-account", "ghost");
    for (let i = 0; i < 3; i++) {
      expect((await upload(app, ghost.master)).status).toBe(201);
    }
    expect(unknownPlanLines()).toEqual([]);
    expect(refusals()).toEqual([]);
  });
});
