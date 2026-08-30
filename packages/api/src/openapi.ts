/**
 * OpenAPI 3.1 schema for the Skrun Registry API.
 * Hand-written for 9 endpoints. Served at GET /openapi.json.
 */
export function getOpenAPISchema(baseUrl = "http://localhost:4000") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Skrun API",
      version: "1.0.0",
      description:
        "Deploy any Agent Skill as an API. Multi-model, stateful, multimodal, open source.",
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
                cache_read_tokens: {
                  type: "integer",
                  description:
                    "Tokens served from the provider's prompt cache. Optional — only present when the provider returned cache activity. Billed at the cached-read rate (typically 0.10× input on Anthropic / GPT-5.x / Gemini, 0.5× on Groq gpt-oss / OpenAI gpt-4o legacy). NOT included in prompt_tokens (which is the FULL-RATE residual).",
                },
                cache_write_tokens: {
                  type: "integer",
                  description:
                    "Tokens written to the provider's prompt cache. Anthropic only — other providers do not expose a separate cache write surcharge. Optional, undefined for non-Anthropic models.",
                },
              },
            },
            warnings: { type: "array", items: { type: "string" } },
            cost: {
              type: "object",
              properties: {
                estimated: {
                  type: "number",
                  description: "Total cost (USD) for this run.",
                },
                saved: {
                  type: "number",
                  description:
                    "Dollar savings (USD) produced by prompt-caching on this run, computed at write time from `cacheReadTokens × (full_input_rate - cached_rate)`. Surfaced only when > 0 (omitted otherwise). Aligned with NUMERIC(10,6) DB precision.",
                },
              },
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
              description:
                "Run-scoped download URL (existing route, kept for backward-compat). Prefer GET /api/files/:id/content via the unified namespace using `file_id`.",
              example: "/api/runs/uuid/files/report.pdf",
            },
            file_id: {
              type: "string",
              pattern: "^fil_[0-9a-f]{32}$",
              description:
                "Unified-namespace identifier for GET /api/files/{file_id}/content. Optional for backward-compat.",
              example: "fil_a1b2c3d4e5f6789012345678901234ab",
            },
          },
          required: ["name", "size", "url"],
        },
        WireFileSource: {
          oneOf: [
            {
              type: "object",
              description: "Reference an already-uploaded file by id (recommended for >4 MB).",
              properties: {
                type: { const: "file" },
                source: { const: "id" },
                file_id: { type: "string", pattern: "^fil_[0-9a-f]{32}$" },
              },
              required: ["type", "source", "file_id"],
            },
            {
              type: "object",
              description: "Inline base64 — capped at INPUT_FILES_MAX_INLINE_MB (default 4 MB).",
              properties: {
                type: { const: "file" },
                source: { const: "data" },
                media_type: { type: "string", example: "image/jpeg" },
                data: { type: "string", description: "Base64-encoded bytes" },
              },
              required: ["type", "source", "media_type", "data"],
            },
            {
              type: "object",
              description: "Public URL — fetched server-side, subject to allowed_hosts.",
              properties: {
                type: { const: "file" },
                source: { const: "url" },
                url: { type: "string", format: "uri" },
              },
              required: ["type", "source", "url"],
            },
          ],
          discriminator: { propertyName: "source" },
        },
        UploadedFileMetadata: {
          type: "object",
          properties: {
            file_id: { type: "string", pattern: "^fil_[0-9a-f]{32}$" },
            size: { type: "integer" },
            media_type: { type: "string", example: "image/jpeg" },
            purpose: { type: "string", enum: ["input", "output"] },
            expires_at: { type: "string", format: "date-time" },
          },
          required: ["file_id", "size", "media_type", "purpose"],
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
            visibility: {
              type: "string",
              enum: ["private", "public"],
              description:
                "Access control. 'private' (default) ⇒ only the owner/admin can POST /run; 'public' ⇒ any authenticated caller can. The set-path is private-only for now — PATCH /api/agents/{namespace}/{name}/visibility accepts 'private' and rejects 'public' (400 PUBLIC_VISIBILITY_DISABLED) until the marketplace.",
            },
            latest_version_verified: { type: "boolean" },
            latest_version: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
          required: ["name", "namespace", "latest_version_verified", "latest_version"],
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
      "/auth/device/code": {
        post: {
          summary: "Request a device code (CLI device-login, RFC 8628)",
          operationId: "deviceCode",
          security: [],
          description:
            "Starts the CLI device-login flow. The CLI sends a PKCE code_challenge (S256) and receives a device_code, a short user_code, and the verification URIs. The token is delivered later via the poll body, never a URL.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code_challenge"],
                  properties: {
                    code_challenge: { type: "string", description: "PKCE S256 challenge" },
                    code_challenge_method: { type: "string", enum: ["S256"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Device + user codes issued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      device_code: { type: "string" },
                      user_code: { type: "string", example: "WXYZ-3456" },
                      verification_uri: { type: "string" },
                      verification_uri_complete: { type: "string" },
                      expires_in: { type: "integer", description: "Seconds until expiry" },
                      interval: { type: "integer", description: "Minimum poll interval (seconds)" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "invalid_request — missing PKCE code_challenge",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "OAUTH_NOT_CONFIGURED — instance has no OAuth (the CLI falls back to --token)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/auth/device/token": {
        post: {
          summary: "Poll for the device-login token (CLI device-login, RFC 8628)",
          operationId: "deviceToken",
          security: [],
          description:
            "The CLI polls with its device_code and PKCE code_verifier. While pending it returns 400 with error code authorization_pending or slow_down. Once authorized and the verifier matches, it returns 200 with the sk_live token in the body (minted at poll-success).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["device_code", "code_verifier"],
                  properties: {
                    device_code: { type: "string" },
                    code_verifier: { type: "string", description: "PKCE verifier" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Authorized — the token is in the body",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: { type: "string", description: "sk_live API key" },
                      username: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Poll state or error: authorization_pending | slow_down | expired_token | invalid_grant | invalid_request",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "429": {
              description: "Too many requests — back off (treat like slow_down)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
            "Execute an agent. Run-authorized: a `private` agent (the default) runs only for its owner (or an admin) — a non-owner gets a 404 indistinguishable from a genuinely-absent agent; a `public` agent runs for any authenticated caller. Supports sync (default), SSE streaming (Accept: text/event-stream), and async webhook (webhook_url in body). Webhook mode requires the `WEBHOOK_SIGNING_KEY` env var on the server — without it the runtime refuses to deliver the callback.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            {
              name: "X-LLM-API-Key",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                'JSON map of provider → API key, e.g. {"google": "AIza...", "anthropic": "sk-ant-..."} — use your own LLM key for this run instead of the server\'s. Accepted providers: anthropic, openai, google, mistral, groq, xai. Whether callers may do this at all is set per agent by `llm_key_policy`. Pair with X-LLM-Base-URL when the agent is not yours and declares its own `model.base_url`.',
            },
            {
              name: "X-LLM-Base-URL",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                'JSON map of provider → base URL, e.g. {"deepseek": "https://api.deepseek.com/v1"} — the endpoint YOUR key for that provider belongs to. Only needed when you send X-LLM-API-Key to an agent you do not own: such an agent may declare its own `model.base_url`, and the server refuses to send your key to an endpoint you did not choose (403 CALLER_BASE_URL_NOT_CONSENTED). Compared by origin, so the path need not match; the refusal names the agent\'s origin.',
            },
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
                      description:
                        "URL for async webhook delivery (activates async mode). Production: must be HTTPS and resolve to a public address (private IPs / cloud-metadata endpoints are refused). Dev mode (NODE_ENV != production) accepts http://localhost:NNNN/... for local testing.",
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
                        "Optional environment override. Fields are shallow-merged on top of the agent.yaml environment defaults. Omit to use agent defaults. Owner/admin-only: a non-owner supplying an override (e.g. on a public agent) gets 403 ENV_OVERRIDE_FORBIDDEN.",
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
            "403": {
              description:
                "Run refused: the resolved version is not verified (AGENT_NOT_VERIFIED — applies under the `admin` verification policy; the `owner`/`disabled` policies do not gate on verification), a non-owner supplied an environment override (ENV_OVERRIDE_FORBIDDEN), the agent's caller-key policy is `creator_only` and the request carried an X-LLM-API-Key header (CALLER_KEY_NOT_ALLOWED), or the request carried an X-LLM-API-Key destined for an agent-declared `model.base_url` the caller did not name in X-LLM-Base-URL (CALLER_BASE_URL_NOT_CONSENTED — a key is only sent to an endpoint chosen by its owner; the agent's own owner, presenting a master credential, is exempt).",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "Agent not found, the caller is not authorized to run a private agent (opaque — indistinguishable from not-found), or the pinned version was not found. If the agent exists but the requested `version` does not, the body conforms to VersionNotFoundResponse and includes `available: string[]` (up to 10 most recent, newest first).",
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
          description:
            "Auth required. Returns the caller's own agents (filtered by `owner_id`) when role='user'; returns all agents instance-wide when role='admin' (dev-token in single-tenant self-host always satisfies this).",
          operationId: "listAgents",
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
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}": {
        get: {
          summary: "Get agent metadata",
          description:
            "Auth required. Returns 404 when the caller is not the owner of the agent and not an admin — indistinguishable from a genuine not-found (existence is hidden from non-privileged readers).",
          operationId: "getAgent",
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
          description:
            "Auth required. Returns 404 when the caller is not the owner and not an admin (existence hidden — same opacity pattern as the metadata route).",
          operationId: "getAgentVersions",
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
                            verified: {
                              type: "boolean",
                              description:
                                "Per-version verified flag. Set via `PATCH /api/agents/:ns/:name/versions/:version/verify` (authority governed by SKRUN_VERIFICATION_POLICY). Under the `admin` policy `POST /run` returns 403 AGENT_NOT_VERIFIED when this is false for the resolved version; `owner`/`disabled` do not gate runs on it.",
                            },
                          },
                          required: ["version", "size", "pushed_at", "notes", "verified"],
                        },
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
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/versions/{version}/verify": {
        patch: {
          summary: "Verify or unverify a version (authority per verification policy)",
          operationId: "verifyVersion",
          description:
            "Set or unset the verified flag on a specific version. The attestation authority is governed by the operator verification policy (SKRUN_VERIFICATION_POLICY): `admin` (default) ⇒ instance admins only; `owner`/`disabled` ⇒ the agent owner may attest their own agents (or an admin). Under the `admin` policy an unverified version cannot run (403 AGENT_NOT_VERIFIED); `owner`/`disabled` do not gate runs on verification. The legacy agent-level `PATCH /api/agents/:ns/:name/verify` route (v0.7.x) was removed in v0.8.0.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "version", in: "path", required: true, schema: { type: "string" } },
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
              description: "Updated version row",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      version: { type: "string" },
                      size: { type: "integer" },
                      pushed_at: { type: "string" },
                      notes: { type: ["string", "null"] },
                      verified: { type: "boolean" },
                    },
                    required: ["version", "size", "pushed_at", "notes", "verified"],
                  },
                },
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
            "403": {
              description: "Caller is not an admin",
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
      "/api/agents/{namespace}/{name}/visibility": {
        patch: {
          summary: "Set agent visibility (owner/admin)",
          operationId: "setAgentVisibility",
          description:
            "Set an agent's visibility. Only 'private' is accepted — the hosting model is private-only, so 'public' is rejected with 400 PUBLIC_VISIBILITY_DISABLED until the marketplace. 'private' ⇒ only the owner/admin can POST /run. Namespace ownership required (admin override).",
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
                  properties: { visibility: { type: "string", enum: ["private", "public"] } },
                  required: ["visibility"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated agent row",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      namespace: { type: "string" },
                      visibility: { type: "string", enum: ["private", "public"] },
                      updated_at: { type: "string", format: "date-time" },
                    },
                    required: ["id", "name", "namespace", "visibility"],
                  },
                },
              },
            },
            "400": {
              description:
                "Invalid body (visibility must be 'private' or 'public'), or 'public' was requested while the public set-path is disabled (PUBLIC_VISIBILITY_DISABLED — private-only hosting).",
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
              description: "Caller does not own the namespace and is not an admin",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found in the caller's namespace",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/llm-keys": {
        get: {
          summary: "List creator LLM keys + caller-key policy (owner/admin)",
          operationId: "listAgentLlmKeys",
          description:
            "Return the agent's caller-key policy and the presence of its creator-attached LLM keys (provider + last4 + updated_at). WRITE-ONLY — the key value is never returned. Requires a master credential (account-wide key, session, or dev-token) + namespace ownership.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Caller-key policy + key presence",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      policy: { type: "string", enum: ["open", "creator_only"] },
                      keys: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            provider: { type: "string" },
                            last4: { type: "string" },
                            updated_at: { type: "string", format: "date-time" },
                          },
                          required: ["provider", "last4"],
                        },
                      },
                    },
                    required: ["policy", "keys"],
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
              description:
                "KEY_SCOPE_FORBIDDEN (a master credential is required) or FORBIDDEN (not your namespace)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found in the caller's namespace",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/llm-keys/{provider}": {
        put: {
          summary: "Attach (or replace) a creator LLM key for a provider (owner/admin)",
          operationId: "setAgentLlmKey",
          description:
            "Encrypt and store the creator's LLM key for one provider (anthropic, openai, google, mistral, groq, xai) so callers don't need to supply their own. The key travels in the body and is never returned. Requires a master credential + namespace ownership; the server must have SKRUN_SECRETS_ENCRYPTION_KEY set, else 500 ENCRYPTION_NOT_CONFIGURED.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "provider", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { key: { type: "string" } },
                  required: ["key"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Stored — returns the provider + display last4 (never the key)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { provider: { type: "string" }, last4: { type: "string" } },
                    required: ["provider", "last4"],
                  },
                },
              },
            },
            "400": {
              description:
                "INVALID_LLM_PROVIDER (unsupported provider) or INVALID_LLM_KEY (too short) or invalid body",
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
              description: "KEY_SCOPE_FORBIDDEN or FORBIDDEN",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found in the caller's namespace",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "500": {
              description:
                "ENCRYPTION_NOT_CONFIGURED — the server has no SKRUN_SECRETS_ENCRYPTION_KEY set",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
        delete: {
          summary: "Remove a creator LLM key for a provider (owner/admin)",
          operationId: "deleteAgentLlmKey",
          description:
            "Delete the creator's LLM key for one provider. Requires a master credential + namespace ownership.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "provider", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "204": { description: "Removed (no content)" },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "KEY_SCOPE_FORBIDDEN or FORBIDDEN",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found in the caller's namespace",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/llm-key-policy": {
        put: {
          summary: "Set the caller-key policy (owner/admin)",
          operationId: "setAgentLlmKeyPolicy",
          description:
            "Set whether callers may bring their own LLM key. 'open' (default) ⇒ caller > creator > server resolution; 'creator_only' ⇒ a run carrying X-LLM-API-Key is rejected with 403 CALLER_KEY_NOT_ALLOWED. Requires a master credential + namespace ownership.",
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
                  properties: { policy: { type: "string", enum: ["open", "creator_only"] } },
                  required: ["policy"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated policy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { policy: { type: "string", enum: ["open", "creator_only"] } },
                    required: ["policy"],
                  },
                },
              },
            },
            "400": {
              description: "Invalid body (policy must be 'open' or 'creator_only')",
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
              description: "KEY_SCOPE_FORBIDDEN or FORBIDDEN",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Agent not found in the caller's namespace",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/agents/{namespace}/{name}/versions/{version}": {
        delete: {
          summary: "Delete a single version of an agent",
          operationId: "deleteAgentVersion",
          description:
            "Permanently remove one version of an agent. Returns 409 LAST_VERSION if it would leave the agent with no versions; use DELETE /api/agents/{namespace}/{name} to remove the agent entirely. Past runs referencing this version remain readable (agent_version is a text column).",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "version", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "204": {
              description: "Version deleted (no content)",
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
              description: "Agent (NOT_FOUND) or version (VERSION_NOT_FOUND) not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "409": {
              description:
                "LAST_VERSION — cannot delete the last remaining version. Use DELETE /api/agents/{namespace}/{name} for full removal.",
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
            "Returns the authenticated user's profile. Used by the dashboard to display user info and to render policy-gated controls (`role`, `verification_policy` — both read-only).",
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
                      role: { type: "string", enum: ["admin", "user"] },
                      verification_policy: {
                        type: "string",
                        enum: ["admin", "owner", "disabled"],
                        description:
                          "Operator verification policy (read-only). Governs who may attest a version and whether runs are gated on verification.",
                      },
                    },
                    required: ["id", "username", "namespace", "plan", "role"],
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
                      description:
                        'Operation scopes (default: all). Allowed: agent:run, agent:push, agent:verify. A run-only key passes ["agent:run"].',
                      example: ["agent:run", "agent:push", "agent:verify"],
                    },
                    scope_kind: {
                      type: "string",
                      enum: ["account", "agents"],
                      description:
                        "Resource binding. account (default) = the whole account; agents = restricted to the agents in `agents` (a delegated key).",
                    },
                    agents: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "When scope_kind=agents: the namespace/name agents (which you must own) the key may act on.",
                      example: ["dev/my-agent"],
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
                      scope_kind: { type: "string", enum: ["account", "agents"] },
                      agents: { type: "array", items: { type: "string" } },
                      created_at: { type: "string", format: "date-time" },
                    },
                    required: ["id", "key", "name", "key_prefix", "scopes", "scope_kind"],
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
              description:
                "KEY_SCOPE_FORBIDDEN — key management requires an account-wide API key (a delegated or run-only key cannot mint keys), or a scoped agent is not owned by the caller.",
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
                        scope_kind: { type: "string", enum: ["account", "agents"] },
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
            "403": {
              description: "KEY_SCOPE_FORBIDDEN — requires an account-wide API key.",
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
          summary: "Download a file produced by an agent run (run-scoped, backward-compat)",
          operationId: "getRunFile",
          description:
            "Run-scoped download. Kept for backward compatibility. New clients should prefer the unified GET /api/files/{id}/content using `file_id` from the run response. Requires authentication AND that the caller owns the run.",
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
            "401": {
              description: "Missing or invalid Authorization header",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "Caller is not the run owner",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
      "/api/files": {
        post: {
          summary: "Upload an input file (for use with `file`-typed agent inputs)",
          operationId: "uploadInputFile",
          description:
            "Multipart upload returning a `file_id` to reference in subsequent POST /run calls. Broad media-class allowlist at upload (image/*, application/pdf, audio/*); strict per-agent mime check happens at /run time. Default 24h retention (INPUT_FILES_RETENTION_S). Default 25 MB max (INPUT_FILES_MAX_SIZE_MB).",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Uploaded — file_id and metadata",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/UploadedFileMetadata" },
                },
              },
            },
            "400": {
              description: "INVALID_MULTIPART or MISSING_FILE",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "401": {
              description: "Missing or invalid Authorization header",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "413": {
              description: "FILE_TOO_LARGE — exceeds INPUT_FILES_MAX_SIZE_MB",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "415": {
              description:
                "MIME_NOT_ALLOWED — outside the broad upload allowlist (image/*, application/pdf, audio/*)",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/files/{id}": {
        get: {
          summary: "Get file metadata (input or output, unified namespace)",
          operationId: "getFileMetadata",
          description:
            "Requires authentication; the caller must be either the uploader (input) or the run owner (output).",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^fil_[0-9a-f]{32}$" },
            },
          ],
          responses: {
            "200": {
              description: "File metadata",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/UploadedFileMetadata" },
                },
              },
            },
            "401": {
              description: "Missing or invalid Authorization header",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "Caller is not the file owner",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "FILE_NOT_FOUND — unknown or expired file_id",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
        delete: {
          summary: "Delete an uploaded input file",
          operationId: "deleteInputFile",
          description:
            "Removes the file from storage. Requires authentication AND that the caller owns the input file. Returns 403 DELETE_OUTPUT_FORBIDDEN if the file_id refers to an agent-produced output (callers don't own outputs), or 403 FORBIDDEN if the input file belongs to another user.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^fil_[0-9a-f]{32}$" },
            },
          ],
          responses: {
            "204": { description: "Deleted" },
            "401": {
              description: "Missing or invalid Authorization header",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description:
                "DELETE_OUTPUT_FORBIDDEN — cannot delete output files; or FORBIDDEN — caller does not own the input file",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "FILE_NOT_FOUND",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/files/{id}/content": {
        get: {
          summary: "Download file binary content (input or output, unified namespace)",
          operationId: "getFileContent",
          description:
            "Requires authentication; the caller must be either the uploader (input) or the run owner (output).",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^fil_[0-9a-f]{32}$" },
            },
          ],
          responses: {
            "200": {
              description: "Binary file content with Content-Type from upload",
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "401": {
              description: "Missing or invalid Authorization header",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description: "Caller is not the file owner",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "FILE_NOT_FOUND",
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
                      cache_savings_today: {
                        type: "number",
                        description:
                          "Total dollar savings (USD) produced by prompt-caching today. Filtered by authenticated user (multi-tenancy).",
                      },
                      cache_savings_yesterday: {
                        type: "number",
                        description:
                          "Total dollar savings (USD) produced by prompt-caching yesterday.",
                      },
                      daily_cache_savings: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 7,
                        maxItems: 7,
                        description: "7-day daily savings in USD (oldest first, index 6 = today).",
                      },
                      cost_today: {
                        type: "number",
                        description: "Total estimated cost (USD) today, summed across all runs.",
                      },
                      cost_yesterday: {
                        type: "number",
                        description: "Total estimated cost (USD) yesterday.",
                      },
                      daily_cost: {
                        type: "array",
                        items: { type: "number" },
                        minItems: 7,
                        maxItems: 7,
                        description: "7-day daily cost in USD (oldest first, index 6 = today).",
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
            "Per-agent metrics over a rolling window. Returns current period + previous period (for delta) + 7-day daily arrays. Auth required. Returns 404 when the caller is not the owner and not an admin (existence hidden — same opacity pattern as the other per-agent GET routes).",
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
                      cache_savings: {
                        type: "number",
                        description:
                          "Total dollar savings (USD) produced by prompt-caching for this agent over the current period.",
                      },
                      prev_cache_savings: {
                        type: "number",
                        description:
                          "Total dollar savings (USD) for the previous period (same window length, shifted back by `days`).",
                      },
                      daily_cache_savings: {
                        type: "array",
                        items: { type: "number" },
                        description:
                          "Daily savings array (USD). Length matches the `days` query parameter (default 7).",
                      },
                      cost: {
                        type: "number",
                        description:
                          "Total estimated cost (USD) for this agent over the current period.",
                      },
                      prev_cost: {
                        type: "number",
                        description: "Total estimated cost (USD) for the previous period.",
                      },
                      daily_cost: {
                        type: "array",
                        items: { type: "number" },
                        description:
                          "Daily cost array (USD). Length matches the `days` query parameter (default 7).",
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
            "404": {
              description: "Agent not found",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
                      usage_cache_read_tokens: {
                        type: "integer",
                        description:
                          "Tokens served from the provider's prompt cache. Persisted at run completion; 0 for runs without cache activity or for failed runs.",
                      },
                      usage_cache_write_tokens: {
                        type: "integer",
                        description:
                          "Tokens written to the provider's prompt cache (Anthropic only). 0 for non-Anthropic models or runs without cache activity.",
                      },
                      usage_cache_savings_usd: {
                        type: "number",
                        description:
                          "Dollar savings (USD) produced by prompt-caching on this run. Snapshot at write time from `cacheReadTokens × (full_input_rate - cached_rate)`. Aligned with NUMERIC(10,6) precision; 0 for failed runs (no partial accounting).",
                      },
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
