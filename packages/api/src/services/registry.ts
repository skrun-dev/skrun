import { parseAgentYaml } from "@skrun-dev/schema";
import type { DbAdapter } from "../db/adapter.js";
import type { AgentMetadata, AgentVersionInfo } from "../types.js";
import { extractFiles } from "../utils/bundle.js";

export class RegistryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
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

    // Extract config from bundle for config_snapshot
    let configSnapshot: Record<string, unknown> | undefined;
    try {
      const files = extractFiles(bundle);
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
      config_snapshot: configSnapshot,
      notes: notes ?? null,
    });

    return this.buildMetadata(namespace, name);
  }

  async pull(
    namespace: string,
    name: string,
    version?: string,
  ): Promise<{ buffer: Buffer; version: string }> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    let resolvedVersion: string;
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
    } else {
      const latest = await this.db.getLatestVersion(agent.id);
      if (!latest) {
        throw new RegistryError("NO_VERSIONS", `No versions found for ${namespace}/${name}`, 404);
      }
      resolvedVersion = latest.version;
    }

    const bundleKey = `${namespace}/${name}/${resolvedVersion}.agent`;
    const buffer = await this.storage.get(bundleKey);
    if (!buffer) {
      throw new RegistryError("BUNDLE_NOT_FOUND", "Bundle file not found in storage", 500);
    }

    return { buffer, version: resolvedVersion };
  }

  async list(page: number, limit: number): Promise<{ agents: AgentMetadata[]; total: number }> {
    const result = await this.db.listAgents(page, limit);
    const agents: AgentMetadata[] = [];
    for (const a of result.agents) {
      const versions = await this.db.getVersions(a.id);
      const latest = await this.db.getLatestVersion(a.id);
      agents.push({
        name: a.name,
        namespace: a.namespace,
        description: a.description,
        verified: a.verified,
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
    }));
  }

  async deleteAgent(namespace: string, name: string): Promise<void> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    // Delete all version bundles from storage
    const versions = await this.db.getVersions(agent.id);
    for (const v of versions) {
      await this.storage.delete(v.bundle_key).catch(() => {});
    }

    // Delete agent from DB (cascades to versions)
    await this.db.deleteAgent(namespace, name);
  }

  async setVerified(namespace: string, name: string, verified: boolean): Promise<AgentMetadata> {
    const agent = await this.db.setVerified(namespace, name, verified);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    return this.buildMetadata(namespace, name);
  }

  private async buildMetadata(namespace: string, name: string): Promise<AgentMetadata> {
    const agent = await this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const versions = await this.db.getVersions(agent.id);
    const latest = await this.db.getLatestVersion(agent.id);
    return {
      name: agent.name,
      namespace: agent.namespace,
      description: agent.description,
      verified: agent.verified,
      latest_version: latest?.version ?? "",
      versions: versions.map((v) => v.version),
      created_at: agent.created_at,
      updated_at: agent.updated_at,
      run_count: 0,
      token_count: 0,
    };
  }
}
