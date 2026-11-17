/**
 * What a run row references — the account that started it, the agent it ran,
 * the key it was started with — must exist when the row is written. The SQL
 * backends refuse a reference that names no row through their foreign keys;
 * the in-memory backend refuses it with the error below, so that a run naming
 * nothing fails on every backend, not on two of three.
 */

/** What a run row references, and a write can find missing. */
export type RunReference = "account" | "agent" | "key";

/**
 * Thrown by the in-memory backend for a run whose account, agent or key does
 * not exist — the refusal the SQL backends make through their foreign keys.
 */
export class MissingRunReferenceError extends Error {
  readonly code = "RUN_REFERENCE_MISSING";

  constructor(
    readonly reference: RunReference,
    id: string,
  ) {
    super(`runs: no ${reference} with id ${id}`);
    this.name = "MissingRunReferenceError";
  }
}
