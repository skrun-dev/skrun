import { createHook } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createSecureServer } from "node:http2";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isPrivateHost } from "./network.js";
import {
  createGuardedFetch,
  type HostResolver,
  ResponseBodyTooLargeError,
  SsrfBlockedError,
  safeFetch,
} from "./safe-fetch.js";

// A resolver test-double: returns the given addresses for ANY hostname. This is
// the DNS seam — we do NOT stub the global fetch (that would bypass the undici
// dispatcher the guard relies on).
const resolvesTo = (...addresses: string[]): HostResolver =>
  vi.fn(async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );

// A block surfaces either as a thrown SsrfBlockedError (bad scheme, synchronous)
// or as a rejected fetch whose `cause` is the SsrfBlockedError (an address or a
// host refused at a connection). Returns it, for the message.
async function expectSsrfBlocked(fn: () => Promise<unknown>): Promise<SsrfBlockedError> {
  let outcome: unknown;
  try {
    outcome = await fn();
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    expect(cause).toBeInstanceOf(SsrfBlockedError);
    return cause as SsrfBlockedError;
  }
  // Reached only when nothing was blocked: say what came back instead.
  const body =
    outcome instanceof Object && "text" in outcome
      ? await (outcome as { text: () => Promise<string> }).text()
      : String(outcome);
  throw new Error(`expected the SSRF guard to block the request; it returned: ${body}`);
}

// The guard's refusal of a request, or null when the guard let it go — whether
// the connection it opened then answered or failed.
async function guardRefusal(fn: () => Promise<unknown>): Promise<SsrfBlockedError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    return cause instanceof SsrfBlockedError ? cause : null;
  }
}

