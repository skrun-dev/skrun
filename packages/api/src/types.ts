export interface AgentMetadata {
  name: string;
  namespace: string;
  description: string;
  /**
   * Verified state of the latest version (by push time). Computed at read
   * time from `agent_versions.verified` of the most recently pushed version.
   * Drives the dashboard listing badge.
   */
  latest_version_verified: boolean;
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
  /**
   * Per-version verified state. Gated by `PATCH /api/agents/:ns/:name/versions/:version/verify`
   * (admin only). Drives per-row badge + Verify/Unverify toggle in the dashboard
   * versions table.
   */
  verified: boolean;
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
  /**
   * Instance-level privilege. The auth middleware populates this from the
   * User row (`'user'` default, `'admin'` after a manual SQL promotion).
   * Dev-token mode maps to `'admin'` to preserve single-user self-host UX.
   * Routes gating on `user.role === 'admin'` (the per-version verify
   * endpoint, the DELETE admin override) read this field.
   */
  role: "admin" | "user";
}
