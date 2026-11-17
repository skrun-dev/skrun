import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOutputKey, runOutputsArchiveKey } from "@skrun-dev/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCache } from "../cache/bundle-cache.js";
import { getInputFile, inputCache, registerInputFile } from "../cache/input-cache.js";
import { _clearOutputCacheForTests, getOutputDir, registerOutput } from "../cache/output-cache.js";
import { MemoryDb } from "../db/memory.js";
import type { Agent, User } from "../db/schema.js";
import { MemoryStorage } from "../storage/memory.js";
import {
  type AccountDeletionDeps,
  type AccountDeletionLog,
  deleteAccount,
} from "./account-deletion.js";
import { createDeletionJournal, type DeletionJournal } from "./deletion-journal.js";

const AT = new Date("2026-03-04T05:06:07.890Z");
const DUE = "2026-04-01T00:00:00.000Z";

interface LoggedLine {
  level: "info" | "error";
  fields: Record<string, unknown>;
}

/** A logger that keeps every line, and what it never says, as one string. */
function recordingLog(): { log: AccountDeletionLog; lines: LoggedLine[]; all: () => string } {
  const lines: LoggedLine[] = [];
  return {
    log: {
      info: (fields) => lines.push({ level: "info", fields }),
      error: (fields) => lines.push({ level: "error", fields }),
    },
    lines,
    all: () => JSON.stringify(lines),
  };
}

interface World {
  db: MemoryDb;
  bundles: MemoryStorage;
  outputs: MemoryStorage;
  alice: User;
  bob: User;
  tool: Agent;
  /** The bundle keys of alice's versions. */
  bundleKeys: string[];
  recorded: ReturnType<typeof recordingLog>;
  deps: AccountDeletionDeps;
}

/**
 * Alice, with an agent of `versions` versions (an object for each), an account
 * key and a run that has finished; Bob, with an agent of his own and one
 * version. Bundles and run outputs live on two stores, as they do in a cloud
 * deployment.
 */
async function world(versions = 2): Promise<World> {
  const db = new MemoryDb();
  const bundles = new MemoryStorage();
  const outputs = new MemoryStorage();
  const alice = await db.createUser({
    github_id: "gh-alice-4242",
    username: "alice",
    email: "alice@example.com",
  });
  const bob = await db.createUser({ github_id: "gh-bob-4343", username: "bob" });
  const tool = await db.createAgent({
    name: "tool",
    namespace: "alice",
    description: "",
    owner_id: alice.id,
  });
  const bundleKeys: string[] = [];
  for (let i = 1; i <= versions; i++) {
    const key = `alice/tool/${i}.0.0.agent`;
    await db.createVersion(tool.id, { version: `${i}.0.0`, size: 1, bundle_key: key });
    await bundles.put(key, Buffer.from(`bundle ${i}`));
    bundleKeys.push(key);
  }
  const other = await db.createAgent({
    name: "other",
    namespace: "bob",
    description: "",
    owner_id: bob.id,
  });
  await db.createVersion(other.id, {
    version: "1.0.0",
    size: 1,
    bundle_key: "bob/other/1.0.0.agent",
  });
  await bundles.put("bob/other/1.0.0.agent", Buffer.from("bob's"));
  await db.createApiKey({
    user_id: alice.id,
    key_hash: "hash-alice-account",
    key_prefix: "skrun_sk_al",
    name: "account",
  });
  const recorded = recordingLog();
  return {
    db,
    bundles,
    outputs,
    alice,
    bob,
    tool,
    bundleKeys,
    recorded,
    deps: { db, bundleStorage: bundles, outputStorage: outputs, log: recorded.log, now: () => AT },
  };
}

/**
 * A cloud run of `user` on `agentId` that completed with these file names,
 * whose objects wait for their purge — an object for every name, and the
 * archive. `purged` marks it purged already.
 */
async function cloudRun(
  w: World,
  id: string,
  opts: { user: User; agentId: string; names: string[]; purged?: boolean },
): Promise<void> {
  await w.db.createRun({
    id,
    agent_id: opts.agentId,
    agent_version: "alice/tool@1.0.0",
    user_id: opts.user.id,
    status: "running",
    input: { asked: "something" },
  });
  await w.db.updateRun(id, {
    status: "completed",
    output: { said: "something" },
    files: opts.names.map((name) => ({ name, size: 1 })),
    purge_after: DUE,
  });
  for (const name of opts.names) await w.outputs.put(runOutputKey(id, name), Buffer.from("x"));
  await w.outputs.put(runOutputsArchiveKey(id), Buffer.from("archive"));
  if (opts.purged) await w.db.markRunOutputsPurged(id, DUE);
}

