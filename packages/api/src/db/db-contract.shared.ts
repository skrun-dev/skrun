/**
 * Shared DbAdapter contract test — single source of truth for behavioral
 * contract across all `DbAdapter` implementations (MemoryDb, SqliteDb,
 * PostgresDb). Each backend test file calls this function with its factory.
 *
 * Created for the Postgres-agnostic DbAdapter work. Mandated
 * by the spec: zero inline assertions duplicating this contract.
 * Backend-specific tests (e.g., SqliteDb FK cascade, SqliteDb migrations,
 * PostgresDb advisory lock) live in their own files, NOT here.
 *
 * Factory contract — `makeDb()` returns a fresh DbAdapter instance with
 * empty tables BUT with the fixture user rows (`fixtureUsers()`) pre-seeded.
 * SqliteDb / PostgresDb enforce FK and need this; MemoryDb refuses a run
 * naming an account it does not hold, and needs it too.
 *
 * UUID-safety: Postgres uuid columns (users.id,
 * agents.owner_id, runs.id, runs.user_id, api_keys.id, environments.owner_id)
 * reject arbitrary strings — so EVERY identifier the contract passes to a uuid
 * column must be a real uuid, including the intentionally-absent ones (the
 * "missing" lookups would otherwise throw `invalid input syntax for type uuid`
 * instead of returning null). `fx(label)` maps a stable label → a stable uuid
 * (create + read agree). Text columns (namespace, name, github_id, key_hash,
 * agent_version, state keys, env names) stay plain strings. This is why the
 * PostgresDb contract never ran green before this (literal `owner_id:"u"` +
 * string run ids errored against uuid columns).
 *
 * Each test gets its own DB via `beforeEach` so tests are isolated.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "@skrun-dev/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeRun, truncateRunContent } from "../routes/_helpers.js";
import { validBundle } from "../routes/agent-bundle.shared.js";
import { type PushLimits, RegistryError, RegistryService } from "../services/registry.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  type AdmissionLimits,
  type AdmittedRunData,
  type DbAdapter,
  FAST_RUN_WINDOW_MS,
  type RunAdmissionResult,
  SHUTDOWN_RUN_ERROR,
} from "./adapter.js";
import { MissingRunReferenceError, type RunReference } from "./reference-errors.js";
import { isMissingStateReference } from "./state-errors.js";

const _fxCache = new Map<string, string>();
/** Stable label → stable uuid, so create + read of the same label agree. */
export function fx(label: string): string {
  let u = _fxCache.get(label);
  if (!u) {
    u = randomUUID();
    _fxCache.set(label, u);
  }
  return u;
}

/**
 * Whether `err` is the refusal each backend makes of a run naming what does
 * not exist: its foreign key, or the in-memory error for that reference.
 */
