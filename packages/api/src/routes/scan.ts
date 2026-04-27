import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";
import { RegistryError, type RegistryService } from "../services/registry.js";

// --- Tar builder (replicates CLI skrun build logic) ---

const EXCLUDE_PATTERNS = new Set(["node_modules", ".git", "dist", ".env", ".DS_Store"]);

function isExcluded(name: string): boolean {
  if (EXCLUDE_PATTERNS.has(name)) return true;
  if (name.startsWith(".") && name !== ".") return true;
  if (name.endsWith(".secret")) return true;
  return false;
}

function collectFiles(dir: string, base: string = dir): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, base));
    } else {
      files.push(relative(base, fullPath));
    }
  }

  return files.sort();
}

function createTarEntry(filePath: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const nameBytes = Buffer.from(filePath, "utf-8");
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));

  Buffer.from("0000644\0").copy(header, 100); // mode
  Buffer.from("0001000\0").copy(header, 108); // uid
  Buffer.from("0001000\0").copy(header, 116); // gid
  Buffer.from(`${content.length.toString(8).padStart(11, "0")}\0`).copy(header, 124); // size
  Buffer.from("00000000000\0").copy(header, 136); // mtime
  header[156] = 48; // type: regular file
  Buffer.from("ustar\0").copy(header, 257); // magic
  Buffer.from("00").copy(header, 263); // version

  // Checksum
  Buffer.from("        ").copy(header, 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);

  const paddingSize = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(paddingSize)]);
}

function buildAgentBundle(agentDir: string): Buffer {
  const files = collectFiles(agentDir);
  const parts: Buffer[] = [];

  for (const file of files) {
    const content = readFileSync(join(agentDir, file));
    parts.push(createTarEntry(file, content));
  }

  parts.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}

// --- Routes ---

export function createScanRoutes(
  db: DbAdapter,
  authMiddleware: MiddlewareHandler,
  service: RegistryService,
): Hono {
  const router = new Hono();

  router.get("/agents/scan", authMiddleware, async (c) => {
    const agentsDir = process.env.SKRUN_AGENTS_DIR;

    if (!agentsDir) {
      return c.json({ agents: [], configured: false });
    }

    const resolvedDir = resolve(agentsDir);

    if (!existsSync(resolvedDir)) {
      return c.json({
        agents: [],
        configured: true,
        error: `Directory not found: ${agentsDir}`,
      });
    }

    const entries = readdirSync(resolvedDir);
    const user = getUser(c);
    const agents: Array<{ name: string; path: string; registered: boolean }> = [];

    for (const entry of entries) {
      const entryPath = join(resolvedDir, entry);
      if (!entryPath.startsWith(resolvedDir)) continue;

      try {
        const stat = statSync(entryPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      const agentYamlPath = join(entryPath, "agent.yaml");
      if (!existsSync(agentYamlPath)) continue;

      const agent = await db.getAgent(user.namespace, entry);
      agents.push({
        name: entry,
        path: entryPath,
        registered: agent !== null,
      });
    }

    return c.json({ agents, configured: true });
  });

  // POST /api/agents/scan/:name/push — build + push agent directly (no CLI)
  router.post("/agents/scan/:name/push", authMiddleware, async (c) => {
    const agentsDir = process.env.SKRUN_AGENTS_DIR;
    if (!agentsDir) {
      return c.json(
        { error: { code: "NOT_CONFIGURED", message: "SKRUN_AGENTS_DIR not configured" } },
        400,
      );
    }

    const { name } = c.req.param();
    const user = getUser(c);
    const resolvedDir = resolve(agentsDir);
    const agentPath = join(resolvedDir, name);

    if (!agentPath.startsWith(resolvedDir)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Invalid agent path" } }, 403);
    }

    if (!existsSync(agentPath)) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Agent directory not found: ${name}` } },
        404,
      );
    }

    const agentYamlPath = join(agentPath, "agent.yaml");
    if (!existsSync(agentYamlPath)) {
      return c.json(
        { error: { code: "INVALID_AGENT", message: "No agent.yaml found in directory" } },
        400,
      );
    }

    // Read version from agent.yaml
    let version = "1.0.0";
    try {
      const yamlContent = readFileSync(agentYamlPath, "utf-8");
      const versionMatch = yamlContent.match(/version:\s*["']?([^"'\n]+)/);
      if (versionMatch?.[1]) {
        version = versionMatch[1].trim();
      }
    } catch {
      // Use default version
    }

    // Build bundle in memory (tar.gz) — same format as skrun build
    const bundle = buildAgentBundle(agentPath);

    try {
      const metadata = await service.push(user.namespace, name, version, bundle, user.id);
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
