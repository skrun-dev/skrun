import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isExcludedEntry, packAgentTar } from "@skrun-dev/schema";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import { getUser } from "../middleware/auth.js";
import { assertKeyCanPushOrThrow } from "../services/key-scope.js";
import type { RegistryService } from "../services/registry.js";
import { dispatchRegistryError } from "./_helpers.js";

/**
 * Same segment shape the registry routes enforce on `:name` (nine routes) and
 * `agent-llm-keys` (two). A superset of the schema's own AGENT_NAME_REGEX, so
 * every directory with a legal agent name still scans and pushes; one that
 * would fail it is already unusable through every other registry route.
 */
const PATH_SEGMENT_REGEX = /^[a-z0-9-]{1,64}$/;

/**
 * Containment check with the trailing separator.
 *
 * `"/srv/agents-backup".startsWith("/srv/agents")` is `true`, so a sibling
 * directory sharing the prefix passes a bare `startsWith` — reproduced end to
 * end as an HTTP 200 through the full app. The repo already gets this right
 * three times elsewhere (storage/local.ts:27, utils/bundle.ts:70,
 * routes/files.ts:314); this brings the two scan sites in line.
 */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// --- Bundle builder (shares the .agent tar codec + exclude contract with the
// CLI `skrun build`, via @skrun-dev/schema — so the two writers never diverge). ---

export async function collectFiles(dir: string, base: string = dir): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (isExcludedEntry(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, base)));
    } else {
      files.push(relative(base, fullPath));
    }
  }

  return files.sort();
}

async function buildAgentBundle(agentDir: string): Promise<Buffer> {
  const files = await collectFiles(agentDir);
  const entries = files.map((file) => ({
    name: file,
    content: readFileSync(join(agentDir, file)),
  }));
  return packAgentTar(entries);
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
      if (!isInside(entryPath, resolvedDir)) continue;

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

    // `:name` is percent-decoded by Hono, so `..%2fagents-backup` arrives as a
    // traversal. Validate the segment as the registry routes do, BEFORE joining.
    if (!PATH_SEGMENT_REGEX.test(name)) {
      return c.json(
        {
          error: {
            code: "INVALID_AGENT_NAME",
            message: "Agent name must match ^[a-z0-9-]{1,64}$",
          },
        },
        400,
      );
    }

    const agentPath = join(resolvedDir, name);

    if (!isInside(agentPath, resolvedDir)) {
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

    // API-key scope (same gate as the regular push route — this is the second
    // push entrypoint and must not be a bypass).
    if (user.key) {
      try {
        const existing = await db.getAgent(user.namespace, name);
        assertKeyCanPushOrThrow(user, existing);
      } catch (err) {
        return dispatchRegistryError(c, err);
      }
    }

    // Build bundle in memory (tar.gz) — same format as skrun build
    const bundle = await buildAgentBundle(agentPath);

    try {
      const metadata = await service.push(user.namespace, name, version, bundle, user.id);
      return c.json(metadata);
    } catch (err) {
      return dispatchRegistryError(c, err);
    }
  });

  return router;
}
