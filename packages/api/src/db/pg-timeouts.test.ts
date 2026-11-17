import { type AddressInfo, createServer, type Socket } from "node:net";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  clientTimeoutMs,
  DB_CLIENT_TIMEOUT_MARGIN_MS,
  DB_STATEMENT_TIMEOUT_MAX_MS,
  DB_STATEMENT_TIMEOUT_MIN_MS,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  databaseTimeoutCause,
  isClientReadTimeout,
  readDbStatementTimeoutMs,
  writeOutcomeUnknown,
} from "./pg-timeouts.js";

describe("readDbStatementTimeoutMs", () => {
  const refusal = (value: string) =>
    `SKRUN_DB_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 600000 (got "${value}"). Unset it to use the 10000 ms default.`;

  it("unset, it is the 10 s default — the suite inherits no value from the shell that runs it", () => {
    expect(DEFAULT_DB_STATEMENT_TIMEOUT_MS).toBe(10_000);
    expect(readDbStatementTimeoutMs({})).toBe(10_000);
    expect(readDbStatementTimeoutMs()).toBe(10_000);
  });

  it.each([
    "",
    "abc",
    "0",
    "-1",
    "999",
    "600001",
    "1e3",
    "1.5",
    "0x10",
    " ",
  ])("refuses %j, naming the variable and the value it got", (value) => {
    expect(() => readDbStatementTimeoutMs({ SKRUN_DB_STATEMENT_TIMEOUT_MS: value })).toThrow(
      refusal(value),
    );
  });

  it.each([
    ["1000", 1_000],
    ["600000", 600_000],
    [" 5000 ", 5_000],
  ])("takes %j as %d ms", (value, expected) => {
    expect(readDbStatementTimeoutMs({ SKRUN_DB_STATEMENT_TIMEOUT_MS: value })).toBe(expected);
  });

  it("its bounds are one second and ten minutes", () => {
    expect(DB_STATEMENT_TIMEOUT_MIN_MS).toBe(1_000);
    expect(DB_STATEMENT_TIMEOUT_MAX_MS).toBe(600_000);
  });
});

describe("clientTimeoutMs", () => {
  it("is the statement bound plus a 5 s margin", () => {
    expect(DB_CLIENT_TIMEOUT_MARGIN_MS).toBe(5_000);
    expect(clientTimeoutMs(10_000)).toBe(15_000);
    expect(clientTimeoutMs(1_000)).toBe(6_000);
  });
});

// ── What the installed driver says when the database does not answer ──
//
// A fake server on the loopback, no Postgres: it answers a client's startup
// with AuthenticationOk then ReadyForQuery — all a client needs to count as
// connected — and then says nothing more; or it accepts the connection and
// never answers at all. Each case provokes one error of the driver and reads
// the cause from it, so a driver that words it differently turns this red.

/** AuthenticationOk ('R', length 8, 0), then ReadyForQuery ('Z', length 5, idle). */
const STARTUP_ANSWER = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

interface FakeServer {
  url: string;
  close(): Promise<void>;
}

const servers: FakeServer[] = [];

async function fakeServer(mode: "silent-after-startup" | "never-answers"): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (mode === "silent-after-startup") socket.once("data", () => socket.write(STARTUP_ANSWER));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeServer = {
    url: `postgres://user:secret@127.0.0.1:${port}/db`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
  servers.push(fake);
  return fake;
}