describe("account deletion — objects first, then rows", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    _clearOutputCacheForTests();
    inputCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _clearOutputCacheForTests();
    inputCache.clear();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "skrun-deletion-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("deletes the bundles and the pending outputs, never an object under a refused name, nothing for a run already purged", async () => {
    const w = await world(2);
    await cloudRun(w, "run-pending", {
      user: w.alice,
      agentId: w.tool.id,
      names: ["a.txt", "d/b.csv", "../x"],
    });
    await cloudRun(w, "run-purged", {
      user: w.alice,
      agentId: w.tool.id,
      names: ["old.txt"],
      purged: true,
    });
    const bundleDeletes = vi.spyOn(w.bundles, "delete");
    const outputDeletes = vi.spyOn(w.outputs, "delete");

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    for (const key of w.bundleKeys) expect(await w.bundles.exists(key)).toBe(false);
    for (const key of [
      runOutputKey("run-pending", "a.txt"),
      runOutputKey("run-pending", "d/b.csv"),
      runOutputsArchiveKey("run-pending"),
    ]) {
      expect(await w.outputs.exists(key)).toBe(false);
    }
    const deleted = [...bundleDeletes.mock.calls, ...outputDeletes.mock.calls].map(([key]) => key);
    expect(deleted.filter((key) => key.includes("../x"))).toEqual([]);
    expect(deleted.filter((key) => key.includes("run-purged"))).toEqual([]);
    // Each object on its own store: no bundle key reaches the outputs store, nor the reverse.
    expect(bundleDeletes.mock.calls.map(([key]) => key).sort()).toEqual([...w.bundleKeys].sort());
    expect(outputDeletes.mock.calls.every(([key]) => key.includes("run-pending"))).toBe(true);
    // Bob's bundle, and the purged run's object, stay.
    expect(await w.bundles.exists("bob/other/1.0.0.agent")).toBe(true);
    expect(await w.outputs.exists(runOutputKey("run-purged", "old.txt"))).toBe(true);
    // The pending run is marked purged with the deletion's instant, and cleared.
    const pending = await w.db.getRun("run-pending");
    expect(pending).toMatchObject({
      outputs_purged_at: AT.toISOString(),
      content_cleared_at: AT.toISOString(),
      files: [],
      input: null,
    });
    expect(await w.db.getUserById(w.alice.id)).toBeNull();
  });

  it("a delete that fails stops before the database; trying again deletes everything", async () => {
    const w = await world(3);
    await cloudRun(w, "run-a", { user: w.alice, agentId: w.tool.id, names: ["a.txt"] });
    const deleteFromStore = MemoryStorage.prototype.delete;
    let calls = 0;
    vi.spyOn(w.bundles, "delete").mockImplementation(async function (this: MemoryStorage, key) {
      calls++;
      if (calls === 2) {
        throw Object.assign(new Error(`store unreachable while deleting ${key}`), {
          name: "TimeoutError",
          code: "ETIMEDOUT",
        });
      }
      return deleteFromStore.call(w.bundles, key);
    });

    const first = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(first).toEqual({ status: "storage_unavailable" });
    expect(await w.bundles.exists(w.bundleKeys[0] as string)).toBe(false);
    expect(await w.bundles.exists(w.bundleKeys[1] as string)).toBe(true);
    expect(await w.bundles.exists(w.bundleKeys[2] as string)).toBe(true);
    // The database is untouched: the account, its key, its agent, its run as they were.
    expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
    expect(await w.db.getApiKeyByHash("hash-alice-account")).not.toBeNull();
    expect(await w.db.getAgent("alice", "tool")).not.toBeNull();
    expect(await w.db.getRun("run-a")).toMatchObject({
      input: { asked: "something" },
      content_cleared_at: null,
      outputs_purged_at: null,
    });
    expect(await w.outputs.exists(runOutputKey("run-a", "a.txt"))).toBe(true);

    const second = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(second.status).toBe("deleted");
    for (const key of w.bundleKeys) expect(await w.bundles.exists(key)).toBe(false);
    expect(await w.outputs.exists(runOutputKey("run-a", "a.txt"))).toBe(false);
    expect(await w.db.getUserById(w.alice.id)).toBeNull();
  });

  it("evicts the account's local outputs and uploads in this process, and leaves the extracted bundles", async () => {
    const w = await world(1);
    await w.db.createRun({
      id: "run-local",
      agent_id: w.tool.id,
      agent_version: "alice/tool@1.0.0",
      user_id: w.alice.id,
      status: "completed",
    });
    await w.db.createRun({
      id: "run-bob",
      agent_id: null,
      agent_version: "bob/other@1.0.0",
      user_id: w.bob.id,
      status: "completed",
    });
    const aliceDir = tempDir();
    const bobDir = tempDir();
    registerOutput("run-local", aliceDir);
    registerOutput("run-bob", bobDir);
    const uploads: Record<string, string> = {};
    for (const [fileId, owner] of [
      ["fil_alice_1", w.alice.id],
      ["fil_alice_2", w.alice.id],
      ["fil_bob_1", w.bob.id],
    ] as const) {
      const path = join(tempDir(), "upload.bin");
      writeFileSync(path, "x");
      uploads[fileId] = path;
      registerInputFile(fileId, {
        path,
        size: 1,
        media_type: "text/plain",
        purpose: "input",
        expires_at: new Date(AT.getTime() + 86_400_000),
        owner_id: owner,
        uploaded_by_key_id: null,
      });
    }
    const bundleEvictions = [
      vi.spyOn(bundleCache, "delete"),
      vi.spyOn(bundleCache, "clear"),
      vi.spyOn(bundleCache, "sweep"),
    ];

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(getOutputDir("run-local")).toBeUndefined();
    expect(existsSync(aliceDir)).toBe(false);
    expect(getInputFile("fil_alice_1")).toBeUndefined();
    expect(getInputFile("fil_alice_2")).toBeUndefined();
    expect(existsSync(uploads.fil_alice_1 as string)).toBe(false);
    expect(existsSync(uploads.fil_alice_2 as string)).toBe(false);
    // Bob's copies stay.
    expect(getOutputDir("run-bob")).toBe(bobDir);
    expect(existsSync(bobDir)).toBe(true);
    expect(getInputFile("fil_bob_1")?.owner_id).toBe(w.bob.id);
    for (const spy of bundleEvictions) expect(spy).not.toHaveBeenCalled();
  });

  it("deletes after the commit what appeared after the plan: a version pushed, a run that completed", async () => {
    const w = await world(1);
    await w.db.createRun({
      id: "run-late",
      agent_id: w.tool.id,
      agent_version: "alice/tool@1.0.0",
      user_id: w.alice.id,
      status: "running",
    });
    const plan = w.db.planUserDeletion.bind(w.db);
    vi.spyOn(w.db, "planUserDeletion").mockImplementation(async (userId) => {
      const read = await plan(userId);
      // Between the plan and the transaction: a push and a completion land.
      await w.db.createVersion(w.tool.id, {
        version: "9.0.0",
        size: 1,
        bundle_key: "alice/tool/9.0.0.agent",
      });
      await w.bundles.put("alice/tool/9.0.0.agent", Buffer.from("late"));
      await w.db.updateRun("run-late", {
        status: "completed",
        files: [{ name: "late.txt", size: 1 }],
        purge_after: DUE,
      });
      await w.outputs.put(runOutputKey("run-late", "late.txt"), Buffer.from("x"));
      await w.outputs.put(runOutputsArchiveKey("run-late"), Buffer.from("x"));
      return read;
    });

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome).toMatchObject({ status: "deleted", counts: { versions: 2 } });
    expect(await w.bundles.exists("alice/tool/9.0.0.agent")).toBe(false);
    expect(await w.outputs.exists(runOutputKey("run-late", "late.txt"))).toBe(false);
    expect(await w.outputs.exists(runOutputsArchiveKey("run-late"))).toBe(false);
    expect(await w.db.getRun("run-late")).toMatchObject({
      outputs_purged_at: AT.toISOString(),
      files: [],
    });
    // 1 planned bundle; then 1 late bundle, 1 late file and its archive.
    expect(outcome).toMatchObject({ counts: { objects_deleted: 4 } });
  });

  it("touches nothing when the confirmation is not the username, or when there is no such account", async () => {
    const w = await world(1);
    const deletes = [vi.spyOn(w.bundles, "delete"), vi.spyOn(w.outputs, "delete")];
    const deleteUser = vi.spyOn(w.db, "deleteUser");

    for (const confirm of ["Alice", "bob", ""]) {
      expect(await deleteAccount(w.deps, { userId: w.alice.id, confirm, route: "self" })).toEqual({
        status: "confirmation_mismatch",
      });
    }
    expect(
      await deleteAccount(w.deps, { userId: "no-such-account", confirm: "alice", route: "admin" }),
    ).toEqual({ status: "not_found" });

    for (const spy of [...deletes, deleteUser]) expect(spy).not.toHaveBeenCalled();
    expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
    expect(w.recorded.lines).toEqual([]);
  });

  it("two deletions of one account at once: one deletes, the other finds nothing", async () => {
    const w = await world(2);
    const request = { userId: w.alice.id, confirm: "alice", route: "self" } as const;

    const outcomes = await Promise.all([
      deleteAccount(w.deps, request),
      deleteAccount(w.deps, request),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(["deleted", "not_found"]);
    expect(await w.db.getUserById(w.alice.id)).toBeNull();
    for (const key of w.bundleKeys) expect(await w.bundles.exists(key)).toBe(false);
  });

  it("without a store for run outputs, deletes the bundles and leaves the runs' purge to their deadline", async () => {
    const w = await world(1);
    await cloudRun(w, "run-a", { user: w.alice, agentId: w.tool.id, names: ["a.txt"] });

    const outcome = await deleteAccount(
      { ...w.deps, outputStorage: undefined },
      { userId: w.alice.id, confirm: "alice", route: "self" },
    );

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.exists(w.bundleKeys[0] as string)).toBe(false);
    expect(await w.db.getRun("run-a")).toMatchObject({ outputs_purged_at: null });
  });
});

