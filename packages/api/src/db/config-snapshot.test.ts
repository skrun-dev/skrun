// RT-7 — `agent_versions.config_snapshot` is informational only. Existing
// rows from before #84 retain the legacy `<ns>/<slug>` form for the `name`
// field inside the snapshot; new rows carry slug-only names. No code path
// in the registry / run flow re-parses `config_snapshot.name` to derive
// identity (agent identity comes from the registry row's separate
// `namespace` + `name` columns + the run URL).
//
// This test pins the invariant: a legacy-form snapshot stored in the DB is
// returned verbatim by `getVersions()` without throwing or being normalized.

import { describe, expect, it } from "vitest";
import { MemoryDb } from "./memory.js";

describe("RT-7 config_snapshot is informational-only", () => {
  it("RT-7a: legacy <ns>/<slug> form in config_snapshot.name is preserved verbatim", async () => {
    const db = new MemoryDb();
    const agent = await db.createAgent({
      namespace: "tarcroi",
      name: "email-drafter",
      description: "",
      owner_id: "u-1",
    });
    // Simulate a pre-#84 push: the bundle's internal yaml carried the legacy
    // <namespace>/<slug> form, and the registry stored that verbatim in the
    // snapshot. The registry row itself (above) was already correctly
    // (namespace, name) split because the DB layer takes them separately.
    const legacySnapshot = {
      name: "dev/email-drafter",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      inputs: [{ name: "q", type: "string", required: true }],
      outputs: [{ name: "r", type: "string" }],
    };
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 1024,
      bundle_key: "tarcroi/email-drafter/1.0.0.agent",
      config_snapshot: legacySnapshot,
    });

    const versions = await db.getVersions(agent.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].config_snapshot).toEqual(legacySnapshot);
    // Specifically, the `name` field retains the legacy <ns>/<slug> form.
    // The snapshot is informational; no identity decision is made from it.
    expect((versions[0].config_snapshot as { name: string }).name).toBe("dev/email-drafter");
  });

  it("RT-7b: slug-only form in config_snapshot.name is also accepted (new pushes)", async () => {
    const db = new MemoryDb();
    const agent = await db.createAgent({
      namespace: "tarcroi",
      name: "email-drafter",
      description: "",
      owner_id: "u-1",
    });
    const newSnapshot = {
      name: "email-drafter",
      version: "2.0.0",
      model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
      inputs: [{ name: "q", type: "string", required: true }],
      outputs: [{ name: "r", type: "string" }],
    };
    await db.createVersion(agent.id, {
      version: "2.0.0",
      size: 1024,
      bundle_key: "tarcroi/email-drafter/2.0.0.agent",
      config_snapshot: newSnapshot,
    });

    const versions = await db.getVersions(agent.id);
    expect(versions[0].config_snapshot).toEqual(newSnapshot);
    expect((versions[0].config_snapshot as { name: string }).name).toBe("email-drafter");
  });

  it("RT-7c: agent identity is derived from (namespace, name) columns, NOT from config_snapshot.name", async () => {
    const db = new MemoryDb();
    const agent = await db.createAgent({
      namespace: "tarcroi",
      name: "email-drafter",
      description: "",
      owner_id: "u-1",
    });
    await db.createVersion(agent.id, {
      version: "1.0.0",
      size: 1024,
      bundle_key: "tarcroi/email-drafter/1.0.0.agent",
      // Deliberately mismatched: snapshot says one thing, registry row says another.
      // The registry row wins for identity; the snapshot is just a historical
      // record of the bundle's internal yaml at push time.
      config_snapshot: { name: "completely/different-slug", version: "1.0.0" },
    });

    // Looking up by the REGISTRY identity works.
    const found = await db.getAgent("tarcroi", "email-drafter");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(agent.id);

    // Looking up by the SNAPSHOT identity does NOT (and should not) work.
    const ghost = await db.getAgent("completely", "different-slug");
    expect(ghost).toBeNull();
  });
});
