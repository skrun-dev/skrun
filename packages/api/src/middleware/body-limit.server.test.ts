import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

/**
 * The body caps through the HTTP server the API runs on (`@hono/node-server`),
 * not through `app.request`: what the server does with a body nobody read is
 * only visible on a real connection. When a route answers before reading its
 * body, the server reads the rest of it off the socket so the connection can
 * carry the next request. The caps must leave that intact — asking the request
 * for its body before the route does, or building the route's request from the
 * server's, wires a reader to the socket that stalls that clean-up, and the
 * server closes the connection instead.
 *
 * Loopback only, on a port the system picks.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const CHUNK = 64 * KIB;
const ANSWER_WAIT_MS = 5_000;

const savedRequest = globalThis.Request;
const savedResponse = globalThis.Response;

let server: Server;
let port: number;
/** What the reading route saw, for the case that reads. */
let probe: { length?: number; failed?: boolean; aborted?: boolean } = {};

beforeAll(async () => {
  const app = createApp(new MemoryStorage(), new MemoryDb(), { verificationPolicy: "admin" });
  app.post("/body-probe/read", async (c) => {
    const text = await c.req.text();
    return c.json({ length: text.length });
  });
  // A route that makes its own answer of a failed read, as the run route's 400 does.
  app.post("/body-probe/catch", async (c) => {
    try {
      await c.req.text();
    } catch {
      probe.failed = true;
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    }
    return c.json({});
  });
  app.post("/body-probe/abort", async (c) => {
    const signal = c.req.raw.signal;
    const aborted = new Promise<boolean>((resolve) => {
      if (signal.aborted) resolve(true);
      signal.addEventListener("abort", () => resolve(true));
      setTimeout(() => resolve(false), ANSWER_WAIT_MS);
    });
    try {
      await c.req.text();
    } catch {
      probe.failed = true;
    }
    probe.aborted = await aborted;
    return c.json({});
  });
  // As the server entry points do (`serve`): this listener also installs the
  // server's own Request and Response classes, restored after the file.
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.defineProperty(globalThis, "Request", { value: savedRequest });
  Object.defineProperty(globalThis, "Response", { value: savedResponse });
});

