/**
 * E2E: request-body caps — a run, an upload and a push, each held to its own cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validBundleOfSize } from "../../packages/api/src/routes/agent-bundle.shared.js";
// The built runtime: the module the API resolves, so a spy on it reaches the route.
import { LLMRouter } from "../../packages/runtime/dist/index.js";
import { packAgentTar } from "../../packages/schema/src/index.js";
import { DEV_TOKEN, devAuth, runAgent, createTestApp as setup, verifyVersion } from "./setup.js";

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** A body pulled one 64 KiB chunk at a time, with no Content-Length; `pulled()` counts what left. */
function pullBody(head: string, size: number, tail: string) {
  const parts = [new TextEncoder().encode(head), null, new TextEncoder().encode(tail)] as const;
  let sent = 0;
  let pulled = 0;
  let stage = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        controller.enqueue(parts[0]);
        pulled += parts[0].byteLength;
        stage = 1;
        return;
      }
      if (stage === 1 && sent < size) {
        const len = Math.min(CHUNK, size - sent);
        controller.enqueue(new Uint8Array(len).fill(0x61));
        sent += len;
        pulled += len;
        return;
      }
      if (stage === 1) {
        controller.enqueue(parts[2]);
        pulled += parts[2].byteLength;
        stage = 2;
        return;
      }
      controller.close();
    },
  });
  return { stream, pulled: () => pulled };
}

describe("E2E: request-body caps", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    delete process.env.INPUT_FILES_MAX_SIZE_MB;
    ctx = setup();
    // The model is simulated; everything else is the real path.
    vi.spyOn(LLMRouter.prototype, "call").mockImplementation(async () => ({
      content: '{"answer":"ok"}',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      estimatedCost: 0.001,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      durationMs: 1,
    }));
    const agentYaml = [
      "name: body-cap",
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
      { name: "SKILL.md", content: Buffer.from("# body-cap\n") },
    ]);
    const pushed = await ctx.app.request("/api/agents/dev/body-cap/push?version=1.0.0", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    expect(pushed.status).toBe(200);
    await verifyVersion(ctx.app, { name: "body-cap" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.INPUT_FILES_MAX_SIZE_MB;
  });

  it("a 7 MB run is refused 413 REQUEST_TOO_LARGE, and no run is written", async () => {
    const res = await ctx.app.request("/api/agents/dev/body-cap/run", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { q: "x".repeat(7 * MIB) } }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_TOO_LARGE");
    expect(await ctx.db.listRuns()).toEqual([]);
    expect(LLMRouter.prototype.call).not.toHaveBeenCalled();
  });

  it("a run of ordinary size is unchanged", async () => {
    const res = await runAgent(ctx.app, {
      name: "body-cap",
      input: { q: "hi" },
      llmKeyHeader: JSON.stringify({ anthropic: "sk-ant-fake-caller-key" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("completed");
    expect(await ctx.db.listRuns()).toHaveLength(1);
  });

  it("a 30 MB upload sent as a stream is refused 413 FILE_TOO_LARGE before it is read whole", async () => {
    const boundary = "----skrun-e2e-cap";
    const body = pullBody(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
      30 * MIB,
      `\r\n--${boundary}--\r\n`,
    );
    const res = await ctx.app.request("/api/files", {
      method: "POST",
      headers: { ...devAuth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FILE_TOO_LARGE");
    // The read stopped at the cap (the 25 MB file limit plus 1 MB of framing).
    expect(body.pulled()).toBeLessThan(30 * MIB);
    expect(body.pulled()).toBeLessThanOrEqual(26 * MIB + 2 * CHUNK);
  });

  it("a 2 MB bundle is pushed: the push keeps its own cap", async () => {
    const res = await ctx.app.request("/api/agents/dev/big-bundle/push?version=1.0.0", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(await validBundleOfSize(2 * MIB, "big-bundle")),
    });
    expect(res.status).toBe(200);
  });
});
