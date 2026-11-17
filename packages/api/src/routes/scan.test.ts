import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { parseQuotaEnv } from "../quotas/thresholds.js";
import { RegistryService } from "../services/registry.js";
import { MemoryStorage } from "../storage/memory.js";
import { agentYamlOfSize, minimalAgentYaml } from "./agent-bundle.shared.js";
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
  app.route("/api", createScanRoutes(db, noAuth as never, service, parseQuotaEnv({})));
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
    // The path is the agent's directory under the configured one, never a server path.
    for (const agent of body.agents as Array<{ name: string; path: string }>) {
      expect(agent.path).toBe(agent.name);
    }
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
    a.route("/api", createScanRoutes(db, scopedAuth as never, service, parseQuotaEnv({})));
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
    writeFileSync(join(agentsDir, "legit", "agent.yaml"), minimalAgentYaml("legit"));
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

// The credentials a test app authenticates as, without the auth middleware.
type Who = {
  role?: "admin" | "user";
  key?: {
    id: string;
    scope_kind: "account" | "agents";
    operations: string[];
    agent_ids: string[];
  };
};

function appAs(who: Who): Hono {
  const db = new MemoryDb();
  const service = new RegistryService(new MemoryStorage(), db);
  const auth = async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", {
      id: "u1",
      namespace: "dev",
      username: "dev",
      role: who.role ?? "user",
      ...who,
    });
    return next();
  };
  const a = new Hono();
  a.route("/api", createScanRoutes(db, auth as never, service, parseQuotaEnv({})));
  return a;
}

const SESSION: Who = { role: "user" };
const DEV_TOKEN: Who = { role: "admin" };
const FULL_KEY: Who = {
  key: {
    id: "k-full",
    scope_kind: "account",
    operations: ["agent:run", "agent:push", "agent:verify"],
    agent_ids: [],
  },
};
const RUN_ONLY_KEY: Who = {
  key: { id: "k-run", scope_kind: "account", operations: ["agent:run"], agent_ids: [] },
};
const DELEGATED_KEY: Who = {
  key: {
    id: "k-del",
    scope_kind: "agents",
    operations: ["agent:run", "agent:push"],
    agent_ids: [],
  },
};

// The agents-directory scan reads the server's disk: it is for a full-access
// credential, and it names no server path — each agent's path is relative to
// the configured directory, and the directory itself appears nowhere.
describe("GET /api/agents/scan — a full-access read that names no server path", () => {
  let dir: string;
  const originalEnv = process.env.SKRUN_AGENTS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-scan-read-"));
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "agent.yaml"), `name: ${name}\nversion: 1.0.0\n`);
    }
    mkdirSync(join(dir, "not-an-agent"));
    process.env.SKRUN_AGENTS_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SKRUN_AGENTS_DIR = originalEnv;
    else delete process.env.SKRUN_AGENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an account key that may only run agents, with the full-access message", async () => {
    const res = await appAs(RUN_ONLY_KEY).request("/api/agents/scan");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "KEY_SCOPE_FORBIDDEN",
        message:
          "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.",
      },
    });
  });

  it("refuses a delegated key, with the delegated-key message", async () => {
    const res = await appAs(DELEGATED_KEY).request("/api/agents/scan");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "KEY_SCOPE_FORBIDDEN",
        message: "This endpoint is not available to a resource-scoped API key.",
      },
    });
  });

  it.each([
    ["a session", SESSION],
    ["the dev token", DEV_TOKEN],
    ["a full account key", FULL_KEY],
  ])("lists the agents to %s, each path relative to the configured directory", async (_label, who) => {
    const res = await appAs(who).request("/api/agents/scan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{ name: string; path: string; registered: boolean }>;
      configured: boolean;
    };
    expect(body.configured).toBe(true);
    expect(body.agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
    for (const agent of body.agents) expect(agent.path).toBe(agent.name);
  });

  it("no value of the answer contains the configured directory", async () => {
    const res = await appAs(SESSION).request("/api/agents/scan");
    const text = await res.text();
    expect(text).not.toContain(basename(dir));
  });

  it("a configured directory that is missing is reported without its path", async () => {
    const missing = join(dir, "gone-away-dir");
    process.env.SKRUN_AGENTS_DIR = missing;
    const res = await appAs(SESSION).request("/api/agents/scan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[]; configured: boolean; error: string };
    expect(body).toEqual({
      agents: [],
      configured: true,
      error: "Directory not found: the configured agents directory",
    });
    expect(JSON.stringify(body)).not.toContain("gone-away-dir");
  });
});

