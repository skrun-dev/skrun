import { FlyMachinesApi, RunnerPool } from "@skrun-dev/runtime";
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAdminPoolRoutes } from "./admin-pool.js";

function createTestApp(role: "admin" | "user", pool?: RunnerPool) {
  const fakeAuth = async (c: Context, next: () => Promise<void>) => {
    c.set("user", { id: "u1", namespace: "test", username: "test", role });
    await next();
  };
  const app = new Hono();
  app.route("/api", createAdminPoolRoutes(fakeAuth, pool));
  return app;
}

function makePool(size: number): RunnerPool {
  return new RunnerPool(new FlyMachinesApi("tok", "app"), {
    size,
    imageTag: "registry.example/runner:v1",
  });
}

describe("GET /api/admin/pool", () => {
  it("shows an administrator the counters", async () => {
    const res = await createTestApp("admin", makePool(2)).request("/api/admin/pool");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      enabled: true,
      size: 2,
      ready: 0,
      hits: 0,
      misses: 0,
    });
  });

  // Instance-wide numbers about the fleet: a tenant has no business seeing them
  // and no way to act on them. Opaque 404 rather than 403, like the rest of the
  // API — an unprivileged caller learns nothing about whether a pool exists here.
  it("hides the endpoint from a non-administrator", async () => {
    const res = await createTestApp("user", makePool(2)).request("/api/admin/pool");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // "No pool here" and "a pool that is failing" are different answers, and the
  // counters alone cannot tell them apart.
  it("reports a deployment with no pool as disabled rather than pretending", async () => {
    const res = await createTestApp("admin", undefined).request("/api/admin/pool");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });
  });

  it("treats a configured-but-zero pool as disabled too", async () => {
    const res = await createTestApp("admin", makePool(0)).request("/api/admin/pool");
    await expect(res.json()).resolves.toEqual({ enabled: false });
  });
});
