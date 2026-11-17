/**
 * E2E: a file passed as a run input by its id must be one of the caller's uploads.
 *
 * An agent with a file input is pushed and verified; the model call is
 * intercepted — no network. Each client uploads a file through POST /api/files,
 * then runs the agent naming a `file_id`. A file id travels (run history lists
 * them), so knowing one must not be enough to put someone else's file into a
 * prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../../packages/api/src/auth/api-key.js";
import { inputCache } from "../../packages/api/src/cache/input-cache.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import { DEV_TOKEN, createTestApp as setup, verifyVersion } from "./setup.js";

/** A caller's own model key: the run is servable without any server key. */
const LLM_KEY = JSON.stringify({ google: "fake-caller-key" });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const AGENT = "reads-an-image";

describe("E2E: a run reads only the uploads its caller made", () => {
  let ctx: ReturnType<typeof setup>;
  /** How many times the model was called. */
  let modelCalls: number;

  beforeEach(async () => {
    ctx = setup();
    inputCache.clear();
    modelCalls = 0;
    vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => {
      modelCalls += 1;
      return {
        content: JSON.stringify({ answer: "seen" }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimatedCost: 0,
        provider: "google",
        model: "gemini-2.5-flash",
        durationMs: 1,
      };
    });

    const agentYaml = [
      `name: ${AGENT}`,
      "version: 1.0.0",
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
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${AGENT}\n`) },
    ]);
    const res = await ctx.app.request(`/api/agents/dev/${AGENT}/push?version=1.0.0`, {
      method: "POST",
      headers: { ...bearer(DEV_TOKEN), "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await verifyVersion(ctx.app, { name: AGENT });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    inputCache.clear();
  });

  /** A key the agent's owner hands a client: delegated to running this agent. */
  async function clientKey(): Promise<string> {
    const agent = await ctx.db.getAgent("dev", AGENT);
    if (!agent) throw new Error("agent missing");
    const { key, keyHash, keyPrefix } = generateApiKey();
    await ctx.db.createApiKey({
      user_id: agent.owner_id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "client",
      scopes: ["agent:run"],
      scope_kind: "agents",
      agents: [agent.id],
    });
    return key;
  }

  async function upload(token: string): Promise<string> {
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from("png-bytes")], { type: "image/png" }));
    const res = await ctx.app.request("/api/files", {
      method: "POST",
      headers: bearer(token),
      body: fd,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { file_id: string }).file_id;
  }

  function run(token: string, fileId: string) {
    return ctx.app.request(`/api/agents/dev/${AGENT}/run`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json", "X-LLM-API-Key": LLM_KEY },
      body: JSON.stringify({ input: { picture: { type: "file", source: "id", file_id: fileId } } }),
    });
  }

  it("a client's run reads the file it uploaded", async () => {
    const a = await clientKey();
    const mine = await upload(a);

    const res = await run(a, mine);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("completed");
    expect(modelCalls).toBe(1);
  });

  it("a client's run naming another client's upload is refused as an unknown file, before any model call", async () => {
    const a = await clientKey();
    const b = await clientKey();
    const theirs = await upload(b);

    const res = await run(a, theirs);
    const unknown = await run(a, "fil_00000000000000000000000000000000");

    expect(res.status).toBe(404);
    expect(unknown.status).toBe(404);
    const [refused, missing] = [
      (await res.json()) as { error: { code: string; message: string } },
      (await unknown.json()) as { error: { code: string; message: string } },
    ];
    expect(refused.error.code).toBe("FILE_NOT_FOUND");
    // The same answer as for an id nobody uploaded.
    expect(refused.error.message.replace(theirs, "<id>")).toBe(
      missing.error.message.replace("fil_00000000000000000000000000000000", "<id>"),
    );
    expect(modelCalls).toBe(0);
  });

  it("a full-access credential's run reads any upload of its account, and none of another account", async () => {
    const a = await clientKey();
    const clientUpload = await upload(a);
    const otherAccountUpload = await upload("another-account-token");

    const own = await run(DEV_TOKEN, clientUpload);
    expect(own.status).toBe(200);
    expect(modelCalls).toBe(1);

    const foreign = await run(DEV_TOKEN, otherAccountUpload);
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe(
      "FILE_NOT_FOUND",
    );
    expect(modelCalls).toBe(1);
  });
});
