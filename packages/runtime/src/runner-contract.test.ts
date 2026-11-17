import { describe, expect, expectTypeOf, it } from "vitest";
import { RUNNER_ERROR_BODY_MAX_BYTES, readRunnerErrorText } from "./adapter/flyio/runner-call.js";
import { BundleFetchFailedError, McpConnectError } from "./errors.js";
import {
  type ClaimRequest,
  ClaimRequestSchema,
  ClaimResultSchema,
  classifyInitFailure,
  type HealthzResult,
  HealthzResultSchema,
  INFRA_HOSTS_CHECKS,
  INIT_ERROR_MESSAGE_MAX_BYTES,
  INIT_STAGES,
  type InfraHostsCheck,
  type InitErrorBody,
  InitErrorBodySchema,
  type InitRequest,
  InitRequestSchema,
  type InitResult,
  InitResultSchema,
  type InitStage,
  InitStepError,
  initErrorBody,
  initErrorMessage,
  initStageOf,
  mcpFactsOf,
  type ToolRequest,
  ToolRequestSchema,
} from "./runner-contract.js";
import type { InitResult as InitResultOfTypes } from "./types.js";

/**
 * The bodies the harness and the runner exchange to prepare a run. The two are
 * deployed separately, so each reads the other's newer and older messages: a
 * field it does not know is ignored, never refused, and a field added later is
 * optional.
 */

const SHA = "a".repeat(64);
const TOKEN = "t".repeat(32);

const initBody = {
  bundleUrl: "https://store.example/bundle.tgz?sig=1",
  outputsPutUrl: "https://store.example/outputs?sig=2",
  tools: [{ name: "lookup", script: "lookup.py", description: "Finds a thing" }],
  mcpServers: [{ name: "docs", transport: "http", url: "https://mcp.example/" }],
  allowedHosts: ["api.example.com"],
  bundleSha256: SHA,
};

describe("a body that carries a field its reader does not know", () => {
  it("is accepted by the runner at /init, the field dropped and the rest kept", () => {
    const parsed = InitRequestSchema.safeParse({ ...initBody, sentByANewerHarness: 600 });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(initBody);
  });

  it("is accepted by the runner at /claim, the field dropped and the rest kept", () => {
    const parsed = ClaimRequestSchema.safeParse({
      rpcToken: TOKEN,
      allowedHosts: ["api.example.com"],
      sentByANewerHarness: 600,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ rpcToken: TOKEN, allowedHosts: ["api.example.com"] });
  });

  it("is accepted by the harness in the answers of /init and /claim, and in a failed /init", () => {
    const init = InitResultSchema.safeParse({ ok: true, tools: [], answeredByANewerRunner: 1 });
    const claim = ClaimResultSchema.safeParse({
      ok: true,
      process_id: "p-1",
      answeredByANewerRunner: 1,
    });
    const failed = InitErrorBodySchema.safeParse({
      error: "init failed",
      message: "boom",
      answeredByANewerRunner: 1,
    });

    expect(init.data).toEqual({ ok: true, tools: [] });
    expect(claim.data).toEqual({ ok: true, process_id: "p-1" });
    expect(failed.data).toEqual({ error: "init failed", message: "boom" });
  });

  it("is kept whole on an agent's tool or server, which the runner relays to its provider", () => {
    const parsed = InitRequestSchema.parse(initBody);

    expect(parsed.tools[0]).toEqual(initBody.tools[0]);
    expect(parsed.mcpServers[0]).toEqual(initBody.mcpServers[0]);
  });
});

