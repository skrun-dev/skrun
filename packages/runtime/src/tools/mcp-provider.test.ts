import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectError } from "../errors.js";
import {
  describeBytes,
  TOOL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_TRUNCATION_MARKER,
  truncateToolResult,
} from "../files/output-rules.js";
import type { Logger } from "../logger.js";
import { classifyInitFailure, initStageOf, mcpFactsOf } from "../runner-contract.js";
import { createGuardedFetch, type HostResolver, SsrfBlockedError } from "../security/safe-fetch.js";
import { MCP_STDIO_MAX_MESSAGE_BYTES, McpToolProvider } from "./mcp-provider.js";
import type { ToolResult } from "./types.js";

// The real guard, spied on: one suite below reads what the provider hands it.
vi.mock("../security/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/safe-fetch.js")>();
  return { ...actual, createGuardedFetch: vi.fn(actual.createGuardedFetch) };
});

const MOCK_SERVER = resolve(import.meta.dirname, "../../tests/fixtures/mock-mcp-server.js");

describe("McpToolProvider — stdio transport", () => {
  it("should connect to a stdio MCP server and list tools", async () => {
    const provider = new McpToolProvider({
      name: "test-stdio",
      transport: "stdio",
      command: "node",
      args: [MOCK_SERVER],
      auth: "none",
    });

    const tools = await provider.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name === "echo")).toBe(true);

    await provider.disconnect();
  });

  it("should call a tool via stdio and get result", async () => {
    const provider = new McpToolProvider({
      name: "test-stdio",
      transport: "stdio",
      command: "node",
      args: [MOCK_SERVER],
      auth: "none",
    });

    await provider.listTools(); // triggers connect
    const result = await provider.callTool("echo", { text: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");

    await provider.disconnect();
  });

  it("throws McpConnectError when command is not found (no silent tools=[])", async () => {
    // Previously this swallowed the spawn error and returned tools=[].
    // The LLM then had no tools and could hallucinate plausible answers
    // that passed output-validation repair retry — silent garbage.
    // Now the failure surfaces as a typed error the route can convert to
    // 502 MCP_CONNECT_FAILED.
    const provider = new McpToolProvider({
      name: "test-missing",
      transport: "stdio",
      command: "nonexistent-command-xyz",
      args: [],
      auth: "none",
    });

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    await provider.disconnect();
  });

  it("should return transport mode correctly", async () => {
    const stdioProvider = new McpToolProvider({
      name: "t1",
      transport: "stdio",
      command: "node",
      auth: "none",
    });
    // Access private method via any for testing
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    expect((stdioProvider as any).getTransportMode()).toBe("stdio");

    const urlProvider = new McpToolProvider({
      name: "t2",
      url: "https://example.com/mcp",
      auth: "none",
    });
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    expect((urlProvider as any).getTransportMode()).toBe("streamable-http");

    const sseProvider = new McpToolProvider({
      name: "t3",
      url: "https://example.com/sse",
      transport: "sse",
      auth: "none",
    });
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    expect((sseProvider as any).getTransportMode()).toBe("sse");
  });

  it("getConfigKey returns stable key for same config (VT-8)", () => {
    const config = {
      name: "test",
      url: "https://example.com/mcp",
      transport: "streamable-http" as const,
      auth: "none" as const,
    };
    const p1 = new McpToolProvider(config);
    const p2 = new McpToolProvider(config);
    expect(p1.getConfigKey()).toBe(p2.getConfigKey());
    expect(p1.getConfigKey()).toContain("example.com");
  });

  it("reconnect-on-error retries after connection drop (VT-9)", async () => {
    const provider = new McpToolProvider({
      name: "test-stdio",
      transport: "stdio",
      command: "node",
      args: [MOCK_SERVER],
      auth: "none",
    });

    await provider.listTools(); // connect

    // Simulate connection drop by forcibly disconnecting the client
    // biome-ignore lint/suspicious/noExplicitAny: testing reconnect behavior
    const client = (provider as any).client;
    await client.close();

    // callTool should detect the connection error, reconnect, and succeed on retry
    const result = await provider.callTool("echo", { text: "after-reconnect" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("after-reconnect");

    await provider.disconnect();
  });

  it("throws McpConnectError when host not in allowedHosts (VT-11)", async () => {
    // allowed_hosts mismatch is a misconfiguration — fail the run loudly
    // rather than silently dropping tools (which led to hallucinated output
    // pre-fix, see post-#83 investigation).
    const provider = new McpToolProvider(
      {
        name: "blocked-remote",
        url: "https://mcp.blocked.com/sse",
        transport: "sse",
        auth: "none",
      },
      undefined,
      ["other.com"], // allowedHosts does NOT include mcp.blocked.com
    );

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    await provider.disconnect();
  });

  it("stdio transport is not affected by allowedHosts", async () => {
    // allowedHosts=[] (all blocked) should NOT block stdio (local process)
    const provider = new McpToolProvider(
      {
        name: "test-stdio-allowed",
        transport: "stdio",
        command: "node",
        args: [MOCK_SERVER],
        auth: "none",
      },
      undefined,
      [], // empty = all blocked, but stdio is local — should still work
    );

    const tools = await provider.listTools();
    expect(tools.length).toBeGreaterThan(0);

    await provider.disconnect();
  });
});

describe("McpToolProvider — a remote server's redirect is held to the agent's allowed_hosts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const quiet = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;

  it.each([
    "sse",
    "streamable-http",
  ] as const)("hands the guard the agent's allowed_hosts on the %s transport", async (transport) => {
    // Stopped at the handshake: what is read is the guard the transport got.
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error("stopped"));
    vi.mocked(createGuardedFetch).mockClear();
    const allowedHosts = ["mcp.example.test", "*.cdn.example.test"];
    const provider = new McpToolProvider(
      { name: "remote", url: "https://mcp.example.test/mcp", transport, auth: "none" },
      quiet,
      allowedHosts,
    );

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);
    expect(vi.mocked(createGuardedFetch)).toHaveBeenCalledWith({ allowedHosts });
  });

  // The SDK's Streamable HTTP client, on the guarded fetch, against two local
  // origins: the one the agent names redirects every request (307, so a POST
  // stays a POST) to the one that serves MCP. Names stand for the two hosts and
  // resolve to the loopback, which allowPrivateHosts lets through — it relaxes
  // the address checks, never the list.
  describe("through the SDK's Streamable HTTP transport, between two origins", () => {
    let front: Server;
    let backend: Server;
    let frontPort = 0;
    let backendPort = 0;
    let backendHits = 0;
    const anyNameToLoopback: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];

    const listen = async (server: Server): Promise<number> => {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    };

    beforeAll(async () => {
      // The SDK's server, stateless: one server and one transport per request.
      // Its web-standard transport, bridged here by hand: the Node one (through
      // @hono/node-server 1.19.17) answered `transfer-encoding: chunked` with an
      // unframed body on Node 24.12, which no client can parse.
      backend = createServer(async (req, res) => {
        backendHits += 1;
        const mcp = new McpServer({ name: "redirect-target", version: "1.0.0" });
        mcp.registerTool("ping", { description: "Answers pong" }, async () => ({
          content: [{ type: "text", text: "pong" }],
        }));
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcp.connect(transport);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const answer = await transport.handleRequest(
          new Request(`http://${req.headers.host}${req.url ?? "/"}`, {
            method: req.method,
            headers,
            ...(chunks.length > 0 && { body: Buffer.concat(chunks) }),
          }),
        );
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
        await transport.close();
        await mcp.close();
      });
      backendPort = await listen(backend);
      front = createServer((req, res) => {
        res.writeHead(307, { location: `http://mcp-backend.test:${backendPort}${req.url ?? "/"}` });
        res.end();
      });
      frontPort = await listen(front);
    });

    afterAll(async () => {
      for (const server of [front, backend]) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    });

    async function connectThrough(allowedHosts: string[]): Promise<Client> {
      const client = new Client({ name: "redirect-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://mcp-front.test:${frontPort}/mcp`),
        {
          fetch: createGuardedFetch({
            allowedHosts,
            allowPrivateHosts: true,
            resolver: anyNameToLoopback,
          }) as unknown as typeof fetch,
        },
      );
      await client.connect(transport, { timeout: 10_000 });
      return client;
    }

    it("follows the redirect when the server it leads to is in allowed_hosts", async () => {
      backendHits = 0;
      const client = await connectThrough(["mcp-front.test", "mcp-backend.test"]);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["ping"]);
        expect(backendHits).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    });

    it("refuses the redirect when the server it leads to is not, before reaching it", async () => {
      backendHits = 0;
      let failure: unknown;
      try {
        const client = await connectThrough(["mcp-front.test"]);
        await client.close();
      } catch (err) {
        failure = err;
      }
      // The SDK hands the fetch's error on; the guard's refusal is its cause.
      let cause = failure;
      while (cause instanceof Error && !(cause instanceof SsrfBlockedError)) cause = cause.cause;
      expect(cause).toBeInstanceOf(SsrfBlockedError);
      expect((cause as Error).message).toBe("Blocked 'mcp-backend.test': not in the allowed hosts");
      expect(backendHits).toBe(0);
    });
  });
});

