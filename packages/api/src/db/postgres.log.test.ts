import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresDb } from "./postgres.js";

// What PostgresDb logs when it is built. The constructor logs `db_connected`
// before any connection is made, so this file needs no Postgres (unlike
// postgres.test.ts, which runs only with DATABASE_URL). pino writes to the file
// descriptor directly, so the line is observed by replacing createLogger:
// vi.mock is hoisted above the import of ./postgres.js, which builds its logger
// at import time, and vi.hoisted declares the spy in lock-step. The rest of
// @skrun-dev/runtime is left intact.
const { logInfo } = vi.hoisted(() => ({ logInfo: vi.fn() }));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const logger = {
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: "info",
  };
  return { ...actual, createLogger: () => ({ ...logger, child: () => logger }) };
});

/** The db_connected call made while building a PostgresDb on `databaseUrl`. */
async function connectedLine(databaseUrl: string): Promise<{ url: unknown; whole: string }> {
  logInfo.mockClear();
  const db = new PostgresDb(databaseUrl);
  await db.close();
  const calls = logInfo.mock.calls.filter(([fields]) => fields?.event === "db_connected");
  expect(calls).toHaveLength(1);
  const args = calls[0] ?? [];
  return { url: args[0]?.url, whole: JSON.stringify(args) };
}

describe("the db_connected log line", () => {
  afterEach(() => {
    logInfo.mockClear();
  });

  it("writes host, port and database of a pooler URL, never its user or password", async () => {
    const line = await connectedLine("postgres://postgres.projectref0witness:pw0witness@h:5432/db");
    expect(line.url).toBe("h:5432/db");
    expect(line.whole).not.toContain("projectref0witness");
    expect(line.whole).not.toContain("pw0witness");
  });

  it("writes host, port and database of a URL whose password is in the query, never the query", async () => {
    const line = await connectedLine("postgres://h:5432/db?password=pw0witness&sslmode=require");
    expect(line.url).toBe("h:5432/db");
    expect(line.whole).not.toContain("pw0witness");
    expect(line.whole).not.toContain("password");
    expect(line.whole).not.toContain("sslmode");
  });

  // A URL that holds an `@` is believed only when the parser read credentials
  // before it and left no `@` after them. Otherwise the line falls back to what
  // follows the last `@` — when that `@` comes before any `?` or `#` — or to a
  // fixed text that holds nothing of the string.
  const NOT_LOGGED = "(unparseable database URL, not logged)";

  // A password left unencoded that holds a `/` after digits ends the authority
  // early: the URL still parses, with the user as its host and the digits as its
  // port — the way the Postgres client reads it too. That host is not trusted;
  // what follows the last `@` is the address.
  it("never takes the user for the host when an unencoded password holds a /", async () => {
    const line = await connectedLine(
      "postgres://postgres.projectref0witness:4242/pw0witness@h:5432/db",
    );
    expect(line.url).toBe("h:5432/db");
    expect(line.whole).not.toContain("projectref0witness");
    expect(line.whole).not.toContain("pw0witness");
    expect(line.whole).not.toContain("4242");
  });

  // The same with a `?` or a `#`: the last `@` then sits in what the parser read
  // as the query or the fragment, and nothing of the string is written.
  it.each([
    ["?", "postgres://postgres.projectref0witness:4242?pw0witness@h:5432/db"],
    ["#", "postgres://postgres.projectref0witness:4242#pw0witness@h:5432/db"],
  ])("writes nothing of the URL when an unencoded password holds a %s", async (_delimiter, url) => {
    const line = await connectedLine(url);
    expect(line.url).toBe(NOT_LOGGED);
    expect(line.whole).not.toContain("projectref0witness");
    expect(line.whole).not.toContain("pw0witness");
    expect(line.whole).not.toContain("4242");
  });

  // A password passed in the query that holds an `@`: the client reads it and
  // connects, and what follows that `@` is the end of the password, then the
  // user when it follows.
  it("writes nothing of the URL when a password in its query holds an @", async () => {
    const line = await connectedLine(
      "postgres://h:5432/db?password=pw0witness@tail0witness&user=user0witness",
    );
    expect(line.url).toBe(NOT_LOGGED);
    expect(line.whole).not.toContain("pw0witness");
    expect(line.whole).not.toContain("tail0witness");
    expect(line.whole).not.toContain("user0witness");
  });

  // An unencoded `@` in the password, then a `/`: the parser reads a user and a
  // password, and leaves an `@` in the path. What follows the last `@` is the
  // address.
  it("falls back when an @ is left after the credentials the parser read", async () => {
    const line = await connectedLine(
      "postgres://user0witness:pw0witness@x9/tail0witness@h:5432/db",
    );
    expect(line.url).toBe("h:5432/db");
    expect(line.whole).not.toContain("user0witness");
    expect(line.whole).not.toContain("pw0witness");
    expect(line.whole).not.toContain("tail0witness");
  });

  it("falls back to what follows the last @, without the query, when the URL does not parse", async () => {
    const noScheme = await connectedLine("user0witness:pw0witness@h:5432/db?sslmode=require");
    expect(noScheme.url).toBe("h:5432/db");
    expect(noScheme.whole).not.toContain("user0witness");
    expect(noScheme.whole).not.toContain("pw0witness");
    expect(noScheme.whole).not.toContain("sslmode");

    // Nothing to cut on: the string itself is never written.
    const noAt = await connectedLine("pw0witness");
    expect(noAt.whole).not.toContain("pw0witness");
  });
});

// Not a log line, but a method that needs no Postgres either: what the
// publication reads after a version's row failed. The classifier itself is
// held in `pg-timeouts.test.ts`; this pins that PostgresDb answers with it.
describe("PostgresDb.writeOutcomeUnknown", () => {
  it("is known only for a refusal the server answered", async () => {
    const db = new PostgresDb("postgres://h:5432/db");
    try {
      expect(db.writeOutcomeUnknown({ severity: "ERROR", code: "22P05" })).toBe(false);
      expect(db.writeOutcomeUnknown({ severity: "ERROR", code: "08006" })).toBe(true);
      expect(db.writeOutcomeUnknown(new Error("Connection terminated unexpectedly"))).toBe(true);
    } finally {
      await db.close();
    }
  });
});
