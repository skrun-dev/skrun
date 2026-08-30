import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryDb } from "../../packages/api/src/db/memory.js";
import type { createApp } from "../../packages/api/src/index.js";
import { createTestApp, pushAgent, runAgent, seedUserKey } from "./setup.js";

describe("E2E: agent visibility + run-authorization (#81)", () => {
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;

  beforeEach(() => {
    ({ app, db } = createTestApp());
  });

  it("private-by-default: owner runs, stranger 404; public: stranger runs; env-override gated", async () => {
    const alice = await seedUserKey(db, "alice");
    const bob = await seedUserKey(db, "bob");

    // Alice pushes + verifies her agent (private by default).
    await pushAgent(app, { ns: "alice", name: "a1", token: alice.key });
    await db.setVersionVerified("alice", "a1", "1.0.0", true);

    // Owner runs her own private agent → past run-auth.
    const ownerRun = await runAgent(app, { ns: "alice", name: "a1", token: alice.key });
    expect(ownerRun.status).not.toBe(404);

    // Stranger runs the private agent → opaque 404.
    const strangerRun = await runAgent(app, { ns: "alice", name: "a1", token: bob.key });
    expect(strangerRun.status).toBe(404);

    // The public set-path is disabled (private-only hosting), so flip via the
    // DB layer — this exercises the dormant run-auth public branch without the
    // (now-rejected) HTTP toggle.
    await db.setVisibility("alice", "a1", "public");

    // Stranger runs the now-public agent → past run-auth.
    const strangerPublic = await runAgent(app, { ns: "alice", name: "a1", token: bob.key });
    expect(strangerPublic.status).not.toBe(404);

    // Stranger supplies an environment override on the public agent → 403.
    const envOverride = await app.request("/api/agents/alice/a1/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${bob.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: {},
        environment: { networking: { allowed_hosts: ["evil.example.com"] } },
      }),
    });
    expect(envOverride.status).toBe(403);
    expect(((await envOverride.json()) as { error: { code: string } }).error.code).toBe(
      "ENV_OVERRIDE_FORBIDDEN",
    );
  });
});
