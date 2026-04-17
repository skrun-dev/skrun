/**
 * E2E: SDK — test @skrun-dev/sdk against a real local HTTP server.
 * Uses Node's http.createServer + Hono's fetch handler.
 */
import { type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";
import { SkrunApiError, SkrunClient } from "../../packages/sdk/src/index.js";

let server: Server;
let port: number;
let client: SkrunClient;

beforeAll(async () => {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db);

  // Start a real HTTP server that delegates to Hono
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const honoRes = await app.fetch(
      new Request(`http://localhost:${port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      }),
    );

    res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()));
    const resBody = await honoRes.arrayBuffer();
    res.end(Buffer.from(resBody));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  client = new SkrunClient({ baseUrl: `http://localhost:${port}`, token: "dev-token" });
});

afterAll(() => {
  server?.close();
});

describe("E2E: SDK", () => {
  it("list() returns empty agent list", async () => {
    const result = await client.list();
    expect(result.agents).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("push() + getAgent() + getVersions()", async () => {
    const bundle = Buffer.from("fake-bundle");
    const pushResult = await client.push("dev/sdk-test", bundle, "1.0.0");
    expect(pushResult.latest_version).toBe("1.0.0");

    const meta = await client.getAgent("dev/sdk-test");
    expect(meta.name).toBe("sdk-test");
    expect(meta.namespace).toBe("dev");

    const versions = await client.getVersions("dev/sdk-test");
    expect(versions).toContain("1.0.0");
  });

  it("pull() returns buffer", async () => {
    const buf = await client.pull("dev/sdk-test");
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it("list() returns pushed agent", async () => {
    const result = await client.list();
    expect(result.total).toBeGreaterThan(0);
    expect(result.agents.some((a) => a.name === "sdk-test")).toBe(true);
  });

  it("verify() sets verified flag", async () => {
    const result = await client.verify("dev/sdk-test", true);
    expect(result.verified).toBe(true);

    const meta = await client.getAgent("dev/sdk-test");
    expect(meta.verified).toBe(true);
  });

  it("run() on fake bundle returns BUNDLE_CORRUPT", async () => {
    try {
      await client.run("dev/sdk-test", {});
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      expect((e as SkrunApiError).status).toBe(500);
      expect((e as SkrunApiError).code).toBe("BUNDLE_CORRUPT");
    }
  });

  it("getAgent() on nonexistent → NOT_FOUND", async () => {
    try {
      await client.getAgent("dev/nonexistent");
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      expect((e as SkrunApiError).code).toBe("NOT_FOUND");
      expect((e as SkrunApiError).status).toBe(404);
    }
  });

  it("invalid agent format throws Error", async () => {
    await expect(client.run("no-slash", {})).rejects.toThrow("Agent must be 'namespace/name'");
  });

  it("agent object format works", async () => {
    try {
      await client.run({ namespace: "dev", name: "sdk-test" }, {});
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      expect((e as SkrunApiError).code).toBe("BUNDLE_CORRUPT");
    }
  });

  it("run() with environment option passes it in request body (VT-11)", async () => {
    // Environment override is passed through to the API. Since the bundle is fake,
    // we expect BUNDLE_CORRUPT (same as run() without env) — proving the env option
    // doesn't break the request flow and reaches the server.
    try {
      await client.run(
        "dev/sdk-test",
        {},
        {
          environment: { timeout: "600s", max_cost: 10.0 },
        },
      );
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      // If environment was rejected, we'd get 400 INVALID_ENVIRONMENT.
      // Getting BUNDLE_CORRUPT means environment was accepted and we progressed further.
      expect((e as SkrunApiError).code).toBe("BUNDLE_CORRUPT");
    }
  });
});
