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
    force = false,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ version });
    if (force) {
      params.set("force", "true");
    }
    const url = `${this.baseUrl}/api/agents/${namespace}/${name}/push?${params.toString()}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/octet-stream",
      },
      body: bundle,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      const msg = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Push failed (${res.status}): ${msg}`);
    }

    return (await res.json()) as Record<string, unknown>;
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
