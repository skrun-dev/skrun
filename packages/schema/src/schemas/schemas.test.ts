import { describe, expect, it } from "vitest";
import { AgentConfigSchema } from "./agent-config.js";
import {
  EnvironmentConfigSchema,
  sandboxHostForm,
  sandboxRefusalMessage,
  sandboxRefusedHosts,
} from "./environment-config.js";
import { InputFieldSchema, OutputFieldSchema } from "./inputs-outputs.js";
import { McpServerSchema } from "./mcp-server.js";
import { ModelConfigSchema } from "./model-config.js";
import { SkillFrontmatterSchema } from "./skill-frontmatter.js";
import {
  STATE_TTL_MAX_DAYS,
  STATE_TTL_MIN_DAYS,
  StateConfigSchema,
  stateTtlDays,
  stateTtlRawDays,
} from "./state-config.js";
import { TestCaseSchema } from "./test-case.js";
import { ToolConfigSchema } from "./tool-config.js";

describe("ModelConfigSchema", () => {
  it("should validate a valid model config", () => {
    const result = ModelConfigSchema.parse({
      provider: "anthropic",
      name: "claude-sonnet-4-20250514",
      temperature: 0.3,
    });
    expect(result.provider).toBe("anthropic");
    expect(result.temperature).toBe(0.3);
  });

  it("should validate with fallback", () => {
    const result = ModelConfigSchema.parse({
      provider: "anthropic",
      name: "claude-sonnet-4-20250514",
      fallback: { provider: "openai", name: "gpt-4o" },
    });
    expect(result.fallback?.provider).toBe("openai");
  });

  it("should reject invalid provider", () => {
    expect(() => ModelConfigSchema.parse({ provider: "invalid", name: "test" })).toThrow();
  });

  it("should reject empty name", () => {
    expect(() => ModelConfigSchema.parse({ provider: "anthropic", name: "" })).toThrow();
  });
});

describe("EnvironmentConfigSchema", () => {
  it("should apply all defaults (VT-2)", () => {
    const result = EnvironmentConfigSchema.parse({});
    expect(result.networking.allowed_hosts).toEqual([]);
    expect(result).not.toHaveProperty("filesystem");
    expect(result).not.toHaveProperty("secrets");
    expect(result.timeout).toBe("300s");
    expect(result).not.toHaveProperty("sandbox");
    expect(result.max_cost).toBeUndefined();
  });

  it("should accept valid values (VT-1)", () => {
    const result = EnvironmentConfigSchema.parse({
      networking: { allowed_hosts: ["googleapis.com", "*.example.com"] },
      secrets: ["API_KEY"],
      timeout: "600s",
      max_cost: 5.0,
    });
    expect(result.networking.allowed_hosts).toHaveLength(2);
    expect(result.timeout).toBe("600s");
    expect(result.max_cost).toBe(5.0);
  });

  it("drops a filesystem without a word, whatever its value: the validator is what names it", () => {
    for (const filesystem of ["none", "read-only", "read-write", "execute"]) {
      const result = EnvironmentConfigSchema.parse({ filesystem, timeout: "600s" });
      expect(result).not.toHaveProperty("filesystem");
      expect(result.timeout).toBe("600s");
    }
  });

  it("should parse nested networking config (VT-4)", () => {
    const result = EnvironmentConfigSchema.parse({
      networking: { allowed_hosts: ["api.github.com"] },
    });
    expect(result.networking.allowed_hosts).toEqual(["api.github.com"]);
  });

  it("should reject invalid timeout format", () => {
    expect(() => EnvironmentConfigSchema.parse({ timeout: "5m" })).toThrow();
  });

  it("should reject negative max_cost", () => {
    expect(() => EnvironmentConfigSchema.parse({ max_cost: -1 })).toThrow();
  });
});