async function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("safeFetch — SSRF guard", () => {
  it("VT-1: blocks a host that resolves to a loopback IP", async () => {
    const resolver = resolvesTo("127.0.0.1");
    await expectSsrfBlocked(() =>
      safeFetch("http://evil.test/", undefined, { resolver, timeoutMs: 2000 }),
    );
    // The injected resolver IS the connect-time validation point — this proves
    // there is no separate pre-check / re-resolution window a rebinding attack
    // could slip through (the VT-2 property): undici connects to exactly what
    // this resolver returned, and it is validated here before any socket opens.
    expect(resolver).toHaveBeenCalledWith("evil.test");
  });

  it("VT-3: blocks when ANY resolved IP is private (multi-answer DNS)", async () => {
    await expectSsrfBlocked(() =>
      safeFetch("http://mixed.test/", undefined, {
        resolver: resolvesTo("93.184.216.34", "10.0.0.5"),
        timeoutMs: 2000,
      }),
    );
  });

  it("VT-4: blocks IPv6 unspecified (::) and IPv4-mapped IPv6", async () => {
    await expectSsrfBlocked(() =>
      safeFetch("http://a.test/", undefined, { resolver: resolvesTo("::"), timeoutMs: 2000 }),
    );
    await expectSsrfBlocked(() =>
      safeFetch("http://b.test/", undefined, {
        resolver: resolvesTo("::ffff:169.254.169.254"),
        timeoutMs: 2000,
      }),
    );
  });

  it("VT-8: rejects non-http(s) schemes before any resolution", async () => {
    await expectSsrfBlocked(() => safeFetch("file:///etc/passwd"));
    await expectSsrfBlocked(() => safeFetch("data:text/plain,hi"));
  });

  it("VT-5: completes a validated request, and allowPrivateHosts relaxes the block", async () => {
    // safeFetch blocks loopback, so to exercise the ALLOW path against a local
    // test server we opt in with allowPrivateHosts. This proves both that a
    // validated connection actually completes and that the opt-in works.
    const server = await startEchoServer();
    try {
      const res = await safeFetch(`http://127.0.0.1:${server.port}/`, undefined, {
        resolver: resolvesTo("127.0.0.1"),
        allowPrivateHosts: true,
        timeoutMs: 3000,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      await server.close();
    }
  });

  // Redirect hops: see the two suites below, which drive real redirects between
  // two local servers.

  it("createGuardedFetch (the MCP-injected fetch) blocks a private-resolving host", async () => {
    const guarded = createGuardedFetch({ resolver: resolvesTo("169.254.169.254") });
    await expectSsrfBlocked(() => guarded("http://metadata.test/"));
  });
});

// Two local servers drive real redirects. The redirector answers every request
// with the status and `Location` its query names; the target answers `from
// target` and counts the requests that reach it — what a redirect to an
// internal service would read. Both listen on 127.0.0.1, so the suites below say
// through the guard's two test seams what each address stands for: the resolver
// maps any name to 127.0.0.1, and `isPrivateAddress` lets
// 127.0.0.1 stand for a public address while every other private or reserved
// address stays one — the other spellings of loopback included, which are what
// a redirect aimed at the host would use.
const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
const PUBLIC_STAND_IN = "127.0.0.1";
const standInIsPublic = (address: string): boolean =>
  address !== PUBLIC_STAND_IN && isPrivateHost(address);
const anyNameToLoopback: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];

interface LocalServer {
  port: number;
  hits: number;
  close: () => Promise<void>;
}

async function listenLocal(handler: Parameters<typeof createServer>[1]): Promise<LocalServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const local: LocalServer = {
    port: typeof addr === "object" && addr ? addr.port : 0,
    hits: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server.on("request", () => {
    local.hits += 1;
  });
  return local;
}

function startRedirector(): Promise<LocalServer> {
  return listenLocal((req, res) => {
    const query = new URL(req.url ?? "/", "http://redirector").searchParams;
    res.writeHead(Number(query.get("status") ?? 307), { location: query.get("to") ?? "/" });
    res.end();
  });
}

function startTarget(): Promise<LocalServer> {
  return listenLocal((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("from target");
  });
}

describe("safeFetch — every connection's address is checked, a redirect hop's included", () => {
  let redirector: LocalServer;
  let target: LocalServer;
  beforeAll(async () => {
    redirector = await startRedirector();
    target = await startTarget();
  });
  afterAll(async () => {
    await redirector.close();
    await target.close();
  });
  beforeEach(() => {
    target.hits = 0;
  });

  // The redirector at the public stand-in, sending the request on to `to`.
  const via = (to: string, status = 307) =>
    `http://127.0.0.1:${redirector.port}/?status=${status}&to=${encodeURIComponent(to)}`;
  const standIn = { isPrivateAddress: standInIsPublic, timeoutMs: 5000 };

  it.each(REDIRECT_STATUSES)("refuses a %i to a private address literal", async (status) => {
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(via(`http://127.0.0.2:${target.port}/`, status), undefined, standIn),
    );
    expect(blocked.message).toBe("Blocked '127.0.0.2': a private/reserved address");
  });

  // Every spelling below reaches the host's own loopback, or a reserved address;
  // WHATWG URL parsing — undici's, for `Location` too — rewrites each into the
  // canonical form the guard then sees (measured: the message names it).
  it.each([
    ["an IPv4-mapped IPv6 literal", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"],
    ["the IPv6 loopback", "[::1]", "[::1]"],
    ["the IPv6 unspecified address", "[::]", "[::]"],
    ["the IPv4 unspecified address", "0.0.0.0", "0.0.0.0"],
    ["a hexadecimal IPv4", "0x7f.0.0.2", "127.0.0.2"],
    ["a single-number IPv4", "2130706434", "127.0.0.2"],
    ["an IPv4-compatible IPv6 literal", "[::127.0.0.1]", "[::7f00:1]"],
    ["an IPv4-translated IPv6 literal", "[::ffff:0:127.0.0.1]", "[::ffff:0:7f00:1]"],
  ])("refuses a hop to %s (%s), in its canonical form %s", async (_what, spelled, canonical) => {
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(via(`http://${spelled}:${target.port}/`), undefined, standIn),
    );
    expect(blocked.message).toBe(`Blocked '${canonical}': a private/reserved address`);
    expect(target.hits).toBe(0);
  });

  it("refuses a hop to a name that resolves to a private address, naming the name, never the address", async () => {
    const resolver: HostResolver = async (hostname) => [
      { address: hostname === "internal.test" ? "10.0.0.5" : "127.0.0.1", family: 4 },
    ];
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(via(`http://internal.test:${target.port}/`), undefined, { ...standIn, resolver }),
    );
    // The message reaches whoever handed the URL in; the address maps the
    // server's own network, so it travels apart, for the server's log.
    expect(blocked.message).toBe("Blocked 'internal.test': resolves to a private/reserved address");
    expect(blocked.message).not.toContain("10.0.0.5");
    expect(blocked.privateResolution).toEqual({ host: "internal.test", address: "10.0.0.5" });
    expect(target.hits).toBe(0);
  });

  it("carries no resolution on a refusal of an address written out", async () => {
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(via(`http://127.0.0.2:${target.port}/`), undefined, standIn),
    );
    expect(blocked.privateResolution).toBeUndefined();
  });

  it("follows a hop to a public address (the control: the stand-in is reachable)", async () => {
    const res = await safeFetch(via(`http://127.0.0.1:${target.port}/`), undefined, standIn);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(await res.text()).toBe("from target");
  });

  it("refuses a first URL that is a private literal, in any spelling, whatever its caller checked", async () => {
    // No seam here: the production classification. Before the guard checked
    // literals, each of these returned the target's body.
    for (const host of ["127.0.0.1", "2130706433", "0x7f.1", "0177.0.0.1"]) {
      const blocked = await expectSsrfBlocked(() =>
        safeFetch(`http://${host}:${target.port}/`, undefined, { timeoutMs: 5000 }),
      );
      expect(blocked.message).toBe("Blocked '127.0.0.1': a private/reserved address");
    }
    expect(target.hits).toBe(0);
  });

  it("follows a hop to a private address under allowPrivateHosts", async () => {
    const res = await safeFetch(via(`http://127.0.0.1:${target.port}/`), undefined, {
      allowPrivateHosts: true,
      timeoutMs: 5000,
    });
    expect(await res.text()).toBe("from target");
  });

  it("returns the 3xx as it is under followRedirects: false", async () => {
    const to = `http://127.0.0.1:${target.port}/`;
    const res = await safeFetch(via(to), undefined, {
      allowPrivateHosts: true,
      followRedirects: false,
      timeoutMs: 5000,
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(to);
    expect(target.hits).toBe(0);
  });
});

