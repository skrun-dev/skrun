import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLiveDatabase } from "./live/database-guard.js";

// The live suite's registry writes to whatever DATABASE_URL names, and its
// `.env` can fall back to one naming a shared database. These are the guard's
// real cases, and the proof that the suite calls it where it writes — and not
// when `_ctx.ts` loads, which the cloud smokes import without opening any
// database. `_ctx.ts` is read as text, never imported: importing it would load
// the suite's `.env`.

const LIVE = join(import.meta.dirname, "live");
const PASSWORD = "s3cr3t-pw";

const refusal = (value: string | undefined): string => {
  try {
    assertLiveDatabase({ DATABASE_URL: value });
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

describe("E2E: the live suite's database guard", () => {
  it.each([
    [
      "a throwaway Postgres on this machine",
      "postgres://postgres:postgres@127.0.0.1:55432/skrun_test",
    ],
    ["localhost, postgresql://", "postgresql://postgres:postgres@localhost:5432/skrun_test"],
    ["no DATABASE_URL (SQLite)", undefined],
    ["an empty DATABASE_URL (SQLite)", ""],
  ])("accepts %s", (_label, value) => {
    expect(() => assertLiveDatabase({ DATABASE_URL: value })).not.toThrow();
  });

  it("refuses a remote host, naming the host and never the URL", () => {
    const url = `postgres://user:${PASSWORD}@db.example.com:5432/skrun_test`;
    const message = refusal(url);
    expect(message).toContain('"db.example.com"');
    expect(message).toContain("the live suite");
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(url);
  });

  it("says what the live suite does to the database, and the way out — not the API tests' reason", () => {
    const message = refusal(`postgres://user:${PASSWORD}@db.example.com:5432/skrun_test`);
    expect(message).toContain("writes to the database it is given");
    expect(message).toContain("deletes accounts");
    expect(message).toContain("Leave DATABASE_URL empty for SQLite");
    expect(message).toContain("SKRUN_ENV_FILE");
    expect(message).not.toContain("These tests destroy");
  });

  it("refuses a host= parameter that names another server", () => {
    const message = refusal(
      `postgres://user:${PASSWORD}@127.0.0.1:5432/skrun_test?host=db.example.com`,
    );
    expect(message).toContain("host, hostaddr or service parameter");
    expect(message).not.toContain(PASSWORD);
  });

  it("refuses a local database whose name does not end in _test", () => {
    const message = refusal(`postgres://user:${PASSWORD}@127.0.0.1:5432/skrun`);
    expect(message).toContain('"skrun"');
    expect(message).not.toContain(PASSWORD);
  });

  // The registry reads any non-empty value as Postgres (packages/api/src/dev.ts):
  // a value that is not a postgres:// URL is not "SQLite", it is refused.
  it.each([
    ["an https:// address", "https://example.com/x_test"],
    ["blanks only", "   "],
    ["a bare word", "my-database"],
  ])("refuses %s, without echoing it", (_label, value) => {
    const message = refusal(value);
    expect(message).toContain("is not a postgres:// or postgresql:// URL");
    if (value.trim()) expect(message).not.toContain(value);
  });
});

/** The text of `name`'s body in `source`, from its declaration to the next top-level export. */
function exportedFunction(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) return "";
  const end = source.indexOf("\nexport ", start + declaration.length);
  return source.slice(start, end === -1 ? undefined : end);
}

/** What opens a database connection in these files (loading the `pg` module opens none). */
const OPENS_A_DATABASE = /new pg\.(?:Pool|Client)\(/;

describe("E2E: the live suite judges its database where it writes", () => {
  const ctx = readFileSync(join(LIVE, "_ctx.ts"), "utf8");

  it("loading _ctx.ts judges nothing (the cloud smokes import it and open no database)", () => {
    expect(ctx, "_ctx.ts calls the guard at load again").not.toMatch(/^assertLiveDatabase\(/m);
  });

  it("startRegistry() judges the environment it hands the registry, before stopping or starting one", () => {
    const body = exportedFunction(ctx, "export async function startRegistry(");
    expect(body, "startRegistry() is gone from _ctx.ts").not.toBe("");
    const guard = body.indexOf("assertLiveDatabase(env);");
    expect(guard, "startRegistry() no longer calls assertLiveDatabase(env)").toBeGreaterThan(-1);
    // After the environment is complete (extraEnv laid over it and its removals done)…
    expect(guard).toBeGreaterThan(body.indexOf("delete env[name];"));
    // …before the registry on :4000 is stopped, and before one is spawned with it.
    expect(guard).toBeLessThan(body.indexOf("killPort4000();"));
    const spawn = body.indexOf("spawn(process.execPath");
    expect(guard).toBeLessThan(spawn);
    expect(body.slice(spawn), "the registry is not spawned with the judged env").toMatch(
      /^spawn\([^)]*\{\s*cwd: ROOT,\s*env,/,
    );
  });

  it("every live file that opens the database judges it first", () => {
    const readers = readdirSync(LIVE)
      .filter((name) => name.endsWith(".ts") && name !== "database-guard.ts")
      .filter((name) =>
        /process\.env\s*(?:\??\.\s*DATABASE_URL\b|\[\s*["'`]DATABASE_URL["'`]\s*\])/.test(
          readFileSync(join(LIVE, name), "utf8"),
        ),
      );
    // The scan itself works: the two known readers are found.
    expect(readers).toEqual(expect.arrayContaining(["35-database-timeout.ts", "registry-db.ts"]));
    for (const name of readers) {
      const source = readFileSync(join(LIVE, name), "utf8");
      const guard = source.indexOf("assertLiveDatabase(process.env);");
      expect(guard, `${name} reads DATABASE_URL without the guard`).toBeGreaterThan(-1);
      const opens = source.search(OPENS_A_DATABASE);
      if (opens !== -1) {
        expect(guard, `${name} opens the database before judging it`).toBeLessThan(opens);
      }
    }
  });
});
