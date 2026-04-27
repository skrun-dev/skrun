import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { EmptyState } from "../components/shared/empty-state";
import {
  IconBook,
  IconChevRight,
  IconClock,
  IconCopy,
  IconError,
  IconPlay,
  IconRuns,
  IconSpark,
} from "../components/shared/icons";
import { Btn, Card, KV, MetricCard, PageHeader, Pill, StatusPill } from "../components/shared/ui";
import {
  useAgent,
  useAgentStats,
  useAgentVersions,
  useDeleteAgent,
  useRecentRuns,
  useVerifyAgent,
} from "../lib/api-client";

/**
 * Truncate a string at N graphemes (not UTF-16 code units), so emoji and CJK
 * characters don't split mid-character. Uses Intl.Segmenter with a safe fallback.
 */
function truncateGraphemes(str: string, max: number): string {
  if (!str || str.length <= max) return str;
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const graphemes: string[] = [];
    for (const { segment } of segmenter.segment(str)) {
      graphemes.push(segment);
      if (graphemes.length > max) break;
    }
    if (graphemes.length <= max) return str;
    return `${graphemes.slice(0, max).join("")}…`;
  } catch {
    // Fallback: naive slice (still safe for ASCII)
    return `${str.slice(0, max)}…`;
  }
}