// One definition of what the cloud sandbox can enforce in allowed_hosts: "*",
// a host name it reads — letters, digits, dots, hyphens, underscores —, or an
// IPv6 literal, bare or in brackets; spaces taken out and an empty entry
// skipped first, as the sandbox does. Anything else is refused, by its form.
describe("sandboxRefusedHosts", () => {
  it.each([
    ["a host with a port", "example.com:443", "host-port"],
    ["an IPv6 literal with a port", "[2606:4700::1111]:443", "host-port"],
    ["a URL", "https://x.y", "url"],
    ["a host with a path", "x.y/z", "path"],
    ["a host pattern", "*.slack.com", "pattern"],
    ["an internationalised name", "bücher.de", "other"],
    ["an address with an @", "user@example.com", "other"],
    ["a name with a %", "100%.example.com", "other"],
    ["two names in one entry", "a.com,b.com", "other"],
    ["a star inside a name", "api.*.com", "other"],
    ["an IPv6 literal with a zone", "fe80::1%eth0", "other"],
    ["brackets around a name", "[example.com]", "other"],
  ])("refuses %s, by its form", (_what, host, form) => {
    expect(sandboxRefusedHosts([host])).toEqual([{ host, form }]);
  });

  it.each([
    ["every public address", "*"],
    ["a name", "api.example.com"],
    ["a name with an underscore and a hyphen", "my_host-1.example.com"],
    ["a name surrounded by spaces", "  api.example.com  "],
    ["an IPv4 literal", "93.184.216.34"],
    ["a bare IPv6 literal", "2606:4700::1111"],
    ["an IPv6 literal in brackets", "[2606:4700::1111]"],
    ["an empty entry", ""],
    ["an entry of spaces", "   "],
  ])("accepts %s", (_what, host) => {
    expect(sandboxRefusedHosts([host])).toEqual([]);
  });

  it("names each refused entry as written, in order, and only those", () => {
    expect(
      sandboxRefusedHosts(["api.example.com", " example.com:443", "*", "*.slack.com", "x.y/z"]),
    ).toEqual([
      { host: " example.com:443", form: "host-port" },
      { host: "*.slack.com", form: "pattern" },
      { host: "x.y/z", form: "path" },
    ]);
  });
});

describe("sandboxHostForm", () => {
  it("hands the sandbox an IPv6 literal bare, its brackets taken off", () => {
    expect(sandboxHostForm("[2606:4700::1111]")).toBe("2606:4700::1111");
    expect(sandboxHostForm(" [2606:4700::1111] ")).toBe("2606:4700::1111");
  });

  it.each([
    "2606:4700::1111",
    "api.example.com",
    "*",
    "[example.com]",
  ])("leaves %s as written", (host) => {
    expect(sandboxHostForm(host)).toBe(host);
  });
});

describe("sandboxRefusalMessage", () => {
  it("names each entry with its form and which runtime honours it, and says what to write instead", () => {
    const hosts = ["api.example.com", "*.slack.com", "example.com:443", "https://x.y", "a@b"];
    const message = sandboxRefusalMessage(hosts, sandboxRefusedHosts(hosts));
    expect(message).toContain('"*.slack.com" (a host pattern: honoured by the local runtime only)');
    expect(message).toContain('"example.com:443" (a host with a port: honoured by no runtime)');
    expect(message).toContain('"https://x.y" (a URL: honoured by no runtime)');
    expect(message).toContain('"a@b" (not a host name the sandbox reads: honoured by no runtime)');
    expect(message).not.toContain('api.example.com"');
    expect(message).toContain('or use "*"');
    expect(message).toContain("every port");
  });

  it('beside "*", says the entries add nothing and are to be removed — it does not advise "*"', () => {
    const hosts = ["*", "*.slack.com", "x.y/z"];
    const message = sandboxRefusalMessage(hosts, sandboxRefusedHosts(hosts));
    expect(message).toContain('"x.y/z" (a host with a path: honoured by no runtime)');
    expect(message).toContain("remove them");
    expect(message).not.toContain('or use "*"');
  });
});

