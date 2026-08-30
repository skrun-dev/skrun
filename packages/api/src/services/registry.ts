import { createHash, timingSafeEqual } from "node:crypto";
import { createLogger } from "@skrun-dev/runtime";
import { parseAgentYaml } from "@skrun-dev/schema";
import { bundleCache } from "../cache/bundle-cache.js";
import type { DbAdapter } from "../db/adapter.js";
import type { Agent } from "../db/schema.js";
import type { AgentMetadata, AgentVersionInfo } from "../types.js";
import { extractFiles } from "../utils/bundle.js";

const logger = createLogger("registry-service");

/**
 * Status is encoded as the typed union of HTTP codes the service emits.
 * Callers can return `c.json(..., err.status)` without an `as` cast —
 * Hono's StatusCode parameter accepts this union directly.
 */
export type RegistryErrorStatus = 400 | 403 | 404 | 409 | 500;

export class RegistryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: RegistryErrorStatus,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export class RegistryService {
  constructor(
    private storage: import("../storage/adapter.js").StorageAdapter,
    private db: DbAdapter,
  ) {}

  async push(
    namespace: string,
    name: string,
    version: string,
    bundle: Buffer,
    userId: string,
    notes?: string | null,
  ): Promise<AgentMetadata> {
    // Get or create agent
    let agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      agent = await this.db.createAgent({
        name,
        namespace,
        description: "",
        owner_id: userId,
      });
    }

    // Check duplicate version
    const existing = await this.db.getVersionByNumber(agent.id, version);
    if (existing) {
      throw new RegistryError(
        "VERSION_EXISTS",
        `Version ${version} already exists for ${namespace}/${name}. Bump version in agent.yaml.`,
        409,
      );
    }

    // Store bundle
    const bundleKey = `${namespace}/${name}/${version}.agent`;
    await this.storage.put(bundleKey, bundle);

    // Checksum the bundle at push so pull() can verify integrity.
    // Always set for new pushes (the nullable column is only a backfill valve
    // for legacy rows).
    const bundleSha256 = createHash("sha256").update(bundle).digest("hex");

    // Extract config from bundle for config_snapshot
    let configSnapshot: Record<string, unknown> | undefined;
    try {
      const files = await extractFiles(bundle);
      const agentYamlContent = files["agent.yaml"];
      if (agentYamlContent) {
        const parsed = parseAgentYaml(agentYamlContent);
        configSnapshot = parsed.config as unknown as Record<string, unknown>;
      }
    } catch {
      // Config snapshot is best-effort — don't fail the push
    }

    // Create version record
    await this.db.createVersion(agent.id, {
      version,
      size: bundle.length,
      bundle_key: bundleKey,
      bundle_sha256: bundleSha256,
      config_snapshot: configSnapshot,
      notes: notes ?? null,
    });

