import {
  type QueryClient,
  type QueryState,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

// --- Types ---

export interface Stats {
  agents_count: number;
  runs_today: number;
  tokens_today: number;
  failed_today: number;
  runs_yesterday: number;
  tokens_yesterday: number;
  failed_yesterday: number;
  daily_runs: number[];
  daily_tokens: number[];
  daily_failed: number[];
  /** Total dollar savings (USD) produced by prompt-caching today. */
  cache_savings_today: number;
  /** Total dollar savings (USD) produced by prompt-caching yesterday. */
  cache_savings_yesterday: number;
  /** 7-day daily savings array (USD), oldest first; index 6 = today. */
  daily_cache_savings: number[];
  /** Total estimated cost (USD) today. */
  cost_today: number;
  /** Total estimated cost (USD) yesterday. */
  cost_yesterday: number;
  /** 7-day daily cost array (USD), oldest first; index 6 = today. */
  daily_cost: number[];
}

export interface AgentStats {
  runs: number;
  tokens: number;
  failed: number;
  avg_duration_ms: number;
  prev_runs: number;
  prev_tokens: number;
  prev_failed: number;
  prev_avg_duration_ms: number;
  daily_runs: number[];
  daily_tokens: number[];
  daily_failed: number[];
  daily_avg_duration_ms: number[];
  /** Total cache savings (USD) over the current period. */
  cache_savings: number;
  /** Cache savings over the previous period (same window length). */
  prev_cache_savings: number;
  /** Daily cache savings array (USD); length matches the `days` query param. */
  daily_cache_savings: number[];
  /** Total estimated cost (USD) over the current period. */
  cost: number;
  /** Cost over the previous period (same window length). */
  prev_cost: number;
  /** Daily cost array (USD); length matches the `days` query param. */
  daily_cost: number[];
}

export interface Agent {
  id: string;
  name: string;
  namespace: string;
  description: string;
  owner_id: string;
  /**
   * Access control. `private` (default) ⇒ only the owner/admin can run the
   * agent; `public` ⇒ any authenticated caller can. Optional for forward
   * compatibility with responses that predate the field.
   */
  visibility?: "private" | "public";
  /**
   * Verified state of the latest version (by push time). Drives the listing
   * badge. Computed by the registry service from `agent_versions.verified`
   * of the most recently pushed version. False when the agent has no
   * versions.
   */
  latest_version_verified: boolean;
  created_at: string;
  updated_at: string;
  run_count: number;
  token_count: number;
  /** Total estimated cost (USD) across all runs of this agent. */
  cost_total: number;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  version: string;
  size: number;
  bundle_key: string;
  pushed_at: string;
  config_snapshot?: Record<string, unknown>;
  notes: string | null;
  /**
   * Per-version verified state. Drives the per-row badge + Verify/Unverify
   * action button in the versions table on agent-detail.
   */
  verified: boolean;
}

export interface Run {
  id: string;
  agent_id: string | null;
  agent_version: string;
  user_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  usage_prompt_tokens: number;
  usage_completion_tokens: number;
  usage_total_tokens: number;
  usage_estimated_cost: number;
  /** Tokens served from the provider's prompt cache. 0 when no cache activity. */
  usage_cache_read_tokens: number;
  /** Tokens written to the provider's prompt cache (Anthropic only). */
  usage_cache_write_tokens: number;
  /**
   * Dollar savings (USD) produced by prompt-caching on this run. Snapshot at
   * write time; 0 for failed runs (no partial accounting).
   */
  usage_cache_savings_usd: number;
  model: string | null;
  duration_ms: number | null;
  /**
   * Files produced by the run, persisted at completion. Each entry mirrors
   * the SSE `run_complete.files[]` payload: `{name, size, url?, file_id?}`.
   * Consumed by the `FilesBlock` UI component to render download links.
   * Null for runs with no output files or for failed runs.
   */
  files: Array<{ name: string; size: number; url?: string; file_id?: string }> | null;
  created_at: string;
  completed_at: string | null;
}

export interface ScannedAgent {
  name: string;
  path: string;
  registered: boolean;
}

export interface ScanResult {
  agents: ScannedAgent[];
  configured: boolean;
}

export interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  /** Resource binding: `account` (the whole account) or `agents` (scoped). */
  scope_kind: "account" | "agents";
  created_at: string;
  last_used_at: string | null;
  /** When the key stops being accepted; `null` means it never expires. */
  expires_at: string | null;
}

