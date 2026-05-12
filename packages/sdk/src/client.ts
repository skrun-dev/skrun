import { SkrunApiError, SkrunFileUploadError } from "./errors.js";
import { parseSSEStream } from "./sse.js";
import type {
  AgentIdentifier,
  AgentMetadata,
  AsyncRunResult,
  ListOptions,
  PaginatedList,
  PushOptions,
  PushResult,
  RunEvent,
  RunInput,
  RunInputValue,
  RunOptions,
  SdkRunResult,
  SdkUploadedFileInfo,
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
  async run(agent: AgentIdentifier, input: RunInput, options?: RunOptions): Promise<SdkRunResult> {
    const { namespace, name } = this.parseAgent(agent);
    const resolvedInput = await this.uploadBinaryInputs(input);
    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers: this.buildHeaders(options),
      body: JSON.stringify(this.buildRunBody(resolvedInput, options)),
      timeout: options?.timeout,
    });
    return (await res.json()) as SdkRunResult;
  }

  /** Stream agent execution via SSE. Returns an async iterable of RunEvent objects. */
  async *stream(
    agent: AgentIdentifier,
    input: RunInput,
    options?: RunOptions,
  ): AsyncGenerator<RunEvent> {
    const { namespace, name } = this.parseAgent(agent);
    const resolvedInput = await this.uploadBinaryInputs(input);
    const headers = this.buildHeaders(options);
    headers.Accept = "text/event-stream";

    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(this.buildRunBody(resolvedInput, options)),
      timeout: options?.timeout,
    });

    yield* parseSSEStream(res);
  }

  /** Run an agent asynchronously. Returns immediately with a run ID. Result delivered via webhook. */
  async runAsync(
    agent: AgentIdentifier,
    input: RunInput,
    webhookUrl: string,
    options?: RunOptions,
  ): Promise<AsyncRunResult> {
    const { namespace, name } = this.parseAgent(agent);
    const resolvedInput = await this.uploadBinaryInputs(input);
    const res = await this.request(`/api/agents/${namespace}/${name}/run`, {
      method: "POST",
      headers: this.buildHeaders(options),
      body: JSON.stringify(this.buildRunBody(resolvedInput, options, webhookUrl)),
      timeout: options?.timeout,
    });
    return (await res.json()) as AsyncRunResult;
  }

  /** Upload a binary value to /api/files and return the file_id reference shape. */
  async uploadFile(
    blob: Blob | File | Uint8Array,
    options?: { filename?: string; contentType?: string },
  ): Promise<SdkUploadedFileInfo> {
    const fd = new FormData();
    const filename = options?.filename ?? (blob instanceof File ? blob.name : "upload.bin");
    const contentType =
      options?.contentType ??
      (blob instanceof Blob ? blob.type || "application/octet-stream" : "application/octet-stream");
    const blobToSend =
      blob instanceof Blob
        ? blob
        : new Blob([blob as unknown as ArrayBuffer], { type: contentType });
    fd.append("file", blobToSend, filename);

    let res: Response;
    try {
      res = await this.request("/api/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        body: fd,
      });
    } catch (err) {
      if (err instanceof SkrunApiError) {
        throw new SkrunFileUploadError(`Failed to upload file: ${err.message}`, err);
      }
      throw new SkrunFileUploadError("Failed to upload file", err);
    }
    return (await res.json()) as SdkUploadedFileInfo;
  }

  /**
   * Walk `input` for binary values (Blob/File/Uint8Array), upload each via
   * POST /api/files, and substitute the value with the wire-format file
   * reference shape `{type: "file", source: "id", file_id}`. Plain values
   * pass through unchanged.
   */
  private async uploadBinaryInputs(input: RunInput): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (Array.isArray(value)) {
        const arr: unknown[] = [];
        for (const item of value) {
          arr.push(await this.maybeUploadValue(item));
        }
        out[key] = arr;
      } else {
        out[key] = await this.maybeUploadValue(value);
      }
    }
    return out;
  }

  private async maybeUploadValue(value: RunInputValue): Promise<unknown> {
    if (isBinaryValue(value)) {
      const uploaded = await this.uploadFile(value);
      return { type: "file", source: "id", file_id: uploaded.file_id };
    }
    return value;
  }

  // --- Registry methods ---

  /** Push an agent bundle to the registry. */
  async push(
    agent: AgentIdentifier,
    bundle: Buffer | Uint8Array,
    version: string,
    options?: PushOptions,
  ): Promise<PushResult> {
    const { namespace, name } = this.parseAgent(agent);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/octet-stream",
    };
    if (options?.message !== undefined && options.message !== "") {
      if (options.message.length > 500) {
        throw new Error(`Push message too long (${options.message.length} chars). Max 500.`);
      }
      if (options.message.includes("\x00")) {
        throw new Error("Push message must not contain null bytes.");
      }
      // Percent-encode so non-ASCII characters transit safely in the HTTP header.
      headers["X-Skrun-Version-Notes"] = encodeURIComponent(options.message);
    }
    const res = await this.request(
      `/api/agents/${namespace}/${name}/push?version=${encodeURIComponent(version)}`,
      {
        method: "POST",
        headers,
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
    input: Record<string, unknown>, // resolved (post-uploadBinaryInputs)
    options?: RunOptions,
    webhookUrl?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { input };
    if (options?.version) body.version = options.version;
    if (options?.environment) body.environment = options.environment;
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

function isBinaryValue(v: unknown): v is Blob | File | Uint8Array {
  if (typeof Blob !== "undefined" && v instanceof Blob) return true;
  if (typeof File !== "undefined" && v instanceof File) return true;
  if (v instanceof Uint8Array) return true;
  return false;
}
