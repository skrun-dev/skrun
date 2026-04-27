import { Link, useNavigate, useParams } from "react-router-dom";
import { EmptyState } from "../components/shared/empty-state";
import { IconChevRight, IconPlay } from "../components/shared/icons";
import { JsonViewer } from "../components/shared/json-viewer";
import { Btn, Card, PageHeader, Pill, StatusPill } from "../components/shared/ui";
import { type RunEvent, useRun } from "../lib/api-client";

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading, error } = useRun(id!);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
        <div className="h-48 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <EmptyState
        title="Run not found"
        description={`No run found with ID ${id}.`}
        action={
          <Link to="/runs">
            <Btn variant="primary">Back to runs</Btn>
          </Link>
        }
      />
    );
  }

  const agentRef = run.agent_version?.includes("/") ? run.agent_version.split("@")[0] : null;
  const agentVersion = run.agent_version?.includes("@") ? run.agent_version.split("@")[1] : null;

  const events: RunEvent[] = [];
  if (run.output && typeof run.output === "object" && "_events" in run.output) {
    const rawEvents = (run.output as Record<string, unknown>)._events;
    if (Array.isArray(rawEvents)) {
      for (const e of rawEvents) {
        if (e && typeof e === "object" && "type" in e) {
          events.push(e as RunEvent);
        }
      }
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link to="/runs" className="hover:text-sky-700 dark:hover:text-sky-400">
              Runs
            </Link>
            <IconChevRight className="w-2.5 h-2.5 opacity-40" />
            <span>{run.id.slice(0, 12)}</span>
          </span>
        }
        title={<span className="font-mono text-[20px] font-semibold">{run.id.slice(0, 12)}</span>}
        description={
          <span className="flex items-center gap-2 text-[12.5px]">
            {agentRef && (
              <Link
                to={`/agents/${agentRef}`}
                className="text-sky-600 dark:text-sky-400 hover:underline"
              >
                {agentRef}
                {agentVersion ? `@${agentVersion}` : ""}
              </Link>
            )}
            {run.duration_ms !== null && (
              <>
                <span className="text-gray-300">&middot;</span>
                <span className="font-mono">{formatDuration(run.duration_ms)}</span>
              </>
            )}
            <span className="text-gray-300">&middot;</span>
            <span>{new Date(run.created_at).toLocaleString()}</span>
          </span>
        }
        meta={<StatusPill status={run.status} />}
      >
        {agentRef && (
          <Btn
            variant="secondary"
            icon={<IconPlay />}
            onClick={() => {
              const inputEncoded = run.input ? encodeURIComponent(JSON.stringify(run.input)) : "";
              navigate(`/agents/${agentRef}/run${inputEncoded ? `?input=${inputEncoded}` : ""}`);
            }}
          >
            Re-run
          </Btn>
        )}
      </PageHeader>

      {/* Token strip */}
      <div className="grid grid-cols-5 gap-px bg-gray-200 dark:bg-gray-900 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-900 mb-5">
        {[
          { l: "Input tokens", v: run.usage_prompt_tokens.toLocaleString(), mono: false },
          { l: "Output tokens", v: run.usage_completion_tokens.toLocaleString(), mono: false },
          { l: "Total tokens", v: run.usage_total_tokens.toLocaleString(), mono: false },
          { l: "Cost", v: `$${run.usage_estimated_cost.toFixed(4)}`, mono: false },
          { l: "Model", v: run.model ?? "\u2014", mono: true },
        ].map((s) => (
          <div key={s.l} className="bg-white dark:bg-gray-950/40 px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.08em] text-gray-500 font-medium">
              {s.l}
            </div>
            <div
              className={`text-[18px] font-semibold mt-1 text-gray-900 dark:text-gray-100 tabular-nums tracking-tight ${s.mono ? "font-mono text-[13px] truncate" : ""}`}
            >
              {s.v}
            </div>
          </div>
        ))}
      </div>

      {/* I/O */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <Card
          title="Input"
          action={
            <span className="text-[10px] font-mono text-gray-400">
              {run.input ? `${JSON.stringify(run.input).length} B` : "—"}
            </span>
          }
          pad={false}
        >
          <div className="p-4 bg-gray-50/40 dark:bg-gray-950/60">
            {run.input ? (
              <JsonViewer data={run.input} />
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">No input</p>
            )}
          </div>
        </Card>

        <Card
          title={run.status === "failed" ? "Error" : "Output"}
          action={
            <span className="text-[10px] font-mono text-gray-400">
              {run.output ? `${JSON.stringify(run.output).length} B` : "—"}
            </span>
          }
          pad={false}
        >
          <div className="p-4 bg-gray-50/40 dark:bg-gray-950/60">
            {run.status === "failed" && run.error ? (
              <div className="bg-red-500/5 border border-red-200 dark:border-red-800/50 rounded-md p-3">
                <p className="text-sm text-red-600 dark:text-red-400 font-mono">{run.error}</p>
              </div>
            ) : run.output ? (
              <JsonViewer data={run.output} />
            ) : run.status === "running" ? (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-sm text-amber-600 dark:text-amber-400">Running...</span>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">No output</p>
            )}
          </div>
        </Card>
      </div>

      {/* Events Timeline */}
      <Card
        title="Event timeline"
        action={
          events.length > 0 ? (
            <span className="text-[11px] text-gray-400">{events.length} events</span>
          ) : undefined
        }
        pad={false}
      >
        {events.length > 0 ? (
          <div className="px-4 py-3 space-y-0">
            {events.map((e, i) => {
              const tone = getEventTone(e.type);
              const dotClass =
                tone === "emerald"
                  ? "bg-emerald-500 ring-4 ring-emerald-500/10"
                  : tone === "sky"
                    ? "bg-sky-500 ring-4 ring-sky-500/10"
                    : tone === "violet"
                      ? "bg-violet-500 ring-4 ring-violet-500/10"
                      : tone === "red"
                        ? "bg-red-500 ring-4 ring-red-500/10"
                        : "bg-gray-400 ring-4 ring-gray-400/10";
              return (
                <div key={`event-${i}`} className="relative flex items-start gap-3 py-2">
                  <div
                    className="relative flex flex-col items-center shrink-0"
                    style={{ width: 14 }}
                  >
                    <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`} />
                    {i < events.length - 1 && (
                      <span className="absolute top-[18px] bottom-[-8px] w-px bg-gray-200 dark:bg-gray-800" />
                    )}
                  </div>
                  <Pill tone={tone}>{e.type}</Pill>
                  <span className="text-[11.5px] text-gray-500 dark:text-gray-400 flex-1 truncate font-mono">
                    {formatEventDetail(e)}
                  </span>
                  {e.timestamp && (
                    <span className="text-[10.5px] text-gray-400 dark:text-gray-600 font-mono tabular-nums">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Event persistence coming soon. Events are visible in real-time in the playground.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function getEventTone(type: string): "emerald" | "sky" | "violet" | "red" | "neutral" {
  if (type.includes("complete") || type.includes("result")) return "emerald";
  if (type.includes("tool")) return "sky";
  if (type.includes("llm") || type.includes("chunk")) return "violet";
  if (type.includes("error") || type.includes("fail")) return "red";
  return "neutral";
}

function formatEventDetail(event: RunEvent): string {
  const d = event.data;
  if (d.message) return String(d.message);
  if (d.tool_name) return `${d.tool_name}(${d.args ? "..." : ""})`;
  if (d.output) return String(d.output).slice(0, 100);
  return JSON.stringify(d).slice(0, 100);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
