export class SkrunFileUploadError extends Error {
  readonly code = "FILE_UPLOAD_FAILED";
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SkrunFileUploadError";
    this.cause = cause;
  }
}

export class SkrunApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SkrunApiError";
    this.code = code;
    this.status = status;
  }

  /** Create from an HTTP response with Skrun's error format: { error: { code, message } } */
  static async fromResponse(response: Response): Promise<SkrunApiError> {
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      const code = body.error?.code ?? "UNKNOWN";
      const message = body.error?.message ?? response.statusText;
      // Dispatch typed subclasses by error code. The default falls through to
      // the generic SkrunApiError so consumers can still check `err.code` or
      // `err.status` even for codes we don't have a dedicated class for.
      const Subclass = ERROR_CLASS_BY_CODE[code];
      if (Subclass) {
        return new Subclass(message);
      }
      return new SkrunApiError(code, message, response.status);
    } catch {
      return new SkrunApiError("UNKNOWN", response.statusText, response.status);
    }
  }

  static networkError(baseUrl: string, cause?: Error): SkrunApiError {
    const err = new SkrunApiError("NETWORK_ERROR", `Failed to connect to ${baseUrl}`, 0);
    if (cause) err.cause = cause;
    return err;
  }

  static timeout(ms: number): SkrunApiError {
    return new SkrunApiError("TIMEOUT", `Request timed out after ${ms}ms`, 0);
  }

  static streamInterrupted(): SkrunApiError {
    return new SkrunApiError("STREAM_INTERRUPTED", "SSE connection closed unexpectedly", 0);
  }
}

/**
 * Thrown when a `POST /run` call hits an unverified agent version. Catch with
 * `instanceof SkrunNotVerifiedError` for a typed branch, or fall back to
 * `err.code === "AGENT_NOT_VERIFIED"` if you receive a generic
 * `SkrunApiError` from a code path that bypasses `fromResponse`.
 */
export class SkrunNotVerifiedError extends SkrunApiError {
  constructor(message: string) {
    super("AGENT_NOT_VERIFIED", message, 403);
    this.name = "SkrunNotVerifiedError";
  }
}

/**
 * Dispatch table mapping `error.code` → typed `SkrunApiError` subclass.
 * Extensible: add an entry here when introducing a new typed error class.
 * Codes absent from the table fall through to a plain `SkrunApiError` in
 * `fromResponse`, which preserves backward compatibility for consumers that
 * only check `err.code`.
 */
const ERROR_CLASS_BY_CODE: Record<string, new (message: string) => SkrunApiError> = {
  AGENT_NOT_VERIFIED: SkrunNotVerifiedError,
};
