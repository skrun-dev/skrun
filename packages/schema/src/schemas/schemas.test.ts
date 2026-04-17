import { describe, expect, it } from "vitest";
import { AgentConfigSchema } from "./agent-config.js";
import { EnvironmentConfigSchema } from "./environment-config.js";
import { InputFieldSchema, OutputFieldSchema } from "./inputs-outputs.js";
import { McpServerSchema } from "./mcp-server.js";
import { ModelConfigSchema } from "./model-config.js";
import { SkillFrontmatterSchema } from "./skill-frontmatter.js";
import { StateConfigSchema } from "./state-config.js";
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
    expect(result.filesystem).toBe("read-only");
    expect(result.secrets).toEqual([]);
    expect(result.timeout).toBe("300s");
    expect(result.sandbox).toBe("strict");
    expect(result.max_cost).toBeUndefined();
  });

  it("should accept valid values (VT-1)", () => {
    const result = EnvironmentConfigSchema.parse({
      networking: { allowed_hosts: ["googleapis.com", "*.example.com"] },
      filesystem: "read-write",
      secrets: ["API_KEY"],
      timeout: "600s",
      max_cost: 5.0,
      sandbox: "permissive",
    });
    expect(result.networking.allowed_hosts).toHaveLength(2);
    expect(result.filesystem).toBe("read-write");
    expect(result.timeout).toBe("600s");
    expect(result.max_cost).toBe(5.0);
    expect(result.sandbox).toBe("permissive");
  });

  it("should reject invalid filesystem value (VT-3)", () => {
    expect(() => EnvironmentConfigSchema.parse({ filesystem: "execute" })).toThrow();
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
  it("should apply defaults", () => {
    const result = StateConfigSchema.parse({});
    expect(result.type).toBe("kv");
    expect(result.ttl).toBe("30d");
  });

  it("should reject invalid ttl format", () => {
    expect(() => StateConfigSchema.parse({ ttl: "30h" })).toThrow();
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
    name: "acme/seo-audit",
    version: "1.0.0",
    model: { provider: "anthropic", name: "claude-sonnet-4-20250514" },
    inputs: [{ name: "website_url", type: "string" }],
    outputs: [{ name: "report", type: "object" }],
  };

  it("should validate a minimal valid config", () => {
    const result = AgentConfigSchema.parse(validConfig);
    expect(result.name).toBe("acme/seo-audit");
    expect(result.tools).toEqual([]);
    expect(result.environment.filesystem).toBe("read-only");
    expect(result.environment.timeout).toBe("300s");
    expect(result.state.type).toBe("kv");
    expect(result.context_mode).toBe("skill");
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
        sandbox: "strict",
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

  it("should reject invalid name format", () => {
    expect(() => AgentConfigSchema.parse({ ...validConfig, name: "no-namespace" })).toThrow();
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
    expect(result.environment.filesystem).toBe("read-write");
    expect(result.environment.timeout).toBe("600s");
    expect(result.environment.sandbox).toBe("strict");
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
      runtime: { timeout: "300s", sandbox: "strict" },
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
