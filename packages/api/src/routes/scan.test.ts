import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { RegistryService } from "../services/registry.js";
import { MemoryStorage } from "../storage/memory.js";
import { collectFiles, createScanRoutes } from "./scan.js";

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
    delete process.env.SKRUN_AGENTS_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SKRUN_AGENTS_DIR = originalEnv;
    } else {
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

// VT-15 (#65): the scan push entrypoint must enforce the same key-scope gate as
// the regular push — it is a second push path and must not be a bypass (B-1).
describe("POST /api/agents/scan/:name/push — API-key scope", () => {
  let app: Hono;
  let dir: string;
  const originalEnv = process.env.SKRUN_AGENTS_DIR;

  beforeEach(() => {
    const db = new MemoryDb();
    const service = new RegistryService(new MemoryStorage(), db);
    // A delegated (resource-scoped, no-grant) key — cannot create/push.
    const scopedAuth = async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("user", {
        id: "u1",
        namespace: "dev",
        username: "dev",
        role: "user",
        key: { id: "k1", scope_kind: "agents", operations: ["agent:push"], agent_ids: [] },
      });
      return next();
    };
    const a = new Hono();
    a.route("/api", createScanRoutes(db, scopedAuth as never, service));
    app = a;

    dir = mkdtempSync(join(tmpdir(), "skrun-scan-scope-"));
    mkdirSync(join(dir, "myagent"));
    writeFileSync(join(dir, "myagent", "agent.yaml"), "name: myagent\nversion: 1.0.0\n");
    process.env.SKRUN_AGENTS_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SKRUN_AGENTS_DIR = originalEnv;
    else delete process.env.SKRUN_AGENTS_DIR;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors
    }
  });

  it("a resource-scoped key cannot push via the scan entrypoint → 403 KEY_SCOPE_FORBIDDEN", async () => {
    const res = await app.request("/api/agents/scan/myagent/push", { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "KEY_SCOPE_FORBIDDEN",
    );
  });
});

// VT-12 / SC-9: the server-side push writer now shares the exclude contract with
// the CLI, so Python venvs + caches are no longer bundled by the scan push route.
describe("scan collectFiles — aligned exclude contract (VT-12 / SC-9)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-scan-excl-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeIn(rel: string, content: string): void {
    const full = join(dir, rel);
    const parent = dirname(full);
    if (parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(full, content);
  }

  it("excludes venv, .venv, __pycache__ and .pytest_cache", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x\nversion: 0.0.1\n");
    writeIn("requirements.txt", "pandas\n");
    writeIn("scripts/run.py", "import os\n");
    writeIn("venv/bin/python", "#!/usr/bin/env python3");
    writeIn(".venv/Lib/site-packages/numpy/__init__.py", "");
    writeIn("scripts/__pycache__/run.cpython-311.pyc", "compiled");
    writeIn(".pytest_cache/CACHEDIR.TAG", "sig");

    const files = await collectFiles(dir);

    expect(files).toContain("requirements.txt");
    expect(files).toContain(join("scripts", "run.py"));
    for (const leaked of ["venv", ".venv", "__pycache__", ".pytest_cache"]) {
      expect(files.some((f) => f.includes(leaked))).toBe(false);
    }
  });
});

describe("POST /api/agents/scan/:name/push — directory containment (SEC-003, audit/006)", () => {
  let app: Hono;
  let root: string;
  let agentsDir: string;
  const originalEnv = process.env.SKRUN_AGENTS_DIR;

  beforeEach(() => {
    app = createTestApp().app;
    // A sibling that SHARES THE PREFIX — the whole finding. `/x/agents-backup`
    // starts with `/x/agents`, so a bare startsWith lets it through.
    root = mkdtempSync(join(tmpdir(), "skrun-sec003-"));
    agentsDir = join(root, "agents");
    mkdirSync(join(agentsDir, "legit"), { recursive: true });
    writeFileSync(join(agentsDir, "legit", "agent.yaml"), "name: legit\nversion: 1.0.0\n");
    mkdirSync(join(root, "agents-backup"), { recursive: true });
    writeFileSync(join(root, "agents-backup", "agent.yaml"), "name: stolen\nversion: 9.9.9\n");
    process.env.SKRUN_AGENTS_DIR = agentsDir;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.SKRUN_AGENTS_DIR;
    else process.env.SKRUN_AGENTS_DIR = originalEnv;
  });

  it("VT-14: the prefix-sharing sibling is refused (was HTTP 200)", async () => {
    // Hono percent-decodes `:name`, so this arrives as `../agents-backup` and
    // `join()` normalises it to the sibling — which the old bare startsWith
    // accepted, packaging someone else's directory as the caller's agent.
    const res = await app.request("/api/agents/scan/..%2fagents-backup/push", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_AGENT_NAME");
  });

  it("VT-14b: deeper traversal stays refused", async () => {
    const res = await app.request("/api/agents/scan/..%2f..%2fetc/push", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("VT-15: a directory whose name is a legal agent name still pushes", async () => {
    // Proves the new regex is a SUPERSET of the schema's AGENT_NAME_REGEX — the
    // fix must not cost a legitimate scan-push.
    const res = await app.request("/api/agents/scan/legit/push", { method: "POST" });
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(403);
  });

  it("VT-15b: a name that is legal but absent gets 404, not a containment error", async () => {
    // The segment check must not swallow the "not found" signal.
    const res = await app.request("/api/agents/scan/no-such-agent/push", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
