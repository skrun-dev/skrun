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
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Pull failed (${res.status}): ${msg}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  async list(page = 1, limit = 20): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/api/agents?page=${page}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`List failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }
}
