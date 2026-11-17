import { beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { createSession, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

/**
 * What an instance administrator's credential reaches beyond its own account.
 *
 * The role belongs to the person; what a request may do belongs to the
 * credential it carries. A session, the dev token, or an account-wide key that
 * carries every operation is the administrator acting as such, and keeps every
 * widening. A key the administrator reduced to fewer operations, or delegated to
 * a client, is a credential handed out for one job: it answers as the same key
 * of an ordinary account would, on every route that widens for an administrator.
 *
 * Each widening is pinned by its own cases, so that losing one names that one:
 * the pool view, the agent list, an agent's metadata and versions, a run of
 * another account's private agent, an environment override, and an attestation.
 */

type Headers = Record<string, string>;

interface World {
  app: ReturnType<typeof createApp>;
  db: MemoryDb;
  /** An account-wide key carrying run and verify only: reduced, not every operation. */
  reduced: Headers;
  /** A key delegated to the administrator's own agent, carrying every operation. */
  delegated: Headers;
  /** The administrator's account-wide key with every operation. */
  full: Headers;
  /** The administrator's session cookie. */
  session: Headers;
  /** The dev token: an administrator by construction on a self-hosted instance. */
  devToken: Headers;
}

const NOT_FOUND = { error: { code: "NOT_FOUND" } };

async function mintKey(
  db: MemoryDb,
  userId: string,
  opts: { scope_kind?: "account" | "agents"; scopes?: string[]; agents?: string[] } = {},
): Promise<string> {
  const { key, keyHash, keyPrefix } = generateApiKey();
  await db.createApiKey({
    user_id: userId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name: "k",
    scope_kind: opts.scope_kind ?? "account",
    scopes: opts.scopes,
    agents: opts.agents ?? [],
  });
  return key;
}

/**
 * An administrator (`root`) who owns one private agent, and another account
 * (`alice`) who owns a private agent and one whose visibility is public. Every
 * version is unverified, so a run that gets past the authorization gates stops
 * at the verification gate, before anything executes.
 */
async function world(): Promise<World> {
  const storage = new MemoryStorage();
  const db = new MemoryDb();
  const app = createApp(storage, db, { verificationPolicy: "admin" });

  const root = await db.createUser({ github_id: "gh-root-1", username: "root" });
  // The promotion is an SQL statement on a real deployment; the in-memory store
  // hands back the very row it keeps.
  root.role = "admin";
  const alice = await db.createUser({ github_id: "gh-alice-2", username: "alice" });

  const own = await db.createAgent({
    name: "own",
    namespace: "root",
    description: "",
    owner_id: root.id,
  });
  const tool = await db.createAgent({
    name: "tool",
    namespace: "alice",
    description: "",
    owner_id: alice.id,
  });
  const open = await db.createAgent({
    name: "open",
    namespace: "alice",
    description: "",
    owner_id: alice.id,
  });
  await db.setVisibility("alice", "open", "public");
  for (const [agent, key] of [
    [own, "root/own/1.0.0.agent"],
    [tool, "alice/tool/1.0.0.agent"],
    [open, "alice/open/1.0.0.agent"],
  ] as const) {
    await db.createVersion(agent.id, { version: "1.0.0", size: 1, bundle_key: key });
    await storage.put(key, Buffer.from("bundle"));
  }

  const bearer = (token: string): Headers => ({ Authorization: `Bearer ${token}` });
  return {
    app,
    db,
    reduced: bearer(await mintKey(db, root.id, { scopes: ["agent:run", "agent:verify"] })),
    delegated: bearer(await mintKey(db, root.id, { scope_kind: "agents", agents: [own.id] })),
    full: bearer(await mintKey(db, root.id)),
    session: {
      Cookie: `${sessionCookieName()}=${await createSession(db, root.id)}`,
      "Sec-Fetch-Site": "same-origin",
    },
    devToken: bearer("dev-token"),
  };
}

/** The credentials that are the administrator acting as such. */
const MASTER = ["full", "session", "devToken"] as const;

function get(w: World, path: string, headers: Headers): Promise<Response> {
  return w.app.request(path, { headers });
}

function run(w: World, path: string, headers: Headers, body: object = {}): Promise<Response> {
  return w.app.request(path, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ input: {}, ...body }),
  });
}

function verify(w: World, headers: Headers): Promise<Response> {
  return w.app.request("/api/agents/alice/tool/versions/1.0.0/verify", {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ verified: true }),
  });
}