describe("what an older side sends", () => {
  it("an /init body without lists or checksum: the lists empty, no checksum", () => {
    const parsed = InitRequestSchema.parse({ bundleUrl: initBody.bundleUrl });

    expect(parsed).toEqual({
      bundleUrl: initBody.bundleUrl,
      tools: [],
      mcpServers: [],
      allowedHosts: [],
    });
  });

  it("a /claim body without hosts: no host allowed", () => {
    expect(ClaimRequestSchema.parse({ rpcToken: TOKEN })).toEqual({
      rpcToken: TOKEN,
      allowedHosts: [],
    });
  });

  it("a /claim body without a lifetime: none, and the rest kept", () => {
    const parsed = ClaimRequestSchema.parse({ rpcToken: TOKEN, allowedHosts: ["a.example"] });
    expect(parsed.lifetimeS).toBeUndefined();
    expect(parsed.allowedHosts).toEqual(["a.example"]);
  });

  it("an /init answer with its tools alone, or phases without the dependency install", () => {
    expect(InitResultSchema.safeParse({ ok: true, tools: [] }).success).toBe(true);
    expect(
      InitResultSchema.safeParse({
        ok: true,
        tools: [],
        phases: { bundle_ms: 1, extract_ms: 2, mcp_ms: 3 },
        boot: { vm_boot_ms: 4 },
      }).success,
    ).toBe(true);
  });

  it("an /init answer whose timings it cannot read: the timings absent, the start kept", () => {
    const tools = [{ name: "lookup", description: "Finds a thing", input_schema: {} }];

    expect(
      InitResultSchema.parse({
        ok: true,
        tools,
        phases: { bundle_ms: 1, mcp_ms: 3 },
        boot: { vm_boot_ms: "4" },
        infra_hosts: "unchanged",
      }),
    ).toEqual({ ok: true, tools, infra_hosts: "unchanged" });
    expect(InitResultSchema.parse({ ok: true, tools, phases: "fast", boot: [1] })).toEqual({
      ok: true,
      tools,
    });
  });

  it("a /claim answer without the process that answered", () => {
    expect(ClaimResultSchema.parse({ ok: true, uptime_ms: 12 })).toEqual({
      ok: true,
      uptime_ms: 12,
    });
  });
});

describe("the lifetime a /claim body carries", () => {
  it("is the machine's, in whole seconds, from 1 to ten digits", () => {
    for (const lifetimeS of [1, 1250, 2_148_417, 9_999_999_999]) {
      expect(ClaimRequestSchema.parse({ rpcToken: TOKEN, lifetimeS }).lifetimeS).toBe(lifetimeS);
    }
  });
});

describe("what neither side accepts", () => {
  it("an /init body whose bundle URL is not one, or whose checksum is not 64 hex digits", () => {
    expect(InitRequestSchema.safeParse({ ...initBody, bundleUrl: "not a url" }).success).toBe(
      false,
    );
    expect(InitRequestSchema.safeParse({ ...initBody, bundleSha256: "ABC" }).success).toBe(false);
    expect(InitRequestSchema.safeParse({ ...initBody, tools: [{ script: "x.py" }] }).success).toBe(
      false,
    );
  });

  it("a /claim body whose credential is shorter than 32 characters", () => {
    expect(ClaimRequestSchema.safeParse({ rpcToken: "short" }).success).toBe(false);
  });

  // The runner hands the lifetime to the machine's guardian as digits, which
  // arms 1 to 10 of them: anything else would reach it as a line it refuses, or
  // as a lifetime it does not arm.
  it("a /claim body whose lifetime is not a whole number of seconds, from 1 to ten digits", () => {
    for (const lifetimeS of [0, -1, 1.5, 10_000_000_000, "600", null]) {
      expect(ClaimRequestSchema.safeParse({ rpcToken: TOKEN, lifetimeS }).success).toBe(false);
    }
  });

  it("an answer that does not say ok, or an /init answer without a list of tools", () => {
    expect(InitResultSchema.safeParse({ tools: [] }).success).toBe(false);
    expect(InitResultSchema.safeParse({ ok: true, tools: "none" }).success).toBe(false);
    expect(ClaimResultSchema.safeParse({ process_id: "p-1" }).success).toBe(false);
    expect(InitErrorBodySchema.safeParse({ message: "boom" }).success).toBe(false);
  });
});

