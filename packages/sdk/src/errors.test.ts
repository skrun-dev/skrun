import { describe, expect, it } from "vitest";
import { SkrunApiError, SkrunFileUploadError, SkrunNotVerifiedError } from "./errors.js";

describe("SkrunApiError", () => {
  it("is an instance of Error", () => {
    const err = new SkrunApiError("NOT_FOUND", "Agent not found", 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SkrunApiError);
  });

  it("has code, message, and status", () => {
    const err = new SkrunApiError("UNAUTHORIZED", "Missing token", 401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Missing token");
    expect(err.status).toBe(401);
    expect(err.name).toBe("SkrunApiError");
  });

  it("fromResponse parses server error format", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "NOT_FOUND", message: "Agent not found" } }),
      { status: 404, statusText: "Not Found" },
    );
    const err = await SkrunApiError.fromResponse(response);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Agent not found");
    expect(err.status).toBe(404);
  });

  it("fromResponse handles non-JSON response", async () => {
    const response = new Response("Internal Server Error", {
      status: 500,
      statusText: "Internal Server Error",
    });
    const err = await SkrunApiError.fromResponse(response);
    expect(err.code).toBe("UNKNOWN");
    expect(err.status).toBe(500);
  });

  it("networkError creates error with code NETWORK_ERROR", () => {
    const err = SkrunApiError.networkError("http://localhost:4000");
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.message).toContain("localhost:4000");
    expect(err.status).toBe(0);
  });

  it("timeout creates error with code TIMEOUT", () => {
    const err = SkrunApiError.timeout(5000);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toContain("5000ms");
  });

  it("streamInterrupted creates error with code STREAM_INTERRUPTED", () => {
    const err = SkrunApiError.streamInterrupted();
    expect(err.code).toBe("STREAM_INTERRUPTED");
  });
});

describe("SkrunNotVerifiedError", () => {
  it("UAT-40: code is AGENT_NOT_VERIFIED and status is 403", () => {
    const err = new SkrunNotVerifiedError("Agent ops/x version 1.0.0 must be verified");
    expect(err.code).toBe("AGENT_NOT_VERIFIED");
    expect(err.status).toBe(403);
  });

  it("UAT-42: subclass relationship — instanceof SkrunApiError + SkrunNotVerifiedError + Error", () => {
    const err = new SkrunNotVerifiedError("test");
    expect(err).toBeInstanceOf(SkrunNotVerifiedError);
    expect(err).toBeInstanceOf(SkrunApiError);
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves the message", () => {
    const msg = "Version 1.2.0 must be verified by an admin before it can run.";
    const err = new SkrunNotVerifiedError(msg);
    expect(err.message).toBe(msg);
  });

  it("name is SkrunNotVerifiedError (not the parent's)", () => {
    const err = new SkrunNotVerifiedError("x");
    expect(err.name).toBe("SkrunNotVerifiedError");
  });
});

// fromResponse dispatch — pinning the typed-subclass selection so future
// adds to ERROR_CLASS_BY_CODE don't accidentally break existing consumers.
describe("SkrunApiError.fromResponse dispatch", () => {
  function buildResponse(status: number, body: unknown): Response {
    return {
      status,
      statusText: "Test Status",
      json: async () => body,
    } as unknown as Response;
  }

  it("UAT-40: returns SkrunNotVerifiedError on 403 + AGENT_NOT_VERIFIED", async () => {
    const res = buildResponse(403, {
      error: { code: "AGENT_NOT_VERIFIED", message: "Version 1.0.0 must be verified" },
    });
    const err = await SkrunApiError.fromResponse(res);

    expect(err).toBeInstanceOf(SkrunNotVerifiedError);
    expect(err.code).toBe("AGENT_NOT_VERIFIED");
    expect(err.status).toBe(403);
    expect(err.message).toBe("Version 1.0.0 must be verified");
  });

  it("UAT-41: returns plain SkrunApiError for other 403 codes (e.g. FORBIDDEN)", async () => {
    const res = buildResponse(403, {
      error: { code: "FORBIDDEN", message: "Wrong namespace" },
    });
    const err = await SkrunApiError.fromResponse(res);

    expect(err).toBeInstanceOf(SkrunApiError);
    expect(err).not.toBeInstanceOf(SkrunNotVerifiedError);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.status).toBe(403);
  });

  it("returns plain SkrunApiError for 4xx/5xx codes outside the dispatch table", async () => {
    const cases = [
      { status: 404, code: "AGENT_NOT_FOUND" },
      { status: 409, code: "VERSION_EXISTS" },
      { status: 500, code: "INTERNAL_ERROR" },
    ];
    for (const c of cases) {
      const res = buildResponse(c.status, { error: { code: c.code, message: "x" } });
      const err = await SkrunApiError.fromResponse(res);
      expect(err).toBeInstanceOf(SkrunApiError);
      expect(err).not.toBeInstanceOf(SkrunNotVerifiedError);
      expect(err.code).toBe(c.code);
      expect(err.status).toBe(c.status);
    }
  });

  it("UAT-44 (extensibility): unknown code falls through to generic SkrunApiError", async () => {
    // Future-proofing: adding a new code to ERROR_CLASS_BY_CODE doesn't break
    // existing consumers. This test pins that contract by verifying the
    // default path is preserved for unknown codes.
    const res = buildResponse(403, {
      error: { code: "BRAND_NEW_UNKNOWN_CODE", message: "future code" },
    });
    const err = await SkrunApiError.fromResponse(res);
    expect(err.constructor.name).toBe("SkrunApiError");
    expect(err.code).toBe("BRAND_NEW_UNKNOWN_CODE");
  });

  it("handles missing error.code — falls back to UNKNOWN", async () => {
    const res = buildResponse(400, { error: { message: "no code field" } });
    const err = await SkrunApiError.fromResponse(res);
    expect(err.code).toBe("UNKNOWN");
  });
});

// Sanity: SkrunFileUploadError still works (regression guard — it's an
// independent subclass and shouldn't be affected by the dispatch refactor).
describe("SkrunFileUploadError (regression)", () => {
  it("code stays FILE_UPLOAD_FAILED, instanceof Error", () => {
    const err = new SkrunFileUploadError("upload failed");
    expect(err.code).toBe("FILE_UPLOAD_FAILED");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SkrunFileUploadError");
  });
});
