/**
 * E2E: bundle fetch failure path (#15 VT-23).
 *
 * The runner downloads the agent bundle from a presigned R2 GET URL during
 * its /init handshake. When R2 / MinIO returns an error (expired URL,
 * misconfigured bucket, transient 500), the runner's /init endpoint
 * surfaces a 500 with the underlying message; the harness translates
 * that into a `MachineSpawnError` at phase=`init-rpc` and destroys the
 * machine in the spawn-failure cleanup path.
 *
 * Asserted via mocked fetch — the runner side itself is exercised in
 * the in-machine runner code (no Node-side test fixture for that).
 */
import { describe, expect, it, vi } from "vitest";
import type { FlyMachinesApi, Machine } from "../../packages/runtime/src/adapter/flyio/index.js";
import {
  FlyioAdapter,
  type PresignedStorageAdapter,
} from "../../packages/runtime/src/adapter/flyio/index.js";
import { LLMRouter } from "../../packages/runtime/src/llm/router.js";
import { ToolRegistry } from "../../packages/runtime/src/tools/registry.js";
import type { RunEvent, RunRequest } from "../../packages/runtime/src/types.js";

function makeRequest(): RunRequest {
  return {
    agentConfig: {
      name: "bundle-fail-agent",
      description: "Bundle fail test",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-3-5-sonnet" },
      inputs: [],
      outputs: [{ name: "result", type: "string", description: "result" }],
      tools: [],
      mcp_servers: [],
      environment: {
        networking: { allowed_hosts: [] },
        filesystem: "read-only",
        secrets: [],
        timeout: "30s",
        max_cost: 1.0,
        sandbox: "strict",
      },
      state: { type: "none" },
      context_mode: "skill",
      tests: [],
    },
    skillContent: "x",
    input: {},
    runId: "run-vt23",
    bundleKey: "dev/bundle-fail-agent/1.0.0.agent",
  };
}

function makeStorage(): PresignedStorageAdapter {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    // The harness still hands out a presigned URL — it's the RUNNER's
    // GET against that URL that 500s, not the storage call itself.
    getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://r2.example/bad-bundle"),
    getPresignedUploadUrl: vi.fn().mockResolvedValue("https://r2.example/put"),
  };
}

async function drain(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("VT-23: bundle fetch failure → run_error + machine destroyed", () => {
  it("runner /init reports bundle fetch 500 → harness emits run_error + destroys leaked machine", async () => {
    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const createSpy = vi.fn().mockResolvedValue({
      id: "m-bundle-fail",
      name: "skrun-run-vt23",
      state: "started",
      private_ip: "fdaa::1",
    } as Machine);
    const flyApi = {
      create: createSpy,
      destroy: destroySpy,
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;

    // Mocked fetch: /healthz OK, /init returns 500 with a bundle-fetch
    // error message (mirroring what the in-runner Hono handler would
    // surface when downloadBundle() throws).
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/init")) {
        return new Response(
          JSON.stringify({
            error: "init failed",
            message: "bundle fetch failed: HTTP 500 Internal Server Error",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new FlyioAdapter(
      flyApi,
      makeStorage(),
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl },
    );
    const events = await drain(adapter.executeStream(makeRequest()));

    // The machine was successfully created, then /init failed → the
    // spawn-failure cleanup path destroys it.
    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledExactlyOnceWith("m-bundle-fail");

    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
    if (last?.type === "run_error") {
      // The error code reflects the spawn-phase failure; the message
      // carries the underlying bundle-fetch reason.
      expect(last.error.code).toBe("MACHINE_SPAWN_FAILED");
      expect(last.error.message).toMatch(/init-rpc|bundle fetch failed/i);
    }
  });

  it("runner /init returns a network error (transient ECONNREFUSED) → same destroy + run_error path", async () => {
    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const createSpy = vi.fn().mockResolvedValue({
      id: "m-net-fail",
      name: "skrun-run-net",
      state: "started",
      private_ip: "fdaa::1",
    } as Machine);
    const flyApi = {
      create: createSpy,
      destroy: destroySpy,
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;

    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/init")) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new FlyioAdapter(
      flyApi,
      makeStorage(),
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl },
    );
    const events = await drain(adapter.executeStream(makeRequest()));

    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledExactlyOnceWith("m-net-fail");
    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
  });

  it("healthz never responds within budget → boot-probe timeout + destroy", async () => {
    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const createSpy = vi.fn().mockResolvedValue({
      id: "m-boot-stuck",
      name: "skrun-run-boot",
      state: "started",
      private_ip: "fdaa::1",
    } as Machine);
    const flyApi = {
      create: createSpy,
      destroy: destroySpy,
      start: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
    } as unknown as FlyMachinesApi;

    // /healthz always 503 → boot probe exhausts its budget.
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/healthz")) {
        return new Response("not ready", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const adapter = new FlyioAdapter(
      flyApi,
      makeStorage(),
      new LLMRouter(),
      new ToolRegistry(),
      undefined,
      { fetchImpl, maxBootTimeMs: 200, bootPollIntervalMs: 50 },
    );
    const events = await drain(adapter.executeStream(makeRequest()));

    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).toHaveBeenCalledExactlyOnceWith("m-boot-stuck");
    const last = events[events.length - 1];
    expect(last?.type).toBe("run_error");
  });
});
