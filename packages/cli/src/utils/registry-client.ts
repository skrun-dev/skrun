export class RegistryClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async push(
    bundle: Buffer,
    namespace: string,
    name: string,
    version: string,
    opts?: { notes?: string },
  ): Promise<{ body: Record<string, unknown>; warning?: string }> {
    const url = `${this.baseUrl}/api/agents/${namespace}/${name}/push?version=${version}`;
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      "Content-Type": "application/octet-stream",
    };
    if (opts?.notes) {
      // HTTP header values must be latin-1. Percent-encode to safely carry non-ASCII notes.
      headers["X-Skrun-Version-Notes"] = encodeURIComponent(opts.notes);
    }
    const res = await fetch(url, {
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
    const url = `${this.baseUrl}/api/agents/${namespace}/${name}${versionPath}`;
    const res = await fetch(url, { headers: this.authHeaders() });

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
    const url = `${this.baseUrl}/api/agents?page=${page}&limit=${limit}`;
    // Auth header required since the endpoint is no longer public —
    // anonymous callers get 401. The token's role determines whether the
    // server returns the caller's own agents or all agents instance-wide.
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Invoke POST /run synchronously. Returns the full SdkRunResult-shaped JSON.
   * Errors carry `{ code, status }` on the thrown Error so callers can render
   * `<code>: <message>` without leaking the raw response body — required by
   * AC-27c security hygiene for the CLI `skrun run` command.
   */
  async run(
    namespace: string,
    name: string,
    input: Record<string, unknown>,
    opts?: { version?: string },
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/api/agents/${namespace}/${name}/run`;
    const body: Record<string, unknown> = { input };
    if (opts?.version) body.version = opts.version;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
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

    return (await res.json()) as Record<string, unknown>;
  }

  async verifyVersion(
    namespace: string,
    name: string,
    version: string,
    verified: boolean,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/api/agents/${namespace}/${name}/versions/${version}/verify`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ verified }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Verify failed (${res.status}): ${msg}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }
}
