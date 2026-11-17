import type { FileInputField } from "@skrun-dev/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrfBlockedError, safeFetch } from "../security/safe-fetch.js";
import {
  INLINE_BASE64_MAX_BYTES,
  type ResolveContext,
  ResolveError,
  resolveInput,
} from "./parts.js";

// safeFetch (the SSRF guard) is exercised in security/safe-fetch.test.ts; here we
// mock it so the url-source path is testable without a real network call.
vi.mock("../security/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});
const safeFetchMock = vi.mocked(safeFetch);

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
    safeFetchMock.mockReset();
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
    safeFetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }) as unknown as Awaited<ReturnType<typeof safeFetch>>,
    );

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
    // The agent's list goes to the guard too: it holds every connection of the
    // fetch to it, so a listed host cannot redirect the fetch off the list.
    expect(safeFetchMock).toHaveBeenCalledWith(
      "https://example.com/img.jpg",
      undefined,
      expect.objectContaining({ timeoutMs: expect.any(Number), allowedHosts: ["example.com"] }),
    );
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

  it("throws URL_FETCH_FAILED when the fetch returns non-2xx", async () => {
    safeFetchMock.mockResolvedValue(
      new Response(null, { status: 500 }) as unknown as Awaited<ReturnType<typeof safeFetch>>,
    );
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

  it("throws URL_NOT_ALLOWED when safeFetch blocks a host that resolves private, the address apart", async () => {
    // safeFetch rejects with SsrfBlockedError carried as the fetch error's cause.
    const resolution = { host: "x.example.com", address: "127.0.0.1" };
    const blocked = Object.assign(new TypeError("fetch failed"), {
      cause: new SsrfBlockedError(
        "Blocked 'x.example.com': resolves to a private/reserved address",
        resolution,
      ),
    });
    safeFetchMock.mockRejectedValue(blocked);
    const schema = makeFileSchema();
    const ctx = makeCtx({ allowedHosts: ["*"] });
    const err = await resolveInput(
      { photo: [{ type: "file", source: "url", url: "https://x.example.com/x.jpg" }] },
      [schema],
      ctx,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect(err).toMatchObject({
      code: "URL_NOT_ALLOWED",
      message: "Blocked 'x.example.com': resolves to a private/reserved address",
      privateResolution: resolution,
    });
  });

  it("tells the caller the host a name was refused for, never the address it resolves to — through the real guard", async () => {
    // The guard itself, on a resolver that answers a private address for any
    // name: refused at the lookup, before any socket opens.
    const actual = await vi.importActual<typeof import("../security/safe-fetch.js")>(
      "../security/safe-fetch.js",
    );
    safeFetchMock.mockImplementation((url, init, opts) =>
      actual.safeFetch(url, init, {
        ...opts,
        resolver: async () => [{ address: "10.20.30.40", family: 4 }],
      }),
    );
    const err = await resolveInput(
      { photo: [{ type: "file", source: "url", url: "https://intranet.example.com/a.jpg?k=v" }] },
      [makeFileSchema()],
      makeCtx({ allowedHosts: ["*"] }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    const refused = err as ResolveError;
    expect(refused.code).toBe("URL_NOT_ALLOWED");
    expect(refused.message).toBe(
      "Blocked 'intranet.example.com': resolves to a private/reserved address",
    );
    expect(refused.message).not.toContain("10.20.30.40");
    expect(refused.privateResolution).toEqual({
      host: "intranet.example.com",
      address: "10.20.30.40",
    });
  });

  it("throws URL_NOT_ALLOWED, naming the host, when the guard refuses a redirect hop", async () => {
    // What safeFetch rejects with when an allowed host redirects off the list.
    const blocked = Object.assign(new TypeError("fetch failed"), {
      cause: new SsrfBlockedError("Blocked 'internal.example': not in the allowed hosts"),
    });
    safeFetchMock.mockRejectedValue(blocked);
    const schema = makeFileSchema();
    const ctx = makeCtx({ allowedHosts: ["example.com"] });
    await expect(
      resolveInput(
        { photo: [{ type: "file", source: "url", url: "https://example.com/x.jpg" }] },
        [schema],
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "URL_NOT_ALLOWED",
      message: "Blocked 'internal.example': not in the allowed hosts",
    });
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

  it.each([
    ["absent", {}],
    ["null", { photo: null }],
    ["an empty list", { photo: [] }],
  ])("refuses a required file input that is %s with MISSING_INPUT, in the words the check of the declared inputs gives", async (_label, input) => {
    const refused = await resolveInput(
      input,
      [makeFileSchema({ required: true })],
      makeCtx(),
    ).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ResolveError);
    expect(refused).toMatchObject({
      code: "MISSING_INPUT",
      message: "Missing required input: photo",
    });
  });

  it.each([
    ["absent", {}],
    ["null", { photo: null }],
    ["an empty list", { photo: [] }],
  ])("leaves an optional file input that is %s out of the resolved inputs: the run goes ahead without it", async (_label, input) => {
    const result = await resolveInput(input, [makeFileSchema({ required: false })], makeCtx());
    expect(result.has("photo")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("resolves one descriptor alone, not in a list, to one part", async () => {
    const data = Buffer.from("img").toString("base64");
    const result = await resolveInput(
      { photo: { type: "file", source: "data", media_type: "image/png", data } },
      [makeFileSchema()],
      makeCtx(),
    );
    expect(result.get("photo")).toHaveLength(1);
  });

  it("refuses an element that is not a file source with INVALID_INPUT_TYPE, naming the field and the element, never the value", async () => {
    const schema = makeFileSchema({ max_count: 2 });
    const ctx = makeCtx();
    const png = { type: "file", source: "data", media_type: "image/png", data: "aGk=" };

    const alone = await resolveInput({ photo: 5 }, [schema], ctx).catch((err: unknown) => err);
    expect(alone).toBeInstanceOf(ResolveError);
    expect(alone).toMatchObject({
      code: "INVALID_INPUT_TYPE",
      message:
        "Input 'photo' is not a file source (Invalid input: expected object, received number)",
    });

    const second = await resolveInput(
      { photo: [png, { type: "file", source: "url", url: "secret-7f3a" }] },
      [schema],
      ctx,
    ).catch((err: unknown) => err);
    expect(second).toBeInstanceOf(ResolveError);
    expect(second).toMatchObject({
      code: "INVALID_INPUT_TYPE",
      message: "Input 'photo' item 1 is not a file source (url: Invalid URL)",
    });
  });

  it("skips optional file input when not provided", async () => {
    const schema = makeFileSchema({ required: false });
    const ctx = makeCtx();
    const result = await resolveInput({}, [schema], ctx);
    expect(result.size).toBe(0);
  });

  it("skips an optional file input named toString that the input does not carry as a field of its own: the prototype's is none of its inputs", async () => {
    const schema = makeFileSchema({ name: "toString", required: false });
    await expect(resolveInput({}, [schema], makeCtx())).resolves.toEqual(new Map());
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