describe("the body of /tool, and the answer to /healthz", () => {
  it("a /tool body names its kind and its tool, its arguments none when it sends none", () => {
    expect(ToolRequestSchema.safeParse({ kind: "script", name: "lookup" }).data).toEqual({
      kind: "script",
      name: "lookup",
      args: {},
    });
    expect(
      ToolRequestSchema.safeParse({ kind: "mcp", name: "search", args: { q: "x" } }).data,
    ).toEqual({ kind: "mcp", name: "search", args: { q: "x" } });
  });

  it("a /tool body carrying a field the runner does not know: the field dropped, the rest kept", () => {
    const parsed = ToolRequestSchema.safeParse({
      kind: "script",
      name: "lookup",
      args: {},
      sentByANewerHarness: 1,
    });

    expect(parsed.data).toEqual({ kind: "script", name: "lookup", args: {} });
  });

  it("a /tool body of another kind, without a name, or whose arguments are not an object, is refused", () => {
    expect(ToolRequestSchema.safeParse({ kind: "shell", name: "x" }).success).toBe(false);
    expect(ToolRequestSchema.safeParse({ kind: "script" }).success).toBe(false);
    expect(ToolRequestSchema.safeParse({ kind: "script", name: "x", args: [1] }).success).toBe(
      false,
    );
    expect(ToolRequestSchema.safeParse({ kind: "script", name: "x", args: "x" }).success).toBe(
      false,
    );
  });

  it("a /healthz answer names the process that answered; an older runner's names none", () => {
    expect(HealthzResultSchema.safeParse({ ok: true, process_id: "p-1" }).data).toEqual({
      ok: true,
      process_id: "p-1",
    });
    expect(HealthzResultSchema.safeParse({ ok: true }).data).toEqual({ ok: true });
  });

  it("a /healthz answer is read for its process alone: a field the harness does not know, or no ok, still names it", () => {
    expect(
      HealthzResultSchema.safeParse({ ok: true, process_id: "p-1", answeredByANewerRunner: 1 })
        .data,
    ).toEqual({ ok: true, process_id: "p-1" });
    expect(HealthzResultSchema.safeParse({ process_id: "p-1" }).data).toEqual({
      process_id: "p-1",
    });
  });

  it("a /healthz answer whose process is not a text, or that says it is not ok, names no process", () => {
    expect(HealthzResultSchema.safeParse({ ok: true, process_id: 7 }).success).toBe(false);
    expect(HealthzResultSchema.safeParse({ ok: false, process_id: "p-1" }).success).toBe(false);
  });
});

describe("the types", () => {
  it("are those of the schemas, and the runtime's other name for the /init answer is the same", () => {
    expectTypeOf<InitResultOfTypes>().toEqualTypeOf<InitResult>();
    expectTypeOf(InitRequestSchema.parse(initBody)).toEqualTypeOf<InitRequest>();
    expectTypeOf(ClaimRequestSchema.parse({ rpcToken: TOKEN })).toEqualTypeOf<ClaimRequest>();
    expectTypeOf(ToolRequestSchema.parse({ kind: "mcp", name: "x" })).toEqualTypeOf<ToolRequest>();
    expectTypeOf(HealthzResultSchema.parse({ ok: true })).toEqualTypeOf<HealthzResult>();
  });
});

describe("the step a failed /init names, read from its error's class, never its text", () => {
  const fetchFailed = (
    kind: "network" | "status" | "incomplete" | undefined,
    httpStatus: number | null,
  ) =>
    new BundleFetchFailedError({
      urlHost: "store.example",
      httpStatus,
      bytesDownloaded: 0,
      ...(kind !== undefined && { kind }),
    });
  const mcpFailed = new McpConnectError({
    server: "docs",
    transport: "streamable-http",
    location: "https://mcp.example/",
    isTimeout: false,
  });
  const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
    syscall: "write",
  });

  it.each([
    ["a download that found no answer", fetchFailed("network", null), "bundle-network"],
    ["a download refused by its answer", fetchFailed("status", 403), "bundle-status"],
    [
      "a download whose body did not arrive whole",
      fetchFailed("incomplete", 200),
      "bundle-incomplete",
    ],
    ["an older download error without an answer", fetchFailed(undefined, null), "bundle-network"],
    ["an older download error with a status", fetchFailed(undefined, 503), "bundle-status"],
    [
      "a bundle that does not match its checksum",
      new InitStepError("bundle-checksum", "bundle checksum mismatch"),
      "bundle-checksum",
    ],
    [
      "a bundle that does not extract",
      new InitStepError("bundle-extract", "tar extract failed: exit code 2"),
      "bundle-extract",
    ],
    [
      "a disk the runner found full",
      new InitStepError("disk-full", "tar extract failed: the disk is full"),
      "disk-full",
    ],
    ["a write the disk refused for want of space", diskFull, "disk-full"],
    [
      "a step whose cause is a full disk",
      new InitStepError("bundle-extract", "tar extract failed", { cause: diskFull }),
      "disk-full",
    ],
    ["a connection to an MCP server that failed", mcpFailed, "mcp-connect"],
    [
      "an error of no class it knows, whatever its text",
      new Error("bundle checksum mismatch"),
      "other",
    ],
    ["another text that names a step", new Error("MCP server failed to connect"), "other"],
    ["a value thrown that is not an error", "bundle-checksum", "other"],
  ] as const)("%s: %s", (_what, err, stage) => {
    expect(initStageOf(err)).toBe(stage);
  });

  it("names only steps the contract lists", () => {
    const stage: InitStage = initStageOf(new Error("x"));
    expect(INIT_STAGES).toContain(stage);
  });
});

