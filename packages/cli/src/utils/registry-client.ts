import {
  cachedNamespace,
  cacheNamespace,
  InvalidRegistryUrl,
  NotSignedIn,
  resolveTarget,
  send,
  sessionState,
  type Target,
  type TargetSource,
} from "./auth.js";
import { exitWith } from "./exit.js";
import * as format from "./format.js";

/** An Error carrying `{ code, status }`, as `RegistryClient.run` throws them. */
function streamInterrupted(): Error & { code: string; status: number } {
  const err = new Error("The event stream closed before the run ended") as Error & {
    code: string;
    status: number;
  };
  err.code = "STREAM_INTERRUPTED";
  err.status = 0;
  return err;
}

/**
 * Collect a run's event stream (SSE) into the result a synchronous `POST /run`
 * returns, with the same shape: `run_start` gives the resolved version;
 * `run_complete` gives the completed result, its `files` each with their
 * download `url` and its `files_excluded` counts (`{}` from a server that does
 * not send them); `run_error` gives the failed result the synchronous call
 * returns (`status: "failed"`, `error` holding the message, an empty output,
 * zero usage, and nothing left out). A stream that ends before either throws
 * `STREAM_INTERRUPTED`. Every other event is skipped, a type or a stage this
 * CLI does not know included. The response is cancelled once the result is
 * read.
 *
 * A copy of the SDK's collector, on purpose: the CLI does not depend on the SDK.
 */