/** The error `promise` rejects with; fails when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection, got a result");
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("databaseTimeoutCause, on the installed driver's own errors", () => {
  it("a query the server never answers, past the client's own timer: query_read_timeout", async () => {
    const server = await fakeServer("silent-after-startup");
    const client = new Client({ connectionString: server.url, query_timeout: 50 });
    await client.connect();
    try {
      const err = await rejectionOf(client.query("SELECT 1"));
      expect((err as Error).message).toBe("Query read timeout");
      expect(databaseTimeoutCause(err)).toBe("query_read_timeout");
      expect(isClientReadTimeout(err)).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("every connection of the pool busy past the wait for one: pool_wait", async () => {
    const server = await fakeServer("silent-after-startup");
    const pool = new Pool({ connectionString: server.url, max: 1, connectionTimeoutMillis: 50 });
    const held = await pool.connect();
    try {
      const err = await rejectionOf(pool.query("SELECT 1"));
      expect((err as Error).message).toBe("timeout exceeded when trying to connect");
      expect(databaseTimeoutCause(err)).toBe("pool_wait");
      expect(isClientReadTimeout(err)).toBe(false);
    } finally {
      held.release();
      await pool.end();
    }
  });

  it("a new connection of the pool that gets no answer at all: connect_timeout", async () => {
    const server = await fakeServer("never-answers");
    const pool = new Pool({ connectionString: server.url, max: 1, connectionTimeoutMillis: 50 });
    try {
      const err = await rejectionOf(pool.query("SELECT 1"));
      expect((err as Error).message).toBe("Connection terminated due to connection timeout");
      expect(databaseTimeoutCause(err)).toBe("connect_timeout");
      expect(isClientReadTimeout(err)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("a client outside a pool whose connection gets no answer at all: connect_timeout", async () => {
    const server = await fakeServer("never-answers");
    const client = new Client({ connectionString: server.url, connectionTimeoutMillis: 50 });
    const err = await rejectionOf(client.connect());
    expect((err as Error).message).toBe("timeout expired");
    expect(databaseTimeoutCause(err)).toBe("connect_timeout");
  });
});

describe("databaseTimeoutCause, on errors built by hand", () => {
  it("a statement the server stopped (57014): statement_timeout", () => {
    expect(databaseTimeoutCause({ code: "57014" })).toBe("statement_timeout");
    expect(isClientReadTimeout({ code: "57014" })).toBe(false);
  });

  it("reads the cause of a wrapped error, once", () => {
    expect(databaseTimeoutCause(new Error("wrapped", { cause: { code: "57014" } }))).toBe(
      "statement_timeout",
    );
    expect(databaseTimeoutCause({ cause: new Error("Query read timeout") })).toBe(
      "query_read_timeout",
    );
    expect(databaseTimeoutCause({ cause: { cause: { code: "57014" } } })).toBeNull();
  });

  it("any other error is not a timeout: null", () => {
    for (const err of [
      new Error("Connection terminated unexpectedly"),
      { code: "ECONNREFUSED" },
      { code: "ENOTFOUND" },
      { code: "55P03" },
      new Error("boom"),
      "57014",
      null,
      undefined,
    ]) {
      expect(databaseTimeoutCause(err)).toBeNull();
      expect(isClientReadTimeout(err)).toBe(false);
    }
  });
});

// ── Whether a write that threw may have been committed ──
//
// The same fake server, which answers a query with the server's own refusal —
// an ErrorResponse carrying a SQLSTATE — or closes the connection on it: the
// errors the installed driver builds from each, read as a write's outcome.

/** A Postgres message: its type byte, its length (itself included), its body. */
function message(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}

/** An ErrorResponse of `severity` — ERROR by default — and SQLSTATE `code`, then ReadyForQuery. */
function refusal(code: string, severity = "ERROR"): Buffer {
  const field = (tag: string, value: string) => Buffer.from(`${tag}${value}\0`);
  const body = Buffer.concat([
    field("S", severity),
    field("V", severity),
    field("C", code),
    field("M", "refused"),
    Buffer.from([0]),
  ]);
  return Buffer.concat([message("E", body), message("Z", Buffer.from("I"))]);
}

/** A server that completes the startup, then answers each query with `onQuery`. */
async function queryServer(onQuery: (socket: Socket) => void): Promise<string> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(STARTUP_ANSWER);
      socket.once("data", () => onQuery(socket));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push({
    url: "",
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  });
  return `postgres://user:secret@127.0.0.1:${port}/db`;
}

/** The error the installed driver rejects a query with, against `url`. */
async function queryError(url: string): Promise<unknown> {
  const client = new Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  try {
    return await rejectionOf(client.query("INSERT INTO t VALUES (1)"));
  } finally {
    await client.end().catch(() => {});
  }
}

