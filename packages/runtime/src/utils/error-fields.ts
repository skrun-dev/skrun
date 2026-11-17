/** A class or a code, never anything that could spell out a path. */
const ERROR_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A line of a V8 stack that is a frame: `    at …`. */
const FRAME = /^\s+at\s/;

/** What a log line may say about an error. */
export interface ErrorFields {
  error_name: string;
  error_code?: string;
  /** The HTTP status the error carries, when it carries one: a number a server sent back. */
  error_status?: string;
  /** The frames of the error's stack, one per entry, never its header. */
  error_stack?: string[];
}

/**
 * What a log line may say about an error: its class, its code and, when it
 * carries one, its HTTP status. Never its message — a storage error can quote
 * the key it failed on, a parser the text it choked on, a provider the request
 * it refused, and any of them can carry a file name or a URL. Those can be
 * personal data, and a log store is another destination, kept for another
 * length of time.
 *
 * The status is read from a whole-number `status` property, which the model
 * providers' SDKs set on their errors and which says what a bare `Error` name
 * cannot: a rate limit from a refused key, say.
 *
 * With `{ stack: true }`, also the frames of its stack: where it was thrown
 * from, in the server's own code. Never the header written before them, which
 * holds the name and the message — see `stackFrames`.
 *
 * One implementation for every process that logs: the API, the runtime it
 * drives, and the runner inside the sandbox.
 */
export function errorFields(err: unknown, options: { stack?: boolean } = {}): ErrorFields {
  const name = err instanceof Error && ERROR_TOKEN.test(err.name) ? err.name : "Error";
  const fields: ErrorFields = { error_name: name };
  const carrier = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  const code = carrier?.code;
  if (typeof code === "number") fields.error_code = String(code);
  else if (typeof code === "string" && ERROR_TOKEN.test(code)) fields.error_code = code;
  const status = carrier?.status;
  if (typeof status === "number" && Number.isInteger(status)) fields.error_status = String(status);
  if (options.stack) {
    const frames = stackFrames(err);
    if (frames) fields.error_stack = frames;
  }
  return fields;
}

/**
 * The frames of an error's stack, without the header that comes first. That
 * header is the error's name and message, and a message can run over several
 * lines — one of which can even look like a frame — so it is removed as a
 * whole, exactly as it was written, never as "the first line". It is either
 * `Error.prototype.toString` of the error or, for Node's own errors, `Name
 * [CODE]: message`. A stack that starts with neither — a message changed
 * after the stack was written, say — gives no frame at all. After the header,
 * frames are kept up to the first line that is not one: whatever a library
 * appends there (a cause, with its own message) is left out.
 */
function stackFrames(err: unknown): string[] | undefined {
  try {
    if (!(err instanceof Error) || typeof err.stack !== "string") return undefined;
    const stack = err.stack;
    const header = stackHeaders(err).find((candidate) => stack.startsWith(`${candidate}\n`));
    if (header === undefined) return undefined;
    const frames: string[] = [];
    for (const line of stack.slice(header.length + 1).split("\n")) {
      if (!FRAME.test(line)) break;
      frames.push(line.trim());
    }
    return frames.length > 0 ? frames : undefined;
  } catch {
    // A getter that throws on name, message or stack: no frame, rather than a guess.
    return undefined;
  }
}

/** The headers a stack can start with, for this error. */
function stackHeaders(err: Error): string[] {
  const headers = [Error.prototype.toString.call(err)];
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    const message = String(err.message);
    headers.push(`${String(err.name)} [${code}]${message === "" ? "" : `: ${message}`}`);
  }
  return headers;
}
