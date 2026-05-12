import type { FileInputField } from "@skrun-dev/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INLINE_BASE64_MAX_BYTES,
  type ResolveContext,
  ResolveError,
  resolveInput,
} from "./parts.js";

function makeFileSchema(overrides: Partial<FileInputField> = {}): FileInputField {
  return {
    name: "photo",
    type: "file",
    media: "image",
    max_count: 1,
    required: true,
    ...overrides,
  } as FileInputField;
}

function makeCtx(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    fetchInputFile: vi.fn().mockResolvedValue(null),
    allowedHosts: [],
    ...overrides,
  };
}

describe("resolveInput", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("VT-12 micro: resolves a base64 inline data part", async () => {
    const schema = makeFileSchema();
    const ctx = makeCtx();
    const data = Buffer.from("PNG-fake-bytes").toString("base64");
    const result = await resolveInput(
      { photo: [{ type: "file", source: "data", media_type: "image/png", data }] },
      [schema],
      ctx,
    );
    const parts = result.get("photo");
    expect(parts).toHaveLength(1);
    expect(parts?.[0]?.kind).toBe("image");
    expect(parts?.[0]?.media_type).toBe("image/png");
    if (parts?.[0]?.kind === "image") {
      expect(Buffer.from(parts[0].bytes).toString()).toBe("PNG-fake-bytes");
    }
  });

  it("VT-13 micro: throws INLINE_TOO_LARGE when base64 decodes to > 4MB", async () => {
    const schema = makeFileSchema();
    const ctx = makeCtx();
    const oversize = Buffer.alloc(INLINE_BASE64_MAX_BYTES + 1).toString("base64");
    await expect(
      resolveInput(
        {
          photo: [{ type: "file", source: "data", media_type: "image/png", data: oversize }],
        },
        [schema],
        ctx,
      ),
    ).rejects.toMatchObject({ code: "INLINE_TOO_LARGE" });
  });

  it("VT-11 micro: resolves source: 'id' via fetchInputFile callback", async () => {
    const schema = makeFileSchema();
    const fetchMock = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      media_type: "image/png",
    });
    const ctx = makeCtx({ fetchInputFile: fetchMock });
    const result = await resolveInput(
      { photo: [{ type: "file", source: "id", file_id: "fil_abc" }] },
      [schema],
      ctx,
    );
    expect(fetchMock).toHaveBeenCalledWith("fil_abc");
    const parts = result.get("photo");
    expect(parts?.[0]?.media_type).toBe("image/png");
  });

  it("throws FILE_NOT_FOUND when source: 'id' returns null", async () => {
    const schema = makeFileSchema();
    const ctx = makeCtx();
    await expect(
      resolveInput(
        { photo: [{ type: "file", source: "id", file_id: "fil_unknown" }] },
        [schema],
        ctx,
      ),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("resolves source: 'url' when host is in allowed_hosts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const schema = makeFileSchema();
    const ctx = makeCtx({ allowedHosts: ["example.com"] });
    const result = await resolveInput(
      { photo: [{ type: "file", source: "url", url: "https://example.com/img.jpg" }] },
      [schema],
      ctx,
    );
    const parts = result.get("photo");
    expect(parts?.[0]?.media_type).toBe("image/jpeg");
    if (parts?.[0]?.kind === "image") {
      expect(Array.from(parts[0].bytes)).toEqual([1, 2, 3]);
    }
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/img.jpg");
  });

  it("VT-15 micro: throws URL_NOT_ALLOWED when host outside allowlist", async () => {
    const schema = makeFileSchema();
    const ctx = makeCtx({ allowedHosts: ["example.com"] });
    await expect(
      resolveInput(
        { photo: [{ type: "file", source: "url", url: "https://evil.com/x.jpg" }] },
        [schema],
        ctx,
      ),
    ).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });

  it("throws URL_FETCH_FAILED when fetch returns non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const schema = makeFileSchema();
    const ctx = makeCtx({ allowedHosts: ["example.com"] });
    await expect(
      resolveInput(
        { photo: [{ type: "file", source: "url", url: "https://example.com/x.jpg" }] },
        [schema],
        ctx,
      ),
    ).rejects.toMatchObject({ code: "URL_FETCH_FAILED" });
  });

  it("RT-6 micro: returns empty map when no file inputs declared", async () => {
    const ctx = makeCtx();
    const result = await resolveInput({ question: "hi" }, [], ctx);
    expect(result.size).toBe(0);
  });

  it("resolves multiple parts when max_count > 1", async () => {
    const schema = makeFileSchema({ max_count: 5 });
    const ctx = makeCtx();
    const data = Buffer.from("img").toString("base64");
    const result = await resolveInput(
      {
        photo: [
          { type: "file", source: "data", media_type: "image/png", data },
          { type: "file", source: "data", media_type: "image/png", data },
          { type: "file", source: "data", media_type: "image/png", data },
        ],
      },
      [schema],
      ctx,
    );
    expect(result.get("photo")).toHaveLength(3);
  });

  it("throws MAX_COUNT_EXCEEDED when payload has more items than max_count", async () => {
    const schema = makeFileSchema({ max_count: 2 });
    const ctx = makeCtx();
    const data = Buffer.from("img").toString("base64");
    await expect(
      resolveInput(
        {
          photo: [
            { type: "file", source: "data", media_type: "image/png", data },
            { type: "file", source: "data", media_type: "image/png", data },
            { type: "file", source: "data", media_type: "image/png", data },
          ],
        },
        [schema],
        ctx,
      ),
    ).rejects.toMatchObject({ code: "MAX_COUNT_EXCEEDED" });
  });

  it("throws REQUIRED_INPUT_MISSING for required file input not provided", async () => {
    const schema = makeFileSchema({ required: true });
    const ctx = makeCtx();
    await expect(resolveInput({}, [schema], ctx)).rejects.toMatchObject({
      code: "REQUIRED_INPUT_MISSING",
    });
  });

  it("skips optional file input when not provided", async () => {
    const schema = makeFileSchema({ required: false });
    const ctx = makeCtx();
    const result = await resolveInput({}, [schema], ctx);
    expect(result.size).toBe(0);
  });

  it("ResolveError exposes a code property", () => {
    const err = new ResolveError("MY_CODE", "msg");
    expect(err.code).toBe("MY_CODE");
    expect(err.name).toBe("ResolveError");
  });

  it("returns 'document' kind for media: document", async () => {
    const schema = makeFileSchema({ media: "document" });
    const ctx = makeCtx();
    const data = Buffer.from("PDF-fake").toString("base64");
    const result = await resolveInput(
      {
        photo: [{ type: "file", source: "data", media_type: "application/pdf", data }],
      },
      [schema],
      ctx,
    );
    expect(result.get("photo")?.[0]?.kind).toBe("document");
  });

  it("returns 'audio' kind for media: audio", async () => {
    const schema = makeFileSchema({ media: "audio" });
    const ctx = makeCtx();
    const data = Buffer.from("WAV-fake").toString("base64");
    const result = await resolveInput(
      {
        photo: [{ type: "file", source: "data", media_type: "audio/wav", data }],
      },
      [schema],
      ctx,
    );
    expect(result.get("photo")?.[0]?.kind).toBe("audio");
  });
});
