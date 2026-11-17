/**
 * Deleting an account: one service, whichever route asks — the account itself
 * or an administrator.
 *
 * The order, and why. (1) Read what the account has in object storage: the key
 * of every version of its agents, and the output objects of its runs that are
 * still waiting for their purge. Once the account is found and its name
 * confirmed, and when the operator keeps a deletion journal, record the
 * deletion there before anything is deleted: a database restored from an
 * earlier copy can then have it done again. A record that cannot be written
 * stops the deletion, as a delete that fails does below: nothing is deleted
 * yet. (2) Delete those objects — before any row,
 * because the rows are the only record of the keys. A delete that fails stops
 * the deletion: nothing is written to the database, the caller is told the
 * store is unavailable and tries again with the same credential; deleting a key
 * that is already gone is not an error; a key a version of another account
 * still names is never deleted, before the commit or after. (3) Delete the
 * account in one database transaction (`DbAdapter.deleteUser`): its runs are
 * cleared and marked, its rows go. (4) After the commit, delete what appeared between (1) and (3) — the
 * object of a version pushed meanwhile (unless a version row names its key
 * again: the name is free by then, see below), the outputs of a run that
 * completed meanwhile. The account is gone by then: a failure here is logged and changes
 * nothing in the answer. (5) Evict what this process holds of the account: the
 * local outputs of its runs, its uploads. Another instance keeps its copies
 * until they expire. The extracted bundles are not evicted: an extraction is
 * keyed by the bundle's bytes, never served for another content, and leaves
 * with its own expiry.
 *
 * The namespace's folder, swept twice. A bundle is stored under
 * `<namespace>/<name>/<version>.agent`, written before its version row: an
 * object whose push was still in flight, or whose row is already gone, is named
 * by no row. So the folder `<namespace>/` is listed and emptied too — before
 * the commit, and once more after it, for a push that landed in between. Never
 * when the name could reach someone else's objects: a namespace outside the
 * alphabet a push accepts (`^[a-z0-9-]{1,64}$`, an account older than that rule)
 * is not swept at all, nor the run outputs folder (`RUN_OUTPUTS_PREFIX`) —
 * refused by name, never left to that alphabet —, nor one another account
 * shares — another account with the same username, or an agent of that
 * namespace another account owns — and the keys the rows name are then the
 * only ones deleted.
 *
 * After the commit, the name is free: a new account can take it at once. So the
 * second sweep reads again whether the namespace is in use (an account by that
 * name, or an agent under it) and lists nothing if it is; otherwise it deletes
 * only the listed keys no version row names. What remains: a new holder who
 * signs up and pushes between that read and the delete — milliseconds after a
 * deletion, for a name just freed — can lose the object of that push, written
 * before its row; the push succeeded, and its pulls and runs fail with a bundle
 * not found until a new version is pushed.
 *
 * Two stores, not one. Bundles live on the store the app was built with;
 * a cloud run's outputs on the store of the cloud runtime, absent on any other
 * runtime — where no run has output objects to purge.
 *
 * What a log line says. Success: the route kind and counts, nothing that names
 * the account — no username, GitHub id, e-mail, internal id, object key or file
 * name. A failure before the commit: the account's internal id (the account
 * still exists), the stage to resume from, the class and code of the error. A
 * failure after the commit: the stage and the error, and no id at all.
 */
import { createLogger, RUN_OUTPUTS_PREFIX } from "@skrun-dev/runtime";
import { evictInputFilesOfOwner } from "../cache/input-cache.js";
import { outputCache } from "../cache/output-cache.js";
import type { DbAdapter } from "../db/adapter.js";
import { PATH_SEGMENT_REGEX } from "../db/namespace.js";
import type { Run } from "../db/schema.js";
import { runOutputDeletes } from "../files/output-purge.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { errorFields } from "../utils/error-fields.js";
import type { DeletionJournal } from "./deletion-journal.js";

/** Which route asked: the account itself, or an administrator. */
export type AccountDeletionRoute = "self" | "admin";

/** What a successful deletion removed, as the success log line says it. */
export interface AccountDeletionCounts {
  agents: number;
  versions: number;
  api_keys: number;
  runs_cleared: number;
  /** Deletes the object stores accepted — a delete of a key already gone counts. */
  objects_deleted: number;
}

