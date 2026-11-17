import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { packAgentTar, parseAgentYaml, type ValidationError } from "@skrun-dev/schema";
import { type Headers, pack as tarPack } from "tar-stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { MemoryDb } from "../db/memory.js";
import {
  agentYamlOfSize,
  minimalAgentYaml,
  validBundle,
  withSize,
} from "../routes/agent-bundle.shared.js";
import { MemoryStorage } from "../storage/memory.js";
import { AccountTurns, type PushLimits, RegistryError, RegistryService } from "./registry.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A bundle a push accepts, packed once: `sized` gives it the weight a test needs. */
let SIZED_BASE: Buffer;
beforeAll(async () => {
  SIZED_BASE = await validBundle("sized");
});
/** A bundle a push accepts, of exactly `bytes` bytes. */
const sized = (bytes: number): Buffer => withSize(SIZED_BASE, bytes);

/** A bundle whose agent.yaml declares `timeout` (none: the schema's default). */
async function agentBundle(timeout?: string): Promise<Buffer> {
  const yaml = [
    "name: bounded",
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
    ...(timeout ? ["environment:", `  timeout: ${timeout}`] : []),
  ].join("\n");
  return packAgentTar([
    { name: "agent.yaml", content: Buffer.from(yaml) },
    { name: "SKILL.md", content: Buffer.from("# bounded\n") },
  ]);
}