describe("InputFieldSchema / OutputFieldSchema", () => {
  it("should validate input with defaults", () => {
    const result = InputFieldSchema.parse({ name: "query", type: "string" });
    expect(result.required).toBe(true);
  });

  it("should validate output", () => {
    const result = OutputFieldSchema.parse({
      name: "report",
      type: "object",
      description: "The generated report",
    });
    expect(result.name).toBe("report");
  });

  it("should reject invalid type", () => {
    expect(() => InputFieldSchema.parse({ name: "x", type: "invalid" })).toThrow();
  });
});

describe("StateConfigSchema", () => {
  it("should apply defaults: no state, one notebook per caller, 30 days", () => {
    const result = StateConfigSchema.parse({});
    expect(result.type).toBe("none");
    expect(result.scope).toBe("per_caller");
    expect(result.ttl).toBe("30d");
  });

  it("an agent that turns state on gets one notebook per caller unless it says shared", () => {
    expect(StateConfigSchema.parse({ type: "kv" }).scope).toBe("per_caller");
    expect(StateConfigSchema.parse({ type: "kv", scope: "shared" }).scope).toBe("shared");
  });

  it("refuses a misspelled scope instead of falling back to a default", () => {
    expect(() => StateConfigSchema.parse({ type: "kv", scope: "per_caler" })).toThrow();
  });

  it("should reject invalid ttl format", () => {
    expect(() => StateConfigSchema.parse({ ttl: "30h" })).toThrow();
  });

  it("keeps an out-of-range ttl valid in the schema (a published version must stay runnable)", () => {
    expect(StateConfigSchema.parse({ ttl: "0d" }).ttl).toBe("0d");
    expect(StateConfigSchema.parse({ ttl: "99999999999d" }).ttl).toBe("99999999999d");
  });
});

// The one reading of a ttl's number of days, shared by the refusal before
// publishing (validateAgent) and the bound the server applies (stateTtlDays):
// it bounds nothing itself, so each of the two decides from the same number.
describe("stateTtlRawDays", () => {
  it("reads the number of days a ttl names, bounds included", () => {
    expect(stateTtlRawDays("30d")).toBe(30);
    expect(stateTtlRawDays("1d")).toBe(1);
    expect(stateTtlRawDays("365d")).toBe(365);
  });

  it("does not bound a ttl outside 1 to 365 days", () => {
    expect(stateTtlRawDays("0d")).toBe(0);
    expect(stateTtlRawDays("366d")).toBe(366);
    expect(stateTtlRawDays("99999999999d")).toBe(99999999999);
  });

  it("reads a number of days too long for a double as Infinity", () => {
    expect(stateTtlRawDays(`${"9".repeat(400)}d`)).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads a ttl that does not start with digits as NaN", () => {
    expect(stateTtlRawDays("d")).toBeNaN();
  });
});

describe("stateTtlDays", () => {
  it("reads the number of days of an in-range ttl", () => {
    expect(stateTtlDays("30d")).toBe(30);
    expect(stateTtlDays("1d")).toBe(1);
    expect(stateTtlDays("365d")).toBe(365);
  });

  it("reads a ttl below the floor as the floor", () => {
    expect(STATE_TTL_MIN_DAYS).toBe(1);
    expect(stateTtlDays("0d")).toBe(1);
  });

  it("reads a ttl above the ceiling as the ceiling, however large", () => {
    expect(STATE_TTL_MAX_DAYS).toBe(365);
    expect(stateTtlDays("366d")).toBe(365);
    expect(stateTtlDays("99999999999d")).toBe(365);
    expect(stateTtlDays("9".repeat(400) + "d")).toBe(365);
  });
});

