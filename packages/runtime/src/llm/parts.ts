import { type FileInputField, type WireFileSource, WireFileSourceSchema } from "@skrun-dev/schema";
import { isHostAllowed } from "../security/network.js";

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

export class ResolveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
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
  const res = await fetch(wire.url);
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
    const raw = input[schema.name];
    if (raw === undefined || raw === null) {
      if (schema.required) {
        throw new ResolveError(
          "REQUIRED_INPUT_MISSING",
          `Required file input '${schema.name}' is missing`,
        );
      }
      continue;
    }

    const wireArray = Array.isArray(raw) ? raw : [raw];

    if (wireArray.length > schema.max_count) {
      throw new ResolveError(
        "MAX_COUNT_EXCEEDED",
        `Input '${schema.name}' has ${wireArray.length} items but max_count is ${schema.max_count}`,
      );
    }

    const parts: SkrunPart[] = [];
    for (const item of wireArray) {
      const wire = WireFileSourceSchema.parse(item);
      const { bytes, media_type } = await resolveWirePart(wire, ctx);
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