export interface CreateKeyInput {
  name: string;
  /** `account` (default) or `agents` (a list of `namespace/name` you own). */
  scope_kind?: "account" | "agents";
  agents?: string[];
  /** Operation scopes; omit for a full key (`agent:run/push/verify`). */
  scopes?: string[];
  /** ISO-8601 instant; omit for a key that never expires. */
  expires_at?: string;
}

/**
 * An account's fast runs of the rolling hour, in `GET /api/usage` — told only
 * while a runner pool runs. A manual copy of the API's `FastRunsUsage`, like
 * the other types of this file: same field names, nothing imported.
 */
export interface FastRunsUsage {
  /** The runs per rolling hour entitled to a pooled machine; `null` when that bound is off, `0` for a plan that includes none. */
  limit: number | null;
  /** Those left now, never below 0; `null` when the bound is off. */
  remaining: number | null;
  /** When the next right comes back (ISO-8601); `null` when nothing comes back or the bound is off. */
  resets_at: string | null;
}

/**
 * The body of `GET /api/usage` — what the account consumes now. A manual copy
 * of the API's `UsageResponse`: same field names, nothing imported.
 */
export interface UsageResponse {
  /** The plan whose thresholds apply, as the server names it. */
  plan: string;
  /**
   * `null` when the server sets no quota at all. The seats and the compute
   * each `null` when their bound is off; the fast runs `null` only while no
   * runner pool runs.
   */
  quotas: {
    concurrent_runs: { limit: number; in_use: number } | null;
    compute: {
      limit_seconds: number;
      /** The charged time of the window's runs, in whole seconds (rounded down). */
      used_seconds: number;
      /** The current window, aligned on UTC (ISO-8601): start included, end excluded. */
      window: { start: string; end: string };
    } | null;
    fast_runs: FastRunsUsage | null;
  } | null;
}

/**
 * The body of `GET /api/instance` — what the instance tells whoever is signed
 * in about itself: the links its dashboard shows. A manual copy of the API's
 * `InstanceResponse`: same field names, nothing imported.
 */
export interface InstanceResponse {
  links: {
    /** Where the docs are: the operator's address, or this server's API reference (`/docs`). */
    docs: string;
    /** The operator's terms; `null` when none is set. */
    terms: string | null;
    /** The operator's privacy policy; `null` when none is set. */
    privacy: string | null;
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// --- Auth token ---
// "none" = use cookies (OAuth mode), string = use Bearer token, undefined = not yet set
let _authToken: string | "none" | undefined;

export function setAuthToken(token: string | "none") {
  _authToken = token;
}

export function getAuthHeaders(): Record<string, string> {
  if (_authToken === "none" || _authToken === undefined) {
    // OAuth mode (session cookie) or not yet initialized — no Authorization header
    return {};
  }
  return { Authorization: `Bearer ${_authToken}` };
}

// --- Base fetch ---

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: { code: "UNKNOWN", message: res.statusText } }));
    throw new ApiError(
      res.status,
      body.error?.code ?? "UNKNOWN",
      body.error?.message ?? res.statusText,
    );
  }

  return res.json() as Promise<T>;
}

async function apiFetchRaw(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: { code: "UNKNOWN", message: res.statusText } }));
    throw new ApiError(
      res.status,
      body.error?.code ?? "UNKNOWN",
      body.error?.message ?? res.statusText,
    );
  }

  return res;
}

// --- Query Hooks ---

export interface MeResponse {
  id: string;
  username: string;
  namespace: string;
  email?: string | null;
  avatar_url?: string | null;
  plan: string;
  role: "admin" | "user";
  /** Operator verification policy (read-only). Missing = legacy "admin". */
  verification_policy?: "admin" | "owner" | "disabled";
}

export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => apiFetch("/me"),
    staleTime: 5 * 60_000, // identity is stable across a session
  });
}

/**
 * The instance's links, read once per session: they change only when the
 * server restarts. A failed read is asked again as the app's default `retry`
 * says, and the links then fall back (`instanceLinks`).
 */