describe("McpServerSchema", () => {
  it("should validate a remote MCP server with url", () => {
    const result = McpServerSchema.parse({
      name: "google-search-console",
      url: "https://mcp.gsc.io/sse",
      auth: "oauth2",
    });
    expect(result.auth).toBe("oauth2");
  });

  it("should default auth to none", () => {
    const result = McpServerSchema.parse({
      name: "test",
      url: "https://example.com",
    });
    expect(result.auth).toBe("none");
  });

  it("should validate a stdio MCP server with command", () => {
    const result = McpServerSchema.parse({
      name: "local-tools",
      transport: "stdio",
      command: "node",
      args: ["mcp-servers/tools.js"],
    });
    expect(result.transport).toBe("stdio");
    expect(result.command).toBe("node");
    expect(result.args).toEqual(["mcp-servers/tools.js"]);
  });

  it("should validate stdio without args", () => {
    const result = McpServerSchema.parse({
      name: "local",
      transport: "stdio",
      command: "python3 server.py",
    });
    expect(result.transport).toBe("stdio");
    expect(result.args).toBeUndefined();
  });

  it("should validate remote with explicit sse transport", () => {
    const result = McpServerSchema.parse({
      name: "legacy",
      url: "https://old-mcp.example.com/sse",
      transport: "sse",
    });
    expect(result.transport).toBe("sse");
  });

  it("should validate remote with streamable-http transport", () => {
    const result = McpServerSchema.parse({
      name: "modern",
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });
    expect(result.transport).toBe("streamable-http");
  });

  it("should reject when no url and no stdio command", () => {
    expect(() => McpServerSchema.parse({ name: "test" })).toThrow();
  });

  it("should reject stdio without command", () => {
    expect(() => McpServerSchema.parse({ name: "test", transport: "stdio" })).toThrow();
  });

  it("should reject invalid URL", () => {
    expect(() => McpServerSchema.parse({ name: "test", url: "not-a-url" })).toThrow();
  });
});

describe("TestCaseSchema", () => {
  it("should validate a test case", () => {
    const result = TestCaseSchema.parse({
      name: "basic-test",
      input: { query: "test" },
      assert: "output.score >= 0",
    });
    expect(result.name).toBe("basic-test");
  });

  it("should reject empty assert", () => {
    expect(() => TestCaseSchema.parse({ name: "test", input: {}, assert: "" })).toThrow();
  });

  it("keeps the input as it was given — a field of its own named __proto__ included", () => {
    const input = JSON.parse('{"__proto__":{"a":1},"q":"x"}');

    const result = TestCaseSchema.parse({ name: "named-proto", input, assert: "true" });

    expect(result.input).toBe(input);
    expect(Object.hasOwn(result.input, "__proto__")).toBe(true);
    expect(JSON.stringify(result.input)).toBe('{"__proto__":{"a":1},"q":"x"}');
  });

  it.each([
    ["a string", "string"],
    [[1, 2], "array"],
    [null, "null"],
    [undefined, "undefined"],
  ])("refuses an input that is not an object (%j) in the words of a record", (input, received) => {
    const result = TestCaseSchema.safeParse({ name: "t", input, assert: "true" });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      {
        expected: "record",
        code: "invalid_type",
        path: ["input"],
        message: `Invalid input: expected record, received ${received}`,
      },
    ]);
  });
});

