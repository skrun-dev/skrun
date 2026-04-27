import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  IconAgents,
  IconCheck,
  IconChevRight,
  IconError,
  IconExternal,
  IconPlus,
  IconRuns,
  IconSpark,
} from "../components/shared/icons";
import { Btn, Card, MetricCard, PageHeader, Pill, StatusDot } from "../components/shared/ui";
import { useAgents, useRecentRuns, useStats } from "../lib/api-client";

export function HomePage() {
  const { data: stats, isLoading: statsLoading, error: statsError } = useStats();
  const { data: runs, isLoading: runsLoading } = useRecentRuns(undefined, 15);
  const { data: agentsData } = useAgents(1, 20);

  const [statsDays, setStatsDays] = useState(1);

  const topAgents = useMemo(() => {
    if (!agentsData?.agents) return [];
    return [...agentsData.agents].sort((a, b) => b.run_count - a.run_count).slice(0, 5);
  }, [agentsData?.agents]);

  // Compute values based on toggle (1d = today, 7d = sum of daily arrays)
  const metricValues = useMemo(() => {
    if (!stats) return null;
    if (statsDays === 1) {
      return {
        runs: stats.runs_today,
        tokens: stats.tokens_today,
        failed: stats.failed_today,
        prevRuns: stats.runs_yesterday,
        prevTokens: stats.tokens_yesterday,
        prevFailed: stats.failed_yesterday,
      };
    }
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    return {
      runs: sum(stats.daily_runs),
      tokens: sum(stats.daily_tokens),
      failed: sum(stats.daily_failed),
      prevRuns: 0,
      prevTokens: 0,
      prevFailed: 0,
    };
  }, [stats, statsDays]);

  if (statsError) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
          <IconError className="w-6 h-6 text-red-500" />
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Cannot reach API. Check that the registry is running.
        </p>
        <Btn variant="primary" onClick={() => window.location.reload()}>
          Retry
        </Btn>
      </div>
    );
  }

  const hasData = stats && (stats.agents_count > 0 || stats.runs_today > 0);

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Overview"
        description="Everything running in your instance."
        meta={
          stats && stats.failed_today === 0 ? (
            <Pill tone="emerald" dot>
              healthy
            </Pill>
          ) : undefined
        }
      >
        <Link to="/agents">
          <Btn variant="accent" icon={<IconPlus />}>
            Import agent
          </Btn>
        </Link>
      </PageHeader>

      {/* Period toggle + Hero metrics */}
      {stats && (
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
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {statsLoading ? (
          <>
            <MetricSkeleton />
            <MetricSkeleton />
            <MetricSkeleton />
            <MetricSkeleton />
          </>
        ) : stats && metricValues ? (
          <>
            <MetricCard
              label="Active agents"
              value={stats.agents_count}
              icon={<IconAgents className="w-4 h-4" />}
              tone="sky"
            />
            <MetricCard
              label="Runs"
              value={formatNumber(metricValues.runs)}
              delta={
                statsDays === 1
                  ? computeDeltaPercent(metricValues.runs, metricValues.prevRuns)
                  : undefined
              }
              icon={<IconRuns className="w-4 h-4" />}
              tone="emerald"
              spark={stats.daily_runs}
            />
            <MetricCard
              label="Tokens"
              value={formatTokens(metricValues.tokens)}
              delta={
                statsDays === 1
                  ? computeDeltaPercent(metricValues.tokens, metricValues.prevTokens)
                  : undefined
              }
              icon={<IconSpark className="w-4 h-4" />}
              tone="violet"
              spark={stats.daily_tokens}
            />
            <MetricCard
              label="Failed runs"
              value={metricValues.failed}
              delta={
                statsDays === 1
                  ? metricValues.failed === 0 && metricValues.prevFailed === 0
                    ? "0%"
                    : computeDeltaPercent(metricValues.failed, metricValues.prevFailed)
                  : undefined
              }
              icon={<IconError className="w-4 h-4" />}
              tone={metricValues.failed > 0 ? "red" : "emerald"}
              spark={stats.daily_failed}
            />
          </>
        ) : null}
      </div>

      {/* Main content */}
      {!hasData ? (
        <OnboardingCard />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Activity feed — 2/3 */}
          <div className="lg:col-span-2">
            <Card
              title="Recent activity"
              action={
                <Link
                  to="/runs"
                  className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline"
                >
                  View all &rarr;
                </Link>
              }
              pad={false}
            >
              {runsLoading ? (
                <div className="divide-y divide-gray-100 dark:divide-gray-900">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={`skel-${i}`} className="px-4 py-3">
                      <div className="h-4 w-3/4 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : runs && runs.length > 0 ? (
                <div className="divide-y divide-gray-100 dark:divide-gray-900">
                  {runs.map((run) => (
                    <Link
                      key={run.id}
                      to={`/runs/${run.id}`}
                      className="group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50/70 dark:hover:bg-gray-900/40"
                    >
                      <StatusDot status={run.status} />
                      <span className="text-[13px] text-gray-800 dark:text-gray-200 truncate flex-1 min-w-0">
                        {extractAgentName(run.agent_version)}
                      </span>
                      <span className="font-mono text-[11px] text-gray-400 dark:text-gray-600 hidden sm:inline">
                        {run.id.slice(0, 8)}
                      </span>
                      {run.usage_total_tokens > 0 && (
                        <span className="text-[11px] text-gray-400 dark:text-gray-600 tabular-nums w-14 text-right hidden sm:inline">
                          {run.usage_total_tokens.toLocaleString()} tok
                        </span>
                      )}
                      {run.duration_ms !== null && (
                        <span className="text-[11px] text-gray-400 dark:text-gray-600 tabular-nums w-10 text-right font-mono">
                          {formatDuration(run.duration_ms)}
                        </span>
                      )}
                      <span className="text-[11px] text-gray-400 dark:text-gray-600 tabular-nums w-8 text-right">
                        {formatRelativeTime(run.created_at)}
                      </span>
                      <IconChevRight className="w-2.5 h-2.5 text-gray-300 dark:text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No runs yet
                </div>
              )}
            </Card>
          </div>

          {/* Right column — 1/3 */}
          <div className="space-y-5">
            <Card
              title="Top agents"
              action={
                <Link
                  to="/agents"
                  className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline"
                >
                  Manage
                </Link>
              }
              pad={false}
            >
              {topAgents.length > 0 ? (
                <div className="divide-y divide-gray-100 dark:divide-gray-900">
                  {topAgents.map((agent) => (
                    <Link
                      key={agent.id}
                      to={`/agents/${agent.namespace}/${agent.name}`}
                      className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50/70 dark:hover:bg-gray-900/40 group"
                    >
                      <div className="w-6 h-6 rounded-md bg-sky-100 dark:bg-sky-950/60 flex items-center justify-center text-[10px] font-mono font-semibold text-sky-700 dark:text-sky-300">
                        {agent.name.slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12.5px] text-gray-800 dark:text-gray-200 truncate">
                            {agent.name}
                          </span>
                          {agent.verified && (
                            <IconCheck className="w-3 h-3 text-sky-500 shrink-0" />
                          )}
                        </div>
                        <div className="text-[10.5px] text-gray-400 dark:text-gray-600 tabular-nums">
                          {agent.run_count.toLocaleString()} runs
                        </div>
                      </div>
                      <IconChevRight className="w-2.5 h-2.5 text-gray-300 dark:text-gray-700 opacity-0 group-hover:opacity-100" />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  No agents yet
                </div>
              )}
            </Card>

            <Card title="Quick start" pad={false}>
              <div className="p-4 space-y-2 text-[12px] text-gray-600 dark:text-gray-400">
                <div className="font-mono bg-gray-50 dark:bg-gray-900/70 border border-gray-100 dark:border-gray-900 rounded-md px-2.5 py-1.5 text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed">
                  <div>
                    <span className="text-gray-400">$</span> skrun init my-agent
                  </div>
                  <div>
                    <span className="text-gray-400">$</span> skrun build &amp;&amp; skrun push
                  </div>
                </div>
                <a
                  href="/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline inline-flex items-center gap-1"
                >
                  Read docs <IconExternal className="w-2.5 h-2.5" />
                </a>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Onboarding ---

function OnboardingCard() {
  return (
    <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8">
      <div className="max-w-lg mx-auto text-center">
        <div className="w-12 h-12 rounded-full bg-sky-500/10 flex items-center justify-center mx-auto mb-4">
          <IconPlus className="w-5 h-5 text-sky-500" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Welcome to Skrun
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Deploy any Agent Skill as an API. Import your first agent to get started.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/agents">
            <Btn variant="primary" icon={<IconPlus />}>
              Import Agent
            </Btn>
          </Link>
          <a href="/docs" target="_blank" rel="noopener noreferrer">
            <Btn variant="secondary">Read Docs</Btn>
          </a>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-4 text-left">
          <Step
            number={1}
            title="Import"
            description="Upload an .agent bundle or scan a directory"
          />
          <Step number={2} title="Test" description="Run your agent in the playground" />
          <Step number={3} title="Deploy" description="Push to cloud with skrun deploy" />
        </div>
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  description,
}: { number: number; title: string; description: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="w-5 h-5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 text-xs font-bold flex items-center justify-center">
          {number}
        </span>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 pl-7">{description}</p>
    </div>
  );
}

function MetricSkeleton() {
  return <div className="h-[104px] bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />;
}

// --- Formatters ---

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
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

function computeDeltaPercent(current: number, previous: number): string {
  if (previous === 0) return "new";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}
