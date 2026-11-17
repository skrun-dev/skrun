import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BundleFetchFailedError } from "../errors.js";
import { downloadBundle } from "./bundle-download.js";

/**
 * The runner downloads an agent's bundle from a presigned URL before it checks
 * and extracts it. Every server below is a real one, on the loopback, on a port
 * the system picks, and each test closes what it opened.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

let dir: string;
let dest: string;
const servers: Array<HttpServer | TcpServer> = [];
const sockets = new Set<Socket>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skrun-bundle-download-"));
  dest = join(dir, "bundle.tgz");
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Starts `server` on the loopback and returns the port the system gave it. */
async function listen(server: HttpServer | TcpServer): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A download that fails drops its connection, and the server's end of it can
    // see a reset: a socket error with no listener would end the test process.
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** An HTTP server that answers every request with `handler`. */
async function serve(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
  const port = await listen(createHttpServer(handler));
  // A presigned URL's query is its credential: what an error says must not carry it.
  return `http://127.0.0.1:${port}/bundles/agent.tgz?X-Amz-Signature=do-not-tell`;
}

/** What the download left in its directory: the destination, and anything beside it. */
function leftBehind(): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** The rejection of `promise`, or a failure of the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("the download resolved");
}

describe("downloadBundle — a bundle served whole", () => {
  it("writes the bundle to its destination, and nothing beside it", async () => {
    const body = Buffer.alloc(256 * KIB, 7);
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });

    await downloadBundle(url, dest);

    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(leftBehind()).toEqual(["bundle.tgz"]);
  });

  it("does not compare a body sent compressed with the length its compressed form declared", async () => {
    const body = Buffer.alloc(64 * KIB, 3);
    const sent = gzipSync(body);
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": String(sent.length), "Content-Encoding": "gzip" });
      res.end(sent);
    });

    await downloadBundle(url, dest);

    expect(readFileSync(dest).equals(body)).toBe(true);
  });
});

describe("downloadBundle — a download that fails says how, and leaves nothing behind", () => {
  it("a body cut in the middle fails as incomplete, and the process lives on", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": String(MIB) });
      res.write(Buffer.alloc(64 * KIB, 1));
      // The connection drops with most of the body still to come.
      setTimeout(() => res.socket?.destroy(), 50);
    });

    const err = await rejection(downloadBundle(url, dest));

    expect(err).toBeInstanceOf(BundleFetchFailedError);
    const failed = err as BundleFetchFailedError;
    expect(failed.details.kind).toBe("incomplete");
    expect(failed.details.httpStatus).toBe(200);
    expect(failed.details.urlHost).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(failed.details.bytesDownloaded).toBeLessThan(MIB);
    expect(failed.message).not.toContain("do-not-tell");
    expect(leftBehind()).toEqual([]);
  });

  it("a refusal by status fails as such, and writes nothing", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/xml" });
      res.end("<Error><Code>AccessDenied</Code></Error>");
    });

    const err = await rejection(downloadBundle(url, dest));

    expect(err).toBeInstanceOf(BundleFetchFailedError);
    expect((err as BundleFetchFailedError).details).toMatchObject({
      kind: "status",
      httpStatus: 403,
      bytesDownloaded: 0,
    });
    expect((err as BundleFetchFailedError).message).not.toContain("do-not-tell");
    expect(leftBehind()).toEqual([]);
  });

  it("a body that ends short of its declared length fails as incomplete", async () => {
    // Written by hand: an HTTP server of Node's would not send this. The
    // connection is ended cleanly after half the body it announced.
    const port = await listen(
      createTcpServer((socket) => {
        socket.once("data", () => {
          socket.end(
            Buffer.concat([
              Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n"),
              Buffer.alloc(500, 2),
            ]),
          );
        });
      }),
    );

    const err = await rejection(downloadBundle(`http://127.0.0.1:${port}/agent.tgz`, dest));

    expect(err).toBeInstanceOf(BundleFetchFailedError);
    expect((err as BundleFetchFailedError).details.kind).toBe("incomplete");
    expect((err as BundleFetchFailedError).details.bytesDownloaded).toBeLessThan(1000);
    expect(leftBehind()).toEqual([]);
  });

  it("a body its transport delivers short of its declared length is counted, and fails as incomplete", async () => {
    // A transport that does not hold the body to its length, handed in: what is
    // checked is the count of bytes written against the declared length.
    const shortFetch: typeof fetch = async () =>
      new Response(new Uint8Array(500), { status: 200, headers: { "Content-Length": "1000" } });

    const err = await rejection(
      downloadBundle("https://store.example/agent.tgz?sig=1", dest, { fetch: shortFetch }),
    );

    expect(err).toBeInstanceOf(BundleFetchFailedError);
    expect((err as BundleFetchFailedError).details).toMatchObject({
      kind: "incomplete",
      httpStatus: 200,
      bytesDownloaded: 500,
      urlHost: "store.example",
    });
    expect(leftBehind()).toEqual([]);
  });

  it("a server that cannot be reached fails as a network failure, and writes nothing", async () => {
    // A port the system gave, then closed: nothing listens there any more.
    const port = await listen(createTcpServer());
    await new Promise<void>((done) => servers.pop()?.close(() => done()));

    const err = await rejection(downloadBundle(`http://127.0.0.1:${port}/agent.tgz`, dest));

    expect(err).toBeInstanceOf(BundleFetchFailedError);
    expect((err as BundleFetchFailedError).details).toMatchObject({
      kind: "network",
      httpStatus: null,
      bytesDownloaded: 0,
    });
    expect(leftBehind()).toEqual([]);
  });

  it("a destination it cannot write fails with the file system's own error, not as a download", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": String(KIB) });
      res.end(Buffer.alloc(KIB));
    });

    const err = await rejection(downloadBundle(url, join(dir, "no-such-dir", "bundle.tgz")));

    expect(err).not.toBeInstanceOf(BundleFetchFailedError);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(leftBehind()).toEqual([]);
  });

  it("a download its caller abandons ends with its caller's reason, and leaves nothing", async () => {
    const abandon = new AbortController();
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": String(MIB) });
      res.write(Buffer.alloc(64 * KIB, 1));
      // The rest never comes: the caller gives up first.
      setTimeout(() => abandon.abort(new Error("the caller gave up")), 50);
    });

    const err = await rejection(downloadBundle(url, dest, { signal: abandon.signal }));

    expect(err).toEqual(new Error("the caller gave up"));
    expect(leftBehind()).toEqual([]);
  });
});
