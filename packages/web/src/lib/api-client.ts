import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
}

export interface Agent {
  id: string;
  name: string;
  namespace: string;
  description: string;
  owner_id: string;
  verified: boolean;
  created_at: string;
  updated_at: string;
  run_count: number;
  token_count: number;
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
  model: string | null;
  duration_ms: number | null;
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
  created_at: string;
  last_used_at: string | null;
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
let _authToken: string | "none" | undefined = undefined;

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

export function useStats() {
  return useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => apiFetch("/stats"),
    staleTime: 60_000,
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

export function useVerifyAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      namespace,
      name,
      verified,
    }: { namespace: string; name: string; verified: boolean }) =>
      apiFetch(`/agents/${namespace}/${name}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ verified }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent"] });
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
    }: { namespace: string; name: string; version: string; bundle: ArrayBuffer }) => {
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
    mutationFn: (name: string) =>
      apiFetch<{ key: string } & ApiKey>("/keys", {
        method: "POST",
        body: JSON.stringify({ name: name || "Unnamed key" }),
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