async function code(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

async function error(res: Response): Promise<{ code?: string; message?: string }> {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return body.error ?? {};
}

/** How a refusal names the credential an administrator acts with. */
const FULL_ACCESS =
  "full access (a session, the dev token, or an account-wide API key that carries every operation)";

const OVERRIDE = { environment: { networking: { allowed_hosts: ["evil.example.com"] } } };

let w: World;
beforeEach(async () => {
  w = await world();
});

describe("the pool view", () => {
  it("an administrator's reduced key gets the opaque 404 an ordinary account gets", async () => {
    const res = await get(w, "/api/admin/pool", w.reduced);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(NOT_FOUND);
  });

  it("an administrator's delegated key gets the opaque 404", async () => {
    const res = await get(w, "/api/admin/pool", w.delegated);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(NOT_FOUND);
  });

  it.each(MASTER)("the administrator's %s still reads it", async (cred) => {
    const res = await get(w, "/api/admin/pool", w[cred]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("the agent list", () => {
  async function names(res: Response): Promise<string[]> {
    const body = (await res.json()) as { agents: Array<{ namespace: string; name: string }> };
    return body.agents.map((a) => `${a.namespace}/${a.name}`).sort();
  }

  it("an administrator's reduced key lists only its own account's agents", async () => {
    const res = await get(w, "/api/agents", w.reduced);
    expect(res.status).toBe(200);
    expect(await names(res)).toEqual(["root/own"]);
  });

  it("an administrator's delegated key cannot enumerate, like any delegated key", async () => {
    const res = await get(w, "/api/agents", w.delegated);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("KEY_SCOPE_FORBIDDEN");
  });

  it.each(MASTER)("the administrator's %s still lists every account's agents", async (cred) => {
    const res = await get(w, "/api/agents", w[cred]);
    expect(res.status).toBe(200);
    expect(await names(res)).toEqual(expect.arrayContaining(["alice/open", "alice/tool"]));
  });
});

describe("another account's agent metadata and versions", () => {
  const PATHS = ["/api/agents/alice/tool", "/api/agents/alice/tool/versions"];

  it.each(PATHS)("an administrator's reduced key gets the opaque 404 on %s", async (path) => {
    const res = await get(w, path, w.reduced);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(NOT_FOUND);
  });

  it.each(PATHS)("an administrator's delegated key gets the opaque 404 on %s", async (path) => {
    const res = await get(w, path, w.delegated);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(NOT_FOUND);
  });

  it.each(MASTER)("the administrator's %s still reads both", async (cred) => {
    for (const path of PATHS) {
      expect((await get(w, path, w[cred])).status).toBe(200);
    }
  });
});

describe("a run of another account's private agent", () => {
  const PATH = "/api/agents/alice/tool/run";

  it("an administrator's reduced key gets the opaque 404", async () => {
    const res = await run(w, PATH, w.reduced);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(NOT_FOUND);
  });

  it("an administrator's delegated key gets the opaque 404", async () => {
    const res = await run(w, PATH, w.delegated);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(NOT_FOUND);
  });

  it.each(
    MASTER,
  )("the administrator's %s still gets past the authorization gates", async (cred) => {
    // The version is unverified: a run that passed every authorization gate
    // stops at the verification gate, before anything executes.
    const res = await run(w, PATH, w[cred]);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("AGENT_NOT_VERIFIED");
  });
});

describe("an environment override", () => {
  it("an administrator's reduced key cannot override another account's agent it may run", async () => {
    // A public agent, so the run itself is allowed: what is refused is the override.
    const res = await run(w, "/api/agents/alice/open/run", w.reduced, OVERRIDE);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("ENV_OVERRIDE_FORBIDDEN");
  });

  it.each([
    "reduced",
    "delegated",
  ] as const)("an administrator's %s key cannot override even its own agent's environment", async (cred) => {
    const res = await run(w, "/api/agents/root/own/run", w[cred], OVERRIDE);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("ENV_OVERRIDE_FORBIDDEN");
  });

  it.each(
    MASTER,
  )("the administrator's %s still overrides another account's agent", async (cred) => {
    for (const path of ["/api/agents/alice/open/run", "/api/agents/alice/tool/run"]) {
      const res = await run(w, path, w[cred], OVERRIDE);
      expect(await code(res)).toBe("AGENT_NOT_VERIFIED");
    }
  });
});

describe("an attestation of another account's agent", () => {
  async function verified(): Promise<boolean> {
    const agent = await w.db.getAgent("alice", "tool");
    const versions = await w.db.getVersions((agent as { id: string }).id);
    return versions[0]?.verified ?? false;
  }

  it.each([
    "reduced",
    "delegated",
  ] as const)("an administrator's %s key is refused like an ordinary account's, and nothing is attested", async (cred) => {
    const res = await verify(w, w[cred]);
    expect(res.status).toBe(403);
    const refusal = await error(res);
    expect(refusal.code).toBe("FORBIDDEN");
    // The refusal names the credential an administrator attests with.
    expect(refusal.message).toContain(FULL_ACCESS);
    expect(await verified()).toBe(false);
  });

  it.each([
    "reduced",
    "delegated",
  ] as const)("under the owner policy, an administrator's %s key is refused on another account's agent, naming the credential", async (cred) => {
    const owner = createApp(new MemoryStorage(), w.db, { verificationPolicy: "owner" });
    const res = await owner.request("/api/agents/alice/tool/versions/1.0.0/verify", {
      method: "PATCH",
      headers: { ...w[cred], "Content-Type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.status).toBe(403);
    const refusal = await error(res);
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.message).toContain(FULL_ACCESS);
    expect(await verified()).toBe(false);
  });

  it.each(MASTER)("the administrator's %s still attests it", async (cred) => {
    const res = await verify(w, w[cred]);
    expect(res.status).toBe(200);
    expect(await verified()).toBe(true);
  });
});
