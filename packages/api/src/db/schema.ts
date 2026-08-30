export interface Agent {
  id: string;
  name: string;
  namespace: string;
  description: string;
  owner_id: string;
  /**
   * Access control. `private` (default) ⇒ only the owner (or admin) can
   * `POST /run`; `public` ⇒ any authenticated caller can. Replaces the
   * legacy cross-tenant run default.
   */
  visibility: "private" | "public";
  /**
   * Caller-key policy for LLM-key resolution. `open` (default) ⇒ the chain is
   * caller > creator > server; `creator_only` ⇒ caller-provided keys are
   * rejected so the agent runs only on the creator-attached key (or the server
   * key, self-host). See services/creator-llm-key.ts + the run.ts policy gate.
   */
  llm_key_policy: AgentLlmKeyPolicy;
  created_at: string;
  updated_at: string;
}

/**
 * Caller-key policy for an agent's LLM-key resolution. `open` (default) lets a
 * caller bring their own `X-LLM-API-Key`; `creator_only` rejects caller keys so
 * the agent runs only on the creator-attached key (or the server key, self-host).
 */
export type AgentLlmKeyPolicy = "open" | "creator_only";

/**
 * Presence view of a creator-attached LLM key — what read endpoints return. The
 * plaintext key is NEVER exposed; only the provider, a display-only `last4`, and
 * the update time. (The ciphertext lives in AgentLlmKeyRecord, run-path only.)
 */
export interface AgentLlmKeyInfo {
  provider: string;
  last4: string;
  updated_at: string;
}

/**
 * Internal record of a creator-attached LLM key, including the encrypted
 * `ciphertext` (envelope version‖iv‖tag‖ct, base64). Only the harness reads this
 * to decrypt at run via the KeyProvider — it is never serialised to a client.
 */
export interface AgentLlmKeyRecord {
  agent_id: string;
  provider: string;
  ciphertext: string;
  last4: string;
  key_version: number;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  version: string;
  size: number;
  bundle_key: string;
  /**
   * SHA-256 (hex) of the bundle, set at push and verified at pull.
   * Nullable: legacy rows are backfilled at boot; new pushes always
   * set it (invariant in RegistryService.push).
   */
  bundle_sha256: string | null;
  config_snapshot?: Record<string, unknown>;
  notes: string | null;
  pushed_at: string;
  verified: boolean;
}

export interface AgentState {
  agent_id: string;
  state: Record<string, unknown>;
  updated_at: string;
}

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  github_id: string;
  username: string;
  email: string;
  avatar_url: string;
  plan: string;
  /**
   * Instance-level privilege. `admin` is the only role allowed to call
   * `PATCH /api/agents/:ns/:name/verify`. Default `user` for all newly
   * created accounts; dev-token in self-host mode is mapped to `admin` to
   * preserve the single-user UX. Promotion to admin in production requires
   * a manual SQL UPDATE — there is intentionally no API for elevation.
   */
  role: UserRole;
  created_at: string;
  updated_at: string;
}

/**
 * Resource binding of an API key. `account` (default) = the owner's whole
 * account (existing keys — non-breaking); `agents` = restricted to the agents
 * listed in `api_key_agents` (a delegated key). Orthogonal to the operation
 * scopes in `ApiKey.scopes`. Enforced by the auth layer (services/key-scope.ts).
 */
export type ApiKeyScopeKind = "account" | "agents";

/**
 * The default operation scopes of a newly-minted key (a "full" key) — also the
 * canonical full set that makes an account-wide key a master credential. A key
 * may be minted with a narrower subset (e.g. run-only). The DbAdapter applies
 * this default when `scopes` is omitted, so a key always carries explicit
 * operations (an empty list is a deliberate deny-all, never the default).
 */
export const API_KEY_DEFAULT_SCOPES: readonly string[] = [
  "agent:run",
  "agent:push",
  "agent:verify",
];

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  /** Operation scopes: `agent:run` | `agent:push` | `agent:verify`. */
  scopes: string[];
  /** Resource binding. Defaults to `account`. */
  scope_kind: ApiKeyScopeKind;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export type DeviceCodeStatus = "pending" | "authorized";

/**
 * A pending/authorized OAuth 2.0 Device Authorization Grant (RFC 8628), backing
 * the CLI device-login flow that replaced the loopback `?token=` redirect.
 * The device_code/user_code are stored SHA-256-HASHED (the raw codes live only in
 * transit, like `api_keys.key_hash`); the `sk_live` token is minted only at
 * poll-success, so this row holds no secret at rest. See routes/auth.ts (the
 * device endpoints) + auth/device-code.ts.
 */
export interface DeviceCode {
  device_code_hash: string;
  user_code_hash: string;
  /** PKCE (RFC 7636) S256 challenge; the poll requires the matching verifier. */
  code_challenge: string;
  status: DeviceCodeStatus;
  /** Bound at authorization (the GitHub-OAuth user); null while pending. */
  user_id: string | null;
  /** RFC 8628 slow_down back-off in seconds; +5 each slow_down. */
  current_interval: number;
  /** PKCE verifier attempts; the code is invalidated past the cap. */
  attempt_count: number;
  created_at: string;
  expires_at: string;
  last_polled_at: string | null;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface Run {
  id: string;
  agent_id: string | null;
  agent_version: string;
  model: string | null;
  environment_id: string | null;
  user_id: string | null;
  /**
   * The API key that initiated the run (per-key = per-client metering), or null
   * for session/dev-token runs. FK `ON DELETE SET NULL` — preserved on revoke.
   */
  api_key_id: string | null;
  status: RunStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  usage_prompt_tokens: number;
  usage_completion_tokens: number;
  usage_total_tokens: number;
  usage_estimated_cost: number;
  usage_cache_read_tokens: number;
  usage_cache_write_tokens: number;
  usage_cache_savings_usd: number;
  duration_ms: number | null;
  /**
   * Operator-only: the Fly machine id of the runner that served this run. Cloud
   * (Fly) runs only; null for local. Internal — not exposed in the run API.
   */
  machine_id: string | null;
  /**
   * Operator-only: the runner's private 6PN address. Cloud runs only; null for
   * local. Internal topology — not exposed in the run API.
   */
  private_ip: string | null;
  /**
   * Per-phase cold-start timing (ms) for the runner spawn — the `runner_spawned`
   * event's phases map. Cloud runs only; null for local.
   */
  phase_timings: Record<string, number> | null;
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