describe("account deletion — the deletion journal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _clearOutputCacheForTests();
    inputCache.clear();
  });

  /** A journal that records nothing, and remembers when it was asked. */
  function journalSpy(): DeletionJournal & { record: ReturnType<typeof vi.fn> } {
    return { record: vi.fn(async () => {}) };
  }

  it("records the account once the plan is read and the name confirmed, before the first object and the rows", async () => {
    const w = await world(2);
    await cloudRun(w, "run-a", { user: w.alice, agentId: w.tool.id, names: ["a.txt"] });
    const journal = journalSpy();
    const plan = vi.spyOn(w.db, "planUserDeletion");
    const bundleDeletes = vi.spyOn(w.bundles, "delete");
    const outputDeletes = vi.spyOn(w.outputs, "delete");
    const deleteUser = vi.spyOn(w.db, "deleteUser");

    const outcome = await deleteAccount(
      { ...w.deps, journal },
      { userId: w.alice.id, confirm: "alice", route: "self" },
    );

    expect(outcome.status).toBe("deleted");
    expect(journal.record.mock.calls).toEqual([["account", w.alice.id]]);
    const recorded = journal.record.mock.invocationCallOrder[0] as number;
    expect(plan.mock.invocationCallOrder[0]).toBeLessThan(recorded);
    const firstDelete = Math.min(
      ...bundleDeletes.mock.invocationCallOrder,
      ...outputDeletes.mock.invocationCallOrder,
    );
    expect(bundleDeletes).toHaveBeenCalled();
    expect(recorded).toBeLessThan(firstDelete);
    expect(recorded).toBeLessThan(deleteUser.mock.invocationCallOrder[0] as number);
  });

  it("on the bundles' store, its object stays once the account is gone: the deletion's sweeps never reach it", async () => {
    const w = await world(2);
    const journal = createDeletionJournal(w.bundles);

    const outcome = await deleteAccount(
      { ...w.deps, journal },
      { userId: w.alice.id, confirm: "alice", route: "admin" },
    );

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.list("_deletions/")).toEqual([`_deletions/account/${w.alice.id}`]);
    expect(await w.db.getUserById(w.alice.id)).toBeNull();
  });

  it("records nothing when the name is not confirmed, or when there is no such account", async () => {
    const w = await world(1);
    const journal = journalSpy();
    const deps = { ...w.deps, journal };

    expect(
      await deleteAccount(deps, { userId: w.alice.id, confirm: "Alice", route: "self" }),
    ).toEqual({ status: "confirmation_mismatch" });
    expect(
      await deleteAccount(deps, { userId: "no-such-account", confirm: "alice", route: "admin" }),
    ).toEqual({ status: "not_found" });

    expect(journal.record).not.toHaveBeenCalled();
  });

  it("without a journal, a deletion writes nothing to the bundles' store", async () => {
    const w = await world(2);
    const puts = vi.spyOn(w.bundles, "put");

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(puts).not.toHaveBeenCalled();
    expect(await w.bundles.list("_deletions/")).toEqual([]);
  });

  it("a journal that cannot record stops the deletion before anything is deleted: the store is said unavailable, the stage logged", async () => {
    const w = await world(2);
    await cloudRun(w, "run-a", { user: w.alice, agentId: w.tool.id, names: ["a.txt"] });
    const journal: DeletionJournal = {
      record: vi.fn(async () => {
        throw Object.assign(new Error(`cannot write _deletions/account/${w.alice.id}`), {
          name: "TimeoutError",
          code: "ETIMEDOUT",
        });
      }),
    };
    const deletes = [vi.spyOn(w.bundles, "delete"), vi.spyOn(w.outputs, "delete")];
    const deleteUser = vi.spyOn(w.db, "deleteUser");

    const outcome = await deleteAccount(
      { ...w.deps, journal },
      { userId: w.alice.id, confirm: "alice", route: "self" },
    );

    expect(outcome).toEqual({ status: "storage_unavailable" });
    for (const spy of [...deletes, deleteUser]) expect(spy).not.toHaveBeenCalled();
    for (const key of w.bundleKeys) expect(await w.bundles.exists(key)).toBe(true);
    expect(await w.outputs.exists(runOutputKey("run-a", "a.txt"))).toBe(true);
    expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
    expect(await w.db.getRun("run-a")).toMatchObject({
      input: { asked: "something" },
      content_cleared_at: null,
    });
    expect(w.recorded.lines).toEqual([
      {
        level: "error",
        fields: {
          event: "account_deletion_failed",
          user_id: w.alice.id,
          stage: "journal",
          error_name: "TimeoutError",
          error_code: "ETIMEDOUT",
        },
      },
    ]);
  });
});