function isRunReferenceRefusal(err: unknown, reference: RunReference): boolean {
  if (err instanceof MissingRunReferenceError) return err.reference === reference;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  return code === "23503" || code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

/** The run references a case can name as missing, each with the field that names it. */
const MISSING_RUN_REFERENCES: Array<[RunReference, Partial<AdmittedRunData>]> = [
  ["account", { user_id: fx("no-such-account") }],
  ["agent", { agent_id: fx("no-such-agent") }],
  ["key", { api_key_id: fx("no-such-key") }],
];

/** User labels the contract references as FK parents — seeded by each factory. */
export const FIXTURE_USER_LABELS = ["u", "user-1", "user-A", "user-B", "u1", "u2"] as const;

/** Fixture user rows (uuid id + unique github_id/username) for factory seeding. */
export function fixtureUsers(): Array<{ id: string; github_id: string; username: string }> {
  return FIXTURE_USER_LABELS.map((l) => ({
    id: fx(l),
    github_id: `gh-fixture-${l}`,
    username: `fixture-${l}`,
  }));
}

/**
 * What a case needs from a backend that the interface does not offer. Each
 * backend test file supplies it the backend's own way: raw SQL on the SQL
 * backends, the stored row in memory.
 */
export interface DbContractHooks {
  /**
   * Set a run's cleared mark, as only an account deletion writes it — never
   * through `updateRun`, which does not take the field.
   */
  setRunContentCleared(db: DbAdapter, runId: string, at: string): Promise<void>;
  /**
   * The number of rows of each table of `DELETION_COUNTED_TABLES`, read the
   * backend's own way: what an account deletion may remove and never add to.
   */
  countRows(db: DbAdapter): Promise<Record<string, number>>;
  /** Whether the backend refuses two accounts with the same username (Postgres). */
  usernameIsUnique: boolean;
  /** What the run admission cases need from the backend. */
  admission: {
    /**
     * Set a finished run's charged time, as only its final write will — never
     * through `updateRun`, which does not take the field.
     */
    setRunChargedMs(db: DbAdapter, runId: string, chargedMs: number): Promise<void>;
    /**
     * Gather the planner's statistics on `runs`, as a store in service has
     * them — Postgres's autovacuum gathers them, an operator's `ANALYZE` on a
     * SQLite file too. Without them, a fresh table's few rows are read through
     * the `(user_id, created_at)` index, in creation order whether the query
     * asks for that order or not; with them, a small table is scanned, in the
     * order its rows are kept. Memory has no planner.
     */
    analyzeRuns(db: DbAdapter): Promise<void>;
  };
}

/** Every table an account's rows live in, or that a deletion could write to. */
export const DELETION_COUNTED_TABLES = [
  "users",
  "api_keys",
  "api_key_agents",
  "agents",
  "agent_versions",
  "agent_llm_keys",
  "agent_state",
  "environments",
  "device_codes",
  "sessions",
  "runs",
] as const;

export function runDbContractTests(
  label: string,
  makeDb: () => Promise<DbAdapter>,
  hooks: DbContractHooks,
): void {
  describe(`DbAdapter contract: ${label}`, () => {
    let db: DbAdapter;
    beforeEach(async () => {
      db = await makeDb();
    });

    // ── Agents ──────────────────────────────────────────────────────────

    describe("agents", () => {
      it("creates and gets an agent", async () => {
        const agent = await db.createAgent({
          name: "seo-audit",
          namespace: "acme",
          description: "SEO audit agent",
          owner_id: fx("user-1"),
        });
        expect(agent.id).toBeTruthy();
        expect(agent.name).toBe("seo-audit");

        const found = await db.getAgent("acme", "seo-audit");
        expect(found?.id).toBe(agent.id);
      });

      it("returns null for missing agent", async () => {
        expect(await db.getAgent("x", "y")).toBeNull();
      });

      it("defaults visibility to private when unspecified", async () => {
        const agent = await db.createAgent({
          name: "vis-default",
          namespace: "acme",
          description: "",
          owner_id: fx("user-1"),
        });
        expect(agent.visibility).toBe("private");
        expect((await db.getAgent("acme", "vis-default"))?.visibility).toBe("private");
      });

      it("honours an explicit public visibility at create", async () => {
        const agent = await db.createAgent({
          name: "vis-public",
          namespace: "acme",
          description: "",
          owner_id: fx("user-1"),
          visibility: "public",
        });
        expect(agent.visibility).toBe("public");
        expect((await db.getAgent("acme", "vis-public"))?.visibility).toBe("public");
      });

      it("setVisibility flips private <-> public", async () => {
        await db.createAgent({
          name: "vis-flip",
          namespace: "acme",
          description: "",
          owner_id: fx("user-1"),
        });
        const toPublic = await db.setVisibility("acme", "vis-flip", "public");
        expect(toPublic?.visibility).toBe("public");
        expect((await db.getAgent("acme", "vis-flip"))?.visibility).toBe("public");
        const toPrivate = await db.setVisibility("acme", "vis-flip", "private");
        expect(toPrivate?.visibility).toBe("private");
      });

      it("setVisibility on a missing agent returns null", async () => {
        expect(await db.setVisibility("acme", "ghost", "public")).toBeNull();
      });

      it("lists agents with pagination", async () => {
        await db.createAgent({ name: "a", namespace: "ns", description: "", owner_id: fx("u") });
        await db.createAgent({ name: "b", namespace: "ns", description: "", owner_id: fx("u") });
        await db.createAgent({ name: "c", namespace: "ns", description: "", owner_id: fx("u") });

        const page1 = await db.listAgents({ page: 1, limit: 2 });
        expect(page1.agents).toHaveLength(2);
        expect(page1.total).toBe(3);

        const page2 = await db.listAgents({ page: 2, limit: 2 });
        expect(page2.agents).toHaveLength(1);
      });

      it("listAgents — userId filter narrows to owner's agents only", async () => {
        await db.createAgent({
          name: "a1",
          namespace: "userA",
          description: "",
          owner_id: fx("user-A"),
        });
        await db.createAgent({
          name: "a2",
          namespace: "userA",
          description: "",
          owner_id: fx("user-A"),
        });
        await db.createAgent({
          name: "b1",
          namespace: "userB",
          description: "",
          owner_id: fx("user-B"),
        });
        await db.createAgent({
          name: "b2",
          namespace: "userB",
          description: "",
          owner_id: fx("user-B"),
        });
        await db.createAgent({
          name: "b3",
          namespace: "userB",
          description: "",
          owner_id: fx("user-B"),
        });

        const listA = await db.listAgents({ page: 1, limit: 20, userId: fx("user-A") });
        expect(listA.agents).toHaveLength(2);
        expect(listA.total).toBe(2);
        expect(listA.agents.every((a) => a.owner_id === fx("user-A"))).toBe(true);

        const listB = await db.listAgents({ page: 1, limit: 20, userId: fx("user-B") });
        expect(listB.agents).toHaveLength(3);
        expect(listB.total).toBe(3);
        expect(listB.agents.every((a) => a.owner_id === fx("user-B"))).toBe(true);

        // No userId → instance-wide (admin / dev-token)
        const listAll = await db.listAgents({ page: 1, limit: 20 });
        expect(listAll.agents).toHaveLength(5);
        expect(listAll.total).toBe(5);
      });

      it("listAgents — the userId filter stays accurate across pages (25 + 5 = 30; page 2 of A)", async () => {
        for (let i = 0; i < 25; i++) {
          await db.createAgent({
            name: `a${i.toString().padStart(2, "0")}`,
            namespace: "userA",
            description: "",
            owner_id: fx("user-A"),
          });
        }
        for (let i = 0; i < 5; i++) {
          await db.createAgent({
            name: `b${i}`,
            namespace: "userB",
            description: "",
            owner_id: fx("user-B"),
          });
        }

        const page1 = await db.listAgents({ page: 1, limit: 20, userId: fx("user-A") });
        expect(page1.agents).toHaveLength(20);
        expect(page1.total).toBe(25);

        const page2 = await db.listAgents({ page: 2, limit: 20, userId: fx("user-A") });
        expect(page2.agents).toHaveLength(5);
        expect(page2.total).toBe(25);
        expect(page2.agents.every((a) => a.owner_id === fx("user-A"))).toBe(true);
      });

      it("sets per-version verified flag", async () => {
        const agent = await db.createAgent({
          name: "verif",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 0, bundle_key: "k" });

        const updated = await db.setVersionVerified("ns", "verif", "1.0.0", true);
        expect(updated?.verified).toBe(true);

        const found = await db.getVersionByNumber(agent.id, "1.0.0");
        expect(found?.verified).toBe(true);
      });

      it("deletes agent and cascades to its versions", async () => {
        const agent = await db.createAgent({
          name: "del",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k" });

        expect(await db.deleteAgent("ns", "del")).toBe(true);
        expect(await db.getAgent("ns", "del")).toBeNull();
        expect(await db.getVersions(agent.id)).toHaveLength(0);
      });

      it("deletes an agent and detaches its runs, which survive with a null agent_id", async () => {
        const agent = await db.createAgent({
          name: "detach",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        for (const label of ["detach-run-1", "detach-run-2"]) {
          await db.createRun({
            id: fx(label),
            agent_id: agent.id,
            agent_version: "ns/detach@1.0.0",
            status: "completed",
          });
        }

        expect(await db.deleteAgent("ns", "detach")).toBe(true);

        for (const label of ["detach-run-1", "detach-run-2"]) {
          const run = await db.getRun(fx(label));
          expect(run, `${label} survives its agent`).not.toBeNull();
          expect(run?.agent_id, `${label}.agent_id`).toBeNull();
          expect(run?.agent_version).toBe("ns/detach@1.0.0");
        }
      });

      it("returns run_count and token_count in listAgents", async () => {
        const agent = await db.createAgent({
          name: "counted",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("r1"),
          agent_id: agent.id,
          agent_version: "ns/counted@1.0.0",
          status: "completed",
        });
        await db.createRun({
          id: fx("r2"),
          agent_id: agent.id,
          agent_version: "ns/counted@1.0.0",
          status: "completed",
        });
        await db.updateRun(fx("r1"), { usage_total_tokens: 100 });
        await db.updateRun(fx("r2"), { usage_total_tokens: 200 });

        const { agents } = await db.listAgents({ page: 1, limit: 10 });
        const a = agents.find((x) => x.name === "counted");
        expect(a?.run_count).toBe(2);
        expect(a?.token_count).toBe(300);
      });
    });

    // ── Versions ────────────────────────────────────────────────────────

    describe("versions", () => {
      it("creates and lists versions", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "ns/a/1.0.0.agent",
        });
        await db.createVersion(agent.id, {
          version: "1.1.0",
          size: 200,
          bundle_key: "ns/a/1.1.0.agent",
        });

        const versions = await db.getVersions(agent.id);
        expect(versions).toHaveLength(2);
      });

      it("gets latest version", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
        await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

        const latest = await db.getLatestVersion(agent.id);
        expect(latest?.version).toBe("2.0.0");
      });

      it("returns null for latest version on empty agent", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        expect(await db.getLatestVersion(agent.id)).toBeNull();
      });

      it("gets version by number; returns null for missing", async () => {
        const agent = await db.createAgent({
          name: "a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
        await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

        const v = await db.getVersionByNumber(agent.id, "1.0.0");
        expect(v?.size).toBe(100);
        expect(await db.getVersionByNumber(agent.id, "9.9.9")).toBeNull();
      });

      it("deleteVersion removes the row and preserves listAgents aggregates", async () => {
        const agent = await db.createAgent({
          name: "del-version",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, { version: "1.0.0", size: 100, bundle_key: "k1" });
        await db.createVersion(agent.id, { version: "2.0.0", size: 200, bundle_key: "k2" });

        // Pre-condition: listAgents aggregates capture run_count etc.
        const before = await db.listAgents({ page: 1, limit: 10 });
        const beforeStats = before.agents.find((a) => a.id === agent.id);
        expect(beforeStats).toBeDefined();

        await db.deleteVersion(agent.id, "1.0.0");

        const versions = await db.getVersions(agent.id);
        expect(versions).toHaveLength(1);
        expect(versions[0].version).toBe("2.0.0");

        // run_count / token_count / cost_total are unchanged — they join on
        // `runs`, not `agent_versions`.
        const after = await db.listAgents({ page: 1, limit: 10 });
        const afterStats = after.agents.find((a) => a.id === agent.id);
        expect(afterStats?.run_count).toBe(beforeStats?.run_count);
        expect(afterStats?.token_count).toBe(beforeStats?.token_count);
        expect(afterStats?.cost_total).toBe(beforeStats?.cost_total);
      });

      it("round-trips config_snapshot as structured object", async () => {
        const agent = await db.createAgent({
          name: "cfg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const snapshot = {
          model: { provider: "google", name: "gemini-2.5-flash" },
          inputs: [{ name: "q", type: "string" }],
        };
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "k",
          config_snapshot: snapshot,
        });

        const v = await db.getLatestVersion(agent.id);
        expect(v?.config_snapshot).toEqual(snapshot);
      });

      it("stores notes and defaults to null when absent", async () => {
        const agent = await db.createAgent({
          name: "notes-test",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "k1",
          notes: "Added retry logic",
        });
        await db.createVersion(agent.id, {
          version: "2.0.0",
          size: 200,
          bundle_key: "k2",
        });

        const versions = await db.getVersions(agent.id);
        // Ordering: implementations may sort by version or pushed_at. Index by version.
        const v1 = versions.find((v) => v.version === "1.0.0");
        const v2 = versions.find((v) => v.version === "2.0.0");
        expect(v1?.notes).toBe("Added retry logic");
        expect(v2?.notes).toBeNull();
      });

      it("round-trips notes with emoji and multibyte UTF-8", async () => {
        const agent = await db.createAgent({
          name: "emoji",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const note = "🚀 Amélioration 日本語";
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "k",
          notes: note,
        });
        const v = await db.getLatestVersion(agent.id);
        expect(v?.notes).toBe(note);
      });

      it("hashes and round-trips bundle_sha256; defaults to null when absent", async () => {
        // createVersion persists the bundle's SHA-256; the column
        // is nullable (legacy/backfill valve), the always-set invariant lives
        // in RegistryService.push(). Runs on all 3 backends incl. PostgresDb
        // in CI.
        const agent = await db.createAgent({
          name: "hashed",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const sha = "a".repeat(64);
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "k1",
          bundle_sha256: sha,
        });
        await db.createVersion(agent.id, {
          version: "2.0.0",
          size: 200,
          bundle_key: "k2",
        });

        const v1 = await db.getVersionByNumber(agent.id, "1.0.0");
        const v2 = await db.getVersionByNumber(agent.id, "2.0.0");
        expect(v1?.bundle_sha256).toBe(sha);
        expect(v2?.bundle_sha256).toBeNull();
      });

      it("listVersionsMissingHash returns only null-hash rows (id + bundle_key)", async () => {
        // The backfill enumerates versions with no stored hash.
        const agent = await db.createAgent({
          name: "missing-hash",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 100,
          bundle_key: "kn",
        });
        await db.createVersion(agent.id, {
          version: "2.0.0",
          size: 200,
          bundle_key: "kh",
          bundle_sha256: "b".repeat(64),
        });

        const missing = await db.listVersionsMissingHash();
        expect(missing.some((m) => m.bundle_key === "kn")).toBe(true);
        expect(missing.some((m) => m.bundle_key === "kh")).toBe(false);
        for (const m of missing) {
          expect(m.id).toBeTruthy();
          expect(typeof m.bundle_key).toBe("string");
        }

        // setVersionBundleHash (backfill writer) populates the row → it leaves
        // the missing list. Covers all 3 backends incl. PostgresDb in CI.
        const target = missing.find((m) => m.bundle_key === "kn");
        expect(target).toBeDefined();
        if (target) {
          await db.setVersionBundleHash(target.id, "d".repeat(64));
          const after = await db.listVersionsMissingHash();
          expect(after.some((m) => m.bundle_key === "kn")).toBe(false);
          const updated = await db.getVersionByNumber(agent.id, "1.0.0");
          expect(updated?.bundle_sha256).toBe("d".repeat(64));
        }
      });

      describe("the bundle bytes an account holds", () => {
        /** An agent of `owner`, with one version per size given. */
        async function agentWithVersions(name: string, owner: string, sizes: number[]) {
          const agent = await db.createAgent({
            name,
            namespace: "ns",
            description: "",
            owner_id: fx(owner),
          });
          for (const [i, size] of sizes.entries()) {
            await db.createVersion(agent.id, {
              version: `1.${i}.0`,
              size,
              bundle_key: `ns/${name}/1.${i}.0.agent`,
            });
          }
          return agent;
        }

        it("is zero for an account that owns no agent, and for one whose agents have no version", async () => {
          expect(await db.sumBundleBytesByOwner(fx("u"))).toBe(0);
          await agentWithVersions("empty", "u", []);
          expect(await db.sumBundleBytesByOwner(fx("u"))).toBe(0);
        });

        it("adds up every version of every agent the account owns, and none of another account's", async () => {
          await agentWithVersions("first", "u", [100, 200]);
          await agentWithVersions("second", "u", [300]);
          await agentWithVersions("someone-else", "user-1", [5000]);

          expect(await db.sumBundleBytesByOwner(fx("u"))).toBe(600);
          expect(await db.sumBundleBytesByOwner(fx("user-1"))).toBe(5000);
        });

        it("no longer counts a deleted version, nor the versions of a deleted agent", async () => {
          const first = await agentWithVersions("first", "u", [100, 200]);
          await agentWithVersions("second", "u", [300]);

          await db.deleteVersion(first.id, "1.0.0");
          expect(await db.sumBundleBytesByOwner(fx("u"))).toBe(500);

          await db.deleteAgent("ns", "second");
          expect(await db.sumBundleBytesByOwner(fx("u"))).toBe(200);
        });

        it("reads a sum past 2^31 bytes whole, as a number", async () => {
          // Each size fits the column (an integer); their sum does not.
          await agentWithVersions("large", "u", [2_000_000_000, 2_000_000_000]);
          expect(await db.sumBundleBytesByOwner(fx("u"))).toBe(4_000_000_000);
        });
      });

      // The registry's push on this backend. Both pushes of one version share
      // one object key: let the second store its bytes over the first's, and
      // the version keeps the first's checksum over them — every pull of it
      // refused, and the second answered by the backend's unique version.
      describe("two pushes of one version at once, their bundles different", () => {
        const pushLimits: Array<[string, PushLimits | undefined]> = [
          ["no bound given", undefined],
          [
            "no storage bound",
            { plan: "free", maxTimeoutS: 900, storageBytes: null, master: true },
          ],
          [
            "a storage bound",
            { plan: "free", maxTimeoutS: null, storageBytes: 1024 * 1024, master: true },
          ],
        ];

        it.each(
          pushLimits,
        )("with %s: one is stored, the other refused 409 VERSION_EXISTS, and the version reads back as the bundle stored", async (_label, limits) => {
          await pushTwiceAtOnce([fx("u"), fx("u")], limits);
        });

        // Two accounts can be given one namespace — the development token's
        // accounts are — and push into it one after the other too.
        it("by two accounts given one namespace, with no storage bound: one is stored, the other refused 409 VERSION_EXISTS, and the version reads back as the bundle stored", async () => {
          await pushTwiceAtOnce([fx("u"), fx("u2")], pushLimits[1][1]);
        });

        /**
         * `ns/same@1.0.0` pushed by the first of `pushers`, then `2.0.0` pushed
         * twice at once, by each of them, with different bytes.
         */
        async function pushTwiceAtOnce(
          pushers: [string, string],
          limits: PushLimits | undefined,
        ): Promise<void> {
          const storage = new MemoryStorage();
          const service = new RegistryService(storage, db);
          await service.push(
            "ns",
            "same",
            "1.0.0",
            await validBundle("same"),
            pushers[0],
            null,
            limits,
          );
          // Two bundles a push accepts, their bytes different.
          const bundles = [await validBundle("same-first"), await validBundle("same-second")];

          // Each write waits until both pushes have read whether the version
          // exists, or a moment: pushes not taken in turn have both read it
          // absent by then. The second bundle's bytes land last.
          let versionReads = 0;
          const getVersionByNumber = db.getVersionByNumber.bind(db);
          const reads = vi
            .spyOn(db, "getVersionByNumber")
            .mockImplementation(async (agentId, version) => {
              const found = await getVersionByNumber(agentId, version);
              if (version === "2.0.0") versionReads += 1;
              return found;
            });
          const put = storage.put.bind(storage);
          storage.put = async (key, data, opts) => {
            const until = Date.now() + 300;
            while (versionReads < 2 && Date.now() < until) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            if (data.equals(bundles[1])) await new Promise((resolve) => setTimeout(resolve, 50));
            return put(key, data, opts);
          };

          try {
            const outcomes = await Promise.all(
              bundles.map((bundle, i) =>
                service.push("ns", "same", "2.0.0", bundle, pushers[i], null, limits).then(
                  () => "stored",
                  (err: unknown) =>
                    err instanceof RegistryError
                      ? `${err.status} ${err.code}`
                      : `failed: ${(err as { code?: string }).code ?? String(err)}`,
                ),
              ),
            );
            expect([...outcomes].sort()).toEqual(["409 VERSION_EXISTS", "stored"]);

            const storedBundle = bundles[outcomes.indexOf("stored")];
            const pulled = await service.pull("ns", "same", "2.0.0");
            expect(pulled.buffer.equals(storedBundle)).toBe(true);
            expect(await storage.get("ns/same/2.0.0.agent")).toEqual(storedBundle);
            const agent = await db.getAgent("ns", "same");
            expect((await db.getVersions(agent?.id ?? "")).map((v) => v.version).sort()).toEqual([
              "1.0.0",
              "2.0.0",
            ]);
          } finally {
            reads.mockRestore();
          }
        }
      });

      // The registry's push on this backend. A version's row records its
      // configuration in a `jsonb` column on Postgres, which refuses U+0000
      // and a lone surrogate; SQLite and the memory store accept both. The
      // push refuses them on every backend, before anything is written.
      describe("a push whose agent.yaml holds U+0000 or a lone surrogate", () => {
        /** A minimal agent's agent.yaml, `description` its input's, and `extra` lines after it. */
        const agentYaml = (description: string, extra: readonly string[] = []): string =>
          [
            "name: odd",
            "version: 1.0.0",
            "model:",
            "  provider: anthropic",
            "  name: claude-sonnet-4-6",
            "inputs:",
            "  - name: q",
            "    type: string",
            `    description: "${description}"`,
            "outputs:",
            "  - name: answer",
            "    type: string",
            ...extra,
          ].join("\n");
        /** A minimal agent's agent.yaml with one test, whose `input` is the flow mapping `input`. */
        const withTestInput = (input: string): string =>
          agentYaml("plain", [
            "tests:",
            "  - name: t",
            `    input: ${input}`,
            '    assert: "true"',
          ]);

        // The YAML escapes, as written in the file: `\0`, `\uD800`, `\udc00`.
        const refused: Array<[string, string, string]> = [
          ["U+0000 in a value", agentYaml("a\\0b"), "inputs[0].description holds U+0000"],
          [
            "a lone high surrogate in a value",
            agentYaml("a\\uD800b"),
            "inputs[0].description holds a lone surrogate",
          ],
          [
            "a lone low surrogate in a nested value",
            withTestInput('{ q: { deep: ["ok", "\\udc00"] } }'),
            "tests[0].input.q.deep[1] holds a lone surrogate",
          ],
          [
            "U+0000 in a key",
            withTestInput('{ "k\\0": 1 }'),
            "a key of tests[0].input holds U+0000",
          ],
          [
            "a lone surrogate in a key",
            withTestInput('{ "k\\uD800": 1 }'),
            "a key of tests[0].input holds a lone surrogate",
          ],
        ];

        it.each(
          refused,
        )("%s: 400 INVALID_CONFIG naming the field, no agent, no version, no object", async (_label, yaml, named) => {
          const storage = new MemoryStorage();
          const service = new RegistryService(storage, db);
          const err = await service
            .push("ns", "odd", "1.0.0", await validBundle("odd", yaml), fx("u"))
            .catch((caught: unknown) => caught);
          expect(err).toBeInstanceOf(RegistryError);
          expect((err as RegistryError).status).toBe(400);
          expect((err as RegistryError).code).toBe("INVALID_CONFIG");
          expect((err as RegistryError).message).toContain(named);
          expect(await db.getAgent("ns", "odd")).toBeNull();
          expect(await storage.list("ns/")).toEqual([]);
        });

        it("a new version of an existing agent is refused alike: the agent keeps its one version and its one object", async () => {
          const storage = new MemoryStorage();
          const service = new RegistryService(storage, db);
          await service.push(
            "ns",
            "odd",
            "1.0.0",
            await validBundle("odd", agentYaml("plain")),
            fx("u"),
          );
          const err = await service
            .push("ns", "odd", "2.0.0", await validBundle("odd", agentYaml("a\\0b")), fx("u"))
            .catch((caught: unknown) => caught);
          expect((err as RegistryError).code).toBe("INVALID_CONFIG");
          const agent = await db.getAgent("ns", "odd");
          expect((await db.getVersions(agent?.id ?? "")).map((v) => v.version)).toEqual(["1.0.0"]);
          expect(await storage.list("ns/")).toEqual(["ns/odd/1.0.0.agent"]);
        });

        it("a whole surrogate pair — an emoji — is stored, and its version records it", async () => {
          const storage = new MemoryStorage();
          const service = new RegistryService(storage, db);
          // Written as the escape of each half, and as the character itself.
          await service.push(
            "ns",
            "odd",
            "1.0.0",
            await validBundle("odd", agentYaml("a \\uD83D\\uDE00 b, \u{1F642}")),
            fx("u"),
          );
          const agent = await db.getAgent("ns", "odd");
          const version = await db.getVersionByNumber(agent?.id ?? "", "1.0.0");
          const inputs = version?.config_snapshot?.inputs as Array<{ description?: string }>;
          expect(inputs[0]?.description).toBe("a \u{1F600} b, \u{1F642}");
          expect(await storage.list("ns/")).toEqual(["ns/odd/1.0.0.agent"]);
        });
      });

      // What the publication reads after a version's row failed: a refusal
      // the store itself answered is a write known not to have committed.
      it("a version the store refuses as a duplicate is a write whose outcome is known", async () => {
        const agent = await db.createAgent({
          name: "dup",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const row = { version: "1.0.0", size: 1, bundle_key: "ns/dup/1.0.0.agent" };
        await db.createVersion(agent.id, row);
        const err = await db.createVersion(agent.id, row).then(
          () => null,
          (caught: unknown) => caught,
        );
        if (label === "memory") {
          // The memory store has no unique version: it keeps both rows, and refuses nothing.
          expect(err).toBeNull();
          expect(db.writeOutcomeUnknown(new Error("any"))).toBe(false);
        } else {
          expect(err).not.toBeNull();
          expect(db.writeOutcomeUnknown(err)).toBe(false);
        }
      });
    });

    // ── Agent State ─────────────────────────────────────────────────────

    describe("state", () => {
      /** A deadline written by the caller, with milliseconds. */
      const EXPIRES = "2099-05-06T07:08:09.123Z";
      const SHARED = { kind: "shared" } as const;
      const asAccount = (userId: string) => ({ kind: "account", userId }) as const;
      const asKey = (keyId: string) => ({ kind: "key", keyId }) as const;

      /**
       * What a notebook belongs to, each created through the adapter: an agent,
       * a second agent, an account (a `users` row — the memory backend refuses
       * an account it does not know), and two API keys of another account.
       */
      async function stateFixture(tag: string) {
        const agent = await db.createAgent({
          name: `st-agent-${tag}`,
          namespace: "st",
          description: "",
          owner_id: fx("user-1"),
        });
        const otherAgent = await db.createAgent({
          name: `st-other-${tag}`,
          namespace: "st",
          description: "",
          owner_id: fx("user-1"),
        });
        const account = await db.createUser({
          github_id: `st-account-${tag}`,
          username: `st-account-${tag}`,
        });
        const newKey = (label: string) =>
          db.createApiKey({
            user_id: fx("user-A"),
            key_hash: `st-hash-${tag}-${label}`,
            key_prefix: "skrun_sk_st",
            name: `st ${label}`,
          });
        const keyA = await newKey("a");
        const keyB = await newKey("b");
        return { agent, otherAgent, account, keyA, keyB };
      }

      it("reads a notebook back with its deadline; a partition never written reads as null", async () => {
        const { agent } = await stateFixture("rt");
        expect(await db.getState(agent.id, SHARED)).toBeNull();

        await db.setState(agent.id, SHARED, { score: 75, history: [1, 2] }, EXPIRES);
        expect(await db.getState(agent.id, SHARED)).toEqual({
          state: { score: 75, history: [1, 2] },
          expires_at: EXPIRES,
        });
      });

      it("writing a partition again replaces its notebook", async () => {
        const { agent, account } = await stateFixture("ow");
        await db.setState(agent.id, asAccount(account.id), { step: 1 }, EXPIRES);
        await db.setState(agent.id, asAccount(account.id), { step: 2 }, EXPIRES);
        expect((await db.getState(agent.id, asAccount(account.id)))?.state).toEqual({ step: 2 });
      });

      it("writing a partition again moves its deadline to the one of the new write", async () => {
        // The deadline slides with each write: a notebook kept for its ttl is
        // kept from its last write, not from its first.
        const { agent, account } = await stateFixture("slide");
        const first = "2099-01-01T00:00:00.000Z";
        const second = "2099-02-03T04:05:06.789Z";
        await db.setState(agent.id, asAccount(account.id), { step: 1 }, first);
        await db.setState(agent.id, asAccount(account.id), { step: 2 }, second);
        expect(await db.getState(agent.id, asAccount(account.id))).toEqual({
          state: { step: 2 },
          expires_at: second,
        });
      });

      it("reads an expired notebook back like any other, with its deadline", async () => {
        // The adapter does not decide what an expired notebook means: the
        // caller of the adapter does, from the deadline it reads.
        const { agent } = await stateFixture("expired-read");
        const past = new Date(Date.now() - 60_000).toISOString();
        await db.setState(agent.id, SHARED, { stale: true }, past);
        expect(await db.getState(agent.id, SHARED)).toEqual({
          state: { stale: true },
          expires_at: past,
        });
      });

      it("purges expired notebooks, in every kind of partition, and keeps the others", async () => {
        const { agent, otherAgent, account, keyA, keyB } = await stateFixture("purge");
        const past = new Date(Date.now() - 60_000).toISOString();
        await db.setState(agent.id, SHARED, { gone: "shared" }, past);
        await db.setState(agent.id, asAccount(account.id), { gone: "account" }, past);
        await db.setState(agent.id, asKey(keyA.id), { gone: "key" }, past);
        await db.setState(otherAgent.id, SHARED, { kept: "shared" }, EXPIRES);
        await db.setState(agent.id, asKey(keyB.id), { kept: "key" }, EXPIRES);

        await db.purgeExpiredState();

        expect(await db.getState(agent.id, SHARED)).toBeNull();
        expect(await db.getState(agent.id, asAccount(account.id))).toBeNull();
        expect(await db.getState(agent.id, asKey(keyA.id))).toBeNull();
        expect(await db.getState(otherAgent.id, SHARED)).toEqual({
          state: { kept: "shared" },
          expires_at: EXPIRES,
        });
        expect((await db.getState(agent.id, asKey(keyB.id)))?.state).toEqual({ kept: "key" });
      });

      it("a notebook written again with a later deadline is not purged", async () => {
        const { agent, account } = await stateFixture("purge-slide");
        const past = new Date(Date.now() - 60_000).toISOString();
        await db.setState(agent.id, asAccount(account.id), { step: 1 }, past);
        await db.setState(agent.id, asAccount(account.id), { step: 2 }, EXPIRES);

        await db.purgeExpiredState();

        expect((await db.getState(agent.id, asAccount(account.id)))?.state).toEqual({ step: 2 });
      });

      it("each partition reads only its own notebook", async () => {
        const { agent, otherAgent, account, keyA, keyB } = await stateFixture("iso");
        await db.setState(agent.id, SHARED, { who: "shared" }, EXPIRES);
        await db.setState(agent.id, asAccount(account.id), { who: "account" }, EXPIRES);
        await db.setState(agent.id, asKey(keyA.id), { who: "key-a" }, EXPIRES);

        expect((await db.getState(agent.id, SHARED))?.state).toEqual({ who: "shared" });
        expect((await db.getState(agent.id, asAccount(account.id)))?.state).toEqual({
          who: "account",
        });
        expect((await db.getState(agent.id, asKey(keyA.id)))?.state).toEqual({ who: "key-a" });
        // A caller that never wrote reads nothing, not another caller's notebook.
        expect(await db.getState(agent.id, asKey(keyB.id))).toBeNull();
        // The same partitions of another agent are empty.
        expect(await db.getState(otherAgent.id, SHARED)).toBeNull();
        expect(await db.getState(otherAgent.id, asAccount(account.id))).toBeNull();
        expect(await db.getState(otherAgent.id, asKey(keyA.id))).toBeNull();
      });

      it("deleting an agent deletes every notebook of that agent, and only those", async () => {
        const { agent, otherAgent, account, keyA } = await stateFixture("del-agent");
        await db.setState(agent.id, SHARED, { n: 1 }, EXPIRES);
        await db.setState(agent.id, asAccount(account.id), { n: 2 }, EXPIRES);
        await db.setState(agent.id, asKey(keyA.id), { n: 3 }, EXPIRES);
        await db.setState(otherAgent.id, asKey(keyA.id), { n: 4 }, EXPIRES);

        expect(await db.deleteAgent("st", agent.name)).toBe(true);

        expect(await db.getState(agent.id, SHARED)).toBeNull();
        expect(await db.getState(agent.id, asAccount(account.id))).toBeNull();
        expect(await db.getState(agent.id, asKey(keyA.id))).toBeNull();
        expect((await db.getState(otherAgent.id, asKey(keyA.id)))?.state).toEqual({ n: 4 });
      });

      it("an agent re-created under the same name reads none of the deleted agent's notebooks", async () => {
        const { agent, account } = await stateFixture("recreate");
        await db.setState(agent.id, SHARED, { old: true }, EXPIRES);
        await db.setState(agent.id, asAccount(account.id), { old: true }, EXPIRES);
        await db.deleteAgent("st", agent.name);

        const again = await db.createAgent({
          name: agent.name,
          namespace: "st",
          description: "",
          owner_id: fx("user-1"),
        });
        expect(await db.getState(again.id, SHARED)).toBeNull();
        expect(await db.getState(again.id, asAccount(account.id))).toBeNull();
      });

      it("revoking a key deletes that key's notebooks and keeps the other key's", async () => {
        const { agent, otherAgent, keyA, keyB } = await stateFixture("del-key");
        await db.setState(agent.id, asKey(keyA.id), { k: "a" }, EXPIRES);
        await db.setState(otherAgent.id, asKey(keyA.id), { k: "a2" }, EXPIRES);
        await db.setState(agent.id, asKey(keyB.id), { k: "b" }, EXPIRES);

        expect(await db.deleteApiKey(keyA.id)).toBe(true);

        expect(await db.getState(agent.id, asKey(keyA.id))).toBeNull();
        expect(await db.getState(otherAgent.id, asKey(keyA.id))).toBeNull();
        expect((await db.getState(agent.id, asKey(keyB.id)))?.state).toEqual({ k: "b" });
      });

      it("revoking a key by its owner deletes that key's notebooks and keeps the other key's", async () => {
        const { agent, keyA, keyB } = await stateFixture("del-key-owner");
        await db.setState(agent.id, asKey(keyA.id), { k: "a" }, EXPIRES);
        await db.setState(agent.id, asKey(keyB.id), { k: "b" }, EXPIRES);

        expect(await db.deleteApiKeyByOwner(keyA.id, fx("user-A"))).toBe(true);

        expect(await db.getState(agent.id, asKey(keyA.id))).toBeNull();
        expect((await db.getState(agent.id, asKey(keyB.id)))?.state).toEqual({ k: "b" });
      });

      /** The error a write rejects with, so a case can say what kind of refusal it is. */
      async function refusal(write: Promise<void>): Promise<unknown> {
        try {
          await write;
        } catch (err) {
          return err;
        }
        throw new Error("the write was not refused");
      }

      it("refuses to write a notebook for an agent that does not exist", async () => {
        const err = await refusal(db.setState(fx("st-absent-agent"), SHARED, { x: 1 }, EXPIRES));
        // The refusal a run absorbs: a missing reference, and nothing else.
        expect(isMissingStateReference(err)).toBe(true);
      });

      it("refuses to write a notebook for an account that does not exist", async () => {
        const { agent } = await stateFixture("absent-account");
        const err = await refusal(
          db.setState(agent.id, asAccount(fx("st-absent-account")), { x: 1 }, EXPIRES),
        );
        expect(isMissingStateReference(err)).toBe(true);
        expect(await db.getState(agent.id, asAccount(fx("st-absent-account")))).toBeNull();
      });

      it("refuses to write a notebook for a key that does not exist", async () => {
        const { agent } = await stateFixture("absent-key");
        const err = await refusal(
          db.setState(agent.id, asKey(fx("st-absent-key")), { x: 1 }, EXPIRES),
        );
        expect(isMissingStateReference(err)).toBe(true);
        expect(await db.getState(agent.id, asKey(fx("st-absent-key")))).toBeNull();
      });

      it("a write after its agent was deleted, or its key revoked, is refused as a missing reference", async () => {
        // What a run meets when the agent or the caller's key goes while it runs:
        // the notebook is read at the start, written at the end.
        const { agent, otherAgent, keyA, keyB } = await stateFixture("gone-mid-run");
        expect(await db.getState(agent.id, asKey(keyA.id))).toBeNull();
        expect(await db.deleteAgent("st", agent.name)).toBe(true);
        expect(
          isMissingStateReference(
            await refusal(db.setState(agent.id, asKey(keyA.id), { x: 1 }, EXPIRES)),
          ),
        ).toBe(true);

        expect(await db.deleteApiKey(keyB.id)).toBe(true);
        expect(
          isMissingStateReference(
            await refusal(db.setState(otherAgent.id, asKey(keyB.id), { x: 1 }, EXPIRES)),
          ),
        ).toBe(true);
        expect(await db.getState(otherAgent.id, asKey(keyB.id))).toBeNull();
      });

      it("stores a copy — mutating the written or the read object does not change the notebook", async () => {
        const { agent } = await stateFixture("copy");
        const original = { counter: 1 };
        await db.setState(agent.id, SHARED, original, EXPIRES);

        // SqliteDb/PostgresDb satisfy this via JSON serialization (deserialize
        // returns a fresh object). MemoryDb must explicitly structuredClone.
        original.counter = 999;
        const read = await db.getState(agent.id, SHARED);
        expect(read?.state).toEqual({ counter: 1 });

        (read?.state as { counter: number }).counter = 555;
        expect((await db.getState(agent.id, SHARED))?.state).toEqual({ counter: 1 });
      });
    });

    // ── Users ───────────────────────────────────────────────────────────

    describe("users", () => {
      it("creates and finds user by github_id + by id", async () => {
        const user = await db.createUser({
          github_id: "gh-123",
          username: "alice",
          email: "alice@test.com",
          avatar_url: "https://img.test/a.png",
        });
        expect(user.id).toBeTruthy();
        expect(user.plan).toBe("free");

        const byId = await db.getUserById(user.id);
        expect(byId?.username).toBe("alice");

        const byGh = await db.getUserByGithubId("gh-123");
        expect(byGh?.id).toBe(user.id);
      });

      it("returns null for missing user (both lookups)", async () => {
        expect(await db.getUserById(fx("nope"))).toBeNull();
        expect(await db.getUserByGithubId("nope")).toBeNull();
      });

      it("updates user fields (email + plan)", async () => {
        const user = await db.createUser({ github_id: "gh-1", username: "bob" });
        const updated = await db.updateUser(user.id, { email: "bob@new.com", plan: "pro" });
        expect(updated?.email).toBe("bob@new.com");
        expect(updated?.plan).toBe("pro");
      });
    });

    // ── Accounts created by a GitHub sign-in: the namespace they get ────

    describe("oauth users", () => {
      it("a free login becomes the namespace, lowercased, not derived", async () => {
        const { user, derived } = await db.createOAuthUser({
          github_id: "gh-oauth-1",
          login: "Alice",
          email: "alice@test.com",
          avatar_url: "https://img.test/a.png",
        });
        expect(user.username).toBe("alice");
        expect(derived).toBeNull();
        expect(user.email).toBe("alice@test.com");
        expect(user.avatar_url).toBe("https://img.test/a.png");
        expect((await db.getUserByGithubId("gh-oauth-1"))?.id).toBe(user.id);
      });

      it("a taken login gets `<login>--2`, then `--3` — the explicit read, on every backend", async () => {
        await db.createUser({ github_id: "gh-oauth-1", username: "alice" });
        const second = await db.createOAuthUser({ github_id: "gh-oauth-2", login: "alice" });
        expect(second.user.username).toBe("alice--2");
        expect(second.derived).toBe(2);
        const third = await db.createOAuthUser({ github_id: "gh-oauth-3", login: "Alice" });
        expect(third.user.username).toBe("alice--3");
        expect(third.derived).toBe(3);
        expect((await db.getUserByGithubId("gh-oauth-2"))?.username).toBe("alice--2");
      });

      it("a derived name already held by an older account is skipped", async () => {
        await db.createUser({ github_id: "gh-oauth-1", username: "alice" });
        await db.createUser({ github_id: "gh-oauth-old", username: "alice--2" });
        const { user, derived } = await db.createOAuthUser({
          github_id: "gh-oauth-2",
          login: "alice",
        });
        expect(user.username).toBe("alice--3");
        expect(derived).toBe(3);
      });

      it("the same GitHub account twice is one account, never renamed", async () => {
        const first = await db.createOAuthUser({ github_id: "gh-oauth-1", login: "alice" });
        // A later sign-in under a new login: the account it already has.
        const again = await db.createOAuthUser({ github_id: "gh-oauth-1", login: "alice-new" });
        expect(again.user.id).toBe(first.user.id);
        expect(again.user.username).toBe("alice");
        expect(again.derived).toBeNull();
        const twice = await db.createOAuthUser({ github_id: "gh-oauth-1", login: "alice" });
        expect(twice.user.id).toBe(first.user.id);
        expect((await db.getUserByGithubId("gh-oauth-1"))?.id).toBe(first.user.id);
        // No second row was written under a derived name: the next account
        // for this login still gets the first derived name.
        const other = await db.createOAuthUser({ github_id: "gh-oauth-2", login: "alice" });
        expect(other.user.username).toBe("alice--2");
      });

      it("two logins that sanitize to the same base get the base, then a derived name", async () => {
        const first = await db.createOAuthUser({ github_id: "gh-oauth-1", login: "a_b" });
        const second = await db.createOAuthUser({ github_id: "gh-oauth-2", login: "a-b" });
        expect(first.user.username).toBe("a-b");
        expect(first.derived).toBeNull();
        expect(second.user.username).toBe("a-b--2");
        expect(second.derived).toBe(2);
      });
    });

    // ── API Keys ────────────────────────────────────────────────────────

    describe("api keys", () => {
      it("creates, looks up by hash, lists, and deletes", async () => {
        const user = await db.createUser({ github_id: "ak-1", username: "ak-u" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "hash-abc",
          key_prefix: "skrun_sk_abc",
          name: "test key",
          scopes: ["read", "write"],
        });
        expect(key.id).toBeTruthy();
        expect(key.scopes).toEqual(["read", "write"]);

        const found = await db.getApiKeyByHash("hash-abc");
        expect(found?.id).toBe(key.id);
        expect(found?.scopes).toEqual(["read", "write"]);

        const list = await db.listApiKeys(user.id);
        expect(list).toHaveLength(1);

        expect(await db.deleteApiKey(key.id)).toBe(true);
        expect(await db.listApiKeys(user.id)).toHaveLength(0);
      });

      // The expiry must round-trip identically on every backend. The auth
      // middleware refuses a key whose expiry has passed, so a backend that
      // dropped, truncated or shifted the value would silently either keep a
      // dead credential alive or kill a live one — and no other case in this
      // contract passes `expires_at` at all.
      it("round-trips expires_at unchanged, and treats its absence as null", async () => {
        const user = await db.createUser({ github_id: "ak-exp", username: "ak-exp-u" });
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "hash-expiring",
          key_prefix: "skrun_sk_exp",
          name: "expiring key",
          expires_at: expiresAt,
        });
        expect(key.expires_at).toBe(expiresAt);

        const found = await db.getApiKeyByHash("hash-expiring");
        expect(found?.expires_at).toBe(expiresAt);
        const listed = await db.listApiKeys(user.id);
        expect(listed.find((k) => k.id === key.id)?.expires_at).toBe(expiresAt);

        // Omitted → null, never a defaulted instant: expiry is not retroactive.
        const open = await db.createApiKey({
          user_id: user.id,
          key_hash: "hash-open",
          key_prefix: "skrun_sk_open",
          name: "open key",
        });
        expect(open.expires_at).toBeNull();
        expect((await db.getApiKeyByHash("hash-open"))?.expires_at).toBeNull();
      });

      it("returns false for deleteApiKey on nonexistent id", async () => {
        expect(await db.deleteApiKey(fx("nonexistent-key"))).toBe(false);
      });

      it("deletes only when owned by the user", async () => {
        const u1 = await db.createUser({ github_id: "ak-o1", username: "o1" });
        const u2 = await db.createUser({ github_id: "ak-o2", username: "o2" });
        const key = await db.createApiKey({
          user_id: u1.id,
          key_hash: "h-owned",
          key_prefix: "sk_",
          name: "mine",
        });

        // Wrong owner → false, key still there
        expect(await db.deleteApiKeyByOwner(key.id, u2.id)).toBe(false);
        expect(await db.getApiKeyByHash("h-owned")).toBeTruthy();

        // Correct owner → true, key gone
        expect(await db.deleteApiKeyByOwner(key.id, u1.id)).toBe(true);
        expect(await db.getApiKeyByHash("h-owned")).toBeNull();
      });

      it("returns false for deleteApiKeyByOwner on nonexistent key", async () => {
        const u = await db.createUser({ github_id: "ak-x", username: "x" });
        expect(await db.deleteApiKeyByOwner(fx("nonexistent-key"), u.id)).toBe(false);
      });

      it("updates last_used_at", async () => {
        const user = await db.createUser({ github_id: "ak-lu", username: "lu" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-lu",
          key_prefix: "sk_",
          name: "k",
        });
        expect(key.last_used_at).toBeNull();

        await db.updateApiKeyLastUsed(key.id);
        const updated = await db.getApiKeyByHash("h-lu");
        expect(updated?.last_used_at).toBeTruthy();
      });

      it("defaults scope_kind to 'account' with no grants", async () => {
        const user = await db.createUser({ github_id: "ak-sk", username: "ak-sk" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-sk-default",
          key_prefix: "sk_",
          name: "default",
        });
        expect(key.scope_kind).toBe("account");
        expect((await db.getApiKeyByHash("h-sk-default"))?.scope_kind).toBe("account");
        expect(await db.getApiKeyAgentIds(key.id)).toEqual([]);
      });

      it("persists scope_kind 'agents' + grant rows (round-trip)", async () => {
        const user = await db.createUser({ github_id: "ak-ag", username: "ak-ag" });
        const a1 = await db.createAgent({
          name: "ag1",
          namespace: "ak-ag",
          description: "",
          owner_id: user.id,
        });
        const a2 = await db.createAgent({
          name: "ag2",
          namespace: "ak-ag",
          description: "",
          owner_id: user.id,
        });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-scoped",
          key_prefix: "sk_",
          name: "scoped",
          scopes: ["agent:run"],
          scope_kind: "agents",
          agents: [a1.id, a2.id],
        });
        expect(key.scope_kind).toBe("agents");
        expect([...(await db.getApiKeyAgentIds(key.id))].sort()).toEqual([a1.id, a2.id].sort());
      });

      it("cascades grant rows when a granted agent is deleted (fail-closed)", async () => {
        const user = await db.createUser({ github_id: "ak-cz", username: "ak-cz" });
        const a1 = await db.createAgent({
          name: "cz1",
          namespace: "ak-cz",
          description: "",
          owner_id: user.id,
        });
        const a2 = await db.createAgent({
          name: "cz2",
          namespace: "ak-cz",
          description: "",
          owner_id: user.id,
        });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-cz",
          key_prefix: "sk_",
          name: "cz",
          scope_kind: "agents",
          agents: [a1.id, a2.id],
        });
        await db.deleteAgent("ak-cz", "cz1");
        expect(await db.getApiKeyAgentIds(key.id)).toEqual([a2.id]);
        await db.deleteAgent("ak-cz", "cz2");
        // 0 grants left → the key is deny-all at the enforcement layer (never fail-open).
        expect(await db.getApiKeyAgentIds(key.id)).toEqual([]);
      });
    });

    // ── Agent LLM keys (creator-attached, encrypted) ──────────────────────

    describe("agent llm keys", () => {
      it("defaults llm_key_policy to 'open' and setLlmKeyPolicy round-trips", async () => {
        const user = await db.createUser({ github_id: "lk-pol", username: "lk-pol" });
        const agent = await db.createAgent({
          name: "pol",
          namespace: "lk-pol",
          description: "",
          owner_id: user.id,
        });
        expect(agent.llm_key_policy).toBe("open");
        expect((await db.getAgent("lk-pol", "pol"))?.llm_key_policy).toBe("open");

        const locked = await db.setLlmKeyPolicy("lk-pol", "pol", "creator_only");
        expect(locked?.llm_key_policy).toBe("creator_only");
        expect((await db.getAgent("lk-pol", "pol"))?.llm_key_policy).toBe("creator_only");
      });

      it("setLlmKeyPolicy on a missing agent returns null", async () => {
        expect(await db.setLlmKeyPolicy("lk-pol", "ghost", "creator_only")).toBeNull();
      });

      it("upserts a key (replace on same provider), lists presence (no ciphertext), reads secrets", async () => {
        const user = await db.createUser({ github_id: "lk-up", username: "lk-up" });
        const agent = await db.createAgent({
          name: "up",
          namespace: "lk-up",
          description: "",
          owner_id: user.id,
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "cipher-v1", "••1234", 1);
        await db.setAgentLlmKey(agent.id, "openai", "cipher-o", "••abcd", 1);
        // Replace anthropic (same provider) — must NOT create a duplicate row.
        await db.setAgentLlmKey(agent.id, "anthropic", "cipher-v2", "••5678", 1);

        const presence = await db.listAgentLlmKeys(agent.id);
        expect(presence).toHaveLength(2);
        const anthropic = presence.find((p) => p.provider === "anthropic");
        expect(anthropic?.last4).toBe("••5678");
        expect(anthropic?.updated_at).toBeTruthy();
        // Presence view exposes ONLY provider/last4/updated_at — never the ciphertext.
        expect(Object.keys(anthropic ?? {}).sort()).toEqual(["last4", "provider", "updated_at"]);

        const secrets = await db.getAgentLlmKeySecrets(agent.id);
        expect(secrets).toHaveLength(2);
        const aSecret = secrets.find((s) => s.provider === "anthropic");
        expect(aSecret?.ciphertext).toBe("cipher-v2");
        expect(aSecret?.agent_id).toBe(agent.id);
        expect(aSecret?.key_version).toBe(1);
      });

      it("deleteAgentLlmKey removes a single provider", async () => {
        const user = await db.createUser({ github_id: "lk-del", username: "lk-del" });
        const agent = await db.createAgent({
          name: "del",
          namespace: "lk-del",
          description: "",
          owner_id: user.id,
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "c-a", "••1111", 1);
        await db.setAgentLlmKey(agent.id, "openai", "c-o", "••2222", 1);
        await db.deleteAgentLlmKey(agent.id, "anthropic");
        const presence = await db.listAgentLlmKeys(agent.id);
        expect(presence.map((p) => p.provider)).toEqual(["openai"]);
      });

      it("cascades keys when the agent is deleted", async () => {
        const user = await db.createUser({ github_id: "lk-cz", username: "lk-cz" });
        const agent = await db.createAgent({
          name: "cz",
          namespace: "lk-cz",
          description: "",
          owner_id: user.id,
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "c-a", "••3333", 1);
        await db.setAgentLlmKey(agent.id, "openai", "c-o", "••4444", 1);
        await db.deleteAgent("lk-cz", "cz");
        expect(await db.getAgentLlmKeySecrets(agent.id)).toEqual([]);
        expect(await db.listAgentLlmKeys(agent.id)).toEqual([]);
      });
    });

    // ── Device codes (CLI device-login, RFC 8628) ───────────────────────

    describe("device codes", () => {
      const future = () => new Date(Date.now() + 600_000).toISOString();

      it("creates a pending code and looks it up by device-hash and user-hash", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-1",
          user_code_hash: "uch-1",
          code_challenge: "chal-1",
          expires_at: future(),
        });
        const byDevice = await db.getDeviceCodeByDeviceHash("dch-1");
        expect(byDevice?.user_code_hash).toBe("uch-1");
        expect(byDevice?.code_challenge).toBe("chal-1");
        expect(byDevice?.status).toBe("pending");
        expect(byDevice?.user_id).toBeNull();
        expect(byDevice?.current_interval).toBe(5);
        expect(byDevice?.attempt_count).toBe(0);
        const byUser = await db.getDeviceCodeByUserHash("uch-1");
        expect(byUser?.device_code_hash).toBe("dch-1");
      });

      it("returns null for missing device/user hashes", async () => {
        expect(await db.getDeviceCodeByDeviceHash("nope")).toBeNull();
        expect(await db.getDeviceCodeByUserHash("nope")).toBeNull();
      });

      it("authorizes a pending code once (binds user_id); re-authorize is a no-op", async () => {
        const user = await db.createUser({ github_id: "dc-auth", username: "dc-auth" });
        await db.createDeviceCode({
          device_code_hash: "dch-2",
          user_code_hash: "uch-2",
          code_challenge: "chal-2",
          expires_at: future(),
        });
        expect(await db.authorizeDeviceCode("uch-2", user.id)).toBe(true);
        const authed = await db.getDeviceCodeByDeviceHash("dch-2");
        expect(authed?.status).toBe("authorized");
        expect(authed?.user_id).toBe(user.id);
        // Already authorized → not pending → false.
        expect(await db.authorizeDeviceCode("uch-2", user.id)).toBe(false);
      });

      it("records a poll (last_polled_at) and bumps current_interval on slow_down", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-3",
          user_code_hash: "uch-3",
          code_challenge: "chal-3",
          expires_at: future(),
        });
        await db.recordDeviceCodePoll("dch-3", false);
        let dc = await db.getDeviceCodeByDeviceHash("dch-3");
        expect(dc?.last_polled_at).not.toBeNull();
        expect(dc?.current_interval).toBe(5);
        await db.recordDeviceCodePoll("dch-3", true);
        dc = await db.getDeviceCodeByDeviceHash("dch-3");
        expect(dc?.current_interval).toBe(10);
      });

      it("increments the PKCE attempt counter", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-4",
          user_code_hash: "uch-4",
          code_challenge: "chal-4",
          expires_at: future(),
        });
        expect(await db.incrementDeviceCodeAttempts("dch-4")).toBe(1);
        expect(await db.incrementDeviceCodeAttempts("dch-4")).toBe(2);
      });

      it("consumes (deletes) a code", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-5",
          user_code_hash: "uch-5",
          code_challenge: "chal-5",
          expires_at: future(),
        });
        await db.consumeDeviceCode("dch-5");
        expect(await db.getDeviceCodeByDeviceHash("dch-5")).toBeNull();
      });

      it("purges expired codes and keeps fresh ones", async () => {
        await db.createDeviceCode({
          device_code_hash: "dch-old",
          user_code_hash: "uch-old",
          code_challenge: "chal-old",
          expires_at: new Date(Date.now() - 10_000).toISOString(),
        });
        await db.createDeviceCode({
          device_code_hash: "dch-fresh",
          user_code_hash: "uch-fresh",
          code_challenge: "chal-fresh",
          expires_at: future(),
        });
        await db.purgeExpiredDeviceCodes();
        expect(await db.getDeviceCodeByDeviceHash("dch-old")).toBeNull();
        expect(await db.getDeviceCodeByDeviceHash("dch-fresh")).not.toBeNull();
      });
    });

    // ── Sessions (the browser session cookie store) ─────────────────────

    describe("sessions", () => {
      const future = () => new Date(Date.now() + 600_000).toISOString();
      // A real uuid: sessions.user_id is a uuid column on Postgres, which
      // rejects an arbitrary string (see the uuid-safety note at the top).
      const userId = () => fx("user-1");

      it("creates, reads, deletes a session", async () => {
        const expires = future();
        await db.createSession({ id_hash: "sess-1", user_id: userId(), expires_at: expires });

        const row = await db.getSession("sess-1");
        expect(row?.id_hash).toBe("sess-1");
        expect(row?.user_id).toBe(userId());
        expect(row?.expires_at).toBe(expires);

        await db.deleteSession("sess-1");
        expect(await db.getSession("sess-1")).toBeNull();
      });

      it("returns null for an unknown session id, without throwing", async () => {
        expect(await db.getSession("sess-nope")).toBeNull();
      });

      it("reads timestamps back as ISO strings, equal to what was written", async () => {
        // The postgres driver hands back Date objects where this contract says
        // string. Without this assertion the suite stays green with the defect
        // present — which is exactly how it went unnoticed on device_codes.
        const expires = future();
        await db.createSession({ id_hash: "sess-iso", user_id: userId(), expires_at: expires });

        const row = await db.getSession("sess-iso");
        expect(typeof row?.expires_at).toBe("string");
        expect(typeof row?.created_at).toBe("string");
        expect(row?.expires_at).toBe(expires);
      });

      it("purges expired sessions and keeps fresh ones", async () => {
        await db.createSession({
          id_hash: "sess-old",
          user_id: userId(),
          expires_at: new Date(Date.now() - 10_000).toISOString(),
        });
        await db.createSession({
          id_hash: "sess-fresh",
          user_id: userId(),
          expires_at: future(),
        });

        await db.purgeExpiredSessions();
        expect(await db.getSession("sess-old")).toBeNull();
        expect(await db.getSession("sess-fresh")).not.toBeNull();
      });
    });

    // ── Runs ────────────────────────────────────────────────────────────

    describe("runs", () => {
      it("creates, updates, and gets a completed run", async () => {
        const run = await db.createRun({
          id: fx("run-completed"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
          input: { url: "https://example.com" },
        });
        expect(run.status).toBe("running");
        expect(run.completed_at).toBeNull();

        const updated = await db.updateRun(fx("run-completed"), {
          status: "completed",
          output: { score: 85 },
          usage_prompt_tokens: 100,
          usage_completion_tokens: 50,
          usage_total_tokens: 150,
          usage_estimated_cost: 0.001,
          duration_ms: 2500,
          completed_at: new Date().toISOString(),
        });
        expect(updated?.status).toBe("completed");
        expect(updated?.output).toEqual({ score: 85 });
        expect(updated?.duration_ms).toBe(2500);
      });

      it("round-trips runner cold-start telemetry across all backends", async () => {
        const created = await db.createRun({
          id: fx("run-telemetry"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        // Fresh runs default the operator-only telemetry to null.
        expect(created.machine_id).toBeNull();
        expect(created.private_ip).toBeNull();
        expect(created.phase_timings).toBeNull();

        const phases = { create_api_ms: 12, host_schedule_pull_ms: 4800, vm_boot_ms: 3200 };
        const updated = await db.updateRun(fx("run-telemetry"), {
          machine_id: "9185707b71308e",
          private_ip: "fdaa:0:1:a7b:1:2:3:4",
          phase_timings: phases,
        });
        expect(updated?.machine_id).toBe("9185707b71308e");
        expect(updated?.private_ip).toBe("fdaa:0:1:a7b:1:2:3:4");
        expect(updated?.phase_timings).toEqual(phases);

        // Round-trips through getRun (SELECT *) — the jsonb/TEXT column survives.
        const fetched = await db.getRun(fx("run-telemetry"));
        expect(fetched?.phase_timings).toEqual(phases);
        expect(fetched?.machine_id).toBe("9185707b71308e");
      });

      it("creates and updates a failed run", async () => {
        await db.createRun({
          id: fx("run-failed"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        const updated = await db.updateRun(fx("run-failed"), {
          status: "failed",
          error: "Model not available",
          completed_at: new Date().toISOString(),
        });
        expect(updated?.status).toBe("failed");
        expect(updated?.error).toBe("Model not available");
      });

      it("getRun returns null for nonexistent", async () => {
        expect(await db.getRun(fx("nonexistent-run"))).toBeNull();
      });

      it("filters listRuns by agent_id / status / limit", async () => {
        const a1 = await db.createAgent({
          name: "ra1",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const a2 = await db.createAgent({
          name: "ra2",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });

        await db.createRun({
          id: fx("lr1"),
          agent_id: a1.id,
          agent_version: "v",
          status: "completed",
        });
        await db.createRun({
          id: fx("lr2"),
          agent_id: a1.id,
          agent_version: "v",
          status: "failed",
        });
        await db.createRun({
          id: fx("lr3"),
          agent_id: a2.id,
          agent_version: "v",
          status: "completed",
        });

        const byAgent = await db.listRuns({ agent_id: a1.id });
        expect(byAgent).toHaveLength(2);

        const byStatus = await db.listRuns({ status: "completed" });
        expect(byStatus.length).toBeGreaterThanOrEqual(2);

        const limited = await db.listRuns({ limit: 1 });
        expect(limited).toHaveLength(1);
      });

      it("getAgentRunTotals counts every run of the agent and sums its tokens, as its listed runs would", async () => {
        const counted = await db.createAgent({
          name: "tot-a",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const beside = await db.createAgent({
          name: "tot-b",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        const empty = await db.createAgent({
          name: "tot-c",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        // Every status, three callers (the owner, another account, none), and
        // runs that never reported any usage.
        const runs: Array<{
          label: string;
          status: "running" | "completed" | "failed" | "cancelled";
          user: string | null;
          tokens?: number;
        }> = [
          { label: "tot-1", status: "completed", user: fx("u"), tokens: 200 },
          { label: "tot-2", status: "failed", user: fx("user-1"), tokens: 50 },
          { label: "tot-3", status: "running", user: null },
          { label: "tot-4", status: "cancelled", user: fx("u") },
          { label: "tot-5", status: "completed", user: null, tokens: 7 },
        ];
        for (const run of runs) {
          await db.createRun({
            id: fx(run.label),
            agent_id: counted.id,
            agent_version: "ns/tot-a@1.0.0",
            user_id: run.user,
            status: run.status,
          });
          if (run.tokens !== undefined) {
            await db.updateRun(fx(run.label), { usage_total_tokens: run.tokens });
          }
        }
        await db.createRun({
          id: fx("tot-beside"),
          agent_id: beside.id,
          agent_version: "ns/tot-b@1.0.0",
          status: "completed",
        });
        await db.updateRun(fx("tot-beside"), { usage_total_tokens: 1000 });

        const totals = await db.getAgentRunTotals(counted.id);
        expect(totals).toEqual({ run_count: 5, token_count: 257 });
        const listed = await db.listRuns({ agent_id: counted.id });
        expect(totals).toEqual({
          run_count: listed.length,
          token_count: listed.reduce((sum, r) => sum + (r.usage_total_tokens ?? 0), 0),
        });
        expect(await db.getAgentRunTotals(beside.id)).toEqual({ run_count: 1, token_count: 1000 });
        expect(await db.getAgentRunTotals(empty.id)).toEqual({ run_count: 0, token_count: 0 });
      });

      it("round-trips JSON columns (input, output, files)", async () => {
        const input = { nested: { data: [1, 2, 3] } };
        const output = { items: ["a", "b"] };
        const files = [{ name: "report.pdf", size: 1024 }];

        await db.createRun({
          id: fx("json-run"),
          agent_id: null,
          agent_version: "v",
          status: "running",
          input,
        });
        await db.updateRun(fx("json-run"), { output, files });

        const run = await db.getRun(fx("json-run"));
        expect(run?.input).toEqual(input);
        expect(run?.output).toEqual(output);
        expect(run?.files).toEqual(files);
      });

      it("records api_key_id and nulls it when the key is revoked (SET NULL)", async () => {
        const user = await db.createUser({ github_id: "rk-1", username: "rk-1" });
        const key = await db.createApiKey({
          user_id: user.id,
          key_hash: "h-run-key",
          key_prefix: "sk_",
          name: "runner",
          scopes: ["agent:run"],
        });
        await db.createRun({
          id: fx("run-keyed"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
          user_id: user.id,
          api_key_id: key.id,
        });
        expect((await db.getRun(fx("run-keyed")))?.api_key_id).toBe(key.id);

        // A session/dev-token run carries no key.
        await db.createRun({
          id: fx("run-nokey"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        expect((await db.getRun(fx("run-nokey")))?.api_key_id).toBeNull();

        // Revoking the key preserves the run row but drops the link.
        await db.deleteApiKey(key.id);
        expect((await db.getRun(fx("run-keyed")))?.api_key_id).toBeNull();
      });

      // ── A run's final status is written once ─────────────────────────────

      describe("the final write of a run", () => {
        const COMPLETED_AT = "2026-04-05T06:07:08.901Z";
        const FAILED_AT = "2026-04-05T06:07:09.012Z";
        const completion = {
          status: "completed" as const,
          output: { said: "the answer" },
          error: null,
          files: [{ name: "out.txt", size: 3 }],
          purge_after: "2026-04-12T06:07:08.901Z",
          usage_prompt_tokens: 20,
          usage_completion_tokens: 10,
          usage_total_tokens: 30,
          usage_estimated_cost: 0.25,
          duration_ms: 1500,
          completed_at: COMPLETED_AT,
        };
        const failure = (error: string) => ({
          status: "failed" as const,
          error,
          completed_at: FAILED_AT,
        });
        async function running(label: string): Promise<string> {
          const id = fx(`final-${label}`);
          await db.createRun({ id, agent_id: null, agent_version: "1.0.0", status: "running" });
          return id;
        }

        it("a running row is finished: the write lands and the row comes back", async () => {
          const id = await running("once");
          const written = await db.finishRun(id, completion);
          expect(written).toMatchObject(completion);
          expect(await db.getRun(id)).toMatchObject(completion);
        });

        it("a failure after a completion writes nothing and hands back null", async () => {
          const id = await running("failed-after-completed");
          await db.finishRun(id, completion);
          const before = await db.getRun(id);
          expect(await db.finishRun(id, failure("too late"))).toBeNull();
          expect(await db.getRun(id)).toEqual(before);
        });

        it("a completion after a failure writes nothing and hands back null", async () => {
          const id = await running("completed-after-failed");
          await db.finishRun(id, failure("Model not available"));
          const before = await db.getRun(id);
          expect(await db.finishRun(id, completion)).toBeNull();
          expect(await db.getRun(id)).toEqual(before);
        });

        it("a row that does not exist hands back null", async () => {
          expect(await db.finishRun(fx("final-nobody"), completion)).toBeNull();
          expect(await db.getRun(fx("final-nobody"))).toBeNull();
        });

        it("the stop's provisional failure is replaced by a completion that asks for it", async () => {
          const id = await running("provisional-replaced");
          await db.finishRun(id, failure(SHUTDOWN_RUN_ERROR));
          const written = await db.finishRun(id, completion, { replaceShutdownProvisional: true });
          expect(written).toMatchObject(completion);
          expect(await db.getRun(id)).toMatchObject(completion);
        });

        it("the stop's provisional failure is never replaced by a completion that does not ask", async () => {
          const id = await running("provisional-kept");
          await db.finishRun(id, failure(SHUTDOWN_RUN_ERROR));
          const before = await db.getRun(id);
          expect(await db.finishRun(id, completion)).toBeNull();
          expect(await db.getRun(id)).toEqual(before);
        });

        it("the stop's provisional failure is never replaced by a failure, even one that asks", async () => {
          const id = await running("provisional-not-by-failure");
          await db.finishRun(id, failure(SHUTDOWN_RUN_ERROR));
          const before = await db.getRun(id);
          expect(
            await db.finishRun(id, failure("the real error"), { replaceShutdownProvisional: true }),
          ).toBeNull();
          expect(await db.getRun(id)).toEqual(before);
        });

        it("a failure of any other error is never replaced, even by a completion that asks", async () => {
          const id = await running("other-failure");
          await db.finishRun(id, failure("Model not available"));
          const before = await db.getRun(id);
          expect(
            await db.finishRun(id, completion, { replaceShutdownProvisional: true }),
          ).toBeNull();
          expect(await db.getRun(id)).toEqual(before);
        });

        it("on a row whose content was cleared, the status is written and the content is not", async () => {
          const id = await running("cleared");
          const AT = "2026-04-05T06:00:00.000Z";
          await hooks.setRunContentCleared(db, id, AT);
          // The content the row held before the write, whatever each backend
          // gives a new row (Postgres: `files` defaults to an empty list).
          const before = await db.getRun(id);
          const written = await db.finishRun(id, completion);
          const expected = {
            status: "completed",
            usage_total_tokens: 30,
            duration_ms: 1500,
            completed_at: COMPLETED_AT,
            output: before?.output,
            error: before?.error,
            files: before?.files,
            purge_after: before?.purge_after,
            content_cleared_at: AT,
          };
          expect(before?.output).toBeNull();
          expect(written).toMatchObject(expected);
          expect(await db.getRun(id)).toMatchObject(expected);
        });

        // What Postgres refuses to store — a NUL byte in `text`, the escapes JSON
        // writes for a NUL or a lone surrogate in `jsonb` — never reaches a
        // store: the row's copy of a run's content replaces them, the same way
        // whatever the store (`truncateRunContent`), so the run's end is
        // recorded. The final write is the route's own, `finalizeRun`.
        it("a final write whose output, or whose error, carries a NUL or a lone surrogate lands: the row finished, charged, its copy holding U+FFFD in their place", async () => {
          const silent = { info() {}, warn() {}, error() {} } as unknown as Logger;
          const admittedAt = new Date("2026-04-05T06:00:00.000Z");
          const now = new Date("2026-04-05T06:00:07.250Z");

          const completed = await running("unstorable-output");
          const completion = await finalizeRun(
            db,
            silent,
            completed,
            { claim: "none", admittedAt },
            {
              status: "completed",
              completion: {
                output: {
                  answer: "done\u0000",
                  lone: "a\ud800b",
                  "k\u0000": "\udc00",
                  pair: "😀",
                },
                promptTokens: 1,
                completionTokens: 2,
                totalTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCost: 0,
                durationMs: 7_000,
                files: [],
              },
              modelForCostLookup: "claude-x",
              now,
              mode: "sync",
              runtimeMode: "local",
            },
          );
          expect(completion).toMatchObject({ written: true, status: "completed" });
          expect(await db.getRun(completed)).toMatchObject({
            status: "completed",
            output: { answer: "done�", lone: "a�b", "k�": "�", pair: "😀" },
            completed_at: now.toISOString(),
            charged_ms: 7_250,
          });

          const failed = await running("unstorable-error");
          const error = "Tool failed: \u0000 and \ud800 and \udfff";
          const failure = await finalizeRun(
            db,
            silent,
            failed,
            { claim: "none", admittedAt },
            { status: "failed", error, now, mode: "sse", runtimeMode: "local" },
          );
          // The caller is told the error as the run ended on it.
          expect(failure).toMatchObject({ written: true, status: "failed", error });
          expect(await db.getRun(failed)).toMatchObject({
            status: "failed",
            error: "Tool failed: � and � and �",
            completed_at: now.toISOString(),
            charged_ms: 7_250,
          });
        });

        // A run's usage comes from its model's provider — from an endpoint an
        // agent declares, which reports what it likes. Postgres refuses a token
        // count past an `integer` or a fraction of one, and a cost past
        // `numeric(10,6)`: the row's numbers are bounded the same way whatever
        // the store, so the run's end is recorded.
        it("a completion whose usage no column holds — past an integer, a fraction, a negative, not finite — lands: the row finished, charged, its numbers bounded", async () => {
          const silent = { info() {}, warn() {}, error() {} } as unknown as Logger;
          const admittedAt = new Date("2026-04-05T06:00:00.000Z");
          const now = new Date("2026-04-05T06:00:07.250Z");
          const id = await running("unstorable-usage");

          const result = await finalizeRun(
            db,
            silent,
            id,
            { claim: "none", admittedAt },
            {
              status: "completed",
              completion: {
                output: { answer: "done" },
                promptTokens: 1.5,
                completionTokens: 2 ** 31,
                totalTokens: Number.POSITIVE_INFINITY,
                cacheReadTokens: 1e13,
                cacheWriteTokens: -4,
                estimatedCost: 123_456.789,
                durationMs: 1e12,
                files: [],
              },
              // A model whose cached reads are priced below its input: the
              // savings of 1e13 cached tokens are far past what the column holds.
              modelForCostLookup: "claude-sonnet-5-5",
              now,
              mode: "sync",
              runtimeMode: "local",
            },
          );

          expect(result).toMatchObject({ written: true, status: "completed" });
          expect(await db.getRun(id)).toMatchObject({
            status: "completed",
            output: { answer: "done" },
            completed_at: now.toISOString(),
            charged_ms: 7_250,
            usage_prompt_tokens: 2,
            usage_completion_tokens: 2_147_483_647,
            usage_total_tokens: 0,
            usage_cache_read_tokens: 2_147_483_647,
            usage_cache_write_tokens: 0,
            usage_estimated_cost: 9_999.999999,
            usage_cache_savings_usd: 9_999.999999,
            duration_ms: 2_147_483_647,
          });
        });

        // The last of the final writes carries only what the server computes:
        // once the content and the numbers are bounded, a write without content
        // is refused only for a file name the store cannot hold — a lone
        // surrogate, refused by Postgres — or by the store itself.
        it("a completion whose file list the store refuses still lands, with its status, its end and its charged time", async () => {
          const silent = { info() {}, warn() {}, error() {} } as unknown as Logger;
          const admittedAt = new Date("2026-04-05T06:00:00.000Z");
          const now = new Date("2026-04-05T06:00:07.250Z");
          const id = await running("unstorable-file-name");

          const result = await finalizeRun(
            db,
            silent,
            id,
            { claim: "none", admittedAt },
            {
              status: "completed",
              completion: {
                output: { answer: "done" },
                promptTokens: 1,
                completionTokens: 2,
                totalTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCost: 0,
                durationMs: 7_000,
                files: [{ name: "report-\ud800.txt", size: 3 }],
              },
              modelForCostLookup: "claude-x",
              now,
              mode: "sync",
              runtimeMode: "local",
            },
          );

          expect(result).toMatchObject({ written: true, status: "completed" });
          expect(await db.getRun(id)).toMatchObject({
            status: "completed",
            completed_at: now.toISOString(),
            charged_ms: 7_250,
            error: null,
          });
        });

        it("an admission whose input carries a NUL or a lone surrogate is written, its copy holding U+FFFD in their place", async () => {
          const id = fx("unstorable-input");
          const result = await db.admitRun({
            run: {
              ...truncateRunContent({
                id,
                agent_id: null,
                agent_version: "1.0.0",
                input: { q: "ask\u0000", lone: "\ud800", "k\udc00": 1 },
              }),
              user_id: fx("u"),
            },
            now: "2026-04-05T06:00:00.000Z",
            deadlineAt: "2026-04-05T06:10:00.000Z",
            windowStart: null,
            limits: {
              concurrentRuns: null,
              computeMs: null,
              fastRunsPerHour: null,
              instanceCap: null,
            },
            poolRunning: false,
          });
          expect(result.admitted).toBe(true);
          expect(await db.getRun(id)).toMatchObject({
            status: "running",
            input: { q: "ask�", lone: "�", "k�": 1 },
          });
        });

        // A row keeps no value nested deeper than 100 levels — far below what
        // Postgres `jsonb` refuses, under a code that reads as an outage. The
        // run route refuses such an input before its copy is built; past them,
        // the copy's defense is a marker that measures and writes nothing of
        // the value. The copy is the route's own (`truncateRunContent`), the
        // same whatever the store.
        it("an admission keeps an input nested 100 levels deep whole, and one nested ten thousand levels deep as the marker of a value too deep", async () => {
          const nested = (levels: number): Record<string, unknown> => {
            let value: unknown = "leaf";
            for (let level = 0; level < levels; level++) value = { n: value };
            return value as Record<string, unknown>;
          };
          const admit = (id: string, input: Record<string, unknown>) =>
            db.admitRun({
              run: {
                ...truncateRunContent({ id, agent_id: null, agent_version: "1.0.0", input }),
                user_id: fx("u"),
              },
              now: "2026-04-05T06:00:00.000Z",
              deadlineAt: "2026-04-05T06:10:00.000Z",
              windowStart: null,
              limits: {
                concurrentRuns: null,
                computeMs: null,
                fastRunsPerHour: null,
                instanceCap: null,
              },
              poolRunning: false,
            });

          const whole = fx("input-100-levels");
          expect((await admit(whole, nested(100))).admitted).toBe(true);
          expect((await db.getRun(whole))?.input).toEqual(nested(100));

          const deep = fx("input-10000-levels");
          // The copy itself never throws for a value's depth.
          expect(() =>
            truncateRunContent({ id: deep, agent_id: null, input: nested(10_000) }),
          ).not.toThrow();
          expect((await admit(deep, nested(10_000))).admitted).toBe(true);
          expect((await db.getRun(deep))?.input).toEqual({ _truncated: { bytes: 0, preview: "" } });
        });

        it("a final write whose output is nested ten thousand levels deep lands: the row finished, charged, its copy the marker of a value too deep", async () => {
          const silent = { info() {}, warn() {}, error() {} } as unknown as Logger;
          const admittedAt = new Date("2026-04-05T06:00:00.000Z");
          const now = new Date("2026-04-05T06:00:07.250Z");
          const id = await running("deep-output");
          let output: Record<string, unknown> = { answer: "done" };
          for (let level = 0; level < 10_000; level++) output = { nested: output };

          const result = await finalizeRun(
            db,
            silent,
            id,
            { claim: "none", admittedAt },
            {
              status: "completed",
              completion: {
                output,
                promptTokens: 1,
                completionTokens: 2,
                totalTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCost: 0,
                durationMs: 7_000,
                files: [],
              },
              modelForCostLookup: "claude-x",
              now,
              mode: "sync",
              runtimeMode: "local",
            },
          );

          expect(result).toMatchObject({ written: true, status: "completed" });
          expect(await db.getRun(id)).toMatchObject({
            status: "completed",
            output: { _truncated: { bytes: 0, preview: "" } },
            usage_total_tokens: 3,
            completed_at: now.toISOString(),
            charged_ms: 7_250,
          });
        });

        it("a provisional failure on a row whose content was cleared keeps no error, and is never replaced", async () => {
          const id = await running("cleared-provisional");
          await hooks.setRunContentCleared(db, id, "2026-04-05T06:00:00.000Z");
          const provisional = await db.finishRun(id, failure(SHUTDOWN_RUN_ERROR));
          expect(provisional).toMatchObject({ status: "failed", error: null });
          const before = await db.getRun(id);
          expect(
            await db.finishRun(id, completion, { replaceShutdownProvisional: true }),
          ).toBeNull();
          expect(await db.getRun(id)).toEqual(before);
        });
      });

      // ── A run names only what exists ─────────────────────────────────────

      describe("a run whose account, agent or key does not exist", () => {
        for (const [reference, field] of MISSING_RUN_REFERENCES) {
          it(`is refused when its ${reference} does not exist, and leaves no row`, async () => {
            const id = fx(`dangling-${reference}`);
            const err = await db
              .createRun({
                id,
                agent_id: null,
                agent_version: "1.0.0",
                status: "running",
                ...field,
              })
              .then(
                () => null,
                (e: unknown) => e,
              );
            expect(err, `a run naming a missing ${reference}`).not.toBeNull();
            expect(isRunReferenceRefusal(err, reference), String(err)).toBe(true);
            expect(await db.getRun(id)).toBeNull();
          });
        }
      });

      // ── The cleared mark: set by an account deletion, never at creation ──

      it("a new run carries no cleared mark, and reads back without one", async () => {
        const created = await db.createRun({
          id: fx("cleared-new"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        expect(created.content_cleared_at).toBeNull();
        expect((await db.getRun(fx("cleared-new")))?.content_cleared_at).toBeNull();
        const listed = (await db.listRuns({ limit: 50 })).find((r) => r.id === fx("cleared-new"));
        expect(listed?.content_cleared_at).toBeNull();
      });

      // ── What a run holds of its account's quotas ─────────────────────────

      it("a run written outside the admission holds no seat deadline, no charged time, no right to the pool", async () => {
        const created = await db.createRun({
          id: fx("quota-columns-new"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
        });
        const read = await db.getRun(fx("quota-columns-new"));
        const listed = (await db.listRuns({ limit: 50 })).find(
          (r) => r.id === fx("quota-columns-new"),
        );
        for (const row of [created, read, listed]) {
          expect(row).toMatchObject({ deadline_at: null, charged_ms: null, pool_entitled: false });
        }
      });

      // ── The admission: a run's row written only while there is room ──────

      describe("run admission", () => {
        /** 2026-05-04 12:00 UTC: the start of a six-hour window. */
        const T0 = Date.parse("2026-05-04T12:00:00.000Z");
        const SECOND = 1_000;
        const MINUTE = 60_000;
        const HOUR = 3_600_000;
        const iso = (ms: number): string => new Date(ms).toISOString();
        const OFF: AdmissionLimits = {
          concurrentRuns: null,
          computeMs: null,
          fastRunsPerHour: null,
          instanceCap: null,
        };

        /** What an admission came to: `admitted`, or the reason of its refusal. */
        const outcome = (result: RunAdmissionResult): string =>
          result.admitted ? "admitted" : result.reason;

        /**
         * Admit one run of `fx("u")` unless told otherwise, at `nowMs`, its
         * deadline an hour later unless given, no bound unless given.
         */
        function admit(
          label: string,
          opts: {
            userId?: string | null;
            nowMs: number;
            deadlineMs?: number;
            windowStartMs?: number;
            limits?: Partial<AdmissionLimits>;
            poolRunning?: boolean;
            run?: Partial<AdmittedRunData>;
          },
        ): Promise<RunAdmissionResult> {
          return db.admitRun({
            run: {
              id: fx(`admit-${label}`),
              agent_id: null,
              agent_version: "1.0.0",
              user_id: opts.userId === undefined ? fx("u") : opts.userId,
              input: { label },
              ...opts.run,
            },
            now: iso(opts.nowMs),
            deadlineAt: iso(opts.deadlineMs ?? opts.nowMs + HOUR),
            windowStart: opts.windowStartMs === undefined ? null : iso(opts.windowStartMs),
            limits: { ...OFF, ...opts.limits },
            poolRunning: opts.poolRunning ?? false,
          });
        }

        async function finish(label: string, endMs: number): Promise<void> {
          const written = await db.finishRun(fx(`admit-${label}`), {
            status: "completed",
            completed_at: iso(endMs),
          });
          expect(written, `the run ${label} is finished`).not.toBeNull();
        }

        async function setCharged(label: string, chargedMs: number): Promise<void> {
          await hooks.admission.setRunChargedMs(db, fx(`admit-${label}`), chargedMs);
        }

        /** How many of the labelled runs have a row. */
        async function rowsOf(labels: string[]): Promise<number> {
          const rows = await Promise.all(labels.map((label) => db.getRun(fx(`admit-${label}`))));
          return rows.filter((row) => row !== null).length;
        }

        it("two seats: of five admissions of one account at once, two are admitted and three refused for concurrency, with no row", async () => {
          const labels = [0, 1, 2, 3, 4].map((i) => `seats-${i}`);
          const results = await Promise.all(
            labels.map((label) => admit(label, { nowMs: T0, limits: { concurrentRuns: 2 } })),
          );
          expect(results.map(outcome).sort()).toEqual([
            "admitted",
            "admitted",
            "concurrency",
            "concurrency",
            "concurrency",
          ]);
          for (const result of results) {
            if (!result.admitted) expect(result.usage).toMatchObject({ seatsInUse: 2 });
          }
          expect(await rowsOf(labels)).toBe(2);
        });

        it("an instance cap of five with four seats held: of four accounts admitted at once, one is admitted and three refused for the instance", async () => {
          for (const i of [0, 1, 2, 3]) {
            expect(outcome(await admit(`held-${i}`, { userId: null, nowMs: T0 }))).toBe("admitted");
          }
          const accounts = ["u1", "u2", "user-A", "user-B"];
          const labels = accounts.map((account) => `instance-${account}`);
          const results = await Promise.all(
            accounts.map((account, i) =>
              admit(labels[i] as string, {
                userId: fx(account),
                nowMs: T0 + SECOND,
                limits: { instanceCap: 5 },
              }),
            ),
          );
          expect(results.map(outcome).sort()).toEqual([
            "admitted",
            "instance",
            "instance",
            "instance",
          ]);
          for (const result of results) {
            if (!result.admitted) expect(result.usage).toMatchObject({ instanceSeatsInUse: 5 });
          }
          expect(await rowsOf(labels)).toBe(1);
        });

        it("a running row holds its seat until its deadline, and none past it", async () => {
          await admit("deadline-held", { nowMs: T0, deadlineMs: T0 + MINUTE });
          const before = await admit("deadline-before", {
            nowMs: T0 + 30 * SECOND,
            limits: { concurrentRuns: 1 },
          });
          expect(outcome(before)).toBe("concurrency");
          const after = await admit("deadline-after", {
            nowMs: T0 + 2 * MINUTE,
            limits: { concurrentRuns: 1 },
          });
          expect(outcome(after)).toBe("admitted");
          expect(after.usage).toMatchObject({ seatsInUse: 0 });
        });

        it("a running row without a deadline holds no seat and counts no time", async () => {
          await db.createRun({
            id: fx("admit-no-deadline"),
            agent_id: null,
            agent_version: "1.0.0",
            status: "running",
            user_id: fx("u"),
            created_at: iso(T0),
          });
          const result = await admit("after-no-deadline", {
            nowMs: T0 + MINUTE,
            windowStartMs: T0,
            limits: { concurrentRuns: 1, computeMs: 1 },
          });
          expect(outcome(result)).toBe("admitted");
          expect(result.usage).toMatchObject({ seatsInUse: 0, computeUsedMs: 0 });
        });

        it("on the instance too, a running row past its deadline or without one holds no place: a cap of two with one live seat admits, and the instance reads one", async () => {
          // In flight at 12:02: a live seat, two past their deadline (one of
          // them without an account), and one written without a deadline.
          await admit("instance-live", { userId: fx("u1"), nowMs: T0 });
          await admit("instance-expired", {
            userId: fx("u2"),
            nowMs: T0,
            deadlineMs: T0 + MINUTE,
          });
          await admit("instance-expired-anon", {
            userId: null,
            nowMs: T0,
            deadlineMs: T0 + MINUTE,
          });
          await db.createRun({
            id: fx("admit-instance-no-deadline"),
            agent_id: null,
            agent_version: "1.0.0",
            status: "running",
            user_id: fx("user-A"),
            created_at: iso(T0),
          });
          const now = T0 + 2 * MINUTE;
          const read = await db.getAccountUsage(fx("u2"), {
            now: iso(now),
            windowStart: null,
            fastSince: null,
            instance: true,
          });
          expect(read).toMatchObject({ seatsInUse: 0, instanceSeatsInUse: 1 });
          const result = await admit("instance-new", {
            userId: fx("user-B"),
            nowMs: now,
            limits: { instanceCap: 2 },
          });
          expect(outcome(result)).toBe("admitted");
          expect(result.usage).toMatchObject({ instanceSeatsInUse: 1 });
          // The run just admitted holds its place; the other three still none.
          const after = await db.getAccountUsage(fx("u2"), {
            now: iso(now),
            windowStart: null,
            fastSince: null,
            instance: true,
          });
          expect(after).toMatchObject({ seatsInUse: 0, instanceSeatsInUse: 2 });
        });

        it("ten seconds charged since the window began at 12:00 and a quota of ten: at 13:00 the run is refused for compute, and nothing is written", async () => {
          await admit("compute-first", { nowMs: T0 });
          await finish("compute-first", T0 + 10 * SECOND);
          const refused = await admit("compute-refused", {
            nowMs: T0 + HOUR,
            windowStartMs: T0,
            limits: { computeMs: 10_000 },
          });
          expect(outcome(refused)).toBe("compute");
          expect(refused.usage).toMatchObject({ computeUsedMs: 10_000 });
          expect(await rowsOf(["compute-refused"])).toBe(0);
          // A millisecond more of quota, and the same instant admits: reaching the limit refuses.
          const admitted = await admit("compute-admitted", {
            nowMs: T0 + HOUR,
            windowStartMs: T0,
            limits: { computeMs: 10_001 },
          });
          expect(outcome(admitted)).toBe("admitted");
        });

        it("a run of the window before counts nothing; a run in flight counts its time so far: admitted at 13:00, refused two seconds later", async () => {
          const now = T0 + HOUR;
          // Created at 11:59, finished at 12:30: it belongs to the window before.
          await admit("previous-window", { nowMs: T0 - MINUTE });
          await finish("previous-window", T0 + 30 * MINUTE);
          // In flight since eight seconds before now, its deadline an hour away.
          await admit("in-flight", { nowMs: now - 8 * SECOND });
          const limits = { computeMs: 10_000 };
          const first = await admit("at-now", { nowMs: now, windowStartMs: T0, limits });
          expect(outcome(first)).toBe("admitted");
          expect(first.usage).toMatchObject({ computeUsedMs: 8_000 });
          const second = await admit("two-seconds-later", {
            nowMs: now + 2 * SECOND,
            windowStartMs: T0,
            limits,
          });
          expect(outcome(second)).toBe("compute");
          // The run in flight: ten seconds; the one admitted at now: two.
          expect(second.usage).toMatchObject({ computeUsedMs: 12_000 });
        });

        // Past its deadline a run still `running` would have written its status
        // had its process lived: its process died, and nothing of it is charged.
        it("a run in flight counts its time so far before its deadline; past it, it counts nothing, and an account at its compute limit is admitted again", async () => {
          await admit("orphan", { nowMs: T0, deadlineMs: T0 + 5 * SECOND });
          const usageAt = (ms: number) =>
            db.getAccountUsage(fx("u"), { now: iso(ms), windowStart: iso(T0), fastSince: null });
          // A second before its deadline: four seconds so far, its seat held.
          expect(await usageAt(T0 + 4 * SECOND)).toMatchObject({
            seatsInUse: 1,
            computeUsedMs: 4_000,
          });
          // At its deadline: no seat, no time.
          expect(await usageAt(T0 + 5 * SECOND)).toMatchObject({ seatsInUse: 0, computeUsedMs: 0 });
          // An hour later, in the same window: still nothing.
          expect(await usageAt(T0 + HOUR)).toMatchObject({ seatsInUse: 0, computeUsedMs: 0 });
          // Its four seconds would have reached a limit of one: the admission reads nothing either.
          const admitted = await admit("after-orphan", {
            nowMs: T0 + MINUTE,
            windowStartMs: T0,
            limits: { computeMs: 1 },
          });
          expect(outcome(admitted)).toBe("admitted");
          expect(admitted.usage).toMatchObject({ seatsInUse: 0, computeUsedMs: 0 });
        });

        it("the compute sums each finished run's charged time — 0, 0 and 90 s — and a finished run without one counts its 90 s, never 0", async () => {
          for (const label of ["sum-zero-a", "sum-zero-b", "sum-charged", "sum-unset"]) {
            await admit(label, { nowMs: T0 });
            await finish(label, T0 + 90 * SECOND);
          }
          await setCharged("sum-zero-a", 0);
          await setCharged("sum-zero-b", 0);
          await setCharged("sum-charged", 90_000);
          const usage = await db.getAccountUsage(fx("u"), {
            now: iso(T0 + HOUR),
            windowStart: iso(T0),
            fastSince: null,
          });
          expect(usage.computeUsedMs).toBe(180_000);
          // The admission reads the same sum.
          const refused = await admit("sum-refused", {
            nowMs: T0 + HOUR,
            windowStartMs: T0,
            limits: { computeMs: 180_000 },
          });
          expect(outcome(refused)).toBe("compute");
          expect(refused.usage).toMatchObject({ computeUsedMs: 180_000 });
        });

        it("runs without an account are ignored by an account and counted by the instance; such a run is bounded by the instance alone", async () => {
          await admit("anon-1", { userId: null, nowMs: T0 });
          await admit("anon-2", { userId: null, nowMs: T0 });
          const bounds = { concurrentRuns: 1, instanceCap: 3 };
          const own = await admit("account-own", { nowMs: T0 + SECOND, limits: bounds });
          expect(outcome(own)).toBe("admitted");
          expect(own.usage).toMatchObject({ seatsInUse: 0, instanceSeatsInUse: 2 });
          const other = await admit("account-other", {
            userId: fx("u1"),
            nowMs: T0 + 2 * SECOND,
            limits: bounds,
          });
          expect(outcome(other)).toBe("instance");
          expect(other.usage).toMatchObject({ seatsInUse: 0, instanceSeatsInUse: 3 });
          const anon = await admit("anon-3", {
            userId: null,
            nowMs: T0 + 3 * SECOND,
            windowStartMs: T0,
            limits: { concurrentRuns: 1, computeMs: 1 },
          });
          expect(outcome(anon)).toBe("admitted");
          const usage = await db.getAccountUsage(fx("u"), {
            now: iso(T0 + 4 * SECOND),
            windowStart: null,
            fastSince: null,
            instance: true,
          });
          expect(usage).toMatchObject({ seatsInUse: 1, instanceSeatsInUse: 4 });
        });

        it("refusals come in order — compute, then seats, then the instance — the first that applies is the one given", async () => {
          // One run of the account in flight since the window's start.
          await admit("order-held", { nowMs: T0 });
          const at = { nowMs: T0 + 10 * SECOND, windowStartMs: T0 };
          const all = { concurrentRuns: 1, computeMs: 10_000, instanceCap: 1 };
          expect(outcome(await admit("order-all", { ...at, limits: all }))).toBe("compute");
          expect(
            outcome(await admit("order-seats", { ...at, limits: { ...all, computeMs: 20_000 } })),
          ).toBe("concurrency");
          expect(
            outcome(
              await admit("order-instance", {
                ...at,
                limits: { ...all, computeMs: 20_000, concurrentRuns: 2 },
              }),
            ),
          ).toBe("instance");
          expect(await rowsOf(["order-all", "order-seats", "order-instance"])).toBe(0);
        });

        for (const [path, limits] of [
          ["with no bound", {}],
          ["under a bound", { concurrentRuns: 5 }],
        ] as const) {
          it(`${path}: the row is written running, created at the process's instant, with the deadline it was given — and read back so`, async () => {
            const label = `written-${path.replace(/ /g, "-")}`;
            const deadline = "2026-05-04T12:15:51.123Z";
            const result = await admit(label, {
              nowMs: T0 + 123,
              deadlineMs: Date.parse(deadline),
              limits,
            });
            expect(result.admitted).toBe(true);
            const expected = {
              status: "running",
              created_at: iso(T0 + 123),
              deadline_at: deadline,
              charged_ms: null,
              pool_entitled: false,
              input: { label },
            };
            const read = await db.getRun(fx(`admit-${label}`));
            const listed = (await db.listRuns({ limit: 50 })).find(
              (run) => run.id === fx(`admit-${label}`),
            );
            for (const row of [result.admitted ? result.run : null, read, listed]) {
              expect(row).toMatchObject(expected);
            }
          });

          for (const [reference, field] of MISSING_RUN_REFERENCES) {
            it(`${path}: a run whose ${reference} does not exist is refused, and leaves no row`, async () => {
              const label = `dangling-${reference}-${path.replace(/ /g, "-")}`;
              const err = await admit(label, { nowMs: T0, limits, run: field }).then(
                () => null,
                (e: unknown) => e,
              );
              expect(err, `a run naming a missing ${reference}`).not.toBeNull();
              expect(isRunReferenceRefusal(err, reference), String(err)).toBe(true);
              expect(await rowsOf([label])).toBe(0);
            });
          }
        }

        it("two fast runs per rolling hour, under one run every ten minutes: exactly the runs at 0, 10, 60, 70, 120 and 130 min have the right", async () => {
          const entitled: number[] = [];
          for (let minute = 0; minute <= 130; minute += 10) {
            const result = await admit(`fast-${minute}`, {
              nowMs: T0 + minute * MINUTE,
              limits: { fastRunsPerHour: 2 },
              poolRunning: true,
            });
            if (!result.admitted) throw new Error(`the run at ${minute} min was refused`);
            expect(result.run.pool_entitled).toBe(result.poolEntitled);
            if (result.poolEntitled) entitled.push(minute);
          }
          expect(entitled).toEqual([0, 10, 60, 70, 120, 130]);
          // The rows record it; the usage counts the hour strictly.
          const recorded = (await db.listRuns({ user_id: fx("u"), limit: 50 }))
            .filter((run) => run.pool_entitled)
            .map((run) => (Date.parse(run.created_at) - T0) / MINUTE)
            .sort((a, b) => a - b);
          expect(recorded).toEqual([0, 10, 60, 70, 120, 130]);
          const now = T0 + 130 * MINUTE;
          const usage = await db.getAccountUsage(fx("u"), {
            now: iso(now),
            windowStart: null,
            fastSince: iso(now - FAST_RUN_WINDOW_MS),
            fastLimit: 2,
          });
          // At its limit, the account gets a right back when its oldest run of the hour leaves.
          expect(usage).toMatchObject({
            fastRunsUsed: 2,
            releasingFastRunAt: iso(T0 + 120 * MINUTE),
          });
        });

        it("the run whose leaving gives a right back, in the order the runs were created — not the order their rows were written or finished: the oldest of the hour's runs with the right while the account holds at most its limit, past it the one that brings it back under; a run without the right never counts, one created exactly an hour ago has left, none in the hour gives null", async () => {
          // With five an hour, the account's runs with the right at 12:00, 12:10, 12:20
          // and 12:30 — written out of that order, two of them finished before the
          // reads, so that no store hands them back in creation order by chance —,
          // one without it at 12:05; a run without an account at 12:15.
          for (const minute of [20, 0, 30, 10]) {
            const result = await admit(`back-${minute}`, {
              nowMs: T0 + minute * MINUTE,
              limits: { fastRunsPerHour: 5 },
              poolRunning: true,
            });
            expect(result.admitted && result.poolEntitled, `the run at ${minute} min`).toBe(true);
            // An admission never reads it: its usage says none, never leaves it out.
            expect(result.admitted && result.usage?.releasingFastRunAt).toBeNull();
          }
          const without = await admit("back-without", { nowMs: T0 + 5 * MINUTE });
          expect(without.admitted && without.poolEntitled).toBe(false);
          const anon = await admit("back-anon", {
            userId: null,
            nowMs: T0 + 15 * MINUTE,
            poolRunning: true,
          });
          expect(anon.admitted && anon.poolEntitled).toBe(true);
          // A finished run keeps its right; finishing it rewrites its row.
          await finish("back-0", T0 + 2 * MINUTE);
          await finish("back-20", T0 + 25 * MINUTE);
          // Planned as in service: a read that does not ask for the order gets the rows'.
          await hooks.admission.analyzeRuns(db);

          const back = async (
            nowMs: number,
            fastLimit: number,
            userId: string | null = fx("u"),
          ) => {
            const usage = await db.getAccountUsage(userId, {
              now: iso(nowMs),
              windowStart: null,
              fastSince: iso(nowMs - FAST_RUN_WINDOW_MS),
              fastLimit,
            });
            return usage.releasingFastRunAt;
          };
          // 12:59:59.999 — the four runs with the right are in the hour.
          const justBefore = T0 + HOUR - 1;
          expect(await back(justBefore, 5)).toBe(iso(T0));
          expect(await back(justBefore, 4)).toBe(iso(T0));
          expect(await back(justBefore, 2)).toBe(iso(T0 + 20 * MINUTE));
          // 13:00 — the 12:00 run, created exactly an hour ago, has left: three remain.
          const hour = T0 + HOUR;
          expect(await back(hour, 5)).toBe(iso(T0 + 10 * MINUTE));
          expect(await back(hour, 3)).toBe(iso(T0 + 10 * MINUTE));
          expect(await back(hour, 2)).toBe(iso(T0 + 20 * MINUTE));
          expect(await back(hour, 1)).toBe(iso(T0 + 30 * MINUTE));
          // A plan that includes none: no run's leaving brings the account under 0.
          expect(await back(hour, 0)).toBeNull();
          // 13:30 — none of the hour had the right.
          expect(await back(T0 + HOUR + 30 * MINUTE, 5)).toBeNull();
          // No account, no hour asked, no limit asked.
          expect(await back(hour, 5, null)).toBeNull();
          const noHour = await db.getAccountUsage(fx("u"), {
            now: iso(hour),
            windowStart: null,
            fastSince: null,
            fastLimit: 5,
          });
          expect(noHour.releasingFastRunAt).toBeNull();
          const notAsked = await db.getAccountUsage(fx("u"), {
            now: iso(hour),
            windowStart: null,
            fastSince: iso(hour - FAST_RUN_WINDOW_MS),
          });
          expect(notAsked.fastRunsUsed).toBe(3);
          // Not asked: none, never left out.
          expect(notAsked.releasingFastRunAt).toBeNull();
        });

        it("while a pool runs, a run without an account has the right, every run has it when the hourly bound is off, none when it is zero; without a pool, none has it", async () => {
          const cases: Array<[string, Parameters<typeof admit>[1], boolean]> = [
            [
              "fast-anon",
              { userId: null, nowMs: T0, limits: { fastRunsPerHour: 0 }, poolRunning: true },
              true,
            ],
            ["fast-unbounded", { nowMs: T0, poolRunning: true }, true],
            ["fast-zero", { nowMs: T0, limits: { fastRunsPerHour: 0 }, poolRunning: true }, false],
            [
              "fast-no-pool",
              { nowMs: T0, limits: { fastRunsPerHour: 2 }, poolRunning: false },
              false,
            ],
          ];
          for (const [label, opts, right] of cases) {
            const result = await admit(label, opts);
            expect(result.admitted && result.poolEntitled, label).toBe(right);
            expect((await db.getRun(fx(`admit-${label}`)))?.pool_entitled, label).toBe(right);
          }
        });

        it("with no bound and no instance cap, fifty admissions at once are all admitted, none busy, nothing read", async () => {
          const labels = Array.from({ length: 50 }, (_, i) => `open-${i}`);
          const results = await Promise.all(labels.map((label) => admit(label, { nowMs: T0 })));
          expect(results.map(outcome)).toEqual(labels.map(() => "admitted"));
          for (const result of results) expect(result.usage).toBeNull();
          expect(await rowsOf(labels)).toBe(50);
        });

        it("the usage reads only what it is asked: no window, no hour, no instance, no account", async () => {
          await admit("asked-held", { nowMs: T0, poolRunning: true });
          const at = { now: iso(T0 + MINUTE), windowStart: null, fastSince: null };
          expect(await db.getAccountUsage(fx("u"), at)).toEqual({
            seatsInUse: 1,
            computeUsedMs: 0,
            fastRunsUsed: 0,
            releasingFastRunAt: null,
            instanceSeatsInUse: null,
          });
          expect(await db.getAccountUsage(null, { ...at, instance: true })).toEqual({
            seatsInUse: 0,
            computeUsedMs: 0,
            fastRunsUsed: 0,
            releasingFastRunAt: null,
            instanceSeatsInUse: 1,
          });
        });

        it("an account deletion keeps a run's deadline, charged time and right to the pool, as it keeps its timestamps", async () => {
          const deadline = iso(T0 + 20 * MINUTE);
          await admit("kept", {
            userId: fx("user-B"),
            nowMs: T0,
            deadlineMs: Date.parse(deadline),
            limits: { fastRunsPerHour: 1 },
            poolRunning: true,
          });
          await finish("kept", T0 + MINUTE);
          await setCharged("kept", 60_000);
          const at = iso(T0 + 2 * MINUTE);
          expect(
            await db.deleteUser(fx("user-B"), { purged_output_run_ids: [], at }),
          ).not.toBeNull();
          expect(await db.getRun(fx("admit-kept"))).toMatchObject({
            user_id: null,
            input: null,
            content_cleared_at: at,
            created_at: iso(T0),
            deadline_at: deadline,
            charged_ms: 60_000,
            pool_entitled: true,
          });
        });

        it("a run's final write records the time it is charged — 0 included — and the compute sums read it, not its end minus its creation", async () => {
          await admit("charged-none", { nowMs: T0 + MINUTE });
          await admit("charged-some", { nowMs: T0 + 2 * MINUTE });
          const none = await db.finishRun(fx("admit-charged-none"), {
            status: "failed",
            completed_at: iso(T0 + 2 * MINUTE),
            charged_ms: 0,
          });
          const some = await db.finishRun(fx("admit-charged-some"), {
            status: "completed",
            completed_at: iso(T0 + 5 * MINUTE),
            charged_ms: 90 * SECOND,
          });
          expect(none?.charged_ms).toBe(0);
          expect(some?.charged_ms).toBe(90_000);
          expect((await db.getRun(fx("admit-charged-none")))?.charged_ms).toBe(0);
          // Their ends minus their creations would be 60 s and 180 s.
          const usage = await db.getAccountUsage(fx("u"), {
            now: iso(T0 + 10 * MINUTE),
            windowStart: iso(T0),
            fastSince: null,
          });
          expect(usage.computeUsedMs).toBe(90_000);
        });

        // ── A right to a pooled machine given back: once, while the row holds it ──

        it("a right given back: the row loses it and nothing else, the hour counts one fast run fewer, the run whose leaving gives a right back moves, and the account's next admission gets one", async () => {
          const fast = { limits: { fastRunsPerHour: 2 }, poolRunning: true };
          const first = await admit("give-back-0", { nowMs: T0, ...fast });
          const without = await admit("give-back-without", { nowMs: T0 + 5 * MINUTE });
          const second = await admit("give-back-10", { nowMs: T0 + 10 * MINUTE, ...fast });
          expect(first.admitted && first.poolEntitled).toBe(true);
          expect(without.admitted && without.poolEntitled).toBe(false);
          expect(second.admitted && second.poolEntitled).toBe(true);
          const at = T0 + 15 * MINUTE;
          const usageWith = (fastLimit: number) =>
            db.getAccountUsage(fx("u"), {
              now: iso(at),
              windowStart: null,
              fastSince: iso(at - FAST_RUN_WINDOW_MS),
              fastLimit,
            });
          expect(await usageWith(2)).toMatchObject({
            fastRunsUsed: 2,
            releasingFastRunAt: iso(T0),
          });
          // Past a limit of one, the 12:10 run is the one whose leaving gives a right back.
          expect((await usageWith(1)).releasingFastRunAt).toBe(iso(T0 + 10 * MINUTE));
          const before = structuredClone(await db.getRun(fx("admit-give-back-10")));
          expect(before?.pool_entitled).toBe(true);

          expect(await db.returnPoolRight(fx("admit-give-back-10"))).toBe(true);

          // The row loses its right, and nothing else of it moves.
          expect(await db.getRun(fx("admit-give-back-10"))).toEqual({
            ...before,
            pool_entitled: false,
          });
          // The hour counts one fast run fewer, and the 12:10 run no longer takes part.
          expect(await usageWith(2)).toMatchObject({
            fastRunsUsed: 1,
            releasingFastRunAt: iso(T0),
          });
          expect((await usageWith(1)).releasingFastRunAt).toBe(iso(T0));
          // The account's next admission gets the right the run gave back.
          const next = await admit("give-back-20", { nowMs: T0 + 20 * MINUTE, ...fast });
          expect(next.admitted && next.poolEntitled).toBe(true);
          expect((await db.getRun(fx("admit-give-back-20")))?.pool_entitled).toBe(true);
        });

        it("a right is given back once, and only while the row holds it: a second time, a run that never had it and a run that does not exist give nothing back and write nothing", async () => {
          await admit("once", { nowMs: T0, limits: { fastRunsPerHour: 2 }, poolRunning: true });
          await admit("once-without", { nowMs: T0 + MINUTE });
          expect(await db.returnPoolRight(fx("admit-once"))).toBe(true);
          const givenBack = structuredClone(await db.getRun(fx("admit-once")));
          const neverHad = structuredClone(await db.getRun(fx("admit-once-without")));
          expect(givenBack?.pool_entitled).toBe(false);
          expect(neverHad?.pool_entitled).toBe(false);

          expect(await db.returnPoolRight(fx("admit-once")), "a second time").toBe(false);
          expect(
            await db.returnPoolRight(fx("admit-once-without")),
            "a run that never had it",
          ).toBe(false);
          expect(
            await db.returnPoolRight(fx("admit-once-missing")),
            "a run that does not exist",
          ).toBe(false);

          expect(await db.getRun(fx("admit-once"))).toEqual(givenBack);
          expect(await db.getRun(fx("admit-once-without"))).toEqual(neverHad);
          expect(await db.getRun(fx("admit-once-missing"))).toBeNull();
        });

        it("a finished run still gives its right back — nothing is asked of its status — and so does a run whose account was deleted", async () => {
          const fast = { limits: { fastRunsPerHour: 2 }, poolRunning: true };
          await admit("finished", { nowMs: T0, ...fast });
          const finished = await db.finishRun(fx("admit-finished"), {
            status: "completed",
            completed_at: iso(T0 + MINUTE),
            charged_ms: 30 * SECOND,
          });
          expect(finished).toMatchObject({
            status: "completed",
            charged_ms: 30_000,
            pool_entitled: true,
          });
          const before = structuredClone(await db.getRun(fx("admit-finished")));
          expect(await db.returnPoolRight(fx("admit-finished"))).toBe(true);
          expect(await db.getRun(fx("admit-finished"))).toEqual({
            ...before,
            pool_entitled: false,
          });

          await admit("orphaned", { userId: fx("user-B"), nowMs: T0, ...fast });
          expect(
            await db.deleteUser(fx("user-B"), { purged_output_run_ids: [], at: iso(T0 + MINUTE) }),
          ).not.toBeNull();
          const orphan = structuredClone(await db.getRun(fx("admit-orphaned")));
          expect(orphan).toMatchObject({ user_id: null, pool_entitled: true });
          expect(await db.returnPoolRight(fx("admit-orphaned"))).toBe(true);
          expect(await db.getRun(fx("admit-orphaned"))).toEqual({
            ...orphan,
            pool_entitled: false,
          });
        });

        // One fast run an hour, and a right given back beside an admission of the
        // same account: whichever comes first, the hour never holds two rights.
        // (On Postgres, the two at once — the admission holding the account's
        // lock while the right is given back — is a case of its own.)
        const fastOf = (account: string) => ({
          userId: fx(account),
          limits: { fastRunsPerHour: 1 },
          poolRunning: true,
        });
        const rightOf = (result: RunAdmissionResult) => result.admitted && result.poolEntitled;
        const heldInTheHour = async (account: string, nowMs: number) =>
          (
            await db.getAccountUsage(fx(account), {
              now: iso(nowMs),
              windowStart: null,
              fastSince: iso(nowMs - FAST_RUN_WINDOW_MS),
            })
          ).fastRunsUsed;

        it("one fast run an hour, the right given back before the account's next admission: that admission gets it, and the hour never holds two", async () => {
          const a = await admit("u1-a", { nowMs: T0, ...fastOf("u1") });
          expect(rightOf(a), "A").toBe(true);
          expect(await heldInTheHour("u1", T0)).toBe(1);
          expect(await db.returnPoolRight(fx("admit-u1-a"))).toBe(true);
          expect(await heldInTheHour("u1", T0 + MINUTE)).toBe(0);
          const b = await admit("u1-b", { nowMs: T0 + MINUTE, ...fastOf("u1") });
          expect(rightOf(b), "B, admitted once A gave its right back").toBe(true);
          expect(await heldInTheHour("u1", T0 + MINUTE)).toBe(1);
        });

        it("one fast run an hour, an admission while the right is still held, then the right given back: that admission gets none, the one after does, and the hour never holds two", async () => {
          const a = await admit("u2-a", { nowMs: T0, ...fastOf("u2") });
          expect(rightOf(a), "A").toBe(true);
          const b = await admit("u2-b", { nowMs: T0 + MINUTE, ...fastOf("u2") });
          expect(rightOf(b), "B, admitted while A holds the right").toBe(false);
          expect(b.usage).toMatchObject({ fastRunsUsed: 1 });
          expect(await heldInTheHour("u2", T0 + MINUTE)).toBe(1);
          expect(await db.returnPoolRight(fx("admit-u2-a"))).toBe(true);
          expect(await heldInTheHour("u2", T0 + 2 * MINUTE)).toBe(0);
          const c = await admit("u2-c", { nowMs: T0 + 2 * MINUTE, ...fastOf("u2") });
          expect(rightOf(c), "C, admitted once A gave its right back").toBe(true);
          expect(await heldInTheHour("u2", T0 + 2 * MINUTE)).toBe(1);
        });
      });

      // ── Output retention: the purge deadline and the purge mark ──────────

      describe("run output retention", () => {
        const now = "2026-09-25T12:00:00.000Z";

        /** A completed run holding one output file and the given purge deadline. */
        async function completedRun(label: string, purgeAfter: string | null): Promise<void> {
          await db.createRun({
            id: fx(label),
            agent_id: null,
            agent_version: "1.0.0",
            status: "running",
          });
          await db.updateRun(fx(label), {
            status: "completed",
            files: [{ name: `${label}.txt`, size: 1 }],
            completed_at: "2026-09-25T08:00:00.000Z",
            purge_after: purgeAfter,
          });
        }

        it("a new run has neither a purge deadline nor a purge mark", async () => {
          const created = await db.createRun({
            id: fx("retention-new"),
            agent_id: null,
            agent_version: "1.0.0",
            status: "running",
          });
          expect(created.purge_after).toBeNull();
          expect(created.outputs_purged_at).toBeNull();

          const fetched = await db.getRun(fx("retention-new"));
          expect(fetched?.purge_after).toBeNull();
          expect(fetched?.outputs_purged_at).toBeNull();
        });

        it("writes the purge deadline in the same update as the files and the completion time", async () => {
          const files = [
            { name: "a.txt", size: 1 },
            { name: "d/b.csv", size: 2 },
          ];
          const completedAt = "2026-09-25T10:00:00.000Z";
          const purgeAfter = "2026-09-25T11:00:00.000Z";
          await db.createRun({
            id: fx("retention-write"),
            agent_id: null,
            agent_version: "1.0.0",
            status: "running",
          });

          const updated = await db.updateRun(fx("retention-write"), {
            files,
            completed_at: completedAt,
            purge_after: purgeAfter,
          });
          expect(updated?.files).toEqual(files);
          expect(updated?.completed_at).toBe(completedAt);
          expect(updated?.purge_after).toBe(purgeAfter);

          const fetched = await db.getRun(fx("retention-write"));
          expect(fetched?.files).toEqual(files);
          expect(fetched?.completed_at).toBe(completedAt);
          expect(fetched?.purge_after).toBe(purgeAfter);
          expect(fetched?.outputs_purged_at).toBeNull();
        });

        it("selects the runs past their deadline and not yet purged, oldest deadline first, with their files", async () => {
          // Created in an order that is neither the deadline order nor its reverse.
          await completedRun("retention-due-late", "2026-09-25T11:30:00.000Z");
          await completedRun("retention-future", "2026-09-25T12:00:01.000Z");
          await completedRun("retention-due-early", "2026-09-25T09:00:00.000Z");
          await completedRun("retention-no-deadline", null);
          await completedRun("retention-due-now", now);
          await completedRun("retention-marked", "2026-09-25T08:30:00.000Z");
          await db.markRunOutputsPurged(fx("retention-marked"), "2026-09-25T08:35:00.000Z");

          const due = await db.listRunsDueForOutputPurge(now, 10);

          // A deadline equal to now is due; a future one, a missing one and a
          // marked run are not.
          expect(due.map((r) => r.id)).toEqual([
            fx("retention-due-early"),
            fx("retention-due-late"),
            fx("retention-due-now"),
          ]);
          // Each element carries the id and the files, from which the object
          // keys are rebuilt — and nothing else.
          expect(due[0]).toEqual({
            id: fx("retention-due-early"),
            files: [{ name: "retention-due-early.txt", size: 1 }],
          });
        });

        it("returns at most the limit, the oldest deadlines first", async () => {
          await completedRun("retention-limit-2", "2026-09-25T10:00:00.000Z");
          await completedRun("retention-limit-3", "2026-09-25T11:00:00.000Z");
          await completedRun("retention-limit-1", "2026-09-25T09:00:00.000Z");

          const firstTwo = await db.listRunsDueForOutputPurge(now, 2);
          expect(firstTwo.map((r) => r.id)).toEqual([
            fx("retention-limit-1"),
            fx("retention-limit-2"),
          ]);
        });

        it("keeps the first purge mark, and a marked run leaves the selection", async () => {
          await completedRun("retention-mark", "2026-09-25T09:00:00.000Z");
          expect((await db.listRunsDueForOutputPurge(now, 10)).map((r) => r.id)).toEqual([
            fx("retention-mark"),
          ]);

          const first = "2026-09-25T12:00:05.000Z";
          await db.markRunOutputsPurged(fx("retention-mark"), first);
          // A second instance purging the same run marks it again: no error, and
          // the first mark stands.
          await db.markRunOutputsPurged(fx("retention-mark"), "2026-09-25T12:05:00.000Z");

          const row = await db.getRun(fx("retention-mark"));
          expect(row?.outputs_purged_at).toBe(first);
          expect(await db.listRunsDueForOutputPurge(now, 10)).toEqual([]);
        });
      });
    });

    // ── Deleting an account: erase, clear, detach, keep nothing more ─────

    describe("account deletion", () => {
      const AT = "2026-03-04T05:06:07.890Z";
      const PURGE_AFTER = "2026-03-01T00:00:00.000Z";
      const EXPIRES = "2099-05-06T07:08:09.123Z";
      const FILES_R1 = [{ name: "a.txt", size: 1 }];
      const FILES_R6 = [{ name: "d/b.csv", size: 2 }];
      const sortIds = (ids: string[]) => [...ids].sort();

      /**
       * Account A ("alice") and account B ("bob"), with one row of each sort
       * an account holds. A owns agent T (two versions, a creator LLM key), a
       * delegated key granted T, an account key, a session, an authorised
       * device code, an environment. Notebooks: T's shared one; in B's agent O,
       * A's own, the one of A's key, and the shared one A wrote. B owns O (one
       * version), a key, a session, a device code, an environment, its own
       * notebook in O. Runs: r1 A on T (completed, outputs waiting for their
       * purge — the ones a deletion deletes first), r2 B on T, r3 A on O, r4 A
       * on T still running (under A's environment), r5 B on O, r6 A on T
       * completed with outputs no one deleted yet.
       */
      async function seedTwoAccounts() {
        const a = await db.createUser({ github_id: "gh-del-a", username: "alice" });
        const b = await db.createUser({ github_id: "gh-del-b", username: "bob" });
        const t = await db.createAgent({
          name: "tool",
          namespace: "alice",
          description: "",
          owner_id: a.id,
        });
        const o = await db.createAgent({
          name: "other",
          namespace: "bob",
          description: "",
          owner_id: b.id,
        });
        await db.createVersion(t.id, {
          version: "1.0.0",
          size: 1,
          bundle_key: "alice/tool/1.0.0.agent",
        });
        await db.createVersion(t.id, {
          version: "2.0.0",
          size: 2,
          bundle_key: "alice/tool/2.0.0.agent",
        });
        await db.createVersion(o.id, {
          version: "1.0.0",
          size: 3,
          bundle_key: "bob/other/1.0.0.agent",
        });
        await db.setAgentLlmKey(t.id, "anthropic", "cipher-del", "••1234", 1);
        const aDelegated = await db.createApiKey({
          user_id: a.id,
          key_hash: "del-hash-a-delegated",
          key_prefix: "skrun_sk_dd",
          name: "delegated",
          scopes: ["agent:run"],
          scope_kind: "agents",
          agents: [t.id],
        });
        const aAccount = await db.createApiKey({
          user_id: a.id,
          key_hash: "del-hash-a-account",
          key_prefix: "skrun_sk_da",
          name: "account",
        });
        const bKey = await db.createApiKey({
          user_id: b.id,
          key_hash: "del-hash-b",
          key_prefix: "skrun_sk_db",
          name: "b",
        });
        await db.createSession({ id_hash: "del-sess-a", user_id: a.id, expires_at: EXPIRES });
        await db.createSession({ id_hash: "del-sess-b", user_id: b.id, expires_at: EXPIRES });
        for (const [who, user] of [
          ["a", a],
          ["b", b],
        ] as const) {
          await db.createDeviceCode({
            device_code_hash: `del-dc-${who}`,
            user_code_hash: `del-uc-${who}`,
            code_challenge: "chal",
            expires_at: EXPIRES,
          });
          await db.authorizeDeviceCode(`del-uc-${who}`, user.id);
        }
        const envA = await db.createEnvironment({ name: "env-a", owner_id: a.id, config: {} });
        const envB = await db.createEnvironment({ name: "env-b", owner_id: b.id, config: {} });
        await db.setState(t.id, { kind: "shared" }, { on: "t shared" }, EXPIRES);
        await db.setState(o.id, { kind: "account", userId: a.id }, { on: "o alice" }, EXPIRES);
        await db.setState(
          o.id,
          { kind: "key", keyId: aAccount.id },
          { on: "o alice key" },
          EXPIRES,
        );
        await db.setState(o.id, { kind: "shared" }, { on: "o shared, written by alice" }, EXPIRES);
        await db.setState(o.id, { kind: "account", userId: b.id }, { on: "o bob" }, EXPIRES);

        const run = async (
          tag: string,
          data: {
            agent_id: string;
            agent_version: string;
            user_id: string;
            api_key_id?: string;
            environment_id?: string;
            status: "running" | "completed";
          },
          completion?: Parameters<DbAdapter["updateRun"]>[1],
        ) => {
          const id = fx(`del-${tag}`);
          await db.createRun({
            id,
            ...data,
            model: "gemini-2.5-flash",
            input: { asked: `${tag} input` },
          });
          if (completion) await db.updateRun(id, completion);
          return id;
        };
        const completed = (files: Record<string, unknown>[] | null, purgeAfter: string | null) => ({
          status: "completed" as const,
          output: { said: "an answer" },
          error: null,
          files,
          purge_after: purgeAfter,
          usage_prompt_tokens: 30,
          usage_completion_tokens: 12,
          usage_total_tokens: 42,
          usage_estimated_cost: 0.5,
          duration_ms: 1200,
          completed_at: "2026-03-01T00:00:00.000Z",
          machine_id: "machine-1",
          private_ip: "fdaa:0:1::2",
          phase_timings: { vm_boot_ms: 5 },
        });
        const r1 = await run(
          "r1",
          {
            agent_id: t.id,
            agent_version: "alice/tool@1.0.0",
            user_id: a.id,
            api_key_id: aAccount.id,
            status: "running",
          },
          completed(FILES_R1, PURGE_AFTER),
        );
        const r2 = await run(
          "r2",
          { agent_id: t.id, agent_version: "alice/tool@2.0.0", user_id: b.id, status: "running" },
          { ...completed(null, null), error: "a failure message" },
        );
        const r3 = await run(
          "r3",
          { agent_id: o.id, agent_version: "bob/other@1.0.0", user_id: a.id, status: "running" },
          completed(null, null),
        );
        const r4 = await run("r4", {
          agent_id: t.id,
          agent_version: "alice/tool@2.0.0",
          user_id: a.id,
          api_key_id: aDelegated.id,
          environment_id: envA.id,
          status: "running",
        });
        const r5 = await run(
          "r5",
          {
            agent_id: o.id,
            agent_version: "bob/other@1.0.0",
            user_id: b.id,
            api_key_id: bKey.id,
            environment_id: envB.id,
            status: "running",
          },
          completed([{ name: "kept.txt", size: 9 }], PURGE_AFTER),
        );
        const r6 = await run(
          "r6",
          { agent_id: t.id, agent_version: "alice/tool@1.0.0", user_id: a.id, status: "running" },
          completed(FILES_R6, PURGE_AFTER),
        );
        return { a, b, t, o, aDelegated, aAccount, bKey, envA, envB, r1, r2, r3, r4, r5, r6 };
      }

      /** A copy of each row: the memory backend hands back the stored object itself. */
      async function runsById(ids: string[]) {
        const rows = await Promise.all(ids.map((id) => db.getRun(id)));
        return Object.fromEntries(ids.map((id, i) => [id, structuredClone(rows[i])]));
      }

      it("deletes every row the account holds, and the notebooks written under it or its keys elsewhere", async () => {
        const s = await seedTwoAccounts();

        await db.deleteUser(s.a.id, { purged_output_run_ids: [s.r1], at: AT });

        expect(await db.getUserById(s.a.id)).toBeNull();
        expect(await db.getUserByGithubId("gh-del-a")).toBeNull();
        expect(await db.getApiKeyByHash("del-hash-a-delegated")).toBeNull();
        expect(await db.getApiKeyByHash("del-hash-a-account")).toBeNull();
        expect(await db.getApiKeyAgentIds(s.aDelegated.id)).toEqual([]);
        expect(await db.getSession("del-sess-a")).toBeNull();
        expect(await db.getDeviceCodeByDeviceHash("del-dc-a")).toBeNull();
        expect(await db.getAgent("alice", "tool")).toBeNull();
        expect(await db.getVersions(s.t.id)).toEqual([]);
        expect(await db.listAgentLlmKeys(s.t.id)).toEqual([]);
        expect(await db.getEnvironment(s.envA.id)).toBeNull();
        expect(await db.listEnvironments(s.a.id)).toEqual([]);
        expect(await db.getState(s.t.id, { kind: "shared" })).toBeNull();
        expect(await db.getState(s.o.id, { kind: "account", userId: s.a.id })).toBeNull();
        expect(await db.getState(s.o.id, { kind: "key", keyId: s.aAccount.id })).toBeNull();

        // The other account keeps everything, the shared notebook A wrote in
        // B's agent included: it belongs to the agent, not to its writer.
        expect((await db.getUserById(s.b.id))?.username).toBe("bob");
        expect((await db.getApiKeyByHash("del-hash-b"))?.id).toBe(s.bKey.id);
        expect((await db.getSession("del-sess-b"))?.user_id).toBe(s.b.id);
        expect((await db.getDeviceCodeByDeviceHash("del-dc-b"))?.user_id).toBe(s.b.id);
        expect((await db.getAgent("bob", "other"))?.id).toBe(s.o.id);
        expect((await db.getVersions(s.o.id)).map((v) => v.bundle_key)).toEqual([
          "bob/other/1.0.0.agent",
        ]);
        expect((await db.getEnvironment(s.envB.id))?.name).toBe("env-b");
        expect((await db.getState(s.o.id, { kind: "shared" }))?.state).toEqual({
          on: "o shared, written by alice",
        });
        expect((await db.getState(s.o.id, { kind: "account", userId: s.b.id }))?.state).toEqual({
          on: "o bob",
        });
      });

      it("removes exactly the account's rows and writes none: no table gains a row", async () => {
        const s = await seedTwoAccounts();
        const before = await hooks.countRows(db);

        await db.deleteUser(s.a.id, { purged_output_run_ids: [s.r1], at: AT });

        const after = await hooks.countRows(db);
        const removed = Object.fromEntries(
          Object.keys(before).map((table) => [table, before[table] - after[table]]),
        );
        expect(removed).toEqual({
          users: 1,
          api_keys: 2,
          api_key_agents: 1,
          agents: 1,
          agent_versions: 2,
          agent_llm_keys: 1,
          agent_state: 3,
          environments: 1,
          device_codes: 1,
          sessions: 1,
          runs: 0,
        });
      });

      it("clears and marks the account's runs and its agents' runs, detaches them, and touches no other run", async () => {
        const s = await seedTwoAccounts();
        const ids = [s.r1, s.r2, s.r3, s.r4, s.r5, s.r6];
        const before = await runsById(ids);

        await db.deleteUser(s.a.id, { purged_output_run_ids: [s.r1], at: AT });

        const after = await runsById(ids);
        const cleared = {
          input: null,
          output: null,
          error: null,
          files: [],
          content_cleared_at: AT,
        };
        // Usage, model, status, durations, timestamps and telemetry stay: only
        // the content goes, and the references to what was deleted.
        expect(after[s.r1]).toEqual({
          ...before[s.r1],
          ...cleared,
          agent_version: "@1.0.0",
          user_id: null,
          agent_id: null,
          api_key_id: null,
          outputs_purged_at: AT,
        });
        expect(after[s.r2]).toEqual({
          ...before[s.r2],
          ...cleared,
          agent_version: "@2.0.0",
          agent_id: null,
        });
        expect(after[s.r3]).toEqual({ ...before[s.r3], ...cleared, user_id: null });
        expect(after[s.r4]).toEqual({
          ...before[s.r4],
          ...cleared,
          agent_version: "@2.0.0",
          user_id: null,
          agent_id: null,
          api_key_id: null,
          environment_id: null,
        });
        expect(after[s.r6]).toEqual({
          ...before[s.r6],
          ...cleared,
          agent_version: "@1.0.0",
          user_id: null,
          agent_id: null,
        });
        expect(after[s.r5]).toEqual(before[s.r5]);
        expect(before[s.r5]?.input).toEqual({ asked: "r5 input" });
      });

      it("drops the namespace and the agent's name from the version a run names, only for the account's agents", async () => {
        const s = await seedTwoAccounts();

        await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

        // A on its own agent, B on A's agent: the name goes. A on B's agent:
        // the address of another account's agent is not the account's data.
        expect((await db.getRun(s.r1))?.agent_version).toBe("@1.0.0");
        expect((await db.getRun(s.r2))?.agent_version).toBe("@2.0.0");
        expect((await db.getRun(s.r3))?.agent_version).toBe("bob/other@1.0.0");
      });

      it("keeps the version a run names when its agent is another account's, even under the account's namespace", async () => {
        const s = await seedTwoAccounts();
        // B's agent under the name `alice`: the version text starts with the
        // deleted account's namespace, but the agent is not the account's.
        const squat = await db.createAgent({
          name: "squat",
          namespace: "alice",
          description: "",
          owner_id: s.b.id,
        });
        const id = fx("del-r7");
        await db.createRun({
          id,
          agent_id: squat.id,
          agent_version: "alice/squat@1.0.0",
          user_id: s.a.id,
          status: "completed",
          input: { asked: "r7 input" },
        });

        await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

        expect(await db.getRun(id)).toMatchObject({
          agent_version: "alice/squat@1.0.0",
          agent_id: squat.id,
          user_id: null,
          input: null,
          content_cleared_at: AT,
        });
      });

      it("reports what it deleted, the runs it cleared, and the outputs still waiting that it was not told about", async () => {
        const s = await seedTwoAccounts();

        const result = await db.deleteUser(s.a.id, { purged_output_run_ids: [s.r1], at: AT });

        expect(result).not.toBeNull();
        expect({
          ...result,
          cleared_run_ids: sortIds(result?.cleared_run_ids ?? []),
          bundle_keys: sortIds(result?.bundle_keys ?? []),
        }).toEqual({
          agents: 1,
          versions: 2,
          api_keys: 2,
          cleared_run_ids: sortIds([s.r1, s.r2, s.r3, s.r4, s.r6]),
          late_outputs: [{ id: s.r6, files: FILES_R6 }],
          bundle_keys: ["alice/tool/1.0.0.agent", "alice/tool/2.0.0.agent"],
        });
        // The run whose objects were not deleted keeps no purge mark.
        expect((await db.getRun(s.r6))?.outputs_purged_at).toBeNull();
      });

      it("plans the storage to clear: bundle keys, outputs waiting for their purge, a namespace of its own", async () => {
        const s = await seedTwoAccounts();

        const plan = await db.planUserDeletion(s.a.id);

        expect(plan).not.toBeNull();
        expect({
          ...plan,
          bundle_keys: sortIds(plan?.bundle_keys ?? []),
          pending_outputs: [...(plan?.pending_outputs ?? [])].sort((x, y) =>
            x.id.localeCompare(y.id),
          ),
        }).toEqual({
          username: "alice",
          bundle_keys: ["alice/tool/1.0.0.agent", "alice/tool/2.0.0.agent"],
          pending_outputs: [
            { id: s.r1, files: FILES_R1 },
            { id: s.r6, files: FILES_R6 },
          ].sort((x, y) => x.id.localeCompare(y.id)),
          namespace_shared: false,
        });
        // A plan reads only.
        expect((await db.getUserById(s.a.id))?.username).toBe("alice");
        expect((await db.getRun(s.r1))?.files).toEqual(FILES_R1);
      });

      it("a namespace is shared when another account's agent lives under it", async () => {
        const s = await seedTwoAccounts();
        await db.createAgent({
          name: "squat",
          namespace: "alice",
          description: "",
          owner_id: s.b.id,
        });

        expect((await db.planUserDeletion(s.a.id))?.namespace_shared).toBe(true);
      });

      it("a namespace is shared when another account carries the same username, where the backend allows it", async () => {
        const s = await seedTwoAccounts();
        const twin = db.createUser({ github_id: "gh-del-twin", username: "alice" });
        if (hooks.usernameIsUnique) {
          await expect(twin).rejects.toThrow();
          expect((await db.planUserDeletion(s.a.id))?.namespace_shared).toBe(false);
          return;
        }
        await twin;
        expect((await db.planUserDeletion(s.a.id))?.namespace_shared).toBe(true);
      });

      it("an account that does not exist: no plan, no deletion — twice is not an error", async () => {
        const s = await seedTwoAccounts();
        expect(await db.planUserDeletion(fx("del-nobody"))).toBeNull();
        expect(
          await db.deleteUser(fx("del-nobody"), { purged_output_run_ids: [], at: AT }),
        ).toBeNull();

        expect(await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT })).not.toBeNull();
        expect(await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT })).toBeNull();
        expect(await db.planUserDeletion(s.a.id)).toBeNull();
      });

      it("a namespace is in use while an account carries it or an agent lives under it", async () => {
        const s = await seedTwoAccounts();
        expect(await db.namespaceInUse("alice")).toBe(true);
        expect(await db.namespaceInUse("nobody-here")).toBe(false);

        await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });
        expect(await db.namespaceInUse("alice")).toBe(false);

        // An agent alone keeps it in use.
        await db.createAgent({
          name: "late",
          namespace: "alice",
          description: "",
          owner_id: s.b.id,
        });
        expect(await db.namespaceInUse("alice")).toBe(true);
        // An account alone, too.
        await db.createUser({ github_id: "gh-del-new", username: "alice-new" });
        expect(await db.namespaceInUse("alice-new")).toBe(true);
      });

      it("tells which bundle keys a version still names", async () => {
        const s = await seedTwoAccounts();
        const asked = ["alice/tool/1.0.0.agent", "bob/other/1.0.0.agent", "alice/none/1.0.0.agent"];
        expect(sortIds(await db.referencedBundleKeys(asked))).toEqual([
          "alice/tool/1.0.0.agent",
          "bob/other/1.0.0.agent",
        ]);
        expect(await db.referencedBundleKeys([])).toEqual([]);

        await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });
        expect(await db.referencedBundleKeys(asked)).toEqual(["bob/other/1.0.0.agent"]);
      });

      it("tells which bundle keys a version of another account names, leaving out one owner's own", async () => {
        const s = await seedTwoAccounts();
        // A version of B's agent that names A's key: one object, two rows.
        await db.createVersion(s.o.id, {
          version: "2.0.0",
          size: 1,
          bundle_key: "alice/tool/1.0.0.agent",
        });
        const asked = ["alice/tool/1.0.0.agent", "alice/tool/2.0.0.agent", "bob/other/1.0.0.agent"];

        expect(sortIds(await db.referencedBundleKeys(asked, s.a.id))).toEqual([
          "alice/tool/1.0.0.agent",
          "bob/other/1.0.0.agent",
        ]);
        expect(sortIds(await db.referencedBundleKeys(asked, s.b.id))).toEqual([
          "alice/tool/1.0.0.agent",
          "alice/tool/2.0.0.agent",
        ]);
        expect(sortIds(await db.referencedBundleKeys(asked))).toEqual(sortIds(asked));
      });

      describe("runs left behind by an agent the account deleted earlier", () => {
        const FILES_R8 = [{ name: "left.txt", size: 4 }];

        /**
         * The two accounts, plus A's agent `old`, deleted by A before A's own
         * deletion. B ran it twice before: r8 names it as its version does
         * (outputs waiting for their purge), r9 carries a version under
         * another namespace that only starts like A's. Deleting the agent
         * detached both, their content intact.
         */
        async function seedLeftBehind() {
          const s = await seedTwoAccounts();
          const old = await db.createAgent({
            name: "old",
            namespace: "alice",
            description: "",
            owner_id: s.a.id,
          });
          const r8 = fx("del-r8");
          await db.createRun({
            id: r8,
            agent_id: old.id,
            agent_version: "alice/old@1.0.0",
            user_id: s.b.id,
            api_key_id: s.bKey.id,
            status: "running",
            model: "gemini-2.5-flash",
            input: { asked: "r8 input" },
          });
          await db.updateRun(r8, {
            status: "completed",
            output: { said: "an answer" },
            files: FILES_R8,
            purge_after: PURGE_AFTER,
          });
          const r9 = fx("del-r9");
          await db.createRun({
            id: r9,
            agent_id: old.id,
            agent_version: "alice-2/old@1.0.0",
            user_id: s.b.id,
            status: "completed",
            model: "gemini-2.5-flash",
            input: { asked: "r9 input" },
          });
          expect(await db.deleteAgent("alice", "old")).toBe(true);
          expect(await db.getRun(r8)).toMatchObject({
            agent_id: null,
            input: { asked: "r8 input" },
          });
          return { ...s, r8, r9 };
        }

        it("clears and marks a run another account made on it, found by the namespace its version names", async () => {
          const s = await seedLeftBehind();
          const before = await runsById([s.r8, s.r9]);

          const plan = await db.planUserDeletion(s.a.id);
          const result = await db.deleteUser(s.a.id, { purged_output_run_ids: [s.r1], at: AT });

          const after = await runsById([s.r8, s.r9]);
          // Still B's run: only its content goes, and the deleted account's
          // namespace and agent name from the version it names.
          expect(after[s.r8]).toEqual({
            ...before[s.r8],
            input: null,
            output: null,
            error: null,
            files: [],
            content_cleared_at: AT,
            agent_version: "@1.0.0",
          });
          expect(after[s.r8]?.user_id).toBe(s.b.id);
          // `alice-2/` is another namespace: an exact prefix, never a pattern.
          expect(after[s.r9]).toEqual(before[s.r9]);
          // Its outputs are the deletion's to delete, before and after the commit.
          expect(plan?.pending_outputs).toContainEqual({ id: s.r8, files: FILES_R8 });
          expect(result?.cleared_run_ids).toContain(s.r8);
          expect(result?.cleared_run_ids).not.toContain(s.r9);
          expect(result?.late_outputs).toContainEqual({ id: s.r8, files: FILES_R8 });
        });

        it("compares the namespace as text, never as a pattern: `_` matches only itself", async () => {
          const ab = await db.createUser({ github_id: "gh-del-ab", username: "a_b" });
          const other = await db.createUser({ github_id: "gh-del-other", username: "other" });
          const agent = await db.createAgent({
            name: "x",
            namespace: "a_b",
            description: "",
            owner_id: ab.id,
          });
          const [own, lookalike] = [fx("del-ab-own"), fx("del-ab-lookalike")];
          for (const [id, version] of [
            [own, "a_b/x@1.0.0"],
            [lookalike, "axb/x@1.0.0"],
          ] as const) {
            await db.createRun({
              id,
              agent_id: agent.id,
              agent_version: version,
              user_id: other.id,
              status: "completed",
              input: { asked: version },
            });
          }
          await db.deleteAgent("a_b", "x");

          await db.deleteUser(ab.id, { purged_output_run_ids: [], at: AT });

          expect(await db.getRun(own)).toMatchObject({
            input: null,
            agent_version: "@1.0.0",
            content_cleared_at: AT,
          });
          expect(await db.getRun(lookalike)).toMatchObject({
            input: { asked: "axb/x@1.0.0" },
            agent_version: "axb/x@1.0.0",
            content_cleared_at: null,
          });
        });

        it("leaves them alone when the namespace is shared: the version text could be another account's", async () => {
          const s = await seedLeftBehind();
          await db.createAgent({
            name: "squat",
            namespace: "alice",
            description: "",
            owner_id: s.b.id,
          });
          const before = await runsById([s.r8]);

          const plan = await db.planUserDeletion(s.a.id);
          const result = await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

          expect(plan?.namespace_shared).toBe(true);
          expect(plan?.pending_outputs.map((r) => r.id)).not.toContain(s.r8);
          expect(result?.cleared_run_ids).not.toContain(s.r8);
          expect((await runsById([s.r8]))[s.r8]).toEqual(before[s.r8]);
        });
      });

      describe("a run still going when its account is deleted", () => {
        const TELEMETRY = {
          usage_prompt_tokens: 7,
          usage_completion_tokens: 5,
          usage_total_tokens: 12,
          usage_estimated_cost: 0.25,
          duration_ms: 900,
          completed_at: "2026-03-05T00:00:00.000Z",
          machine_id: "machine-2",
          private_ip: "fdaa:0:1::3",
          phase_timings: { vm_boot_ms: 7 },
        };
        const CLEARED = { output: null, error: null, files: [], content_cleared_at: AT };

        it("completes without its output, its files or its purge date coming back", async () => {
          const s = await seedTwoAccounts();
          await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

          const returned = await db.updateRun(s.r4, {
            status: "completed",
            output: { said: "a late answer" },
            files: [{ name: "late.txt", size: 4 }],
            purge_after: "2026-04-01T00:00:00.000Z",
            ...TELEMETRY,
          });

          const expected = { status: "completed", ...TELEMETRY, ...CLEARED, purge_after: null };
          expect(returned).toMatchObject(expected);
          expect(await db.getRun(s.r4)).toMatchObject({ ...expected, input: null });
        });

        it("fails without its error message coming back", async () => {
          const s = await seedTwoAccounts();
          await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

          const returned = await db.updateRun(s.r4, {
            status: "failed",
            error: "a late failure",
            ...TELEMETRY,
          });

          const expected = { status: "failed", ...TELEMETRY, ...CLEARED, purge_after: null };
          expect(returned).toMatchObject(expected);
          expect(await db.getRun(s.r4)).toMatchObject({ ...expected, input: null });
        });

        it("a run never cleared still takes its content", async () => {
          const s = await seedTwoAccounts();
          await db.deleteUser(s.a.id, { purged_output_run_ids: [], at: AT });

          // r5: B on B's agent, outside the deletion's scope.
          const returned = await db.updateRun(s.r5, {
            output: { said: "written" },
            error: "written too",
            files: [{ name: "w.txt", size: 1 }],
            purge_after: "2026-04-01T00:00:00.000Z",
          });

          expect(returned).toMatchObject({
            output: { said: "written" },
            error: "written too",
            files: [{ name: "w.txt", size: 1 }],
            purge_after: "2026-04-01T00:00:00.000Z",
            content_cleared_at: null,
          });
        });
      });
    });

    // ── Environments ────────────────────────────────────────────────────

    describe("environments", () => {
      it("creates and gets an environment", async () => {
        const env = await db.createEnvironment({
          name: "prod",
          owner_id: fx("u1"),
          config: { timeout: 30, networking: { allowed_hosts: ["*"] } },
        });
        expect(env.id).toBeTruthy();

        const found = await db.getEnvironment(env.id);
        expect(found?.name).toBe("prod");
        expect(found?.config).toEqual({ timeout: 30, networking: { allowed_hosts: ["*"] } });
      });

      it("lists environments by owner", async () => {
        await db.createEnvironment({ name: "dev", owner_id: fx("u1"), config: {} });
        await db.createEnvironment({ name: "prod", owner_id: fx("u1"), config: {} });
        await db.createEnvironment({ name: "other", owner_id: fx("u2"), config: {} });

        const envs = await db.listEnvironments(fx("u1"));
        expect(envs).toHaveLength(2);

        const empty = await db.listEnvironments(fx("nobody"));
        expect(empty).toHaveLength(0);
      });
    });

    // ── Stats ───────────────────────────────────────────────────────────

    describe("stats", () => {
      it("getStats aggregates count + tokens + failed (today)", async () => {
        const agent = await db.createAgent({
          name: "s-agg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("sa-t1"),
          agent_id: agent.id,
          agent_version: "v",
          status: "completed",
        });
        await db.createRun({
          id: fx("sa-t2"),
          agent_id: agent.id,
          agent_version: "v",
          status: "failed",
        });
        await db.updateRun(fx("sa-t1"), { usage_total_tokens: 100 });
        await db.updateRun(fx("sa-t2"), { usage_total_tokens: 50 });

        const stats = await db.getStats();
        expect(stats.agents_count).toBe(1);
        expect(stats.runs_today).toBe(2);
        expect(stats.tokens_today).toBe(150);
        expect(stats.failed_today).toBe(1);
        expect(stats.daily_runs).toHaveLength(7);
        expect(stats.daily_tokens).toHaveLength(7);
        expect(stats.daily_failed).toHaveLength(7);
        // Today is the last bucket (index 6) — assert VALUES, not just length.
        // A length-only check let the PostgresDb `::date`→Date bucketing bug
        // ship all-zero daily arrays (see the multi-day + rolling tests below).
        expect(stats.daily_runs[6]).toBe(2);
        expect(stats.daily_tokens[6]).toBe(150);
        expect(stats.daily_failed[6]).toBe(1);
      });

      it("getStats daily_* buckets honour created_at across multiple days", async () => {
        // Regression for the PostgresDb daily-bucketing bug: a length-7 array
        // isn't enough — buckets must be POPULATED. Backdate one run 2 days ago
        // and create one now; assert they land in distinct buckets.
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        await db.createRun({
          id: fx("dd-old"),
          agent_id: null,
          agent_version: "v",
          status: "failed",
          created_at: twoDaysAgo,
        });
        await db.createRun({
          id: fx("dd-now"),
          agent_id: null,
          agent_version: "v",
          status: "completed",
        });

        const stats = await db.getStats();
        // 7-day window ends today (index 6); 2 days ago = index 4.
        expect(stats.daily_runs[6]).toBe(1);
        expect(stats.daily_runs[4]).toBe(1);
        expect(stats.daily_failed[4]).toBe(1);
        expect(stats.daily_failed[6]).toBe(0);
        expect(stats.daily_runs.reduce((a, b) => a + b, 0)).toBe(2);
      });

      it("getStats today/yesterday tiles are ROLLING 24h windows (not UTC calendar days)", async () => {
        // A run from ~21h ago must count in the 24h tile even across the
        // UTC-midnight boundary; a run from ~25h ago must not.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        await db.createRun({
          id: fx("rw-recent"),
          agent_id: null,
          agent_version: "v",
          status: "completed",
          created_at: oneHourAgo,
        });
        await db.createRun({
          id: fx("rw-old"),
          agent_id: null,
          agent_version: "v",
          status: "failed",
          created_at: twentyFiveHoursAgo,
        });

        const stats = await db.getStats();
        // Trailing 24h → only the 1h-ago run.
        expect(stats.runs_today).toBe(1);
        expect(stats.failed_today).toBe(0);
        // Preceding 24h window [now-48h, now-24h) → the 25h-ago run.
        expect(stats.runs_yesterday).toBe(1);
        expect(stats.failed_yesterday).toBe(1);
      });

      it("getStats agents_count is filtered by owner when userId is provided", async () => {
        await db.createAgent({
          name: "own-a",
          namespace: "na",
          description: "",
          owner_id: fx("user-A"),
        });
        await db.createAgent({
          name: "own-b1",
          namespace: "nb1",
          description: "",
          owner_id: fx("user-B"),
        });
        await db.createAgent({
          name: "own-b2",
          namespace: "nb2",
          description: "",
          owner_id: fx("user-B"),
        });

        expect((await db.getStats({ userId: fx("user-A") })).agents_count).toBe(1);
        expect((await db.getStats({ userId: fx("user-B") })).agents_count).toBe(2);
        // No filter → instance-wide total.
        expect((await db.getStats()).agents_count).toBe(3);
      });

      it("getAgentStats aggregates runs/tokens/failed/avg_duration (period)", async () => {
        const agent = await db.createAgent({
          name: "as-agg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("as-1"),
          agent_id: agent.id,
          agent_version: "v",
          status: "completed",
        });
        await db.updateRun(fx("as-1"), { usage_total_tokens: 200, duration_ms: 1000 });

        const stats = await db.getAgentStats(agent.id);
        expect(stats.runs).toBe(1);
        expect(stats.tokens).toBe(200);
        expect(stats.failed).toBe(0);
        expect(stats.avg_duration_ms).toBe(1000);
        expect(stats.daily_runs).toHaveLength(7);
      });

      it("getAgentStats: daily_cache_savings / daily_cost length matches `days` argument (daily_runs/tokens/failed/avg_duration stay at 7 for sparkline UX)", async () => {
        const agent = await db.createAgent({
          name: "as-days",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        await db.createRun({
          id: fx("asd-1"),
          agent_id: agent.id,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("asd-1"), { usage_cache_savings_usd: 0.5 });

        const stats7 = await db.getAgentStats(agent.id, 7);
        // Original sparkline fields hardcoded to 7 (home page UX consistency,
        // documented in memory.ts:489-491 + sqlite.ts).
        expect(stats7.daily_runs).toHaveLength(7);
        expect(stats7.daily_tokens).toHaveLength(7);
        expect(stats7.daily_failed).toHaveLength(7);
        expect(stats7.daily_avg_duration_ms).toHaveLength(7);
        // Cache + cost honour the `days` parameter.
        expect(stats7.daily_cache_savings).toHaveLength(7);
        expect(stats7.daily_cost).toHaveLength(7);

        const stats30 = await db.getAgentStats(agent.id, 30);
        // Sparkline fields still 7 — they ignore `days` by design.
        expect(stats30.daily_runs).toHaveLength(7);
        expect(stats30.daily_tokens).toHaveLength(7);
        // Cache + cost grow to match `days`.
        expect(stats30.daily_cache_savings).toHaveLength(30);
        expect(stats30.daily_cost).toHaveLength(30);
      });
    });

    // ── Cache cost-savings ──────────────────────────────────────────────

    describe("cache cost-savings", () => {
      it("getStats sums cache_savings_today across runs", async () => {
        const today = new Date().toISOString();
        await db.createRun({
          id: fx("cs-r1"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-r1"), { usage_cache_savings_usd: 0.42, completed_at: today });
        await db.createRun({
          id: fx("cs-r2"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-r2"), { usage_cache_savings_usd: 0.42, completed_at: today });
        await db.createRun({
          id: fx("cs-r3"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-r3"), { usage_cache_savings_usd: 0, completed_at: today });

        const stats = await db.getStats();
        expect(stats.cache_savings_today).toBeCloseTo(0.84, 6);
        expect(stats.daily_cache_savings).toHaveLength(7);
        // Today is the last bucket (index 6) — sum should be 0.84
        expect(stats.daily_cache_savings[6]).toBeCloseTo(0.84, 6);
      });

      it("getStats multi-tenant userId filter isolates cache_savings", async () => {
        for (let i = 0; i < 2; i++) {
          const id = fx(`cst-a${i}`);
          await db.createRun({
            id,
            agent_id: null,
            agent_version: "v",
            user_id: fx("user-A"),
            status: "running",
          });
          await db.updateRun(id, { usage_cache_savings_usd: 0.42 });
        }
        for (let i = 0; i < 3; i++) {
          const id = fx(`cst-b${i}`);
          await db.createRun({
            id,
            agent_id: null,
            agent_version: "v",
            user_id: fx("user-B"),
            status: "running",
          });
          await db.updateRun(id, { usage_cache_savings_usd: 1.0 });
        }

        const statsA = await db.getStats({ userId: fx("user-A") });
        expect(statsA.cache_savings_today).toBeCloseTo(0.84, 6);

        const statsB = await db.getStats({ userId: fx("user-B") });
        expect(statsB.cache_savings_today).toBeCloseTo(3.0, 6);

        // No filter — instance-wide
        const statsAll = await db.getStats();
        expect(statsAll.cache_savings_today).toBeCloseTo(3.84, 6);
      });

      it("getAgentStats sums cache_savings over period", async () => {
        const agent = await db.createAgent({
          name: "csg",
          namespace: "ns",
          description: "",
          owner_id: fx("u"),
        });
        for (let i = 0; i < 5; i++) {
          const id = fx(`csg${i}`);
          await db.createRun({
            id,
            agent_id: agent.id,
            agent_version: "v",
            status: "running",
          });
          await db.updateRun(id, { usage_cache_savings_usd: 1.0 });
        }

        const stats = await db.getAgentStats(agent.id, 7);
        expect(stats.cache_savings).toBeCloseTo(5.0, 6);
        expect(stats.daily_cache_savings).toHaveLength(7);
        expect(stats.daily_cache_savings.reduce((s, v) => s + v, 0)).toBeCloseTo(5.0, 6);
      });

      it("failed run keeps cache_savings_usd = 0", async () => {
        await db.createRun({
          id: fx("cs-fail"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-fail"), {
          status: "failed",
          error: "boom",
          completed_at: new Date().toISOString(),
        });
        const run = await db.getRun(fx("cs-fail"));
        expect(run?.status).toBe("failed");
        expect(run?.usage_cache_savings_usd).toBe(0);
        expect(run?.usage_cache_read_tokens).toBe(0);
        expect(run?.usage_cache_write_tokens).toBe(0);
      });

      it("CRUD column completeness — 3 cache fields preserved across update→get", async () => {
        await db.createRun({
          id: fx("cs-rt"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        await db.updateRun(fx("cs-rt"), {
          status: "completed",
          usage_cache_read_tokens: 7143,
          usage_cache_write_tokens: 0,
          usage_cache_savings_usd: 0.000964,
        });
        const run = await db.getRun(fx("cs-rt"));
        expect(run?.usage_cache_read_tokens).toBe(7143);
        expect(run?.usage_cache_write_tokens).toBe(0);
        expect(run?.usage_cache_savings_usd).toBeCloseTo(0.000964, 6);
      });

      it("createRun initializes cache fields to 0 by default", async () => {
        await db.createRun({
          id: fx("cs-default"),
          agent_id: null,
          agent_version: "v",
          status: "running",
        });
        const run = await db.getRun(fx("cs-default"));
        expect(run?.usage_cache_read_tokens).toBe(0);
        expect(run?.usage_cache_write_tokens).toBe(0);
        expect(run?.usage_cache_savings_usd).toBe(0);
      });
    });

    // ── Timestamps: one shape on every backend ──────────────────────────

    /**
     * The contract types every timestamp as a string, and the memory and SQLite
     * backends carry the `toISOString()` string they were given. So every table
     * the interface reads back must hand out that same shape: a string, equal to
     * what the caller wrote when the caller wrote it, and in `toISOString()` form
     * when the backend stamped it. One case per table, so a table that hands back
     * something else is named by its case.
     */
    describe("timestamps read back as ISO strings", () => {
      /** Written by the caller, with milliseconds, so a lossy round trip shows. */
      const WRITTEN = "2099-03-04T05:06:07.891Z";

      function expectTimestamp(value: unknown, column: string, written?: string): void {
        expect(typeof value, column).toBe("string");
        if (written !== undefined) {
          expect(value, column).toBe(written);
        } else {
          expect(new Date(value as string).toISOString(), column).toBe(value);
        }
      }

      it("users", async () => {
        const created = await db.createUser({ github_id: "ts-user", username: "ts-user" });
        const read = await db.getUserById(created.id);
        const byGithub = await db.getUserByGithubId("ts-user");
        for (const row of [created, read, byGithub]) {
          expectTimestamp(row?.created_at, "users.created_at");
          expectTimestamp(row?.updated_at, "users.updated_at");
        }
      });

      it("api_keys", async () => {
        const created = await db.createApiKey({
          user_id: fx("u"),
          key_hash: "ts-key",
          key_prefix: "sk_",
          name: "ts",
          expires_at: WRITTEN,
        });
        await db.updateApiKeyLastUsed(created.id);
        const read = await db.getApiKeyByHash("ts-key");
        const listed = (await db.listApiKeys(fx("u"))).find((k) => k.id === created.id);
        for (const row of [read, listed]) {
          expectTimestamp(row?.created_at, "api_keys.created_at");
          expectTimestamp(row?.expires_at, "api_keys.expires_at", WRITTEN);
          expectTimestamp(row?.last_used_at, "api_keys.last_used_at");
        }
      });

      it("agents", async () => {
        const created = await db.createAgent({
          name: "ts-agent",
          namespace: "ts",
          description: "",
          owner_id: fx("u"),
        });
        const read = await db.getAgent("ts", "ts-agent");
        const listed = (await db.listAgents({ page: 1, limit: 10 })).agents.find(
          (a) => a.id === created.id,
        );
        const flipped = await db.setVisibility("ts", "ts-agent", "public");
        for (const row of [created, read, listed, flipped]) {
          expectTimestamp(row?.created_at, "agents.created_at");
          expectTimestamp(row?.updated_at, "agents.updated_at");
        }
      });

      it("agent_versions", async () => {
        const agent = await db.createAgent({
          name: "ts-versioned",
          namespace: "ts",
          description: "",
          owner_id: fx("u"),
        });
        const created = await db.createVersion(agent.id, {
          version: "1.0.0",
          size: 1,
          bundle_key: "ts/ts-versioned/1.0.0.agent",
        });
        const read = await db.getVersionByNumber(agent.id, "1.0.0");
        const latest = await db.getLatestVersion(agent.id);
        const [listed] = await db.getVersions(agent.id);
        for (const row of [created, read, latest, listed]) {
          expectTimestamp(row?.pushed_at, "agent_versions.pushed_at");
        }
      });

      it("agent_state", async () => {
        const agent = await db.createAgent({
          name: "ts-stateful",
          namespace: "ts",
          description: "",
          owner_id: fx("u"),
        });
        await db.setState(agent.id, { kind: "shared" }, { step: 1 }, WRITTEN);
        const read = await db.getState(agent.id, { kind: "shared" });
        expectTimestamp(read?.expires_at, "agent_state.expires_at", WRITTEN);
      });

      it("environments", async () => {
        const created = await db.createEnvironment({
          name: "ts-env",
          owner_id: fx("u"),
          config: {},
        });
        const read = await db.getEnvironment(created.id);
        const [listed] = await db.listEnvironments(fx("u"));
        for (const row of [created, read, listed]) {
          expectTimestamp(row?.created_at, "environments.created_at");
          expectTimestamp(row?.updated_at, "environments.updated_at");
        }
      });

      it("runs", async () => {
        const createdAt = "2099-03-04T01:02:03.456Z";
        const completedAt = "2099-03-04T02:03:04.567Z";
        const purgeAfter = "2099-03-04T03:04:05.678Z";
        const purgedAt = "2099-03-04T04:05:06.789Z";
        const clearedAt = "2099-03-04T05:06:07.890Z";
        await db.createRun({
          id: fx("ts-run"),
          agent_id: null,
          agent_version: "1.0.0",
          status: "running",
          created_at: createdAt,
        });
        const updated = await db.updateRun(fx("ts-run"), {
          status: "completed",
          completed_at: completedAt,
          purge_after: purgeAfter,
        });
        expectTimestamp(updated?.created_at, "runs.created_at", createdAt);
        expectTimestamp(updated?.completed_at, "runs.completed_at", completedAt);
        expectTimestamp(updated?.purge_after, "runs.purge_after", purgeAfter);

        await db.markRunOutputsPurged(fx("ts-run"), purgedAt);
        await hooks.setRunContentCleared(db, fx("ts-run"), clearedAt);
        const read = await db.getRun(fx("ts-run"));
        const [listed] = await db.listRuns({ limit: 1 });
        for (const row of [read, listed]) {
          expectTimestamp(row?.created_at, "runs.created_at", createdAt);
          expectTimestamp(row?.completed_at, "runs.completed_at", completedAt);
          expectTimestamp(row?.purge_after, "runs.purge_after", purgeAfter);
          expectTimestamp(row?.outputs_purged_at, "runs.outputs_purged_at", purgedAt);
          expectTimestamp(row?.content_cleared_at, "runs.content_cleared_at", clearedAt);
        }
      });

      it("agent_llm_keys", async () => {
        const agent = await db.createAgent({
          name: "ts-keyed",
          namespace: "ts",
          description: "",
          owner_id: fx("u"),
        });
        await db.setAgentLlmKey(agent.id, "anthropic", "cipher", "••1234", 1);
        const [presence] = await db.listAgentLlmKeys(agent.id);
        expectTimestamp(presence?.updated_at, "agent_llm_keys.updated_at");
      });

      it("device_codes", async () => {
        await db.createDeviceCode({
          device_code_hash: "ts-dch",
          user_code_hash: "ts-uch",
          code_challenge: "ts-chal",
          expires_at: WRITTEN,
        });
        await db.recordDeviceCodePoll("ts-dch", false);
        const byDevice = await db.getDeviceCodeByDeviceHash("ts-dch");
        const byUser = await db.getDeviceCodeByUserHash("ts-uch");
        for (const row of [byDevice, byUser]) {
          expectTimestamp(row?.created_at, "device_codes.created_at");
          expectTimestamp(row?.expires_at, "device_codes.expires_at", WRITTEN);
          expectTimestamp(row?.last_polled_at, "device_codes.last_polled_at");
        }
      });

      it("sessions", async () => {
        await db.createSession({ id_hash: "ts-sess", user_id: fx("u"), expires_at: WRITTEN });
        const read = await db.getSession("ts-sess");
        expectTimestamp(read?.created_at, "sessions.created_at");
        expectTimestamp(read?.expires_at, "sessions.expires_at", WRITTEN);
      });
    });
  });
}
