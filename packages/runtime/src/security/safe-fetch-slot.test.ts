import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type HostResolver, safeFetch } from "./safe-fetch.js";

// Its own file on purpose: the guard loads `undici` ONCE per module instance and
// takes its snapshot of Node's dispatcher slot at that moment. Vitest isolates
// test files, so this is the one place where "what was in the slot before the
// first guarded call" can be arranged. No static `import "undici"` here either —
// it would write the slot before the guard runs (see safe-fetch.test.ts).

const LEGACY_SLOT = Symbol.for("undici.globalDispatcher.1");
const slots = globalThis as unknown as Record<symbol, unknown>;

const resolvesTo = (address: string): HostResolver => vi.fn(async () => [{ address, family: 4 }]);

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

describe("safeFetch — an operator's global dispatcher survives the guard (ADR-026)", () => {
  // What `NODE_USE_ENV_PROXY=1` does at startup: Node installs an
  // `EnvHttpProxyAgent` in the slot before any user code runs. Stand-in here: a
  // sentinel object with the one method undici checks for. It is never
  // dispatched to — the guard passes its own dispatcher — so it need not work.
  const operatorAgent = { dispatch: () => false, marker: "operator-proxy-agent" };
  const before = slots[LEGACY_SLOT];

  afterAll(() => {
    slots[LEGACY_SLOT] = before;
  });

  it("what was in the slot before the first guarded call is still there after it", async () => {
    slots[LEGACY_SLOT] = operatorAgent;
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
    expect(slots[LEGACY_SLOT]).toBe(operatorAgent);

    // A caller of the package's `undici.fetch` without an explicit dispatcher
    // still has one. WHOSE it is depends on Node and on load order, not on the
    // guard: the package installs its own agent only when the slot it reads is
    // empty at import (`lib/global.js`). Up to Node 24.12 that slot always was,
    // so the answer is the package's own `Agent`; from Node 24.20 (bundled
    // undici 7.29) Node fills that slot itself at its first fetch, and a package
    // loaded after that defers to Node's agent — a different class from a
    // different module instance (the orders measured are in `safe-fetch.ts`).
    // Measured on 22.23 / 24.12 / 24.20. So the assertion is "a working
    // dispatcher", not "an instance of the package's `Dispatcher`", which
    // depends on the Node version and the load order and would tie this test
    // to both.
    const { getGlobalDispatcher } = await import("undici");
    expect(typeof getGlobalDispatcher().dispatch).toBe("function");
  });
});
