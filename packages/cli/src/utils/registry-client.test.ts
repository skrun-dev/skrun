import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ThrowawayProfile,
  useThrowawayProfile,
  writeSession,
  writeSignInFile,
} from "../test-profile.shared.js";
import { parseSessionFile, Unreachable } from "./auth.js";
import { CliExit } from "./exit.js";
import { collectRunStream, connect, RegistryClient } from "./registry-client.js";

const BASE = "http://registry.test";

/** An event stream body, one `event:`/`data:` block per event. */
function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A body that arrives in the given chunks, as a network read would split it. */
function chunked(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * A body that sends `text`, then stays open — as a server does until it
 * closes the connection. Records whether its reader cancelled it.
 */
function openAfter(text: string): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

const START = {
  type: "run_start",
  run_id: "r1",
  timestamp: "t",
  agent: "dev/agent",
  agent_version: "1.4.0",
};
const COMPLETE = {
  type: "run_complete",
  run_id: "r1",
  timestamp: "t",
  output: { answer: "ok" },
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  cost: { estimated: 0.01, saved: 0.002 },
  duration_ms: 42,
  files: [{ name: "report.txt", size: 5, url: "/api/runs/r1/files/report.txt" }],
  files_excluded: { too_large: 1, upload_budget: 2 },
};

describe("collectRunStream — the run's result, collected from its event stream", () => {
  it("returns the completed result in the shape of the synchronous call", async () => {
    const result = await collectRunStream(
      chunked([
        sse([
          START,
          { type: "run_heartbeat", run_id: "r1", timestamp: "t", stage: "acquiring_runner" },
          { type: "runner_spawned", run_id: "r1", timestamp: "t", phases: { create_api_ms: 1 } },
          { type: "an_event_not_known_yet", run_id: "r1", timestamp: "t" },
          COMPLETE,
        ]),
      ]),
    );
    expect(result).toStrictEqual({
      run_id: "r1",
      status: "completed",
      agent_version: "1.4.0",
      output: { answer: "ok" },
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      cost: { estimated: 0.01, saved: 0.002 },
      duration_ms: 42,
      files: [{ name: "report.txt", size: 5, url: "/api/runs/r1/files/report.txt" }],
      files_excluded: { too_large: 1, upload_budget: 2 },
    });
  });

  it("reports no file left out from a server that does not count them", async () => {
    const { files_excluded: _counts, ...fromAnEarlierServer } = COMPLETE;

    const result = await collectRunStream(chunked([sse([START, fromAnEarlierServer])]));

    expect(result.files_excluded).toEqual({});
  });

  it("reads events split across chunks, and CRLF line ends", async () => {
    const text = sse([START, COMPLETE]).replace(/\n/g, "\r\n");
    const cut = text.length / 3;
    const result = await collectRunStream(
      chunked([text.slice(0, cut), text.slice(cut, 2 * cut), text.slice(2 * cut)]),
    );
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ answer: "ok" });
  });

  it("returns the failed result of the synchronous call on run_error", async () => {
    const result = await collectRunStream(
      chunked([
        sse([
          START,
          {
            type: "run_error",
            run_id: "r1",
            timestamp: "t",
            error: { code: "TIMEOUT", message: "Agent execution timed out" },
          },
        ]),
      ]),
    );
    expect(result).toStrictEqual({
      run_id: "r1",
      status: "failed",
      agent_version: "1.4.0",
      output: {},
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { estimated: 0 },
      duration_ms: 0,
      files: [],
      files_excluded: {},
      error: "Agent execution timed out",
    });
  });

  it.each([
    ["run_complete", COMPLETE],
    [
      "run_error",
      { type: "run_error", run_id: "r1", timestamp: "t", error: { code: "X", message: "failed" } },
    ],
  ])("cancels the response at %s, instead of waiting for the server to close it", async (_type, terminal) => {
    const open = openAfter(sse([START, terminal]));

    const result = await collectRunStream(open.body);

    expect(result.run_id).toBe("r1");
    expect(open.cancelled()).toBe(true);
  });

  it("throws STREAM_INTERRUPTED when the stream ends before the run does", async () => {
    const err = await collectRunStream(chunked([sse([START])])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code: string }).code).toBe("STREAM_INTERRUPTED");
    expect((err as Error & { status: number }).status).toBe(0);
  });
});

