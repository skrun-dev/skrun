import { Hono } from "hono";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { RegistryError, type RegistryService } from "../services/registry.js";

export function createRegistryRoutes(service: RegistryService): Hono {
  const router = new Hono();

  // Push — auth required
  router.post("/agents/:namespace/:name/push", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    const version = c.req.query("version");
    const force = c.req.query("force") === "true";
    const user = getUser(c);

    if (!version) {
      return c.json(
        { error: { code: "MISSING_VERSION", message: "Query param 'version' is required" } },
        400,
      );
    }

    // Check namespace ownership
    if (namespace !== user.namespace) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `You don't have permission to push to namespace '${namespace}'`,
          },
        },
        403,
      );
    }

    try {
      const body = await c.req.arrayBuffer();
      const buffer = Buffer.from(body);
      const metadata = await service.push(namespace, name, version, buffer, user.id, force);
      return c.json(metadata);
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }
  });

  // Pull latest — auth required
  router.get("/agents/:namespace/:name/pull", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();
    try {
      const result = await service.pull(namespace, name);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${name}-${result.version}.agent"`);
      c.header("X-Agent-Version", result.version);
      return c.body(new Uint8Array(result.buffer));
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }
  });

  // Pull specific version — auth required
  router.get("/agents/:namespace/:name/pull/:version", authMiddleware, async (c) => {
    const { namespace, name, version } = c.req.param();
    try {
      const result = await service.pull(namespace, name, version);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${name}-${result.version}.agent"`);
      c.header("X-Agent-Version", result.version);
      return c.body(new Uint8Array(result.buffer));
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }
  });

  // List — public
  router.get("/agents", async (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const limit = Number(c.req.query("limit") ?? "20");
    const result = await service.list(page, limit);
    return c.json({ ...result, page, limit });
  });

  // Metadata — public
  router.get("/agents/:namespace/:name", async (c) => {
    const { namespace, name } = c.req.param();
    try {
      const metadata = await service.getMetadata(namespace, name);
      return c.json(metadata);
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }
  });

  // Versions — public
  router.get("/agents/:namespace/:name/versions", async (c) => {
    const { namespace, name } = c.req.param();
    try {
      const versions = await service.getVersions(namespace, name);
      return c.json({ versions });
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }
  });

  // Verify — auth required (operator action)
  router.patch("/agents/:namespace/:name/verify", authMiddleware, async (c) => {
    const { namespace, name } = c.req.param();

    let body: { verified: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }, 400);
    }

    if (typeof body.verified !== "boolean") {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Body must contain { verified: boolean }" } },
        400,
      );
    }

    try {
      const metadata = await service.setVerified(namespace, name, body.verified);
      return c.json(metadata);
    } catch (err) {
      if (err instanceof RegistryError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status as 400 | 404 | 409 | 500,
        );
      }
      throw err;
    }
  });

  return router;
}
