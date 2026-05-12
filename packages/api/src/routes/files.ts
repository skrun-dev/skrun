import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { SkrunError } from "@skrun-dev/schema";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  deleteInputFile,
  getInputRetentionSeconds,
  registerInputFile,
} from "../cache/input-cache.js";
import { getOutputDir } from "../cache/output-cache.js";
import { resolveFileId } from "../files/file-id-resolver.js";
import { writeInputFile } from "../files/input-store.js";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function isAllowedUploadMime(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("audio/");
}

export function createFilesRoutes(authMiddleware: MiddlewareHandler): Hono {
  const router = new Hono();

  router.post("/files", authMiddleware, async (c) => {
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_MULTIPART",
            message: "Could not parse multipart/form-data body",
          },
        },
        400,
      );
    }

    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json(
        {
          error: {
            code: "MISSING_FILE",
            message: "Multipart field 'file' is required and must be a binary upload",
          },
        },
        400,
      );
    }

    const mediaType = file.type || "application/octet-stream";
    if (!isAllowedUploadMime(mediaType)) {
      return c.json(
        {
          error: {
            code: "MIME_NOT_ALLOWED",
            message: `Media type '${mediaType}' is not in the allowed upload classes (image/*, application/pdf, audio/*). Strict per-agent mime validation happens at /run.`,
          },
        },
        415,
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    let writeResult: ReturnType<typeof writeInputFile>;
    try {
      writeResult = writeInputFile(bytes);
    } catch (err) {
      if (err instanceof SkrunError && err.code === "FILE_TOO_LARGE") {
        return c.json({ error: { code: "FILE_TOO_LARGE", message: err.message } }, 413);
      }
      throw err;
    }

    const expiresAt = new Date(Date.now() + getInputRetentionSeconds() * 1000);
    registerInputFile(writeResult.file_id, {
      path: writeResult.path,
      size: writeResult.size,
      media_type: mediaType,
      purpose: "input",
      expires_at: expiresAt,
    });

    return c.json(
      {
        file_id: writeResult.file_id,
        size: writeResult.size,
        media_type: mediaType,
        purpose: "input" as const,
        expires_at: expiresAt.toISOString(),
      },
      201,
    );
  });

  router.get("/files/:id", (c) => {
    const { id } = c.req.param();
    const resolved = resolveFileId(id);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File '${id}' not found or expired`,
          },
        },
        404,
      );
    }
    return c.json({
      file_id: id,
      size: resolved.metadata.size,
      media_type: resolved.metadata.media_type,
      purpose: resolved.metadata.purpose,
      expires_at: resolved.metadata.expires_at?.toISOString(),
    });
  });

  router.get("/files/:id/content", (c) => {
    const { id } = c.req.param();
    const resolved = resolveFileId(id);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File '${id}' not found or expired`,
          },
        },
        404,
      );
    }

    if (!existsSync(resolved.path)) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File data missing on disk for '${id}'`,
          },
        },
        404,
      );
    }

    const content = readFileSync(resolved.path);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": resolved.metadata.media_type,
        "Content-Length": String(content.length),
      },
    });
  });

  router.delete("/files/:id", authMiddleware, (c) => {
    const { id } = c.req.param();
    const resolved = resolveFileId(id);
    if (!resolved) {
      return c.json(
        {
          error: {
            code: "FILE_NOT_FOUND",
            message: `File '${id}' not found or expired`,
          },
        },
        404,
      );
    }
    if (resolved.metadata.purpose === "output") {
      return c.json(
        {
          error: {
            code: "DELETE_OUTPUT_FORBIDDEN",
            message: "Output files are produced by agents and cannot be deleted by callers",
          },
        },
        403,
      );
    }
    deleteInputFile(id);
    return c.body(null, 204);
  });

  router.get("/runs/:run_id/files/:filename", (c) => {
    const { run_id, filename } = c.req.param();

    const dir = getOutputDir(run_id);
    if (!dir) {
      return c.json(
        { error: { code: "RUN_NOT_FOUND", message: `Run ${run_id} not found or expired` } },
        404,
      );
    }

    const filePath = join(dir, filename);

    // Path traversal protection
    if (!resolve(filePath).startsWith(resolve(dir) + sep)) {
      return c.json({ error: { code: "FILE_NOT_FOUND", message: "File not found" } }, 404);
    }

    if (!existsSync(filePath)) {
      return c.json(
        { error: { code: "FILE_NOT_FOUND", message: `File "${filename}" not found` } },
        404,
      );
    }

    const content = readFileSync(filePath);
    const ext = extname(filename).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(content.length),
      },
    });
  });

  return router;
}
