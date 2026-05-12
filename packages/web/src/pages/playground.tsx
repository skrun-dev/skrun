import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/shared/empty-state";
import { IconChevRight, IconCopy, IconLock, IconPlay } from "../components/shared/icons";
import { JsonViewer } from "../components/shared/json-viewer";
import { Btn, Card, PageHeader, Pill } from "../components/shared/ui";
import { getAuthHeaders, type RunEvent, useAgent, useAgentVersions } from "../lib/api-client";

const LLM_KEY_STORAGE = "skrun-llm-key";

type PlaygroundStatus = "idle" | "running" | "completed" | "failed" | "error";

type AgentInput = {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  media?: "image" | "document" | "audio";
  max_count?: number;
  mime_types?: string[];
};

type AttachedFile = { file_id: string; name: string; size: number };

function mediaToAcceptAttr(media?: string): string | undefined {
  if (media === "image") return "image/*";
  if (media === "document") return "application/pdf";
  if (media === "audio") return "audio/*";
  return undefined;
}

async function uploadFileToApi(file: File): Promise<AttachedFile> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { ...getAuthHeaders() },
    credentials: "same-origin",
    body: fd,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Upload failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { file_id: string; size: number };
  return { file_id: body.file_id, name: file.name, size: body.size };
}