describe("safeFetch — allowedHosts holds every connection, a redirect hop's included", () => {
  let redirector: LocalServer;
  let target: LocalServer;
  beforeAll(async () => {
    redirector = await startRedirector();
    target = await startTarget();
  });
  afterAll(async () => {
    await redirector.close();
    await target.close();
  });
  beforeEach(() => {
    target.hits = 0;
  });

  // Names stand for the two hosts; both resolve to the public stand-in. The
  // address checks stay on, as in production: no agent's request runs under
  // allowPrivateHosts, so the list is tested without it.
  const viaFront = (to: string, status = 307) =>
    `http://front.test:${redirector.port}/?status=${status}&to=${encodeURIComponent(to)}`;
  const toTarget = () => `http://target.test:${target.port}/`;
  const listed = (allowedHosts: string[]) => ({
    allowedHosts,
    resolver: anyNameToLoopback,
    isPrivateAddress: standInIsPublic,
    timeoutMs: 5000,
  });

  it.each(REDIRECT_STATUSES)("refuses a %i to a host off the list", async (status) => {
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(viaFront(toTarget(), status), undefined, listed(["front.test"])),
    );
    expect(blocked.message).toBe("Blocked 'target.test': not in the allowed hosts");
    expect(target.hits).toBe(0);
  });

  it.each([
    [["front.test", "target.test"]],
    [["*.test"]],
    [["*"]],
  ])("follows a hop to a listed host — allowedHosts %j", async (allowedHosts) => {
    const res = await safeFetch(viaFront(toTarget()), undefined, listed(allowedHosts));
    expect(res.redirected).toBe(true);
    expect(await res.text()).toBe("from target");
    expect(target.hits).toBe(1);
  });

  it("holds a hop to an address literal to the list too", async () => {
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(viaFront(`http://127.0.0.1:${target.port}/`), undefined, listed(["front.test"])),
    );
    expect(blocked.message).toBe("Blocked '127.0.0.1': not in the allowed hosts");
    expect(target.hits).toBe(0);
  });

  it("refuses a first URL off the list, and refuses everything under an empty list", async () => {
    for (const allowedHosts of [["target.test"], []]) {
      const before = redirector.hits;
      await expectSsrfBlocked(() =>
        safeFetch(viaFront(toTarget()), undefined, listed(allowedHosts)),
      );
      expect(redirector.hits).toBe(before);
    }
  });

  it("allowPrivateHosts relaxes the address checks, never the list", async () => {
    const blocked = await expectSsrfBlocked(() =>
      safeFetch(viaFront(toTarget()), undefined, {
        allowedHosts: ["front.test"],
        allowPrivateHosts: true,
        resolver: anyNameToLoopback,
        timeoutMs: 5000,
      }),
    );
    expect(blocked.message).toBe("Blocked 'target.test': not in the allowed hosts");
    expect(target.hits).toBe(0);
  });

  // The guard sees an IPv6 literal in the form `URL.hostname` gives, bracketed;
  // the list may name it in any spelling. The hop goes to the IPv6 loopback, a
  // seam letting it stand for a public address. Nothing listens there: what the
  // network then answers is not the point, only whether the guard opened the way.
  describe("an IPv6 literal the list names", () => {
    const toV6 = () => `http://[::1]:${target.port}/`;
    const v6Listed = (entry: string) => ({
      allowedHosts: ["front.test", entry],
      resolver: anyNameToLoopback,
      isPrivateAddress: (address: string) => address !== "::1" && standInIsPublic(address),
      timeoutMs: 5000,
    });

    it.each([
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ])("lets a hop to it through when the list writes it %s", async (entry) => {
      expect(
        await guardRefusal(() => safeFetch(viaFront(toV6()), undefined, v6Listed(entry))),
      ).toBe(null);
    });

    it("refuses a hop to it when the list names another address", async () => {
      const refusal = await guardRefusal(() =>
        safeFetch(viaFront(toV6()), undefined, v6Listed("::2")),
      );
      expect(refusal?.message).toBe("Blocked '[::1]': not in the allowed hosts");
    });
  });

  it("createGuardedFetch passes the list on: a hop off it is refused, a listed one followed", async () => {
    const seams = { resolver: anyNameToLoopback, isPrivateAddress: standInIsPublic };
    const offList = createGuardedFetch({ ...seams, allowedHosts: ["front.test"] });
    await expectSsrfBlocked(() => offList(viaFront(toTarget())));
    const onList = createGuardedFetch({ ...seams, allowedHosts: ["front.test", "target.test"] });
    expect(await (await onList(viaFront(toTarget()))).text()).toBe("from target");
  });
});

// The guard wraps undici's fetch with a validating dispatcher. Everything else
// about the request and the response must pass through untouched: an LLM SDK
// injected with `createGuardedFetch` (the `base_url` path) builds its headers as
// a `Headers` instance and reads gzip-encoded JSON bodies. Neither was covered,
// and a public report claimed both were broken — they are not, and these cases
// keep it that way. The third case pins the one behaviour that DOES lose the
// bearer, so the doc sentence about it stays true.
describe("safeFetch — request/response fidelity on the base_url path", () => {
  async function startInspectingServer(opts: { gzip: boolean }) {
    const server: Server = createServer((req, res) => {
      const seen = JSON.stringify({
        authorization: req.headers.authorization ?? null,
        "x-custom": req.headers["x-custom"] ?? null,
      });
      if (opts.gzip) {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(seen));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(seen);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  const local = { resolver: resolvesTo("127.0.0.1"), allowPrivateHosts: true, timeoutMs: 3000 };

  it("passes a `Headers` instance through — the Authorization header reaches the server", async () => {
    const server = await startInspectingServer({ gzip: false });
    try {
      const headers = new Headers({ authorization: "Bearer sk-test", "x-custom": "yes" });
      const res = await safeFetch(
        `http://127.0.0.1:${server.port}/v1/chat/completions`,
        { method: "POST", headers, body: "{}" },
        local,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authorization: "Bearer sk-test", "x-custom": "yes" });
    } finally {
      await server.close();
    }
  });

  it("decodes a gzip-encoded JSON response — `json()` parses it", async () => {
    const server = await startInspectingServer({ gzip: true });
    try {
      const res = await safeFetch(
        `http://127.0.0.1:${server.port}/v1/chat/completions`,
        { headers: { authorization: "Bearer sk-test" } },
        local,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authorization: "Bearer sk-test", "x-custom": null });
    } finally {
      await server.close();
    }
  });

  it("drops the Authorization header on a cross-origin redirect (fetch standard) — the documented base_url trap", async () => {
    // Two servers on two ports are two origins. The first redirects to the
    // second; per the fetch standard the bearer must not follow. This is what a
    // `base_url` that redirects (http -> https, another host) looks like from the
    // provider's side: a request with no key, hence 401 — docs/agent-yaml.md says so.
    const target = await startInspectingServer({ gzip: false });
    const front: Server = createServer((req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}${req.url ?? "/"}` });
      res.end();
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", () => resolve()));
    const frontAddr = front.address();
    const frontPort = typeof frontAddr === "object" && frontAddr ? frontAddr.port : 0;
    try {
      const res = await safeFetch(
        `http://127.0.0.1:${frontPort}/v1/chat/completions`,
        { method: "POST", headers: { authorization: "Bearer sk-test" }, body: "{}" },
        local,
      );
      expect(res.status).toBe(200);
      expect(res.redirected).toBe(true);
      expect(await res.json()).toEqual({ authorization: null, "x-custom": null });
    } finally {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await target.close();
    }
  });
});

