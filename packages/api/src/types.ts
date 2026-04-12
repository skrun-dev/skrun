export interface AgentMetadata {
  name: string;
  namespace: string;
  description: string;
  verified: boolean;
  latest_version: string;
  versions: string[];
  created_at: string;
  updated_at: string;
}

export interface AgentVersionInfo {
  version: string;
  size: number;
  pushed_at: string;
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
}