export function PlaygroundPage() {
  const { namespace = "", name = "" } = useParams<{ namespace: string; name: string }>();
  const [searchParams] = useSearchParams();
  const { data: agent, isLoading: agentLoading, error: agentError } = useAgent(namespace, name);
  const { data: versions } = useAgentVersions(namespace, name);

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
  const [fileAttachments, setFileAttachments] = useState<Record<string, AttachedFile[]>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const jsonAttachRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Persist LLM key
  useEffect(() => {
    if (llmKey) {
      localStorage.setItem(LLM_KEY_STORAGE, llmKey);
    }
  }, [llmKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: agentProviders[0] is computed from props, stable per render
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

  const handleFormFileSelect = useCallback(
    async (inputName: string, maxCount: number, files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploadError(null);
      setUploading((p) => ({ ...p, [inputName]: true }));
      try {
        const arr = Array.from(files).slice(0, maxCount);
        const uploaded = await Promise.all(arr.map(uploadFileToApi));
        const wireValues = uploaded.map((u) => ({
          type: "file",
          source: "id",
          file_id: u.file_id,
        }));
        setFileAttachments((prev) => ({ ...prev, [inputName]: uploaded }));
        let obj: Record<string, unknown> = {};
        try {
          obj = JSON.parse(input);
        } catch {
          /* ignore */
        }
        obj[inputName] = maxCount === 1 ? wireValues[0] : wireValues;
        setInput(JSON.stringify(obj, null, 2));
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading((p) => ({ ...p, [inputName]: false }));
      }
    },
    [input],
  );

  const clearFormFile = useCallback(
    (inputName: string) => {
      setFileAttachments((prev) => {
        const next = { ...prev };
        delete next[inputName];
        return next;
      });
      try {
        const obj = JSON.parse(input);
        delete obj[inputName];
        setInput(JSON.stringify(obj, null, 2));
      } catch {
        /* ignore */
      }
    },
    [input],
  );

  const handleJsonAttach = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setUploading((p) => ({ ...p, __json__: true }));
    try {
      const uploaded = await Promise.all(Array.from(files).map(uploadFileToApi));
      const refs = uploaded.map((u) => ({
        type: "file",
        source: "id",
        file_id: u.file_id,
      }));
      const snippet =
        refs.length === 1 ? JSON.stringify(refs[0], null, 2) : JSON.stringify(refs, null, 2);
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = ta.value.slice(0, start);
        const after = ta.value.slice(end);
        const next = before + snippet + after;
        setInput(next);
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(start + snippet.length, start + snippet.length);
        });
      } else {
        setInput((cur) => `${cur}\n${snippet}`);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading((p) => ({ ...p, __json__: false }));
    }
  }, []);

  if (agentLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse" />
        <div className="h-32 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse" />
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
    ?.inputs as AgentInput[] | undefined;
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
                <div className="flex items-center p-0.5 rounded-sm bg-gray-100/60 dark:bg-gray-900 text-[10.5px]">
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
                  if (inp.type === "file") {
                    const maxCount = inp.max_count ?? 1;
                    const accept = mediaToAcceptAttr(inp.media);
                    const attached = fileAttachments[inp.name] ?? [];
                    const isUploading = uploading[inp.name] === true;
                    return (
                      <div key={inp.name}>
                        <label
                          htmlFor={`input-${inp.name}`}
                          className="text-[11.5px] font-medium text-gray-700 dark:text-gray-300 mb-1 block"
                        >
                          {inp.name} {inp.required && <span className="text-red-400">*</span>}
                          <span className="ml-1.5 text-[10.5px] text-gray-400 font-normal">
                            ({inp.media ?? "file"}
                            {maxCount > 1 ? ` · up to ${maxCount}` : ""})
                          </span>
                        </label>
                        {inp.description && (
                          <p className="text-[10.5px] text-gray-400 mb-1.5">{inp.description}</p>
                        )}
                        <input
                          id={`input-${inp.name}`}
                          type="file"
                          accept={accept}
                          multiple={maxCount > 1}
                          disabled={status === "running" || isUploading}
                          onChange={(e) => {
                            handleFormFileSelect(inp.name, maxCount, e.target.files);
                            e.target.value = "";
                          }}
                          className="block w-full text-[11px] text-gray-600 dark:text-gray-400 file:mr-3 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-[11px] file:font-medium file:bg-sky-50 dark:file:bg-sky-900/30 file:text-sky-700 dark:file:text-sky-300 hover:file:bg-sky-100 dark:hover:file:bg-sky-900/50 file:cursor-pointer disabled:opacity-50"
                        />
                        {isUploading && (
                          <p className="text-[10.5px] text-amber-600 dark:text-amber-400 mt-1">
                            Uploading…
                          </p>
                        )}
                        {attached.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {attached.map((a) => (
                              <li
                                key={a.file_id}
                                className="flex items-center justify-between gap-2 px-2 py-1 rounded-sm bg-gray-50 dark:bg-gray-900/60 text-[11px]"
                              >
                                <span className="flex-1 truncate text-gray-700 dark:text-gray-300">
                                  {a.name}
                                </span>
                                <span className="text-gray-400 tabular-nums">
                                  {(a.size / 1024).toFixed(0)} KB
                                </span>
                                <span className="font-mono text-[10px] text-gray-400">
                                  {a.file_id.slice(0, 12)}…
                                </span>
                              </li>
                            ))}
                            <li>
                              <button
                                type="button"
                                onClick={() => clearFormFile(inp.name)}
                                className="text-[10.5px] text-gray-500 hover:text-red-600"
                              >
                                Clear
                              </button>
                            </li>
                          </ul>
                        )}
                      </div>
                    );
                  }
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
                        className="w-full h-8 px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-[12px] text-gray-800 dark:text-gray-200 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15 disabled:opacity-50"
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={10}
                  disabled={status === "running"}
                  className="w-full px-4 py-3 pb-10 text-[11.5px] font-mono leading-[1.55] text-gray-700 dark:text-gray-300 bg-gray-50/40 dark:bg-gray-950/60 border-0 outline-hidden resize-none disabled:opacity-50"
                  spellCheck={false}
                />
                <div className="absolute bottom-2 right-3 flex items-center gap-2">
                  {uploading.__json__ && (
                    <span className="text-[10.5px] text-amber-600 dark:text-amber-400">
                      Uploading…
                    </span>
                  )}
                  <input
                    ref={jsonAttachRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      handleJsonAttach(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => jsonAttachRef.current?.click()}
                    disabled={status === "running" || uploading.__json__}
                    className="px-2 py-0.5 rounded-md text-[10.5px] font-medium bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50 disabled:opacity-50"
                  >
                    Attach file
                  </button>
                </div>
              </div>
            )}
            {uploadError && (
              <div className="px-4 py-2 border-t border-red-100 dark:border-red-900/40 text-[11px] text-red-600 dark:text-red-400">
                {uploadError}
              </div>
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
                  className="w-full h-8 px-2.5 mb-2 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-[11.5px] text-gray-800 dark:text-gray-200 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15 disabled:opacity-50"
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
                  className="flex-1 bg-transparent outline-hidden text-[11.5px] font-mono text-gray-700 dark:text-gray-300 placeholder:text-gray-400 disabled:opacity-50"
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
                  className="w-full h-8 px-2.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 text-[11.5px] font-mono text-gray-800 dark:text-gray-200 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15 disabled:opacity-50"
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
              <div className="px-4 py-3 space-y-1.5 font-mono text-[11.5px] leading-relaxed bg-linear-to-b from-white to-gray-50/40 dark:from-gray-950/40 dark:to-gray-950/70 max-h-[300px] overflow-y-auto">
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