export function useInstance() {
  return useQuery<InstanceResponse>({
    queryKey: ["instance"],
    queryFn: () => apiFetch("/instance"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** One field of `value`, when `value` is an object; nothing otherwise. */
function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The links the dashboard shows, from the answer of `useInstance()` as it
 * comes: each kept only when it is a string. With no answer — a read that
 * failed or is still under way —, a field missing or not a string: the docs
 * stay `/docs`, and no terms nor privacy link is shown.
 */
export function instanceLinks(data: InstanceResponse | undefined): {
  docs: string;
  terms: string | null;
  privacy: string | null;
} {
  const links = fieldOf(data, "links");
  const docs = fieldOf(links, "docs");
  const terms = fieldOf(links, "terms");
  const privacy = fieldOf(links, "privacy");
  return {
    docs: typeof docs === "string" ? docs : "/docs",
    terms: typeof terms === "string" ? terms : null,
    privacy: typeof privacy === "string" ? privacy : null,
  };
}

export function useStats() {
  return useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => apiFetch("/stats"),
    staleTime: 60_000,
  });
}

/** The query of the account's usage — invalidated when a playground run ends. */
export const USAGE_QUERY_KEY = ["usage"] as const;

/**
 * How long after an instant the usage changes at it is read again. A server
 * whose clock is behind the browser's by less than this is past the instant
 * too; one further behind answers as before it, and that answer is read again
 * as one whose instant is already past.
 */
export const USAGE_REREAD_MARGIN_MS = 2_000;

/** The bounds of a wait that grows with what calls for it: as long again, within these. */
const WAIT_MIN_MS = 5_000;
const WAIT_MAX_MS = 5 * 60_000;

/** The soonest a read is set: a delay of 0 sets no timer at all. */
const SOONEST_MS = 1;

/** The longest delay a timer holds (2^31 − 1 ms, about 24.8 days): a longer one fires at once. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** The wait before a read when what calls for it began `elapsed` ago: as long again, 5 s to 5 min. */
function growingWait(elapsed: number): number {
  return Math.min(Math.max(elapsed, WAIT_MIN_MS), WAIT_MAX_MS);
}

/** A refused answer — a 4xx: asking again would get the same. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status < 500;
}

/** The usage query, as the delay reads it. */
interface UsageQuery {
  state: QueryState<UsageResponse>;
}

/** When the failures of each usage query began: its first failure since its last answer. */
const failuresBegan = new WeakMap<UsageQuery, number>();

/** When the query's failures since its last answer began — the last failure, for the first of them. */
function failingSince(query: UsageQuery): number {
  const { dataUpdatedAt, errorUpdatedAt } = query.state;
  const began = failuresBegan.get(query);
  if (began !== undefined && began > dataUpdatedAt) return began;
  failuresBegan.set(query, errorUpdatedAt);
  return errorUpdatedAt;
}

/**
 * The delay until the usage is read again; `false` when nothing calls for a
 * read. While a read is under way, or waits — for the network, or for its tab
 * to come back to the front before it is tried again —, none: its outcome
 * sets the next. After a refusal, none. After any other failure, the usage is
 * read again after as long as has passed since its failures began, 5 s at
 * least and 5 min at most, counted from the last one, until an answer comes.
 * After an answer, at the instants where the usage changes by itself: the end
 * of the compute window, the return of a fast run. One still to come when the
 * answer arrived is read the margin after it. One already past by then says
 * the server's clock is behind the browser's, not yet at it: the answer is
 * read again after as long as had passed since that instant, 5 s at least and
 * 5 min at most, until an answer moves past it. The nearer read wins. Each is
 * set at a fixed moment, so a render does not put it back, and one whose
 * moment has gone by with nothing after it — a timer held back in a hidden
 * tab — is made at once. The answer is read as it comes: a field missing, or
 * not a text that reads as a date, gives no instant.
 */
function usageRereadDelay(query: UsageQuery, now: number): number | false {
  const { state } = query;
  if (state.fetchStatus !== "idle") return false;
  let next: number;
  if (state.status === "error") {
    if (isRefusal(state.error)) return false;
    const last = state.errorUpdatedAt;
    next = last + growingWait(last - failingSince(query));
  } else {
    const receivedAt = state.dataUpdatedAt;
    const quotas = state.data?.quotas;
    const reads = [quotas?.compute?.window?.end, quotas?.fast_runs?.resets_at]
      .map((value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
      .map((at) =>
        at > receivedAt ? at + USAGE_REREAD_MARGIN_MS : receivedAt + growingWait(receivedAt - at),
      )
      .filter((read) => !Number.isNaN(read));
    if (reads.length === 0) return false;
    next = Math.min(...reads);
  }
  return Math.min(Math.max(next - now, SOONEST_MS), LONGEST_TIMER_MS);
}

type AppRetry = NonNullable<ReturnType<QueryClient["getDefaultOptions"]>["queries"]>["retry"];

/** Whether the app's default `retry` asks again — read as the query library reads it: 3 tries when unset. */
function appRetries(retry: AppRetry, failures: number, error: Error): boolean {
  if (typeof retry === "function") return retry(failures, error);
  if (typeof retry === "number") return failures < retry;
  return retry ?? failures < 3;
}

/**
 * The account's usage. Its freshness is the app's default: the numbers move
 * with every run, so it is kept shorter than the statistics'. It is read
 * again when it changes by itself, in a background tab too — the app never
 * reads again when a tab comes back to the front. A refused answer (a 4xx) is
 * not asked again. Any other failure is asked again as the app's default
 * `retry` says, then read again after a wait that grows, 5 s to 5 min, until
 * an answer comes.
 */
export function useUsage() {
  const appRetry = useQueryClient().getDefaultOptions().queries?.retry;
  return useQuery<UsageResponse>({
    queryKey: USAGE_QUERY_KEY,
    queryFn: () => apiFetch("/usage"),
    retry: (failures, error) => !isRefusal(error) && appRetries(appRetry, failures, error),
    refetchInterval: (query) => usageRereadDelay(query, Date.now()),
    refetchIntervalInBackground: true,
  });
}

export function useAgents(page = 1, limit = 50) {
  return useQuery<{ agents: Agent[]; total: number }>({
    queryKey: ["agents", page, limit],
    queryFn: () => apiFetch(`/agents?page=${page}&limit=${limit}`),
    staleTime: 30_000,
  });
}

export function useAgent(namespace: string, name: string) {
  return useQuery<Agent>({
    queryKey: ["agent", namespace, name],
    queryFn: () => apiFetch(`/agents/${namespace}/${name}`),
    staleTime: 30_000,
  });
}

export function useAgentVersions(namespace: string, name: string) {
  return useQuery<AgentVersion[]>({
    queryKey: ["agent-versions", namespace, name],
    queryFn: async () => {
      const data = await apiFetch<{ versions: AgentVersion[] }>(
        `/agents/${namespace}/${name}/versions`,
      );
      return data.versions;
    },
    staleTime: 60_000,
  });
}

export function useAgentStats(namespace: string, name: string, days = 7) {
  return useQuery<AgentStats>({
    queryKey: ["agent-stats", namespace, name, days],
    queryFn: () => apiFetch(`/agents/${namespace}/${name}/stats?days=${days}`),
    staleTime: 60_000,
  });
}

export function useRecentRuns(agentId?: string, limit = 10) {
  return useQuery<Run[]>({
    queryKey: ["runs", agentId, limit],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (agentId) params.set("agent_id", agentId);
      return apiFetch(`/runs?${params}`);
    },
    staleTime: 30_000,
  });
}

export interface RunFilters {
  status?: string;
  agent_id?: string;
  limit?: number;
}

export function useFilteredRuns(filters: RunFilters = {}) {
  return useQuery<Run[]>({
    queryKey: ["runs-filtered", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.agent_id) params.set("agent_id", filters.agent_id);
      params.set("limit", String(filters.limit ?? 50));
      return apiFetch(`/runs?${params}`);
    },
    staleTime: 15_000,
  });
}

export function useRun(id: string) {
  return useQuery<Run>({
    queryKey: ["run", id],
    queryFn: () => apiFetch(`/runs/${id}`),
    staleTime: 30_000,
    enabled: !!id,
  });
}

export interface RunEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp?: string;
}

export function useScanAgents() {
  return useQuery<ScanResult>({
    queryKey: ["agents-scan"],
    queryFn: () => apiFetch("/agents/scan"),
    staleTime: 10_000,
  });
}

// --- Mutation Hooks ---

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      apiFetchRaw(`/agents/${namespace}/${name}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

/**
 * Per-version verify mutation. Calls the new
 * `PATCH /api/agents/:ns/:name/versions/:version/verify` endpoint (admin only
 * — non-admin callers receive 403 from the server). Invalidates the three
 * query keys that source the dashboard surfaces affected by a verify flip:
 * single-agent metadata, the versions table, and the listing badge stat.
 */
export function useVerifyVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      name,
      version,
      verified,
    }: {
      namespace: string;
      name: string;
      version: string;
      verified: boolean;
    }) =>
      apiFetch(`/agents/${namespace}/${name}/versions/${version}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ verified }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agent", variables.namespace, variables.name] });
      queryClient.invalidateQueries({
        queryKey: ["agent-versions", variables.namespace, variables.name],
      });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/**
 * Agent visibility mutation. Calls `PATCH /api/agents/:ns/:name/visibility`
 * (namespace owner / admin — non-owners receive 403 from the server).
 * Invalidates the single-agent metadata + the listing so the badge updates.
 */
export function useSetVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      name,
      visibility,
    }: {
      namespace: string;
      name: string;
      visibility: "private" | "public";
    }) =>
      apiFetch(`/agents/${namespace}/${name}/visibility`, {
        method: "PATCH",
        body: JSON.stringify({ visibility }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agent", variables.namespace, variables.name] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

// ── Creator-attached LLM keys ───────────────────────────────────────────────

export type AgentLlmKeyPolicy = "open" | "creator_only";

/** Presence of a creator-attached LLM key — the plaintext is never returned. */
export interface AgentLlmKeyInfo {
  provider: string;
  last4: string;
  updated_at?: string;
}

export interface AgentLlmKeysResponse {
  policy: AgentLlmKeyPolicy;
  keys: AgentLlmKeyInfo[];
}

/** An agent's caller-key policy + the presence of its creator LLM keys (write-only). */
export function useAgentLlmKeys(namespace: string, name: string) {
  return useQuery<AgentLlmKeysResponse>({
    queryKey: ["agent-llm-keys", namespace, name],
    queryFn: () => apiFetch(`/agents/${namespace}/${name}/llm-keys`),
  });
}

/** Attach (or replace) the creator's LLM key for a provider. Body never echoed. */
export function useSetAgentLlmKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      name,
      provider,
      key,
    }: {
      namespace: string;
      name: string;
      provider: string;
      key: string;
    }) =>
      apiFetch(`/agents/${namespace}/${name}/llm-keys/${provider}`, {
        method: "PUT",
        body: JSON.stringify({ key }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["agent-llm-keys", variables.namespace, variables.name],
      });
    },
  });
}

