import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/shared/empty-state";
import { IconSearch } from "../components/shared/icons";
import { Pagination } from "../components/shared/pagination";
import { PageHeader, StatusPill } from "../components/shared/ui";
import { useFilteredRuns } from "../lib/api-client";

const STATUS_OPTIONS = ["all", "completed", "failed", "running", "cancelled"] as const;
const PAGE_SIZE = 20;

export function RunsPage() {
  const [searchParams] = useSearchParams();
  const [searchFilter, setSearchFilter] = useState(searchParams.get("agent") ?? "");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  const {
    data: runs,
    isLoading,
    error,
  } = useFilteredRuns({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });

  // Client-side status counts
  const statusCounts = useMemo(() => {
    if (!runs) return { all: 0, completed: 0, failed: 0, running: 0, cancelled: 0 };
    const counts = { all: runs.length, completed: 0, failed: 0, running: 0, cancelled: 0 };
    for (const run of runs) {
      if (run.status in counts) counts[run.status as keyof typeof counts]++;
    }
    return counts;
  }, [runs]);

  // When filtering client-side, recompute from full list
  const allRuns = useFilteredRuns({ limit: 100 });
  const allCounts = useMemo(() => {
    if (!allRuns.data) return statusCounts;
    const counts = { all: allRuns.data.length, completed: 0, failed: 0, running: 0, cancelled: 0 };
    for (const run of allRuns.data) {
      if (run.status in counts) counts[run.status as keyof typeof counts]++;
    }
    return counts;
  }, [allRuns.data, statusCounts]);

  // Apply search filter client-side
  const displayRuns = useMemo(() => {
    if (!runs) return [];
    if (!searchFilter) return runs;
    const q = searchFilter.toLowerCase();
    return runs.filter(
      (r) =>
        r.agent_version?.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        r.model?.toLowerCase().includes(q),
    );
  }, [runs, searchFilter]);

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500 dark:text-red-400">Failed to load runs.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Runs"
        description="Every execution of every agent. Click a row for full I/O + event timeline."
      />

      {/* Search + Status filter chips */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center gap-2 h-8 w-[240px] px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-500/15 transition">
          <IconSearch className="w-[13px] h-[13px] text-gray-400" />
          <input
            className="flex-1 bg-transparent outline-none text-[12.5px] text-gray-800 dark:text-gray-200 placeholder:text-gray-400"
            placeholder="Filter by agent, ID, model..."
            value={searchFilter}
            onChange={(e) => {
              setSearchFilter(e.target.value);
              setPage(1);
            }}
          />
          {searchFilter && (
            <button
              type="button"
              onClick={() => setSearchFilter("")}
              className="text-gray-400 hover:text-gray-600 text-[11px]"
            >
              &times;
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 mb-4">
        {STATUS_OPTIONS.map((s) => {
          const count = allCounts[s];
          const isActive = statusFilter === s;
          const dotColor =
            s === "completed"
              ? "bg-emerald-500"
              : s === "running"
                ? "bg-amber-500"
                : s === "failed"
                  ? "bg-red-500"
                  : s === "cancelled"
                    ? "bg-gray-400"
                    : "";
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
              className={`h-7 px-2.5 rounded-md text-[11.5px] font-medium flex items-center gap-1.5 transition-colors ${
                isActive
                  ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900"
              }`}
            >
              {s !== "all" && <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />}
              <span className="capitalize">{s}</span>
              <span
                className={`text-[10.5px] tabular-nums ${isActive ? "text-white/60 dark:text-gray-900/60" : "text-gray-400 dark:text-gray-600"}`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-900 overflow-hidden">
          <div className="divide-y divide-gray-100 dark:divide-gray-900">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={`skel-${i}`} className="px-4 py-3.5">
                <div className="h-4 w-3/4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ) : !displayRuns || displayRuns.length === 0 ? (
        <EmptyState title="No runs yet" description="Run an agent to see activity here." />
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-gray-900 overflow-hidden bg-white dark:bg-gray-950/40">
          {/* Header row */}
          <div className="grid grid-cols-[100px_1fr_100px_90px_80px_80px_80px] gap-3 px-4 h-9 bg-gray-50/60 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-900 text-[10.5px] font-medium uppercase tracking-[0.06em] text-gray-500 items-center">
            <span>Status</span>
            <span>Run ID &middot; Agent</span>
            <span>Model</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Duration</span>
            <span className="text-right">Cost</span>
            <span className="text-right">When</span>
          </div>
          {/* Rows */}
          <div className="divide-y divide-gray-100 dark:divide-gray-900">
            {displayRuns.map((run) => (
              <Link
                key={run.id}
                to={`/runs/${run.id}`}
                className="group grid grid-cols-[100px_1fr_100px_90px_80px_80px_80px] gap-3 px-4 h-12 items-center hover:bg-gray-50/60 dark:hover:bg-gray-900/30"
              >
                <StatusPill status={run.status} />
                <div className="min-w-0 flex items-center gap-3">
                  <span className="font-mono text-[11.5px] text-gray-900 dark:text-gray-100">
                    {run.id.slice(0, 10)}
                  </span>
                  <span className="text-[11.5px] text-gray-500 dark:text-gray-500 truncate">
                    {extractAgentName(run.agent_version)}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-gray-500 dark:text-gray-500 truncate">
                  {run.model ?? "—"}
                </span>
                <span className="text-[12px] tabular-nums text-gray-700 dark:text-gray-300 text-right font-mono">
                  {run.usage_total_tokens > 0 ? run.usage_total_tokens.toLocaleString() : "—"}
                </span>
                <span className="text-[12px] tabular-nums text-gray-500 dark:text-gray-500 text-right font-mono">
                  {run.duration_ms !== null ? formatDuration(run.duration_ms) : "—"}
                </span>
                <span className="text-[12px] tabular-nums text-gray-500 dark:text-gray-500 text-right font-mono">
                  {run.usage_estimated_cost > 0 ? `$${run.usage_estimated_cost.toFixed(4)}` : "—"}
                </span>
                <span className="text-[11.5px] text-gray-400 dark:text-gray-600 text-right">
                  {formatRelativeTime(run.created_at)}
                </span>
              </Link>
            ))}
          </div>
          {/* Footer */}
          <div className="flex items-center justify-between px-4 h-10 border-t border-gray-200 dark:border-gray-900 bg-gray-50/40 dark:bg-gray-900/20 text-[11.5px] text-gray-500">
            <span>{displayRuns.length > 0 ? `1\u2013${displayRuns.length}` : "0 runs"}</span>
            <Pagination
              page={page}
              totalPages={Math.ceil((displayRuns?.length ?? 0) / PAGE_SIZE) || 1}
              onPageChange={setPage}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function extractAgentName(agentVersion: string): string {
  if (!agentVersion) return "unknown";
  const atIndex = agentVersion.indexOf("@");
  return atIndex > 0 ? agentVersion.slice(0, atIndex) : agentVersion;
}
