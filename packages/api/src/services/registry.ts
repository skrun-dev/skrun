import type { MemoryDb } from "../db/memory.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { AgentMetadata, AgentVersionInfo } from "../types.js";

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
    private storage: StorageAdapter,
    private db: MemoryDb,
  ) {}

  async push(
    namespace: string,
    name: string,
    version: string,
    bundle: Buffer,
    userId: string,
    force = false,
  ): Promise<AgentMetadata> {
    // Get or create agent
    let agent = this.db.getAgent(namespace, name);
    if (!agent) {
      agent = this.db.createAgent({
        name,
        namespace,
        description: "",
        owner_id: userId,
      });
    }

    // Check duplicate version
    const existing = this.db.getVersionByNumber(agent.id, version);
    if (existing && !force) {
      throw new RegistryError(
        "VERSION_EXISTS",
        `Version ${version} already exists for ${namespace}/${name}. Bump version in agent.yaml.`,
        409,
      );
    }

    // Store bundle
    const bundleKey = `${namespace}/${name}/${version}.agent`;
    await this.storage.put(bundleKey, bundle);

    // Create version record
    this.db.replaceVersion(agent.id, {
      version,
      size: bundle.length,
      bundle_key: bundleKey,
    });

    return this.buildMetadata(namespace, name);
  }

  async pull(
    namespace: string,
    name: string,
    version?: string,
  ): Promise<{ buffer: Buffer; version: string }> {
    const agent = this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }

    let resolvedVersion: string;
    if (version) {
      const v = this.db.getVersionByNumber(agent.id, version);
      if (!v) {
        throw new RegistryError(
          "VERSION_NOT_FOUND",
          `Version ${version} not found for ${namespace}/${name}`,
          404,
        );
      }
      resolvedVersion = v.version;
    } else {
      const latest = this.db.getLatestVersion(agent.id);
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
    const result = this.db.listAgents(page, limit);
    const agents = result.agents.map((a) => {
      const versions = this.db.getVersions(a.id);
      const latest = this.db.getLatestVersion(a.id);
      return {
        name: a.name,
        namespace: a.namespace,
        description: a.description,
        verified: a.verified,
        latest_version: latest?.version ?? "",
        versions: versions.map((v) => v.version),
        created_at: a.created_at,
        updated_at: a.updated_at,
      };
    });
    return { agents, total: result.total };
  }

  async getMetadata(namespace: string, name: string): Promise<AgentMetadata> {
    return this.buildMetadata(namespace, name);
  }

  async getVersions(namespace: string, name: string): Promise<AgentVersionInfo[]> {
    const agent = this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    return this.db.getVersions(agent.id).map((v) => ({
      version: v.version,
      size: v.size,
      pushed_at: v.pushed_at,
    }));
  }

  async setVerified(namespace: string, name: string, verified: boolean): Promise<AgentMetadata> {
    const agent = this.db.setVerified(namespace, name, verified);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    return this.buildMetadata(namespace, name);
  }

  private buildMetadata(namespace: string, name: string): AgentMetadata {
    const agent = this.db.getAgent(namespace, name);
    if (!agent) {
      throw new RegistryError("NOT_FOUND", `Agent ${namespace}/${name} not found`, 404);
    }
    const versions = this.db.getVersions(agent.id);
    const latest = this.db.getLatestVersion(agent.id);
    return {
      name: agent.name,
      namespace: agent.namespace,
      description: agent.description,
      verified: agent.verified,
      latest_version: latest?.version ?? "",
      versions: versions.map((v) => v.version),
      created_at: agent.created_at,
      updated_at: agent.updated_at,
    };
  }
}
