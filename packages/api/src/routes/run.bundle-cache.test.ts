import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalAdapter, type RunRequest, type RunResult } from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

// An extracted bundle is cached by the SHA-256 of its bytes, not by the
// agent's name and version. A name and a version can come back with other
// bytes — an agent deleted then published again under the same number, on an
// instance that still holds the first extraction — and a cache keyed by the
// name would run the old content in their place.

const AUTH = { Authorization: "Bearer dev-token" };
const OPTS = { verificationPolicy: "owner" as const, runtimeMode: "local" as const };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A runnable agent.yaml, on a google model. */
function agentYamlOf(name: string, model: string): string {
  return [
    `name: ${name}`,
    "version: 1.0.0",
    "model:",
    "  provider: google",
    `  name: ${model}`,
    "inputs:",
    "  - name: q",
    "    type: string",
    "    required: true",
    "outputs:",
    "  - name: answer",
    "    type: string",
  ].join("\n");
}

/** A runnable bundle whose model name and SKILL.md say which content it is. */
async function bundleOf(name: string, model: string, skill: string): Promise<Buffer> {
  return packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYamlOf(name, model)) },
    { name: "SKILL.md", content: Buffer.from(skill) },
  ]);
}

type App = ReturnType<typeof createApp>;

async function push(app: App, name: string, version: string, bundle: Buffer): Promise<void> {
  const res = await app.request(`/api/agents/dev/${name}/push?version=${version}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bundle),
  });
  expect(res.status).toBe(200);
}

function run(app: App, name: string, version?: string): Promise<Response> {
  return app.request(`/api/agents/dev/${name}/run`, {
    method: "POST",
    headers: {
      ...AUTH,
      "Content-Type": "application/json",
      "X-LLM-API-Key": JSON.stringify({ google: "caller-google-key" }),
    },
    body: JSON.stringify({ input: { q: "hi" }, ...(version && { version }) }),
  });
}

/** What a run handed its adapter, scripted to complete without calling a model. */
function scriptExecute(execute: MockInstance): RunRequest[] {
  const seen: RunRequest[] = [];
  execute.mockImplementation(async (request: RunRequest): Promise<RunResult> => {
    seen.push(request);
    return {
      runId: request.runId,
      status: "completed",
      output: { answer: "ok" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
      durationMs: 1,
      files: [],
    };
  });
  return seen;
}

describe("POST /run — an extracted bundle is cached by its content", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    bundleCache.clear();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("an instance that ran the first content of a name and version runs the second once it is published again", async () => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const first = createApp(storage, db, OPTS);

    // A second instance: the same database and store, its own module graph,
    // so its own bundle cache — the way two servers share nothing in memory.
    vi.resetModules();
    const runtime2 = await import("@skrun-dev/runtime");
    const cache2 = (await import("../cache/bundle-cache.js")).bundleCache;
    const second = (await import("../index.js")).createApp(storage, db, OPTS);
    cleanups.push(() => cache2.clear());
    expect(cache2).not.toBe(bundleCache);
    const seen = scriptExecute(vi.spyOn(runtime2.LocalAdapter.prototype, "execute"));

    const c1 = await bundleOf("a", "gemini-2.5-flash", "# first content\n");
    const c2 = await bundleOf("a", "gemini-2.5-pro", "# second content\n");

    await push(first, "a", "1.0.0", c1);
    expect((await run(second, "a")).status).toBe(200);
    expect(cache2.size).toBe(1);

    // The agent is deleted on the first instance, and the same number comes
    // back with other bytes. The second instance still holds the first
    // extraction: nothing told it.
    const del = await first.request("/api/agents/dev/a", { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(204);
    await push(first, "a", "1.0.0", c2);

    expect((await run(second, "a")).status).toBe(200);
    expect(seen.map((r) => [r.agentConfig.model.name, r.skillContent])).toEqual([
      ["gemini-2.5-flash", "# first content\n"],
      ["gemini-2.5-pro", "# second content\n"],
    ]);
  });

  it("a version with no checksum on record is cached under the checksum of its bytes, and shares the extraction of a version with the same bytes", async () => {
    const storage = new MemoryStorage();
    const db = new MemoryDb();
    const app = createApp(storage, db, OPTS);
    const seen = scriptExecute(vi.spyOn(LocalAdapter.prototype, "execute"));

    const bytes = await bundleOf("legacy", "gemini-2.5-flash", "# legacy\n");
    await push(app, "legacy", "1.0.0", bytes);
    // 2.0.0: the same bytes, recorded the way a bundle published before
    // checksums were kept is — no checksum on its row.
    const agent = await db.getAgent("dev", "legacy");
    if (!agent) throw new Error("agent missing after push");
    await storage.put("dev/legacy/2.0.0.agent", bytes);
    await db.createVersion(agent.id, {
      version: "2.0.0",
      size: bytes.length,
      bundle_key: "dev/legacy/2.0.0.agent",
      bundle_sha256: null,
    });
    expect((await db.getVersionByNumber(agent.id, "2.0.0"))?.bundle_sha256).toBeNull();

    expect((await run(app, "legacy", "2.0.0")).status).toBe(200);
    const extracted = bundleCache.get(sha256(bytes));
    expect(extracted).toBeDefined();
    expect(bundleCache.size).toBe(1);

    expect((await run(app, "legacy", "1.0.0")).status).toBe(200);
    expect(bundleCache.size).toBe(1);
    expect(bundleCache.get(sha256(bytes))?.dir).toBe(extracted?.dir);
    expect(seen.map((r) => r.agent_version)).toEqual(["2.0.0", "1.0.0"]);
  });

  // A local run launches its scripts from the extraction's directory: the
  // whole bundle is written there. What the cache keeps in memory is the text
  // the run reads — the three manifests —, nothing else of the bundle.
  it("a local run extracts the whole bundle to disk, and the cache keeps the text of its three manifests only", async () => {
    const app = createApp(new MemoryStorage(), new MemoryDb(), OPTS);
    const seen = scriptExecute(vi.spyOn(LocalAdapter.prototype, "execute"));

    const manifests = {
      "agent.yaml": agentYamlOf("whole", "gemini-2.5-flash"),
      "SKILL.md": "# whole\n",
      "AGENTS.md": "# persistent context\n",
    };
    const bytes = await packAgentTar([
      ...Object.entries(manifests).map(([name, text]) => ({ name, content: Buffer.from(text) })),
      { name: "scripts/hello.sh", content: Buffer.from("echo hi\n") },
      { name: "assets/blob.bin", content: Buffer.alloc(256 * 1024, 0xff) },
    ]);
    await push(app, "whole", "1.0.0", bytes);

    expect((await run(app, "whole")).status).toBe(200);
    expect(seen.map((r) => [r.skillContent, r.agentsMdContent])).toEqual([
      [manifests["SKILL.md"], manifests["AGENTS.md"]],
    ]);
    const entry = bundleCache.get(sha256(bytes));
    expect(entry?.files).toEqual(manifests);
    const dir = entry?.dir as string;
    expect(readFileSync(join(dir, "scripts", "hello.sh"), "utf-8")).toBe("echo hi\n");
    expect(readFileSync(join(dir, "assets", "blob.bin")).length).toBe(256 * 1024);
  });
});