describe("account deletion — the namespace's folder, before and after the commit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _clearOutputCacheForTests();
    inputCache.clear();
  });

  interface ListRecord {
    /** Folders listed before the deletion committed. */
    before: string[];
    /** Folders listed after it. */
    after: string[];
  }

  /**
   * Record every folder `list` is asked for, before and after the commit.
   * `beforeCommit` runs inside the deletion, just before the transaction;
   * `afterCommit` just after it.
   */
  function recordLists(
    w: World,
    hooks: { beforeCommit?: () => Promise<void>; afterCommit?: () => Promise<void> } = {},
  ): ListRecord {
    const record: ListRecord = { before: [], after: [] };
    let committed = false;
    const list = w.bundles.list.bind(w.bundles);
    vi.spyOn(w.bundles, "list").mockImplementation(async (folder) => {
      (committed ? record.after : record.before).push(folder);
      return list(folder);
    });
    const deleteUser = w.db.deleteUser.bind(w.db);
    vi.spyOn(w.db, "deleteUser").mockImplementation(async (...args) => {
      await hooks.beforeCommit?.();
      const result = await deleteUser(...args);
      committed = true;
      await hooks.afterCommit?.();
      return result;
    });
    return record;
  }

  it("deletes an object under the namespace that no row names, before the commit", async () => {
    const w = await world(1);
    await w.bundles.put("alice/orphan/1.0.0.agent", Buffer.from("no row names me"));
    const lists = recordLists(w);

    await deleteAccount(w.deps, { userId: w.alice.id, confirm: "alice", route: "self" });

    expect(await w.bundles.exists("alice/orphan/1.0.0.agent")).toBe(false);
    expect(lists.before).toEqual(["alice/"]);
    expect(await w.bundles.exists("bob/other/1.0.0.agent")).toBe(true);
  });

  it("an object pushed under the namespace while the deletion runs is gone once it has committed", async () => {
    const w = await world(1);
    recordLists(w, {
      // A push in flight: its object lands after the first sweep, its row never.
      beforeCommit: () => w.bundles.put("alice/x/1.0.0.agent", Buffer.from("in flight")),
    });

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.exists("alice/x/1.0.0.agent")).toBe(false);
  });

  it("a namespace another account also carries is never swept: its bundles stay", async () => {
    const w = await world(1);
    // Two accounts with one name: possible on the SQLite and in-memory stores.
    const twin = await w.db.createUser({ github_id: "gh-twin-4545", username: "alice" });
    const twinAgent = await w.db.createAgent({
      name: "twin-tool",
      namespace: "alice",
      description: "",
      owner_id: twin.id,
    });
    await w.db.createVersion(twinAgent.id, {
      version: "1.0.0",
      size: 1,
      bundle_key: "alice/twin-tool/1.0.0.agent",
    });
    await w.bundles.put("alice/twin-tool/1.0.0.agent", Buffer.from("the twin's"));
    const lists = recordLists(w);

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.exists("alice/twin-tool/1.0.0.agent")).toBe(true);
    expect(await w.bundles.exists(w.bundleKeys[0] as string)).toBe(false);
    expect([...lists.before, ...lists.after]).toEqual([]);
  });

  it("a namespace two accounts carry, each with the same version: the other account keeps its bundle", async () => {
    const w = await world(0);
    // Two accounts with one name, each with `x@1.0.0`: the same bundle key.
    // Possible on the SQLite and in-memory stores.
    const key = "alice/x/1.0.0.agent";
    const twin = await w.db.createUser({ github_id: "gh-twin-5050", username: "alice" });
    for (const owner of [w.alice, twin]) {
      const agent = await w.db.createAgent({
        name: owner === twin ? "x" : "x-own",
        namespace: "alice",
        description: "",
        owner_id: owner.id,
      });
      await w.db.createVersion(agent.id, { version: "1.0.0", size: 1, bundle_key: key });
    }
    await w.bundles.put(key, Buffer.from("one object, two versions"));

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.exists(key)).toBe(true);
    expect(await w.db.referencedBundleKeys([key])).toEqual([key]);
  });

  it("a namespace outside the alphabet a push accepts is never listed; its version keys still go", async () => {
    const w = await world(0);
    const old = await w.db.createUser({ github_id: "gh-old-4646", username: "Old_Name" });
    const agent = await w.db.createAgent({
      name: "tool",
      namespace: "Old_Name",
      description: "",
      owner_id: old.id,
    });
    await w.db.createVersion(agent.id, {
      version: "1.0.0",
      size: 1,
      bundle_key: "Old_Name/tool/1.0.0.agent",
    });
    await w.bundles.put("Old_Name/tool/1.0.0.agent", Buffer.from("old"));
    const lists = recordLists(w);

    const outcome = await deleteAccount(w.deps, {
      userId: old.id,
      confirm: "Old_Name",
      route: "admin",
    });

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.exists("Old_Name/tool/1.0.0.agent")).toBe(false);
    expect([...lists.before, ...lists.after]).toEqual([]);
  });

  it("an account named after the run outputs folder never lists it, nor deletes a run's outputs", async () => {
    const w = await world(0);
    // A dev token `_runs-token` signs in under the namespace `_runs`.
    const odd = await w.db.createUser({ github_id: "gh-odd-4949", username: "_runs" });
    // Bundles and outputs in one bucket, as a deployment may keep them.
    const output = runOutputKey("run-of-someone-else", "report.txt");
    await w.bundles.put(output, Buffer.from("someone else's output"));
    const lists = recordLists(w);

    const outcome = await deleteAccount(w.deps, {
      userId: odd.id,
      confirm: "_runs",
      route: "admin",
    });

    expect(outcome.status).toBe("deleted");
    expect(await w.bundles.exists(output)).toBe(true);
    expect([...lists.before, ...lists.after]).toEqual([]);
  });

  it("a new holder of the name, signed up the moment the deletion committed, keeps what it pushed", async () => {
    const w = await world(1);
    const lists = recordLists(w, {
      // The name is free: someone signs up as alice and pushes twice — one
      // version recorded, one whose object is written and whose row is not yet.
      afterCommit: async () => {
        const { user } = await w.db.createOAuthUser({ github_id: "gh-new-4747", login: "alice" });
        const agent = await w.db.createAgent({
          name: "y",
          namespace: user.username,
          description: "",
          owner_id: user.id,
        });
        await w.bundles.put("alice/y/1.0.0.agent", Buffer.from("new holder, recorded"));
        await w.db.createVersion(agent.id, {
          version: "1.0.0",
          size: 1,
          bundle_key: "alice/y/1.0.0.agent",
        });
        await w.bundles.put("alice/y/2.0.0.agent", Buffer.from("new holder, row on its way"));
      },
    });

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect((await w.db.getUserByGithubId("gh-new-4747"))?.username).toBe("alice");
    expect(await w.bundles.exists("alice/y/1.0.0.agent")).toBe(true);
    expect(await w.bundles.exists("alice/y/2.0.0.agent")).toBe(true);
    expect(lists.after).toEqual([]);
  });

  it("a version pushed during the deletion, whose key a new holder of the name records again, keeps the new holder's object", async () => {
    const w = await world(1);
    const key = "alice/tool/9.0.0.agent";
    recordLists(w, {
      // The account pushes a version while it is being deleted, after the
      // first sweep: the deletion learns its key from the transaction.
      beforeCommit: async () => {
        await w.db.createVersion(w.tool.id, { version: "9.0.0", size: 1, bundle_key: key });
        await w.bundles.put(key, Buffer.from("pushed during the deletion"));
      },
      // The name is free: someone signs up as alice and pushes the same name
      // and version — the same key, recorded by a version row of theirs.
      afterCommit: async () => {
        const { user } = await w.db.createOAuthUser({ github_id: "gh-new-4848", login: "alice" });
        const agent = await w.db.createAgent({
          name: "tool",
          namespace: user.username,
          description: "",
          owner_id: user.id,
        });
        await w.bundles.put(key, Buffer.from("the new holder's"));
        await w.db.createVersion(agent.id, { version: "9.0.0", size: 1, bundle_key: key });
      },
    });

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect((await w.bundles.get(key))?.toString()).toBe("the new holder's");
  });

  it("after the commit, a listed key that a version row still names stays; the others go", async () => {
    const w = await world(1);
    recordLists(w, {
      // Landed after the first sweep: one object no row names, and one that a
      // version of another account's agent names.
      beforeCommit: async () => {
        await w.bundles.put("alice/x/1.0.0.agent", Buffer.from("named by nobody"));
        await w.bundles.put("alice/kept/1.0.0.agent", Buffer.from("named by another version"));
        const other = await w.db.getAgent("bob", "other");
        await w.db.createVersion(other?.id as string, {
          version: "2.0.0",
          size: 1,
          bundle_key: "alice/kept/1.0.0.agent",
        });
      },
    });

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(await w.db.namespaceInUse("alice")).toBe(false);
    expect(await w.bundles.exists("alice/kept/1.0.0.agent")).toBe(true);
    expect(await w.bundles.exists("alice/x/1.0.0.agent")).toBe(false);
  });

  it("a listing that fails before the commit stops the deletion; after it, it is logged without any id", async () => {
    const before = await world(1);
    vi.spyOn(before.bundles, "list").mockRejectedValue(
      Object.assign(new Error("cannot list alice/"), { code: "ETIMEDOUT" }),
    );

    expect(
      await deleteAccount(before.deps, {
        userId: before.alice.id,
        confirm: "alice",
        route: "self",
      }),
    ).toEqual({ status: "storage_unavailable" });
    expect(await before.db.getUserById(before.alice.id)).not.toBeNull();
    expect(before.recorded.lines[0]?.fields).toMatchObject({ stage: "storage" });

    const after = await world(1);
    const list = after.bundles.list.bind(after.bundles);
    vi.spyOn(after.bundles, "list")
      .mockImplementationOnce(list)
      .mockRejectedValueOnce(Object.assign(new Error("cannot list alice/"), { code: "ETIMEDOUT" }));

    const outcome = await deleteAccount(after.deps, {
      userId: after.alice.id,
      confirm: "alice",
      route: "self",
    });

    expect(outcome.status).toBe("deleted");
    expect(after.recorded.lines[0]).toEqual({
      level: "error",
      fields: {
        event: "account_deletion_cleanup_failed",
        stage: "namespace_sweep",
        error_name: "Error",
        error_code: "ETIMEDOUT",
      },
    });
    expect(after.recorded.all()).not.toContain(after.alice.id);
    expect(after.recorded.all()).not.toContain("alice/");
  });
});

