/**
 * E2E: SDK — test @skrun-dev/sdk against a real local HTTP server.
 * Uses Node's http.createServer + Hono's fetch handler.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDb } from "../../packages/api/src/db/memory.js";
import { createApp } from "../../packages/api/src/index.js";
import { validBundle } from "../../packages/api/src/routes/agent-bundle.shared.js";
import { storeVersion } from "../../packages/api/src/routes/stored-version.shared.js";
import { MemoryStorage } from "../../packages/api/src/storage/memory.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import { SkrunApiError, SkrunClient } from "../../packages/sdk/src/index.js";

let server: Server;
let port: number;
let client: SkrunClient;
let storage: MemoryStorage;
let db: MemoryDb;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  storage = new MemoryStorage();
  db = new MemoryDb();
  app = createApp(storage, db);

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
    const bundle = await validBundle("sdk-test");
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

  it("verifyVersion() sets per-version verified flag (admin only — dev-token is admin)", async () => {
    const result = await client.verifyVersion("dev/sdk-test", "1.0.0", true);
    expect(result.verified).toBe(true);
    expect(result.version).toBe("1.0.0");

    const meta = await client.getAgent("dev/sdk-test");
    expect(meta.latest_version_verified).toBe(true);
  });

  it("run() of a stored bundle that does not unpack returns BUNDLE_CORRUPT (post-verify)", async () => {
    // A version stored as a push stored one before it refused a bundle that
    // does not unpack, verified so the runtime gate passes: the run fails at
    // extraction, which is the assertion we care about.
    await storeVersion({
      app,
      storage,
      db,
      token: "dev-token",
      namespace: "dev",
      name: "sdk-corrupt",
      version: "1.0.0",
      bundle: Buffer.from("fake-bundle"),
      verified: true,
    });
    try {
      await client.run("dev/sdk-corrupt", {});
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      expect((e as SkrunApiError).status).toBe(500);
      expect((e as SkrunApiError).code).toBe("BUNDLE_CORRUPT");
    }
  });

  it("push() of a bundle whose agent.yaml names a secret → 400 UNSUPPORTED_FIELD, and nothing is published", async () => {
    // A real bundle: the server judges what its agent.yaml declares, which it
    // can only do when it reads.
    const agentYaml = [
      "name: sdk-secretive",
      "version: 1.0.0",
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      "  secrets: [X]",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from("# sdk-secretive\n") },
    ]);
    const refused = await client.push("dev/sdk-secretive", bundle, "1.0.0").catch((e) => e);
    expect(refused).toBeInstanceOf(SkrunApiError);
    expect(refused).toMatchObject({
      status: 400,
      code: "UNSUPPORTED_FIELD",
      message:
        "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.",
    });

    const read = await client.getAgent("dev/sdk-secretive").catch((e) => e);
    expect(read).toBeInstanceOf(SkrunApiError);
    expect(read).toMatchObject({ status: 404, code: "NOT_FOUND" });
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

  it("agent object format works (post-verify so runtime gate passes)", async () => {
    // The stored bundle that does not unpack, verified above: the run reaches
    // its extraction.
    try {
      await client.run({ namespace: "dev", name: "sdk-corrupt" }, {});
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      expect((e as SkrunApiError).code).toBe("BUNDLE_CORRUPT");
    }
  });

  it("run() with environment option passes it in request body (VT-11)", async () => {
    // Environment override is passed through to the API. The stored bundle
    // that does not unpack, verified above, takes the run to the
    // bundle-extraction phase (where it fails with BUNDLE_CORRUPT — proves env
    // was accepted).
    try {
      await client.run(
        "dev/sdk-corrupt",
        {},
        {
          environment: { timeout: "600s", max_cost: 10.0 },
        },
      );
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SkrunApiError);
      // If environment was rejected, we'd get 400 INVALID_ENVIRONMENT.
      // Getting BUNDLE_CORRUPT means environment was accepted + the verified
      // gate was passed (proving verifyVersion took effect).
      expect((e as SkrunApiError).code).toBe("BUNDLE_CORRUPT");
    }
  });
});