/** What a promise settles on: its value, or the error it rejects with. */
const outcomeOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    (value) => value,
    (err: unknown) => err,
  );

/**
 * The outcome of `pending`, or "still pending" when it has not settled within
 * `ms`: a case that waits on a request or on its body bounds the wait itself,
 * so that what never settles fails on the case's own assertion.
 */
async function within(ms: number, pending: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([outcomeOf(pending), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Node timers of at least `minDelayMs` alive in the process, however they
 * were armed — `setTimeout` or `AbortSignal.timeout` alike: an async hook sees
 * each one born, and sees it end when it fires or is cleared. A timer carries
 * its delay in `_idleTimeout`.
 */
function watchTimers(minDelayMs: number): { live: () => number; stop: () => void } {
  const live = new Set<number>();
  const hook = createHook({
    init(asyncId, type, _triggerAsyncId, resource) {
      const delay = (resource as { _idleTimeout?: unknown })._idleTimeout;
      if (type === "Timeout" && typeof delay === "number" && delay >= minDelayMs) {
        live.add(asyncId);
      }
    },
    destroy(asyncId) {
      live.delete(asyncId);
    },
  }).enable();
  return { live: () => live.size, stop: () => void hook.disable() };
}

// A bound on what one response body may carry. A local server answers each
// path its own way; every URL carries a path and a token, which no refusal may
// repeat. The bound is 4 MiB, the one the model router sets.
describe("safeFetch — a bound on a response's body", () => {
  const FOUR_MIB = 4 * 1024 * 1024;
  const SLICE = 64 * 1024;
  const BODY_REFUSAL =
    "The response body is larger than 4 MiB (4194304 bytes), the most this request may read. It was not read further.";

  /** A JSON document of exactly `bytes` bytes. */
  const jsonOfSize = (bytes: number): string => `{"pad":"${"a".repeat(bytes - 10)}"}`;
  /** `bytes` bytes written in slices with no length announced: the body goes chunked. */
  const writeChunked = (res: ServerResponse, bytes: number): void => {
    for (let sent = 0; sent < bytes; sent += SLICE) {
      res.write(Buffer.alloc(Math.min(SLICE, bytes - sent), 0x61));
    }
    res.end();
  };
  const gzipOver = gzipSync(Buffer.alloc(FOUR_MIB + 1, 0x61));
  const deflateOver = deflateSync(Buffer.alloc(FOUR_MIB + 1, 0x61));
  /** `bytes` bytes that no compression shrinks, drawn from a fixed seed: the same at every run. */
  const incompressible = (bytes: number): Buffer => {
    const out = Buffer.alloc(bytes);
    let state = 0x2545f491;
    for (let at = 0; at < bytes; at += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      out.writeUInt32LE(state >>> 0, at);
    }
    return out;
  };
  // Exactly the bound once decoded; gzip only adds to it, so its encoded length
  // — the one its Content-Length announces — is past the bound.
  const randomExact = incompressible(FOUR_MIB);
  const gzipExact = gzipSync(randomExact);

  // The request whose body is announced past the bound and never written:
  // whether the client closed its connection.
  const announced = { closed: false };
  let server: LocalServer;

  beforeAll(async () => {
    server = await listenLocal((req, res) => {
      res.on("error", () => undefined);
      const path = new URL(req.url ?? "/", "http://local").pathname.split("/").pop();
      switch (path) {
        case "exact":
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.alloc(FOUR_MIB, 0x61));
          return;
        case "chunked-exact":
          res.writeHead(200, { "content-type": "application/octet-stream" });
          writeChunked(res, FOUR_MIB);
          return;
        case "over":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonOfSize(FOUR_MIB + 1));
          return;
        case "chunked-over":
          res.writeHead(200, { "content-type": "application/octet-stream" });
          writeChunked(res, FOUR_MIB + 1);
          return;
        case "announced-over":
          req.socket.once("close", () => {
            announced.closed = true;
          });
          res.writeHead(200, { "content-length": String(FOUR_MIB + 1) });
          res.flushHeaders();
          return; // the body is never written
        case "identity-announced-over":
          req.socket.once("close", () => {
            announced.closed = true;
          });
          res.writeHead(200, {
            "content-encoding": "IDENTITY",
            "content-length": String(FOUR_MIB + 1),
          });
          res.flushHeaders();
          return; // the body is never written
        case "gzip-exact":
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-encoding": "gzip",
            "content-length": String(gzipExact.length),
          });
          res.end(gzipExact);
          return;
        case "deflate-over":
          res.writeHead(200, {
            "content-encoding": "deflate",
            "content-length": String(deflateOver.length),
          });
          res.end(deflateOver);
          return;
        case "gzip-over":
          res.writeHead(200, { "content-encoding": "gzip" });
          res.write(gzipOver);
          res.end();
          return;
        case "gzip-json":
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
          res.end(gzipSync(JSON.stringify({ answer: 42 })));
          return;
        case "error-over":
          res.writeHead(500, { "content-type": "text/plain" });
          writeChunked(res, FOUR_MIB + 1);
          return;
        case "no-content":
          res.writeHead(204);
          res.end();
          return;
        case "head":
          res.writeHead(200, { "content-length": String(5 * 1024 * 1024) });
          res.end();
          return;
        case "five-mib":
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "retry-after": "3600",
            "retry-after-ms": "3600000",
            "x-should-retry": "true",
            "x-request-id": "req-1",
          });
          res.end(Buffer.alloc(5 * 1024 * 1024, 0x61));
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    announced.closed = false;
  });

  const at = (path: string) =>
    `http://127.0.0.1:${server.port}/v1/secret-path/${path}?token=sk-sentinel-123`;
  const bounded = { allowPrivateHosts: true, maxResponseBytes: FOUR_MIB, timeoutMs: 15_000 };
  // Each wait is bounded by the case itself (`within`), well inside its timeout.
  const CASE = { timeout: 15_000 };

  it.each(["exact", "chunked-exact"])(
    "a body of exactly the bound is read whole (%s)",
    CASE,
    async (path) => {
      const res = await safeFetch(at(path), undefined, bounded);
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(FOUR_MIB);
    },
  );

  it(
    "a body one byte past the bound is refused by its body, never by the fetch — the class intact through json(), the message the bound's, never the URL",
    CASE,
    async () => {
      const fetched = await within(3_000, safeFetch(at("over"), undefined, bounded));
      // The fetch itself resolves: a client that retries a failed fetch is never
      // given one to retry.
      expect(fetched).toMatchObject({ status: 200 });
      const res = fetched as Awaited<ReturnType<typeof safeFetch>>;
      const refusal = await within(3_000, res.json());
      expect(refusal).toBeInstanceOf(ResponseBodyTooLargeError);
      expect((refusal as ResponseBodyTooLargeError).limitBytes).toBe(FOUR_MIB);
      const { message } = refusal as Error;
      expect(message).toBe(BODY_REFUSAL);
      for (const part of ["secret-path", "sk-sentinel-123", "127.0.0.1", `:${server.port}`]) {
        expect(message).not.toContain(part);
      }
    },
  );

  it(
    "a chunked body, no length announced, one byte past the bound: refused as it is read",
    CASE,
    async () => {
      const res = await safeFetch(at("chunked-over"), undefined, bounded);
      expect(await within(3_000, res.text())).toBeInstanceOf(ResponseBodyTooLargeError);
    },
  );

  it(
    "a Content-Length past the bound refuses at the first read, before a byte: the server sees its connection closed, its body never written",
    CASE,
    async () => {
      const res = await safeFetch(at("announced-over"), undefined, bounded);
      expect(res.status).toBe(200);
      expect(await within(3_000, res.text())).toBeInstanceOf(ResponseBodyTooLargeError);
      await vi.waitFor(() => expect(announced.closed).toBe(true), { timeout: 3_000, interval: 20 });
    },
  );

  it(
    "a Content-Length past the bound on a body sent as it is — content-encoding identity, in any case — refuses at the first read, before a byte",
    CASE,
    async () => {
      const res = await safeFetch(at("identity-announced-over"), undefined, bounded);
      expect(res.status).toBe(200);
      expect(await within(3_000, res.text())).toBeInstanceOf(ResponseBodyTooLargeError);
      await vi.waitFor(() => expect(announced.closed).toBe(true), { timeout: 3_000, interval: 20 });
    },
  );

  it(
    "a gzip body of exactly the bound once decoded, its Content-Length past it: read whole — a compressed body is judged by its decoded bytes, never by its announced length",
    CASE,
    async () => {
      expect(gzipExact.length).toBeGreaterThan(FOUR_MIB);
      const res = await safeFetch(at("gzip-exact"), undefined, bounded);
      expect(res.headers.get("content-length")).toBe(String(gzipExact.length));
      const body = await within(3_000, res.arrayBuffer());
      expect(body).toMatchObject({ byteLength: FOUR_MIB });
      expect(Buffer.from(body as ArrayBuffer).equals(randomExact)).toBe(true);
    },
  );

  it(
    "a Content-Length under the bound that does not tell the body's size — a deflate body that decodes past it — is refused at the bound",
    CASE,
    async () => {
      expect(deflateOver.length).toBeLessThan(FOUR_MIB);
      const res = await safeFetch(at("deflate-over"), undefined, bounded);
      expect(await within(3_000, res.arrayBuffer())).toBeInstanceOf(ResponseBodyTooLargeError);
    },
  );

  it(
    "a gzip body far under the bound that decodes past it is refused: the bytes counted are the decoded ones",
    CASE,
    async () => {
      expect(gzipOver.length).toBeLessThan(FOUR_MIB);
      const res = await safeFetch(at("gzip-over"), undefined, bounded);
      expect(await within(3_000, res.arrayBuffer())).toBeInstanceOf(ResponseBodyTooLargeError);
    },
  );

  it(
    "a gzip JSON under the bound is decoded once: json() parses it, the content-encoding header carried as it came",
    CASE,
    async () => {
      const res = await safeFetch(at("gzip-json"), undefined, bounded);
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect(await res.json()).toEqual({ answer: 42 });
    },
  );

  it(
    "an error body past the bound: the response and its status returned, the body refused at the bound",
    CASE,
    async () => {
      const res = await safeFetch(at("error-over"), undefined, bounded);
      expect(res.status).toBe(500);
      expect(await within(3_000, res.text())).toBeInstanceOf(ResponseBodyTooLargeError);
    },
  );

  it(
    "a response with no body passes whatever it announces — a 204, and a HEAD announcing 5 MiB",
    CASE,
    async () => {
      const noContent = await safeFetch(at("no-content"), undefined, bounded);
      expect(noContent.status).toBe(204);
      expect(await noContent.text()).toBe("");
      const head = await safeFetch(at("head"), { method: "HEAD" }, bounded);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    },
  );

  it("createGuardedFetch passes the bound on to each call", CASE, async () => {
    const guarded = createGuardedFetch({ allowPrivateHosts: true, maxResponseBytes: FOUR_MIB });
    const res = await guarded(at("chunked-over"));
    expect(await within(3_000, res.text())).toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it(
    "without the options, the response is undici's own, as it came: 5 MiB read whole, every header kept",
    CASE,
    async () => {
      const res = await safeFetch(at("five-mib"), undefined, {
        allowPrivateHosts: true,
        timeoutMs: 15_000,
      });
      // Only the response undici's fetch built knows the URL it came from.
      expect(res.url).toBe(at("five-mib"));
      expect(res.headers.get("retry-after")).toBe("3600");
      expect(res.headers.get("retry-after-ms")).toBe("3600000");
      expect(res.headers.get("x-should-retry")).toBe("true");
      expect(res.headers.get("x-request-id")).toBe("req-1");
      expect((await res.arrayBuffer()).byteLength).toBe(5 * 1024 * 1024);
    },
  );
});

// A deadline on the request, the read of its body included, and the retry
// headers taken off the response. Real time throughout: the request is served
// by a real local server, whose sockets and timers no fake clock drives; the
// deadline's own timers are counted by an async hook (`watchTimers`).
describe("safeFetch — a deadline on the whole request, and the retry headers removed", () => {
  const FOUR_MIB = 4 * 1024 * 1024;
  // The request served drip by drip: whether the client closed its connection.
  const drip = { closed: false };
  let slowHits = 0;
  let server: LocalServer;

  beforeAll(async () => {
    server = await listenLocal((req, res) => {
      res.on("error", () => undefined);
      const path = new URL(req.url ?? "/", "http://local").pathname.split("/").pop();
      switch (path) {
        case "drip": {
          // The headers at once, then one byte every 50 ms, without end.
          res.writeHead(200, { "content-type": "text/plain" });
          res.flushHeaders();
          const timer = setInterval(() => res.write("a"), 50);
          res.on("close", () => {
            clearInterval(timer);
            drip.closed = true;
          });
          return;
        }
        case "slow-ok":
          // Answers after 100 ms: long past a timer that would fire after 1 ms.
          slowHits += 1;
          setTimeout(() => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
          }, 100);
          return;
        case "rate-limited":
          res.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "3600",
            "retry-after-ms": "3600000",
            "x-should-retry": "false",
            "x-request-id": "req-2",
          });
          res.end('{"error":{"message":"slow down"}}');
          return;
        case "ok":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          return;
        case "no-content":
          res.writeHead(204);
          res.end();
          return;
        case "broken":
          // No answer: the connection is cut, and the fetch fails.
          req.socket.destroy();
          return;
        case "cut":
          // The headers and part of the body, then the connection cut.
          res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
          res.write("0123456789");
          setTimeout(() => req.socket.destroy(), 20);
          return;
        case "heavy":
          // A body past the small bound the cases below set.
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("a".repeat(2_048));
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    drip.closed = false;
    slowHits = 0;
  });

  const at = (path: string) => `http://127.0.0.1:${server.port}/v1/${path}`;
  // Each wait is bounded by the case itself (`within`), well inside its timeout.
  const CASE = { timeout: 15_000 };

  it.each([
    ["alone", {}],
    ["with a bound on the body", { maxResponseBytes: FOUR_MIB }],
  ])(
    "a body served drip by drip is cut at the deadline — %s — and its connection closed",
    CASE,
    async (_what, extra) => {
      const startedAt = Date.now();
      const guarded = createGuardedFetch({
        allowPrivateHosts: true,
        deadline: startedAt + 400,
        ...extra,
      });
      const fetched = await within(3_000, guarded(at("drip")));
      expect(fetched).toMatchObject({ status: 200 });
      const res = fetched as Awaited<ReturnType<typeof guarded>>;
      const outcome = await within(3_000, res.text());
      expect(outcome).toMatchObject({ name: "TimeoutError" });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await vi.waitFor(() => expect(drip.closed).toBe(true), { timeout: 3_000, interval: 20 });
    },
  );

  it("the caller's own signal still cuts the read under a deadline far off", CASE, async () => {
    const caller = new AbortController();
    const guarded = createGuardedFetch({
      allowPrivateHosts: true,
      maxResponseBytes: FOUR_MIB,
      deadline: Date.now() + 60_000,
    });
    const fetched = await within(3_000, guarded(at("drip"), { signal: caller.signal }));
    expect(fetched).toMatchObject({ status: 200 });
    const res = fetched as Awaited<ReturnType<typeof guarded>>;
    setTimeout(() => caller.abort(), 300);
    const outcome = await within(3_000, res.text());
    expect(outcome).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(drip.closed).toBe(true), { timeout: 3_000, interval: 20 });
  });

  it(
    "a deadline 30 days off lets a normal response be read: the delay is held to what a timer takes",
    CASE,
    async () => {
      const guarded = createGuardedFetch({
        allowPrivateHosts: true,
        deadline: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      const outcome = await within(
        3_000,
        guarded(at("slow-ok")).then((res) => res.text()),
      );
      expect(outcome).toBe("ok");
    },
  );

  // A request under a deadline ten minutes off and its caller's own signal:
  // once its body is decided, no timer of that length is alive, and the
  // caller's signal is no longer listened to.
  async function decidedBody(
    path: string,
    extra: { maxResponseBytes?: number },
    expected: (outcome: unknown) => void,
  ): Promise<void> {
    const timers = watchTimers(9 * 60_000);
    try {
      const guarded = createGuardedFetch({
        allowPrivateHosts: true,
        deadline: Date.now() + 10 * 60_000,
        ...extra,
      });
      const caller = new AbortController();
      const res = await guarded(at(path), { signal: caller.signal });
      expected(await within(3_000, res.text()));
      await vi.waitFor(() => expect(timers.live()).toBe(0), { timeout: 1_000, interval: 10 });
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    } finally {
      timers.stop();
    }
  }

  it(
    "a body whose connection is cut part way leaves no timer of its deadline and no listener on its caller's signal",
    CASE,
    async () => {
      await decidedBody("cut", {}, (outcome) => expect(outcome).toBeInstanceOf(Error));
    },
  );

  it(
    "a body refused past its bound leaves no timer of its deadline and no listener on its caller's signal",
    CASE,
    async () => {
      await decidedBody("heavy", { maxResponseBytes: 1_024 }, (outcome) =>
        expect(outcome).toBeInstanceOf(ResponseBodyTooLargeError),
      );
    },
  );

  it(
    "a deadline reached while nobody reads the body: the caller's signal is no longer listened to",
    CASE,
    async () => {
      const caller = new AbortController();
      const guarded = createGuardedFetch({ allowPrivateHosts: true, deadline: Date.now() + 300 });
      const res = await guarded(at("drip"), { signal: caller.signal });
      expect(res.status).toBe(200);
      // The body is left unread past the deadline.
      await vi.waitFor(() => expect(drip.closed).toBe(true), { timeout: 3_000, interval: 20 });
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    },
  );

  it("a deadline already past abandons the request before it is sent", CASE, async () => {
    const guarded = createGuardedFetch({ allowPrivateHosts: true, deadline: Date.now() - 1 });
    const outcome = await within(3_000, guarded(at("slow-ok")));
    expect(outcome).toMatchObject({ name: "TimeoutError" });
    expect(slowHits).toBe(0);
  });

  it.each([
    ["alone", {}],
    [
      "with a bound on the body and the retry headers removed",
      { maxResponseBytes: FOUR_MIB, stripRetryHeaders: true },
    ],
  ])(
    "a request once decided — its body read to its end, no body, its body cancelled, a failed fetch, its caller's abort — leaves no timer of its deadline and no listener on its caller's signal (%s)",
    CASE,
    async (_what, extra) => {
      // A deadline ten minutes off: the only timers of that length are the deadline's.
      const timers = watchTimers(9 * 60_000);
      try {
        const guarded = createGuardedFetch({
          allowPrivateHosts: true,
          deadline: Date.now() + 10 * 60_000,
          ...extra,
        });
        // Each request under its caller's own signal, as the model SDK sends it.
        const request = (path: string) => {
          const caller = new AbortController();
          return { caller, response: guarded(at(path), { signal: caller.signal }) };
        };
        const leftBehind = async (caller: AbortController): Promise<void> => {
          await vi.waitFor(() => expect(timers.live()).toBe(0), { timeout: 1_000, interval: 10 });
          expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
        };

        const read = request("ok");
        expect(await (await read.response).text()).toBe("ok");
        await leftBehind(read.caller);

        const empty = request("no-content");
        expect((await empty.response).status).toBe(204);
        await leftBehind(empty.caller);

        const cancelled = request("drip");
        await (await cancelled.response).body?.cancel();
        await leftBehind(cancelled.caller);
        await vi.waitFor(() => expect(drip.closed).toBe(true), { timeout: 3_000, interval: 20 });

        const failed = request("broken");
        expect(await within(3_000, failed.response)).toBeInstanceOf(Error);
        await leftBehind(failed.caller);

        const abandoned = request("drip");
        const body = (await abandoned.response).text();
        abandoned.caller.abort();
        expect(await within(3_000, body)).toMatchObject({ name: "AbortError" });
        await leftBehind(abandoned.caller);
      } finally {
        timers.stop();
      }
    },
  );

  it(
    "stripRetryHeaders takes the three retry headers off a 429, every other header and the body kept",
    CASE,
    async () => {
      const guarded = createGuardedFetch({ allowPrivateHosts: true, stripRetryHeaders: true });
      const res = await guarded(at("rate-limited"));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.get("retry-after-ms")).toBeNull();
      expect(res.headers.get("x-should-retry")).toBeNull();
      expect(res.headers.get("x-request-id")).toBe("req-2");
      expect(await res.json()).toEqual({ error: { message: "slow down" } });
    },
  );
});

// A rebuilt response (a bound on its body, a deadline, the retry headers
// removed) copies the status of the one fetched. A server may write its reason
// phrase in UTF-8, which a response's constructor refuses: the status is kept,
// its phrase left empty, and the fetch never rejected for it.
describe("safeFetch — a rebuilt response keeps its status whatever its reason phrase", () => {
  let server: NetServer;
  let port = 0;

  beforeAll(async () => {
    // A raw server: Node's HTTP server refuses to write such a reason phrase.
    server = createNetServer((socket) => {
      socket.once("data", (request) => {
        // `/plain` answers a phrase of plain ASCII; `/latin`, one whose last
        // character, written in UTF-8, is a Latin-1 one (U+00E9); any other
        // path, one past Latin-1 (U+2713).
        const line = request.toString("latin1");
        const phrase = line.startsWith("GET /plain ")
          ? "All good"
          : line.startsWith("GET /latin ")
            ? "OK é"
            : "OK ✓";
        socket.end(
          Buffer.concat([
            Buffer.from(`HTTP/1.1 200 ${phrase}`, "utf8"),
            Buffer.from(
              "\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
              "latin1",
            ),
          ]),
        );
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ["a bound on the body", { maxResponseBytes: 4 * 1024 * 1024 }],
    ["a deadline", { deadline: Date.now() + 60_000 }],
    ["the retry headers removed", { stripRetryHeaders: true }],
  ])(
    "a reason phrase that is not Latin-1, under %s: the response resolves, its status and body read",
    { timeout: 15_000 },
    async (_what, extra) => {
      const fetched = await within(
        3_000,
        safeFetch(`http://127.0.0.1:${port}/v1/chat`, undefined, {
          allowPrivateHosts: true,
          timeoutMs: 10_000,
          ...extra,
        }),
      );
      expect(fetched).toMatchObject({ status: 200, statusText: "" });
      const res = fetched as Awaited<ReturnType<typeof safeFetch>>;
      expect(await res.text()).toBe("ok");
    },
  );

  it("a reason phrase of plain ASCII is kept as it came", { timeout: 15_000 }, async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/plain`, undefined, {
      allowPrivateHosts: true,
      timeoutMs: 10_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("All good");
    expect(await res.text()).toBe("ok");
  });

  it("a reason phrase with a Latin-1 character past ASCII (U+00E9) is kept as it came", {
    timeout: 15_000,
  }, async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/latin`, undefined, {
      allowPrivateHosts: true,
      timeoutMs: 10_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK é");
    expect(await res.text()).toBe("ok");
  });
});

// A throwaway self-signed certificate from the openssl CLI (present on the CI
// runners and on developer machines; a pure-JS generator was tried first and
// produced a certificate Node's TLS client hangs on). Missing openssl is a
// failure here, never a skip: a control that cannot run has not run.
function selfSignedCert(): { dir: string; key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "skrun-h2-"));
  const keyPath = join(dir, "t.key");
  const certPath = join(dir, "t.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return { dir, key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

describe("safeFetch — over an HTTP/2 origin (the base_url path as a hosted provider presents it)", () => {
  // undici 8 enables HTTP/2 by default on its Agent, so against a TLS origin that
  // offers h2 the guard's own connection is HTTP/2 — the one shape the plain
  // HTTP/1.1 fidelity tests above do not cover, and the one an OpenAI-compatible
  // provider behind nginx or a CDN presents. github.com/skrun-dev/skrun/issues/12
  // reported this shape as broken (gzip left raw, bearer dropped); measured intact
  // on Node 22.12 / 24.12 / 24.14 × undici 8.10.0 / 8.10.2 / 8.11.0 on 2026-09-23.
  // This pins the three properties at once: h2 is really negotiated, a `Headers`
  // instance reaches the server, the gzip body is decoded.
  it("negotiates h2, passes a `Headers` instance, decodes gzip", { timeout: 15_000 }, async () => {
    const { dir, key, cert } = selfSignedCert();
    let seen: { httpVersion: string; authorization: string | null } | null = null;
    const payload = { choices: [{ message: { content: "42" } }] };
    const server = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
      seen = { httpVersion: req.httpVersion, authorization: req.headers.authorization ?? null };
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify(payload)));
    });
    server.on("session", (session) => session.on("error", () => undefined));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    // Self-signed for this one test; read at connect time, so scoped and restored.
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const res = await safeFetch(
        `https://localhost:${port}/v1/chat/completions`,
        { method: "POST", headers: new Headers({ authorization: "Bearer sk-test" }), body: "{}" },
        { resolver: resolvesTo("127.0.0.1"), allowPrivateHosts: true, timeoutMs: 5000 },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(payload);
      expect(seen).toEqual({ httpVersion: "2.0", authorization: "Bearer sk-test" });
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("safeFetch — the guard must not degrade the process's built-in fetch (ADR-026)", () => {
  // The guard uses the npm `undici` for its own fetch + dispatcher. Node's
  // built-in fetch bundles ANOTHER undici, and the two share one global
  // dispatcher slot (`Symbol.for("undici.globalDispatcher.1")`): loading the
  // npm package writes a wrapper there whenever the package's own slot (`.2`)
  // is still empty — always up to Node 24.12, and from 24.20 when the package
  // loads before Node fills its slots (see `safe-fetch.ts`). With
  // undici 8.11.0 that wrapper negotiated HTTP/2 for the built-in fetch's own
  // connections, and the built-in fetch then received gzip bodies raw, with no
  // `content-encoding` header to tell it so — every plain `fetch()` in the api
  // process against an h2 origin (GitHub's OAuth token endpoint first) got bytes
  // `json()` could not parse. Seen on 2026-09-22, the day 8.11.0 shipped, on an
  // image built two hours later. The guard now loads the package on first use
  // and hands the slot back. This pins the PROPERTY, on the shape that exposed
  // it: TLS + ALPN h2, gzip body (a plain-HTTP or HTTP/1.1 server does not
  // reproduce it) — and, so that it also fails on a benign undici version (one
  // whose wrapper forces HTTP/1.1, as 8.12.3's does: the gzip half then stays
  // green), the slot itself: after the first guarded call it must not hold a
  // dispatcher of the npm package. `undici` is imported dynamically here and
  // only AFTER the guarded call: a static import in this file would write the
  // slot before the guard ever ran, and the test would measure its own import.
  it("after the first guarded call, the BUILT-IN fetch still decodes a gzip response from an HTTP/2 origin, and the slot is Node's", {
    timeout: 15_000,
  }, async () => {
    const echo = await startEchoServer();
    try {
      const res = await safeFetch(`http://127.0.0.1:${echo.port}/`, undefined, {
        resolver: resolvesTo("127.0.0.1"),
        allowPrivateHosts: true,
        timeoutMs: 3000,
      });
      expect(res.status).toBe(200);
    } finally {
      await echo.close();
    }
    const { Dispatcher } = await import("undici");
    const slot = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("undici.globalDispatcher.1")
    ];
    expect(slot instanceof Dispatcher).toBe(false);

    const { dir, key, cert } = selfSignedCert();
    const payload = JSON.stringify({ access_token: "gho_fixture" });
    const server = createSecureServer({ key, cert, allowHTTP1: true }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(payload));
    });
    server.on("session", (session) => session.on("error", () => undefined));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    // The certificate is self-signed for this one test; the built-in fetch reads
    // this switch at connect time, so it is scoped to the request and restored.
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      // Deliberately `globalThis.fetch`, never `safeFetch`: the subject is what
      // the rest of the process sees once the guard has been imported.
      // Bounded: with the broken wrapper the request may hang instead of
      // returning raw bytes — both are the same failure, and both must be named.
      const res = await globalThis.fetch(`https://127.0.0.1:${port}/login/oauth/access_token`, {
        signal: AbortSignal.timeout(4000),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ access_token: "gho_fixture" });
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