describe("writeOutcomeUnknown, on the installed driver's own errors", () => {
  // One code of each class that says the statement was refused and rolled back.
  it.each([
    "22P05",
    "22P02",
    "23505",
    "25P02",
    "40001",
    "40P01",
    "42P01",
    "54001",
  ])("the server refused the write (%s): known — nothing was committed", async (code) => {
    const err = await queryError(await queryServer((socket) => socket.write(refusal(code))));
    expect((err as { code?: unknown }).code).toBe(code);
    expect(writeOutcomeUnknown(err)).toBe(false);
  });

  it.each([
    ["08006", "a connection failed"],
    ["08003", "a connection that does not exist"],
    ["57P01", "the server shutting down"],
    ["57P02", "a crash shutdown"],
    ["57P03", "the server not yet accepting"],
    ["57014", "a statement stopped"],
    ["53300", "too many connections"],
    ["58030", "a system error"],
    ["XX000", "an internal error"],
  ])("the server answered %s — %s: unknown", async (code) => {
    const err = await queryError(await queryServer((socket) => socket.write(refusal(code))));
    expect((err as { code?: unknown }).code).toBe(code);
    expect(writeOutcomeUnknown(err)).toBe(true);
  });

  // What a connection pooler answers when the server's session behind it dies
  // with a query in flight: a FATAL XX000 (Supavisor's default error).
  it("a pooler's FATAL XX000 for a session lost behind it: unknown", async () => {
    const err = await queryError(
      await queryServer((socket) => socket.write(refusal("XX000", "FATAL"))),
    );
    expect(err).toMatchObject({ severity: "FATAL", code: "XX000" });
    expect(writeOutcomeUnknown(err)).toBe(true);
  });

  it("a session-ending severity, whatever the class: unknown", async () => {
    for (const severity of ["FATAL", "PANIC"]) {
      const err = await queryError(
        await queryServer((socket) => socket.write(refusal("23505", severity))),
      );
      expect(err).toMatchObject({ severity, code: "23505" });
      expect(writeOutcomeUnknown(err)).toBe(true);
    }
  });

  it("the connection closed while the write waited, no SQLSTATE: unknown", async () => {
    const err = await queryError(await queryServer((socket) => socket.destroy()));
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(writeOutcomeUnknown(err)).toBe(true);
  });

  it("the client's own timer gave up on it: unknown", async () => {
    const url = await queryServer(() => {});
    const client = new Client({ connectionString: url, query_timeout: 50 });
    await client.connect();
    try {
      const err = await rejectionOf(client.query("INSERT INTO t VALUES (1)"));
      expect(isClientReadTimeout(err)).toBe(true);
      expect(writeOutcomeUnknown(err)).toBe(true);
    } finally {
      await client.end().catch(() => {});
    }
  });
});

describe("writeOutcomeUnknown, on errors built by hand", () => {
  it("a SQLSTATE without the server's severity is no answer of the server: unknown", () => {
    expect(writeOutcomeUnknown({ code: "23505" })).toBe(true);
    expect(writeOutcomeUnknown({ severity: "ERROR", code: "23505" })).toBe(false);
  });

  it("a code that is no SQLSTATE — a socket's — is unknown, even five capitals long", () => {
    expect(writeOutcomeUnknown({ severity: "ERROR", code: "ECONNRESET" })).toBe(true);
    expect(writeOutcomeUnknown({ code: "EPIPE" })).toBe(true);
    expect(writeOutcomeUnknown({ severity: "ERROR", code: "22p05" })).toBe(true);
  });

  it("the class decides, not a localized severity: a refusal in another language is known, an internal error is not", () => {
    expect(writeOutcomeUnknown({ severity: "ERREUR", code: "22P05" })).toBe(false);
    expect(writeOutcomeUnknown({ severity: "ERREUR", code: "XX000" })).toBe(true);
    expect(writeOutcomeUnknown({ severity: "ERROR", code: "P0001" })).toBe(true);
  });

  it("anything else is unknown", () => {
    for (const err of [new Error("boom"), "23505", null, undefined, { severity: "ERROR" }]) {
      expect(writeOutcomeUnknown(err)).toBe(true);
    }
  });
});
