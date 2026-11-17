/**
 * Test-support module, not a test file: two local HTTP servers a run reaches
 * the way it reaches the real ones, each on the loopback address and an
 * ephemeral port, closed by the test that started it.
 *
 * - A fake model endpoint compatible with OpenAI's chat completions, for an
 *   agent that declares it in `model.base_url`. Each request gets the next of
 *   the replies a test scripted, in order — an answer of a given text, an answer
 *   that asks for a number of tool calls, a body of a given size, or a body sent
 *   one space at a time until the connection closes; once they are spent, every
 *   request gets `DEFAULT_ANSWER`. It notes each request, and the instant each
 *   connection it served closed.
 * - A fake runner for the `flyio` runtime: `POST /outputs/collect` answers
 *   `200 {"files":[]}` — a run that leaves no output file —, anything else 404.
 *   It notes each request.
 *
 * It imports no test framework: the Level-2 suite and the live suite both
 * start it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the fake endpoint answers to one request. */
export type ModelReply =
  /** A chat completion whose message carries this text. */
  | { kind: "answer"; content: string }
  /** A chat completion that asks for `count` tool calls, and no text. */
  | { kind: "toolCalls"; count: number }
  /**
   * A chat completion whose message carries `contentBytes` bytes of text: its
   * body weighs that plus its envelope, and says so in its `Content-Length`.
   */
  | { kind: "oversized"; contentBytes: number }
  /**
   * `200` and its headers at once, then one space every `everyMs` (50 by
   * default), until the connection closes: a body that never ends.
   */
  | { kind: "drip"; everyMs?: number };

/** What the endpoint answers once the scripted replies are spent: an output `{ "result": 1 }`. */
export const DEFAULT_ANSWER: ModelReply = { kind: "answer", content: '{"result":1}' };

/** One request the fake endpoint received. */
export interface ModelRequest {
  method: string;
  path: string;
  /** The bytes of its body. */
  bytes: number;
}

export interface FakeModelEndpoint {
  /** What an agent declares in `model.base_url`: `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  /** Each request, in the order it arrived. */
  requests: ModelRequest[];
  /** The instant (`Date.now()`) each served connection closed, in order. */
  closedAt: number[];
  /** The replies of the next requests, in order: replaces what was left of the previous script. */
  script(replies: ModelReply[]): void;
  /**
   * The instant a served connection closed — the first one at or after `since`,
   * waited for until `until` (`Date.now()`'s clock) at the latest; `undefined`
   * if none closed by then.
   */
  closedBetween(since: number, until: number): Promise<number | undefined>;
  /** Closes the server and every connection still open. */
  close(): Promise<void>;
}

export interface FakeRunner {
  /** A runner's base URL, as an acquired machine hands it to the run. */
  baseUrl: string;
  /** Each request, as `"<METHOD> <path>"`, in the order it arrived. */
  requests: string[];
  close(): Promise<void>;
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function originOf(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A chat completion, as the endpoint's body. */
function completion(
  message: { content: string | null; tool_calls?: unknown[] },
  finish: "stop" | "tool_calls",
): string {
  return JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function toolCalls(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `call-${i}`,
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  }));
}

function sendJson(res: ServerResponse, body: string): void {
  const bytes = Buffer.from(body);
  res.writeHead(200, { "content-type": "application/json", "content-length": bytes.length });
  res.end(bytes);
}

export async function startFakeModelEndpoint(): Promise<FakeModelEndpoint> {
  const requests: ModelRequest[] = [];
  const closedAt: number[] = [];
  const waiters = new Set<() => void>();
  let replies: ModelReply[] = [];

  const serve = (req: IncomingMessage, res: ServerResponse, bytes: number) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", bytes });
    const reply = replies.shift() ?? DEFAULT_ANSWER;
    if (reply.kind === "answer") {
      sendJson(res, completion({ content: reply.content }, "stop"));
    } else if (reply.kind === "toolCalls") {
      sendJson(
        res,
        completion({ content: null, tool_calls: toolCalls(reply.count) }, "tool_calls"),
      );
    } else if (reply.kind === "oversized") {
      sendJson(res, completion({ content: "a".repeat(reply.contentBytes) }, "stop"));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const timer = setInterval(() => res.write(" "), reply.everyMs ?? 50);
      res.once("close", () => clearInterval(timer));
    }
  };

  const server = await listen((req, res) => {
    // A client that hangs up mid-answer is what some replies are for.
    res.on("error", () => {});
    res.once("close", () => {
      closedAt.push(Date.now());
      for (const wake of waiters) wake();
    });
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on("end", () => serve(req, res, bytes));
  });

  return {
    baseUrl: `${originOf(server)}/v1`,
    requests,
    closedAt,
    script(next) {
      replies = [...next];
    },
    closedBetween(since, until) {
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = () => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(closedAt.find((at) => at >= since));
        };
        const check = () => {
          if (closedAt.some((at) => at >= since)) settle();
        };
        waiters.add(check);
        timer = setTimeout(settle, Math.max(0, until - Date.now()));
        check();
      });
    },
    close: () => closeServer(server),
  };
}

export async function startFakeRunner(): Promise<FakeRunner> {
  const requests: string[] = [];
  const server = await listen((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/outputs/collect")) {
        sendJson(res, JSON.stringify({ files: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { baseUrl: originOf(server), requests, close: () => closeServer(server) };
}
