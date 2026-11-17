/**
 * E2E: deleting an account, through the HTTP routes.
 *
 * An account pushes an agent and runs it, then deletes itself. Afterwards its
 * agent is not found, its key no longer signs anything in, the object store
 * holds nothing under its namespace, and its run is still there — cleared,
 * marked and detached. The login then signs in again and gets a new, empty
 * account under the same namespace; what it pushes at the same version number
 * is what runs. A run still going when its account is deleted completes, and
 * its row keeps nothing of its content.
 *
 * The model call is intercepted — no network. What the model was given as its
 * instructions (the agent's SKILL.md) is recorded, so a test can tell which
 * content a run executed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
import { sessionCookieName } from "../../packages/api/src/auth/session.js";
import type { MemoryDb } from "../../packages/api/src/db/memory.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import { createTestApp, seedUserKey, verifyVersion } from "./setup.js";

/** A caller's own model key: the run is servable without any server key. */
const LLM_KEY = JSON.stringify({ google: "fake-caller-key" });

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type App = ReturnType<typeof createTestApp>["app"];

/** An agent bundle whose SKILL.md says `skill`: the content a run is given. */
async function bundle(name: string, skill: string) {
  const agentYaml = [
    `name: ${name}`,
    "version: 1.0.0",
    "model:",
    "  provider: google",
    "  name: gemini-2.5-flash",
    "inputs:",
    "  - name: q",
    "    type: string",
    "    required: true",
    "outputs:",
    "  - name: answer",
    "    type: string",
  ].join("\n");
  const tar = await packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYaml) },
    { name: "SKILL.md", content: Buffer.from(`${skill}\n`) },
  ]);
  return new Uint8Array(tar);
}

/** Push `skill` as `<ns>/<name>@<version>` with `token`, then verify the version (dev-token is admin). */
async function push(
  app: App,
  token: string,
  ns: string,
  name: string,
  skill: string,
  version = "1.0.0",
) {
  const res = await app.request(`/api/agents/${ns}/${name}/push?version=${version}`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/octet-stream" },
    body: await bundle(name, skill),
  });
  expect(res.status).toBe(200);
  expect((await verifyVersion(app, { ns, name, version })).status).toBe(200);
}

async function run(app: App, token: string, ns: string, name: string): Promise<Response> {
  return await app.request(`/api/agents/${ns}/${name}/run`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json", "X-LLM-API-Key": LLM_KEY },
    body: JSON.stringify({ input: { q: "hello" } }),
  });
}

