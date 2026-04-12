export interface Agent {
  id: string;
  name: string;
  namespace: string;
  description: string;
  owner_id: string;
  verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  version: string;
  size: number;
  bundle_key: string;
  pushed_at: string;
}
