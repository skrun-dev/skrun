import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCookieName } from "./auth/session.js";
import { MemoryDb } from "./db/memory.js";
import { createApp } from "./index.js";
import { MemoryStorage } from "./storage/memory.js";

// The app's error handler logs through the runtime's logger factory, created at
// module level in ./index.js: replaced here, before that import, by spies per
// level — the shape of index.test.ts. Nothing else of the runtime is replaced.
const { logInfoSpy, logWarnSpy, logErrorSpy, logOtherSpy } = vi.hoisted(() => ({
  logInfoSpy: vi.fn(),
  logWarnSpy: vi.fn(),
  logErrorSpy: vi.fn(),
  logOtherSpy: vi.fn(),
}));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const levels = {
    info: logInfoSpy,
    warn: logWarnSpy,
    error: logErrorSpy,
    debug: logOtherSpy,
    trace: logOtherSpy,
    fatal: logOtherSpy,
  };
  return {
    ...actual,
    createLogger: () => ({ ...levels, level: "info", child: () => levels }),
  };
});

const ANSWER = {
  error: {
    code: "DATABASE_TIMEOUT",
    message:
      "The database did not answer in time. Try again in a few seconds; if the request changes something, check first whether it took effect.",
  },
};
const LINE_MESSAGE = "The database did not answer in time; the request was answered 503";

// A value that must reach no log line: the error's message may quote a row, and
// a database client carries its connection string, its password in it.
const WITNESS = "row-5c1d-never-in-a-log";

/** An error the database driver could raise, carrying the witness besides what it says. */
function driverError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), {
    client: { connectionString: `postgres://skrun:${WITNESS}@db.internal:5432/skrun` },
    ...fields,
  });
}

/** A database whose read of an account's keys fails with `err`. */
function dbFailingWith(err: Error): MemoryDb {
  const db = new MemoryDb();
  db.listApiKeys = async () => {
    throw err;
  };
  return db;
}

// A request whose database does not answer in time: a statement the server
// stopped at its bound, a connection the client gave up on, a wait for one of
// the pool's connections past its bound, a new connection that got no answer.
// The app answers 503 with a named code and a Retry-After, and logs one line
// that names the cause; any other error keeps the bare 500 it had.
describe("createApp — a request whose database does not answer in time", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SKRUN_RUNTIME;
    process.env.NODE_ENV = "test";
    process.env.SKRUN_DEV_AUTH = "1";
    for (const spy of [logInfoSpy, logWarnSpy, logErrorSpy, logOtherSpy]) spy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  /** Every call of every log level, as one text. */
  function everythingLogged(): string {
    const calls = [logInfoSpy, logWarnSpy, logErrorSpy, logOtherSpy].map((spy) => spy.mock.calls);
    return inspect(calls, { depth: 10 });
  }

  function linesOf(event: string): unknown[][] {
    return logErrorSpy.mock.calls.filter(([fields]) => fields?.event === event);
  }

  function listKeys(db: MemoryDb): Promise<Response> {
    return Promise.resolve(
      createApp(new MemoryStorage(), db).request("/api/keys", {
        headers: { Authorization: "Bearer dev-token" },
      }),
    );
  }

  it.each([
    [
      "a statement the server stopped at its bound (57014)",
      () =>
        driverError(`canceling statement due to statement timeout ${WITNESS}`, { code: "57014" }),
      { cause: "statement_timeout", error_name: "Error", error_code: "57014" },
    ],
    [
      "a connection the client's timer gave up on",
      () => driverError("Query read timeout"),
      { cause: "query_read_timeout", error_name: "Error" },
    ],
    [
      "every connection of the pool busy past the wait for one",
      () => driverError("timeout exceeded when trying to connect"),
      { cause: "pool_wait", error_name: "Error" },
    ],
    [
      "a new connection that got no answer in time",
      () =>
        driverError("Connection terminated due to connection timeout", {
          cause: new Error("Connection terminated unexpectedly"),
        }),
      { cause: "connect_timeout", error_name: "Error" },
    ],
  ])("%s: 503 DATABASE_TIMEOUT, Retry-After, one line naming the cause", async (_name, make, fields) => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await listKeys(dbFailingWith(make()));

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(ANSWER);
    expect(res.headers.get("Retry-After")).toBe("5");
    // One line: the method, the route's pattern, the cause, the error's class and code.
    expect(linesOf("database_timeout")).toEqual([
      [{ event: "database_timeout", method: "GET", route: "/api/keys", ...fields }, LINE_MESSAGE],
    ]);
    expect(linesOf("unhandled_error")).toEqual([]);
    // Neither the error's message nor the client it carries reaches a log line, nor stderr.
    expect(everythingLogged()).not.toContain(WITNESS);
    expect(printed).not.toHaveBeenCalled();
  });

  it("names the route by its pattern, never its path", async () => {
    const db = new MemoryDb();
    db.getAgent = async () => {
      throw driverError("canceling statement due to statement timeout", { code: "57014" });
    };

    const res = await createApp(new MemoryStorage(), db).request(`/api/agents/dev/${WITNESS}`, {
      headers: { Authorization: "Bearer dev-token" },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(ANSWER);
    expect(linesOf("database_timeout")).toEqual([
      [
        {
          event: "database_timeout",
          method: "GET",
          route: "/api/agents/:namespace/:name",
          cause: "statement_timeout",
          error_name: "Error",
          error_code: "57014",
        },
        LINE_MESSAGE,
      ],
    ]);
    expect(everythingLogged()).not.toContain(WITNESS);
  });

  it.each([
    [
      "a database that refuses the connection",
      () => driverError("connect ECONNREFUSED 127.0.0.1:5432", { code: "ECONNREFUSED" }),
    ],
    ["any other error", () => driverError("something else went wrong")],
  ])("%s: the bare 500, as before", async (_name, make) => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await listKeys(dbFailingWith(make()));

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe("Internal Server Error");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(linesOf("database_timeout")).toEqual([]);
    expect(linesOf("unhandled_error")).toHaveLength(1);
  });

  // The session cookie's read keeps its own answer: a database failure there is
  // not an absent session, and its 500 says so.
  it("a session cookie the database cannot check in time: the session's own 500, as before", async () => {
    const db = new MemoryDb();
    db.getSession = async () => {
      throw driverError("canceling statement due to statement timeout", { code: "57014" });
    };

    const res = await createApp(new MemoryStorage(), db).request("/api/keys", {
      headers: { Cookie: `${sessionCookieName()}=00000000-0000-4000-8000-000000000000` },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Session lookup failed" },
    });
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(linesOf("database_timeout")).toEqual([]);
  });
});