export async function collectRunStream(
  body: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  let agentVersion: string | undefined;

  /** The result, once a terminal event is read; undefined before. */
  const take = (block: string): Record<string, unknown> | undefined => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data) return undefined;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (event.type === "run_start") {
      agentVersion = event.agent_version as string | undefined;
    } else if (event.type === "run_complete") {
      return {
        run_id: event.run_id,
        status: "completed",
        agent_version: agentVersion ?? "unknown",
        output: event.output,
        usage: event.usage,
        cost: event.cost,
        duration_ms: event.duration_ms,
        files: event.files ?? [],
        files_excluded: event.files_excluded ?? {},
      };
    } else if (event.type === "run_error") {
      const error = event.error as { message?: string } | undefined;
      return {
        run_id: event.run_id,
        status: "failed",
        agent_version: agentVersion ?? "unknown",
        output: {},
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cost: { estimated: 0 },
        duration_ms: 0,
        files: [],
        files_excluded: {},
        error: error?.message ?? "Unknown error",
      };
    }
    return undefined;
  };

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      const blocks = buffer.split("\n\n");
      buffer = done ? "" : (blocks.pop() ?? "");
      for (const block of blocks) {
        const result = take(block);
        if (result) {
          // The run is over: close the response now, as the SDK does, rather
          // than hold it until the server ends it — on the cloud runtime, not
          // before the run's machine is destroyed.
          await reader.cancel().catch(() => {});
          return result;
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  throw streamInterrupted();
}

/** What the server says of verification, as `GET /api/me` exposes it. */
export interface VerificationView {
  /** The operator's policy; absent when the server did not say. */
  policy?: "admin" | "owner" | "disabled";
  /** The caller's role on that server. */
  role?: string;
}

/**
 * The registry client of the server a command targets — the order of
 * `resolveTarget()` — with that server's session. Without one, nothing is
 * sent: the command ends, saying why (no session for that server, a file of an
 * older CLI, a file that cannot be read) and how to sign in. An invalid
 * `SKRUN_REGISTRY_URL` ends it too, naming the variable.
 */
export function connect(): RegistryClient {
  let target: Target;
  try {
    target = resolveTarget();
  } catch (err) {
    if (!(err instanceof InvalidRegistryUrl)) throw err;
    format.error(err.message);
    exitWith(1);
  }
  const state = sessionState(target.address);
  if (state !== "present") {
    format.error(new NotSignedIn(target.address, state, target.source).message);
    exitWith(1);
  }
  return new RegistryClient(target.address, target.source);
}

/**
 * The routes of a Skrun server, for the CLI. The client holds no token: every
 * request leaves through `send()`, which carries the one saved for this
 * server's address and follows no redirect. `source`, where the address came
 * from, shapes only the advice of an error's message.
 */
export class RegistryClient {
  constructor(
    private baseUrl: string,
    private source?: TargetSource,
  ) {}

  /**
   * A request to this server, under its session: no session for it throws
   * `NotSignedIn`, nothing sent; a redirect throws `RedirectRefused`, no answer
   * `Unreachable` — each naming the server.
   */
  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return send(this.baseUrl, path, init, "session", this.source);
  }

  /**
   * The server's verification policy and the caller's role, from `GET
   * /api/me`, at best: a refusal, a network failure, a slow answer (5 s) or a
   * profile without the policy (a server older than the field) all give an
   * empty view, and the note after a push falls back to what it always said.
   */
  async verificationView(): Promise<VerificationView> {
    try {
      const res = await this.request("/api/me", { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return {};
      const profile = (await res.json()) as { verification_policy?: unknown; role?: unknown };
      const policy = profile.verification_policy;
      if (policy !== "admin" && policy !== "owner" && policy !== "disabled") return {};
      return { policy, role: typeof profile.role === "string" ? profile.role : undefined };
    } catch {
      return {};
    }
  }

  /**
   * An agent's recent runs, newest first, at most `limit`. A refusal throws an
   * Error carrying the `status`, so the command can tell an unknown agent (404)
   * from another failure.
   */
  async logs(
    namespace: string,
    name: string,
    limit: string | number,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await this.request(`/api/agents/${namespace}/${name}/logs?limit=${limit}`);
    if (!res.ok) {
      const err = new Error(`Failed to fetch logs (${res.status})`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    const data = (await res.json()) as { logs?: Array<Record<string, unknown>> };
    return data.logs ?? [];
  }

  /**
   * The caller's namespace on this server — the registry derives it from the
   * caller's credentials at push time, and the push URL names it. Known without
   * a request for the local development token (`dev`) or when saved with the
   * session; otherwise asked once from `GET /api/me`, and saved with this
   * server's session — the current server is left as it is.
   */
  async currentNamespace(): Promise<string> {
    const known = cachedNamespace(this.baseUrl);
    if (known !== undefined) return known;
    const res = await this.request("/api/me");
    if (!res.ok) {
      throw new Error(
        `Failed to resolve your namespace from the registry (HTTP ${res.status}). Run \`skrun login\` again.`,
      );
    }
    const data = (await res.json()) as { namespace?: string };
    if (!data.namespace) {
      throw new Error("Registry /api/me response missing the `namespace` field.");
    }
    cacheNamespace(this.baseUrl, data.namespace);
    return data.namespace;
  }

  async push(
    bundle: Buffer,
    namespace: string,
    name: string,
    version: string,
    opts?: { notes?: string },
  ): Promise<{ body: Record<string, unknown>; warning?: string }> {
    const path = `/api/agents/${namespace}/${name}/push?version=${version}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (opts?.notes) {
      // HTTP header values must be latin-1. Percent-encode to safely carry non-ASCII notes.
      headers["X-Skrun-Version-Notes"] = encodeURIComponent(opts.notes);
    }
    const res = await this.request(path, {
      method: "POST",
      headers,
      body: bundle,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Push failed (${res.status}): ${msg}`);
    }

    const warning = res.headers.get("X-Skrun-Warning") ?? undefined;
    return { body: (await res.json()) as Record<string, unknown>, warning };
  }

  async pull(namespace: string, name: string, version?: string): Promise<Buffer> {
    const versionPath = version ? `/pull/${version}` : "/pull";
    const res = await this.request(`/api/agents/${namespace}/${name}${versionPath}`);

    if (!res.ok) {
      const errBody = await res
        .json()
        .catch(() => ({ error: { code: "UNKNOWN", message: res.statusText } }));
      const code = (errBody as { error?: { code?: string } }).error?.code ?? "UNKNOWN";
      const msg = (errBody as { error?: { message?: string } }).error?.message ?? res.statusText;
      // Mirror the run() pattern: preserve `code` + `status` on the thrown
      // Error so callers can distinguish 404 NOT_FOUND from other failures
      // and render context-appropriate messages (e.g. 3-cause hint for 404).
      const err = new Error(msg) as Error & { code: string; status: number };
      err.code = code;
      err.status = res.status;
      throw err;
    }

    return Buffer.from(await res.arrayBuffer());
  }

  async list(page = 1, limit = 20): Promise<Record<string, unknown>> {
    // Under the session: the endpoint is no longer public — anonymous callers
    // get 401. The token's role determines whether the server returns the
    // caller's own agents or all agents instance-wide.
    const res = await this.request(`/api/agents?page=${page}&limit=${limit}`);
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }

  async createKey(input: {
    name: string;
    scope_kind?: "account" | "agents";
    agents?: string[];
    scopes?: string[];
    /** ISO-8601 instant; absent, the key never expires. */
    expires_at?: string;
  }): Promise<Record<string, unknown>> {
    const res = await this.request("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Create key failed (${res.status}): ${msg}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async listKeys(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("/api/keys");
    if (!res.ok) throw new Error(`List keys failed (${res.status})`);
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  async revokeKey(id: string): Promise<void> {
    const res = await this.request(`/api/keys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Revoke key failed (${res.status}): ${msg}`);
    }
  }

  async setLlmKey(ns: string, name: string, provider: string, key: string): Promise<void> {
    const res = await this.request(`/api/agents/${ns}/${name}/llm-keys/${provider}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Attach LLM key failed (${res.status}): ${msg}`);
    }
  }

  async listLlmKeys(
    ns: string,
    name: string,
  ): Promise<{ policy: string; keys: Array<Record<string, unknown>> }> {
    const res = await this.request(`/api/agents/${ns}/${name}/llm-keys`);
    if (!res.ok) throw new Error(`List LLM keys failed (${res.status})`);
    return (await res.json()) as { policy: string; keys: Array<Record<string, unknown>> };
  }

  async removeLlmKey(ns: string, name: string, provider: string): Promise<void> {
    const res = await this.request(`/api/agents/${ns}/${name}/llm-keys/${provider}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Remove LLM key failed (${res.status}): ${msg}`);
    }
  }

  async setLlmKeyPolicy(ns: string, name: string, policy: string): Promise<void> {
    const res = await this.request(`/api/agents/${ns}/${name}/llm-key-policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Set LLM key policy failed (${res.status}): ${msg}`);
    }
  }

  /**
   * Invoke POST /run and wait for the result: the run's event stream is read
   * and collected into the result the synchronous call returns, with the same
   * shape (`collectRunStream`) — which is what lets it run on every runtime,
   * the cloud one included, where only a stream is served. No total deadline:
   * the server sends a heartbeat about every 30 s while a run waits.
   *
   * `llmKeys` go in the X-LLM-API-Key header, and nowhere else. `llmBaseUrls`
   * — the endpoint each provider's key belongs to — go in X-LLM-Base-URL, a
   * JSON object of provider to address, as the SDK sends it.
   *
   * Errors carry `{ code, status }` on the thrown Error so callers can render
   * `<code>: <message>` without leaking the raw response body — required by
   * AC-27c security hygiene for the CLI `skrun run` command.
   */
  async run(
    namespace: string,
    name: string,
    input: Record<string, unknown>,
    opts?: {
      version?: string;
      llmKeys?: Record<string, string>;
      llmBaseUrls?: Record<string, string>;
    },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { input };
    if (opts?.version) body.version = opts.version;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (opts?.llmKeys) headers["X-LLM-API-Key"] = JSON.stringify(opts.llmKeys);
    if (opts?.llmBaseUrls) headers["X-LLM-Base-URL"] = JSON.stringify(opts.llmBaseUrls);
    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res
        .json()
        .catch(() => ({ error: { code: "UNKNOWN", message: res.statusText } }));
      const code = (errBody as { error?: { code?: string } }).error?.code ?? "UNKNOWN";
      const msg = (errBody as { error?: { message?: string } }).error?.message ?? res.statusText;
      const err = new Error(msg) as Error & { code: string; status: number };
      err.code = code;
      err.status = res.status;
      throw err;
    }

    if (!res.body) throw streamInterrupted();
    return collectRunStream(res.body);
  }

  async verifyVersion(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/agents/${namespace}/${name}/versions/${version}/verify`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Verify failed (${res.status}): ${msg}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  async setVisibility(
    namespace: string,
    name: string,
    visibility: "private" | "public",
  ): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/agents/${namespace}/${name}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Set visibility failed (${res.status}): ${msg}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }
}
