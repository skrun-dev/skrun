import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../storage/memory.js";
import { backfillBundleHashes } from "./backfill-bundle-hashes.js";
import { MemoryDb } from "./memory.js";

describe("backfillBundleHashes (SEC-020)", () => {
  it("VT-13: populates present bundles, skips missing, is idempotent", async () => {
    const db = new MemoryDb();
    const storage = new MemoryStorage();
    const agent = await db.createAgent({
      name: "a",
      namespace: "ns",
      description: "",
      owner_id: "u",
    });

    // v1: bundle present in storage, no hash yet → should be backfilled.
    const b1 = Buffer.from("bundle-one");
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: b1.length,
      bundle_key: "ns/a/1.0.0.agent",
    });
    await storage.put("ns/a/1.0.0.agent", b1);

    // v2: row exists, bundle MISSING from storage → skipped, no throw.
    await db.createVersion(agent.id, {
      version: "2.0.0",
      size: 5,
      bundle_key: "ns/a/2.0.0.agent",
    });

    // v3: already hashed → must be ignored by listVersionsMissingHash.
    await db.createVersion(agent.id, {
      version: "3.0.0",
      size: 3,
      bundle_key: "ns/a/3.0.0.agent",
      bundle_sha256: "c".repeat(64),
    });

    const r1 = await backfillBundleHashes(db, storage);
    expect(r1.scanned).toBe(2); // v1 + v2 (v3 already hashed)
    expect(r1.hashed).toBe(1); // v1
    expect(r1.missing).toBe(1); // v2

    const v1 = await db.getVersionByNumber(agent.id, "1.0.0");
    expect(v1?.bundle_sha256).toBe(createHash("sha256").update(b1).digest("hex"));
    const v2 = await db.getVersionByNumber(agent.id, "2.0.0");
    expect(v2?.bundle_sha256).toBeNull(); // still null (bundle was missing)

    // Idempotent: a second run only re-sees v2 (still null) → 0 hashed, no error.
    const r2 = await backfillBundleHashes(db, storage);
    expect(r2.scanned).toBe(1);
    expect(r2.hashed).toBe(0);
    expect(r2.missing).toBe(1);
  });
});