describe("account deletion — what the logs say", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _clearOutputCacheForTests();
    inputCache.clear();
  });

  /** Every value that names the account or what it held. */
  function namesOf(w: World): string[] {
    return [
      "alice",
      w.alice.id,
      "gh-alice-4242",
      "alice@example.com",
      w.tool.id,
      "skrun_sk_al",
      "run-a",
      "a.txt",
      ...w.bundleKeys,
    ];
  }

  for (const route of ["self", "admin"] as const) {
    it(`a deletion by the ${route} route logs one line of counts and the route, and nothing that names the account`, async () => {
      const w = await world(2);
      await cloudRun(w, "run-a", { user: w.alice, agentId: w.tool.id, names: ["a.txt"] });

      await deleteAccount(w.deps, { userId: w.alice.id, confirm: "alice", route });

      expect(w.recorded.lines).toEqual([
        {
          level: "info",
          fields: {
            event: "account_deleted",
            route,
            agents: 1,
            versions: 2,
            api_keys: 1,
            runs_cleared: 1,
            // Two bundles; the run's file and its archive.
            objects_deleted: 4,
          },
        },
      ]);
      for (const name of namesOf(w)) expect(w.recorded.all()).not.toContain(name);
    });
  }

  it("a deletion stopped by the store logs the account's id, the stage and the error's class and code, nothing more", async () => {
    const w = await world(2);
    vi.spyOn(w.bundles, "delete").mockRejectedValue(
      Object.assign(new Error("cannot delete alice/tool/1.0.0.agent"), {
        name: "TimeoutError",
        code: "ETIMEDOUT",
      }),
    );

    await deleteAccount(w.deps, { userId: w.alice.id, confirm: "alice", route: "self" });

    expect(w.recorded.lines).toEqual([
      {
        level: "error",
        fields: {
          event: "account_deletion_failed",
          user_id: w.alice.id,
          stage: "storage",
          error_name: "TimeoutError",
          error_code: "ETIMEDOUT",
        },
      },
    ]);
  });

  it.each([
    ["plan", "planUserDeletion"],
    ["database", "deleteUser"],
  ] as const)("a database failure at the %s stage is logged with that stage, and thrown", async (stage, method) => {
    const w = await world(1);
    const failure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    vi.spyOn(w.db, method).mockRejectedValue(failure);

    await expect(
      deleteAccount(w.deps, { userId: w.alice.id, confirm: "alice", route: "self" }),
    ).rejects.toBe(failure);

    expect(w.recorded.lines).toEqual([
      {
        level: "error",
        fields: {
          event: "account_deletion_failed",
          user_id: w.alice.id,
          stage,
          error_name: "Error",
          error_code: "ECONNRESET",
        },
      },
    ]);
    expect(await w.db.getUserById(w.alice.id)).not.toBeNull();
  });

  it("a cleanup that fails after the commit is logged without any id, and the deletion still succeeds", async () => {
    const w = await world(1);
    await w.db.createRun({
      id: "run-a",
      agent_id: w.tool.id,
      agent_version: "alice/tool@1.0.0",
      user_id: w.alice.id,
      status: "running",
    });
    const plan = w.db.planUserDeletion.bind(w.db);
    vi.spyOn(w.db, "planUserDeletion").mockImplementation(async (userId) => {
      const read = await plan(userId);
      await w.db.updateRun("run-a", {
        status: "completed",
        files: [{ name: "a.txt", size: 1 }],
        purge_after: DUE,
      });
      return read;
    });
    vi.spyOn(w.outputs, "delete").mockRejectedValue(
      Object.assign(new Error(`cannot delete ${runOutputKey("run-a", "a.txt")}`), {
        code: "ETIMEDOUT",
      }),
    );

    const outcome = await deleteAccount(w.deps, {
      userId: w.alice.id,
      confirm: "alice",
      route: "admin",
    });

    expect(outcome.status).toBe("deleted");
    expect(w.recorded.lines).toEqual([
      {
        level: "error",
        fields: {
          event: "account_deletion_cleanup_failed",
          stage: "late_outputs",
          error_name: "Error",
          error_code: "ETIMEDOUT",
        },
      },
      expect.objectContaining({ level: "info" }),
    ]);
    for (const name of namesOf(w)) expect(w.recorded.all()).not.toContain(name);
    // Not marked purged: nothing says its objects are gone.
    expect(await w.db.getRun("run-a")).toMatchObject({ outputs_purged_at: null });
  });
});