describe("McpToolProvider — connect timeout", () => {
  const HANGING_SERVER = resolve(import.meta.dirname, "../../tests/fixtures/hanging-mcp-server.js");

  it("aborts connect with McpConnectError after the configured timeout when the MCP server never answers", async () => {
    // Subprocess spawns instantly but never speaks the MCP protocol — the
    // client.connect() handshake hangs forever waiting for `initialize`.
    // A small timeout (500ms) proves the bound fires; the throw is what
    // surfaces the failure to the route (502 MCP_CONNECT_FAILED).
    const provider = new McpToolProvider(
      {
        name: "test-hanging",
        transport: "stdio",
        command: "node",
        args: [HANGING_SERVER],
        auth: "none",
      },
      undefined,
      [],
      500, // connectTimeoutMs override
    );

    const t0 = Date.now();
    let caught: McpConnectError | null = null;
    try {
      await provider.listTools();
    } catch (err) {
      caught = err instanceof McpConnectError ? err : null;
    }
    const elapsed = Date.now() - t0;

    expect(caught).toBeInstanceOf(McpConnectError);
    expect(caught?.details.isTimeout).toBe(true);
    expect(caught?.details.timeoutMs).toBe(500);
    expect(caught?.details.server).toBe("test-hanging");
    // The bound should fire close to 500ms; allow generous slack for CI.
    expect(elapsed).toBeLessThan(5_000);

    await provider.disconnect();
  });
});