/** One connection: requests written on it in turn, status codes read off it. */
class Connection {
  private readonly socket: Socket;
  private received = "";
  closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (data: Buffer) => {
      this.received += data.toString("latin1");
    });
    // A reset or a broken pipe is an outcome the case asserts on, not a crash.
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
    });
  }

  static async open(): Promise<Connection> {
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    return new Connection(socket);
  }

  write(data: string | Buffer): void {
    if (!this.closed) this.socket.write(data);
  }

  /** The status codes answered so far on this connection, in order. */
  statuses(): number[] {
    return [...this.received.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1]));
  }

  /** Waits until `text` has arrived, the connection closed, or the wait ran out. */
  async arrived(text: string): Promise<boolean> {
    const deadline = Date.now() + ANSWER_WAIT_MS;
    while (!this.received.includes(text) && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.received.includes(text);
  }

  /** Waits until `count` answers have arrived, the connection closed, or the wait ran out. */
  async answers(count: number): Promise<number[]> {
    const deadline = Date.now() + ANSWER_WAIT_MS;
    while (this.statuses().length < count && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.statuses();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

const HEALTH = "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

function head(path: string, framing: string): string {
  return (
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
    `Content-Type: application/octet-stream\r\n${framing}\r\n\r\n`
  );
}

function chunked(total: number): Buffer {
  const frames: Buffer[] = [];
  for (let sent = 0; sent < total; sent += CHUNK) {
    const len = Math.min(CHUNK, total - sent);
    frames.push(
      Buffer.from(`${len.toString(16)}\r\n`),
      Buffer.alloc(len, 0x61),
      Buffer.from("\r\n"),
    );
  }
  frames.push(Buffer.from("0\r\n\r\n"));
  return Buffer.concat(frames);
}

describe("through the HTTP server, a route that answers before reading keeps its connection", () => {
  // The body is sent once the answer is in: the server has to read all of it
  // off the socket after answering, which is the clean-up these cases watch. A
  // body sent at once could already sit in the server's buffers by then.
  it("an early 401 on a 200 KB body with a Content-Length, then a second request on the same connection: 200", async () => {
    const conn = await Connection.open();
    try {
      conn.write(head("/api/files", `Content-Length: ${200 * KIB}`));
      expect(await conn.answers(1)).toEqual([401]);
      conn.write(Buffer.alloc(200 * KIB, 0x61));
      conn.write(HEALTH);
      expect(await conn.answers(2)).toEqual([401, 200]);
    } finally {
      conn.destroy();
    }
  });

  it("an early 401 on an 8 MB chunked body, then a second request on the same connection: 200", async () => {
    const conn = await Connection.open();
    try {
      conn.write(head("/api/files", "Transfer-Encoding: chunked"));
      conn.write(chunked(8 * MIB));
      expect(await conn.answers(1)).toEqual([401]);
      conn.write(HEALTH);
      expect(await conn.answers(2)).toEqual([401, 200]);
    } finally {
      conn.destroy();
    }
  });

  it("a declared Content-Length over the cap is refused 413, and the connection still carries the next request", async () => {
    const conn = await Connection.open();
    try {
      conn.write(head("/body-probe/read", `Content-Length: ${2 * MIB}`));
      expect(await conn.answers(1)).toEqual([413]);
      conn.write(Buffer.alloc(2 * MIB, 0x61));
      conn.write(HEALTH);
      expect(await conn.answers(2)).toEqual([413, 200]);
    } finally {
      conn.destroy();
    }
  });
});

describe("through the HTTP server, a method that carries no body is handed on as it came", () => {
  // A TRACE is only seen here: `new Request` refuses the method, so it cannot
  // be sent through `app.request`. The server hands it on without a body.
  it("a chunked TRACE /health is answered 404, then a GET /health on the same connection: 200", async () => {
    const conn = await Connection.open();
    try {
      conn.write(
        "TRACE /health HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n" +
          `5\r\naaaaa\r\n0\r\n\r\n${HEALTH}`,
      );
      expect(await conn.answers(2)).toEqual([404, 200]);
    } finally {
      conn.destroy();
    }
  });
});

describe("through the HTTP server, a route that reads gets the whole body and the client's signal", () => {
  it("a body under the cap is read whole, with or without a Content-Length, and the connection is reused", async () => {
    const conn = await Connection.open();
    try {
      conn.write(head("/body-probe/read", `Content-Length: ${300 * KIB}`));
      conn.write(Buffer.alloc(300 * KIB, 0x61));
      conn.write(head("/body-probe/read", "Transfer-Encoding: chunked"));
      conn.write(chunked(300 * KIB));
      conn.write(HEALTH);
      expect(await conn.answers(3)).toEqual([200, 200, 200]);
    } finally {
      conn.destroy();
    }
  });

  // The rest of the body stays unread: the server closes the connection once
  // its drain wait has run out (500 ms), so this case asks for the 413 only,
  // not for the connection to be reused.
  it("a 2 MB chunked body to a route that reads it: the client receives the cap's 413 REQUEST_TOO_LARGE", async () => {
    probe = {};
    const conn = await Connection.open();
    try {
      conn.write(head("/body-probe/catch", "Transfer-Encoding: chunked"));
      conn.write(chunked(2 * MIB));
      expect(await conn.answers(1)).toEqual([413]);
      expect(await conn.arrived('"code":"REQUEST_TOO_LARGE"')).toBe(true);
      expect(probe.failed).toBe(true);
    } finally {
      conn.destroy();
    }
  });

  it("a client gone in the middle of the body aborts the signal the route reads", async () => {
    probe = {};
    const conn = await Connection.open();
    conn.write(head("/body-probe/abort", "Transfer-Encoding: chunked"));
    conn.write(chunked(4 * CHUNK).subarray(0, 2 * (CHUNK + 16)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    conn.destroy();
    const deadline = Date.now() + ANSWER_WAIT_MS + 1_000;
    while (probe.aborted === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(probe).toEqual({ failed: true, aborted: true });
  });
});
