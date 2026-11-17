/**
 * E2E: POST /run — input validation, auth, response format
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter, LocalAdapter, type RunRequest } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import {
  DEV_TOKEN,
  devAuth,
  pushAgent,
  runAgent,
  createTestApp as setup,
  verifyVersion,
} from "./setup.js";

describe("E2E: POST /run", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await pushAgent(ctx.app, { name: "test-agent" });
  });

  it("returns 401 without auth", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("400 INVALID_REQUEST for a body with no input — no run recorded", async () => {
    const agentReads = vi.spyOn(ctx.db, "getAgent");
    // The agent's fields sent without input, and the empty object: neither is
    // taken for the input.
    for (const body of [{ query: "hello" }, {}]) {
      const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
        method: "POST",
        headers: { ...devAuth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: "INVALID_REQUEST",
          message:
            'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.',
        },
      });
    }
    expect(agentReads).not.toHaveBeenCalled();
    expect(await ctx.db.listRuns()).toEqual([]);
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await runAgent(ctx.app, { name: "nonexistent", input: {} });
    // Agent not in registry → error during pull
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("health endpoint returns ok", async () => {
    const res = await ctx.app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("rate limit headers are present on /run", async () => {
    const res = await runAgent(ctx.app, { name: "test-agent", input: {} });
    expect(res.headers.get("X-RateLimit-Limit")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
  });

  // --- Version pinning ---

  it("404 VERSION_NOT_FOUND includes `available` newest-first when pinned version doesn't exist", async () => {
    // Push 3 versions of a different agent (beforeEach only pushed 1.0.0 of test-agent)
    await pushAgent(ctx.app, { name: "multi", version: "1.0.0" });
    await pushAgent(ctx.app, { name: "multi", version: "1.1.0" });
    await pushAgent(ctx.app, { name: "multi", version: "1.2.0" });

    const res = await ctx.app.request("/api/agents/dev/multi/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, version: "9.9.9" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("VERSION_NOT_FOUND");
    expect(body.error.message).toContain("9.9.9");
    expect(body.error.available).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  // --- Environment override ---

  it("400 INVALID_ENVIRONMENT when environment is not an object", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, environment: "not-an-object" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ENVIRONMENT");
  });

  it("400 INVALID_ENVIRONMENT when environment is an array", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, environment: ["bad"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ENVIRONMENT");
  });

  it("400 UNSUPPORTED_FIELD when the override names a secret, before the bundle is read — no run written", async () => {
    const reads = vi.spyOn(ctx.storage, "get");
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, environment: { secrets: ["X"] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toEqual({
      code: "UNSUPPORTED_FIELD",
      message:
        "The environment override is refused: environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.",
    });
    expect(reads).not.toHaveBeenCalled();
    expect(await ctx.db.listRuns()).toEqual([]);
  });

  it("accepts null environment (no override)", async () => {
    // null environment should be treated as "no override" — request proceeds normally
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, environment: null }),
    });
    // Should not fail with INVALID_ENVIRONMENT — gets further (bundle extraction or similar)
    expect(res.status).not.toBe(400);
  });

  // --- Playground redirect (the inline playground was removed) ---

  it("GET /playground redirects to /dashboard/agents", async () => {
    const res = await ctx.app.request("/playground", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/dashboard/agents");
  });

  // --- Files API ---

  it("GET /runs/:run_id/files/:filename → 404 for unknown run", async () => {
    // Auth required; missing header → 401 before reaching
    // the run lookup. Use devAuth to reach the 404 branch.
    const res = await ctx.app.request("/api/runs/nonexistent-run/files/test.txt", {
      method: "GET",
      headers: devAuth,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("400 INVALID_VERSION_FORMAT on semver-range request", async () => {
    const res = await ctx.app.request("/api/agents/dev/test-agent/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, version: "^1.0.0" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_VERSION_FORMAT");
    expect(body.error.message).toMatch(/ranges/i);
  });
});

// A local run's sync result says how many output files it left out, and why —
// here a file past FILES_MAX_SIZE_MB, written by the run as a script writes
// one. Counts only: the file's name is not in the result.
describe("E2E: the sync result counts the output files a run left out", () => {
  let ctx: ReturnType<typeof setup>;
  const savedLimit = process.env.FILES_MAX_SIZE_MB;
  /** What the run writes in its output directory, per case: each name with its size. */
  let writes: Array<[string, number]>;

  beforeEach(() => {
    ctx = setup();
    writes = [];
    // The model is simulated; the adapter itself is the real one and collects the files.
    vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => ({
      content: '{"answer":"ok"}',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      estimatedCost: 0.001,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      durationMs: 1,
    }));
    const collect = LocalAdapter.prototype.executeStream;
    vi.spyOn(LocalAdapter.prototype, "executeStream").mockImplementation(async function* (
      this: LocalAdapter,
      request: RunRequest,
    ) {
      for (const [name, size] of writes) {
        if (request.outputDir) writeFileSync(join(request.outputDir, name), Buffer.alloc(size, 1));
      }
      yield* collect.call(this, request);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedLimit === undefined) delete process.env.FILES_MAX_SIZE_MB;
    else process.env.FILES_MAX_SIZE_MB = savedLimit;
  });

  /** Push a runnable bundle under its own name (extracted bundles are cached per process). */
  async function pushRunnable(name: string): Promise<void> {
    const agentYaml = [
      `name: ${name}`,
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-6",
      "inputs:",
      "  - name: q",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n");
    const bundle = await packAgentTar([
      { name: "agent.yaml", content: Buffer.from(agentYaml) },
      { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
    ]);
    const res = await ctx.app.request(`/api/agents/dev/${name}/push?version=1.0.0`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(res.status).toBe(200);
    await verifyVersion(ctx.app, { name });
  }

  async function syncResult(name: string): Promise<Record<string, unknown>> {
    const res = await runAgent(ctx.app, {
      name,
      input: { q: "hi" },
      llmKeyHeader: JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as Record<string, unknown>;
    expect(result.status).toBe("completed");
    return result;
  }

  it("counts a file past the size limit as too large, and keeps the others", async () => {
    await pushRunnable("left-out-too-large");
    process.env.FILES_MAX_SIZE_MB = "1";
    writes = [
      ["big.bin", 1024 * 1024 + 1],
      ["report.txt", 5],
    ];

    const result = await syncResult("left-out-too-large");

    expect((result.files as Array<{ name: string }>).map((file) => file.name)).toEqual([
      "report.txt",
    ]);
    expect(result.files_excluded).toEqual({ too_large: 1 });
    expect(JSON.stringify({ ...result, files: undefined })).not.toContain("big.bin");
  });

  it("carries an empty object when the run left nothing out", async () => {
    await pushRunnable("left-out-nothing");
    writes = [["report.txt", 5]];

    const result = await syncResult("left-out-nothing");

    expect(result).toHaveProperty("files_excluded");
    expect(result.files_excluded).toEqual({});
  });
});