// A connection that fails keeps what its server answered — the status the
// server refused it with, or the code of the JSON-RPC error it sent — and never
// a code the SDK makes itself; the contract then judges whether the failure is
// the run's own. Every server is a real one: an HTTP server on the loopback, on
// a port the system picks, or a process started over stdio. The remote ones are
// named by a host that resolves to the loopback, which allowPrivateHosts lets
// through — it relaxes the address checks, never the list.
describe("McpToolProvider — a failed connection keeps what its server answered", () => {
  const quiet = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;
  const anyNameToLoopback: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];
  const HOST = "mcp-local.test";
  const HANGING_SERVER = resolve(import.meta.dirname, "../../tests/fixtures/hanging-mcp-server.js");
  type ServerConfig = ConstructorParameters<typeof McpToolProvider>[0];

  let realGuard: typeof createGuardedFetch;
  let dir: string;
  const servers: Server[] = [];

  beforeAll(async () => {
    realGuard = (
      await vi.importActual<typeof import("../security/safe-fetch.js")>("../security/safe-fetch.js")
    ).createGuardedFetch;
    dir = mkdtempSync(join(tmpdir(), "skrun-mcp-facts-"));
    // A local server that answers every request with a JSON-RPC error, and one
    // that exits as soon as it starts.
    writeFileSync(
      join(dir, "rpc-error.mjs"),
      [
        'process.stdin.setEncoding("utf8");',
        'let buffered = "";',
        'process.stdin.on("data", (chunk) => {',
        "  buffered += chunk;",
        "  for (let end = buffered.indexOf(String.fromCharCode(10)); end >= 0; end = buffered.indexOf(String.fromCharCode(10))) {",
        "    const line = buffered.slice(0, end);",
        "    buffered = buffered.slice(end + 1);",
        "    if (!line.trim()) continue;",
        "    const message = JSON.parse(line);",
        "    if (message.id === undefined) continue;",
        "    const error = { code: -32603, message: 'cannot start' };",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error }) + String.fromCharCode(10));",
        "  }",
        "});",
      ].join("\n"),
    );
    writeFileSync(join(dir, "exits.mjs"), "process.exit(3);\n");
  });

  beforeEach(() => {
    vi.mocked(createGuardedFetch).mockImplementation((options) =>
      realGuard({ ...options, allowPrivateHosts: true, resolver: anyNameToLoopback }),
    );
  });

  afterEach(async () => {
    vi.mocked(createGuardedFetch).mockImplementation(realGuard);
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An HTTP server on the loopback that answers with `handler`; its port. */
  async function answering(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): Promise<number> {
    const server = createServer((req, res) => void handler(req, res));
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  const remote = (port: number, transport: "streamable-http" | "sse"): ServerConfig => ({
    name: "remote",
    url: `http://${HOST}:${port}/${transport === "sse" ? "sse" : "mcp"}`,
    transport,
    auth: "none",
  });
  const local = (script: string): ServerConfig => ({
    name: "local",
    transport: "stdio",
    command: "node",
    args: [script],
    auth: "none",
  });

  /** The error a connection to `config` fails with. */
  async function failureOf(config: ServerConfig, timeoutMs = 10_000): Promise<McpConnectError> {
    const provider = new McpToolProvider(config, quiet, [HOST], timeoutMs);
    try {
      await provider.listTools();
    } catch (err) {
      if (err instanceof McpConnectError) return err;
      throw err;
    } finally {
      await provider.disconnect();
    }
    throw new Error("the connection succeeded");
  }

  /** How the contract judges the failure, as the body of a failed /init would carry it. */
  const judged = (err: McpConnectError) =>
    classifyInitFailure({ stage: initStageOf(err), mcp: mcpFactsOf(err) });

  it.each([
    401, 404, 405,
  ])("a Streamable HTTP server that refuses it with %i keeps that status, and the failure is the run's", async (status) => {
    const port = await answering((_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("refused");
    });

    const err = await failureOf(remote(port, "streamable-http"));

    expect(err.cause).toBeInstanceOf(StreamableHTTPError);
    expect(err.details.httpStatus).toBe(status);
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("deterministic");
  });

  it.each([
    403, 503,
  ])("a Streamable HTTP server that refuses it with %i keeps that status, and the failure may not be the run's", async (status) => {
    const port = await answering((_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("refused");
    });

    const err = await failureOf(remote(port, "streamable-http"));

    expect(err.details.httpStatus).toBe(status);
    expect(judged(err)).toBe("indeterminate");
  });

  it("a server that answers its handshake with a JSON-RPC error keeps that error's code, and the failure is the run's", async () => {
    const port = await answering(async (req, res) => {
      const message = await bodyOf(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "unsupported" },
        }),
      );
    });

    const err = await failureOf(remote(port, "streamable-http"));

    expect(err.cause).toBeInstanceOf(McpError);
    expect(err.details.rpcCode).toBe(-32602);
    expect(err.details.httpStatus).toBeUndefined();
    expect(judged(err)).toBe("deterministic");
  });

  it("a server that answers the code the SDK gives a closed connection keeps none: the two cannot be told apart", async () => {
    const port = await answering(async (req, res) => {
      const message = await bodyOf(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "x" } }),
      );
    });

    const err = await failureOf(remote(port, "streamable-http"));

    expect((err.cause as McpError).code).toBe(-32000);
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("indeterminate");
  });

  it.each([
    401, 404, 405,
  ])("an SSE server that refuses its event stream with %i keeps that status, and the failure is the run's", async (status) => {
    const port = await answering((_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("refused");
    });

    const err = await failureOf(remote(port, "sse"));

    expect(err.cause).toBeInstanceOf(SseError);
    expect((err.cause as SseError).code).toBe(status);
    expect(err.details.httpStatus).toBe(status);
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("deterministic");
  });

  it.each([
    403, 503,
  ])("an SSE server that refuses its event stream with %i keeps that status, and the failure may not be the run's", async (status) => {
    const port = await answering((_req, res) => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("refused");
    });

    const err = await failureOf(remote(port, "sse"));

    expect(err.cause).toBeInstanceOf(SseError);
    expect(err.details.httpStatus).toBe(status);
    expect(judged(err)).toBe("indeterminate");
  });

  it("an SSE server nothing listens for keeps no status: the SDK's error carries none, and the failure may not be the run's", async () => {
    // A port the system gave, then closed.
    const port = await answering(() => {});
    const closing = servers.pop();
    await new Promise<void>((done) => closing?.close(() => done()));

    const err = await failureOf(remote(port, "sse"));

    expect(err.cause).toBeInstanceOf(SseError);
    expect((err.cause as SseError).code).toBeUndefined();
    expect(err.details.httpStatus).toBeUndefined();
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("indeterminate");
  });

  it("an SSE server that refuses the handshake's request with 401 keeps no status: the SDK says it only in its text", async () => {
    const port = await answering(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      await bodyOf(req);
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("refused");
    });

    const err = await failureOf(remote(port, "sse"));

    expect(err.cause).not.toHaveProperty("code");
    expect((err.cause as Error).message).toContain("HTTP 401");
    expect(err.details.httpStatus).toBeUndefined();
    expect(judged(err)).toBe("indeterminate");
  });

  it("a local server that answers its handshake with a JSON-RPC error keeps that error's code, and the failure is the run's", async () => {
    const err = await failureOf(local(join(dir, "rpc-error.mjs")));

    expect(err.details.rpcCode).toBe(-32603);
    expect(judged(err)).toBe("deterministic");
  });

  it("a local server that exits keeps no code: the closed connection is the SDK's", async () => {
    const err = await failureOf(local(join(dir, "exits.mjs")));

    expect((err.cause as McpError).code).toBe(-32000);
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("indeterminate");
  });

  it("a server that never answers keeps no code: the timeout is the SDK's", async () => {
    const err = await failureOf(local(HANGING_SERVER), 300);

    expect(err.details.isTimeout).toBe(true);
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("indeterminate");
  });

  it("a server nothing listens for keeps nothing, and the failure may not be the run's", async () => {
    // A port the system gave, then closed.
    const port = await answering(() => {});
    const closing = servers.pop();
    await new Promise<void>((done) => closing?.close(() => done()));

    const err = await failureOf(remote(port, "streamable-http"));

    expect(err.details.httpStatus).toBeUndefined();
    expect(err.details.rpcCode).toBeUndefined();
    expect(judged(err)).toBe("indeterminate");
  });
});

