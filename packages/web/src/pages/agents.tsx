import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ImportDialog } from "../components/agents/import-dialog";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { EmptyState } from "../components/shared/empty-state";
import { IconCheck, IconPlay, IconPlus, IconSearch } from "../components/shared/icons";
import { Pagination } from "../components/shared/pagination";
import { Btn, PageHeader, Pill } from "../components/shared/ui";
import { useAgents, useDeleteAgent } from "../lib/api-client";

const PAGE_SIZE = 50;

export function AgentsPage() {
  const [page, setPage] = useState(1);
  const [namespaceFilter, setNamespaceFilter] = useState("");
  const [verifiedFilter, setVerifiedFilter] = useState<"all" | "verified" | "unverified">("all");
  const [sortKey, setSortKey] = useState<"name" | "run_count" | "token_count" | "updated_at">(
    "name",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [deleteTarget, setDeleteTarget] = useState<{ namespace: string; name: string } | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);

  const navigate = useNavigate();
  const { data, isLoading, error } = useAgents(page, PAGE_SIZE);
  const deleteAgent = useDeleteAgent();

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const filteredAgents = useMemo(() => {
    if (!data?.agents) return [];
    let result = [...data.agents];
    if (namespaceFilter) {
      result = result.filter(
        (a) => a.namespace.includes(namespaceFilter) || a.name.includes(namespaceFilter),
      );
    }
    if (verifiedFilter === "verified") result = result.filter((a) => a.verified);
    if (verifiedFilter === "unverified") result = result.filter((a) => !a.verified);
    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name")
        cmp = `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`);
      else if (sortKey === "run_count") cmp = a.run_count - b.run_count;
      else if (sortKey === "token_count") cmp = a.token_count - b.token_count;
      else if (sortKey === "updated_at") cmp = a.updated_at.localeCompare(b.updated_at);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [data?.agents, namespaceFilter, verifiedFilter, sortKey, sortDir]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500 dark:text-red-400">Failed to load agents.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Agents"
        description="Deployed skills callable via POST /run."
      >
        <Btn variant="secondary" onClick={() => setImportOpen(true)} icon={<IconPlus />}>
          Import
        </Btn>
      </PageHeader>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center gap-2 h-8 w-[280px] px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-500/15 transition">
          <IconSearch className="w-[13px] h-[13px] text-gray-400" />
          <input
            className="flex-1 bg-transparent outline-none text-[12.5px] text-gray-800 dark:text-gray-200 placeholder:text-gray-400"
            placeholder="Filter agents..."
            value={namespaceFilter}
            onChange={(e) => setNamespaceFilter(e.target.value)}
          />
        </div>

        <div className="flex items-center p-0.5 rounded-md bg-gray-100/70 dark:bg-gray-900 text-[11.5px]">
          {(["all", "verified", "unverified"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setVerifiedFilter(t)}
              className={`px-2.5 h-6 rounded-[5px] transition-colors capitalize ${
                verifiedFilter === t
                  ? "bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 shadow-sm font-medium"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              }`}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
        </div>

        <div className="flex-1" />
        <span className="text-[11.5px] text-gray-400">{filteredAgents.length} agents</span>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-900 overflow-hidden">
          <div className="divide-y divide-gray-100 dark:divide-gray-900">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={`skel-${i}`} className="px-4 py-3.5">
                <div className="h-4 w-1/2 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ) : filteredAgents.length === 0 ? (
        <EmptyState
          title="No agents registered"
          description="Push agents via CLI with `skrun push` or import them here."
          action={
            <Btn variant="primary" onClick={() => setImportOpen(true)} icon={<IconPlus />}>
              Import agent
            </Btn>
          }
        />
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-gray-900 overflow-hidden bg-white dark:bg-gray-950/40">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_90px_90px_80px_100px] gap-4 px-4 h-9 bg-gray-50/60 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-900 text-[10.5px] font-medium uppercase tracking-[0.06em] text-gray-500 dark:text-gray-500 items-center">
            <SortHeader
              label="Agent"
              sortKey="name"
              current={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label="Runs"
              sortKey="run_count"
              current={sortKey}
              dir={sortDir}
              onSort={toggleSort}
              className="text-right tabular-nums"
            />
            <SortHeader
              label="Tokens"
              sortKey="token_count"
              current={sortKey}
              dir={sortDir}
              onSort={toggleSort}
              className="text-right tabular-nums"
            />
            <span>Status</span>
            <SortHeader
              label="Updated"
              sortKey="updated_at"
              current={sortKey}
              dir={sortDir}
              onSort={toggleSort}
              className="text-right"
            />
          </div>
          {/* Rows */}
          <div className="divide-y divide-gray-100 dark:divide-gray-900">
            {filteredAgents.map((agent) => (
              <div
                key={agent.id}
                className="grid grid-cols-[1fr_90px_90px_80px_100px] gap-4 px-4 h-14 items-center hover:bg-gray-50/60 dark:hover:bg-gray-900/30 group"
              >
                {/* Agent cell */}
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-7 h-7 rounded-md bg-gradient-to-br from-sky-100 to-sky-50 dark:from-sky-950/60 dark:to-sky-950/20 ring-1 ring-sky-100 dark:ring-sky-900/40 flex items-center justify-center text-[10.5px] font-mono font-semibold text-sky-700 dark:text-sky-300 shrink-0">
                    {agent.name.slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Link
                        to={`/agents/${agent.namespace}/${agent.name}`}
                        className="text-[13px] font-medium text-gray-900 dark:text-gray-100 hover:text-sky-700 dark:hover:text-sky-400 truncate"
                      >
                        {agent.namespace}/<span className="font-semibold">{agent.name}</span>
                      </Link>
                      {agent.verified && (
                        <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400">
                          <IconCheck className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>
                    {agent.description && (
                      <div className="text-[11px] text-gray-500 dark:text-gray-500 truncate">
                        {agent.description}
                      </div>
                    )}
                  </div>
                </div>

                {/* Runs */}
                <span className="text-[12px] tabular-nums text-gray-700 dark:text-gray-300 text-right">
                  {agent.run_count}
                </span>

                {/* Tokens */}
                <span className="text-[12px] tabular-nums text-gray-500 dark:text-gray-500 text-right">
                  {formatTokens(agent.token_count)}
                </span>

                {/* Status */}
                <span>
                  {agent.verified ? (
                    <Pill tone="sky">verified</Pill>
                  ) : (
                    <Pill tone="neutral">unverified</Pill>
                  )}
                </span>

                {/* Updated + hover actions */}
                <div className="flex items-center justify-end gap-2">
                  <span className="text-[11px] text-gray-400 dark:text-gray-600 group-hover:hidden">
                    {formatRelativeTime(agent.updated_at)}
                  </span>
                  <div className="hidden group-hover:flex items-center">
                    <button
                      type="button"
                      onClick={() => navigate(`/agents/${agent.namespace}/${agent.name}/run`)}
                      className="h-6 px-2 rounded text-[11px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/70 inline-flex items-center gap-1"
                    >
                      <IconPlay className="w-2.5 h-2.5" /> Try
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Footer */}
          <div className="flex items-center justify-between px-4 h-10 border-t border-gray-200 dark:border-gray-900 bg-gray-50/40 dark:bg-gray-900/20 text-[11.5px] text-gray-500 dark:text-gray-500">
            <span>
              {filteredAgents.length > 0
                ? `1\u2013${filteredAgents.length} of ${data?.total ?? filteredAgents.length}`
                : "0 agents"}
            </span>
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </div>
        </div>
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete agent"
        message={`Delete ${deleteTarget?.namespace}/${deleteTarget?.name}? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (deleteTarget) {
            try {
              await deleteAgent.mutateAsync(deleteTarget);
            } catch {
              // error handled by mutation
            }
            setDeleteTarget(null);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  className = "",
}: {
  label: string;
  sortKey: "name" | "run_count" | "token_count" | "updated_at";
  current: string;
  dir: "asc" | "desc";
  onSort: (key: "name" | "run_count" | "token_count" | "updated_at") => void;
  className?: string;
}) {
  const isActive = current === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 hover:text-gray-800 dark:hover:text-gray-300 transition-colors ${className}`}
    >
      {label}
      {isActive && <span className="text-sky-500">{dir === "asc" ? "\u2191" : "\u2193"}</span>}
    </button>
  );
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

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
