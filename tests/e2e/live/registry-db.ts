/**
 * Read-only access to the database the live registry runs on, for the phases
 * that check what no public route shows.
 *
 * The registry uses Postgres when `DATABASE_URL` is set — it reads the same
 * environment (`dev.ts`) — otherwise the SQLite file it creates at the
 * repository root. Only SELECTs are sent. The URL is never printed.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ROOT } from "./_ctx.js";
import { assertLiveDatabase } from "./database-guard.js";

/** The part of `pg` this module uses. */
interface PgPool {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface PgModule {
  Pool: new (config: { connectionString: string; max?: number }) => PgPool;
}

// `pg` is a dependency of the API package only: it does not resolve from
// `tests/`. Resolved from that package, as the registry itself loads it — so
// the client, its version and its TLS behaviour are the registry's own.
const pg = createRequire(join(ROOT, "packages/api/package.json"))("pg") as PgModule;

/** Read-only access to the database the registry runs on. */
export interface RegistryDb {
  /** `postgres` or `sqlite`, for the result lines. */
  kind: string;
  /** Rows of a SELECT; `?` placeholders, numbered for Postgres. */
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** The registry's database, or null when there is none to read. */
export function openRegistryDb(): RegistryDb | null {
  // The suite's database guard, before a pool is opened on it.
  assertLiveDatabase(process.env);
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    return {
      kind: "postgres",
      async all(sql, params = []) {
        let n = 0;
        const numbered = sql.replace(/\?/g, () => `$${++n}`);
        return (await pool.query(numbered, params)).rows;
      },
      close: () => pool.end(),
    };
  }
  const dbFile = join(ROOT, "skrun.db");
  if (!existsSync(dbFile)) return null;
  const db = new Database(dbFile, { readonly: true });
  return {
    kind: "sqlite",
    async all(sql, params = []) {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    async close() {
      db.close();
    },
  };
}

/** A failed query, described without its message (which may name the host). */
export function queryFailure(err: unknown): string {
  const e = err as { name?: string; code?: string };
  return `query failed: ${e?.name ?? "Error"}${e?.code ? ` code=${e.code}` : ""}`;
}
