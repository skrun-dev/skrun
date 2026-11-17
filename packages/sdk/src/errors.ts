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
      const make = ERROR_CLASS_BY_CODE[code];
      if (make) {
        return make(message, response);
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

  /**
   * A redirect the client did not follow: its target received nothing — no
   * token, no model key, no body. `status` is the `3xx` received, and the
   * message names the origin of the target, read from `Location` against the
   * request's URL, when it is an `http://` or `https://` address. A browser
   * answers with an opaque redirect instead, whose target it does not reveal:
   * `status` 0, and no target named.
   */
  static redirectRefused(baseUrl: string, response: Response, requestUrl: string): SkrunApiError {
    if (response.type === "opaqueredirect") {
      return new SkrunApiError(
        "REDIRECT_REFUSED",
        `The server at ${baseUrl} answered with a redirect, whose target a browser does not reveal; the client does not follow it.`,
        0,
      );
    }
    const target = redirectOrigin(response.headers.get("location"), requestUrl);
    return new SkrunApiError(
      "REDIRECT_REFUSED",
      target === undefined
        ? `The server at ${baseUrl} answered with a redirect (HTTP ${response.status}), which the client does not follow.`
        : `The server at ${baseUrl} answered with a redirect to ${target}, which the client does not follow.`,
      response.status,
    );
  }

  static timeout(ms: number): SkrunApiError {
    return new SkrunApiError("TIMEOUT", `Request timed out after ${ms}ms`, 0);
  }

  static streamInterrupted(): SkrunApiError {
    return new SkrunApiError("STREAM_INTERRUPTED", "SSE connection closed unexpectedly", 0);
  }
}

/** The origin a redirect points to, resolved against the request; undefined when it is not an http:// or https:// address. */
function redirectOrigin(location: string | null, requestUrl: string): string | undefined {
  if (location === null) return undefined;
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return undefined;
  }
  return target.protocol === "http:" || target.protocol === "https:" ? target.origin : undefined;
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
 * The wait a response's `Retry-After` asks for, in seconds: its number of
 * seconds, or the seconds from now to its HTTP date; undefined when the
 * header is absent or unreadable.
 */
function retryAfterSecondsOf(response: Response): number | undefined {
  const value = response.headers?.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Thrown when a run is refused because its account already has as many runs
 * in progress as its plan allows (`429 CONCURRENCY_LIMIT_REACHED`). A seat
 * frees as soon as one of them ends: `retryAfterSeconds` is the server's
 * suggested wait.
 */
export class SkrunConcurrencyLimitError extends SkrunApiError {
  /** The server's `Retry-After`, in seconds. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 429, retryAfterSeconds?: number) {
    super("CONCURRENCY_LIMIT_REACHED", message, status);
    this.name = "SkrunConcurrencyLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when a run is refused because its account used the compute time its
 * plan allows in the current window (`429 COMPUTE_QUOTA_EXCEEDED`).
 * `retryAfterSeconds` is the time left until the window renews.
 */
export class SkrunComputeQuotaError extends SkrunApiError {
  /** The server's `Retry-After`, in seconds: until the window renews. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 429, retryAfterSeconds?: number) {
    super("COMPUTE_QUOTA_EXCEEDED", message, status);
    this.name = "SkrunComputeQuotaError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when a run is refused because the server is at full capacity
 * (`503 CAPACITY_EXHAUSTED`) — every account's runs together, not yours
 * alone. Retrying after `retryAfterSeconds` makes sense.
 */
export class SkrunCapacityError extends SkrunApiError {
  /** The server's `Retry-After`, in seconds. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 503, retryAfterSeconds?: number) {
    super("CAPACITY_EXHAUSTED", message, status);
    this.name = "SkrunCapacityError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when a run is refused because its agent — or the run's environment
 * override — declares a timeout above the longest this server accepts
 * (`400 TIMEOUT_ABOVE_LIMIT`). Waiting changes nothing: the server sends no
 * `Retry-After`, and `retryAfterSeconds` stays undefined.
 */
export class SkrunTimeoutAboveLimitError extends SkrunApiError {
  /** The server's `Retry-After`, in seconds — none is sent for this refusal. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 400, retryAfterSeconds?: number) {
    super("TIMEOUT_ABOVE_LIMIT", message, status);
    this.name = "SkrunTimeoutAboveLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when a push is refused because the account's agents already hold
 * the bundle storage its plan allows, this bundle included
 * (`413 STORAGE_QUOTA_EXCEEDED`). Nothing of the push is stored; deleting a
 * version no longer needed makes room — or, for an agent's last version, the
 * agent, with its state and its model keys. Waiting changes nothing: the server
 * sends no `Retry-After`, and `retryAfterSeconds` stays undefined.
 */
export class SkrunStorageQuotaError extends SkrunApiError {
  /** The server's `Retry-After`, in seconds — none is sent for this refusal. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 413, retryAfterSeconds?: number) {
    super("STORAGE_QUOTA_EXCEEDED", message, status);
    this.name = "SkrunStorageQuotaError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when an upload to `/api/files` is refused because the account
 * already holds as many live uploads as its plan allows
 * (`429 INPUT_FILES_LIMIT_REACHED`). A place frees when the oldest of them
 * expires — `retryAfterSeconds` — or when one is deleted; an account that
 * holds more than its plan allows, its plan lowered, waits until enough of
 * them have expired or been deleted, and `retryAfterSeconds` counts to that
 * moment. From `uploadFile`, and from a run whose binary inputs it uploads, it
 * arrives as the `cause` of a `SkrunFileUploadError`.
 */
export class SkrunInputFilesLimitError extends SkrunApiError {
  /** The server's `Retry-After`, in seconds: until the account holds fewer uploads than its plan allows. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 429, retryAfterSeconds?: number) {
    super("INPUT_FILES_LIMIT_REACHED", message, status);
    this.name = "SkrunInputFilesLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Dispatch table mapping `error.code` → a factory of its typed `SkrunApiError`
 * subclass, handed the message and the response (its status, its headers).
 * Extensible: add an entry here when introducing a new typed error class.
 * Codes absent from the table fall through to a plain `SkrunApiError` in
 * `fromResponse`, which preserves backward compatibility for consumers that
 * only check `err.code`.
 */
const ERROR_CLASS_BY_CODE: Record<string, (message: string, response: Response) => SkrunApiError> =
  {
    AGENT_NOT_VERIFIED: (message) => new SkrunNotVerifiedError(message),
    CONCURRENCY_LIMIT_REACHED: (message, response) =>
      new SkrunConcurrencyLimitError(message, response.status, retryAfterSecondsOf(response)),
    COMPUTE_QUOTA_EXCEEDED: (message, response) =>
      new SkrunComputeQuotaError(message, response.status, retryAfterSecondsOf(response)),
    CAPACITY_EXHAUSTED: (message, response) =>
      new SkrunCapacityError(message, response.status, retryAfterSecondsOf(response)),
    TIMEOUT_ABOVE_LIMIT: (message, response) =>
      new SkrunTimeoutAboveLimitError(message, response.status, retryAfterSecondsOf(response)),
    STORAGE_QUOTA_EXCEEDED: (message, response) =>
      new SkrunStorageQuotaError(message, response.status, retryAfterSecondsOf(response)),
    INPUT_FILES_LIMIT_REACHED: (message, response) =>
      new SkrunInputFilesLimitError(message, response.status, retryAfterSecondsOf(response)),
  };
