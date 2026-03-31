import { randomUUID } from "node:crypto";
import type { Agent, AgentVersion } from "./schema.js";

export class MemoryDb {
  private agents = new Map<string, Agent>();
  private versions = new Map<string, AgentVersion[]>();

  private agentKey(namespace: string, name: string): string {
    return `${namespace}/${name}`;
  }

  createAgent(data: {
    name: string;
    namespace: string;
    description: string;
    owner_id: string;
  }): Agent {
    const key = this.agentKey(data.namespace, data.name);
    const now = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      ...data,
      verified: false,
      created_at: now,
      updated_at: now,
    };
    this.agents.set(key, agent);
    this.versions.set(agent.id, []);
    return agent;
  }

  getAgent(namespace: string, name: string): Agent | null {
    return this.agents.get(this.agentKey(namespace, name)) ?? null;
  }

  listAgents(page: number, limit: number): { agents: Agent[]; total: number } {
    const all = [...this.agents.values()];
    const start = (page - 1) * limit;
    return {
      agents: all.slice(start, start + limit),
      total: all.length,
    };
  }

  createVersion(
    agentId: string,
    data: { version: string; size: number; bundle_key: string },
  ): AgentVersion {
    const version: AgentVersion = {
      id: randomUUID(),
      agent_id: agentId,
      ...data,
      pushed_at: new Date().toISOString(),
    };
    const versions = this.versions.get(agentId) ?? [];
    versions.push(version);
    this.versions.set(agentId, versions);

    // Update agent's updated_at
    for (const agent of this.agents.values()) {
      if (agent.id === agentId) {
        agent.updated_at = version.pushed_at;
        break;
      }
    }

    return version;
  }

  replaceVersion(
    agentId: string,
    data: { version: string; size: number; bundle_key: string },
  ): AgentVersion {
    const versions = this.versions.get(agentId) ?? [];
    const nextVersion: AgentVersion = {
      id: randomUUID(),
      agent_id: agentId,
      ...data,
      pushed_at: new Date().toISOString(),
    };
    const existingIndex = versions.findIndex((version) => version.version === data.version);

    if (existingIndex >= 0) {
      versions[existingIndex] = nextVersion;
    } else {
      versions.push(nextVersion);
    }
    this.versions.set(agentId, versions);

    for (const agent of this.agents.values()) {
      if (agent.id === agentId) {
        agent.updated_at = nextVersion.pushed_at;
        break;
      }
    }

    return nextVersion;
  }

  getVersions(agentId: string): AgentVersion[] {
    return this.versions.get(agentId) ?? [];
  }

  getLatestVersion(agentId: string): AgentVersion | null {
    const versions = this.getVersions(agentId);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  getVersionByNumber(agentId: string, version: string): AgentVersion | null {
    const versions = this.getVersions(agentId);
    return versions.find((v) => v.version === version) ?? null;
  }

  setVerified(namespace: string, name: string, verified: boolean): Agent | null {
    const agent = this.getAgent(namespace, name);
    if (!agent) return null;
    agent.verified = verified;
    agent.updated_at = new Date().toISOString();
    return agent;
  }

  clear(): void {
    this.agents.clear();
    this.versions.clear();
  }
}
