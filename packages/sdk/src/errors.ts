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
      return new SkrunApiError(
        body.error?.code ?? "UNKNOWN",
        body.error?.message ?? response.statusText,
        response.status,
      );
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
