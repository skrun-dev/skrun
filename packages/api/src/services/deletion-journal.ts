/**
 * The deletion journal: a record, outside the database, of each account deleted
 * and each API key revoked, so that a database restored from an earlier copy
 * can have them done again.
 *
 * One empty object per deletion, in the store the server keeps bundles in:
 * `_deletions/account/<id>` or `_deletions/api-key/<id>`, named by the internal
 * id alone, in lower case. The object carries nothing else: the store's own
 * date for the object says when it was written. Nothing here deletes those
 * objects — the operator's lifecycle rule on the prefix does.
 *
 * Off unless the operator sets `SKRUN_DELETION_JOURNAL=true`: no operator keeps
 * an id of a deleted account without having chosen to.
 *
 * This module imports no value from another package, types only: a script that
 * reads the journal after a restore loads it on its own, outside any build.
 */
import type { StorageAdapter } from "../storage/adapter.js";

/** Where the journal's objects live in the store. */
export const DELETION_JOURNAL_PREFIX = "_deletions/";

/** What was deleted: an account, or an API key (by its revocation). */
export type DeletionKind = "account" | "api-key";

/** Writes one record per deletion. */
export interface DeletionJournal {
  /** Writes the empty object of `kind` for `id`; rejects when the store does. */
  record(kind: DeletionKind, id: string): Promise<void>;
}

/** The shape of every id a backend mints (randomUUID()), in the one form the journal writes. */
const JOURNAL_KEY =
  /^_deletions\/(account|api-key)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * SKRUN_DELETION_JOURNAL, read the strict way. Unset → off. Set, it must be
 * `true` or `false` once the spaces around it are set aside, in any case;
 * anything else — the empty string, `1`, `yes`, `on` — throws, naming the
 * variable: the server reads it at its start, which refuses to go on. A value
 * read loosely could keep, or not keep, a record of deletions the operator
 * meant the other way.
 */
export function readDeletionJournal(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SKRUN_DELETION_JOURNAL;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `SKRUN_DELETION_JOURNAL must be true or false (got "${raw}"). Unset it to keep no deletion journal.`,
  );
}

/**
 * The journal, on `storage`. The id is written in lower case: an id arrives in
 * any case where a route accepts one, the database compares it as a UUID, and
 * whoever reads the journal back reads one form.
 */
export function createDeletionJournal(storage: Pick<StorageAdapter, "put">): DeletionJournal {
  return {
    async record(kind, id) {
      await storage.put(`${DELETION_JOURNAL_PREFIX}${kind}/${id.toLowerCase()}`, Buffer.alloc(0));
    },
  };
}

/**
 * What a key of the journal records, or `null` for a key the journal never
 * writes: another prefix, a sub-folder, an id that is not a lower-case UUID.
 */
export function parseDeletionKey(key: string): { kind: DeletionKind; id: string } | null {
  const match = JOURNAL_KEY.exec(key);
  if (!match) return null;
  return { kind: match[1] as DeletionKind, id: match[2] as string };
}
