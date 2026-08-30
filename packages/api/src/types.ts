import type { ApiKeyScopeKind } from "./db/schema.js";

export interface AgentMetadata {
  name: string;
  namespace: string;
  description: string;
  /**
   * Access control. `private` (default) ⇒ only the owner/admin can run the
   * agent; `public` ⇒ any authenticated caller can.
   */
  visibility: "private" | "public";
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

/**
 * The scope context of the `sk_live` API key that authenticated the request,
 * attached by the auth middleware. `null`/absent means the caller used a
 * session cookie or `dev-token` — an unrestricted "master credential".
 *
 * Scope enforcement (services/key-scope.ts) keys off THIS, never `role`: a
 * restricted/limited key restricts even an admin owner, because the key — not
 * the person — is the delegated credential.
 */
export interface KeyContext {
  /** The api_keys row id (recorded on runs.api_key_id for per-key metering). */
  id: string;
  /** `account` = the owner's whole account; `agents` = restricted to `agent_ids`. */
  scope_kind: ApiKeyScopeKind;
  /** Operation scopes: `agent:run` | `agent:push` | `agent:verify`. */
  operations: string[];
  /** Granted agent ids (only for `scope_kind === 'agents'`; empty = deny-all). */
  agent_ids: string[];
}

export interface UserContext {
  id: string;
  namespace: string;
  username: string;
  email?: string;
  avatar_url?: string;
  plan?: string;
  /**
   * API-key scope context (sk_live only). `null` for session/dev-token =
   * unrestricted master credential. Populated by the auth middleware.
   */
  key?: KeyContext | null;
  /**
   * Instance-level privilege. The auth middleware populates this from the
   * User row (`'user'` default, `'admin'` after a manual SQL promotion).
   * Dev-token mode maps to `'admin'` to preserve single-user self-host UX.
   * Routes gating on `user.role === 'admin'` (the per-version verify
   * endpoint, the DELETE admin override) read this field.
   */
  role: "admin" | "user";
}