export function AgentDetailPage() {
  const { namespace, name } = useParams<{ namespace: string; name: string }>();
  const navigate = useNavigate();

  const [statsDays, setStatsDays] = useState(7);
  const { data: agent, isLoading, error } = useAgent(namespace!, name!);
  const { data: versions } = useAgentVersions(namespace!, name!);
  const { data: agentStats } = useAgentStats(namespace!, name!, statsDays);
  const { data: allRuns } = useRecentRuns(undefined, 50);
  const verifyAgent = useVerifyAgent();
  const deleteAgent = useDeleteAgent();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const agentPrefix = `${namespace}/${name}`;
  const runs = useMemo(() => {
    if (!allRuns) return [];
    return allRuns.filter((r) => r.agent_version?.startsWith(agentPrefix)).slice(0, 10);
  }, [allRuns, agentPrefix]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
        <div className="h-32 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <EmptyState
        title="Agent not found"
        description={`No agent found at ${namespace}/${name}.`}
        action={
          <Link to="/agents">
            <Btn variant="primary">Back to agents</Btn>
          </Link>
        }
      />
    );
  }

  const latestVersion = versions && versions.length > 0 ? versions[versions.length - 1] : null;
  const config = latestVersion?.config_snapshot as Record<string, unknown> | undefined;

  return (
    <div>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link to="/agents" className="hover:text-sky-700 dark:hover:text-sky-400">
              Agents
            </Link>
            <IconChevRight className="w-2.5 h-2.5 opacity-40" />
            <span>
              {namespace}/{name}
            </span>
          </span>
        }
        title={
          <span className="flex items-center gap-2.5">
            <span>{name}</span>
            {latestVersion && (
              <>
                <span className="text-gray-300 dark:text-gray-700 font-normal">@</span>
                <span className="font-mono text-[15px] font-medium text-sky-600 dark:text-sky-400">
                  {latestVersion.version}
                </span>
              </>
            )}
          </span>
        }
        description={agent.description || "No description"}
        meta={
          agent.verified ? (
            <Pill tone="sky" dot>
              verified
            </Pill>
          ) : (
            <Pill tone="neutral">unverified</Pill>
          )
        }
      >
        <Btn
          variant="ghost"
          size="sm"
          icon={<IconCopy />}
          onClick={() => {
            const url = `${window.location.origin}/api/agents/${namespace}/${name}/run`;
            navigator.clipboard.writeText(url).catch(() => {});
          }}
        >
          Copy URL
        </Btn>
        <a href="/docs" target="_blank" rel="noopener noreferrer">
          <Btn variant="secondary" icon={<IconBook className="w-3.5 h-3.5" />}>
            API
          </Btn>
        </a>
        <Btn
          variant="accent"
          icon={<IconPlay />}
          onClick={() => navigate(`/agents/${namespace}/${name}/run`)}
        >
          Try in playground
        </Btn>
      </PageHeader>

      {/* Stats period toggle + stat cards */}
      {agentStats && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center p-0.5 rounded-md bg-gray-100/70 dark:bg-gray-900 text-[11.5px]">
              {[1, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setStatsDays(d)}
                  className={`px-2.5 h-6 rounded-[5px] transition-colors ${
                    statsDays === d
                      ? "bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 shadow-sm font-medium"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  {d === 1 ? "24h" : "7d"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3 mb-6">
            <MetricCard
              label="Runs"
              value={agentStats.runs.toLocaleString()}
              delta={deltaPct(agentStats.runs, agentStats.prev_runs)}
              icon={<IconRuns className="w-4 h-4" />}
              tone="sky"
              spark={agentStats.daily_runs}
            />
            <MetricCard
              label="Tokens"
              value={formatTokensShort(agentStats.tokens)}
              delta={deltaPct(agentStats.tokens, agentStats.prev_tokens)}
              icon={<IconSpark className="w-4 h-4" />}
              tone="violet"
              spark={agentStats.daily_tokens}
            />
            <MetricCard
              label="Failed runs"
              value={agentStats.failed}
              delta={
                agentStats.failed === 0 && agentStats.prev_failed === 0
                  ? "0%"
                  : deltaPct(agentStats.failed, agentStats.prev_failed)
              }
              icon={<IconError className="w-4 h-4" />}
              tone={agentStats.failed > 0 ? "red" : "emerald"}
              spark={agentStats.daily_failed}
            />
            <MetricCard
              label="Avg duration"
              value={formatDuration(agentStats.avg_duration_ms)}
              delta={deltaPct(agentStats.avg_duration_ms, agentStats.prev_avg_duration_ms)}
              icon={<IconClock className="w-4 h-4" />}
              tone="amber"
              spark={agentStats.daily_avg_duration_ms}
            />
          </div>
        </>
      )}

      <div className="grid grid-cols-3 gap-5">
        {/* Left 2/3 */}
        <div className="col-span-2 space-y-5">
          {/* Recent runs */}
          <Card
            title="Recent runs"
            action={
              <Link
                to={`/runs?agent=${encodeURIComponent(`${namespace}/${name}`)}`}
                className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline"
              >
                View all &rarr;
              </Link>
            }
            pad={false}
          >
            {!runs || runs.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
                No runs yet for this agent.
              </p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-900">
                {runs.map((run) => (
                  <Link
                    key={run.id}
                    to={`/runs/${run.id}`}
                    className="group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50/60 dark:hover:bg-gray-900/40"
                  >
                    <StatusPill status={run.status} />
                    <span className="font-mono text-[11.5px] text-gray-700 dark:text-gray-300 flex-1">
                      {run.id.slice(0, 12)}
                    </span>
                    {run.model && (
                      <span className="text-[10.5px] font-mono text-gray-400 dark:text-gray-600 truncate max-w-[100px]">
                        {run.model}
                      </span>
                    )}
                    <span className="text-[11px] text-gray-500 dark:text-gray-500 tabular-nums w-16 text-right">
                      {run.usage_total_tokens > 0
                        ? `${run.usage_total_tokens.toLocaleString()} tok`
                        : "—"}
                    </span>
                    <span className="text-[11px] text-gray-400 dark:text-gray-600 tabular-nums w-12 text-right font-mono">
                      {run.duration_ms !== null ? formatDuration(run.duration_ms) : "—"}
                    </span>
                    <span className="text-[11px] text-gray-400 dark:text-gray-600 w-16 text-right">
                      {formatRelativeTime(run.created_at)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {/* Try it */}
          <Card
            title="Try it"
            action={
              <span className="text-[10.5px] font-mono text-gray-400">
                POST /api/agents/{namespace}/{name}/run
              </span>
            }
          >
            <div className="space-y-2.5">
              {(() => {
                const exampleInput =
                  ((
                    config?.tests as
                      | Array<{ name: string; input: Record<string, unknown> }>
                      | undefined
                  )?.[0]?.input as Record<string, unknown>) ?? {};
                const inputJson = JSON.stringify(exampleInput, null, 2);
                return (
                  <>
                    <div className="rounded-md border border-gray-200 dark:border-gray-900 bg-gray-50/60 dark:bg-gray-950/70 p-3 font-mono text-[11.5px] text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre">{`curl -X POST ${window.location.origin}/api/agents/${namespace}/${name}/run \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "input": ${inputJson} }'`}</div>
                    <div className="flex items-center gap-2">
                      <Btn
                        variant="secondary"
                        size="sm"
                        icon={<IconCopy />}
                        onClick={() => {
                          const cmd = `curl -X POST ${window.location.origin}/api/agents/${namespace}/${name}/run -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '${JSON.stringify({ input: exampleInput })}'`;
                          navigator.clipboard.writeText(cmd).catch(() => {});
                        }}
                      >
                        Copy
                      </Btn>
                      <Btn
                        variant="accent"
                        size="sm"
                        icon={<IconPlay />}
                        onClick={() => {
                          const encoded = encodeURIComponent(JSON.stringify(exampleInput));
                          navigate(`/agents/${namespace}/${name}/run?input=${encoded}`);
                        }}
                      >
                        Run in playground
                      </Btn>
                    </div>
                  </>
                );
              })()}
            </div>
          </Card>
        </div>

        {/* Right 1/3 */}
        <div className="space-y-5">
          {/* Versions */}
          <Card title="Versions" pad={false}>
            {!versions || versions.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
                No versions pushed yet.
              </p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-900 max-h-72 overflow-y-auto">
                {[...versions].reverse().map((v, i) => {
                  const truncated = truncateGraphemes(v.notes ?? "", 80);
                  return (
                    <div key={v.id} className="px-4 py-2">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-[12px] text-gray-900 dark:text-gray-100 tabular-nums w-10">
                          {v.version}
                        </span>
                        {i === 0 && <Pill tone="emerald">current</Pill>}
                        <span className="flex-1" />
                        <span className="text-[10.5px] text-gray-400 dark:text-gray-600">
                          {formatDate(v.pushed_at)}
                        </span>
                      </div>
                      {v.notes && (
                        <div
                          className="text-[11.5px] text-gray-600 dark:text-gray-400 mt-1 ml-[54px] truncate"
                          title={v.notes}
                        >
                          {truncated}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Metadata */}
          <Card title="Metadata" pad={false}>
            <dl className="px-4 py-1">
              <KV label="Namespace" value={agent.namespace} />
              <KV label="Name" value={agent.name} />
              <KV label="Created" value={formatDate(agent.created_at)} />
              <KV label="Updated" value={formatDate(agent.updated_at)} />
              {(config?.model as
                | {
                    provider?: string;
                    name?: string;
                    fallback?: { provider: string; name: string };
                  }
                | undefined) && (
                <KV
                  label="Model"
                  value={
                    <div className="text-right">
                      <div className="font-mono text-[11.5px]">
                        {(config!.model as { provider: string; name: string }).provider}/
                        {(config!.model as { provider: string; name: string }).name}
                      </div>
                      {(config!.model as { fallback?: { provider: string; name: string } })
                        .fallback && (
                        <div className="font-mono text-[10.5px] text-gray-400 dark:text-gray-500">
                          fallback:{" "}
                          {
                            (config!.model as { fallback: { provider: string; name: string } })
                              .fallback.provider
                          }
                          /
                          {
                            (config!.model as { fallback: { provider: string; name: string } })
                              .fallback.name
                          }
                        </div>
                      )}
                    </div>
                  }
                />
              )}
              {Array.isArray(config?.tools) && (
                <KV
                  label="Tools"
                  value={`${(config?.tools as unknown[]).length} tool${(config?.tools as unknown[]).length !== 1 ? "s" : ""}`}
                />
              )}
              {Array.isArray(config?.mcp_servers) && (
                <KV
                  label="MCP"
                  value={`${(config?.mcp_servers as unknown[]).length} server${(config?.mcp_servers as unknown[]).length !== 1 ? "s" : ""}`}
                />
              )}
              {(config?.environment as { timeout?: string } | undefined)?.timeout && (
                <KV label="Timeout" value={(config?.environment as { timeout: string }).timeout} />
              )}
            </dl>
          </Card>

          {/* Danger zone */}
          <Card title="Danger zone">
            <div className="space-y-2">
              <Btn
                variant="secondary"
                size="sm"
                className="w-full justify-center"
                onClick={() =>
                  verifyAgent.mutate({
                    namespace: namespace!,
                    name: name!,
                    verified: !agent.verified,
                  })
                }
              >
                {agent.verified ? "Unverify" : "Verify"}
              </Btn>
              <Btn
                variant="danger"
                size="sm"
                className="w-full justify-center"
                onClick={() => setDeleteOpen(true)}
              >
                Delete agent
              </Btn>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete agent"
        message={`Delete ${namespace}/${name}? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          try {
            await deleteAgent.mutateAsync({ namespace: namespace!, name: name! });
            navigate("/agents");
          } catch {
            // handled by mutation
          }
          setDeleteOpen(false);
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
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

function formatTokensShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function deltaPct(current: number, previous: number): string {
  if (previous === 0) return "new";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}
