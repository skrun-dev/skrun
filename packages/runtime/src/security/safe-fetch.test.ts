import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createSecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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

describe("safeFetch — loading the module must not degrade the process's built-in fetch", () => {
  // The guard imports the npm `undici` for its own fetch + dispatcher. Node's
  // built-in fetch bundles ANOTHER undici, and the two share one global
  // dispatcher slot (`Symbol.for("undici.globalDispatcher.1")`): loading the
  // npm package installs a wrapper there. With undici 8.11.0 that wrapper
  // negotiated HTTP/2 for the built-in fetch's own connections, and the built-in
  // fetch then received gzip bodies raw, with no `content-encoding` header to
  // tell it so — every plain `fetch()` in the api process against an h2 origin
  // (GitHub's OAuth token endpoint first) got bytes `json()` could not parse.
  // Seen on 2026-09-22, the day 8.11.0 shipped, on an image built two hours
  // later. This pins the PROPERTY, on the shape that exposed it: TLS + ALPN h2,
  // gzip body. A plain-HTTP or HTTP/1.1 server does not reproduce it.
  it("after import, the BUILT-IN fetch still decodes a gzip response from an HTTP/2 origin", {
    timeout: 15_000,
  }, async () => {
    // A throwaway self-signed certificate from the openssl CLI (present on the CI
    // runners and on developer machines; a pure-JS generator was tried first and
    // produced a certificate Node's TLS client hangs on). Missing openssl is a
    // failure here, never a skip: a control that cannot run has not run.
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
    const pems = { private: readFileSync(keyPath), cert: readFileSync(certPath) };
    const payload = JSON.stringify({ access_token: "gho_fixture" });
    const server = createSecureServer(
      { key: pems.private, cert: pems.cert, allowHTTP1: true },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(payload));
      },
    );
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
