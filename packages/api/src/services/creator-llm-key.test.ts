import { describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import type { Agent } from "../db/schema.js";
import {
  attachCreatorKey,
  listCreatorKeys,
  removeCreatorKey,
  resolveCreatorKeys,
} from "./creator-llm-key.js";
import { EnvKeyProvider, MASTER_KEY_BYTES } from "./secrets/key-provider.js";

const configured = new EnvKeyProvider(Buffer.alloc(MASTER_KEY_BYTES, 9));
const unconfigured = new EnvKeyProvider(null);

async function makeAgent(db: MemoryDb): Promise<Agent> {
  const user = await db.createUser({ github_id: "clk-u", username: "clk-u" });
  return db.createAgent({ name: "a", namespace: "clk", description: "", owner_id: user.id });
}

describe("creator-llm-key service", () => {
  it("attaches, lists presence (last4 only), and resolves the decrypted key", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);

    const res = await attachCreatorKey(
      db,
      configured,
      agent,
      "anthropic",
      "sk-ant-abcdef1234567890",
    );
    expect(res).toEqual({ provider: "anthropic", last4: "7890" });

    expect(await listCreatorKeys(db, agent)).toEqual([
      { provider: "anthropic", last4: "7890", updated_at: expect.any(String) },
    ]);

    expect(await resolveCreatorKeys(db, configured, agent.id)).toEqual({
      anthropic: "sk-ant-abcdef1234567890",
    });
  });

  it("resolveCreatorKeys returns {} when none attached", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    expect(await resolveCreatorKeys(db, configured, agent.id)).toEqual({});
  });

  it("fail-closed: attach without encryption configured → 500 ENCRYPTION_NOT_CONFIGURED, nothing stored", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    await expect(
      attachCreatorKey(db, unconfigured, agent, "anthropic", "sk-ant-abcdef1234567890"),
    ).rejects.toMatchObject({ code: "ENCRYPTION_NOT_CONFIGURED", status: 500 });
    expect(await listCreatorKeys(db, agent)).toEqual([]);
  });

  it("rejects a non-instantiable provider (meta)", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    await expect(
      attachCreatorKey(db, configured, agent, "meta", "sk-meta-abcdef1234567890"),
    ).rejects.toMatchObject({ code: "INVALID_LLM_PROVIDER", status: 400 });
  });

  it("rejects a too-short key", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    await expect(
      attachCreatorKey(db, configured, agent, "openai", "sk-short"),
    ).rejects.toMatchObject({ code: "INVALID_LLM_KEY", status: 400 });
  });

  it("normalizes provider case (OpenAI → openai)", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    const res = await attachCreatorKey(db, configured, agent, "OpenAI", "sk-proj-abcdef1234567890");
    expect(res.provider).toBe("openai");
    expect(Object.keys(await resolveCreatorKeys(db, configured, agent.id))).toEqual(["openai"]);
  });

  it("removeCreatorKey deletes the provider", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    await attachCreatorKey(db, configured, agent, "anthropic", "sk-ant-abcdef1234567890");
    await removeCreatorKey(db, agent, "anthropic");
    expect(await listCreatorKeys(db, agent)).toEqual([]);
  });

  it("resolveCreatorKeys hard-errors when the master key can't decrypt (rotated away)", async () => {
    const db = new MemoryDb();
    const agent = await makeAgent(db);
    await attachCreatorKey(db, configured, agent, "anthropic", "sk-ant-abcdef1234567890");
    const otherKey = new EnvKeyProvider(Buffer.alloc(MASTER_KEY_BYTES, 1));
    await expect(resolveCreatorKeys(db, otherKey, agent.id)).rejects.toThrow();
  });
});
