import { describe, expect, it } from "vitest";
import { AgentConfigSchema } from "./agent-config.js";
import { timeoutRawSeconds } from "./environment-config.js";
import { findRefusedSettings } from "./refused-settings.js";

// The exact words an author reads, each pinned whole.
const AUTH = (i: number, value: string) =>
  `mcp_servers[${i}].auth: ${value} is not yet supported — no credential would be sent to the server. Remove the line: none, the default, is accepted.`;
const SECRETS =
  "environment.secrets is not yet supported — no secret is injected into a run. Leave the list empty, or remove it.";
const META =
  "model.provider meta has no endpoint of its own: set model.base_url to the OpenAI-compatible endpoint that serves the model.";
const META_FALLBACK =
  "model.fallback.provider meta cannot be served: a fallback model is called at its provider's own endpoint, and meta has none. Pick another provider for the fallback.";
const TIMEOUT = (value: string) =>
  `environment.timeout "${value}" is outside the allowed range: a run's timeout is between 1s and 2147483s (about 24.8 days), e.g. "300s".`;

const REMOTE = { name: "search", url: "https://mcp.example.com/sse" };
const STDIO = { name: "files", transport: "stdio", command: "npx" };

describe("findRefusedSettings — an MCP server's auth", () => {
  describe.each([
    ["a remote server", REMOTE],
    ["a stdio server", STDIO],
  ])("on %s", (_kind, server) => {
    it.each([
      ["none", { ...server, auth: "none" }],
      ["absent", server],
    ])("says nothing when auth is %s", (_case, declared) => {
      expect(findRefusedSettings({ mcp_servers: [declared] })).toEqual([]);
    });

    it.each([
      ["api_key"],
      ["oauth2"],
    ])("refuses auth %s, naming the server and the value", (auth) => {
      expect(findRefusedSettings({ mcp_servers: [{ ...server, auth }] })).toEqual([
        { code: "UNSUPPORTED_FIELD", message: AUTH(0, auth), field: "mcp_servers[0].auth" },
      ]);
    });
  });

  it("names each server by its place in the list", () => {
    const servers = [
      { ...REMOTE, auth: "none" },
      { ...STDIO, auth: "api_key" },
      { ...REMOTE, name: "other", auth: "oauth2" },
    ];
    expect(findRefusedSettings({ mcp_servers: servers })).toEqual([
      { code: "UNSUPPORTED_FIELD", message: AUTH(1, "api_key"), field: "mcp_servers[1].auth" },
      { code: "UNSUPPORTED_FIELD", message: AUTH(2, "oauth2"), field: "mcp_servers[2].auth" },
    ]);
  });
});

describe("findRefusedSettings — environment.secrets", () => {
  it.each([
    ["absent", {}],
    ["an empty list", { secrets: [] }],
  ])("says nothing when the list is %s", (_case, environment) => {
    expect(findRefusedSettings({ environment })).toEqual([]);
  });

  it("refuses a list that names a secret", () => {
    expect(findRefusedSettings({ environment: { secrets: ["X"] } })).toEqual([
      { code: "UNSUPPORTED_FIELD", message: SECRETS, field: "environment.secrets" },
    ]);
  });
});

describe("findRefusedSettings — the meta provider", () => {
  it("says nothing for meta served at a base_url", () => {
    const model = { provider: "meta", name: "llama", base_url: "http://localhost:8080/v1" };
    expect(findRefusedSettings({ model })).toEqual([]);
  });

  it("refuses meta without a base_url", () => {
    expect(findRefusedSettings({ model: { provider: "meta", name: "llama" } })).toEqual([
      { code: "MODEL_BASE_URL_REQUIRED", message: META, field: "model.provider" },
    ]);
  });

  it("refuses a meta fallback", () => {
    const model = {
      provider: "anthropic",
      name: "claude-sonnet-4-6",
      fallback: { provider: "meta", name: "llama" },
    };
    expect(findRefusedSettings({ model })).toEqual([
      { code: "MODEL_BASE_URL_REQUIRED", message: META_FALLBACK, field: "model.fallback.provider" },
    ]);
  });

  it("refuses a meta fallback even when the primary has a base_url: a fallback is not called there", () => {
    const model = {
      provider: "meta",
      name: "llama",
      base_url: "http://localhost:8080/v1",
      fallback: { provider: "meta", name: "llama-small" },
    };
    expect(findRefusedSettings({ model })).toEqual([
      { code: "MODEL_BASE_URL_REQUIRED", message: META_FALLBACK, field: "model.fallback.provider" },
    ]);
  });

  it("says nothing for a fallback at another provider", () => {
    const model = {
      provider: "anthropic",
      name: "claude-sonnet-4-6",
      fallback: { provider: "openai", name: "gpt-4o" },
    };
    expect(findRefusedSettings({ model })).toEqual([]);
  });
});

