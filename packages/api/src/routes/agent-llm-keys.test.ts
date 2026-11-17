import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import { validBundle } from "./agent-bundle.shared.js";

const KEY_ENV = "SKRUN_SECRETS_ENCRYPTION_KEY";
const LOCAL_HOSTS_ENV = "SKRUN_ALLOW_LOCAL_MODEL_HOSTS";

describe("agent LLM key routes (#102)", () => {
  const prevKey = process.env[KEY_ENV];
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;

  beforeEach(() => {
    process.env[KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prevKey;
  });

  /** A user + an account-wide (master credential) key. */
  async function makeUser(username: string): Promise<{ id: string; key: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "a",
    });
    return { id: user.id, key };
  }

  /** A delegated (resource-scoped) key — NOT a master credential. */
  async function makeDelegatedKey(userId: string, agentId: string): Promise<string> {
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "scoped",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agentId],
    });
    return key;
  }

  async function pushAgent(ownerKey: string, ns: string, name: string): Promise<string> {
    const pushed = await app.request(`/api/agents/${ns}/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle(name)),
    });
    if (pushed.status !== 200) throw new Error(`push answered ${pushed.status}`);
    const agent = await db.getAgent(ns, name);
    if (!agent) throw new Error("agent missing after push");
    return agent.id;
  }

  function req(method: string, key: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return app.request(`/api/agents/${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  it("VT-11: attach + GET round-trips presence (provider + last4), never the key", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "bot");

    const put = await req("PUT", alice.key, "alice/bot/llm-keys/anthropic", {
      key: "sk-ant-abcdef1234567890",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ provider: "anthropic", last4: "7890" });

    const get = await req("GET", alice.key, "alice/bot/llm-keys");
    expect(get.status).toBe(200);
    const bodyText = await get.text();
    // The full key / ciphertext must never appear in the response.
    expect(bodyText).not.toContain("sk-ant-abcdef1234567890");
    const parsed = JSON.parse(bodyText) as {
      policy: string;
      keys: { provider: string; last4: string; updated_at: string }[];
    };
    expect(parsed.policy).toBe("open");
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0].provider).toBe("anthropic");
    expect(parsed.keys[0].last4).toBe("7890");
    expect(Object.keys(parsed.keys[0]).sort()).toEqual(["last4", "provider", "updated_at"]);
  });

  it("VT-9: a delegated key cannot manage keys (403 KEY_SCOPE_FORBIDDEN)", async () => {
    const alice = await makeUser("alice");
    const agentId = await pushAgent(alice.key, "alice", "bot");
    const delegated = await makeDelegatedKey(alice.id, agentId);

    for (const [method, path, body] of [
      ["GET", "alice/bot/llm-keys", undefined],
      ["PUT", "alice/bot/llm-keys/anthropic", { key: "sk-ant-abcdef1234567890" }],
      ["PUT", "alice/bot/llm-key-policy", { policy: "creator_only" }],
    ] as const) {
      const res = await req(method, delegated, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "KEY_SCOPE_FORBIDDEN",
      );
    }
  });

  it("VT-10: a cross-account caller cannot manage another namespace (403 FORBIDDEN)", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "bot");
    const bob = await makeUser("bob");

    const res = await req("PUT", bob.key, "alice/bot/llm-keys/anthropic", {
      key: "sk-ant-abcdef1234567890",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("VT-6: attach is refused when encryption is unconfigured (500 ENCRYPTION_NOT_CONFIGURED)", async () => {
    delete process.env[KEY_ENV];
    const db2 = new MemoryDb();
    const app2 = createApp(new MemoryStorage(), db2);
    const user = await db2.createUser({ github_id: "gh-carol", username: "carol" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db2.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "a",
    });
    const pushed = await app2.request("/api/agents/carol/bot/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundle("bot")),
    });
    expect(pushed.status).toBe(200);
    const res = await app2.request("/api/agents/carol/bot/llm-keys/anthropic", {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "sk-ant-abcdef1234567890" }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "ENCRYPTION_NOT_CONFIGURED",
    );
  });

  it("attaches a key for meta (200), a provider agent.yaml knows", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "bot");
    const res = await req("PUT", alice.key, "alice/bot/llm-keys/meta", {
      key: "sk-meta-abcdef1234567890",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "meta", last4: "7890" });
  });

  it("rejects a provider agent.yaml does not know with 400 INVALID_LLM_PROVIDER, naming every one it does", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "bot");
    const res = await req("PUT", alice.key, "alice/bot/llm-keys/acme", {
      key: "sk-acme-abcdef1234567890",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_LLM_PROVIDER",
        message:
          "Unsupported LLM provider 'acme'. Supported: anthropic, google, groq, meta, mistral, openai, xai.",
      },
    });
  });

  it("a creator key attached for meta serves a run of a meta agent at its base_url, with no caller key", async () => {
    const CREATOR_KEY = "sk-meta-creator-0123456789abcdef";
    const seen: { method?: string; url?: string; authorization?: string }[] = [];
    // An OpenAI-compatible endpoint on this machine: it records each request
    // and answers one chat completion.
    const server = createServer((request: IncomingMessage, response) => {
      request.resume();
      request.on("end", () => {
        seen.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: "chatcmpl-local",
            object: "chat.completion",
            created: 0,
            model: "llama-local",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: '{"answer":"ok"}' },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    // A base_url on a private address is refused unless the operator allows it.
    const prevLocalHosts = process.env[LOCAL_HOSTS_ENV];
    process.env[LOCAL_HOSTS_ENV] = "true";
    try {
      const localApp = createApp(new MemoryStorage(), db, {
        verificationPolicy: "owner",
        runtimeMode: "local",
      });
      const alice = await makeUser("alice");
      const agentYaml = [
        "name: meta-bot",
        "version: 1.0.0",
        "model:",
        "  provider: meta",
        "  name: llama-local",
        `  base_url: http://127.0.0.1:${port}/v1`,
        "inputs:",
        "  - name: q",
        "    type: string",
        "outputs:",
        "  - name: answer",
        "    type: string",
      ].join("\n");
      const bundle = await packAgentTar([
        { name: "agent.yaml", content: Buffer.from(agentYaml) },
        { name: "SKILL.md", content: Buffer.from("# meta-bot\n") },
      ]);
      const push = await localApp.request("/api/agents/alice/meta-bot/push?version=1.0.0", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.key}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(bundle),
      });
      expect(push.status).toBe(200);

      const attach = await localApp.request("/api/agents/alice/meta-bot/llm-keys/meta", {
        method: "PUT",
        headers: { Authorization: `Bearer ${alice.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key: CREATOR_KEY }),
      });
      expect(attach.status).toBe(200);

      const run = await localApp.request("/api/agents/alice/meta-bot/run", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: { q: "hi" } }),
      });
      expect(run.status).toBe(200);
      expect(await run.json()).toMatchObject({ status: "completed", output: { answer: "ok" } });
      expect(seen).toEqual([
        { method: "POST", url: "/v1/chat/completions", authorization: `Bearer ${CREATOR_KEY}` },
      ]);
    } finally {
      if (prevLocalHosts === undefined) delete process.env[LOCAL_HOSTS_ENV];
      else process.env[LOCAL_HOSTS_ENV] = prevLocalHosts;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("VT-20: sets creator_only without a key → policy set + a non-blocking warning, reflected on GET", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "bot");

    const put = await req("PUT", alice.key, "alice/bot/llm-key-policy", { policy: "creator_only" });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { policy: string; warning?: string };
    expect(body.policy).toBe("creator_only");
    expect(body.warning).toMatch(/No creator LLM key/);

    const get = await req("GET", alice.key, "alice/bot/llm-keys");
    expect(((await get.json()) as { policy: string }).policy).toBe("creator_only");
  });

  it("sets creator_only WITH a key attached → no warning", async () => {
    const alice = await makeUser("alice");
    await pushAgent(alice.key, "alice", "bot");
    await req("PUT", alice.key, "alice/bot/llm-keys/anthropic", { key: "sk-ant-abcdef1234567890" });

    const put = await req("PUT", alice.key, "alice/bot/llm-key-policy", { policy: "creator_only" });
    const body = (await put.json()) as { policy: string; warning?: string };
    expect(body.policy).toBe("creator_only");
    expect(body.warning).toBeUndefined();
  });
});
