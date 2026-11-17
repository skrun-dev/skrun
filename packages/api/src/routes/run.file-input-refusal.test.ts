import { ResolveError } from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

// A file input refused because a name it reaches resolves to a private or
// reserved address: the caller is told the name, the server's log the address
// too. The refusal itself is the runtime's (llm/parts.test.ts,
// security/safe-fetch.test.ts); here the route's share — what it answers, and
// what it logs. So the input's resolution is replaced and throws the refusal, and
// the logger factory is replaced by one that records every call with the
// bindings of the child logger it was made on: a field passed through
// `child(…)` ends up in the line as surely as one passed to the call. vi.mock is
// hoisted above every import: what its factory reads is declared with vi.hoisted.
interface LoggedCall {
  level: string;
  bindings: Record<string, unknown>;
  args: unknown[];
}

const { logged, resolveInput } = vi.hoisted(() => ({
  logged: [] as LoggedCall[],
  resolveInput: vi.fn(),
}));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const loggerWith = (bindings: Record<string, unknown>): unknown => {
    const write =
      (level: string) =>
      (...args: unknown[]) => {
        logged.push({ level, bindings, args });
      };
    return {
      trace: write("trace"),
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      fatal: write("fatal"),
      level: "info",
      child: (more: Record<string, unknown>) => loggerWith({ ...bindings, ...more }),
    };
  };
  return { ...actual, createLogger: () => loggerWith({}), resolveInput };
});

const AGENT = "reads-a-picture";
const VERSION = "1.0.0";
const DEV_TOKEN = "dev-token";
/** A caller's own model key: the run is servable without any server key. */
const LLM_KEY = JSON.stringify({ google: "fake-caller-key" });
/** A URL whose path and query stand for what a log line must never carry. */
const URL_INPUT = "https://intranet.example.com/reports/jane-doe.png?token=s3cret";
const LINE_TEXT =
  "A file input URL was refused: a name it reaches resolves to a private or reserved address";

describe("POST /run — a file input refused for the address a name it reaches resolves to", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;

  beforeEach(async () => {
    logged.length = 0;
    resolveInput.mockReset();
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
    const agentYaml = [
      `name: ${AGENT}`,
      `version: ${VERSION}`,
      "model:",
      "  provider: google",
      "  name: gemini-2.5-flash",
      "inputs:",
      "  - name: picture",
      "    type: file",
      "    media: image",
      "outputs:",
      "  - name: answer",
      "    type: string",
      "environment:",
      "  networking:",
      '    allowed_hosts: ["*"]',
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${AGENT}\n`) },
    ]);
    const res = await app.request(`/api/agents/dev/${AGENT}/push?version=${VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await db.setVersionVerified("dev", AGENT, VERSION, true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A key the agent's owner hands a client: delegated to running this agent. Its secret and its id. */
  async function clientKey(): Promise<{ key: string; id: string }> {
    const agent = await db.getAgent("dev", AGENT);
    if (!agent) throw new Error("agent missing");
    const { key, keyHash, keyPrefix } = generateApiKey();
    const row = await db.createApiKey({
      user_id: agent.owner_id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "client",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agent.id],
    });
    return { key, id: row.id };
  }

  function run(token: string) {
    return app.request(`/api/agents/dev/${AGENT}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-LLM-API-Key": LLM_KEY,
      },
      body: JSON.stringify({ input: { picture: { type: "file", source: "url", url: URL_INPUT } } }),
    });
  }

  /** The route's log lines of the refusal, each with its child's bindings. */
  const refusalLines = () =>
    logged.filter(
      ({ args: [fields] }) =>
        (fields as { event?: string } | undefined)?.event === "input_url_private_address",
    );

  const refusedForItsAddress = () =>
    new ResolveError(
      "URL_NOT_ALLOWED",
      "Blocked 'intranet.example.com': resolves to a private/reserved address",
      { host: "intranet.example.com", address: "10.20.30.40" },
    );

  /** The whole call: no binding from a child logger, these fields, this text. */
  const theLine = (apiKeyId: string | null) => [
    {
      level: "warn",
      bindings: {},
      args: [
        {
          event: "input_url_private_address",
          agent: `dev/${AGENT}`,
          agent_version: VERSION,
          api_key_id: apiKeyId,
          host: "intranet.example.com",
          address: "10.20.30.40",
        },
        LINE_TEXT,
      ],
    },
  ];

  it("answers 403 without the address, and logs the agent, its version, the key, the host and the address — nothing else", async () => {
    resolveInput.mockRejectedValue(refusedForItsAddress());
    const client = await clientKey();

    const res = await run(client.key);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("URL_NOT_ALLOWED");
    expect(JSON.stringify(body)).not.toContain("10.20.30.40");

    // The key a client holds is the one its owner can revoke.
    expect(refusalLines()).toEqual(theLine(client.id));
    // Neither the URL's path nor its query, nor the key's secret, on this line
    // or any other, in a call or in a child's bindings.
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain("jane-doe");
    expect(everything).not.toContain("s3cret");
    expect(everything).not.toContain(client.key);
  });

  it("logs a null key for a credential without a key row", async () => {
    resolveInput.mockRejectedValue(refusedForItsAddress());

    const res = await run(DEV_TOKEN);
    expect(res.status).toBe(403);
    expect(refusalLines()).toEqual(theLine(null));
  });

  it("logs nothing of the kind for a refusal that withholds no address", async () => {
    resolveInput.mockRejectedValue(
      new ResolveError("URL_NOT_ALLOWED", "Blocked 'cdn.example.net': not in the allowed hosts"),
    );

    const res = await run(DEV_TOKEN);
    expect(res.status).toBe(403);
    expect(refusalLines()).toHaveLength(0);
  });
});
