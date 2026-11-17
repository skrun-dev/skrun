import {
  type FileInputField,
  isRunInputAbsent,
  runMissingInputRefusal,
  type WireFileSource,
  WireFileSourceSchema,
} from "@skrun-dev/schema";
import { isHostAllowed } from "../security/network.js";
import { type PrivateResolution, SsrfBlockedError, safeFetch } from "../security/safe-fetch.js";

// ============================================================================
// SkrunPart — internal multimodal representation
// ============================================================================

export type SkrunPart =
  | { kind: "text"; text: string }
  | { kind: "image"; media_type: string; bytes: Uint8Array; filename?: string }
  | { kind: "document"; media_type: string; bytes: Uint8Array; filename?: string }
  | { kind: "audio"; media_type: string; bytes: Uint8Array; filename?: string };

// ============================================================================
// Resolution
// ============================================================================

export const INLINE_BASE64_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const URL_FETCH_TIMEOUT_MS = 30_000; // bound on file-input URL fetches

export class ResolveError extends Error {
  readonly code: string;
  /**
   * For a URL refused because a name it reaches resolved to a private or
   * reserved address: that name, which `message` names too, and that address,
   * which `message` — the caller's to read — never names. For the server's own
   * log.
   */
  readonly privateResolution: PrivateResolution | undefined;
  constructor(code: string, message: string, privateResolution?: PrivateResolution) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
    this.privateResolution = privateResolution;
  }
}

export interface ResolveContext {
  /** Resolve a Skrun file_id to its bytes. Returns null when unknown / expired. */
  fetchInputFile: (file_id: string) => Promise<{ bytes: Uint8Array; media_type: string } | null>;
  /** Allowed hosts list from the agent's environment.networking.allowed_hosts. */
  allowedHosts: string[];
}

async function resolveWirePart(
  wire: WireFileSource,
  ctx: ResolveContext,
): Promise<{ bytes: Uint8Array; media_type: string }> {
  if (wire.source === "id") {
    const result = await ctx.fetchInputFile(wire.file_id);
    if (!result) {
      throw new ResolveError("FILE_NOT_FOUND", `Input file '${wire.file_id}' not found or expired`);
    }
    return result;
  }

  if (wire.source === "data") {
    const bytes = Buffer.from(wire.data, "base64");
    if (bytes.length > INLINE_BASE64_MAX_BYTES) {
      throw new ResolveError(
        "INLINE_TOO_LARGE",
        `Inline base64 data is ${bytes.length} bytes; max ${INLINE_BASE64_MAX_BYTES} bytes (4 MB). Use POST /api/files for larger payloads.`,
      );
    }
    return { bytes: new Uint8Array(bytes), media_type: wire.media_type };
  }

  // wire.source === "url"
  const u = new URL(wire.url);
  if (!isHostAllowed(u.hostname, ctx.allowedHosts)) {
    throw new ResolveError(
      "URL_NOT_ALLOWED",
      `URL host '${u.hostname}' is not in the agent's allowed_hosts allowlist`,
    );
  }
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    // The check above vets this URL; the guard holds every connection — this
    // one, and each redirect hop's — to the same list, so a listed host cannot
    // redirect the fetch off it.
    res = await safeFetch(wire.url, undefined, {
      timeoutMs: URL_FETCH_TIMEOUT_MS,
      allowedHosts: ctx.allowedHosts,
    });
  } catch (err) {
    // safeFetch throws SsrfBlockedError directly (bad scheme) or rejects with it
    // as the fetch error's `cause` (a private/reserved address, literal or
    // resolved, or a host off the list — at the first URL or a redirect hop).
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    if (err instanceof SsrfBlockedError || cause instanceof SsrfBlockedError) {
      const blocked = err instanceof SsrfBlockedError ? err : (cause as SsrfBlockedError);
      throw new ResolveError("URL_NOT_ALLOWED", blocked.message, blocked.privateResolution);
    }
    throw new ResolveError(
      "URL_FETCH_FAILED",
      `Fetching '${wire.url}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!res.ok) {
    throw new ResolveError(
      "URL_FETCH_FAILED",
      `Fetching '${wire.url}' returned status ${res.status}`,
    );
  }
  const buffer = await res.arrayBuffer();
  const mediaType = res.headers.get("content-type") ?? "application/octet-stream";
  return { bytes: new Uint8Array(buffer), media_type: mediaType };
}

/**
 * The refusal of an element of a file input that is not a file source:
 * `Input 'photo' item 1 is not a file source (url: Invalid URL)`. The member a
 * complaint is about comes from the schema's own keys, and its wording names
 * types and expected values, never the one received.
 */
function notAFileSource(
  field: string,
  index: number | undefined,
  issue: { path: PropertyKey[]; message: string } | undefined,
): ResolveError {
  const where = index === undefined ? `Input '${field}'` : `Input '${field}' item ${index}`;
  const member = issue && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
  const what = issue ? ` (${member}${issue.message})` : "";
  return new ResolveError("INVALID_INPUT_TYPE", `${where} is not a file source${what}`);
}

/**
 * Resolve all file-typed inputs in a run request payload to SkrunPart[] per field name.
 *
 * The route handler is expected to:
 *   1. Validate the input shape against the agent.yaml schema (discriminated union)
 *   2. Filter primitive inputs out and collect file-typed schemas
 *   3. Call this function with the file schemas
 *   4. Combine the returned parts with text input into LLMCallRequest.userContent
 */
export async function resolveInput(
  input: Record<string, unknown>,
  fileSchemas: FileInputField[],
  ctx: ResolveContext,
): Promise<Map<string, SkrunPart[]>> {
  const result = new Map<string, SkrunPart[]>();

  for (const schema of fileSchemas) {
    // Absent as the schema defines it — no field of the input's own (a name
    // only its prototype carries, `toString`, `filter` of an array, is none of
    // its inputs), null, or an empty list: a required one is refused with the
    // code and the words the check of the declared inputs gives; an optional
    // one is left out of the resolved inputs, and the run goes ahead without it.
    if (isRunInputAbsent(schema, input)) {
      if (schema.required) {
        const refusal = runMissingInputRefusal(schema.name);
        throw new ResolveError(refusal.code, refusal.message);
      }
      continue;
    }

    const raw = input[schema.name];
    const wireArray = Array.isArray(raw) ? raw : [raw];

    if (wireArray.length > schema.max_count) {
      throw new ResolveError(
        "MAX_COUNT_EXCEEDED",
        `Input '${schema.name}' has ${wireArray.length} items but max_count is ${schema.max_count}`,
      );
    }

    const parts: SkrunPart[] = [];
    for (const [index, item] of wireArray.entries()) {
      // An element that is not a file source is the caller's mistake, refused
      // as one (400 at the route), never thrown as the schema's own error (a
      // 500). The message names the field, the element when the field is a
      // list, and the schema's first complaint — never the value sent.
      const parsed = WireFileSourceSchema.safeParse(item);
      if (!parsed.success) {
        throw notAFileSource(
          schema.name,
          Array.isArray(raw) ? index : undefined,
          parsed.error.issues[0],
        );
      }
      const { bytes, media_type } = await resolveWirePart(parsed.data, ctx);
      parts.push({
        kind: schema.media,
        media_type,
        bytes,
      });
    }
    result.set(schema.name, parts);
  }

  return result;
}
