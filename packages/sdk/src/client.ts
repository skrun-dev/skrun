import { SkrunApiError } from "./errors.js";
import { parseSSEStream } from "./sse.js";
import type {
  AgentIdentifier,
  AgentMetadata,
  AsyncRunResult,
  ListOptions,
  PaginatedList,
  PushResult,
  RunEvent,
  RunOptions,
  SdkRunResult,
  SkrunClientOptions,
} from "./types.js";

const DEFAULT_TIMEOUT = 60_000;

export class SkrunClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeout: number;

  constructor(options: SkrunClientOptions) {
    // Validate baseUrl
    try {
      new URL(options.baseUrl);
    } catch {
      throw new Error("Invalid baseUrl: must be a valid URL");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, ""); // strip trailing slash
    this.token = options.token;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  // --- Execution methods ---

  /** Run an agent synchronously. Blocks until completion. */
  async run(
    agent: AgentIdentifier,
    input: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<SdkRunResult> {
    const { namespace, name } = this.parseAgent(agent);
    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers: this.buildHeaders(options),
      body: JSON.stringify(this.buildRunBody(input, options)),
      timeout: options?.timeout,
    });
    return (await res.json()) as SdkRunResult;
  }

  /** Stream agent execution via SSE. Returns an async iterable of RunEvent objects. */
  async *stream(
    agent: AgentIdentifier,
    input: Record<string, unknown>,
    options?: RunOptions,
  ): AsyncGenerator<RunEvent> {
    const { namespace, name } = this.parseAgent(agent);
    const headers = this.buildHeaders(options);
    headers.Accept = "text/event-stream";

    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(this.buildRunBody(input, options)),
      timeout: options?.timeout,
    });

    yield* parseSSEStream(res);
  }

  /** Run an agent asynchronously. Returns immediately with a run ID. Result delivered via webhook. */
  async runAsync(
    agent: AgentIdentifier,
    input: Record<string, unknown>,
    webhookUrl: string,
    options?: RunOptions,
  ): Promise<AsyncRunResult> {
    const { namespace, name } = this.parseAgent(agent);
    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers: this.buildHeaders(options),
      body: JSON.stringify(this.buildRunBody(input, options, webhookUrl)),
      timeout: options?.timeout,
    });
    return (await res.json()) as AsyncRunResult;
  }

  // --- Registry methods ---

  /** Push an agent bundle to the registry. */
  async push(
    agent: AgentIdentifier,
    bundle: Buffer | Uint8Array,
    version: string,
  ): Promise<PushResult> {
    const { namespace, name } = this.parseAgent(agent);
    const res = await this.request(
      `/api/agents/${namespace}/${name}/push?version=${encodeURIComponent(version)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: bundle,
      },
    );
    return (await res.json()) as PushResult;
  }

  /** Pull an agent bundle from the registry. */
  async pull(agent: AgentIdentifier, version?: string): Promise<Buffer> {
    const { namespace, name } = this.parseAgent(agent);
    const path = version
      ? `/api/agents/${namespace}/${name}/pull/${encodeURIComponent(version)}`
      : `/api/agents/${namespace}/${name}/pull`;
    const res = await this.request(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /** List all agents in the registry. */
  async list(options?: ListOptions): Promise<PaginatedList> {
    const params = new URLSearchParams();
    if (options?.page) params.set("page", String(options.page));
    if (options?.limit) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await this.request(`/api/agents${qs}`, { method: "GET" });
    return (await res.json()) as PaginatedList;
  }

  /** Get metadata for a specific agent. */
  async getAgent(agent: AgentIdentifier): Promise<AgentMetadata> {
    const { namespace, name } = this.parseAgent(agent);
    const res = await this.request(`/api/agents/${namespace}/${name}`, { method: "GET" });
    return (await res.json()) as AgentMetadata;
  }

  /** Get all published versions of an agent. */
  async getVersions(agent: AgentIdentifier): Promise<string[]> {
    const { namespace, name } = this.parseAgent(agent);
    const res = await this.request(`/api/agents/${namespace}/${name}/versions`, { method: "GET" });
    const body = (await res.json()) as {
      versions: Array<string | { version: string }>;
    };
    return body.versions.map((v) => (typeof v === "string" ? v : v.version));
  }

  /** Set or unset the verified flag on an agent. */
  async verify(agent: AgentIdentifier, verified: boolean): Promise<AgentMetadata> {
    const { namespace, name } = this.parseAgent(agent);
    const res = await this.request(`/api/agents/${namespace}/${name}/verify`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ verified }),
    });
    return (await res.json()) as AgentMetadata;
  }

  // --- Private helpers ---

  private parseAgent(agent: AgentIdentifier): { namespace: string; name: string } {
    if (typeof agent === "object") return agent;
    const parts = agent.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("Agent must be 'namespace/name' format");
    }
    return { namespace: parts[0], name: parts[1] };
  }

  private buildRunBody(
    input: Record<string, unknown>,
    options?: RunOptions,
    webhookUrl?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { input };
    if (options?.version) body.version = options.version;
    if (webhookUrl) body.webhook_url = webhookUrl;
    return body;
  }

  private buildHeaders(options?: RunOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (options?.llmKeys) {
      headers["X-LLM-API-Key"] = JSON.stringify(options.llmKeys);
    }
    return headers;
  }

  private async request(path: string, init: RequestInit & { timeout?: number }): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = init.timeout ?? this.timeout;

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw SkrunApiError.timeout(timeoutMs);
      }
      throw SkrunApiError.networkError(this.baseUrl, err instanceof Error ? err : undefined);
    }

    // 2xx → return response for caller to parse
    if (response.ok) return response;

    // Non-2xx → throw typed error
    throw await SkrunApiError.fromResponse(response);
  }
}
