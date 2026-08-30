import { beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSpawnError } from "../../errors.js";
import { FlyMachinesApi } from "./fly-api.js";

const SAMPLE_MACHINE = {
  id: "fdmach_abc123",
  name: "skrun-run-test",
  state: "created" as const,
  region: "cdg",
  instance_id: "01234567",
  private_ip: "fdaa:0:1::1",
  image_ref: { registry: "ghcr.io", repository: "skrun-dev/skrun-runtime", tag: "v0.9.0" },
};

describe("FlyMachinesApi", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  describe("create", () => {
    it("POSTs to /apps/{app}/machines with Bearer auth + JSON body", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 }));
      const api = new FlyMachinesApi("test-token", "skrun-app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const result = await api.create({
        name: "skrun-run-test",
        region: "cdg",
        config: { image: "ghcr.io/skrun-dev/skrun-runtime:latest" },
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/skrun-app/machines");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer test-token");
      expect(init.headers["Content-Type"]).toBe("application/json");
      const sent = JSON.parse(init.body);
      expect(sent.name).toBe("skrun-run-test");
      expect(sent.config.image).toBe("ghcr.io/skrun-dev/skrun-runtime:latest");

      expect(result.id).toBe("fdmach_abc123");
      expect(result.state).toBe("created");
    });

    it("throws MachineSpawnError on 4xx with HTTP status + body in cause", async () => {
      fetchSpy.mockResolvedValue(new Response("Invalid image", { status: 422 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await expect(
        api.create({ name: "skrun-run-bad", config: { image: "bogus" } }),
      ).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: {
          httpStatus: 422,
          phase: "create",
          machineId: null,
          machineName: "skrun-run-bad",
        },
      });
    });

    it("throws MachineSpawnError when response schema mismatches", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ id: 123, state: "alien" }), { status: 200 }),
      );
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await expect(
        api.create({ name: "skrun-run-x", config: { image: "img" } }),
      ).rejects.toBeInstanceOf(MachineSpawnError);
    });
  });

  describe("start / stop / destroy", () => {
    it("start POSTs to /machines/{id}/start", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.start("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123/start");
      expect(init.method).toBe("POST");
    });

    it("suspend POSTs to /machines/{id}/suspend", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.suspend("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123/suspend");
      expect(init.method).toBe("POST");
    });

    // The pool's resume path reuses start() unchanged — Fly documents the standard
    // start endpoint as what resumes a suspended machine. Asserted so a future
    // refactor cannot quietly introduce a separate "resume" call.
    it("resumes a suspended machine through start, not a separate endpoint", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.suspend("fdmach_abc123");
      await api.start("fdmach_abc123");
      expect(fetchSpy.mock.calls.map(([url]) => String(url).split("/").pop())).toEqual([
        "suspend",
        "start",
      ]);
    });

    it("suspend maps a Fly error to MachineSpawnError like its siblings", async () => {
      fetchSpy.mockResolvedValue(new Response("machine not suspendable", { status: 400 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        maxRetries: 0,
      });
      await expect(api.suspend("fdmach_abc123")).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 400 },
      });
    });

    it("stop POSTs to /machines/{id}/stop", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.stop("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123/stop");
      expect(init.method).toBe("POST");
    });

    it("destroy DELETEs /machines/{id}?force=true (force needed to destroy a still-started machine)", async () => {
      fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await api.destroy("fdmach_abc123");
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/fdmach_abc123?force=true");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("list", () => {
    it("GETs /machines and parses an array of machines", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify([SAMPLE_MACHINE]), { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const result = await api.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("fdmach_abc123");
    });
  });

  describe("429 backoff retry", () => {
    it("retries with exponential backoff up to maxRetries on 429", async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE_MACHINE), { status: 200 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        backoffBaseMs: 1, // fast in tests
      });
      const result = await api.create({ name: "skrun-run-r", config: { image: "img" } });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(result.id).toBe("fdmach_abc123");
    });

    it("throws MachineSpawnError when retries exhausted on 429", async () => {
      fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
        maxRetries: 2,
        backoffBaseMs: 1,
      });
      await expect(
        api.create({ name: "skrun-run-e", config: { image: "img" } }),
      ).rejects.toMatchObject({
        name: "MachineSpawnError",
        details: { httpStatus: 429 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });
  });

  describe("inflight dedup", () => {
    it("returns the same promise for concurrent identical (method, path) calls", async () => {
      let resolveFetch: ((r: Response) => void) | null = null;
      const blockingResponse = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      fetchSpy.mockReturnValue(blockingResponse);
      const api = new FlyMachinesApi("token", "app", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      // Fire two concurrent list() calls in the same tick — the second should
      // hit the inflight map and reuse the first call's pending promise.
      const p1 = api.list();
      const p2 = api.list();

      // Resolve the single fetch — both list() promises should complete.
      resolveFetch?.(new Response(JSON.stringify([SAMPLE_MACHINE]), { status: 200 }));

      const [a, b] = await Promise.all([p1, p2]);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(a).toEqual(b);
    });
  });
});
