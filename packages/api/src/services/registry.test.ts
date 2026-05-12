import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { MemoryDb } from "../db/memory.js";
import { MemoryStorage } from "../storage/memory.js";
import { RegistryError, RegistryService } from "./registry.js";

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
    const bundle = Buffer.from("fake-agent-bundle");
    await service.push("acme", "seo-audit", "1.0.0", bundle, "user-1");

    const result = await service.pull("acme", "seo-audit");
    expect(result.buffer).toEqual(bundle);
    expect(result.version).toBe("1.0.0");
  });

  it("should push multiple versions", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "user-1");
    await service.push("acme", "agent", "1.1.0", Buffer.from("v2"), "user-1");

    const latest = await service.pull("acme", "agent");
    expect(latest.version).toBe("1.1.0");
    expect(latest.buffer.toString()).toBe("v2");

    const v1 = await service.pull("acme", "agent", "1.0.0");
    expect(v1.buffer.toString()).toBe("v1");
  });

  it("should reject duplicate version", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "user-1");
    await expect(
      service.push("acme", "agent", "1.0.0", Buffer.from("v2"), "user-1"),
    ).rejects.toThrow(RegistryError);
    await expect(
      service.push("acme", "agent", "1.0.0", Buffer.from("v2"), "user-1"),
    ).rejects.toThrow("already exists");
  });

  it("should throw 404 on pull for non-existent agent", async () => {
    await expect(service.pull("x", "y")).rejects.toThrow(RegistryError);
  });

  it("should throw 404 on pull for non-existent version", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "user-1");
    await expect(service.pull("acme", "agent", "9.9.9")).rejects.toThrow("not found");
  });

  it("should list agents with pagination", async () => {
    await service.push("ns", "a", "1.0.0", Buffer.from("a"), "u");
    await service.push("ns", "b", "1.0.0", Buffer.from("b"), "u");
    await service.push("ns", "c", "1.0.0", Buffer.from("c"), "u");

    const page1 = await service.list(1, 2);
    expect(page1.agents).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await service.list(2, 2);
    expect(page2.agents).toHaveLength(1);
  });

  it("should get metadata", async () => {
    await service.push("acme", "seo-audit", "1.0.0", Buffer.from("v1"), "user-1");
    const meta = await service.getMetadata("acme", "seo-audit");
    expect(meta.name).toBe("seo-audit");
    expect(meta.namespace).toBe("acme");
    expect(meta.latest_version).toBe("1.0.0");
    expect(meta.versions).toEqual(["1.0.0"]);
  });

  it("should get versions list", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "user-1");
    await service.push("acme", "agent", "2.0.0", Buffer.from("v2"), "user-1");

    const versions = await service.getVersions("acme", "agent");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe("1.0.0");
    expect(versions[1].version).toBe("2.0.0");
  });

  it("should store bundle in storage with correct key", async () => {
    const bundle = Buffer.from("test");
    await service.push("acme", "seo", "1.0.0", bundle, "u");
    expect(await storage.exists("acme/seo/1.0.0.agent")).toBe(true);
  });

  it("should propagate notes from push to the stored version", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "u", "Added retry logic");
    const versions = await service.getVersions("acme", "agent");
    expect(versions[0].notes).toBe("Added retry logic");
  });

  it("should default notes to null when absent", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "u");
    const versions = await service.getVersions("acme", "agent");
    expect(versions[0].notes).toBeNull();
  });

  // ── deleteVersion (#77) ──────────────────────────────────────────────

  describe("deleteVersion (#77)", () => {
    // VT-7 LAST_VERSION
    it("throws 409 LAST_VERSION when deleting the only remaining version", async () => {
      await service.push("dev", "foo", "1.0.0", Buffer.from("v1"), "u");

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
      await service.push("dev", "foo", "1.0.0", Buffer.from("v1"), "u");
      await service.push("dev", "foo", "2.0.0", Buffer.from("v2"), "u");

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
      await service.push("dev", "foo", "1.0.0", Buffer.from("v1"), "u");
      await service.push("dev", "foo", "9.9.999", Buffer.from("v2"), "u");
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

    // VT-10 bundleCache eviction
    it("evicts the bundleCache entry for the deleted version", async () => {
      await service.push("dev", "foo", "1.0.0", Buffer.from("v1"), "u");
      await service.push("dev", "foo", "2.0.0", Buffer.from("v2"), "u");

      // Pre-populate cache as if a pull just extracted this version
      bundleCache.set("dev/foo/1.0.0", { dir: "/tmp/skrun-test-vt10", files: {} });
      expect(bundleCache.get("dev/foo/1.0.0")).toBeDefined();

      await service.deleteVersion("dev", "foo", "1.0.0");

      expect(bundleCache.get("dev/foo/1.0.0")).toBeUndefined();
    });

    // VT-11 getMetadata returns new latest after delete
    it("getMetadata returns the new latest version after deleting the previous latest", async () => {
      await service.push("dev", "foo", "1.0.0", Buffer.from("v1"), "u");
      await service.push("dev", "foo", "2.0.0", Buffer.from("v2"), "u");

      const before = await service.getMetadata("dev", "foo");
      expect(before.latest_version).toBe("2.0.0");

      await service.deleteVersion("dev", "foo", "2.0.0");

      const after = await service.getMetadata("dev", "foo");
      expect(after.latest_version).toBe("1.0.0");
    });

    // VT-12 failure-mode order (storage throws, db delete still happens)
    it("storage delete failure is swallowed but DB row still removed (storage-before-db order)", async () => {
      await service.push("dev", "foo", "1.0.0", Buffer.from("v1"), "u");
      await service.push("dev", "foo", "2.0.0", Buffer.from("v2"), "u");

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

    // Bonus B-4: deleteAgent evicts bundleCache for all versions
    it("deleteAgent evicts the bundleCache for all versions of the agent (closes Q-10 asymmetry)", async () => {
      await service.push("dev", "multi", "1.0.0", Buffer.from("v1"), "u");
      await service.push("dev", "multi", "2.0.0", Buffer.from("v2"), "u");

      bundleCache.set("dev/multi/1.0.0", { dir: "/tmp/skrun-test-b4-1", files: {} });
      bundleCache.set("dev/multi/2.0.0", { dir: "/tmp/skrun-test-b4-2", files: {} });
      expect(bundleCache.get("dev/multi/1.0.0")).toBeDefined();
      expect(bundleCache.get("dev/multi/2.0.0")).toBeDefined();

      await service.deleteAgent("dev", "multi");

      expect(bundleCache.get("dev/multi/1.0.0")).toBeUndefined();
      expect(bundleCache.get("dev/multi/2.0.0")).toBeUndefined();
    });
  });
});