async function deleteOwnAccount(app: App, token: string, confirm: string): Promise<Response> {
  return await app.request("/api/account", {
    method: "DELETE",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
}

/** A key with every operation for an account that exists: the sign-in hands out a session, not a key. */
async function keyFor(db: MemoryDb, userId: string): Promise<string> {
  const { key, keyHash, keyPrefix } = generateApiKey();
  await db.createApiKey({ user_id: userId, key_hash: keyHash, key_prefix: keyPrefix, name: "k" });
  return key;
}

/**
 * Sign in through GitHub — the OAuth round trip, with GitHub answering `login`
 * for the GitHub account `githubId`. Returns the session cookie it sets.
 */
async function signInWithGitHub(app: App, githubId: number, login: string): Promise<string> {
  process.env.GITHUB_CLIENT_ID = "test-id";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("login/oauth/access_token")) {
        return Promise.resolve(Response.json({ access_token: "gho_test_token" }));
      }
      if (url.includes("api.github.com/user")) {
        return Promise.resolve(
          Response.json({ id: githubId, login, email: null, avatar_url: null }),
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }),
  );
  try {
    const start = await app.request("/auth/github", { redirect: "manual" });
    const location = new URL(start.headers.get("Location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const stateCookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];
    const callback = await app.request(`/auth/github/callback?code=c&state=${state}`, {
      headers: { Cookie: stateCookie },
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/dashboard");
    const name = sessionCookieName();
    const set = callback.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    if (!set) throw new Error("the sign-in set no session cookie");
    return set.split(";")[0];
  } finally {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  }
}

describe("E2E: deleting an account", () => {
  let ctx: ReturnType<typeof createTestApp>;
  /** The instructions the model was given, one entry per model call. */
  let instructions: string[];
  /** Something to do while the model is answering, before its answer returns. */
  let duringModelCall: (() => Promise<unknown>) | null;

  beforeEach(() => {
    ctx = createTestApp();
    instructions = [];
    duringModelCall = null;
    vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async (_model, system) => {
      instructions.push(String(system));
      if (duringModelCall) await duringModelCall();
      return {
        content: JSON.stringify({ answer: "ok" }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCost: 0,
        provider: "google",
        model: "gemini-2.5-flash",
        durationMs: 1,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("push, run, delete: the agent is gone, the key signs nothing in, nothing is left under the namespace, the run is cleared", async () => {
    const { app, db, storage } = ctx;
    const alice = await seedUserKey(db, "alice");
    await push(app, alice.key, "alice", "notes", "# alice's notes");
    await push(app, alice.key, "alice", "notes", "# alice's notes, again", "2.0.0");
    const ran = await run(app, alice.key, "alice", "notes");
    expect(ran.status).toBe(200);
    const { run_id: runId } = (await ran.json()) as { run_id: string };
    expect(await storage.list("alice/")).toHaveLength(2);

    const deleted = await deleteOwnAccount(app, alice.key, "alice");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });

    const agent = await app.request("/api/agents/alice/notes", { headers: bearer(alice.key) });
    expect(agent.status).toBe(401);
    const asAdmin = await app.request("/api/agents/alice/notes", {
      headers: bearer("dev-token"),
    });
    expect(asAdmin.status).toBe(404);
    expect((await run(app, alice.key, "alice", "notes")).status).toBe(401);
    expect(await storage.list("alice/")).toEqual([]);
    expect(await db.getUserById(alice.id)).toBeNull();

    // The run outlives the account: cleared, marked, detached.
    const row = await db.getRun(runId);
    expect(row).toMatchObject({
      status: "completed",
      user_id: null,
      agent_id: null,
      api_key_id: null,
      input: null,
      output: null,
      error: null,
      files: [],
      agent_version: "@2.0.0",
    });
    expect(row?.content_cleared_at).toEqual(expect.any(String));
  });

  it("the login signs in again: a new empty account under the same name, and a push at the same version runs the new content", async () => {
    const { app, db } = ctx;
    const old = await signInWithGitHub(app, 4242, "Alice");
    const oldMe = await app.request("/api/me", { headers: { Cookie: old } });
    const oldAccount = (await oldMe.json()) as { id: string; username: string };
    expect(oldAccount.username).toBe("alice");
    const oldKey = await keyFor(db, oldAccount.id);
    await push(app, oldKey, "alice", "same-number", "# the first content");
    expect((await run(app, oldKey, "alice", "same-number")).status).toBe(200);
    expect(instructions.at(-1)).toContain("# the first content");

    expect((await deleteOwnAccount(app, oldKey, "alice")).status).toBe(200);
    expect((await app.request("/api/me", { headers: { Cookie: old } })).status).toBe(401);

    // The same GitHub account signs in again: the name was freed with the account.
    const again = await signInWithGitHub(app, 4242, "Alice");
    const newMe = await app.request("/api/me", { headers: { Cookie: again } });
    expect(newMe.status).toBe(200);
    const newAccount = (await newMe.json()) as { id: string; username: string };
    expect(newAccount.username).toBe("alice");
    expect(newAccount.id).not.toBe(oldAccount.id);
    expect(await db.getAgent("alice", "same-number")).toBeNull();

    // The same name, version and agent name — another content: that one runs.
    const newKey = await keyFor(db, newAccount.id);
    await push(app, newKey, "alice", "same-number", "# the second content");
    expect((await run(app, newKey, "alice", "same-number")).status).toBe(200);
    expect(instructions.at(-1)).toContain("# the second content");
    expect(instructions.at(-1)).not.toContain("# the first content");
  });

  it("a run still going when its account is deleted completes for its caller, and its row keeps nothing of its content", async () => {
    const { app, db, storage } = ctx;
    const alice = await seedUserKey(db, "alice");
    await push(app, alice.key, "alice", "slow", "# slow");

    let deletion: Response | undefined;
    duringModelCall = async () => {
      deletion = await deleteOwnAccount(app, alice.key, "alice");
    };
    const ran = await run(app, alice.key, "alice", "slow");

    // The deletion did not wait for the run, and was not refused because of it.
    expect(deletion?.status).toBe(200);
    expect(ran.status).toBe(200);
    const body = (await ran.json()) as { run_id: string; status: string; output: unknown };
    expect(body.status).toBe("completed");
    expect(body.output).toEqual({ answer: "ok" });
    const row = await db.getRun(body.run_id);
    expect(row).toMatchObject({
      status: "completed",
      user_id: null,
      agent_id: null,
      input: null,
      output: null,
      error: null,
      files: [],
      purge_after: null,
      agent_version: "@1.0.0",
    });
    expect(row?.content_cleared_at).toEqual(expect.any(String));
    expect(await storage.list("alice/")).toEqual([]);
  });
});
