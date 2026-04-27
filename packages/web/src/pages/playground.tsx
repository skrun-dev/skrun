import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/shared/empty-state";
import { IconChevRight, IconCopy, IconLock, IconPlay } from "../components/shared/icons";
import { JsonViewer } from "../components/shared/json-viewer";
import { Btn, Card, PageHeader, Pill } from "../components/shared/ui";
import { type RunEvent, getAuthHeaders, useAgent, useAgentVersions } from "../lib/api-client";

const LLM_KEY_STORAGE = "skrun-llm-key";

type PlaygroundStatus = "idle" | "running" | "completed" | "failed" | "error";

export function PlaygroundPage() {
  const { namespace, name } = useParams<{ namespace: string; name: string }>();
  const [searchParams] = useSearchParams();
  const { data: agent, isLoading: agentLoading, error: agentError } = useAgent(namespace!, name!);
  const { data: versions } = useAgentVersions(namespace!, name!);

  const prefillInput = searchParams.get("input");
  const [input, setInput] = useState(() => {
    if (prefillInput) {
      try {
        return JSON.stringify(JSON.parse(decodeURIComponent(prefillInput)), null, 2);
      } catch {
        return "{}";
      }
    }
    return "{}";
  });

  const [llmKey, setLlmKey] = useState(() => localStorage.getItem(LLM_KEY_STORAGE) ?? "");
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [status, setStatus] = useState<PlaygroundStatus>("idle");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"json" | "form">("json");
  const abortRef = useRef<AbortController | null>(null);

  // Persist LLM key
  useEffect(() => {
    if (llmKey) {
      localStorage.setItem(LLM_KEY_STORAGE, llmKey);
    }
  }, [llmKey]);

  const runAgent = useCallback(async () => {
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(input);
    } catch {
      setError("Invalid JSON input");
      return;
    }

    setStatus("running");
    setEvents([]);
    setResult(null);
    setError(null);
    setRunId(null);

    const abort = new AbortController();
    abortRef.current = abort;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...getAuthHeaders(),
    };
    if (llmKey) {
      const provider = selectedProvider || agentProviders[0] || "anthropic";
      headers["X-LLM-API-Key"] = JSON.stringify({ [provider]: llmKey });
    }

    const body: Record<string, unknown> = { input: parsedInput };
    if (selectedVersion) {
      body.version = selectedVersion;
    }

    try {
      const res = await fetch(`/api/agents/${namespace}/${name}/run`, {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) {
        const respBody = await res.json().catch(() => ({ error: { message: res.statusText } }));
        setError(respBody.error?.message ?? `HTTP ${res.status}`);
        setStatus("failed");
        return;
      }

      if (!res.body) {
        setError("No response body");
        setStatus("failed");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalStatus: PlaygroundStatus = "running";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              const event: RunEvent = {
                type: data.type ?? "unknown",
                data,
                timestamp: new Date().toISOString(),
              };
              setEvents((prev) => [...prev, event]);

              if (data.type === "run_start" && data.run_id) {
                setRunId(data.run_id);
              }
              if (data.type === "run_complete") {
                setResult(data.output ?? data);
                finalStatus = "completed";
              }
              if (data.type === "run_error") {
                setError(data.error ?? "Agent execution failed");
                finalStatus = "failed";
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }
      }

      setStatus(finalStatus === "running" ? "completed" : finalStatus);
    } catch (err) {
      if (abort.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Connection failed");
      setStatus("error");
    }
  }, [namespace, name, input, llmKey, selectedVersion, selectedProvider]);

  const stopAgent = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
  }, []);

  if (agentLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
        <div className="h-32 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
      </div>
    );
  }

  if (agentError || !agent) {
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
  const agentInputs = (latestVersion?.config_snapshot as Record<string, unknown> | undefined)
    ?.inputs as
    | Array<{ name: string; type: string; required?: boolean; description?: string }>
    | undefined;
  const modelConfig = (latestVersion?.config_snapshot as Record<string, unknown> | undefined)
    ?.model as
    | { provider?: string; name?: string; fallback?: { provider: string; name: string } }
    | undefined;
  const agentProviders: string[] = [];
  if (modelConfig?.provider) agentProviders.push(modelConfig.provider);
  if (modelConfig?.fallback?.provider && !agentProviders.includes(modelConfig.fallback.provider)) {
    agentProviders.push(modelConfig.fallback.provider);
  }

  return (
    <div>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link to="/agents" className="hover:text-sky-700 dark:hover:text-sky-400">
              Agents
            </Link>
            <IconChevRight className="w-2.5 h-2.5 opacity-40" />
            <Link
              to={`/agents/${namespace}/${name}`}
              className="hover:text-sky-700 dark:hover:text-sky-400"
            >
              {namespace}/{name}
            </Link>
            <IconChevRight className="w-2.5 h-2.5 opacity-40" />
            <span>Playground</span>
          </span>
        }
        title="Playground"
        description={
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12.5px] text-sky-600 dark:text-sky-400">
              {namespace}/{name}
              {selectedVersion
                ? `@${selectedVersion}`
                : latestVersion
                  ? `@${latestVersion.version}`
                  : ""}
            </span>
            <span className="text-gray-300">&middot;</span>
            <span>Interactive SSE streaming</span>
          </span>
        }
      >
        <Btn
          variant="secondary"
          icon={<IconCopy />}
          onClick={() => {
            const cmd = `curl -X POST ${window.location.origin}/api/agents/${namespace}/${name}/run -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d '${JSON.stringify({ input: JSON.parse(input) })}'`;
            navigator.clipboard.writeText(cmd).catch(() => {});
          }}
        >
          Copy as cURL
        </Btn>
      </PageHeader>

      <div className="grid grid-cols-5 gap-5">
        {/* Left: form */}
        <div className="col-span-2 space-y-4">
          {/* Input card */}
          <Card
            title="Input"
            action={
              agentInputs && agentInputs.length > 0 ? (
                <div className="flex items-center p-0.5 rounded bg-gray-100/60 dark:bg-gray-900 text-[10.5px]">
                  <button
                    type="button"
                    onClick={() => setInputMode("json")}
                    className={`px-2 h-5 rounded-[3px] ${inputMode === "json" ? "bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-medium" : "text-gray-500 hover:text-gray-700"}`}
                  >
                    JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode("form")}
                    className={`px-2 h-5 rounded-[3px] ${inputMode === "form" ? "bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-medium" : "text-gray-500 hover:text-gray-700"}`}
                  >
                    Form
                  </button>
                </div>
              ) : undefined
            }
            pad={false}
          >
            {inputMode === "form" && agentInputs ? (
              <div className="p-4 space-y-3">
                {agentInputs.map((inp) => {
                  let currentVal = "";
                  try {
                    currentVal = JSON.parse(input)[inp.name] ?? "";
                  } catch {
                    /* ignore */
                  }
                  return (
                    <div key={inp.name}>
                      <label
                        htmlFor={`input-${inp.name}`}
                        className="text-[11.5px] font-medium text-gray-700 dark:text-gray-300 mb-1 block"
                      >
                        {inp.name} {inp.required && <span className="text-red-400">*</span>}
                      </label>
                      {inp.description && (
                        <p className="text-[10.5px] text-gray-400 mb-1.5">{inp.description}</p>
                      )}
                      <input
                        id={`input-${inp.name}`}
                        type="text"
                        value={currentVal}
                        onChange={(e) => {
                          try {
                            const obj = JSON.parse(input);
                            obj[inp.name] = e.target.value;
                            setInput(JSON.stringify(obj, null, 2));
                          } catch {
                            setInput(JSON.stringify({ [inp.name]: e.target.value }, null, 2));
                          }
                        }}
                        disabled={status === "running"}
                        className="w-full h-8 px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-[12px] text-gray-800 dark:text-gray-200 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15 disabled:opacity-50"
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={10}
                disabled={status === "running"}
                className="w-full px-4 py-3 text-[11.5px] font-mono leading-[1.55] text-gray-700 dark:text-gray-300 bg-gray-50/40 dark:bg-gray-950/60 border-0 outline-none resize-none disabled:opacity-50"
                spellCheck={false}
              />
            )}
          </Card>

          {/* Config card */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-900 bg-white dark:bg-gray-950/40 p-3 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="llm-api-key"
                  className="text-[11.5px] font-medium text-gray-700 dark:text-gray-300"
                >
                  LLM API key <span className="text-gray-400 font-normal">(optional)</span>
                </label>
              </div>
              {agentProviders.length > 1 && (
                <select
                  value={selectedProvider || agentProviders[0]}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  disabled={status === "running"}
                  className="w-full h-8 px-2.5 mb-2 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-[11.5px] text-gray-800 dark:text-gray-200 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15 disabled:opacity-50"
                >
                  {agentProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-950 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-500/15">
                <IconLock className="w-3 h-3 text-gray-400" />
                <input
                  id="llm-api-key"
                  type="password"
                  value={llmKey}
                  onChange={(e) => setLlmKey(e.target.value)}
                  placeholder={`API key for ${selectedProvider || agentProviders[0] || "LLM provider"}`}
                  disabled={status === "running"}
                  className="flex-1 bg-transparent outline-none text-[11.5px] font-mono text-gray-700 dark:text-gray-300 placeholder:text-gray-400 disabled:opacity-50"
                />
              </div>
              <p className="text-[10.5px] text-gray-400 mt-1">Key stored in browser only.</p>
            </div>

            {/* Version pin */}
            {versions && versions.length > 0 && (
              <div>
                <label
                  htmlFor="version-pin"
                  className="text-[11.5px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 block"
                >
                  Version pin
                </label>
                <select
                  id="version-pin"
                  value={selectedVersion}
                  onChange={(e) => setSelectedVersion(e.target.value)}
                  disabled={status === "running"}
                  className="w-full h-8 px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-[11.5px] font-mono text-gray-800 dark:text-gray-200 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15 disabled:opacity-50"
                >
                  <option value="">
                    latest{latestVersion ? ` (${latestVersion.version})` : ""}
                  </option>
                  {[...versions].reverse().map((v) => (
                    <option key={v.id} value={v.version}>
                      {v.version}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Action row */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-500">
              <span
                className={`w-1.5 h-1.5 rounded-full ${status === "running" ? "bg-amber-500 animate-pulse" : "bg-emerald-500"}`}
              />
              <span>
                {status === "running" ? "Streaming..." : status === "idle" ? "Ready" : status}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {status === "running" ? (
                <Btn variant="danger" size="md" onClick={stopAgent}>
                  Stop
                </Btn>
              ) : (
                <>
                  <Btn
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      setInput("{}");
                      setEvents([]);
                      setResult(null);
                      setError(null);
                      setRunId(null);
                      setStatus("idle");
                    }}
                  >
                    Clear
                  </Btn>
                  <Btn variant="primary" icon={<IconPlay />} onClick={runAgent}>
                    Run agent
                  </Btn>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: streaming output */}
        <div className="col-span-3 space-y-4">
          {/* Streaming events */}
          {(status !== "idle" || events.length > 0) && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-900 bg-white dark:bg-gray-950/40">
              <div className="h-10 flex items-center px-4 border-b border-gray-100 dark:border-gray-900 gap-2">
                {status === "running" && (
                  <Pill tone="amber" dot>
                    running
                  </Pill>
                )}
                {status === "completed" && (
                  <Pill tone="emerald" dot>
                    completed
                  </Pill>
                )}
                {(status === "failed" || status === "error") && (
                  <Pill tone="red" dot>
                    failed
                  </Pill>
                )}
                {runId && (
                  <span className="text-[11.5px] text-gray-500 font-mono">
                    {runId.slice(0, 12)}
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-[11px] text-gray-400">{events.length} events</span>
              </div>
              <div className="px-4 py-3 space-y-1.5 font-mono text-[11.5px] leading-relaxed bg-gradient-to-b from-white to-gray-50/40 dark:from-gray-950/40 dark:to-gray-950/70 max-h-[300px] overflow-y-auto">
                {events.map((e, i) => {
                  const color = getEventColor(e.type);
                  return (
                    <div key={`ev-${i}`} className="flex gap-2.5 items-baseline">
                      <span className="text-[10px] text-gray-400 tabular-nums w-10 shrink-0">
                        +{String(i * 100).padStart(4, "0")}
                      </span>
                      <span className={`${color} font-semibold w-[88px] shrink-0`}>{e.type}</span>
                      <span className="text-gray-700 dark:text-gray-300 flex-1 truncate">
                        {formatEventText(e)}
                      </span>
                    </div>
                  );
                })}
                {status === "running" && (
                  <div className="flex gap-2.5 items-baseline">
                    <span className="text-[10px] text-gray-400 tabular-nums w-10" />
                    <span className="text-violet-600 dark:text-violet-400 font-semibold w-[88px]" />
                    <span className="inline-block w-1.5 h-3 bg-gray-500 dark:bg-gray-400 animate-pulse" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          )}

          {/* Result */}
          {result && (
            <Card title="Output" pad={false}>
              <div className="p-4 bg-gray-50/40 dark:bg-gray-950/60">
                <JsonViewer data={result} />
              </div>
            </Card>
          )}

          {/* Run link */}
          {runId && status !== "running" && (
            <Link
              to={`/runs/${runId}`}
              className="inline-flex items-center gap-1 text-sm text-sky-600 dark:text-sky-400 hover:underline"
            >
              View run details &rarr;
            </Link>
          )}

          {/* Idle state */}
          {status === "idle" && events.length === 0 && (
            <div className="flex items-center justify-center py-16 text-gray-400 dark:text-gray-600 text-sm">
              Run the agent to see streaming events here
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getEventColor(type: string): string {
  if (type.includes("complete") || type.includes("result"))
    return "text-emerald-600 dark:text-emerald-400";
  if (type.includes("tool")) return "text-sky-600 dark:text-sky-400";
  if (type.includes("llm") || type.includes("chunk")) return "text-violet-600 dark:text-violet-400";
  if (type.includes("error")) return "text-red-600 dark:text-red-400";
  return "text-gray-500";
}

function formatEventText(e: RunEvent): string {
  const d = e.data;
  if (d.message) return String(d.message);
  if (d.type === "run_start") return `agent=${d.agent ?? ""}`;
  if (d.tool_name) return `${d.tool_name}(${d.args ? "..." : ""})`;
  if (d.output) return String(d.output).slice(0, 120);
  if (d.error) return String(d.error);
  return JSON.stringify(d).slice(0, 120);
}