describe("SkillFrontmatterSchema", () => {
  it("should validate a valid frontmatter", () => {
    const result = SkillFrontmatterSchema.parse({
      name: "pdf-processing",
      description: "Extract PDF text, fill forms, merge files.",
    });
    expect(result.name).toBe("pdf-processing");
  });

  it("should validate with all optional fields", () => {
    const result = SkillFrontmatterSchema.parse({
      name: "code-review",
      description: "Review code for quality and bugs.",
      license: "Apache-2.0",
      compatibility: "Requires git and node",
      metadata: { author: "acme", version: "1.0" },
      "allowed-tools": "Bash(git:*) Read",
    });
    expect(result.license).toBe("Apache-2.0");
    expect(result.metadata?.author).toBe("acme");
    expect(result["allowed-tools"]).toBe("Bash(git:*) Read");
  });

  it("should reject uppercase name", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "PDF-Processing", description: "test" }),
    ).toThrow();
  });

  it("should reject name starting with hyphen", () => {
    expect(() => SkillFrontmatterSchema.parse({ name: "-pdf", description: "test" })).toThrow();
  });

  it("should reject consecutive hyphens", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "pdf--processing", description: "test" }),
    ).toThrow();
  });

  it("should reject name longer than 64 chars", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "a".repeat(65), description: "test" }),
    ).toThrow();
  });

  it("should reject description longer than 1024 chars", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({ name: "test", description: "a".repeat(1025) }),
    ).toThrow();
  });
});