describe("RegistryClient.run — POST /run, read as a stream", () => {
  // The client holds no token: it sends the one saved for its server, in a throwaway profile.
  beforeEach(() => {
    writeSession(useThrowawayProfile(), { address: BASE, token: "tok" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return response();
      }),
    );
    return calls;
  }

  it("asks for the event stream, sends the caller keys, and returns the collected result", async () => {
    const calls = stubFetch(
      () =>
        new Response(sse([START, COMPLETE]), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const client = new RegistryClient(BASE);

    const result = await client.run(
      "dev",
      "agent",
      { q: "hi" },
      {
        version: "1.4.0",
        llmKeys: { google: "key-value-for-the-test" },
      },
    );

    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/api/agents/dev/agent/run`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-LLM-API-Key"]).toBe(JSON.stringify({ google: "key-value-for-the-test" }));
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      input: { q: "hi" },
      version: "1.4.0",
    });
  });

  it("returns once the run ends, and cancels the response the server keeps open", async () => {
    const open = openAfter(sse([START, COMPLETE]));
    stubFetch(() => new Response(open.body, { headers: { "Content-Type": "text/event-stream" } }));

    const result = await new RegistryClient(BASE).run("dev", "agent", {});

    expect(result.status).toBe("completed");
    expect(open.cancelled()).toBe(true);
  });

  it("sends no key header without caller keys", async () => {
    const calls = stubFetch(
      () =>
        new Response(sse([START, COMPLETE]), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    await new RegistryClient(BASE).run("dev", "agent", {});
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("X-LLM-API-Key");
  });

  it("sends the endpoints the caller's model keys belong to in X-LLM-Base-URL, a JSON object of provider to address, and no endpoint header without them", async () => {
    const calls = stubFetch(
      () =>
        new Response(sse([START, COMPLETE]), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );

    await new RegistryClient(BASE).run(
      "dev",
      "agent",
      {},
      { llmBaseUrls: { anthropic: "https://x.example/v1" } },
    );
    await new RegistryClient(BASE).run("dev", "agent", {});

    const withEndpoints = calls[0]?.init.headers as Record<string, string>;
    expect(withEndpoints["X-LLM-Base-URL"]).toBe(
      JSON.stringify({ anthropic: "https://x.example/v1" }),
    );
    expect(withEndpoints).not.toHaveProperty("X-LLM-API-Key");
    expect(calls[1]?.init.headers).not.toHaveProperty("X-LLM-Base-URL");
  });

  it("throws { code, status } for a request refused before the stream opens", async () => {
    stubFetch(() =>
      Response.json(
        { error: { code: "LLM_KEY_REQUIRED", message: "No API key for google" } },
        { status: 400 },
      ),
    );
    const err = await new RegistryClient(BASE).run("dev", "agent", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("No API key for google");
    expect((err as Error & { code: string }).code).toBe("LLM_KEY_REQUIRED");
    expect((err as Error & { status: number }).status).toBe(400);
  });
});

describe("connect — the client of the server a command targets, with that server's session", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  const C = "https://c.example";

  interface Sent {
    url: string;
    headers: Record<string, string>;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Replace fetch by a recorder that answers with `respond(url)`. */
  function recordRequests(respond: (url: string) => Response = () => Response.json([])): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
        return respond(String(input));
      }),
    );
    return sent;
  }

  /** `connect()`, with what it printed and the code it ended with when it refused. */
  function connectAndCapture(): {
    client: RegistryClient | undefined;
    printed: string[];
    exitCode: number | undefined;
  } {
    const printed: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      printed.push(parts.map(String).join(" "));
    });
    try {
      return { client: connect(), printed, exitCode: undefined };
    } catch (err) {
      if (!(err instanceof CliExit)) throw err;
      return { client: undefined, printed, exitCode: err.code };
    } finally {
      error.mockRestore();
    }
  }

  function readBack(profile: ThrowawayProfile): ReturnType<typeof parseSessionFile> {
    return parseSessionFile(readFileSync(profile.file, "utf-8"));
  }

  it("the current server's session: its requests go there, with its token", async () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
    });
    const sent = recordRequests();

    const { client } = connectAndCapture();
    await client?.listKeys();

    expect(sent.map((s) => [s.url, s.headers.Authorization])).toEqual([
      [`${A}/api/keys`, "Bearer token-a"],
    ]);
  });

  it("SKRUN_REGISTRY_URL names another server with a session: that one, with its own token", async () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
    });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);
    const sent = recordRequests();

    const { client } = connectAndCapture();
    await client?.listKeys();

    expect(sent.map((s) => [s.url, s.headers.Authorization])).toEqual([
      [`${B}/api/keys`, "Bearer token-b"],
    ]);
  });

  it.each([
    [
      "no session for the server SKRUN_REGISTRY_URL names: the sign-in advised names no address",
      (profile: ThrowawayProfile) => {
        writeSession(profile, { address: A, token: "token-a" });
        vi.stubEnv("SKRUN_REGISTRY_URL", B);
      },
      `Not logged in to ${B}. Sign in: skrun login (SKRUN_REGISTRY_URL names this server)`,
    ],
    [
      "no session for the current server: the sign-in advised names it",
      (profile: ThrowawayProfile) =>
        writeSignInFile(profile, {
          version: 2,
          current: B,
          sessions: { [A]: { token: "token-a" } },
        }),
      `Not logged in to ${B}. Sign in: skrun login --registry ${B}`,
    ],
    [
      "no sign-in file at all: the default server",
      () => {},
      "Not logged in to http://localhost:4000. Sign in: skrun login --registry http://localhost:4000",
    ],
    [
      "an older CLI's file",
      (profile: ThrowawayProfile) =>
        writeSignInFile(profile, { token: "older-token", registry_url: A }),
      "Signed in with an older CLI — sign in again: skrun login --registry <url>",
    ],
    [
      "a file that cannot be read",
      (profile: ThrowawayProfile) => writeSignInFile(profile, "{ not json"),
      "The CLI's sign-in file cannot be read — sign in again: skrun login --registry <url>",
    ],
    [
      "an older CLI's file, the server named by SKRUN_REGISTRY_URL: the sign-in advised names no address",
      (profile: ThrowawayProfile) => {
        writeSignInFile(profile, { token: "older-token", registry_url: A });
        vi.stubEnv("SKRUN_REGISTRY_URL", B);
      },
      "Signed in with an older CLI — sign in again: skrun login (SKRUN_REGISTRY_URL names this server)",
    ],
    [
      "a file that cannot be read, the server named by SKRUN_REGISTRY_URL: the sign-in advised names no address",
      (profile: ThrowawayProfile) => {
        writeSignInFile(profile, "{ not json");
        vi.stubEnv("SKRUN_REGISTRY_URL", B);
      },
      "The CLI's sign-in file cannot be read — sign in again: skrun login (SKRUN_REGISTRY_URL names this server)",
    ],
    [
      "an invalid SKRUN_REGISTRY_URL",
      (profile: ThrowawayProfile) => {
        writeSession(profile, { address: A, token: "token-a" });
        vi.stubEnv("SKRUN_REGISTRY_URL", "ftp://b.example");
      },
      "SKRUN_REGISTRY_URL must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com",
    ],
  ])("%s: the command ends with 1, says why once, and sends nothing", (_what, arrange, message) => {
    const profile = useThrowawayProfile();
    arrange(profile);
    const sent = recordRequests();

    const { client, printed, exitCode } = connectAndCapture();

    expect(client).toBeUndefined();
    expect(exitCode).toBe(1);
    expect(printed.map((line) => stripVTControlCharacters(line))).toEqual([`✗ ${message}`]);
    expect(sent).toEqual([]);
  });

  it("the namespace asked of the server the variable targets is saved with that server's session — the current server and the other sessions stay", async () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: {
        [A]: { token: "token-a", username: "alice" },
        [B]: { token: "token-b" },
        [C]: { token: "token-c", username: "carol" },
      },
    });
    vi.stubEnv("SKRUN_REGISTRY_URL", B);
    const sent = recordRequests(() => Response.json({ namespace: "bob" }));

    const namespace = await connectAndCapture().client?.currentNamespace();

    expect(namespace).toBe("bob");
    expect(sent.map((s) => [s.url, s.headers.Authorization])).toEqual([
      [`${B}/api/me`, "Bearer token-b"],
    ]);
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: A,
        sessions: {
          [A]: { token: "token-a", username: "alice" },
          [B]: { token: "token-b", username: "bob" },
          [C]: { token: "token-c", username: "carol" },
        },
      },
    });
  });

  it.each([
    [
      "the local development token stands for dev",
      { token: "dev-token", username: "alice" },
      "dev",
    ],
    ["a namespace saved with the session", { token: "token-a", username: "alice" }, "alice"],
  ])("%s, without a request", async (_what, session, expected) => {
    writeSession(useThrowawayProfile(), { address: A, ...session });
    const sent = recordRequests();

    expect(await connectAndCapture().client?.currentNamespace()).toBe(expected);
    expect(sent).toEqual([]);
  });

  it("the verification view reads the policy and the role, and is empty when the server cannot be reached", async () => {
    writeSession(useThrowawayProfile(), { address: A, token: "token-a" });
    recordRequests(() => Response.json({ verification_policy: "admin", role: "admin" }));
    const client = connectAndCapture().client;

    expect(await client?.verificationView()).toEqual({ policy: "admin", role: "admin" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await client?.verificationView()).toEqual({});
  });

  it("the verification view's request leaves with a signal that can end it, not yet aborted, so a slow server is not waited on", async () => {
    writeSession(useThrowawayProfile(), { address: A, token: "token-a" });
    const signals: Array<{ isSignal: boolean; aborted: boolean | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        signals.push({
          isSignal: init?.signal instanceof AbortSignal,
          aborted: init?.signal?.aborted,
        });
        return Response.json({ verification_policy: "owner", role: "user" });
      }),
    );

    expect(await connectAndCapture().client?.verificationView()).toEqual({
      policy: "owner",
      role: "user",
    });
    expect(signals).toEqual([{ isSignal: true, aborted: false }]);
  });

  it("an agent's logs: the runs; a refusal carries its status; a server that cannot be reached is named", async () => {
    writeSession(useThrowawayProfile(), { address: A, token: "token-a" });
    const sent = recordRequests(() => Response.json({ logs: [{ run_id: "r1" }] }));
    const client = connectAndCapture().client as RegistryClient;

    expect(await client.logs("dev", "agent", 5)).toEqual([{ run_id: "r1" }]);
    expect(sent.map((s) => s.url)).toEqual([`${A}/api/agents/dev/agent/logs?limit=5`]);

    recordRequests(() => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }));
    const refused = await client.logs("dev", "missing", 5).catch((e: unknown) => e);
    expect((refused as Error & { status: number }).status).toBe(404);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const unreachable = await client.logs("dev", "agent", 5).catch((e: unknown) => e);
    expect(unreachable).toBeInstanceOf(Unreachable);
    expect((unreachable as Error).message).toBe(`Could not reach ${A} (fetch failed).`);
  });
});
