/**
 * OpenAPI 3.1 schema for the Skrun Registry API.
 * Hand-written for 9 endpoints. Served at GET /openapi.json.
 */
export function getOpenAPISchema(baseUrl = "http://localhost:4000") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Skrun API",
      version: "0.6.0",
      description: "Deploy any Agent Skill as an API. Multi-model, stateful, open source.",
      license: { name: "MIT", url: "https://github.com/skrun-dev/skrun/blob/main/LICENSE" },
    },
    servers: [{ url: baseUrl, description: "Registry server" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Authentication via Bearer token. Accepts: API key (sk_live_...), dev-token (local dev only), or session cookie (web auth).",
        },
        apiKeyAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "API key authentication. Create keys via POST /api/keys. Format: sk_live_<32hex>. Use as Bearer token.",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "NOT_FOUND" },
                message: { type: "string", example: "Agent dev/my-agent not found" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
        RunResult: {
          type: "object",
          properties: {
            run_id: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["completed", "failed"] },
            agent_version: {
              type: "string",
              pattern: "^\\d+\\.\\d+\\.\\d+$",
              description: "Resolved agent version (semver) that was executed.",
              example: "1.2.0",
            },
            output: { type: "object", additionalProperties: true },
            usage: {
              type: "object",
              properties: {
                prompt_tokens: { type: "integer" },
                completion_tokens: { type: "integer" },
                total_tokens: { type: "integer" },
              },
            },
            warnings: { type: "array", items: { type: "string" } },
            cost: {
              type: "object",
              properties: { estimated: { type: "number" } },
            },
            duration_ms: { type: "integer" },
            files: {
              type: "array",
              description: "Files produced by the agent during execution.",
              items: { $ref: "#/components/schemas/FileInfo" },
            },
            error: { type: "string" },
          },
          required: ["run_id", "status", "agent_version", "output", "usage", "cost", "duration_ms"],
        },
        FileInfo: {
          type: "object",
          properties: {
            name: { type: "string", description: "Filename", example: "report.pdf" },
            size: { type: "integer", description: "File size in bytes", example: 524288 },
            url: {
              type: "string",
              description: "Download URL (GET endpoint or presigned URL in cloud)",
              example: "/api/runs/uuid/files/report.pdf",
            },
          },
          required: ["name", "size", "url"],
        },
        AsyncRunResult: {
          type: "object",
          properties: {
            run_id: { type: "string", format: "uuid" },
            agent_version: {
              type: "string",
              pattern: "^\\d+\\.\\d+\\.\\d+$",
              description: "Resolved agent version (semver) that will be executed.",
              example: "1.2.0",
            },
          },
          required: ["run_id", "agent_version"],
        },
        VersionNotFoundResponse: {
          type: "object",
          description: "Returned when a pinned version does not exist.",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "VERSION_NOT_FOUND" },
                message: {
                  type: "string",
                  example: "Version 9.9.9 not found for acme/seo-audit",
                },
                available: {
                  type: "array",
                  items: { type: "string" },
                  description: "Up to 10 most recent versions, newest first.",
                  example: ["1.2.0", "1.1.0", "1.0.0"],
                },
              },
              required: ["code", "message", "available"],
            },
          },
          required: ["error"],
        },
        AgentMetadata: {
          type: "object",
          properties: {
            name: { type: "string" },
            namespace: { type: "string" },
            verified: { type: "boolean" },
            latest_version: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
          required: ["name", "namespace", "verified", "latest_version"],
        },
        PaginatedList: {
          type: "object",
          properties: {
            agents: { type: "array", items: { $ref: "#/components/schemas/AgentMetadata" } },
            total: { type: "integer" },
            page: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["agents", "total", "page", "limit"],
        },
        PushResult: {
          type: "object",
          properties: {
            name: { type: "string" },
            namespace: { type: "string" },
            latest_version: { type: "string" },
          },
          required: ["name", "namespace", "latest_version"],
        },
        RunEvent: {
          type: "object",
          description:
            "SSE event (one of: run_start, tool_call, tool_result, llm_complete, run_complete, run_error). The `run_start` event additionally carries `agent` and `agent_version`.",
          properties: {
            type: {
              type: "string",
              enum: [
                "run_start",
                "tool_call",
                "tool_result",
                "llm_complete",
                "run_complete",
                "run_error",
              ],
            },
            run_id: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
            agent: {
              type: "string",
              description: "Present on run_start events only. Agent identifier (namespace/name).",
            },
            agent_version: {
              type: "string",
              pattern: "^\\d+\\.\\d+\\.\\d+$",
              description: "Present on run_start events only. Resolved version being executed.",
              example: "1.2.0",
            },
          },
          required: ["type", "run_id", "timestamp"],
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          operationId: "getHealth",
          security: [],
          responses: {
            "200": {
              description: "Server is healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string", example: "ok" } },
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/run": {
        post: {
          summary: "Run an agent",
          operationId: "runAgent",
          description:
            "Execute an agent. Supports sync (default), SSE streaming (Accept: text/event-stream), and async webhook (webhook_url in body).",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    input: {
                      type: "object",
                      additionalProperties: true,
                      description: "Input fields matching agent.yaml inputs",
                    },
                    webhook_url: {
                      type: "string",
                      format: "uri",
                      description: "URL for async webhook delivery (activates async mode)",
                    },
                    version: {
                      type: "string",
                      pattern: "^\\d+\\.\\d+\\.\\d+$",
                      description:
                        "Pin a specific agent version (strict semver). Omit to target latest. Ranges (^, ~) and keywords (latest) are not supported.",
                      example: "1.2.0",
                    },
                    environment: {
                      type: "object",
                      description:
                        "Optional environment override. Fields are shallow-merged on top of the agent.yaml environment defaults. Omit to use agent defaults.",
                      properties: {
                        networking: {
                          type: "object",
                          properties: {
                            allowed_hosts: {
                              type: "array",
                              items: { type: "string" },
                              description: "Allowed outbound hosts",
                            },
                          },
                        },
                        filesystem: {
                          type: "string",
                          enum: ["none", "read-only", "read-write"],
                        },
                        secrets: {
                          type: "array",
                          items: { type: "string" },
                          description: "Secret names available to the agent",
                        },
                        timeout: {
                          type: "string",
                          pattern: "^\\d+s$",
                          description: 'Execution timeout (e.g., "300s")',
                          example: "600s",
                        },
                        max_cost: {
                          type: "number",
                          description: "Maximum estimated cost cap",
                        },
                        sandbox: {
                          type: "string",
                          enum: ["strict", "permissive"],
                        },
                      },
                    },
                  },
                  required: ["input"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Sync execution result",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RunResult" } },
                "text/event-stream": {
                  schema: { $ref: "#/components/schemas/RunEvent" },
                  description:
                    "SSE stream of RunEvent objects. Send Accept: text/event-stream to activate.",
                },
              },
            },
            "202": {
              description: "Async execution accepted (webhook mode)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AsyncRunResult" } },
              },
            },
            "400": {
              description: "Validation error",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "Agent not found, or pinned version not found. If the agent exists but the requested `version` does not, the body conforms to VersionNotFoundResponse and includes `available: string[]` (up to 10 most recent, newest first).",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      { $ref: "#/components/schemas/VersionNotFoundResponse" },
                    ],
                  },
                },
              },
            },
            "429": {
              description: "Rate limited",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "502": {
              description: "Execution failed",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "504": {
              description: "Timeout",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/push": {
        post: {
          summary: "Push an agent bundle",
          operationId: "pushAgent",
          description:
            "Upload an agent bundle (.agent tar.gz). Optionally attach a version note via X-Skrun-Version-Notes header (max 500 chars, plain text, percent-encoded UTF-8). Set by the CLI `-m/--message` flag.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            {
              name: "version",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Semver version (e.g., 1.0.0)",
            },
            {
              name: "X-Skrun-Version-Notes",
              in: "header",
              required: false,
              schema: { type: "string", maxLength: 500 },
              description:
                "Optional version note (max 500 chars, plain text, percent-encoded UTF-8). Like a git commit message.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "200": {
              description:
                "Push successful. Response may include `X-Skrun-Warning: notes-unsupported` header when the client sent notes but the server doesn't support them (version skew).",
              headers: {
                "X-Skrun-Warning": {
                  description: "Set to `notes-unsupported` on version skew. Absent otherwise.",
                  schema: { type: "string", enum: ["notes-unsupported"] },
                },
              },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PushResult" } },
              },
            },
            "400": {
              description:
                "Missing version, or INVALID_NOTES (header > 500 chars, null bytes, or malformed percent-encoding)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "Forbidden (namespace ownership)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "409": {
              description: "Version already exists",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/pull": {
        get: {
          summary: "Pull an agent bundle (latest version)",
          operationId: "pullAgent",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Agent bundle",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/pull/{version}": {
        get: {
          summary: "Pull a specific version of an agent bundle",
          operationId: "pullAgentVersion",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "version", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Agent bundle",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent or version not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents": {
        get: {
          summary: "List all agents",
          operationId: "listAgents",
          security: [],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          ],
          responses: {
            "200": {
              description: "Paginated agent list",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PaginatedList" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}": {
        get: {
          summary: "Get agent metadata",
          operationId: "getAgent",
          security: [],
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Agent metadata",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AgentMetadata" } },
              },
            },
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
        delete: {
          summary: "Delete an agent",
          operationId: "deleteAgent",
          description:
            "Permanently delete an agent and all its versions. Namespace ownership required. Past runs remain (agent_id set to null).",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Agent deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { success: { type: "boolean" } },
                    required: ["success"],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "Forbidden (not namespace owner)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/versions": {
        get: {
          summary: "List agent versions",
          operationId: "getAgentVersions",
          security: [],
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Version list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      versions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            version: { type: "string" },
                            size: { type: "integer" },
                            pushed_at: { type: "string" },
                            config_snapshot: {
                              type: "object",
                              additionalProperties: true,
                              description:
                                "Parsed agent.yaml at push time (model, tools, mcp_servers, inputs, environment). Used by the dashboard for playground form generation.",
                            },
                            notes: {
                              type: ["string", "null"],
                              maxLength: 500,
                              description:
                                "Optional note attached at push time via `skrun push -m` or the X-Skrun-Version-Notes header. Plain text, max 500 chars. Null if not provided.",
                            },
                          },
                          required: ["version", "size", "pushed_at", "notes"],
                        },
                      },
                    },
                  },
                },
              },
            },
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/verify": {
        patch: {
          summary: "Verify or unverify an agent",
          operationId: "verifyAgent",
          description: "Set the verified flag. Only verified agents can execute scripts.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { verified: { type: "boolean" } },
                  required: ["verified"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated metadata",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AgentMetadata" } },
              },
            },
            "400": {
              description: "Invalid body",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/auth/github": {
        get: {
          summary: "Initiate GitHub OAuth login",
          operationId: "authGithub",
          security: [],
          description:
            "Redirects to GitHub OAuth authorize page. Returns 404 if OAuth is not configured (local dev mode).",
          responses: {
            "302": { description: "Redirect to GitHub authorize URL" },
            "404": {
              description: "OAuth not configured",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/auth/github/callback": {
        get: {
          summary: "GitHub OAuth callback",
          operationId: "authGithubCallback",
          security: [],
          description:
            "Handles the GitHub OAuth callback. Exchanges code for token, creates/updates user, sets session cookie, redirects to dashboard.",
          parameters: [
            { name: "code", in: "query", required: true, schema: { type: "string" } },
            { name: "state", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            "302": { description: "Redirect to dashboard with session cookie set" },
            "400": {
              description: "Invalid OAuth state",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/login": {
        get: {
          summary: "Login page",
          operationId: "loginPage",
          security: [],
          description:
            'Minimal HTML login page. Shows "Sign in with GitHub" button when OAuth is configured, dev-token instructions otherwise.',
          responses: {
            "200": {
              description: "HTML login page",
              content: { "text/html": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/auth/logout": {
        post: {
          summary: "Logout",
          operationId: "authLogout",
          security: [],
          description: "Clears the session cookie and redirects to /.",
          responses: {
            "302": { description: "Redirect to /" },
          },
        },
      },
      "/api/me": {
        get: {
          summary: "Get current user info",
          operationId: "getMe",
          description:
            "Returns the authenticated user's profile. Used by the dashboard to display user info.",
          responses: {
            "200": {
              description: "User profile",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      username: { type: "string" },
                      namespace: { type: "string" },
                      email: { type: "string", nullable: true },
                      avatar_url: { type: "string", nullable: true },
                      plan: { type: "string", example: "free" },
                    },
                    required: ["id", "username", "namespace", "plan"],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/keys": {
        post: {
          summary: "Create an API key",
          operationId: "createApiKey",
          description:
            "Creates a new API key. The raw key (sk_live_...) is returned only once — store it securely.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "Human-readable key name",
                      example: "CI deploy",
                    },
                    scopes: {
                      type: "array",
                      items: { type: "string" },
                      description: "Key scopes (default: all)",
                      example: ["agent:push", "agent:run", "agent:verify"],
                    },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "API key created (key shown only once)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      key: { type: "string", example: "sk_live_a1b2c3d4e5f6..." },
                      name: { type: "string" },
                      key_prefix: { type: "string", example: "sk_live_a1b2c3d4" },
                      scopes: { type: "array", items: { type: "string" } },
                      created_at: { type: "string", format: "date-time" },
                    },
                    required: ["id", "key", "name", "key_prefix", "scopes"],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
        get: {
          summary: "List your API keys",
          operationId: "listApiKeys",
          description:
            "Returns all API keys for the authenticated user. Key hashes are never returned.",
          responses: {
            "200": {
              description: "List of API keys",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        key_prefix: { type: "string" },
                        scopes: { type: "array", items: { type: "string" } },
                        last_used_at: { type: "string", format: "date-time", nullable: true },
                        created_at: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/keys/{id}": {
        delete: {
          summary: "Revoke an API key",
          operationId: "deleteApiKey",
          description: "Permanently revokes an API key. Only the key owner can revoke it.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Key revoked" },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Key not found or not owned",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/runs/{run_id}/files/{filename}": {
        get: {
          summary: "Download a file produced by an agent run",
          operationId: "getRunFile",
          description:
            "Returns a file produced during agent execution. Files are available for a limited time after the run (default: 1 hour, configurable via FILES_RETENTION_S).",
          security: [],
          parameters: [
            {
              name: "run_id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            { name: "filename", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "File content",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "404": {
              description: "Run or file not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/stats": {
        get: {
          summary: "Dashboard stats aggregated across all agents",
          operationId: "getStats",
          description:
            "Aggregated metrics for the dashboard home page: today/yesterday totals + 7-day daily arrays.",
          responses: {
            "200": {
              description: "Aggregated stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      agents_count: { type: "integer" },
                      runs_today: { type: "integer" },
                      tokens_today: { type: "integer" },
                      failed_today: { type: "integer" },
                      runs_yesterday: { type: "integer" },
                      tokens_yesterday: { type: "integer" },
                      failed_yesterday: { type: "integer" },
                      daily_runs: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 7,
                        maxItems: 7,
                        description: "7-day array (oldest first, index 6 = today)",
                      },
                      daily_tokens: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 7,
                        maxItems: 7,
                      },
                      daily_failed: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 7,
                        maxItems: 7,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/stats": {
        get: {
          summary: "Per-agent stats with period comparison",
          operationId: "getAgentStats",
          description:
            "Per-agent metrics over a rolling window. Returns current period + previous period (for delta) + 7-day daily arrays.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            {
              name: "days",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 30, default: 7 },
              description: "Rolling window size for current + previous period",
            },
          ],
          responses: {
            "200": {
              description: "Agent stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      runs: { type: "integer" },
                      tokens: { type: "integer" },
                      failed: { type: "integer" },
                      avg_duration_ms: { type: "integer" },
                      prev_runs: { type: "integer" },
                      prev_tokens: { type: "integer" },
                      prev_failed: { type: "integer" },
                      prev_avg_duration_ms: { type: "integer" },
                      daily_runs: { type: "array", items: { type: "integer" } },
                      daily_tokens: { type: "array", items: { type: "integer" } },
                      daily_failed: { type: "array", items: { type: "integer" } },
                      daily_avg_duration_ms: { type: "array", items: { type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/runs": {
        get: {
          summary: "List recent runs",
          operationId: "listRuns",
          description: "Returns recent runs, sorted by most recent first. Supports filtering.",
          parameters: [
            {
              name: "agent_id",
              in: "query",
              required: false,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["running", "completed", "failed", "cancelled"],
              },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50, maximum: 100 },
            },
          ],
          responses: {
            "200": {
              description: "Array of runs",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
        },
      },
      "/api/runs/{id}": {
        get: {
          summary: "Get a single run by ID",
          operationId: "getRun",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Run detail with full I/O, tokens, cost, duration, model",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      agent_id: { type: ["string", "null"] },
                      agent_version: { type: "string" },
                      model: {
                        type: ["string", "null"],
                        description: 'LLM model used for this run ("provider/name")',
                      },
                      status: { type: "string" },
                      input: { type: ["object", "null"], additionalProperties: true },
                      output: { type: ["object", "null"], additionalProperties: true },
                      error: { type: ["string", "null"] },
                      usage_prompt_tokens: { type: "integer" },
                      usage_completion_tokens: { type: "integer" },
                      usage_total_tokens: { type: "integer" },
                      usage_estimated_cost: { type: "number" },
                      duration_ms: { type: ["integer", "null"] },
                      created_at: { type: "string", format: "date-time" },
                      completed_at: { type: ["string", "null"], format: "date-time" },
                    },
                  },
                },
              },
            },
            "404": {
              description: "Run not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/scan": {
        get: {
          summary: "Scan the configured SKRUN_AGENTS_DIR for importable agents",
          operationId: "scanAgents",
          description:
            "Returns a list of agent directories found at SKRUN_AGENTS_DIR with their registration status. Returns { configured: false, agents: [] } if the env var is not set.",
          responses: {
            "200": {
              description: "Scan result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      configured: { type: "boolean" },
                      agents: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            path: { type: "string" },
                            registered: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents/scan/{name}/push": {
        post: {
          summary: "Build + push an agent directly from the SKRUN_AGENTS_DIR",
          operationId: "pushScannedAgent",
          description:
            "Reads files from the scanned directory and registers the agent under the authenticated user's namespace. Version is read from the agent.yaml. Useful for importing agents from the dashboard without the CLI.",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Push successful",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PushResult" } },
              },
            },
            "400": {
              description: "SKRUN_AGENTS_DIR not configured, or agent invalid",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "Forbidden (path traversal or namespace mismatch)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
    },
  };
}