describe("findRefusedSettings — environment.timeout", () => {
  it.each([["1s"], ["300s"], ["2147483s"]])("accepts %s", (timeout) => {
    expect(findRefusedSettings({ environment: { timeout } })).toEqual([]);
  });

  it.each([
    ["0s", "0s"],
    ["2147484s", "2147484s"],
    ["99999999999999999999s", "99999999999999999999s"],
    ["a 400-digit number of seconds", `${"9".repeat(400)}s`],
  ])("refuses %s, naming the two bounds", (_label, timeout) => {
    expect(findRefusedSettings({ environment: { timeout } })).toEqual([
      { code: "TIMEOUT_OUT_OF_RANGE", message: TIMEOUT(timeout), field: "environment.timeout" },
    ]);
  });

  it("reads the number of seconds as written, unbounded", () => {
    expect(timeoutRawSeconds("300s")).toBe(300);
    expect(timeoutRawSeconds("0s")).toBe(0);
    expect(timeoutRawSeconds("99999999999999999999s")).toBe(1e20);
    expect(timeoutRawSeconds(`${"9".repeat(400)}s`)).toBe(Number.POSITIVE_INFINITY);
    expect(timeoutRawSeconds("s")).toBeNaN();
  });
});

describe("findRefusedSettings — a value without the schema's shape", () => {
  it.each([
    ["a secrets that is not a list", { environment: { secrets: "X" } }],
    ["a timeout that is a number", { environment: { timeout: 600 } }],
    ["a timeout not in whole seconds", { environment: { timeout: "abc" } }],
    ["a timeout in minutes", { environment: { timeout: "0m" } }],
    ["an environment that is not an object", { environment: null }],
    ["mcp_servers that is not a list", { mcp_servers: "none" }],
    ["a server that is not an object", { mcp_servers: [null, "api_key"] }],
    ["a model that is not an object", { model: "meta" }],
    ["nothing at all", {}],
  ])("says nothing for %s: the schema's own check refuses it", (_case, config) => {
    expect(findRefusedSettings(config)).toEqual([]);
  });
});

describe("findRefusedSettings — a parsed configuration", () => {
  it("reads what the schema accepts, and names every refused setting in order", () => {
    // The schema accepts each of them: a version already published stays readable.
    const config = AgentConfigSchema.parse({
      name: "every-refusal",
      version: "1.0.0",
      model: {
        provider: "meta",
        name: "llama",
        fallback: { provider: "meta", name: "llama-small" },
      },
      mcp_servers: [
        { ...REMOTE, auth: "api_key" },
        { ...STDIO, auth: "oauth2" },
      ],
      inputs: [{ name: "q", type: "string" }],
      outputs: [{ name: "answer", type: "string" }],
      environment: { secrets: ["X"], timeout: "0s" },
    });

    expect(findRefusedSettings(config)).toEqual([
      { code: "MODEL_BASE_URL_REQUIRED", message: META, field: "model.provider" },
      { code: "MODEL_BASE_URL_REQUIRED", message: META_FALLBACK, field: "model.fallback.provider" },
      { code: "UNSUPPORTED_FIELD", message: AUTH(0, "api_key"), field: "mcp_servers[0].auth" },
      { code: "UNSUPPORTED_FIELD", message: AUTH(1, "oauth2"), field: "mcp_servers[1].auth" },
      { code: "UNSUPPORTED_FIELD", message: SECRETS, field: "environment.secrets" },
      { code: "TIMEOUT_OUT_OF_RANGE", message: TIMEOUT("0s"), field: "environment.timeout" },
    ]);
  });

  it("says nothing for a configuration the schema fills with its defaults", () => {
    const config = AgentConfigSchema.parse({
      name: "defaults",
      version: "1.0.0",
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      mcp_servers: [REMOTE],
      inputs: [{ name: "q", type: "string" }],
      outputs: [{ name: "answer", type: "string" }],
    });

    expect(config.mcp_servers[0]?.auth).toBe("none");
    expect(findRefusedSettings(config)).toEqual([]);
  });
});