describe("what a failed connection to an MCP server answered, for the body of a failed /init", () => {
  const failed = (facts: { httpStatus?: number; rpcCode?: number }) =>
    new McpConnectError({
      server: "docs",
      transport: "streamable-http",
      location: "https://mcp.example/",
      isTimeout: false,
      ...facts,
    });

  it("is the status the server refused it with, or the code of the error it answered", () => {
    expect(mcpFactsOf(failed({ httpStatus: 401 }))).toEqual({ http_status: 401 });
    expect(mcpFactsOf(failed({ rpcCode: -32602 }))).toEqual({ rpc_code: -32602 });
  });

  it("is nothing when the server answered neither, or when the error is not a connection's", () => {
    expect(mcpFactsOf(failed({}))).toBeUndefined();
    expect(mcpFactsOf(new Error("x"))).toBeUndefined();
  });
});

describe("which failed /init is the run's own fault", () => {
  it.each([
    ["a bundle that does not match its checksum", { stage: "bundle-checksum" }],
    ["a bundle that does not extract", { stage: "bundle-extract" }],
    ["an MCP server that refused it with 401", { stage: "mcp-connect", mcp: { http_status: 401 } }],
    ["an MCP server that refused it with 404", { stage: "mcp-connect", mcp: { http_status: 404 } }],
    ["an MCP server that refused it with 405", { stage: "mcp-connect", mcp: { http_status: 405 } }],
    [
      "an MCP server that answered a JSON-RPC error",
      { stage: "mcp-connect", mcp: { rpc_code: -32602 } },
    ],
  ] as const)("%s: deterministic", (_what, failure) => {
    expect(classifyInitFailure(failure)).toBe("deterministic");
  });

  it.each([
    ["an MCP server that refused it with 403", { stage: "mcp-connect", mcp: { http_status: 403 } }],
    ["an MCP server that refused it with 408", { stage: "mcp-connect", mcp: { http_status: 408 } }],
    ["an MCP server that refused it with 429", { stage: "mcp-connect", mcp: { http_status: 429 } }],
    ["an MCP server that refused it with 500", { stage: "mcp-connect", mcp: { http_status: 500 } }],
    ["an MCP server that refused it with 503", { stage: "mcp-connect", mcp: { http_status: 503 } }],
    ["an MCP server that answered nothing it could read", { stage: "mcp-connect" }],
    ["a download that found no answer", { stage: "bundle-network" }],
    ["a download refused by its answer", { stage: "bundle-status" }],
    ["a download whose body did not arrive whole", { stage: "bundle-incomplete" }],
    ["a full disk", { stage: "disk-full" }],
    ["any other failure", { stage: "other" }],
    ["an older runner's body, without a step", {}],
    [
      "a status of 401 that is not an MCP server's",
      { stage: "bundle-status", mcp: { http_status: 401 } },
    ],
  ] as const)("%s: indeterminate", (_what, failure) => {
    expect(classifyInitFailure(failure)).toBe("indeterminate");
  });
});

describe("the body of a failed /init", () => {
  it("carries the step, and what an MCP server answered", () => {
    const body = {
      error: "init failed",
      message: "MCP server failed",
      stage: "mcp-connect",
      mcp: { http_status: 401 },
    };

    expect(InitErrorBodySchema.parse(body)).toEqual(body);
  });

  it("reads a step it does not know, or facts it cannot read, as absent, and keeps the rest", () => {
    expect(
      InitErrorBodySchema.parse({
        error: "init failed",
        message: "boom",
        stage: "a-step-of-a-newer-runner",
        mcp: { http_status: "401" },
      }),
    ).toEqual({ error: "init failed", message: "boom" });
  });
});

