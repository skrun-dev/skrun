import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDisposableDatabaseUrl,
  isLoopbackHost,
  isPostgresUrl,
} from "./disposable-database.shared.js";

const SRC = join(import.meta.dirname, "..");
const PACKAGE = join(SRC, "..");

/** Every test or shared test file under `packages/api/src`, as a path relative to it. */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.(test|spec)\.[cm]?tsx?$|\.shared\.ts$/.test(entry.name) ? [relative(SRC, path)] : [];
  });
}

/** True when `source` reads DATABASE_URL from the environment, in any of the usual spellings. */
function readsDatabaseUrl(source: string): boolean {
  return (
    /process\.env\s*(?:\??\.\s*DATABASE_URL\b|(?:\?\.)?\s*\[\s*["'`]DATABASE_URL["'`]\s*\])/.test(
      source,
    ) || /\{[^}]*\bDATABASE_URL\b[^}]*\}\s*=\s*process\.env\b/.test(source)
  );
}

describe("the guard stays wired", () => {
  it("the suite's global setup judges DATABASE_URL before any worker starts", () => {
    const setup = readFileSync(join(PACKAGE, "vitest.global-setup.ts"), "utf8");
    const guard = setup.indexOf("assertDisposableDatabaseUrl(databaseUrl");
    expect(guard, "vitest.global-setup.ts no longer calls the guard").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(setup.indexOf("mkdtempSync("));
  });

  it("finds the two known readers (the scan itself works)", () => {
    const readers = testFiles(SRC).filter((file) =>
      readsDatabaseUrl(readFileSync(join(SRC, file), "utf8")),
    );
    expect(readers).toEqual(
      expect.arrayContaining([
        join("db", "postgres.test.ts"),
        join("db", "migrations-runner.test.ts"),
      ]),
    );
  });

  it.each([
    ["process.env.DATABASE_URL", true],
    ['process.env["DATABASE_URL"]', true],
    ["process.env?.DATABASE_URL", true],
    ["const { DATABASE_URL: url } = process.env;", true],
    ["process.env.DATABASE_URL_EXTRA", false],
    ["// DATABASE_URL is read by the setup", false],
  ])("recognises a reader: %s → %s", (source, reads) => {
    expect(readsDatabaseUrl(source)).toBe(reads);
  });

  it.each(
    testFiles(SRC).filter((file) => file !== join("db", "disposable-database.test.ts")),
  )("%s calls the guard before its first Postgres block, if it reads DATABASE_URL", (file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    if (!readsDatabaseUrl(source)) return;
    const guard = source.indexOf("assertDisposableDatabaseUrl(DATABASE_URL");
    expect(guard, `${file} reads DATABASE_URL without assertDisposableDatabaseUrl`).toBeGreaterThan(
      -1,
    );
    const firstBlock = source.indexOf("describeIfPg(");
    if (firstBlock !== -1) expect(guard).toBeLessThan(firstBlock);
  });
});

describe("the guard of the tests that destroy their database", () => {
  it.each([
    "postgres://postgres:postgres@localhost:5432/skrun_test",
    "postgres://postgres:postgres@LOCALHOST:5432/skrun_test",
    "postgresql://postgres:postgres@127.0.0.1:55432/skrun_test",
    "postgres://postgres:postgres@127.0.0.2/other_test",
    "postgres://postgres:postgres@[::1]:5432/skrun_test",
    "postgres://postgres:postgres@127.0.0.1:55432/skrun_test?sslmode=disable",
  ])("lets a throwaway Postgres on this machine run: %s", (url) => {
    expect(() => assertDisposableDatabaseUrl(url, "x.test.ts")).not.toThrow();
  });

  it.each([
    "postgresql://postgres.ref:secret-pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
    "postgres://postgres:secret-pw@db.example.com:5432/skrun_test",
    "postgres://postgres:secret-pw@postgres:5432/skrun_test",
    "postgres://postgres:secret-pw@10.0.0.5:5432/skrun_test",
    "postgres://postgres:secret-pw@128.0.0.1:5432/skrun_test",
    "postgres://postgres:secret-pw@localhost.example.com:5432/skrun_test",
    "postgres:///skrun_test",
  ])("refuses a server off this machine: %s", (url) => {
    expect(() => assertDisposableDatabaseUrl(url, "x.test.ts")).toThrow(
      /x\.test\.ts: refusing to run against the Postgres at .*not on this machine/,
    );
  });

  // The driver takes a host from the query over the one before it.
  it.each([
    "postgres://u:secret-pw@localhost:5432/skrun_test?host=remote.example.com",
    "postgres://u:secret-pw@127.0.0.1:5432/skrun_test?host=remote.example.com&port=6543",
    "postgres://u:secret-pw@localhost:5432/skrun_test?h%6Fst=remote.example.com",
    "postgres://u:secret-pw@localhost:5432/skrun_test?HOST=remote.example.com",
    "postgres://u:secret-pw@localhost:5432/skrun_test?hostaddr=203.0.113.9",
    "postgres://u:secret-pw@localhost:5432/skrun_test?service=prod",
    "postgres:///skrun_test?host=/var/run/postgresql",
  ])("refuses a query parameter that names another server: %s", (url) => {
    expect(() => assertDisposableDatabaseUrl(url, "x.test.ts")).toThrow(
      /x\.test\.ts: refusing to run(: DATABASE_URL carries a host| against the Postgres at)/,
    );
  });

  // "On this machine" is not "throwaway": a self-hosted stack's database, a tunnel's local end.
  it.each([
    "postgres://skrun:secret-pw@localhost:5432/skrun",
    "postgres://postgres:secret-pw@127.0.0.1:5432/postgres",
    "postgres://postgres:secret-pw@127.0.0.1:5432/",
    "postgres://postgres:secret-pw@127.0.0.1:5432/skrun_test_backup",
    "postgres://postgres:secret-pw@127.0.0.1:5432/test",
  ])("refuses a local database whose name does not end in _test: %s", (url) => {
    expect(() => assertDisposableDatabaseUrl(url, "x.test.ts")).toThrow(
      /x\.test\.ts: refusing to run against the database ".*": its name does not end in _test/,
    );
  });

  it("names the host, never the password", () => {
    let message = "";
    try {
      assertDisposableDatabaseUrl(
        "postgresql://postgres.ref:secret-pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
        "x.test.ts",
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"aws-0-eu-west-1.pooler.supabase.com"');
    expect(message).not.toContain("secret-pw");
  });

  it("refuses a value it cannot read as a URL, without echoing it", () => {
    let message = "";
    try {
      assertDisposableDatabaseUrl("postgres://secret-pw@[bad", "x.test.ts");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/x\.test\.ts: DATABASE_URL is not a URL this guard can read/);
    expect(message).not.toContain("secret-pw");
  });

  it("reads the loopback strictly", () => {
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
    expect(isLoopbackHost("127.0.0")).toBe(false);
    expect(isLoopbackHost("1127.0.0.1")).toBe(false);
    expect(isLoopbackHost("::2")).toBe(false);
  });

  it("knows a Postgres URL from another value", () => {
    expect(isPostgresUrl("postgres://h/d_test")).toBe(true);
    expect(isPostgresUrl("postgresql://h/d_test")).toBe(true);
    expect(isPostgresUrl("file:./skrun.db")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
  });
});