export function useRemoveAgentLlmKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      name,
      provider,
    }: {
      namespace: string;
      name: string;
      provider: string;
    }) => apiFetchRaw(`/agents/${namespace}/${name}/llm-keys/${provider}`, { method: "DELETE" }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["agent-llm-keys", variables.namespace, variables.name],
      });
    },
  });
}

export function useSetLlmKeyPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      name,
      policy,
    }: {
      namespace: string;
      name: string;
      policy: AgentLlmKeyPolicy;
    }) =>
      apiFetch(`/agents/${namespace}/${name}/llm-key-policy`, {
        method: "PUT",
        body: JSON.stringify({ policy }),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["agent-llm-keys", variables.namespace, variables.name],
      });
    },
  });
}

export function useImportAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      namespace,
      name,
      version,
      bundle,
    }: {
      namespace: string;
      name: string;
      version: string;
      bundle: ArrayBuffer;
    }) => {
      await apiFetchRaw(`/agents/${namespace}/${name}/push?version=${version}`, {
        method: "POST",
        body: bundle,
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agents-scan"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

export function usePushScannedAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      await apiFetch(`/agents/scan/${name}/push`, { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agents-scan"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });
}

// --- API Keys ---

export function useApiKeys() {
  return useQuery<ApiKey[]>({
    queryKey: ["api-keys"],
    queryFn: () => apiFetch("/keys"),
    staleTime: 30_000,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateKeyInput) =>
      apiFetch<{ key: string; agents: string[] } & ApiKey>("/keys", {
        method: "POST",
        // This body enumerates its fields explicitly: a field added to the
        // input type but not listed here is dropped in silence — the code
        // compiles and the request leaves without the value.
        body: JSON.stringify({
          name: input.name || "Unnamed key",
          scope_kind: input.scope_kind ?? "account",
          agents: input.agents ?? [],
          scopes: input.scopes,
          expires_at: input.expires_at,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetchRaw(`/keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}
