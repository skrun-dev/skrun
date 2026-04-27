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
  config_snapshot?: Record<string, unknown>;
  notes: string | null;
  pushed_at: string;
}

export interface AgentState {
  agent_id: string;
  state: Record<string, unknown>;
  updated_at: string;
}

export interface User {
  id: string;
  github_id: string;
  username: string;
  email: string;
  avatar_url: string;
  plan: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface Run {
  id: string;
  agent_id: string | null;
  agent_version: string;
  model: string | null;
  environment_id: string | null;
  user_id: string | null;
  status: RunStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  usage_prompt_tokens: number;
  usage_completion_tokens: number;
  usage_total_tokens: number;
  usage_estimated_cost: number;
  duration_ms: number | null;
  files: Record<string, unknown>[] | null;
  created_at: string;
  completed_at: string | null;
}

export interface Environment {
  id: string;
  name: string;
  owner_id: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
