import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { createSession, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";
import { withEnv } from "./oauth-flow.shared.js";

// `GET /api/instance`: the links the dashboard shows — the operator's docs,
// terms and privacy policy — through the whole app: the real authentication,
// the route as mounted, an in-memory database. The settings are read when the
// app is built, so each case sets its environment first and builds the app
// after.

/** The operator's site settings this file sets, put back after each case. */
const KEYS = ["SKRUN_DOCS_URL", "SKRUN_TERMS_URL", "SKRUN_PRIVACY_URL"] as const;

const DEFAULTS = { links: { docs: "/docs", terms: null, privacy: null } };

describe("GET /api/instance", () => {
  let db: MemoryDb;
  let restoreEnv: () => void;

  /** The app, built after the case has set its environment. */
  function app(): ReturnType<typeof createApp> {
    return createApp(new MemoryStorage(), db);
  }

  /** A request with the dev token, which any instance under test accepts. */
  async function read(served: ReturnType<typeof createApp>): Promise<Response> {
    return await served.request("/api/instance", {
      headers: { Authorization: "Bearer dev-token" },
    });
  }

  beforeEach(() => {
    restoreEnv = withEnv(KEYS);
    for (const key of KEYS) delete process.env[key];
    db = new MemoryDb();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("serves the defaults when the operator set none of the addresses", async () => {
    const res = await read(app());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULTS);
  });

  // The form the pages serve, never the string as it was written: an absolute
  // address normalised (a scheme and a host in capitals in lower case, a
  // non-ASCII host in its ASCII form), a path on this site as written.
  it("serves the addresses set, in the form the pages serve them", async () => {
    process.env.SKRUN_DOCS_URL = "https://exämple.com/docs";
    process.env.SKRUN_TERMS_URL = "HTTPS://Example.com/legal/terms";
    process.env.SKRUN_PRIVACY_URL = "/legal/privacy?lang=en#top";
    const res = await read(app());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      links: {
        docs: "https://xn--exmple-cua.com/docs",
        terms: "https://example.com/legal/terms",
        privacy: "/legal/privacy?lang=en#top",
      },
    });
  });

  it.each([
    { value: "", shown: '""' },
    { value: "   ", shown: "blanks" },
  ])("serves the defaults when each address is set to $shown", async ({ value }) => {
    for (const key of KEYS) process.env[key] = value;
    const res = await read(app());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULTS);
  });

  it("answers 401 to a request with no credential", async () => {
    const res = await app().request("/api/instance");

    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("links");
  });

  // Any credential reads it — the body is the instance's configuration, the
  // same for every caller, and nothing about the account.
  it.each([
    "a session",
    "an account-wide key",
    "a key reduced to one agent",
    "the dev token",
  ] as const)("answers 200 to %s", async (credential) => {
    process.env.SKRUN_TERMS_URL = "https://example.com/legal/terms";
    const served = app();
    const user = await db.createUser({ github_id: "gh-instance-reader", username: "reader" });
    let headers: Record<string, string>;
    if (credential === "a session") {
      headers = { Cookie: `${sessionCookieName()}=${await createSession(db, user.id)}` };
    } else if (credential === "the dev token") {
      headers = { Authorization: "Bearer dev-token" };
    } else {
      const agent = await db.createAgent({
        name: "only",
        namespace: "reader",
        description: "",
        owner_id: user.id,
      });
      const k = generateApiKey();
      await db.createApiKey({
        user_id: user.id,
        key_hash: k.keyHash,
        key_prefix: k.keyPrefix,
        name: credential,
        ...(credential === "a key reduced to one agent" && {
          scopes: ["agent:run"],
          scope_kind: "agents" as const,
          agents: [agent.id],
        }),
      });
      headers = { Authorization: `Bearer ${k.key}` };
    }
    const res = await served.request("/api/instance", { headers });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      links: { docs: "/docs", terms: "https://example.com/legal/terms", privacy: null },
    });
  });
});
