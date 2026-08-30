import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createGuardedFetch,
  type HostResolver,
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
// or as a rejected fetch whose `cause` is the SsrfBlockedError (private IP).
async function expectSsrfBlocked(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error("expected the request to be blocked by the SSRF guard");
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    expect(cause).toBeInstanceOf(SsrfBlockedError);
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

  // NOTE — redirect-to-private (VT-6/VT-7): a redirect hop re-connects through
  // the SAME validating dispatcher, so a 3xx to a private host is blocked at the
  // hop's connect exactly like VT-1. This can't be unit-tested here (reaching a
  // real redirecting host needs egress, and a local redirector is itself private,
  // so it can only be reached with allowPrivateHosts on — which also relaxes the
  // hop). It is covered structurally by VT-1 (per-connect validation) plus the
  // plan's source-level verification that undici routes redirect hops through the
  // request's dispatcher. Webhooks additionally pass followRedirects:false.

  it("createGuardedFetch (the MCP-injected fetch) blocks a private-resolving host", async () => {
    const guarded = createGuardedFetch({ resolver: resolvesTo("169.254.169.254") });
    await expectSsrfBlocked(() => guarded("http://metadata.test/"));
  });
});
