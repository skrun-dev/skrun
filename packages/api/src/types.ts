export interface AgentMetadata {
  name: string;
  namespace: string;
  description: string;
  verified: boolean;
  latest_version: string;
  versions: string[];
  created_at: string;
  updated_at: string;
  run_count: number;
  token_count: number;
}

export interface AgentVersionInfo {
  version: string;
  size: number;
  pushed_at: string;
  config_snapshot?: Record<string, unknown>;
  notes: string | null;
}

export interface RegistryErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface UserContext {
  id: string;
  namespace: string;
  username: string;
  email?: string;
  avatar_url?: string;
  plan?: string;
}