// Building an agent from the agents directory reads the server's disk, like
// the scan itself: a credential without full access is refused before any
// read, with the same answer whatever the name, so no key can tell which
// directories exist there.
describe("POST /api/agents/scan/:name/push — refused before the disk is read", () => {
  let dir: string;
  const originalEnv = process.env.SKRUN_AGENTS_DIR;
  const FULL_ACCESS_REFUSAL = {
    error: {
      code: "KEY_SCOPE_FORBIDDEN",
      message:
        "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.",
    },
  };
  const DELEGATED_REFUSAL = {
    error: {
      code: "KEY_SCOPE_FORBIDDEN",
      message: "This endpoint is not available to a resource-scoped API key.",
    },
  };
  const PUSH_ONLY_KEY: Who = {
    key: { id: "k-push", scope_kind: "account", operations: ["agent:push"], agent_ids: [] },
  };
  // An agent directory, a directory without agent.yaml, and no directory at all.
  const NAMES = ["alpha", "not-an-agent", "no-such-dir"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-scan-push-"));
    mkdirSync(join(dir, "alpha"));
    writeFileSync(join(dir, "alpha", "agent.yaml"), minimalAgentYaml("alpha"));
    mkdirSync(join(dir, "not-an-agent"));
    process.env.SKRUN_AGENTS_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SKRUN_AGENTS_DIR = originalEnv;
    else delete process.env.SKRUN_AGENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  async function push(who: Who, name: string) {
    const res = await appAs(who).request(`/api/agents/scan/${name}/push`, { method: "POST" });
    return { status: res.status, body: await res.json() };
  }

  it.each([
    ["an account key that may only run agents", RUN_ONLY_KEY, FULL_ACCESS_REFUSAL],
    ["an account key that may only push", PUSH_ONLY_KEY, FULL_ACCESS_REFUSAL],
    ["a delegated key", DELEGATED_KEY, DELEGATED_REFUSAL],
  ])("refuses %s the same way, whatever the name", async (_label, who, refusal) => {
    const answers = [];
    for (const name of NAMES) answers.push(await push(who, name));
    delete process.env.SKRUN_AGENTS_DIR;
    answers.push(await push(who, "alpha"));
    expect(answers).toEqual([...NAMES, "unconfigured"].map(() => ({ status: 403, body: refusal })));
  });

  it.each([
    ["a session", SESSION],
    ["the dev token", DEV_TOKEN],
    ["a full account key", FULL_KEY],
  ])("builds and pushes for %s, and says what is missing", async (_label, who) => {
    expect((await push(who, "alpha")).status).toBe(200);
    expect(await push(who, "not-an-agent")).toEqual({
      status: 400,
      body: { error: { code: "INVALID_AGENT", message: "No agent.yaml found in directory" } },
    });
    expect((await push(who, "no-such-dir")).status).toBe(404);
  });
});

// The second push entrypoint answers to the same bounds as the registry push:
// the server's longest timeout and the account's bundle storage, checked
// before anything is stored — and to the same refusal of a setting that no
// code honours, whatever bounds it.
describe("POST /api/agents/scan/:name/push — the bounds of every push", () => {
  const MIB = 1024 * 1024;
  let dir: string;
  const originalEnv = process.env.SKRUN_AGENTS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-scan-bounds-"));
    mkdirSync(join(dir, "slow"));
    writeFileSync(
      join(dir, "slow", "agent.yaml"),
      [
        "name: slow",
        "version: 1.0.0",
        "model:",
        "  provider: google",
        "  name: gemini-2.5-flash",
        "inputs:",
        "  - name: q",
        "    type: string",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "environment:",
        "  timeout: 1800s",
      ].join("\n"),
    );
    mkdirSync(join(dir, "secretive"));
    writeFileSync(
      join(dir, "secretive", "agent.yaml"),
      [
        "name: secretive",
        "version: 1.0.0",
        "model:",
        "  provider: google",
        "  name: gemini-2.5-flash",
        "inputs:",
        "  - name: q",
        "    type: string",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "environment:",
        "  secrets: [X]",
      ].join("\n"),
    );
    mkdirSync(join(dir, "big"));
    writeFileSync(join(dir, "big", "agent.yaml"), minimalAgentYaml("big"));
    // Random bytes do not compress: the bundle stays past the cap.
    writeFileSync(join(dir, "big", "data.bin"), randomBytes(MIB + 1024));
    process.env.SKRUN_AGENTS_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SKRUN_AGENTS_DIR = originalEnv;
    else delete process.env.SKRUN_AGENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  function appWith(env: Record<string, string>) {
    const db = new MemoryDb();
    const storage = new MemoryStorage();
    const service = new RegistryService(storage, db);
    const auth = async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("user", { id: "u1", namespace: "dev", username: "dev", role: "user" });
      return next();
    };
    const app = new Hono();
    app.route("/api", createScanRoutes(db, auth as never, service, parseQuotaEnv(env)));
    return { app, db, storage };
  }

  it("an agent declaring more than the server's maximum is refused 400 TIMEOUT_ABOVE_LIMIT, nothing stored", async () => {
    const { app, db, storage } = appWith({ SKRUN_RUN_MAX_TIMEOUT_S: "900" });
    const res = await app.request("/api/agents/scan/slow/push", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "TIMEOUT_ABOVE_LIMIT",
        message: "This agent declares 1800 s; this server accepts at most 900 s.",
      },
    });
    expect(await db.getAgent("dev", "slow")).toBeNull();
    expect(await storage.get("dev/slow/1.0.0.agent")).toBeNull();
  });

  it("a bundle past the account's storage is refused 413 STORAGE_QUOTA_EXCEEDED, nothing stored", async () => {
    const { app, db, storage } = appWith({ SKRUN_QUOTA_STORAGE_MB: "1" });
    const res = await app.request("/api/agents/scan/big/push", { method: "POST" });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );
    expect(await db.getAgent("dev", "big")).toBeNull();
    expect(await storage.get("dev/big/1.0.0.agent")).toBeNull();
  });

  it.each([
    ["no setting", {}],
    ["the server's longest timeout set", { SKRUN_RUN_MAX_TIMEOUT_S: "900" }],
  ])("with %s, an agent.yaml naming a secret is refused 400 UNSUPPORTED_FIELD, by name, nothing stored", async (_label, env) => {
    const { app, db, storage } = appWith(env);
    const createVersion = vi.spyOn(db, "createVersion");
    const res = await app.request("/api/agents/scan/secretive/push", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "UNSUPPORTED_FIELD",
        message:
          "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.",
      },
    });
    expect(await db.getAgent("dev", "secretive")).toBeNull();
    expect(await storage.list("dev/")).toEqual([]);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("with no setting, both are stored", async () => {
    const { app } = appWith({});
    expect((await app.request("/api/agents/scan/slow/push", { method: "POST" })).status).toBe(200);
    expect((await app.request("/api/agents/scan/big/push", { method: "POST" })).status).toBe(200);
  });

  // The route takes the version from the raw text of agent.yaml — the first
  // `version:`, up to a quote or the end of its line —, not from the parsed
  // file: an unquoted version followed by a comment reads with the comment,
  // is not strict semver, and is refused as at the registry's push, nothing
  // stored; a quoted one stops at its quote, and is stored.
  it("an unquoted version followed by a comment is refused 400 INVALID_VERSION_FORMAT, nothing stored", async () => {
    mkdirSync(join(dir, "commented"));
    writeFileSync(
      join(dir, "commented", "agent.yaml"),
      minimalAgentYaml("commented").replace("version: 1.0.0", "version: 1.0.0 # first"),
    );
    const { app, db, storage } = appWith({});
    const res = await app.request("/api/agents/scan/commented/push", { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_VERSION_FORMAT",
    );
    expect(await db.getAgent("dev", "commented")).toBeNull();
    expect(await storage.list("dev/")).toEqual([]);
  });

  it("a quoted version followed by a comment is stored under that version", async () => {
    mkdirSync(join(dir, "quoted"));
    writeFileSync(
      join(dir, "quoted", "agent.yaml"),
      minimalAgentYaml("quoted").replace("version: 1.0.0", 'version: "1.0.0" # first'),
    );
    const { app, storage } = appWith({});
    const res = await app.request("/api/agents/scan/quoted/push", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await storage.list("dev/")).toEqual(["dev/quoted/1.0.0.agent"]);
  });

  // The bundle the route builds from a directory is judged as a pushed one: a
  // run could not load it, so it is never stored. The route builds a readable
  // archive itself, and answers a directory without agent.yaml by its own
  // refusal, so only what agent.yaml holds — and the size — reach these.
  describe("a directory whose bundle would not load is refused, nothing stored", () => {
    const previousCap = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
    afterEach(() => {
      if (previousCap === undefined) delete process.env.BUNDLE_MAX_DECOMPRESSED_MB;
      else process.env.BUNDLE_MAX_DECOMPRESSED_MB = previousCap;
    });

    async function refusedFor(name: string, env: Record<string, string> = {}) {
      const { app, db, storage } = appWith(env);
      const writes = {
        createAgent: vi.spyOn(db, "createAgent"),
        createVersion: vi.spyOn(db, "createVersion"),
        put: vi.spyOn(storage, "put"),
      };
      const res = await app.request(`/api/agents/scan/${name}/push`, { method: "POST" });
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(await db.getAgent("dev", name)).toBeNull();
      expect(await storage.list("dev/")).toEqual([]);
      expect(await db.sumBundleBytesByOwner("u1")).toBe(0);
      expect(writes.createAgent).not.toHaveBeenCalled();
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
      return { status: res.status, ...body.error };
    }

    it("past the decompression cap: 413 BUNDLE_DECOMPRESSED_TOO_LARGE, whatever the storage", async () => {
      // A cap of 1 MB: the directory's random megabyte and its tar headers go past it.
      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "1";
      for (const env of [{}, { SKRUN_QUOTA_STORAGE_MB: "1" }]) {
        const refusal = await refusedFor("big", env);
        expect(refusal).toMatchObject({ status: 413, code: "BUNDLE_DECOMPRESSED_TOO_LARGE" });
        expect(refusal.message).toMatch(/^This bundle decompresses to more than 1 MB, /);
      }
    });

    it("an agent.yaml the schema refuses: 400 INVALID_CONFIG, each issue named", async () => {
      mkdirSync(join(dir, "unfinished"));
      writeFileSync(join(dir, "unfinished", "agent.yaml"), "name: unfinished\nversion: 1.0.0\n");
      const refusal = await refusedFor("unfinished");
      expect(refusal).toMatchObject({ status: 400, code: "INVALID_CONFIG" });
      expect(refusal.message).toMatch(/^agent\.yaml is not valid: .*model: /);
    });

    // A directory's files never contradict each other, but a path of one can
    // be longer than an entry may be: refused as any push's would be.
    it("a file whose path in the bundle passes 1,024 bytes: 400 BUNDLE_CORRUPT, the file named", async () => {
      const deep = Array.from({ length: 6 }, (_, i) => `${"d".repeat(200)}${i}`).join("/");
      const path = `${deep}/notes.txt`;
      mkdirSync(join(dir, "deep", deep), { recursive: true });
      writeFileSync(join(dir, "deep", "agent.yaml"), minimalAgentYaml("deep"));
      writeFileSync(join(dir, "deep", path), "x");
      const refusal = await refusedFor("deep");
      expect(refusal).toMatchObject({ status: 400, code: "BUNDLE_CORRUPT" });
      expect(refusal.message).toBe(
        `This bundle cannot be written out where an agent runs: The entry "${path.slice(0, 60)}…" has a path of ${Buffer.byteLength(path)} bytes; an entry's path may have 1024 at most.`,
      );
    });

    it("an empty agent.yaml: 400 MISSING_CONFIG", async () => {
      mkdirSync(join(dir, "blank"));
      writeFileSync(join(dir, "blank", "agent.yaml"), "");
      expect(await refusedFor("blank")).toMatchObject({ status: 400, code: "MISSING_CONFIG" });
    });

    it("an agent.yaml past 128 KB: 413 CONFIG_TOO_LARGE, whatever the storage — at 128 KB, stored", async () => {
      const LIMIT = 128 * 1024;
      const yamlOf = (bytes: number) => agentYamlOfSize(bytes, minimalAgentYaml("wordy"));
      mkdirSync(join(dir, "wordy"));
      writeFileSync(join(dir, "wordy", "agent.yaml"), yamlOf(LIMIT + 1));
      for (const env of [{}, { SKRUN_QUOTA_STORAGE_MB: "1" }]) {
        const refusal = await refusedFor("wordy", env);
        expect(refusal).toMatchObject({ status: 413, code: "CONFIG_TOO_LARGE" });
        expect(refusal.message).toMatch(
          /^This bundle's agent\.yaml is 131,073 B, more than the 128 KB /,
        );
      }

      writeFileSync(join(dir, "wordy", "agent.yaml"), yamlOf(LIMIT));
      const { app, db } = appWith({});
      expect((await app.request("/api/agents/scan/wordy/push", { method: "POST" })).status).toBe(
        200,
      );
      expect(await db.getAgent("dev", "wordy")).not.toBeNull();
    });
  });
});
