/**
 * The one way a state write is expected to fail: what its row references — the
 * agent, the caller's account, the caller's key — no longer exists. An agent
 * deleted, or a key revoked, while a run was going makes the run's final write
 * fail this way; any other failure is not expected, and is not one of these.
 */

/** What a state row references, and a write can find gone. */
export type StateReference = "agent" | "account" | "key";

/**
 * Thrown by the in-memory backend for a write whose agent, account or key does
 * not exist — the refusal the SQL backends make through their foreign keys.
 */
export class MissingStateReferenceError extends Error {
  readonly code = "STATE_REFERENCE_MISSING";

  constructor(
    readonly reference: StateReference,
    id: string,
  ) {
    super(`agent_state: no ${reference} with id ${id}`);
    this.name = "MissingStateReferenceError";
  }
}

/** Postgres: a foreign key violation. */
const PG_FOREIGN_KEY_VIOLATION = "23503";
/** SQLite (better-sqlite3): a foreign key constraint failed. */
const SQLITE_FOREIGN_KEY = "SQLITE_CONSTRAINT_FOREIGNKEY";

/**
 * Whether a failed state write was refused because the agent, the account or
 * the key its row references does not exist — on any of the three backends.
 * Nothing else matches: a lost connection, a timeout, a CHECK violation or a
 * malformed id are other failures.
 */
export function isMissingStateReference(err: unknown): boolean {
  if (err instanceof MissingStateReferenceError) return true;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  return code === PG_FOREIGN_KEY_VIOLATION || code === SQLITE_FOREIGN_KEY;
}

/**
 * What a run fails with when its state write fails for any other reason: a
 * fixed message, since a database error's own message can name a table, a
 * constraint or a value, and the run's error reaches the caller. The original
 * error's code goes along; the error itself is the `cause`, and is logged by
 * its class and code where it is caught.
 */
/**
 * The same, for a state read that fails: a fixed message, the original code
 * along, the original error as the `cause`. A read is never absorbed.
 */
export class StateReadError extends Error {
  readonly code?: string;

  constructor(cause: unknown, code: string | undefined) {
    super("State read failed", { cause });
    this.name = "StateReadError";
    if (code !== undefined) this.code = code;
  }
}

export class StateWriteError extends Error {
  readonly code?: string;

  constructor(cause: unknown, code: string | undefined) {
    super("State write failed", { cause });
    this.name = "StateWriteError";
    if (code !== undefined) this.code = code;
  }
}