// A remote server's URL can carry a credential in its path or query, and an
// error's message can quote it: the log lines name a remote server by its origin
// and an error by its class. The client's methods are stubbed, so no process is
// started and nothing goes over the network.
describe("McpToolProvider — its log lines name a server by its origin and an error by its class", () => {
  const WITNESS = "witness-2b9f";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function recording() {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, line: (event: string) => lines.find((fields) => fields.event === event) };
  }

  it("names a remote server by its origin, and a failed connection by the error's class", async () => {
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(
      new Error(`handshake refused: ${WITNESS}`),
    );
    const log = recording();
    const provider = new McpToolProvider(
      {
        name: "remote",
        url: "https://mcp.example.test/sse?key=SECRET",
        transport: "sse",
        auth: "none",
      },
      log.logger,
      ["mcp.example.test"],
    );

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    const line = log.line("mcp_connect_failed");
    expect(JSON.stringify(line)).not.toContain("SECRET");
    expect(JSON.stringify(line)).not.toContain("key=");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).not.toHaveProperty("error");
    expect(line).toMatchObject({
      server: "remote",
      transport: "sse",
      location: "https://mcp.example.test",
      error_name: "Error",
    });
  });

  it("never writes a remote server's URL that does not parse", async () => {
    const log = recording();
    const provider = new McpToolProvider(
      { name: "remote", url: `not a url ${WITNESS}`, transport: "sse", auth: "none" },
      log.logger,
    );

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    const line = log.line("mcp_connect_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ location: "(unparseable server URL, not logged)" });
  });

  it("names a local server by its command, as it is", async () => {
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error(`spawn refused: ${WITNESS}`));
    const log = recording();
    const provider = new McpToolProvider(
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], auth: "none" },
      log.logger,
    );

    await expect(provider.listTools()).rejects.toThrow(McpConnectError);

    const line = log.line("mcp_connect_failed");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).toMatchObject({ location: 'command "node"', error_name: "Error" });
  });

  it("logs a lost connection by the error's class, and the call still succeeds once reconnected", async () => {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [] });
    vi.spyOn(Client.prototype, "callTool")
      .mockRejectedValueOnce(new Error(`connection closed: ${WITNESS}`))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "answered" }] });
    const log = recording();
    const provider = new McpToolProvider(
      { name: "local", transport: "stdio", command: "node", auth: "none" },
      log.logger,
    );
    await provider.listTools();

    const result = await provider.callTool("echo", {});

    const line = log.line("mcp_reconnect");
    expect(JSON.stringify(line)).not.toContain(WITNESS);
    expect(line).not.toHaveProperty("error");
    expect(line).toMatchObject({ server: "local", error_name: "Error" });
    expect(result).toEqual({ content: "answered", isError: false });
  });

  it("still hands the model a failed tool's message", async () => {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [] });
    vi.spyOn(Client.prototype, "callTool").mockRejectedValue(
      new Error(`tool exploded: ${WITNESS}`),
    );
    const provider = new McpToolProvider(
      { name: "local", transport: "stdio", command: "node", auth: "none" },
      recording().logger,
    );
    await provider.listTools();

    expect(await provider.callTool("echo", {})).toEqual({
      content: `tool exploded: ${WITNESS}`,
      isError: true,
    });
  });
});