    return this.buildMetadata(namespace, name);
  }

  async pull(
    namespace: string,
    name: string,
    version?: string,
    opts?: { preloadedAgent?: Agent },
  ): Promise<{ buffer: Buffer; version: string; verified: boolean }> {
    // Route layer (#80 multi-tenant gate) may pass `preloadedAgent` to skip
    // the redundant `db.getAgent` call after it has already done one for
    // the ownership check. Keeps `service.pull` testable in isolation while
    // letting the route layer enforce ownership BEFORE any storage fetch
    // (constant-time semantics — genuine-404 and ownership-404 share the
    // same code path on the route side).
    const agent = opts?.preloadedAgent ?? (await this.db.getAgent(namespace, name));
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    let resolvedVersion: string;
    let resolvedVerified: boolean;
    // Keep the resolved version's checksum for the integrity check
    // below (the row objects would otherwise be discarded here).
    let resolvedSha256: string | null;
    if (version) {
      const v = await this.db.getVersionByNumber(agent.id, version);
      if (!v) {
        throw new RegistryError(
          "VERSION_NOT_FOUND",
          `Version ${version} not found for ${namespace}/${name}`,
          404,
        );
      }
      resolvedVersion = v.version;
      resolvedVerified = v.verified;
      resolvedSha256 = v.bundle_sha256;
    } else {
      const latest = await this.db.getLatestVersion(agent.id);
      if (!latest) {
        throw new RegistryError("NO_VERSIONS", `No versions found for ${namespace}/${name}`, 404);
      }
      resolvedVersion = latest.version;
      resolvedVerified = latest.verified;
      resolvedSha256 = latest.bundle_sha256;
    }

    const bundleKey = `${namespace}/${name}/${resolvedVersion}.agent`;
    const buffer = await this.storage.get(bundleKey);
    if (!buffer) {
      throw new RegistryError("BUNDLE_NOT_FOUND", "Bundle file not found in storage", 500);
    }

    // Verify bundle integrity when a checksum is on record. This runs
    // on EVERY pull() call site — run execution AND the GET /pull download — so
    // a tampered storage object can never be served (universal verification).
    // A null checksum = a legacy bundle predating hashing (the boot backfill
    // populates these); log + serve rather than 500 a legitimate bundle.
    // timingSafeEqual is only reached with two equal-length buffers.
    if (resolvedSha256 != null) {
      const actualBuf = createHash("sha256").update(buffer).digest();
      const expectedBuf = Buffer.from(resolvedSha256, "hex");
      if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
        logger.error(
          {
            event: "bundle_integrity_failed",
            agent: `${namespace}/${name}`,
            version: resolvedVersion,
          },
          "Bundle integrity check failed — refusing to serve a tampered bundle",
        );
        throw new RegistryError(
          "BUNDLE_INTEGRITY_FAILED",
          `Bundle integrity check failed for ${namespace}/${name}@${resolvedVersion}`,
          500,
        );
      }
    } else {
      logger.warn(
        {
          event: "bundle_integrity_unknown",
          agent: `${namespace}/${name}`,
          version: resolvedVersion,
        },
        "Bundle has no stored checksum (legacy) — served unverified",
      );
    }

    return { buffer, version: resolvedVersion, verified: resolvedVerified };
  }

  async list(
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ agents: AgentMetadata[]; total: number }> {
    // `userId` is provided by the route layer when the caller is a
    // non-admin OAuth/API-key user (narrows results to own agents); it's
    // left undefined for admin callers (or dev-token mode → admin auto-
    // grant) so they see all agents instance-wide.
    const result = await this.db.listAgents({ page, limit, userId });
    const agents: AgentMetadata[] = [];
    for (const a of result.agents) {
      const versions = await this.db.getVersions(a.id);
      const latest = await this.db.getLatestVersion(a.id);
      agents.push({
        name: a.name,
        namespace: a.namespace,
        description: a.description,
        visibility: a.visibility,
        latest_version_verified: latest?.verified ?? false,
        latest_version: latest?.version ?? "",
        versions: versions.map((v) => v.version),
        created_at: a.created_at,
        updated_at: a.updated_at,
        run_count: a.run_count,
        token_count: a.token_count,
      });
    }
    return { agents, total: result.total };
  }

  async getMetadata(namespace: string, name: string): Promise<AgentMetadata> {
    return this.buildMetadata(namespace, name);
  }

  async getVersions(namespace: string, name: string): Promise<AgentVersionInfo[]> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const versions = await this.db.getVersions(agent.id);
    return versions.map((v) => ({
      version: v.version,
      size: v.size,
      pushed_at: v.pushed_at,
      config_snapshot: v.config_snapshot,
      notes: v.notes,
      verified: v.verified,
    }));
  }

  async deleteAgent(namespace: string, name: string): Promise<void> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    // Evict bundle cache + delete all version bundles from storage
    const versions = await this.db.getVersions(agent.id);
    for (const v of versions) {
      bundleCache.delete(`${namespace}/${name}/${v.version}`);
      await this.storage.delete(v.bundle_key).catch((err) =>
        logger.warn(
          {
            event: "bundle_delete_failed",
            bundle_key: v.bundle_key,
            error: err instanceof Error ? err.message : String(err),
          },
          "Best-effort bundle delete failed during agent delete — orphaned blob may remain",
        ),
      );
    }

    // Delete agent from DB (cascades to versions)
    await this.db.deleteAgent(namespace, name);
  }

  async deleteVersion(namespace: string, name: string, version: string): Promise<void> {
    // Step 1: load agent → 404 NOT_FOUND
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    // Step 2: load versions → 409 LAST_VERSION + 404 VERSION_NOT_FOUND
    const versions = await this.db.getVersions(agent.id);
    if (versions.length <= 1) {
      throw new RegistryError(
        "LAST_VERSION",
        `Cannot delete the last version of ${namespace}/${name}. Use DELETE /api/agents/:namespace/:name to remove the agent entirely.`,
        409,
      );
    }
    const target = versions.find((v) => v.version === version);
    if (!target) {
      throw new RegistryError(
        "VERSION_NOT_FOUND",
        `Version ${version} not found for ${namespace}/${name}`,
        404,
      );
    }

    // Step 3: evict bundle cache (prevent 10-min stale serve via TTL)
    bundleCache.delete(`${namespace}/${name}/${version}`);

    // Step 4: delete bundle from storage (best-effort, mirror deleteAgent pattern).
    // Order is mandatory: storage BEFORE db. Reverse order = silent storage leak forever.
    await this.storage.delete(target.bundle_key).catch((err) =>
      logger.warn(
        {
          event: "bundle_delete_failed",
          bundle_key: target.bundle_key,
          error: err instanceof Error ? err.message : String(err),
        },
        "Best-effort bundle delete failed during version delete — orphaned blob may remain",
      ),
    );

    // Step 5: delete DB row (final commit)
    await this.db.deleteVersion(agent.id, version);
  }

  async setVersionVerified(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<AgentVersionInfo> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const updated = await this.db.setVersionVerified(namespace, name, version, verified);
    if (!updated) {
      throw new RegistryError(
        "VERSION_NOT_FOUND",
        `Version ${version} not found for ${namespace}/${name}`,
        404,
      );
    }
    return {
      version: updated.version,
      size: updated.size,
      pushed_at: updated.pushed_at,
      config_snapshot: updated.config_snapshot,
      notes: updated.notes,
      verified: updated.verified,
    };
  }

  private async buildMetadata(namespace: string, name: string): Promise<AgentMetadata> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const versions = await this.db.getVersions(agent.id);
    const latest = await this.db.getLatestVersion(agent.id);
    // Previously hardcoded run_count/token_count to 0 — the dashboard and
    // CLI both surface these. Compute from listRuns aggregated by agent_id
    // (matches the per-agent semantic already exposed via listAgents and
    // getAgentStats — `limit: 0` returns the full run history for this agent).
    const runs = await this.db.listRuns({ agent_id: agent.id });
    const tokenTotal = runs.reduce((sum, r) => sum + (r.usage_total_tokens ?? 0), 0);
    return {
      name: agent.name,
      namespace: agent.namespace,
      description: agent.description,
      visibility: agent.visibility,
      latest_version_verified: latest?.verified ?? false,
      latest_version: latest?.version ?? "",
      versions: versions.map((v) => v.version),
      created_at: agent.created_at,
      updated_at: agent.updated_at,
      run_count: runs.length,
      token_count: tokenTotal,
    };
  }
}