export type AccountDeletionOutcome =
  | { status: "deleted"; counts: AccountDeletionCounts }
  /** No such account — or another deletion of it committed first. */
  | { status: "not_found" }
  /** `confirm` is not the account's username: nothing was touched. */
  | { status: "confirmation_mismatch" }
  /** A delete failed before the database was touched; trying again resumes. */
  | { status: "storage_unavailable" };

/** Where a deletion that failed before its commit stopped. */
export type AccountDeletionStage = "plan" | "journal" | "storage" | "database";

/** The two log levels the service writes at. */
export interface AccountDeletionLog {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface AccountDeletionDeps {
  db: DbAdapter;
  /** The store bundles are pushed to. */
  bundleStorage: Pick<StorageAdapter, "delete" | "list">;
  /** The store a cloud run's outputs are uploaded to; absent on other runtimes. */
  outputStorage?: Pick<StorageAdapter, "delete">;
  /** The deletion journal, when the operator keeps one; absent, nothing is recorded. */
  journal?: DeletionJournal;
  log?: AccountDeletionLog;
  now?: () => Date;
}

export interface AccountDeletionRequest {
  userId: string;
  /** Must equal the account's username. */
  confirm: string;
  route: AccountDeletionRoute;
}

const defaultLog: AccountDeletionLog = createLogger("account-deletion");

/**
 * `<username>/`, when it can be swept; `null` otherwise. Two guards, each
 * enough on its own:
 *   - the run outputs folder (`RUN_OUTPUTS_PREFIX`, where the outputs of
 *     every cloud run live, whoever ran it) is refused by name. A dev token
 *     `_runs-token` signs in as the namespace `_runs`, and the shape below is
 *     not what keeps that folder out — it only happens to exclude `_` today;
 *   - a namespace outside the shape a push accepts (an account older than that
 *     rule) is not swept: its folder might be another name's.
 */
function namespaceFolder(username: string): string | null {
  const folder = `${username}/`;
  if (folder === RUN_OUTPUTS_PREFIX) return null;
  return PATH_SEGMENT_REGEX.test(username) ? folder : null;
}

/** Delete the account `userId` and everything it owns, in the order above. */
export async function deleteAccount(
  deps: AccountDeletionDeps,
  request: AccountDeletionRequest,
): Promise<AccountDeletionOutcome> {
  const { db, bundleStorage, outputStorage } = deps;
  const log = deps.log ?? defaultLog;
  const { userId, confirm, route } = request;

  const failed = (stage: AccountDeletionStage, err: unknown): void => {
    log.error(
      { event: "account_deletion_failed", user_id: userId, stage, ...errorFields(err) },
      "Account deletion failed; nothing after this stage was done, and trying again resumes",
    );
  };

  // (1) What there is to delete in object storage.
  let plan: Awaited<ReturnType<DbAdapter["planUserDeletion"]>>;
  try {
    plan = await db.planUserDeletion(userId);
  } catch (err) {
    failed("plan", err);
    throw err;
  }
  if (!plan) return { status: "not_found" };
  if (confirm !== plan.username) return { status: "confirmation_mismatch" };

  // The journal, once the request is checked and before anything is deleted.
  if (deps.journal) {
    try {
      await deps.journal.record("account", userId);
    } catch (err) {
      failed("journal", err);
      return { status: "storage_unavailable" };
    }
  }

  // (2) The objects, before any row. The first failure stops everything.
  let objectsDeleted = 0;
  const deletedBundleKeys = new Set<string>();
  const deleteBundle = async (key: string): Promise<void> => {
    if (deletedBundleKeys.has(key)) return;
    await bundleStorage.delete(key);
    deletedBundleKeys.add(key);
    objectsDeleted++;
  };
  // Never a key another account's version still names, before the commit or
  // after: two accounts can share a namespace on the SQLite and in-memory
  // stores, and two equal versions then share one object. Before the commit,
  // this account still names its own keys: only the others' versions count.
  const namedByOthers = async (keys: string[]): Promise<Set<string>> =>
    new Set(keys.length > 0 ? await db.referencedBundleKeys(keys, userId) : []);
  const folder = namespaceFolder(plan.username);
  let listed: string[] = [];
  try {
    if (folder && !plan.namespace_shared) listed = await bundleStorage.list(folder);
  } catch (err) {
    failed("storage", err);
    return { status: "storage_unavailable" };
  }
  const bundleKeys = [...new Set([...plan.bundle_keys, ...listed])];
  let kept: Set<string>;
  try {
    kept = await namedByOthers(bundleKeys);
  } catch (err) {
    failed("plan", err);
    throw err;
  }
  const purgedOutputRunIds: string[] = [];
  try {
    for (const key of bundleKeys) {
      if (!kept.has(key)) await deleteBundle(key);
    }
    if (outputStorage) {
      for (const run of plan.pending_outputs) {
        objectsDeleted += await deleteRunOutputs(outputStorage, run);
        purgedOutputRunIds.push(run.id);
      }
    }
  } catch (err) {
    failed("storage", err);
    return { status: "storage_unavailable" };
  }

  // (3) The rows, in one transaction.
  const at = (deps.now?.() ?? new Date()).toISOString();
  let result: Awaited<ReturnType<DbAdapter["deleteUser"]>>;
  try {
    result = await db.deleteUser(userId, { purged_output_run_ids: purgedOutputRunIds, at });
  } catch (err) {
    failed("database", err);
    throw err;
  }
  if (!result) return { status: "not_found" };

  // (4) After the commit: what appeared since (1). Logged, never answered.
  const cleanupFailed = (stage: string, err: unknown): void => {
    log.error(
      { event: "account_deletion_cleanup_failed", stage, ...errorFields(err) },
      "Account deleted, but an object left behind could not be deleted",
    );
  };
  // The key of a version pushed since (1). The name is free by now: a key a
  // version row names again — a new holder who pushed the same name and
  // version — is theirs, and stays, as in the second sweep below.
  const lateBundleKeys = result.bundle_keys.filter((key) => !deletedBundleKeys.has(key));
  if (lateBundleKeys.length > 0) {
    try {
      const named = await namedByOthers(lateBundleKeys);
      for (const key of lateBundleKeys) {
        if (named.has(key)) continue;
        try {
          await deleteBundle(key);
        } catch (err) {
          cleanupFailed("late_bundles", err);
        }
      }
    } catch (err) {
      cleanupFailed("late_bundles", err);
    }
  }
  // The second sweep: the name is free now, so it is read again first.
  if (folder && !plan.namespace_shared) {
    try {
      if (!(await db.namespaceInUse(plan.username))) {
        const listedAfter = await bundleStorage.list(folder);
        const named = await namedByOthers(listedAfter);
        for (const key of listedAfter) {
          if (!named.has(key)) await deleteBundle(key);
        }
      }
    } catch (err) {
      cleanupFailed("namespace_sweep", err);
    }
  }
  if (outputStorage) {
    for (const run of result.late_outputs) {
      try {
        objectsDeleted += await deleteRunOutputs(outputStorage, run);
        await db.markRunOutputsPurged(run.id, at);
      } catch (err) {
        // Its file list is cleared by now: the output purge can rebuild only
        // the archive's key, and what is left is for the bucket's lifecycle rule.
        cleanupFailed("late_outputs", err);
      }
    }
  }

  // (5) What this process holds of the account. Extracted bundles stay.
  for (const runId of result.cleared_run_ids) outputCache.delete(runId);
  evictInputFilesOfOwner(userId);

  const counts: AccountDeletionCounts = {
    agents: result.agents,
    versions: result.versions,
    api_keys: result.api_keys,
    runs_cleared: result.cleared_run_ids.length,
    objects_deleted: objectsDeleted,
  };
  log.info({ event: "account_deleted", route, ...counts }, "Account deleted");
  return { status: "deleted", counts };
}

/**
 * Delete a run's output objects, by the keys the output purge rebuilds — a
 * name the purge refuses gets no delete. Returns how many deletes succeeded;
 * the first failure throws.
 */
async function deleteRunOutputs(
  storage: Pick<StorageAdapter, "delete">,
  run: Pick<Run, "id" | "files">,
): Promise<number> {
  let deleted = 0;
  for (const { key } of runOutputDeletes(run).keys) {
    await storage.delete(key);
    deleted++;
  }
  return deleted;
}