describe("the body a runner writes for a failed /init", () => {
  /** How many bytes a text takes inside a JSON string, its quotes left out. */
  const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

  /** What the harness reads of an error body: its first bytes, then the contract's fields. */
  async function harnessReads(text: string) {
    const cut = await readRunnerErrorText(new Response(text, { status: 500 }), {
      deadlineMs: 1_000,
      what: "/init",
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(cut);
    } catch {
      return {};
    }
    const body = InitErrorBodySchema.safeParse(parsed);
    return body.success
      ? { stage: body.data.stage, mcp: body.data.mcp, infra_hosts: body.data.infra_hosts }
      : {};
  }

  it("carries the fixed error, the message, the step, what an MCP server answered, and the measurement", () => {
    const err = new McpConnectError(
      {
        server: "docs",
        transport: "streamable-http",
        location: "https://mcp.example/",
        isTimeout: false,
        httpStatus: 401,
      },
      new Error("refused"),
    );

    expect(initErrorBody(err, "changed")).toEqual({
      error: "init failed",
      message: err.message,
      stage: "mcp-connect",
      mcp: { http_status: 401 },
      infra_hosts: "changed",
    });
    expect(JSON.parse(JSON.stringify(initErrorBody(new Error("boom"), undefined)))).toEqual({
      error: "init failed",
      message: "boom",
      stage: "other",
    });
  });

  it("an MCP server's URL of 4,000 characters: the body stays under the harness's read, its step and measurement read, the run's own", async () => {
    const location = `https://mcp.example/${"p".repeat(4_000 - 20)}`;
    const err = new McpConnectError(
      { server: "docs", transport: "streamable-http", location, isTimeout: false, httpStatus: 401 },
      new Error("refused"),
    );
    const text = JSON.stringify(initErrorBody(err, "changed"));
    const read = await harnessReads(text);

    expect(location).toHaveLength(4_000);
    expect(Buffer.byteLength(text)).toBeLessThan(RUNNER_ERROR_BODY_MAX_BYTES);
    expect(read).toEqual({
      stage: "mcp-connect",
      mcp: { http_status: 401 },
      infra_hosts: "changed",
    });
    expect(classifyInitFailure(read)).toBe("deterministic");
  });

  it("keeps a message within the bound whole", () => {
    const message = "m".repeat(INIT_ERROR_MESSAGE_MAX_BYTES);

    expect(initErrorMessage("boom")).toBe("boom");
    expect(initErrorMessage(message)).toBe(message);
  });

  it("cuts a longer one to the bound as JSON writes it, a marker at its end, never inside a character", () => {
    const cases = [
      "a".repeat(5_000),
      "é".repeat(3_000),
      "😀".repeat(2_000),
      '"'.repeat(3_000),
      "\u0001".repeat(3_000),
      `${"a".repeat(1_021)}😀😀`,
    ];
    for (const message of cases) {
      const cut = initErrorMessage(message);

      expect(jsonBytes(cut), message.slice(0, 8)).toBeLessThanOrEqual(INIT_ERROR_MESSAGE_MAX_BYTES);
      expect(jsonBytes(cut), message.slice(0, 8)).toBeGreaterThan(INIT_ERROR_MESSAGE_MAX_BYTES - 8);
      expect(cut.endsWith("…")).toBe(true);
      expect(message.startsWith(cut.slice(0, -1))).toBe(true);
      expect(cut.isWellFormed()).toBe(true);
    }
  });
});

describe("what a pre-created machine measured of its infrastructure hosts", () => {
  it("is one of three words, those the machine's privileged loop writes", () => {
    expect([...INFRA_HOSTS_CHECKS]).toEqual(["changed", "unmeasured", "unchanged"]);
  });

  it.each(
    INFRA_HOSTS_CHECKS,
  )("'%s' is carried by a successful /init and by a failed one", (word) => {
    expect(InitResultSchema.parse({ ok: true, tools: [], infra_hosts: word }).infra_hosts).toBe(
      word,
    );
    expect(
      InitErrorBodySchema.parse({
        error: "init failed",
        stage: "bundle-network",
        infra_hosts: word,
      }).infra_hosts,
    ).toBe(word);
  });

  it("is absent from an older runner's answers, and a word this side does not know is read as absent, the rest kept", () => {
    expect(InitResultSchema.parse({ ok: true, tools: [] }).infra_hosts).toBeUndefined();
    expect(InitErrorBodySchema.parse({ error: "init failed" }).infra_hosts).toBeUndefined();
    expect(
      InitResultSchema.parse({ ok: true, tools: [], infra_hosts: "a-word-of-a-newer-runner" }),
    ).toEqual({ ok: true, tools: [] });
    expect(
      InitErrorBodySchema.parse({
        error: "init failed",
        stage: "bundle-network",
        infra_hosts: 1,
      }),
    ).toEqual({ error: "init failed", stage: "bundle-network" });
  });

  it("types the field of both answers", () => {
    expectTypeOf<InitResult["infra_hosts"]>().toEqualTypeOf<InfraHostsCheck | undefined>();
    expectTypeOf<InitErrorBody["infra_hosts"]>().toEqualTypeOf<InfraHostsCheck | undefined>();
  });
});