describe("AgentConfigSchema", () => {
  const validConfig = {
    name: "seo-audit",
    version: "1.0.0",
    model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
    inputs: [{ name: "website_url", type: "string" }],
    outputs: [{ name: "report", type: "object" }],
  };

  it("should validate a minimal valid config", () => {
    const result = AgentConfigSchema.parse(validConfig);
    expect(result.name).toBe("seo-audit");
    expect(result.tools).toEqual([]);
    expect(result.environment).not.toHaveProperty("filesystem");
    expect(result.environment.timeout).toBe("300s");
    expect(result.state.type).toBe("none");
    expect(result.state.scope).toBe("per_caller");
    expect(result.context_mode).toBe("skill");
    expect(result.tool_choice).toBe("auto");
    expect(result.parallel_tools).toBe(true);
  });

  it("should accept tool_choice: required and parallel_tools: false", () => {
    const result = AgentConfigSchema.parse({
      ...validConfig,
      tool_choice: "required",
      parallel_tools: false,
    });
    expect(result.tool_choice).toBe("required");
    expect(result.parallel_tools).toBe(false);
  });

  it("should accept tool_choice as a tool name", () => {
    const result = AgentConfigSchema.parse({
      ...validConfig,
      tool_choice: "write_artifact",
    });
    expect(result.tool_choice).toBe("write_artifact");
  });

  it("should accept tool_choice: none", () => {
    const result = AgentConfigSchema.parse({ ...validConfig, tool_choice: "none" });
    expect(result.tool_choice).toBe("none");
  });

  it("should validate a full config", () => {
    const result = AgentConfigSchema.parse({
      ...validConfig,
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
        {
          name: "browser",
          description: "Open URL",
          input_schema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      ],
      mcp_servers: [{ name: "gsc", url: "https://mcp.gsc.io/sse", auth: "oauth2" }],
      environment: {
        networking: { allowed_hosts: ["googleapis.com"] },
        filesystem: "read-only",
        secrets: ["GSC_API_KEY"],
        timeout: "300s",
        max_cost: 0.5,
      },
      context_mode: "persistent",
      state: { type: "kv", ttl: "30d" },
      tests: [
        {
          name: "basic",
          input: { website_url: "https://example.com" },
          assert: "output.score >= 0",
        },
      ],
    });
    expect(result.tools).toHaveLength(2);
    expect(result.mcp_servers).toHaveLength(1);
    expect(result.context_mode).toBe("persistent");
  });

  it("should reject legacy namespace/slug name format (post-#84)", () => {
    // Pre-#84 this asserted that names lacking a `/` were rejected. Post-#84
    // (clean break to slug-only) the assertion flips: names WITH a `/` are now
    // the rejected legacy form, and bare slugs like "no-namespace" are valid.
    expect(() => AgentConfigSchema.parse({ ...validConfig, name: "acme/foo" })).toThrow();
    expect(AgentConfigSchema.parse({ ...validConfig, name: "no-namespace" }).name).toBe(
      "no-namespace",
    );
  });

  it("should reject invalid version format", () => {
    expect(() => AgentConfigSchema.parse({ ...validConfig, version: "v1.0" })).toThrow();
  });

  it("should reject empty inputs", () => {
    expect(() => AgentConfigSchema.parse({ ...validConfig, inputs: [] })).toThrow();
  });

  it("should reject empty outputs", () => {
    expect(() => AgentConfigSchema.parse({ ...validConfig, outputs: [] })).toThrow();
  });

  it("should reject legacy tools:[string] with helpful message", () => {
    const result = AgentConfigSchema.safeParse({ ...validConfig, tools: ["pdf-extract"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const joined = result.error.issues.map((i) => i.message).join(" | ");
      expect(joined).toMatch(/must be an object/i);
      expect(joined).toMatch(/docs\/agent-yaml\.md/);
      const firstIssue = result.error.issues[0];
      expect(firstIssue.path).toEqual(["tools", 0]);
    }
  });

  it("should accept an empty tools array", () => {
    const result = AgentConfigSchema.parse({ ...validConfig, tools: [] });
    expect(result.tools).toEqual([]);
  });

  it("should parse config with environment section (VT-5)", () => {
    const result = AgentConfigSchema.parse({
      ...validConfig,
      environment: {
        networking: { allowed_hosts: ["api.github.com"] },
        filesystem: "read-write",
        timeout: "600s",
      },
    });
    expect(result.environment.networking.allowed_hosts).toEqual(["api.github.com"]);
    expect(result.environment).not.toHaveProperty("filesystem");
    expect(result.environment.timeout).toBe("600s");
    expect(result.environment).not.toHaveProperty("sandbox");
    expect((result as Record<string, unknown>).permissions).toBeUndefined();
    expect((result as Record<string, unknown>).runtime).toBeUndefined();
  });

  it("should reject old permissions top-level key (VT-6)", () => {
    const result = AgentConfigSchema.safeParse({
      ...validConfig,
      permissions: { network: [], filesystem: "read-only", secrets: [] },
    });
    expect(result.success).toBe(false);
  });

  it("should reject old runtime top-level key (VT-7)", () => {
    const result = AgentConfigSchema.safeParse({
      ...validConfig,
      runtime: { timeout: "300s" },
    });
    expect(result.success).toBe(false);
  });
});

describe("ToolConfigSchema", () => {
  const validTool = {
    name: "pdf-extract",
    description: "Extract text from a PDF file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };

  it("should validate a full ToolConfig", () => {
    const result = ToolConfigSchema.parse(validTool);
    expect(result.name).toBe("pdf-extract");
    expect(result.description).toBe("Extract text from a PDF file.");
    expect(result.input_schema.type).toBe("object");
    expect(result.input_schema.required).toEqual(["path"]);
  });

  it("should default ToolConfig.required to false when absent", () => {
    const result = ToolConfigSchema.parse(validTool);
    expect(result.required).toBe(false);
  });

  it("should accept ToolConfig.required: true", () => {
    const result = ToolConfigSchema.parse({ ...validTool, required: true });
    expect(result.required).toBe(true);
  });

  it("should reject missing name", () => {
    const { name, ...without } = validTool;
    void name;
    const result = ToolConfigSchema.safeParse(without);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("should reject missing input_schema", () => {
    const { input_schema, ...without } = validTool;
    void input_schema;
    const result = ToolConfigSchema.safeParse(without);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "input_schema")).toBe(true);
    }
  });

  it("should reject invalid name format", () => {
    const result = ToolConfigSchema.safeParse({ ...validTool, name: "bad name!" });
    expect(result.success).toBe(false);
  });

  it("should preserve extra JSON Schema keywords via passthrough", () => {
    const result = ToolConfigSchema.parse({
      ...validTool,
      input_schema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        },
        required: ["count"],
        additionalProperties: false,
      },
    });
    const count = result.input_schema.properties.count as { minimum: number; default: number };
    expect(count.minimum).toBe(1);
    expect(count.default).toBe(10);
  });
});
