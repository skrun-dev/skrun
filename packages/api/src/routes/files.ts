import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { getOutputDir } from "../cache/output-cache.js";

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

export function createFilesRoutes(): Hono {
  const router = new Hono();

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
