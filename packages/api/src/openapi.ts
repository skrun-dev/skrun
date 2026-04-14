/**
 * OpenAPI 3.1 schema for the Skrun Registry API.
 * Hand-written for 9 endpoints. Served at GET /openapi.json.
 */
export function getOpenAPISchema(baseUrl = "http://localhost:4000") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Skrun API",
      version: "0.2.0",
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
          description: 'Authentication token. Use "dev-token" in dev mode.',
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
            error: { type: "string" },
          },
          required: ["run_id", "status", "output", "usage", "cost", "duration_ms"],
        },
        AsyncRunResult: {
          type: "object",
          properties: {
            run_id: { type: "string", format: "uuid" },
          },
          required: ["run_id"],
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
            "SSE event (one of: run_start, tool_call, tool_result, llm_complete, run_complete, run_error)",
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
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
          ],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "200": {
              description: "Push successful",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PushResult" } },
              },
            },
            "400": {
              description: "Missing version",
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
                          },
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
    },
  };
}