// A failed connection's error reaches whoever called the run: the local route
// answers with its message and its details. A remote server's URL can carry a
// credential in its user-info, its path or its query, so the error names the
// server by its origin, as the log lines do. A URL with no origin gets words of
// the error's own — the log lines' say what a line does not write. A local
// server keeps its command, without its arguments.
describe("McpToolProvider — a failed connection's error names a remote server by its origin only", () => {
  type ServerConfig = ConstructorParameters<typeof McpToolProvider>[0];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function recording() {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    return { logger, line: (event: string) => lines.find((fields) => fields.event === event) };
  }

  /** The error a connection to `config` fails with, its timeout 500 ms. */
  async function failureOf(
    config: ServerConfig,
    allowedHosts: string[] = [],
    logger: Logger = recording().logger,
  ): Promise<McpConnectError> {
    const provider = new McpToolProvider(config, logger, allowedHosts, 500);
    try {
      await provider.listTools();
    } catch (err) {
      if (err instanceof McpConnectError) return err;
      throw err;
    } finally {
      await provider.disconnect();
    }
    throw new Error("the connection succeeded");
  }

  it.each([
    ["sse", "https://u:p@remote.example.test/sse?key=abc", "https://remote.example.test", "/sse"],
    [
      "streamable-http",
      "https://u:p@remote.example.test:8443/mcp?key=abc",
      "https://remote.example.test:8443",
      "/mcp",
    ],
  ] as const)("on the %s transport, its message and its details carry the server's origin: no credentials, no path, no query", async (transport, url, origin, path) => {
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error("handshake refused"));

    const err = await failureOf({ name: "remote", url, transport, auth: "none" }, [
      "remote.example.test",
    ]);

    expect(err.details).toEqual({
      server: "remote",
      transport,
      location: origin,
      isTimeout: false,
    });
    expect(err.message).toBe(`MCP server "remote" (${transport}) failed to connect: ${origin}`);
    const said = JSON.stringify({ message: err.message, details: err.details });
    for (const part of ["u:p", path, "key=abc"]) expect(said).not.toContain(part);
  });

  it("a connection that timed out names the server's origin too", async () => {
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(
      new McpError(-32001, "Request timed out"),
    );

    const err = await failureOf(
      {
        name: "remote",
        url: "https://u:p@remote.example.test/sse?key=abc",
        transport: "sse",
        auth: "none",
      },
      ["remote.example.test"],
    );

    expect(err.details).toMatchObject({
      location: "https://remote.example.test",
      isTimeout: true,
      timeoutMs: 500,
    });
    expect(err.message).toBe(
      'MCP server "remote" (sse) failed to connect after 500ms timeout: https://remote.example.test',
    );
  });

  it.each([
    ["has no origin", "foo:bar"],
    ["does not parse", "not a url"],
  ])("a URL that %s is named by words of the error's own, never by the log line's", async (_label, url) => {
    const log = recording();

    const err = await failureOf(
      { name: "remote", url, transport: "sse", auth: "none" },
      [],
      log.logger,
    );

    expect(err.details.location).toBe("a URL with no origin");
    expect(err.message).toBe('MCP server "remote" (sse) failed to connect: a URL with no origin');
    expect(log.line("mcp_connect_failed")).toMatchObject({
      location: "(unparseable server URL, not logged)",
    });
  });

  it("names a local server by its command, without its arguments, as before", async () => {
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(new Error("spawn refused"));

    const err = await failureOf({
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js", "--key=abc"],
      auth: "none",
    });

    expect(err.details.location).toBe('command "node"');
    expect(err.message).toBe('MCP server "local" (stdio) failed to connect: command "node"');
  });
});

