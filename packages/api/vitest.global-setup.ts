import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDisposableDatabaseUrl, isPostgresUrl } from "./src/db/disposable-database.shared.js";

// The suite writes under the temp directory: bundle extractions, run output
// directories, uploads, SQLite files. It gets a temp directory of its own,
// set before the test workers start (they inherit it, and `os.tmpdir()` reads
// it at every call), and removed when the suite ends — so nothing a test writes
// there can outlive the run or land in the developer's temp directory.
export default function setup(): () => void {
  // Tests of this suite destroy the Postgres that DATABASE_URL names. Judged
  // once, before any worker starts, whichever file would read it and however:
  // only a throwaway Postgres on this machine, its database ending in _test
  // (`src/db/disposable-database.shared.ts`). A value of another kind is not a
  // Postgres the suite connects to, and is left alone.
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && isPostgresUrl(databaseUrl)) {
    assertDisposableDatabaseUrl(databaseUrl, "packages/api tests");
  }
  const dir = mkdtempSync(join(tmpdir(), "skrun-test-run-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = dir;
  return () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still open on Windows keeps its folder: the next run's own
      // directory is a fresh one either way.
    }
  };
}
