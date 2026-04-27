import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { RegistryService } from "../services/registry.js";
import { MemoryStorage } from "../storage/memory.js";
import { createScanRoutes } from "./scan.js";

function createTestApp() {
  const db = new MemoryDb();
  const storage = new MemoryStorage();
  const service = new RegistryService(storage, db);
  const noAuth = async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "test-user", namespace: "dev", username: "dev" });
    return next();
  };
  const app = new Hono();
  app.route("/api", createScanRoutes(db, noAuth as never, service));
  return { app, db };
}

describe("GET /api/agents/scan", () => {
  let app: Hono;
  const originalEnv = process.env.SKRUN_AGENTS_DIR;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    // biome-ignore lint/performance/noDelete: Node.js requires delete to truly unset env vars
    delete process.env.SKRUN_AGENTS_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SKRUN_AGENTS_DIR = originalEnv;
    } else {
      // biome-ignore lint/performance/noDelete: Node.js requires delete to truly unset env vars
      delete process.env.SKRUN_AGENTS_DIR;
    }
  });

  it("returns configured:false when env var not set", async () => {
    const res = await app.request("/api/agents/scan");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agents: [], configured: false });
  });

  it("returns error when directory does not exist", async () => {
    process.env.SKRUN_AGENTS_DIR = "/tmp/nonexistent-skrun-test-dir-xyz";
    const res = await app.request("/api/agents/scan");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.agents).toEqual([]);
    expect(body.error).toContain("not found");
  });

  it("scans directory with agent.yaml files", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const agentsDir = resolve(process.cwd(), "../../agents");
    if (!existsSync(agentsDir)) {
      return;
    }

    process.env.SKRUN_AGENTS_DIR = agentsDir;
    const res = await app.request("/api/agents/scan");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.agents.length).toBeGreaterThan(0);
    expect(body.agents[0]).toHaveProperty("name");
    expect(body.agents[0]).toHaveProperty("path");
    expect(body.agents[0]).toHaveProperty("registered");
  });
});