// A local server is read through the SDK's stdio transport, which closes the
// connection on a message past the bound. The server here is written by hand,
// so nothing on its side bounds what it sends, and it counts every execution of
// a tool, with the process that ran it.
describe("McpToolProvider — a local server's message past the bound", () => {
  const SERVER = resolve(import.meta.dirname, "../../tests/fixtures/big-answer-mcp-server.js");
  const MIB = 1024 * 1024;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-mcp-bound-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Starts a provider on the server. `maxStarts`: the server refuses to start
   * once it has started that many times — a replacement that fails.
   */
  function start(counterName: string, options: { maxStarts?: number } = {}) {
    const counter = join(dir, counterName);
    const startsFile = join(dir, `starts-${counterName}`);
    writeFileSync(counter, "");
    writeFileSync(startsFile, "");
    const lines: Array<Record<string, unknown>> = [];
    const keep = (fields: Record<string, unknown>) => {
      lines.push(fields);
    };
    const logger = { warn: keep, info: keep, error: keep, debug: keep } as unknown as Logger;
    const limit = options.maxStarts === undefined ? [] : [String(options.maxStarts)];
    const provider = new McpToolProvider(
      {
        name: "big-answer",
        transport: "stdio",
        command: process.execPath,
        args: [SERVER, counter, startsFile, ...limit],
        auth: "none",
      },
      logger,
    );
    const pids = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
    return {
      provider,
      /** The pid of the server process of each execution, in order. */
      executions: () => pids(counter),
      /** The pid of each server process started, refused ones included, in order. */
      starts: () => pids(startsFile),
      events: (event: string) => lines.filter((fields) => fields.event === event),
    };
  }

  /** What every call waiting on a connection closed past the bound reads. */
  const PAST_THE_BOUND = `The connection to MCP server "big-answer" was closed because the server sent a message larger than ${describeBytes(MCP_STDIO_MAX_MESSAGE_BYTES)}`;
  const NOT_RETRIED = "The tool may have run; the call was not retried.";

  it("runs the tool once, fails the call naming the bound, and the next call is answered", async () => {
    const { provider, executions, events } = start("past-the-bound.txt");
    try {
      await provider.listTools();

      const result = await provider.callTool("big", { mib: 11 });

      expect(executions()).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content).toContain(PAST_THE_BOUND);
      expect(result.content).toContain(NOT_RETRIED);
      expect(events("mcp_message_too_large")).toHaveLength(1);
      expect(events("mcp_message_too_large")[0]).toMatchObject({
        server: "big-answer",
        transport: "stdio",
        max_bytes: MCP_STDIO_MAX_MESSAGE_BYTES,
        error_name: "Error",
      });
      expect(events("mcp_reconnect")).toHaveLength(0);
      // The provider is left on a live connection, never on the closed one.
      // biome-ignore lint/suspicious/noExplicitAny: reading the provider's connection
      const live = provider as any;
      expect(live.connected).toBe(true);
      expect(live.client?.transport).toBeDefined();

      const next = await provider.callTool("big", { mib: 1 / 1024 });

      expect(next).toEqual({ content: "x".repeat(1024), isError: false });
      const pids = executions();
      expect(pids).toHaveLength(2);
      expect(pids[1]).not.toBe(pids[0]);
      expect(events("mcp_reconnect")).toHaveLength(0);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  it("logs one line for a connection, however far past the bound its message goes", async () => {
    const { provider, executions, events } = start("far-past-the-bound.txt");
    try {
      await provider.listTools();

      // The transport empties its buffer at the bound and reads on: the rest of
      // a 25 MiB message passes the bound again before the connection closes.
      const result = await provider.callTool("big", { mib: 25 });

      expect(result.isError).toBe(true);
      expect(executions()).toHaveLength(1);
      expect(events("mcp_message_too_large")).toHaveLength(1);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  it("keeps a connection whose transport reports another error", async () => {
    const { provider, executions, events } = start("other-error.txt");
    try {
      await provider.listTools();

      expect(await provider.callTool("noisy", {})).toEqual({ content: "ok", isError: false });
      expect(await provider.callTool("big", { mib: 1 / 1024 })).toEqual({
        content: "x".repeat(1024),
        isError: false,
      });

      const pids = executions();
      expect(pids).toHaveLength(2);
      expect(pids[1]).toBe(pids[0]);
      expect(events("mcp_message_too_large")).toHaveLength(0);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  it("returns a result under the bound whole, which the runner's cut then bounds", async () => {
    const { provider, executions, events } = start("under-the-bound.txt");
    try {
      await provider.listTools();

      const result = await provider.callTool("big", { mib: 9 });

      expect(result.isError).toBe(false);
      expect(Buffer.byteLength(result.content)).toBe(9 * MIB);
      expect(executions()).toHaveLength(1);
      expect(events("mcp_message_too_large")).toHaveLength(0);
      const cut = truncateToolResult(result);
      expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(TOOL_RESPONSE_MAX_BYTES);
      expect(cut.content.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  it("replaces a connection closed between two calls before the next one goes out", async () => {
    const { provider, executions, events } = start("between-calls.txt");
    try {
      await provider.listTools();

      expect(await provider.callTool("unasked", { mib: 11 })).toEqual({
        content: "ok",
        isError: false,
      });
      await vi.waitFor(() => expect(events("mcp_message_too_large")).toHaveLength(1), {
        timeout: 10_000,
      });

      const next = await provider.callTool("big", { mib: 1 / 1024 });

      expect(next).toEqual({ content: "x".repeat(1024), isError: false });
      const pids = executions();
      expect(pids).toHaveLength(2);
      expect(pids[1]).not.toBe(pids[0]);
      expect(events("mcp_reconnect")).toHaveLength(0);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  // A replacement that fails must still end the call with a result: an error
  // thrown from a tool call reaches the model router as a failure of the model.
  it("fails the call naming the bound, and never throws, when the server does not start again", async () => {
    const { provider, executions, starts, events } = start("restart-refused.txt", {
      maxStarts: 1,
    });
    try {
      await provider.listTools();

      const call = provider.callTool("big", { mib: 11 });

      await expect(call).resolves.toMatchObject({ isError: true });
      const result = await call;
      expect(result.content).toContain(PAST_THE_BOUND);
      expect(result.content).toContain(NOT_RETRIED);
      expect(executions()).toHaveLength(1);
      expect(starts()).toHaveLength(2);
      expect(events("mcp_message_too_large")).toHaveLength(1);
      expect(events("mcp_connect_failed")).toHaveLength(1);
      expect(events("mcp_reconnect")).toHaveLength(0);

      // The provider is left disconnected: the next call reaches no server.
      expect(await provider.callTool("big", { mib: 1 / 1024 })).toEqual({
        content: "MCP server not connected",
        isError: true,
      });
      expect(executions()).toHaveLength(1);
      expect(starts()).toHaveLength(2);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  it("answers the next call, and never throws, when a connection closed between two calls cannot be replaced", async () => {
    const { provider, executions, starts, events } = start("between-calls-refused.txt", {
      maxStarts: 1,
    });
    try {
      await provider.listTools();
      expect(await provider.callTool("unasked", { mib: 11 })).toEqual({
        content: "ok",
        isError: false,
      });
      await vi.waitFor(() => expect(events("mcp_message_too_large")).toHaveLength(1), {
        timeout: 10_000,
      });

      const next = provider.callTool("big", { mib: 1 / 1024 });

      await expect(next).resolves.toEqual({ content: "MCP server not connected", isError: true });
      expect(executions()).toHaveLength(1);
      expect(starts()).toHaveLength(2);
      expect(events("mcp_connect_failed")).toHaveLength(1);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  it("starts one server, not two, when two calls on a connection are failed by the same message", async () => {
    const { provider, executions, starts, events } = start("two-calls.txt");
    try {
      await provider.listTools();

      const results = await Promise.all([
        provider.callTool("big", { mib: 11 }),
        provider.callTool("big", { mib: 11 }),
      ]);

      for (const result of results) {
        expect(result.isError).toBe(true);
        expect(result.content).toContain(PAST_THE_BOUND);
      }
      expect(starts()).toHaveLength(2);
      expect(events("mcp_connect_failed")).toHaveLength(0);
      expect(events("mcp_reconnect")).toHaveLength(0);
      // biome-ignore lint/suspicious/noExplicitAny: reading the provider's connection
      expect((provider as any).connected).toBe(true);

      const next = await provider.callTool("big", { mib: 1 / 1024 });

      expect(next).toEqual({ content: "x".repeat(1024), isError: false });
      // Only the next call ran on the new server: neither failed call was replayed.
      const [first, second] = starts();
      expect(executions().filter((pid) => pid === second)).toHaveLength(1);
      expect(executions().filter((pid) => pid !== first && pid !== second)).toHaveLength(0);
    } finally {
      await provider.disconnect();
    }
  }, 30_000);

  // The close of the replaced connection is held until the test releases it,
  // so a call made meanwhile is made at a known point, with no delay.
  it("answers a call made while the replaced connection closes, without touching that connection", async () => {
    const { provider, events } = start("during-the-close.txt");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const close = Client.prototype.close;
    const closing = vi.spyOn(Client.prototype, "close").mockImplementation(async function (
      this: Client,
    ) {
      await held;
      return close.call(this);
    });
    try {
      await provider.listTools();
      const failing = provider.callTool("big", { mib: 11 });
      await vi.waitFor(() => expect(closing).toHaveBeenCalledTimes(1), { timeout: 10_000 });

      let during: ToolResult | undefined;
      const call = provider.callTool("big", { mib: 1 / 1024 }).then((result) => {
        during = result;
      });
      // Past the microtasks: a call that waited on the held close is still pending.
      await new Promise((resolve) => setImmediate(resolve));

      expect(during).toEqual({ content: "MCP server not connected", isError: true });
      expect(closing).toHaveBeenCalledTimes(1);

      release();
      await call;
      expect((await failing).content).toContain(PAST_THE_BOUND);
      expect(await provider.callTool("big", { mib: 1 / 1024 })).toEqual({
        content: "x".repeat(1024),
        isError: false,
      });
      expect(events("mcp_connect_failed")).toHaveLength(0);
    } finally {
      release();
      closing.mockRestore();
      await provider.disconnect();
    }
  }, 30_000);
});