describe("RegistryService", () => {
  let service: RegistryService;
  let storage: MemoryStorage;
  let db: MemoryDb;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = new MemoryDb();
    service = new RegistryService(storage, db);
    // Clear shared bundleCache singleton between tests to avoid cross-test pollution
    bundleCache.clear();
  });

  it("should push and pull a bundle", async () => {
    const bundle = await validBundle();
    await service.push("acme", "seo-audit", "1.0.0", bundle, "user-1");

    const result = await service.pull("acme", "seo-audit");
    expect(result.buffer).toEqual(bundle);
    expect(result.version).toBe("1.0.0");
  });

  it("should push multiple versions", async () => {
    const first = await validBundle("v1");
    const second = await validBundle("v2");
    await service.push("acme", "agent", "1.0.0", first, "user-1");
    await service.push("acme", "agent", "1.1.0", second, "user-1");

    const latest = await service.pull("acme", "agent");
    expect(latest.version).toBe("1.1.0");
    expect(latest.buffer).toEqual(second);

    const v1 = await service.pull("acme", "agent", "1.0.0");
    expect(v1.buffer).toEqual(first);
  });

  it("should reject duplicate version", async () => {
    await service.push("acme", "agent", "1.0.0", await validBundle("v1"), "user-1");
    await expect(
      service.push("acme", "agent", "1.0.0", await validBundle("v2"), "user-1"),
    ).rejects.toThrow(RegistryError);
    await expect(
      service.push("acme", "agent", "1.0.0", await validBundle("v2"), "user-1"),
    ).rejects.toThrow("already exists");
  });

  it("should throw 404 on pull for non-existent agent", async () => {
    await expect(service.pull("x", "y")).rejects.toThrow(RegistryError);
  });

  it("should throw 404 on pull for non-existent version", async () => {
    await service.push("acme", "agent", "1.0.0", await validBundle("v1"), "user-1");
    await expect(service.pull("acme", "agent", "9.9.9")).rejects.toThrow("not found");
  });

  // ── Bundle integrity (SEC-020 / #17) ────────────────────────────────────

  it("VT-8: push stores the bundle SHA-256", async () => {
    const bundle = await validBundle("hashed");
    await service.push("acme", "hashed", "1.0.0", bundle, "user-1");
    const agent = await db.getAgent("acme", "hashed");
    const v = await db.getVersionByNumber(agent?.id ?? "", "1.0.0");
    expect(v?.bundle_sha256).toBe(createHash("sha256").update(bundle).digest("hex"));
    expect(v?.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("VT-9: pull verifies and serves an intact bundle", async () => {
    const bundle = await validBundle("intact");
    await service.push("acme", "intact", "1.0.0", bundle, "user-1");
    const result = await service.pull("acme", "intact");
    expect(result.buffer).toEqual(bundle);
  });

  it("VT-10: pull throws BUNDLE_INTEGRITY_FAILED (500) on a tampered bundle", async () => {
    await service.push("acme", "tampered", "1.0.0", await validBundle("tampered"), "user-1");
    // Corrupt the stored object behind the registry's back.
    await storage.put("acme/tampered/1.0.0.agent", Buffer.from("evil-payload"));
    await expect(service.pull("acme", "tampered")).rejects.toMatchObject({
      code: "BUNDLE_INTEGRITY_FAILED",
      status: 500,
    });
  });

  it("VT-11: pull serves a legacy bundle with a null checksum (no 500)", async () => {
    // A pre-#17 version: row exists with no bundle_sha256, bundle present.
    const agent = await db.createAgent({
      name: "legacy",
      namespace: "acme",
      description: "",
      owner_id: "user-1",
    });
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 3,
      bundle_key: "acme/legacy/1.0.0.agent",
    });
    await storage.put("acme/legacy/1.0.0.agent", Buffer.from("xyz"));
    const result = await service.pull("acme", "legacy");
    expect(result.buffer.toString()).toBe("xyz");
  });

  it("should list agents with pagination", async () => {
    await service.push("ns", "a", "1.0.0", await validBundle("a"), "u");
    await service.push("ns", "b", "1.0.0", await validBundle("b"), "u");
    await service.push("ns", "c", "1.0.0", await validBundle("c"), "u");

    const page1 = await service.list(1, 2);
    expect(page1.agents).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await service.list(2, 2);
    expect(page2.agents).toHaveLength(1);
  });

  it("should get metadata", async () => {
    await service.push("acme", "seo-audit", "1.0.0", await validBundle("v1"), "user-1");
    const meta = await service.getMetadata("acme", "seo-audit");
    expect(meta.name).toBe("seo-audit");
    expect(meta.namespace).toBe("acme");
    expect(meta.latest_version).toBe("1.0.0");
    expect(meta.versions).toEqual(["1.0.0"]);
  });

  // VT-21 (CODE-113): buildMetadata previously returned hardcoded zeros.
  // Now run_count and token_count reflect the agent's runs, counted by the
  // database (getAgentRunTotals).
  it("VT-21: getMetadata returns real run_count + token_count", async () => {
    await service.push("acme", "stats-agent", "1.0.0", await validBundle("v1"), "user-1");
    const agent = await db.getAgent("acme", "stats-agent");
    if (!agent) throw new Error("seed agent missing");

    // 5 runs, total 1000 tokens
    for (let i = 0; i < 5; i++) {
      await db.createRun({
        id: `r-${i}`,
        agent_id: agent.id,
        agent_version: "acme/stats-agent@1.0.0",
        status: "completed",
      });
      await db.updateRun(`r-${i}`, { usage_total_tokens: 200 });
    }

    const meta = await service.getMetadata("acme", "stats-agent");
    expect(meta.run_count).toBe(5);
    expect(meta.token_count).toBe(1000);
  });

  it("counts an agent's runs without reading them: the metadata and a push's answer never list its runs", async () => {
    await service.push("acme", "counted", "1.0.0", await validBundle("v1"), "user-1");
    await service.push("acme", "beside", "1.0.0", await validBundle("v1"), "user-1");
    const counted = await db.getAgent("acme", "counted");
    const beside = await db.getAgent("acme", "beside");
    if (!counted || !beside) throw new Error("seed agents missing");
    for (let i = 0; i < 3; i++) {
      await db.createRun({
        id: `counted-${i}`,
        agent_id: counted.id,
        agent_version: "acme/counted@1.0.0",
        status: i === 2 ? "failed" : "completed",
      });
      await db.updateRun(`counted-${i}`, { usage_total_tokens: 100 * (i + 1) });
    }
    await db.createRun({
      id: "beside-0",
      agent_id: beside.id,
      agent_version: "acme/beside@1.0.0",
      status: "completed",
    });
    await db.updateRun("beside-0", { usage_total_tokens: 5000 });
    const listRuns = vi.spyOn(db, "listRuns");

    const meta = await service.getMetadata("acme", "counted");
    const pushed = await service.push(
      "acme",
      "counted",
      "1.1.0",
      await validBundle("v2"),
      "user-1",
    );

    expect([meta.run_count, meta.token_count]).toEqual([3, 600]);
    expect([pushed.run_count, pushed.token_count]).toEqual([3, 600]);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("VT-21b: getMetadata returns 0/0 for an agent with no runs (no false positives)", async () => {
    await service.push("acme", "empty-agent", "1.0.0", await validBundle("v1"), "user-1");
    const meta = await service.getMetadata("acme", "empty-agent");
    expect(meta.run_count).toBe(0);
    expect(meta.token_count).toBe(0);
  });

  it("should get versions list", async () => {
    await service.push("acme", "agent", "1.0.0", await validBundle("v1"), "user-1");
    await service.push("acme", "agent", "2.0.0", await validBundle("v2"), "user-1");

    const versions = await service.getVersions("acme", "agent");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe("1.0.0");
    expect(versions[1].version).toBe("2.0.0");
  });

  it("should store bundle in storage with correct key", async () => {
    const bundle = await validBundle("seo");
    await service.push("acme", "seo", "1.0.0", bundle, "u");
    expect(await storage.exists("acme/seo/1.0.0.agent")).toBe(true);
  });

  it("should propagate notes from push to the stored version", async () => {
    await service.push("acme", "agent", "1.0.0", await validBundle("v1"), "u", "Added retry logic");
    const versions = await service.getVersions("acme", "agent");
    expect(versions[0].notes).toBe("Added retry logic");
  });

  it("should default notes to null when absent", async () => {
    await service.push("acme", "agent", "1.0.0", await validBundle("v1"), "u");
    const versions = await service.getVersions("acme", "agent");
    expect(versions[0].notes).toBeNull();
  });

  // ── deleteVersion (#77) ──────────────────────────────────────────────

  describe("deleteVersion (#77)", () => {
    // VT-7 LAST_VERSION
    it("throws 409 LAST_VERSION when deleting the only remaining version", async () => {
      await service.push("dev", "foo", "1.0.0", await validBundle("v1"), "u");

      await expect(service.deleteVersion("dev", "foo", "1.0.0")).rejects.toThrow(RegistryError);
      try {
        await service.deleteVersion("dev", "foo", "1.0.0");
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        expect((err as RegistryError).code).toBe("LAST_VERSION");
        expect((err as RegistryError).status).toBe(409);
      }
      // Version still exists
      const versions = await service.getVersions("dev", "foo");
      expect(versions).toHaveLength(1);
    });

    // 404 NOT_FOUND (agent missing)
    it("throws 404 NOT_FOUND when agent does not exist", async () => {
      try {
        await service.deleteVersion("dev", "missing", "1.0.0");
        expect.fail("expected to throw");
      } catch (err) {
        expect((err as RegistryError).code).toBe("NOT_FOUND");
        expect((err as RegistryError).status).toBe(404);
      }
    });

    // 404 VERSION_NOT_FOUND (agent OK, version missing)
    it("throws 404 VERSION_NOT_FOUND when version does not exist", async () => {
      await service.push("dev", "foo", "1.0.0", await validBundle("v1"), "u");
      await service.push("dev", "foo", "2.0.0", await validBundle("v2"), "u");

      try {
        await service.deleteVersion("dev", "foo", "9.9.9");
        expect.fail("expected to throw");
      } catch (err) {
        expect((err as RegistryError).code).toBe("VERSION_NOT_FOUND");
        expect((err as RegistryError).status).toBe(404);
      }
      // Both existing versions still present
      const versions = await service.getVersions("dev", "foo");
      expect(versions.map((v) => v.version)).toEqual(["1.0.0", "2.0.0"]);
    });

    // VT-9 past run preserved
    it("preserves past runs referencing the deleted version (text column, no FK cascade)", async () => {
      await service.push("dev", "foo", "1.0.0", await validBundle("v1"), "u");
      await service.push("dev", "foo", "9.9.999", await validBundle("v2"), "u");
      const agent = await db.getAgent("dev", "foo");
      const run = await db.createRun({
        id: "run-vt9",
        agent_id: agent?.id ?? null,
        agent_version: "9.9.999",
        status: "completed",
      });

      await service.deleteVersion("dev", "foo", "9.9.999");

      const persistedRun = await db.getRun(run.id);
      expect(persistedRun).not.toBeNull();
      expect(persistedRun?.agent_version).toBe("9.9.999");
      expect(persistedRun?.agent_id).toBe(agent?.id);
    });

    // The extracted-bundle cache is keyed by the bundle's bytes: an extraction
    // can never be served for other content, and another agent with the same
    // bytes may be running from it. Deleting leaves it to its expiry.
    it("deleting a version leaves its extraction to the cache's expiry", async () => {
      await service.push("dev", "foo", "1.0.0", await validBundle("v1"), "u");
      await service.push("dev", "foo", "2.0.0", await validBundle("v2"), "u");

      // Pre-populate cache as if a run just extracted this version
      const key = sha256("v1");
      bundleCache.set(key, { dir: "/tmp/skrun-test-version-delete", files: {} });
      const evict = vi.spyOn(bundleCache, "delete");

      await service.deleteVersion("dev", "foo", "1.0.0");

      expect(evict).not.toHaveBeenCalled();
      expect(bundleCache.get(key)).toBeDefined();
      evict.mockRestore();
    });

    // VT-11 getMetadata returns new latest after delete
    it("getMetadata returns the new latest version after deleting the previous latest", async () => {
      await service.push("dev", "foo", "1.0.0", await validBundle("v1"), "u");
      await service.push("dev", "foo", "2.0.0", await validBundle("v2"), "u");

      const before = await service.getMetadata("dev", "foo");
      expect(before.latest_version).toBe("2.0.0");

      await service.deleteVersion("dev", "foo", "2.0.0");

      const after = await service.getMetadata("dev", "foo");
      expect(after.latest_version).toBe("1.0.0");
    });

    // VT-12 failure-mode order (storage throws, db delete still happens)
    it("storage delete failure is swallowed but DB row still removed (storage-before-db order)", async () => {
      await service.push("dev", "foo", "1.0.0", await validBundle("v1"), "u");
      await service.push("dev", "foo", "2.0.0", await validBundle("v2"), "u");

      // Mock storage.delete to throw
      const storageSpy = vi
        .spyOn(storage, "delete")
        .mockRejectedValueOnce(new Error("R2 unavailable"));

      // Should NOT throw — the .catch(()=>{}) swallows the storage error
      await service.deleteVersion("dev", "foo", "1.0.0");

      expect(storageSpy).toHaveBeenCalled();
      // DB row removed despite storage failure → orphan storage entry, recoverable later
      const versions = await service.getVersions("dev", "foo");
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe("2.0.0");

      storageSpy.mockRestore();
    });

    // VT-13 static guard: storage.delete appears before db.deleteVersion in source
    it("source guarantees storage.delete is called BEFORE db.deleteVersion (regression guard)", () => {
      const src = readFileSync(resolve(import.meta.dirname, "registry.ts"), "utf-8");
      const methodAnchor = src.indexOf("async deleteVersion(");
      expect(methodAnchor).toBeGreaterThan(-1);

      const storageIdx = src.indexOf("this.storage.delete", methodAnchor);
      const dbIdx = src.indexOf("this.db.deleteVersion", methodAnchor);
      expect(storageIdx).toBeGreaterThan(-1);
      expect(dbIdx).toBeGreaterThan(-1);
      // storage delete must appear before db delete in source code order
      expect(storageIdx).toBeLessThan(dbIdx);
    });

    it("deleting an agent leaves the extractions of its versions to the cache's expiry", async () => {
      await service.push("dev", "multi", "1.0.0", await validBundle("v1"), "u");
      await service.push("dev", "multi", "2.0.0", await validBundle("v2"), "u");

      bundleCache.set(sha256("v1"), { dir: "/tmp/skrun-test-agent-delete-1", files: {} });
      bundleCache.set(sha256("v2"), { dir: "/tmp/skrun-test-agent-delete-2", files: {} });
      const evict = vi.spyOn(bundleCache, "delete");

      await service.deleteAgent("dev", "multi");

      expect(evict).not.toHaveBeenCalled();
      expect(bundleCache.size).toBe(2);
      evict.mockRestore();
    });
  });

  // ── Per-version verify (Phase 8.2 — service layer) ──────────────────
  describe("setVersionVerified", () => {
    it("flips the specified version's verified flag to true", async () => {
      await service.push("acme", "v-test", "1.0.0", await validBundle("v1"), "u");
      const result = await service.setVersionVerified("acme", "v-test", "1.0.0", true);
      expect(result.verified).toBe(true);
      expect(result.version).toBe("1.0.0");
    });

    it("flips back to false (revoke)", async () => {
      await service.push("acme", "v-test", "1.0.0", await validBundle("v1"), "u");
      await service.setVersionVerified("acme", "v-test", "1.0.0", true);
      const result = await service.setVersionVerified("acme", "v-test", "1.0.0", false);
      expect(result.verified).toBe(false);
    });

    it("throws NOT_FOUND when agent is missing", async () => {
      await expect(service.setVersionVerified("ghost", "none", "1.0.0", true)).rejects.toThrow(
        RegistryError,
      );
    });

    it("throws VERSION_NOT_FOUND when version is missing", async () => {
      await service.push("acme", "v-test", "1.0.0", await validBundle("v1"), "u");
      await expect(service.setVersionVerified("acme", "v-test", "9.9.9", true)).rejects.toThrow(
        "Version 9.9.9 not found",
      );
    });

    it("only touches the targeted version (BR-2: pinned-caller protection)", async () => {
      await service.push("acme", "multi", "1.0.0", await validBundle("v1"), "u");
      await service.push("acme", "multi", "2.0.0", await validBundle("v2"), "u");
      // Verify v1.0.0 only
      await service.setVersionVerified("acme", "multi", "1.0.0", true);
      const versions = await service.getVersions("acme", "multi");
      const v1 = versions.find((v) => v.version === "1.0.0");
      const v2 = versions.find((v) => v.version === "2.0.0");
      expect(v1?.verified).toBe(true);
      expect(v2?.verified).toBe(false);
    });
  });

  // ── latest_version_verified computation (Phase 8.2) ────────────────────
  describe("latest_version_verified computation", () => {
    it("buildMetadata returns false when no version is verified", async () => {
      await service.push("acme", "a", "1.0.0", await validBundle("v1"), "u");
      const meta = await service.getMetadata("acme", "a");
      expect(meta.latest_version_verified).toBe(false);
    });

    it("buildMetadata returns true when latest version is verified", async () => {
      await service.push("acme", "a", "1.0.0", await validBundle("v1"), "u");
      await service.setVersionVerified("acme", "a", "1.0.0", true);
      const meta = await service.getMetadata("acme", "a");
      expect(meta.latest_version_verified).toBe(true);
    });

    it("buildMetadata reflects only the LATEST version's flag (older verified, newer not)", async () => {
      // v1.0.0 verified, v2.0.0 pushed unverified — latest_version_verified
      // tracks v2.0.0 (the latest), not v1.0.0.
      await service.push("acme", "mixed", "1.0.0", await validBundle("v1"), "u");
      await service.setVersionVerified("acme", "mixed", "1.0.0", true);
      await service.push("acme", "mixed", "2.0.0", await validBundle("v2"), "u");
      const meta = await service.getMetadata("acme", "mixed");
      expect(meta.latest_version).toBe("2.0.0");
      expect(meta.latest_version_verified).toBe(false);
    });

    it("list() exposes latest_version_verified on each row", async () => {
      await service.push("ns1", "verified-one", "1.0.0", await validBundle("v1"), "u");
      await service.setVersionVerified("ns1", "verified-one", "1.0.0", true);
      await service.push("ns2", "unverified-one", "1.0.0", await validBundle("v2"), "u");

      const result = await service.list(1, 10);
      const verified = result.agents.find((a) => a.name === "verified-one");
      const unverified = result.agents.find((a) => a.name === "unverified-one");
      expect(verified?.latest_version_verified).toBe(true);
      expect(unverified?.latest_version_verified).toBe(false);
    });
  });

  // ── What bounds a push: the server's longest timeout, the account's storage ──
  describe("a push over a bound is refused before anything is stored", () => {
    const MIB = 1024 * 1024;
    /** Nothing bounds the push; a master credential asks. */
    const OPEN: PushLimits = { plan: "free", maxTimeoutS: null, storageBytes: null, master: true };

    /** Spies on the two writes a refused push must never reach. */
    function spyOnWrites() {
      return {
        createAgent: vi.spyOn(db, "createAgent"),
        createVersion: vi.spyOn(db, "createVersion"),
        put: vi.spyOn(storage, "put"),
      };
    }

    it("an agent declaring more than the server's maximum: 400 TIMEOUT_ABOVE_LIMIT, no agent created, no object stored", async () => {
      const writes = spyOnWrites();
      const bundle = await agentBundle("1800s");
      await expect(
        service.push("acme", "slow", "1.0.0", bundle, "user-1", null, {
          ...OPEN,
          maxTimeoutS: 900,
        }),
      ).rejects.toMatchObject({
        code: "TIMEOUT_ABOVE_LIMIT",
        status: 400,
        message: "This agent declares 1800 s; this server accepts at most 900 s.",
      });
      expect(writes.createAgent).not.toHaveBeenCalled();
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
      expect(await db.getAgent("acme", "slow")).toBeNull();
      expect(await storage.get("acme/slow/1.0.0.agent")).toBeNull();
    });

    it("a new version of an existing agent over the maximum: refused, the agent keeps its one version and its one object", async () => {
      await service.push("acme", "slow", "1.0.0", await agentBundle("600s"), "user-1", null, {
        ...OPEN,
        maxTimeoutS: 900,
      });
      const writes = spyOnWrites();
      await expect(
        service.push("acme", "slow", "1.1.0", await agentBundle("1800s"), "user-1", null, {
          ...OPEN,
          maxTimeoutS: 900,
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT_ABOVE_LIMIT", status: 400 });
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
      const agent = await db.getAgent("acme", "slow");
      expect((await db.getVersions(agent?.id ?? "")).map((v) => v.version)).toEqual(["1.0.0"]);
      expect(await storage.get("acme/slow/1.1.0.agent")).toBeNull();
    });

    it("an agent declaring exactly the maximum is stored", async () => {
      const meta = await service.push(
        "acme",
        "at-max",
        "1.0.0",
        await agentBundle("900s"),
        "user-1",
        null,
        { ...OPEN, maxTimeoutS: 900 },
      );
      expect(meta.latest_version).toBe("1.0.0");
    });

    it("an agent that declares no timeout runs up to the default: refused only under a maximum below it", async () => {
      await expect(
        service.push("acme", "default", "1.0.0", await agentBundle(), "user-1", null, {
          ...OPEN,
          maxTimeoutS: 120,
        }),
      ).rejects.toMatchObject({
        code: "TIMEOUT_ABOVE_LIMIT",
        message:
          "This agent runs up to 300 s, the default timeout of an agent that declares none; this server accepts at most 120 s.",
      });
      const meta = await service.push(
        "acme",
        "default",
        "1.0.0",
        await agentBundle(),
        "user-1",
        null,
        { ...OPEN, maxTimeoutS: 300 },
      );
      expect(meta.latest_version).toBe("1.0.0");
    });

    it("a bundle whose agent.yaml does not read is refused, whatever the maximum: never stored without a configuration", async () => {
      const writes = spyOnWrites();
      const unreadable = await packAgentTar([
        { name: "agent.yaml", content: Buffer.from("name: [unclosed") },
      ]);
      for (const [name, bundle, code] of [
        ["not-a-tar", Buffer.from("not-a-bundle"), "BUNDLE_CORRUPT"],
        ["bad-yaml", unreadable, "INVALID_CONFIG"],
      ] as const) {
        await expect(
          service.push("acme", name, "1.0.0", bundle, "user-1", null, { ...OPEN, maxTimeoutS: 1 }),
        ).rejects.toMatchObject({ code, status: 400 });
        expect(await db.getAgent("acme", name)).toBeNull();
      }
      expect(writes.createAgent).not.toHaveBeenCalled();
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
    });

    it("a first push past the account's storage: 413 STORAGE_QUOTA_EXCEEDED, no agent created, no object stored", async () => {
      const writes = spyOnWrites();
      await expect(
        service.push("acme", "big", "1.0.0", sized(MIB + 1), "user-1", null, {
          ...OPEN,
          storageBytes: MIB,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", status: 413 });
      expect(writes.createAgent).not.toHaveBeenCalled();
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
      expect(await db.getAgent("acme", "big")).toBeNull();
      expect(await storage.get("acme/big/1.0.0.agent")).toBeNull();
    });

    it("counts what the account already holds, across its agents; up to the cap exactly, a push is stored", async () => {
      const limits = { ...OPEN, storageBytes: 3 * MIB };
      await service.push("acme", "one", "1.0.0", sized(MIB), "user-1", null, limits);
      await service.push("acme", "two", "1.0.0", sized(MIB), "user-1", null, limits);
      // Another account's bundles count for that account only.
      await service.push("other", "theirs", "1.0.0", sized(2 * MIB), "user-2", null, limits);

      const writes = spyOnWrites();
      await expect(
        service.push("acme", "two", "1.1.0", sized(MIB + 1), "user-1", null, limits),
      ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", status: 413 });
      expect(writes.put).not.toHaveBeenCalled();

      const meta = await service.push("acme", "two", "1.1.0", sized(MIB), "user-1", null, limits);
      expect(meta.versions).toEqual(["1.0.0", "1.1.0"]);
    });

    it("tells a master credential the cap, what the account holds, and how to make room — and a version deleted makes it", async () => {
      const limits = { ...OPEN, storageBytes: 2 * MIB };
      await service.push("acme", "agent", "1.0.0", sized(MIB), "user-1", null, limits);
      await service.push("acme", "agent", "1.1.0", sized(MIB / 2), "user-1", null, limits);

      const refused = service.push("acme", "agent", "1.2.0", sized(MIB), "user-1", null, limits);
      await expect(refused).rejects.toMatchObject({
        code: "STORAGE_QUOTA_EXCEEDED",
        status: 413,
        message:
          "This account's agents hold 1.5 MB of the 2 MB of bundle storage its plan allows; this bundle (1 MB) does not fit. Delete a version no longer needed (DELETE /api/agents/:namespace/:name/versions/:version) to make room — or, for an agent's last version, the agent (DELETE /api/agents/:namespace/:name), which deletes its state and its model keys too, and removes it from the keys restricted to it.",
      });

      await service.deleteVersion("acme", "agent", "1.0.0");
      const meta = await service.push("acme", "agent", "1.2.0", sized(MIB), "user-1", null, limits);
      expect(meta.versions).toEqual(["1.1.0", "1.2.0"]);
    });

    it("an agent's last version cannot be deleted to make room: the agent can, as the refusal says", async () => {
      const limits = { ...OPEN, storageBytes: MIB };
      await service.push("acme", "solo", "1.0.0", sized(800 * 1024), "user-1", null, limits);
      const refusal = await service
        .push("acme", "solo", "1.0.1", sized(300 * 1024), "user-1", null, limits)
        .then(
          () => null,
          (err: unknown) => err as RegistryError,
        );
      expect(refusal?.code).toBe("STORAGE_QUOTA_EXCEEDED");
      expect(refusal?.message).toContain(
        "or, for an agent's last version, the agent (DELETE /api/agents/:namespace/:name)",
      );
      await expect(service.deleteVersion("acme", "solo", "1.0.0")).rejects.toMatchObject({
        code: "LAST_VERSION",
      });

      await service.deleteAgent("acme", "solo");
      const meta = await service.push(
        "acme",
        "solo",
        "1.0.1",
        sized(300 * 1024),
        "user-1",
        null,
        limits,
      );
      expect(meta.versions).toEqual(["1.0.1"]);
    });

    it("tells the sizes rounded to a tenth while rounding keeps them true — in bytes otherwise, and never as 1024 KB", async () => {
      const KIB = 1024;
      /** The first sentence of the refusal of a push of `bundle` bytes, the account holding `held`. */
      async function toldFor(held: number[], bundle: number, storageBytes: number) {
        const fresh = new MemoryDb();
        const pushes = new RegistryService(new MemoryStorage(), fresh);
        for (const [i, bytes] of held.entries()) {
          await pushes.push("acme", `held-${i}`, "1.0.0", sized(bytes), "user-1");
        }
        const refusal = await pushes
          .push("acme", "new", "1.0.0", sized(bundle), "user-1", null, {
            ...OPEN,
            storageBytes,
          })
          .then(
            () => null,
            (err: unknown) => err as RegistryError,
          );
        return refusal?.message.split(" Delete ")[0];
      }

      // Rounded, the bundle would seem to fit: 0 B and 1 MB in 1 MB.
      expect(await toldFor([], MIB + 1, MIB)).toBe(
        "This account's agents hold 0 B of the 1,048,576 B of bundle storage its plan allows; this bundle (1,048,577 B) does not fit.",
      );
      // Rounded, an account 40 bytes short of its cap would seem full.
      expect(await toldFor([MIB - 40], 500, MIB)).toBe(
        "This account's agents hold 1,048,536 B of the 1,048,576 B of bundle storage its plan allows; this bundle (500 B) does not fit.",
      );
      // Rounded, an account over its cap (its plan lowered) would seem exactly at it.
      expect(await toldFor([MIB + 40 * KIB], 500, MIB)).toBe(
        "This account's agents hold 1,089,536 B of the 1,048,576 B of bundle storage its plan allows; this bundle (500 B) does not fit.",
      );
      // A size that rounds to 1024 KB is told in MB.
      expect(await toldFor([2.5 * MIB], MIB - 40, 3 * MIB)).toBe(
        "This account's agents hold 2.5 MB of the 3 MB of bundle storage its plan allows; this bundle (1 MB) does not fit.",
      );
      // At its cap exactly, rounding says it as it is.
      expect(await toldFor([MIB], 500, MIB)).toBe(
        "This account's agents hold 1 MB of the 1 MB of bundle storage its plan allows; this bundle (500 B) does not fit.",
      );
    });

    it("tells any other credential the bound, never the account's numbers", async () => {
      const limits = { ...OPEN, storageBytes: MIB, master: false };
      const refusal = await service
        .push("acme", "big", "1.0.0", sized(MIB + 1), "user-1", null, limits)
        .then(
          () => null,
          (err: unknown) => err as RegistryError,
        );
      expect(refusal).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", status: 413 });
      expect(refusal?.message).toBe(
        "This push would take this account past the bundle storage its plan allows; a version deleted from the account makes room — or, for an agent's last version, the agent, which deletes its state and its model keys too, and removes it from the keys restricted to it.",
      );
      expect(refusal?.message).not.toMatch(/\d/);
    });

    it("a version already pushed is refused 409 VERSION_EXISTS, the account at its storage too: before the storage is read, nothing written", async () => {
      const KIB = 1024;
      const limits = { ...OPEN, storageBytes: MIB };
      await service.push("acme", "agent", "1.0.0", sized(600 * KIB), "user-1", null, limits);
      await service.push("acme", "agent", "1.0.1", sized(300 * KIB), "user-1", null, limits);

      const writes = spyOnWrites();
      const sum = vi.spyOn(db, "sumBundleBytesByOwner");
      await expect(
        service.push("acme", "agent", "1.0.1", sized(300 * KIB), "user-1", null, limits),
      ).rejects.toMatchObject({ code: "VERSION_EXISTS", status: 409 });
      expect(sum).not.toHaveBeenCalled();
      expect(writes.createAgent).not.toHaveBeenCalled();
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
      const agent = await db.getAgent("acme", "agent");
      expect((await db.getVersions(agent?.id ?? "")).map((v) => v.version)).toEqual([
        "1.0.0",
        "1.0.1",
      ]);
    });

    it("with no storage bound, reads nothing of what the account holds", async () => {
      const sum = vi.spyOn(db, "sumBundleBytesByOwner");
      await service.push("acme", "free", "1.0.0", sized(MIB), "user-1", null, {
        ...OPEN,
        maxTimeoutS: 900,
      });
      await service.push("acme", "free", "1.1.0", sized(MIB), "user-1");
      expect(sum).not.toHaveBeenCalled();
    });
  });

  // ── A bundle that does not load is refused at push, whatever bounds it ──
  // What no run could read is never stored: an archive past the server's
  // decompression cap, one that does not read, one without an agent.yaml or
  // with an invalid one — judged on the bundle alone, before any other refusal,
  // the account's turn and the duplicate check.
  describe("a bundle that does not load is refused, by name, before anything is stored", () => {
    const previousCap = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
    beforeEach(() => {
      // A cap of 1 MB, so a bundle past it stays small to build.
      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "1";
    });
    afterEach(() => {
      if (previousCap === undefined) delete process.env.BUNDLE_MAX_DECOMPRESSED_MB;
      else process.env.BUNDLE_MAX_DECOMPRESSED_MB = previousCap;
    });

    /** About 2 MB of text: a few KB compressed, past the 1 MB cap once unpacked. */
    const BLOB = Buffer.from("lorem ipsum dolor sit amet\n".repeat(80_000));

    /** A bundle of `agentYaml` and a `SKILL.md` — and, `big`, of BLOB too. */
    function bundleOf(agentYaml: string, big = false): Promise<Buffer> {
      return packAgentTar([
        { name: "agent.yaml", content: Buffer.from(agentYaml) },
        { name: "SKILL.md", content: Buffer.from("# unloadable\n") },
        ...(big ? [{ name: "data/blob.txt", content: BLOB }] : []),
      ]);
    }

    /** A gzipped tar of `entries` as given, any type — `packAgentTar` writes files only. */
    function rawBundle(
      entries: Array<{ name: string; type?: Headers["type"]; linkname?: string; content?: Buffer }>,
    ): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const pack = tarPack();
        const chunks: Buffer[] = [];
        pack.on("data", (c: Buffer) => chunks.push(c));
        pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
        pack.on("error", reject);
        for (const e of entries) {
          const content = e.content ?? Buffer.alloc(0);
          pack.entry(
            { ...e, type: e.type ?? "file", size: content.length, mtime: new Date(0) },
            content,
          );
        }
        pack.finalize();
      });
    }

    /** The words validation gives an `agent.yaml`, joined as the refusal joins them. */
    function issuesOf(agentYaml: string): string {
      try {
        parseAgentYaml(agentYaml);
      } catch (err) {
        return (err as ValidationError).issues.map((issue) => issue.message).join("; ");
      }
      throw new Error("this agent.yaml is valid");
    }

    const TOO_LARGE =
      "This bundle decompresses to more than 1 MB, the most this server unpacks (BUNDLE_MAX_DECOMPRESSED_MB). Make the agent smaller — leave out the files it does not need when it runs — and push it again; the server's operator can raise BUNDLE_MAX_DECOMPRESSED_MB.";
    const MISSING =
      "This bundle has no agent.yaml at its root, or an empty one: an agent's bundle carries its configuration there, as skrun build makes it.";
    const NOT_READABLE = (reason: string) =>
      `This bundle is not a readable .agent archive — a gzip-compressed tar, as skrun build makes (${reason}).`;
    const UNWRITABLE = "This bundle cannot be written out where an agent runs: ";
    const SCHEMA_INVALID = "name: unloadable\nversion: 1.0.0\n";
    /** A tool whose input schema holds an !!omap, where the schema takes any value: valid but for the tag. */
    const OMAP_TOOL = [
      "tools:",
      "  - name: first",
      "    description: Looks things up.",
      "    input_schema:",
      "      type: object",
      "      properties:",
      "        p: !!omap [a: 1, b: 2]",
    ];

    const CASES: ReadonlyArray<
      [string, () => Promise<Buffer>, 400 | 413, string, () => string | RegExp]
    > = [
      [
        "past the decompression cap",
        () => bundleOf(minimalAgentYaml("unloadable"), true),
        413,
        "BUNDLE_DECOMPRESSED_TOO_LARGE",
        () => TOO_LARGE,
      ],
      [
        "not gzip",
        async () => Buffer.from("not-a-bundle"),
        400,
        "BUNDLE_CORRUPT",
        () => NOT_READABLE("incorrect header check"),
      ],
      [
        "gzip, but not a tar",
        async () => gzipSync(Buffer.from("x".repeat(600))),
        400,
        "BUNDLE_CORRUPT",
        () => /^This bundle is not a readable \.agent archive — a gzip-compressed tar/,
      ],
      [
        "two entries that contradict each other",
        () =>
          packAgentTar([
            { name: "agent.yaml", content: Buffer.from(minimalAgentYaml("unloadable")) },
            { name: "scripts/run", content: Buffer.from("#!/bin/sh\n") },
            { name: "scripts/run/helper.py", content: Buffer.from("print(1)\n") },
          ]),
        400,
        "BUNDLE_CORRUPT",
        () =>
          `${UNWRITABLE}The entry "scripts/run/helper.py" needs "scripts/run" to be a directory, and the bundle makes it a file.`,
      ],
      [
        "a name over 255 bytes",
        () =>
          packAgentTar([
            { name: "agent.yaml", content: Buffer.from(minimalAgentYaml("unloadable")) },
            { name: `assets/${"n".repeat(256)}`, content: Buffer.from("x") },
          ]),
        400,
        "BUNDLE_CORRUPT",
        () =>
          `${UNWRITABLE}The entry "assets/${"n".repeat(53)}…" holds a name of 256 bytes between two "/"; a file system takes 255 at most.`,
      ],
      [
        "a character device",
        () =>
          rawBundle([
            { name: "agent.yaml", content: Buffer.from(minimalAgentYaml("unloadable")) },
            { name: "dev/null", type: "character-device" },
          ]),
        400,
        "BUNDLE_CORRUPT",
        () =>
          `${UNWRITABLE}The entry "dev/null" is a character device: tar cannot make one without privileges, and an agent's bundle is written out without them.`,
      ],
      [
        "a hard link to an entry placed after it",
        () =>
          rawBundle([
            { name: "agent.yaml", content: Buffer.from(minimalAgentYaml("unloadable")) },
            { name: "scripts/run.py", type: "link", linkname: "scripts/main.py" },
            { name: "scripts/main.py", content: Buffer.from("print(1)\n") },
          ]),
        400,
        "BUNDLE_CORRUPT",
        () =>
          `${UNWRITABLE}The entry "scripts/run.py" is a hard link to "scripts/main.py", and no file of that path comes before it in the bundle: tar cannot make the link.`,
      ],
      [
        "a path that climbs out, an agent.yaml absent too: judged first",
        () => packAgentTar([{ name: "../escape.txt", content: Buffer.from("leak") }]),
        400,
        "BUNDLE_CORRUPT",
        () =>
          `${UNWRITABLE}The entry "../escape.txt" climbs out of the bundle's directory: its path holds "..".`,
      ],
      [
        "no agent.yaml",
        () => packAgentTar([{ name: "SKILL.md", content: Buffer.from("# unloadable\n") }]),
        400,
        "MISSING_CONFIG",
        () => MISSING,
      ],
      [
        "an agent.yaml below the root",
        () =>
          packAgentTar([
            { name: "unloadable/agent.yaml", content: Buffer.from(minimalAgentYaml("unloadable")) },
          ]),
        400,
        "MISSING_CONFIG",
        () => MISSING,
      ],
      ["an empty agent.yaml", () => bundleOf(""), 400, "MISSING_CONFIG", () => MISSING],
      [
        "an agent.yaml that is not YAML",
        () => bundleOf("name: [unclosed"),
        400,
        "INVALID_CONFIG",
        () => /^agent\.yaml is not valid: YAML parse error: /,
      ],
      [
        "an agent.yaml that repeats a key",
        () => bundleOf(minimalAgentYaml("unloadable", ["name: again"])),
        400,
        "INVALID_CONFIG",
        () =>
          "agent.yaml is not valid: YAML parse error: Map keys must be unique at line 12, column 1:\n\n    type: string\nname: again\n^\n",
      ],
      [
        "an agent.yaml that declares %YAML 1.1",
        () => bundleOf(`%YAML 1.1\n---\n${minimalAgentYaml("unloadable")}`),
        400,
        "INVALID_CONFIG",
        () =>
          "agent.yaml is not valid: agent.yaml is read as YAML 1.2: the directive %YAML 1.1 is not accepted. Remove that line.",
      ],
      [
        "an agent.yaml that holds the tag !!omap",
        () => bundleOf(minimalAgentYaml("unloadable", OMAP_TOOL)),
        400,
        "INVALID_CONFIG",
        () =>
          "agent.yaml is not valid: The YAML tag !!omap is not accepted in agent.yaml. Remove it, and write the entries as a mapping.",
      ],
      [
        "an agent.yaml the schema refuses",
        () => bundleOf(SCHEMA_INVALID),
        400,
        "INVALID_CONFIG",
        () => `agent.yaml is not valid: ${issuesOf(SCHEMA_INVALID)}`,
      ],
    ];

    /** Every bound set, each tight enough to refuse any bundle that loads. */
    const TIGHT: PushLimits = { plan: "free", maxTimeoutS: 1, storageBytes: 1, master: true };

    describe.each([
      ["no bounds", undefined],
      ["the server's bounds", TIGHT],
    ] as const)("with %s", (_bounds, limits) => {
      it.each(
        CASES,
      )("%s: its status and code — no agent, no object, no version, the account's storage unchanged", async (_case, bundle, status, code, message) => {
        const writes = {
          createAgent: vi.spyOn(db, "createAgent"),
          createVersion: vi.spyOn(db, "createVersion"),
          put: vi.spyOn(storage, "put"),
        };
        const push = service.push(
          "acme",
          "unloadable",
          "1.0.0",
          await bundle(),
          "user-1",
          null,
          limits,
        );
        await expect(push).rejects.toBeInstanceOf(RegistryError);
        const expected = message();
        await expect(push).rejects.toMatchObject({
          code,
          status,
          message: typeof expected === "string" ? expected : expect.stringMatching(expected),
        });
        expect(await db.getAgent("acme", "unloadable")).toBeNull();
        expect(await storage.list("acme/")).toEqual([]);
        expect(await db.sumBundleBytesByOwner("user-1")).toBe(0);
        expect(writes.createAgent).not.toHaveBeenCalled();
        expect(writes.put).not.toHaveBeenCalled();
        expect(writes.createVersion).not.toHaveBeenCalled();
      });
    });

    it("an agent.yaml the schema refuses: the message names each issue", async () => {
      const refusal = await service
        .push("acme", "unloadable", "1.0.0", await bundleOf(SCHEMA_INVALID), "user-1")
        .then(
          () => null,
          (err: unknown) => err as RegistryError,
        );
      expect(refusal?.code).toBe("INVALID_CONFIG");
      for (const field of ["model", "inputs", "outputs"]) {
        expect(refusal?.message, field).toMatch(new RegExp(`(^|; |: )${field}: `));
      }
    });

    it("a new version of an existing agent that does not load: the agent keeps its one version, its one object, and the account its storage", async () => {
      await service.push("acme", "unloadable", "1.0.0", await validBundle("unloadable"), "user-1");
      const held = await db.sumBundleBytesByOwner("user-1");
      for (const bundle of [
        await bundleOf(minimalAgentYaml("unloadable"), true),
        Buffer.from("not-a-bundle"),
        await bundleOf("name: [unclosed"),
      ]) {
        await expect(
          service.push("acme", "unloadable", "1.1.0", bundle, "user-1"),
        ).rejects.toBeInstanceOf(RegistryError);
      }
      const agent = await db.getAgent("acme", "unloadable");
      expect((await db.getVersions(agent?.id ?? "")).map((v) => v.version)).toEqual(["1.0.0"]);
      expect(await storage.list("acme/")).toEqual(["acme/unloadable/1.0.0.agent"]);
      expect(await db.sumBundleBytesByOwner("user-1")).toBe(held);
    });

    it("a version already pushed, sent again in a bundle that does not load: refused for the bundle, not as a duplicate", async () => {
      await service.push("acme", "unloadable", "1.0.0", await validBundle("unloadable"), "user-1");
      await expect(
        service.push("acme", "unloadable", "1.0.0", Buffer.from("not-a-bundle"), "user-1"),
      ).rejects.toMatchObject({ code: "BUNDLE_CORRUPT", status: 400 });
    });

    it("past the cap, a bundle declaring a setting no code honours is refused for its size, never stored — once it loads, for the setting", async () => {
      const secrets = minimalAgentYaml("unloadable", ["environment:", "  secrets: [X]"]);
      await expect(
        service.push("acme", "unloadable", "1.0.0", await bundleOf(secrets, true), "user-1"),
      ).rejects.toMatchObject({ code: "BUNDLE_DECOMPRESSED_TOO_LARGE", status: 413 });
      expect(await storage.list("acme/")).toEqual([]);

      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "10";
      await expect(
        service.push("acme", "unloadable", "1.0.0", await bundleOf(secrets, true), "user-1"),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_FIELD", status: 400 });
      expect(await storage.list("acme/")).toEqual([]);
    });

    it("the cap is read at each push: raised past the bundle, the same bundle is stored, its configuration the version's snapshot", async () => {
      const bundle = await bundleOf(minimalAgentYaml("unloadable"), true);
      await expect(
        service.push("acme", "unloadable", "1.0.0", bundle, "user-1"),
      ).rejects.toMatchObject({ code: "BUNDLE_DECOMPRESSED_TOO_LARGE" });

      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "10";
      await service.push("acme", "unloadable", "1.0.0", bundle, "user-1");
      const agent = await db.getAgent("acme", "unloadable");
      const version = await db.getVersionByNumber(agent?.id ?? "", "1.0.0");
      expect(version?.config_snapshot).toMatchObject({ name: "unloadable" });
      expect(await storage.get("acme/unloadable/1.0.0.agent")).toEqual(bundle);
    });
  });

  // ── An agent.yaml past 128 KB is refused at push, judged on its bytes ──
  // agent.yaml holds the agent's configuration: a fixed limit, no setting.
  // Judged once the archive loads and agent.yaml is found, before the file is
  // read as text — so before it is parsed, and before anything is stored.
  describe("an agent.yaml past 128 KB is refused 413 CONFIG_TOO_LARGE, before it is parsed", () => {
    /** The limit: 128 KB. */
    const LIMIT = 128 * 1024;
    const previousCap = process.env.BUNDLE_MAX_DECOMPRESSED_MB;
    beforeEach(() => {
      delete process.env.BUNDLE_MAX_DECOMPRESSED_MB; // the default cap, 50 MB
    });
    afterEach(() => {
      if (previousCap === undefined) delete process.env.BUNDLE_MAX_DECOMPRESSED_MB;
      else process.env.BUNDLE_MAX_DECOMPRESSED_MB = previousCap;
    });

    const bundleOf = (agentYaml: string): Promise<Buffer> => validBundle("big", agentYaml);

    const tooLarge = (bytes: number): string =>
      `This bundle's agent.yaml is ${bytes.toLocaleString("en-US")} B, more than the 128 KB (131,072 B) an agent.yaml may weigh. agent.yaml holds the agent's configuration: put long content — instructions, context, data — in SKILL.md, AGENTS.md or other files of the bundle, and push it again.`;

    /** Push `agentYaml` as `acme/big@1.0.0`: its refusal, or null once stored. */
    async function refusalOf(agentYaml: string, limits?: PushLimits) {
      return service
        .push("acme", "big", "1.0.0", await bundleOf(agentYaml), "user-1", null, limits)
        .then(
          () => null,
          (err: unknown) => err as RegistryError,
        );
    }

    it("an agent.yaml of exactly 128 KB is stored, its configuration the version's snapshot", async () => {
      const yaml = agentYamlOfSize(LIMIT, minimalAgentYaml("big"));
      expect(Buffer.byteLength(yaml)).toBe(LIMIT);
      expect(await refusalOf(yaml)).toBeNull();
      const agent = await db.getAgent("acme", "big");
      const version = await db.getVersionByNumber(agent?.id ?? "", "1.0.0");
      expect(version?.config_snapshot).toMatchObject({ name: "big" });
    });

    const TIGHT: PushLimits = { plan: "free", maxTimeoutS: 1, storageBytes: 1, master: true };

    it.each([
      ["no bounds", undefined],
      ["the server's bounds", TIGHT],
    ] as const)("one byte more, with %s: 413 CONFIG_TOO_LARGE, its size and the limit — no agent, no object, no version", async (_bounds, limits) => {
      const writes = {
        createAgent: vi.spyOn(db, "createAgent"),
        createVersion: vi.spyOn(db, "createVersion"),
        put: vi.spyOn(storage, "put"),
      };
      const refusal = await refusalOf(agentYamlOfSize(LIMIT + 1, minimalAgentYaml("big")), limits);
      expect(refusal).toBeInstanceOf(RegistryError);
      expect(refusal).toMatchObject({
        code: "CONFIG_TOO_LARGE",
        status: 413,
        message: tooLarge(LIMIT + 1),
      });
      expect(await db.getAgent("acme", "big")).toBeNull();
      expect(await storage.list("acme/")).toEqual([]);
      expect(await db.sumBundleBytesByOwner("user-1")).toBe(0);
      expect(writes.createAgent).not.toHaveBeenCalled();
      expect(writes.put).not.toHaveBeenCalled();
      expect(writes.createVersion).not.toHaveBeenCalled();
    });

    it("judged on its bytes, not its characters: under 128 KB of characters, past it in UTF-8", async () => {
      const head = minimalAgentYaml("big");
      const start = Buffer.byteLength(`${head}\n# `);
      // The first size past 128 KB a two-byte character can pad to.
      const bytes = LIMIT + 1 + ((LIMIT + 1 - start) % 2);
      const yaml = agentYamlOfSize(bytes, head, "é");
      expect(yaml.length).toBeLessThan(LIMIT);
      expect(await refusalOf(yaml)).toMatchObject({
        code: "CONFIG_TOO_LARGE",
        message: tooLarge(bytes),
      });
    });

    it("never parsed: past 128 KB, an agent.yaml that is not YAML, or that declares a setting no code honours, is refused for its size", async () => {
      expect(await refusalOf(agentYamlOfSize(LIMIT + 1, "name: [unclosed"))).toMatchObject({
        code: "CONFIG_TOO_LARGE",
        status: 413,
      });
      const secrets = minimalAgentYaml("big", ["environment:", "  secrets: [X]"]);
      expect(await refusalOf(agentYamlOfSize(LIMIT + 1, secrets))).toMatchObject({
        code: "CONFIG_TOO_LARGE",
        status: 413,
      });
      // Under the limit, the same files are refused for what they hold.
      expect(await refusalOf("name: [unclosed")).toMatchObject({ code: "INVALID_CONFIG" });
      expect(await refusalOf(secrets)).toMatchObject({ code: "UNSUPPORTED_FIELD" });
    });

    it("after the decompression cap: a bundle past both is refused for its archive", async () => {
      process.env.BUNDLE_MAX_DECOMPRESSED_MB = "0.1"; // 104,857 bytes, under the file
      expect(await refusalOf(agentYamlOfSize(LIMIT + 1, minimalAgentYaml("big")))).toMatchObject({
        code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
        status: 413,
      });
    });
  });

  // ── A setting that no code honours is refused at push, whatever bounds it ──
  // What validation refuses by name, the push refuses too — before the server's
  // own bounds, the account's turn and the duplicate check, with or without
  // bounds: a bundle that did not come through the CLI is judged all the same.
  describe("a push carrying a setting that no code honours is refused, by name, before anything is stored", () => {
    // The exact words an author reads, as validation gives them.
    const AUTH =
      "mcp_servers[0].auth: api_key is not yet supported — no credential would be sent to the server. Remove the line: none, the default, is accepted.";
    const SECRETS =
      "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.";
    const META =
      "model.provider meta has no endpoint of its own: set model.base_url to the OpenAI-compatible endpoint that serves the model.";
    const META_FALLBACK =
      "model.fallback.provider meta cannot be served: a fallback model is called at its provider's own endpoint, and meta has none. Pick another provider for the fallback.";
    const TIMEOUT = (value: string) =>
      `environment.timeout "${value}" is outside the allowed range: a run's timeout is between 1s and 2147483s (about 24.8 days), e.g. "300s".`;

    const GOOGLE = ["  provider: google", "  name: gemini-2.5-flash"];
    const META_MODEL = ["  provider: meta", "  name: llama"];

    /** A bundle whose agent.yaml declares `model` as its model, then `rest`. */
    function bundleOf(model: string[], rest: string[] = []): Promise<Buffer> {
      const yaml = [
        "name: refused",
        "version: 1.0.0",
        "model:",
        ...model,
        "inputs:",
        "  - name: q",
        "    type: string",
        "outputs:",
        "  - name: answer",
        "    type: string",
        ...rest,
      ].join("\n");
      return packAgentTar([
        { name: "agent.yaml", content: Buffer.from(yaml) },
        { name: "SKILL.md", content: Buffer.from("# refused\n") },
      ]);
    }

    /** The server's longest timeout and a storage bound, as a bounded server reads them. */
    const BOUNDED: PushLimits = {
      plan: "free",
      maxTimeoutS: 900,
      storageBytes: 100 * 1024 * 1024,
      master: true,
    };

    const REFUSED = [
      [
        "an MCP server's auth other than none",
        () =>
          bundleOf(GOOGLE, [
            "mcp_servers:",
            "  - name: search",
            "    url: https://mcp.example.com/sse",
            "    auth: api_key",
          ]),
        "UNSUPPORTED_FIELD",
        AUTH,
      ],
      [
        "a secrets list that names a secret",
        () => bundleOf(GOOGLE, ["environment:", "  secrets: [X]"]),
        "UNSUPPORTED_FIELD",
        SECRETS,
      ],
      ["meta without a base_url", () => bundleOf(META_MODEL), "MODEL_BASE_URL_REQUIRED", META],
      [
        "a meta fallback",
        () => bundleOf([...GOOGLE, "  fallback:", "    provider: meta", "    name: llama"]),
        "MODEL_BASE_URL_REQUIRED",
        META_FALLBACK,
      ],
      [
        "a timeout of 0s",
        () => bundleOf(GOOGLE, ["environment:", "  timeout: 0s"]),
        "TIMEOUT_OUT_OF_RANGE",
        TIMEOUT("0s"),
      ],
      [
        "a timeout past the longest timer",
        () => bundleOf(GOOGLE, ["environment:", "  timeout: 2147484s"]),
        "TIMEOUT_OUT_OF_RANGE",
        TIMEOUT("2147484s"),
      ],
    ] as const;

    describe.each([
      ["no bounds", undefined],
      ["the server's bounds", BOUNDED],
    ] as const)("with %s", (_bounds, limits) => {
      it.each(
        REFUSED,
      )("%s: 400 of its code and its message — no agent, no object, no version", async (_case, bundle, code, message) => {
        const writes = {
          createAgent: vi.spyOn(db, "createAgent"),
          createVersion: vi.spyOn(db, "createVersion"),
          put: vi.spyOn(storage, "put"),
        };
        const push = service.push(
          "acme",
          "refused",
          "1.0.0",
          await bundle(),
          "user-1",
          null,
          limits,
        );
        await expect(push).rejects.toBeInstanceOf(RegistryError);
        await expect(push).rejects.toMatchObject({ code, status: 400, message });
        expect(await db.getAgent("acme", "refused")).toBeNull();
        expect(await storage.list("acme/")).toEqual([]);
        expect(writes.createAgent).not.toHaveBeenCalled();
        expect(writes.put).not.toHaveBeenCalled();
        expect(writes.createVersion).not.toHaveBeenCalled();
      });

      it("a new version of an existing agent carrying one: refused, the agent keeps its one version and its one object", async () => {
        await service.push(
          "acme",
          "refused",
          "1.0.0",
          await bundleOf(GOOGLE),
          "user-1",
          null,
          limits,
        );
        const push = service.push(
          "acme",
          "refused",
          "1.1.0",
          await bundleOf(GOOGLE, ["environment:", "  secrets: [X]"]),
          "user-1",
          null,
          limits,
        );
        await expect(push).rejects.toMatchObject({ code: "UNSUPPORTED_FIELD", status: 400 });
        const agent = await db.getAgent("acme", "refused");
        expect((await db.getVersions(agent?.id ?? "")).map((v) => v.version)).toEqual(["1.0.0"]);
        expect(await storage.list("acme/")).toEqual(["acme/refused/1.0.0.agent"]);
      });

      it("a version already pushed, sent again carrying one: refused for the setting, not as a duplicate", async () => {
        await service.push(
          "acme",
          "refused",
          "1.0.0",
          await bundleOf(GOOGLE),
          "user-1",
          null,
          limits,
        );
        await expect(
          service.push(
            "acme",
            "refused",
            "1.0.0",
            await bundleOf(GOOGLE, ["environment:", "  timeout: 0s"]),
            "user-1",
            null,
            limits,
          ),
        ).rejects.toMatchObject({ code: "TIMEOUT_OUT_OF_RANGE", status: 400 });
      });

      it("several of them: one 400, the code of the first, every message in order, joined by a space", async () => {
        const bundle = await bundleOf(META_MODEL, [
          "mcp_servers:",
          "  - name: search",
          "    url: https://mcp.example.com/sse",
          "    auth: api_key",
          "environment:",
          "  secrets: [X]",
          "  timeout: 0s",
        ]);
        await expect(
          service.push("acme", "refused", "1.0.0", bundle, "user-1", null, limits),
        ).rejects.toMatchObject({
          code: "MODEL_BASE_URL_REQUIRED",
          status: 400,
          message: [META, AUTH, SECRETS, TIMEOUT("0s")].join(" "),
        });
        expect(await db.getAgent("acme", "refused")).toBeNull();
      });

      it("an empty secrets list, an MCP server's auth written none and meta at a base_url are stored", async () => {
        const meta = await service.push(
          "acme",
          "honoured",
          "1.0.0",
          await bundleOf(
            ["  provider: meta", "  name: llama", "  base_url: http://localhost:8080/v1"],
            [
              "mcp_servers:",
              "  - name: search",
              "    url: https://mcp.example.com/sse",
              "    auth: none",
              "environment:",
              "  secrets: []",
              "  timeout: 300s",
            ],
          ),
          "user-1",
          null,
          limits,
        );
        expect(meta.latest_version).toBe("1.0.0");
      });
    });

    it("a timeout past the range on a server whose maximum is lower: refused for the range, never for the server's maximum", async () => {
      await expect(
        service.push(
          "acme",
          "refused",
          "1.0.0",
          await bundleOf(GOOGLE, ["environment:", "  timeout: 3000000s"]),
          "user-1",
          null,
          BOUNDED,
        ),
      ).rejects.toMatchObject({
        code: "TIMEOUT_OUT_OF_RANGE",
        status: 400,
        message: TIMEOUT("3000000s"),
      });
      expect(await db.getAgent("acme", "refused")).toBeNull();
    });
  });

  // ── An account's pushes go one at a time, whatever bounds them ──
  describe("an account's pushes go one at a time", () => {
    const KIB = 1024;
    const MIB = 1024 * KIB;
    const BOUNDED: PushLimits = {
      plan: "free",
      maxTimeoutS: null,
      storageBytes: MIB,
      master: true,
    };

    /**
     * Every write of a key that starts with `prefix` waits for `open()`;
     * `held` settles once one waits. Other keys are written at once.
     */
    function holdPuts(prefix: string) {
      const put = storage.put.bind(storage);
      let open: () => void = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      let entered: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(storage, "put").mockImplementation(async (key, data, opts) => {
        if (key.startsWith(prefix)) {
          entered();
          await opened;
        }
        return put(key, data, opts);
      });
      return { open, held };
    }

    /** What `promise` settles to, or "still waiting" when it has not within `ms`. */
    async function within<T>(promise: Promise<T>, ms: number): Promise<T | "still waiting"> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), ms);
      });
      try {
        return await Promise.race([promise, late]);
      } finally {
        clearTimeout(timer);
      }
    }

    const stored = () => "stored";
    const refusal = (err: RegistryError) => `${err.status} ${err.code}`;

    it("five pushes of one account at once, against a storage with room for one: one is stored, four are refused 413, and nothing of theirs is left", async () => {
      const sum = vi.spyOn(db, "sumBundleBytesByOwner");
      // Each write waits until the five have read what the account holds, or a
      // moment: pushes not taken one at a time would all have read 0 by then.
      const put = storage.put.bind(storage);
      vi.spyOn(storage, "put").mockImplementation(async (key, data, opts) => {
        const until = Date.now() + 200;
        while (sum.mock.calls.length < 5 && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return put(key, data, opts);
      });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          service
            .push("acme", `agent-${i}`, "1.0.0", sized(600 * KIB), "user-1", null, BOUNDED)
            .then(stored, refusal),
        ),
      );

      expect(outcomes.sort()).toEqual([
        "413 STORAGE_QUOTA_EXCEEDED",
        "413 STORAGE_QUOTA_EXCEEDED",
        "413 STORAGE_QUOTA_EXCEEDED",
        "413 STORAGE_QUOTA_EXCEEDED",
        "stored",
      ]);
      expect(await storage.list("acme/")).toHaveLength(1);
      expect(await db.sumBundleBytesByOwner("user-1")).toBe(600 * KIB);
      const agents = await Promise.all(
        Array.from({ length: 5 }, (_, i) => db.getAgent("acme", `agent-${i}`)),
      );
      expect(agents.filter((agent) => agent !== null)).toHaveLength(1);
    });

    it("the account's second push waits while its first is storing, and goes on once it is", async () => {
      const hold = holdPuts("acme/first/");
      const first = service.push("acme", "first", "1.0.0", sized(KIB), "user-1", null, BOUNDED);
      await hold.held;
      const second = service
        .push("acme", "second", "1.0.0", sized(KIB), "user-1", null, BOUNDED)
        .then(stored, refusal);
      expect(await within(second, 100)).toBe("still waiting");

      hold.open();
      await first;
      expect(await within(second, 2000)).toBe("stored");
    });

    it("an account's push does not wait for another account's, into its own namespace", async () => {
      const hold = holdPuts("acme/");
      const first = service.push("acme", "held", "1.0.0", sized(KIB), "user-1", null, BOUNDED);
      await hold.held;

      const other = service
        .push("other", "free", "1.0.0", sized(KIB), "user-2", null, BOUNDED)
        .then(stored, refusal);
      expect(await within(other, 2000)).toBe("stored");

      hold.open();
      await first;
    });

    it("a push waiting its turn goes on once the push before it is refused, fails, or is stored", async () => {
      await service.push("acme", "taken", "1.0.0", sized(KIB), "user-1", null, BOUNDED);
      // A first push holds the turn while its write waits; the push under test
      // queues behind it, and a last one behind that.
      const realPut = MemoryStorage.prototype.put.bind(storage);
      let gate: Promise<void> = Promise.resolve();
      let entered: () => void = () => {};
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, data, opts) => {
        if (key.startsWith("acme/holder-")) {
          entered();
          await gate;
        }
        return realPut(key, data, opts);
      });
      const push = (name: string, bytes: number) =>
        service.push("acme", name, "1.0.0", sized(bytes), "user-1", null, BOUNDED);

      const cases: Array<[string, () => Promise<unknown>, string]> = [
        ["refused for the storage", () => push("big", MIB + 1), "413 STORAGE_QUOTA_EXCEEDED"],
        ["refused for its version", () => push("taken", KIB), "409 VERSION_EXISTS"],
        [
          "failed in the store",
          () => {
            put.mockRejectedValueOnce(new Error("the store is down"));
            return push("broken", KIB);
          },
          "failed",
        ],
        ["stored", () => push("plain", KIB), "stored"],
      ];
      for (const [i, [label, before, outcome]] of cases.entries()) {
        let open: () => void = () => {};
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const held = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const holder = push(`holder-${i}`, KIB);
        await held;
        const tested = before().then(stored, (err: unknown) =>
          err instanceof RegistryError ? refusal(err) : "failed",
        );
        // Long enough for the push under test to queue before the last one.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const last = push(`after-${i}`, KIB).then(stored, refusal);

        open();
        await holder;
        expect([label, await tested]).toEqual([label, outcome]);
        expect([label, await within(last, 2000)]).toEqual([label, "stored"]);
      }
    });

    const unbounded: Array<[string, PushLimits | undefined]> = [
      ["no storage bound", { ...BOUNDED, storageBytes: null, maxTimeoutS: 900 }],
      ["no bound given", undefined],
    ];

    it.each(
      unbounded,
    )("with %s too, the account's second push waits while its first is storing, and goes on once it is", async (_label, limits) => {
      const hold = holdPuts("acme/first/");
      const first = service.push("acme", "first", "1.0.0", sized(KIB), "user-1", null, limits);
      await hold.held;
      const second = service
        .push("acme", "second", "1.0.0", sized(KIB), "user-1", null, limits)
        .then(stored, refusal);
      expect(await within(second, 100)).toBe("still waiting");

      hold.open();
      await first;
      expect(await within(second, 2000)).toBe("stored");
    });

    it("an agent declaring more than the longest timeout is refused at once while another push of its account is storing; a version already pushed waits its turn", async () => {
      await service.push("acme", "taken", "1.0.0", sized(KIB), "user-1", null, BOUNDED);
      const limits: PushLimits = { ...BOUNDED, maxTimeoutS: 900 };
      const hold = holdPuts("acme/first/");
      const first = service.push("acme", "first", "1.0.0", sized(KIB), "user-1", null, limits);
      await hold.held;

      const tooLong = service
        .push("acme", "slow", "1.0.0", await agentBundle("1800s"), "user-1", null, limits)
        .then(stored, refusal);
      const duplicate = service
        .push("acme", "taken", "1.0.0", sized(KIB), "user-1", null, limits)
        .then(stored, refusal);
      expect(await within(tooLong, 100)).toBe("400 TIMEOUT_ABOVE_LIMIT");
      expect(await within(duplicate, 100)).toBe("still waiting");

      hold.open();
      await first;
      expect(await within(duplicate, 2000)).toBe("409 VERSION_EXISTS");
      expect(await db.getAgent("acme", "slow")).toBeNull();
    });
  });
});

describe("AccountTurns", () => {
  it("keeps one entry per key while a step of it runs or waits, and none once every step has settled", async () => {
    const turns = new AccountTurns();
    let finish: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = turns.run("a", () => running);
    const second = turns.run("a", async () => "second");
    const failing = turns.run("b", async () => {
      throw new Error("refused");
    });
    expect(turns.size).toBe(2);

    await expect(failing).rejects.toThrow("refused");
    expect(turns.size).toBe(1);

    finish();
    await first;
    expect(await second).toBe("second");
    expect(turns.size).toBe(0);
  });

  it("hands the turn to the next step when a step throws, as when it returns", async () => {
    const turns = new AccountTurns();
    let fail: () => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const failing = turns.run(
      "a",
      () =>
        new Promise<never>((_, reject) => {
          fail = () => reject(new Error("refused"));
          started();
        }),
    );
    const next = turns.run("a", async () => "next");
    await running;
    fail();
    await expect(failing).rejects.toThrow("refused");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("still waiting"), 2000);
    });
    expect(await Promise.race([next, late])).toBe("next");
    clearTimeout(timer);
  });
});
