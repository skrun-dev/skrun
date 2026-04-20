import { beforeEach, describe, expect, it } from "vitest";
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

  it("should overwrite duplicate version when forced", async () => {
    await service.push("acme", "agent", "1.0.0", Buffer.from("v1"), "user-1");
    await service.push("acme", "agent", "1.0.0", Buffer.from("v2"), "user-1", true);

    const pulled = await service.pull("acme", "agent", "1.0.0");
    expect(pulled.buffer.toString()).toBe("v2");

    const versions = await service.getVersions("acme", "agent");
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("1.0.0");
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
});
