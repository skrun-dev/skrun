import { API_KEY_PREFIX } from "./auth/api-key.js";

/**
 * OpenAPI 3.1 schema for the Skrun Registry API.
 * Hand-written for 9 endpoints. Served at GET /openapi.json.
 */
export function getOpenAPISchema(baseUrl = "http://localhost:4000") {
  /** The wait a refusal asks for. */
  const retryAfter = {
    description:
      "Seconds to wait before sending again. On RATE_LIMITED, until X-RateLimit-Reset (rounded to whole seconds, so up to one more than the window). On a quota refusal: 10 for CONCURRENCY_LIMIT_REACHED, until the window renews for COMPUTE_QUOTA_EXCEEDED, 5 for CAPACITY_EXHAUSTED, until the account holds fewer uploads than its plan allows for INPUT_FILES_LIMIT_REACHED — its oldest upload's expiry, unless it holds more than its plan allows. 3 for PUSH_BUSY.",
    schema: { type: "integer", minimum: 0 },
  };
  /** A push's 503: as many agent.yaml reads waiting as a push may wait behind. */
  const pushBusy =
    "PUSH_BUSY — the server process already has as many agent.yaml reads waiting as it lets a push wait behind: it reads at most two at once — a push's, or a run's first read of a bundle —, and a push that finds 16 waiting is refused, a fixed bound of every server, no setting. Refused at once, before anything is stored, with Retry-After: 3 — send it again then. The server's state, not a fault of the bundle: only files slow to read fill the line, an ordinary agent.yaml reads in a few milliseconds; a run's read is never refused so. A push whose client hangs up while it waits leaves its place, its file never read and nothing stored.";
  /**
   * An account's numbers, on a run's responses: to a full-access credential
   * only, for a run counted against an account, for each bound the server sets.
   */
  const quotaHeaders = {
    "X-Quota-Runs-Limit": {
      description:
        "The account's runs in progress allowed by its plan. Sent to a full-access credential (a session, the dev token, or an account-wide API key with every operation) when the server sets that bound; never to any other key.",
      schema: { type: "integer" },
    },
    "X-Quota-Runs-Remaining": {
      description:
        "The account's places left: on an admitted run, once it holds its own; on a refusal, what was left (0 when that bound refused it).",
      schema: { type: "integer", minimum: 0 },
    },
    "X-Quota-Compute-Limit": {
      description:
        "The account's compute seconds per window. Sent to a full-access credential when the server sets that bound.",
      schema: { type: "integer" },
    },
    "X-Quota-Compute-Remaining": {
      description:
        "The whole compute seconds left in the current window, as read when the run was checked — its own time not counted yet.",
      schema: { type: "integer", minimum: 0 },
    },
    "X-Quota-Compute-Reset": {
      description:
        "When the current window ends, in Unix seconds (the form of X-RateLimit-Reset). Windows are fixed and aligned on UTC.",
      schema: { type: "integer" },
    },
    "X-Quota-Fast-Runs-Limit": {
      description:
        "The account's fast runs per rolling hour: its runs entitled to a ready machine of the server's pre-warm pool. Sent to a full-access credential only while such a pool runs and the server sets that bound; 0 for a plan that includes none. A run past them is never refused: it starts on a new machine, about a minute slower.",
      schema: { type: "integer", minimum: 0 },
    },
    "X-Quota-Fast-Runs-Remaining": {
      description:
        "The fast runs left in the rolling hour: on an admitted run, once its own right is counted; on a refusal, what was left. Not sent for a plan that includes none: its limit, 0, says so. The admission's figure: a right still held then and given back after this header has left — this run's, once its machine is ready if no pooled machine was taken for it, or another of the account's runs' — is not in it, so it can be low by one for each such right; as of its admission, it is never high. GET /api/usage has the current figure.",
      schema: { type: "integer", minimum: 0 },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Skrun API",
      version: "2.0.0",
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
          description: `Authentication via Bearer token. Accepts: API key (${API_KEY_PREFIX}...), dev-token (local dev only), or session cookie (web auth).`,
        },
        apiKeyAuth: {
          type: "http",
          scheme: "bearer",
          description: `API key authentication. Create keys via POST /api/keys. Format: ${API_KEY_PREFIX} followed by 36 characters of 0-9A-Za-z, 45 in all: 30 random characters, then a 6-character checksum of them. The checksum is the CRC-32 (IEEE, as zlib computes it) of the 30 characters taken as ASCII bytes, written in base62 (digits, then A-Z, then a-z), most significant digit first, left-padded with 0 to 6 characters. Use as Bearer token.`,
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
            files_excluded: { $ref: "#/components/schemas/FilesExcluded" },
            error: { type: "string" },
          },
          required: [
            "run_id",
            "status",
            "agent_version",
            "output",
            "usage",
            "cost",
            "duration_ms",
            "files_excluded",
          ],
        },
        FilesExcluded: {
          type: "object",
          description:
            "How many of the run's output files are not in `files`, by reason — counts only, never a file name. A reason that left no file out is omitted: `{}` when every file was kept, and on a failed run. Always present. Each file left out is counted once, under the first reason that applies, in this order: its name, its size, the count; then, on the cloud runtime, its transfer.",
          properties: {
            name_refused: {
              type: "integer",
              minimum: 1,
              description:
                "Files whose name is not a plain relative path: empty, absolute, with a backslash, an empty, `.` or `..` segment, a control character, or more than 512 bytes of UTF-8.",
            },
            too_large: {
              type: "integer",
              minimum: 1,
              description: "Files larger than the size limit (`FILES_MAX_SIZE_MB`).",
            },
            over_count: {
              type: "integer",
              minimum: 1,
              description:
                "Files past the count limit (`FILES_MAX_COUNT`), the files being taken in path order.",
            },
            pull_failed: {
              type: "integer",
              minimum: 1,
              description:
                "Cloud runtime only: files that could not be read from the run's machine.",
            },
            upload_budget: {
              type: "integer",
              minimum: 1,
              description:
                "Cloud runtime only: files not stored because the upload of the run's output files ran out of time — the file under way and those after it. The run still completes, with the files stored before.",
            },
          },
          example: { too_large: 1 },
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
              description:
                "Inline base64 — capped at 4 MB per piece (fixed). All of a request's inline pieces share the run's body cap (about 6.33 MB): about 4.7 MB of them when the rest of the request is small.",
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
                "Access control. 'private' (default) ⇒ only the owner/admin can POST /run; 'public' ⇒ any authenticated caller can. The set-path is private-only for now — PATCH /api/agents/{namespace}/{name}/visibility accepts 'private' and rejects 'public' (400 PUBLIC_VISIBILITY_DISABLED) for now.",
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
            files_excluded: {
              $ref: "#/components/schemas/FilesExcluded",
              description:
                "Present on run_complete events, always: how many of the run's output files were left out, by reason, as in the synchronous result.",
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
            "413": {
              description:
                "REQUEST_TOO_LARGE — the request body exceeds SKRUN_MAX_BODY_MB (default 1 MB). The message names the cap.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "429": {
              description:
                "RATE_LIMITED — more than 120 requests to /auth/device/* from the same client address in the 60-second window. X-RateLimit-Limit / -Remaining / -Reset are on every response.",
              headers: { "Retry-After": retryAfter },
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
            "The CLI polls with its device_code and PKCE code_verifier. While pending it returns 400 with error code authorization_pending or slow_down. Once authorized and the verifier matches, it returns 200 with the API key in the body (minted at poll-success).",
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
                      token: { type: "string", description: `API key (${API_KEY_PREFIX}...)` },
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
            "413": {
              description:
                "REQUEST_TOO_LARGE — the request body exceeds SKRUN_MAX_BODY_MB (default 1 MB). The message names the cap.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "429": {
              description:
                "RATE_LIMITED — too many requests to /auth/device/* from the same client address (120 in the 60-second window): back off (treat like slow_down), for the seconds Retry-After gives.",
              headers: { "Retry-After": retryAfter },
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
            "Execute an agent. Run-authorized: a `private` agent (the default) runs only for its owner (or an admin) — a non-owner gets a 404 indistinguishable from a genuinely-absent agent; a `public` agent runs for any authenticated caller. Supports SSE streaming (Accept: text/event-stream), async webhook (webhook_url in body), and — on the local runtime only — sync, the default for a request that asks for neither, answered with the run's result. The flyio runtime refuses a synchronous request 400 SYNC_MODE_UNSUPPORTED before the run starts, nothing of it written: read the event stream or send a webhook_url instead. The body's input field is required: a body without one is refused 400 INVALID_REQUEST. Webhook mode requires the `WEBHOOK_SIGNING_KEY` env var on the server — without it the runtime refuses to deliver the callback.",
          parameters: [
            { name: "namespace", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            {
              name: "X-LLM-API-Key",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                'JSON map of provider → API key, e.g. {"google": "AIza...", "anthropic": "sk-ant-..."} — use your own LLM key for this run instead of the server\'s. Accepted providers: those agent.yaml knows — anthropic, openai, google, mistral, groq, xai, and meta for an agent that declares `model.base_url`, the one endpoint a meta key is sent to. Whether callers may do this at all is set per agent by `llm_key_policy`. Pair a key for the provider of the agent\'s primary model with X-LLM-Base-URL when the agent is not yours and declares its own `model.base_url`.',
            },
            {
              name: "X-LLM-Base-URL",
              in: "header",
              required: false,
              schema: { type: "string" },
              description:
                "JSON map of provider → base URL, e.g. {\"openai\": \"https://api.deepseek.com/v1\"} — the endpoint YOUR key for that provider belongs to. Only needed when you send X-LLM-API-Key to an agent you do not own: such an agent may declare its own `model.base_url`, and the server refuses to send your key to an endpoint you did not choose (403 CALLER_BASE_URL_NOT_CONSENTED). Only your key for the provider of the agent's primary model is sent there — a fallback model is always called at its own provider's endpoint — so a key for a fallback on another provider needs none. On an agent you do not own, every entry, sent with X-LLM-API-Key or alone, must be where that provider's key goes: the agent's origin for the provider of its primary model when it declares a `model.base_url`, and none for any other provider, or on an agent that declares no `model.base_url` — any other entry is refused the same way. Compared by origin, so the path need not match; the refusal names the agent's origin.",
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
                        "Optional environment override. Fields are shallow-merged on top of the agent.yaml environment defaults. Omit to use agent defaults. Owner/admin-only: a non-owner supplying an override (e.g. on a public agent) gets 403 ENV_OVERRIDE_FORBIDDEN. A field retired from agent.yaml (sandbox, filesystem) is refused with 400 RETIRED_FIELD. The override is then judged as sent, before the bundle is pulled: a secrets list that names a secret is refused with 400 UNSUPPORTED_FIELD — no secret is injected into a run —, and a timeout outside 1s to 2147483s with 400 TIMEOUT_OUT_OF_RANGE. The merged environment is validated as an agent.yaml's is: an invalid field — a timeout not written Ns, a networking that is not an object — is refused with 400 INVALID_ENVIRONMENT, naming each field.",
                      properties: {
                        networking: {
                          type: "object",
                          properties: {
                            allowed_hosts: {
                              type: "array",
                              items: { type: "string" },
                              description:
                                'Allowed outbound hosts. "*" allows every public address. On the flyio runtime, an entry the sandbox cannot enforce — anything but "*", a host name (letters, digits, dots, hyphens and underscores) or an IPv6 literal, bare or in brackets — is refused with 400 EGRESS_HOST_UNSUPPORTED; of those, a host pattern (*.slack.com) is honoured by the local runtime, any other form by no runtime.',
                            },
                          },
                        },
                        timeout: {
                          type: "string",
                          pattern: "^\\d+s$",
                          description:
                            'Execution timeout (e.g., "300s"), between 1s and 2147483s: a value outside is refused with 400 TIMEOUT_OUT_OF_RANGE. On a server that sets a longest timeout, a value above it is refused with 400 TIMEOUT_ABOVE_LIMIT.',
                          example: "600s",
                        },
                        max_cost: {
                          type: "number",
                          description: "Maximum estimated cost cap",
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
              description:
                "Sync execution result, or the opening of the event stream. On a server that sets quotas, it carries the account's numbers (X-Quota-*) to a full-access credential, its own place counted — and, while the server's pre-warm pool runs, its own right to a fast run.",
              headers: quotaHeaders,
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
              description:
                "Async execution accepted (webhook mode). Carries the account's numbers (X-Quota-*) as the 200 does.",
              headers: quotaHeaders,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/AsyncRunResult" } },
              },
            },
            "400": {
              description:
                "Validation error. First, INVALID_REQUEST: the body is not valid JSON; or it is not a JSON object with an input field — a body that is not an object, an object with no input ({} included), or an input that is null —, refused first of all once the body is read, the message naming input: the whole body is never taken for the input. Then SYNC_MODE_UNSUPPORTED, on the flyio runtime only: a request with neither an Accept: text/event-stream header nor a webhook_url (an empty webhook_url is none) — that runtime runs an agent through its event stream or a webhook, never as one response. It is refused after the checks of the body's shape, before any key header, the agent, its inputs, the environment override's settings, the quota or the bundle is read: no run is written, and an agent that does not exist gets the same 400, never a 404. The message names what works: the event stream (skrun run and the SDK's client.run() read it, and return the one-shot result), or a webhook_url. Or no model key for either of the agent's models (LLM_KEY_REQUIRED — neither the primary provider nor the fallback's has an X-LLM-API-Key entry, a creator key attached to the agent, or a server key; a meta model without a model.base_url, from a version published before a push refused one, counts as having none, whatever key is given). A run that no model could serve is refused before it starts, in every response mode the runtime serves: before any event stream opens, and instead of a 202 for a webhook run. A fallback model without a key does not refuse the run, and a run whose primary has no key but whose fallback has one is accepted and served by the fallback. Also RETIRED_FIELD: the environment override carries a field that was retired from agent.yaml (environment.sandbox, environment.filesystem) — refused, never ignored, before any run work. Then UNSUPPORTED_FIELD and TIMEOUT_OUT_OF_RANGE: the environment override, judged as sent — not as merged into the agent's —, carries a secrets list that names a secret, or a timeout outside 1s to 2147483s — refused before the bundle is pulled and before a server's longest timeout is checked, no run written; the code is the first one's, the message names each. A version whose own agent.yaml declares such a setting, published before a push refused it, is not refused at run. And EGRESS_HOST_UNSUPPORTED, on the flyio runtime only: allowed_hosts, after the environment override, holds an entry the sandbox cannot enforce — anything but \"*\", a host name or an IPv6 literal, a host pattern (*.slack.com) and a host with a port among them — refused before the run starts, before any machine; the message names each entry by its form and says what to write instead. INVALID_ENVIRONMENT: the environment override is not an object, or the agent's environment once the override is merged is invalid (a timeout not written Ns, a networking that is not an object…) — the message names each field. TIMEOUT_ABOVE_LIMIT, on a server that sets a longest timeout: the agent, or the run's environment override, declares a timeout above it (an agent that declares none runs up to the 300 s default) — refused before any machine starts, before the bundle is pulled when the version's recorded configuration declares it and no override is sent; the message gives both values. No Retry-After: waiting changes nothing. INVALID_INPUT_TYPE: an input field of the wrong type, an input that is not an object (a string, a number or a boolean — the message names the type received), or an input nested more than 100 levels deep (objects and arrays inside one another, the input itself the first level; the message names the bound) — the latter two refused right after the body's own refusals (INVALID_REQUEST), before anything of the agent is read or of the run written. INVALID_INPUT_TYPE too: an element of a file input that is not a file source — the message names the field and the element, never the value sent.",
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
                "Run refused: the resolved version is not verified (AGENT_NOT_VERIFIED — applies under the `admin` verification policy; the `owner`/`disabled` policies do not gate on verification), a non-owner supplied an environment override (ENV_OVERRIDE_FORBIDDEN), the agent's caller-key policy is `creator_only` and the request carried an X-LLM-API-Key header (CALLER_KEY_NOT_ALLOWED), or the request carried X-LLM-API-Key or X-LLM-Base-URL and either held a key for the provider of the agent's primary model — the one key sent to an agent-declared `model.base_url`, which a fallback on the same provider uses too — without naming that endpoint in X-LLM-Base-URL, or named there an origin that is not where that provider's key goes, whatever keys it held: for the provider of the agent's primary model, an origin other than the agent's; for any other provider, any origin (CALLER_BASE_URL_NOT_CONSENTED — a key is only sent to an endpoint chosen by its owner; a key for a fallback on another provider is never sent there; an agent with no `model.base_url` has no origin to name, for any provider; the agent's own owner, presenting a master credential, is exempt).",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "Agent not found, the caller is not authorized to run a private agent (opaque — indistinguishable from not-found), or the pinned version was not found. If the agent exists but the requested `version` does not, the body conforms to VersionNotFoundResponse and includes `available: string[]` (up to 10 most recent, newest first). Also FILE_NOT_FOUND: a file input by file_id that names an unknown or expired upload, or one the caller may not use — another account's, or, for a key without full access, another key's (the same answer), refused before the model is called.",
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
            "413": {
              description:
                "REQUEST_TOO_LARGE — the request body exceeds the run's cap, about 6.33 MB (6,640,982 bytes): the base64 size of 4 MB, plus 1 MB. It bounds the sum of a request's inline files (source: data) together with the rest of the request — about 4.7 MB of inline files when the rest is small; the message names the cap. Judged on a declared Content-Length before anything is read; a body without one is counted as it is read, after authentication, and this 413 replaces the 400 INVALID_REQUEST of an unreadable body. Also INLINE_TOO_LARGE (one inline file decodes to more than 4 MB) and MAX_COUNT_EXCEEDED (a file input has more elements than its max_count).",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "422": {
              description:
                "BUNDLE_DECOMPRESSED_TOO_LARGE — the agent's stored version decompresses to more than BUNDLE_MAX_DECOMPRESSED_MB (default 50 MB), what this server now unpacks, its tar headers counted: a version pushed under a higher cap — this server's, since lowered, or another instance's — or stored by a server that did not refuse it at push. The code a push of such a bundle is refused with (413). Answered once the version's bundle is read, before the run starts, in every response mode the runtime serves — before any event stream opens, and instead of a 202 for a webhook run —, nothing of the run written. The server stops unpacking at the cap: the message names the agent and its version, says it decompresses to more than the cap, and says who can act — its creator, by pushing a smaller version, or the server's operator, by raising BUNDLE_MAX_DECOMPRESSED_MB.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "429": {
              description:
                "RATE_LIMITED — more than 60 runs from the same client address in the 60-second window, refused before the agent runs; X-RateLimit-Limit / -Remaining / -Reset are on every response. On a server that sets quotas, also CONCURRENCY_LIMIT_REACHED — the account already has as many runs in progress as its plan allows (Retry-After: 10) — and COMPUTE_QUOTA_EXCEEDED — the account used its plan's compute time for the current window (Retry-After: until the window renews). A run is counted against the account of the credential that sends it. Nothing of a refused run is written. A full-access credential is told the account's numbers, in the message and in X-Quota-* headers; any other key gets the same code and Retry-After, and is told that the account reached a usage limit, never its numbers.",
              headers: { "Retry-After": retryAfter, ...quotaHeaders },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "500": {
              description:
                "The run cannot start on this server. Each code below is answered as JSON before the run starts, nothing of it written. BUNDLE_CORRUPT: the stored bundle could not be extracted — it is not a readable archive; one an entry of which cannot be written out (two entries that contradict each other, a name too long), stored before the push refused it; or, on the local runtime, a file or directory of it could not be written out: a full disk, a permission; the server's log says which. MISSING_CONFIG: the stored bundle has no agent.yaml at its root, or an empty one; INVALID_CONFIG: its agent.yaml is not YAML, declares a YAML version other than 1.2, holds a YAML alias or the tag !!omap, the schema refuses it, or the server takes longer than 2 s to read it (read once for as long as the server keeps the bundle in its run cache) — both a bundle stored by a server that did not refuse it at push. BUNDLE_NOT_FOUND: the version's bundle is missing from storage. BUNDLE_INTEGRITY_FAILED: the stored bundle does not match the checksum recorded when it was pushed. CREATOR_KEY_UNREADABLE: a model key the agent's owner attached cannot be decrypted on this server. An error the route does not handle is answered 500 too, at whatever point it happens — once the run is recorded included —, with a plain-text body, Internal Server Error.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
                "text/plain": { schema: { type: "string" } },
              },
            },
            "502": {
              description:
                "Execution failed. EXECUTION_FAILED — synchronous mode, on the local runtime: the agent's execution failed, and its row reads failed. Also MCP_CONNECT_FAILED, on the local runtime: an MCP server the agent declares could not be connected to — answered in every response mode, before the run's row is written. Its message and the location of its details name a remote server by its origin only — its scheme, host and port, never its path, its query or its credentials —, a server whose URL has no origin by the words \"a URL with no origin\", and a local (stdio) server by its command, without its arguments. Also URL_FETCH_FAILED, on both runtimes: a file input given by source: url could not be fetched, or its server answered a status other than 2xx — answered before the run's row is written; the message names the URL.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "503": {
              description:
                "SERVER_STOPPED — synchronous mode: the run did not finish, because the server stopped while it was in progress (a deploy, a restart). Its row reads failed, with the error \"The server stopped while this run was in progress.\" Running it again makes sense, but its tools may already have run. A streamed run ends instead with a run_error of this code, and a webhook delivery carries it as error.code. In every mode, also the answer to a run sent once the server's stop has begun — on a connection kept alive across it: refused before it starts, with the message \"The server is stopping and did not start this run; send it again.\" and the connection closed. Nothing of it ran and no row was written: sending it again to a server that runs is safe. A run whose row was being written as the stop began is not started either: it is answered the same way, with the stop's error its row reads. On a server that sets quotas, also CAPACITY_EXHAUSTED — the server holds as many runs at once as its operator allows, every account's together, or, for a run that a bound on runs in progress, compute time or fast runs applies to, the database did not answer its admission in time once the admission held its database connection (a lock, a statement or the transaction left idle past its bound, or the connection gone silent): Retry-After: 5, nothing of the run is written; a full-access credential gets the account's X-Quota-* headers beside it, except when the admission was not answered in time.",
              headers: { "Retry-After": retryAfter, ...quotaHeaders },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "504": {
              description:
                'Timeout — synchronous mode. TIMEOUT: the agent\'s execution timed out. DEADLINE_EXCEEDED: the run was still in progress at its deadline — its timeout, plus the time its machine may take to get ready and its outputs to upload — and the server stopped it; its row reads failed, with the error "This run was still in progress at its deadline — its timeout, plus the time its machine may take to get ready and its outputs to upload — and was stopped." A streamed run ends instead with a run_error of this code — or, its client no longer reading, its stream is closed ten seconds after the deadline —, and a webhook delivery carries it as error.code.',
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
                "Missing version, or INVALID_NOTES (header > 500 chars, null bytes, or malformed percent-encoding). INVALID_VERSION_FORMAT: a version that is not strict semver (three whole numbers separated by dots, as a run's version) — refused before the bundle is read, nothing stored, the value not quoted. A bundle that does not load, whatever bounds the server sets — BUNDLE_CORRUPT: not a readable .agent archive (a gzip-compressed tar), or one an entry of which cannot be written out where an agent runs — a path that holds .., a name over 255 bytes between two /, a path over 1,024 bytes, a file with no name or a NUL in a name, two entries that contradict each other (a file x and an entry x/y, or one path both a file and a directory), a character or block device, a hard link with no file before it in the archive (its target absent, placed after it, or a directory) —, the entry named; only / separates a path's names; MISSING_CONFIG: no agent.yaml at the archive's root, or an empty one; INVALID_CONFIG: an agent.yaml that is not YAML, that declares a YAML version other than 1.2, that holds a YAML alias or the tag !!omap, or that the schema refuses, the message naming each issue — or one the server takes longer than 2 s to read, a fixed budget of every server: the read is stopped, and the message says the file is too complex to read, nothing of its content —, judged once agent.yaml is within its 128 KB (413 CONFIG_TOO_LARGE otherwise) — the codes a run answers for such a bundle, judged first, once the bundle decompresses within the server's cap (413 BUNDLE_DECOMPRESSED_TOO_LARGE otherwise): before the duplicate check, before anything is stored (no agent created, no object written, no version). Then INVALID_CONFIG for a configuration that holds U+0000 or a lone surrogate (half of a UTF-16 pair without its other half), in a value or a key — a Postgres database stores neither in a version's configuration —, the message naming the first field that holds one, never its text: whatever bounds the server sets, before the duplicate check, before anything is stored. Then a setting of the bundle's agent.yaml that no code honours, whatever bounds the server sets — UNSUPPORTED_FIELD: an MCP server's auth other than none, or a secrets list that names a secret; MODEL_BASE_URL_REQUIRED: meta as the model's provider without a model.base_url, or as the fallback's provider; TIMEOUT_OUT_OF_RANGE: a timeout outside 1s to 2147483s — before the server's longest timeout, before the duplicate check, before anything is stored. The code is the first such setting's; the message names each, in the words of validation. TIMEOUT_ABOVE_LIMIT, on a server that sets a longest timeout: the bundle's agent.yaml declares a timeout above it (an agent that declares none runs up to the 300 s default) — before anything is stored; the message gives both values. No Retry-After: waiting changes nothing.",
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
              description:
                "VERSION_EXISTS — the version is already pushed; answered before the account's storage is checked, nothing stored",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "413": {
              description:
                "BUNDLE_TOO_LARGE — the request body (the compressed bundle) exceeds the server cap set by SKRUN_PUSH_MAX_BODY_MB (default 50 MB). Judged on a declared Content-Length before anything is read; a body without one is counted as it is read, after authentication, and refused at the first chunk past the cap. A different ceiling from BUNDLE_MAX_DECOMPRESSED_MB, which bounds what the archive expands to. BUNDLE_DECOMPRESSED_TOO_LARGE — the bundle decompresses to more than BUNDLE_MAX_DECOMPRESSED_MB (default 50 MB), what this server unpacks: what is counted is the unpacked archive, its tar headers included. Judged on the bundle alone, before anything else of it, whatever bounds the server sets: before the duplicate check, before anything is stored. The server stops unpacking at the cap, so it never knows the bundle's full size: the message says it decompresses to more than the cap, names the setting, and says what to do. CONFIG_TOO_LARGE — the bundle's agent.yaml weighs more than 128 KB (131,072 bytes), a fixed limit of every server, no setting: agent.yaml holds the agent's configuration, and long content belongs in SKILL.md, AGENTS.md or other files of the bundle. Judged on the file's bytes once the bundle loads and agent.yaml is found — after BUNDLE_CORRUPT and MISSING_CONFIG, before INVALID_CONFIG: the file is never parsed —, whatever bounds the server sets, before anything is stored; the message gives its size and the limit, each to the byte. A run never judges it: a version stored before this limit runs as it did. Also STORAGE_QUOTA_EXCEEDED, on a server that bounds an account's bundle storage: the bundles the account's agents hold, this one included, would exceed its plan's — refused before anything is stored, no agent created and no object written. A full-access credential is told what the account holds and the cap; any other key, the bound alone. A deleted version makes room — or, for an agent's last version, the deleted agent; no Retry-After. A version already pushed is answered 409 first: it adds nothing.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "429": {
              description:
                "RATE_LIMITED — more than 10 pushes from the same client address in the 60-second window. X-RateLimit-Limit / -Remaining / -Reset are on every response.",
              headers: { "Retry-After": retryAfter },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "503": {
              description: pushBusy,
              headers: { "Retry-After": retryAfter },
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused. Checked after the ownership check: an agent of another account still answers the opaque 404, unless the caller is an instance admin on a full-access credential.",
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused. Checked after the ownership check: an agent of another account still answers the opaque 404, unless the caller is an instance admin on a full-access credential.",
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
            "Auth required. Returns the caller's own agents (filtered by `owner_id`); returns all agents instance-wide when the caller is an admin (role='admin') on a full-access credential — a session, the dev token, or an account-wide API key that carries every operation (dev-token in single-tenant self-host always satisfies this). An admin's account-wide key with fewer operations lists the admin's own agents only.",
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — not available to a resource-scoped API key (a key restricted to some agents): such a key cannot list the account's agents.",
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — a resource-scoped API key (a key restricted to some agents) reads the metadata of its own agents only: another agent of the account is refused. Checked after the ownership check: an agent of another account still answers the opaque 404, unless the caller is an instance admin on a full-access credential.",
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
            "Auth required. Returns 404 when the caller is not the owner and not an admin (existence hidden — same opacity pattern as the metadata route). Each version carries config_snapshot only for a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify); an account-wide key with fewer operations (a run-only key) gets the same list with the field absent. A key restricted to some agents is refused with 403.",
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
                                "Parsed agent.yaml at push time (model, tools, mcp_servers, inputs, environment). Used by the dashboard for playground form generation. Absent (not null) for a key without full access.",
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — not available to a resource-scoped API key (a key restricted to some agents). Checked after the ownership check: an agent of another account still answers the opaque 404, unless the caller is an instance admin on a full-access credential.",
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
            "Set or unset the verified flag on a specific version. The attestation authority is governed by the operator verification policy (SKRUN_VERIFICATION_POLICY): `admin` (default) ⇒ instance admins only; `owner`/`disabled` ⇒ the agent owner may attest their own agents (or an admin). An admin attests beyond their own agents on a full-access credential only; an admin's restricted or delegated key is held to the policy like any key of their account. Under the `admin` policy an unverified version cannot run (403 AGENT_NOT_VERIFIED); `owner`/`disabled` do not gate runs on verification. The answer is the version, with its config_snapshot only for a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify), as in the versions list. The legacy agent-level `PATCH /api/agents/:ns/:name/verify` route (v0.7.x) was removed in v0.8.0.",
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
                      config_snapshot: {
                        type: "object",
                        additionalProperties: true,
                        description:
                          "Parsed agent.yaml at push time, as in the versions list. Absent (not null) for a key without full access.",
                      },
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
              description:
                "FORBIDDEN — the verification policy does not let the caller attest this agent: under `admin`, only an admin with full access (a session, the dev token, or an account-wide API key that carries every operation); under `owner`/`disabled`, the agent's owner as well. The message names the credential an admin needs. KEY_SCOPE_FORBIDDEN — the key lacks agent:verify, or is restricted to other agents.",
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
            "Set an agent's visibility. Only 'private' is accepted — the hosting model is private-only, so 'public' is rejected with 400 PUBLIC_VISIBILITY_DISABLED for now. 'private' ⇒ only the owner/admin can POST /run. Namespace ownership required (admin override).",
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
            "Encrypt and store the creator's LLM key for one provider agent.yaml knows (anthropic, openai, google, mistral, groq, xai, meta — a meta key is sent to the agent's `model.base_url`, the one endpoint a meta model has) so callers don't need to supply their own. The key travels in the body and is never returned. Requires a master credential + namespace ownership; the server must have SKRUN_SECRETS_ENCRYPTION_KEY set, else 500 ENCRYPTION_NOT_CONFIGURED.",
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
            "Handles the GitHub OAuth callback: exchanges the code for a token, creates or " +
            "updates the user, and sets the session cookie. Where the browser goes next is " +
            "decided by this server's configuration and never by a request parameter — the " +
            "dashboard by default, or, when a session cookie domain is set, the configured path " +
            "on the site's origin, its root by default. A login that does not complete comes back to that same " +
            "destination carrying an opaque `login` marker: `failed` for any problem with the " +
            "handshake or the token exchange (the causes are deliberately indistinguishable), " +
            "`denied` when the account is not allowed on this instance. Neither marker names " +
            "the account or the cause. With no destination configured, those cases keep the " +
            "JSON and HTML responses below instead. `code` and `state` are present on the " +
            "nominal return only: a user who cancels at GitHub comes back without them, and " +
            "that request takes the failure exit.",
          parameters: [
            { name: "code", in: "query", required: false, schema: { type: "string" } },
            { name: "state", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "302": {
              description:
                "Redirect to the configured destination — the configured path on the site's " +
                "origin, its root by default — or to the dashboard when no session cookie domain " +
                "is configured. A successful login adds no query parameter; a failed or refused " +
                "one adds `login=failed` or `login=denied`.",
            },
            "400": {
              description:
                "Invalid or missing OAuth state — only when no return destination is configured",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description:
                "The GitHub account is not allowed to sign in on this instance. A generic HTML " +
                "page that never echoes the account — only when no return destination is " +
                "configured.",
              content: { "text/html": { schema: { type: "string" } } },
            },
            "500": {
              description:
                "OAUTH_FAILED — the token exchange or profile fetch failed. The message is " +
                "generic; the detail goes to the server's logs. Only when no return destination " +
                "is configured.",
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
            'Minimal HTML login page. Shows "Sign in with GitHub" button when OAuth is configured, dev-token instructions otherwise. When the operator configured a sign-in page of their own, answers a temporary redirect to it instead — whether or not OAuth is configured, and carrying nothing of the request. When the operator configured a terms or a privacy policy address, the page shows a line naming them under the GitHub button.',
          responses: {
            "200": {
              description: "HTML login page",
              content: { "text/html": { schema: { type: "string" } } },
            },
            "302": {
              description:
                "When the operator configured a sign-in page: a redirect to that page, in the form the server validated at start. Nothing of the request is carried over.",
            },
          },
        },
      },
      "/auth/logout": {
        post: {
          summary: "Logout",
          operationId: "authLogout",
          security: [],
          description:
            "Signs the browser out. Destroys the session server-side and clears the session " +
            "cookie on every scope it may hold — both the host-only cookie and, where a cookie " +
            "domain is configured, the domain-scoped one, under each name still in play. " +
            "Answers with a JSON body; it does not redirect.",
          responses: {
            "200": {
              description: "Signed out",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                  },
                },
              },
            },
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
                      email: { type: ["string", "null"] },
                      avatar_url: { type: ["string", "null"] },
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
      "/api/instance": {
        get: {
          summary: "The instance's public links",
          operationId: "getInstance",
          description:
            "The links this instance shows: its docs, and the operator's terms and privacy policy. Read by the dashboard, once per session. Any credential reads it — a session, an API key of any reach, the dev token: the body is the instance's configuration, the same for every caller, and nothing about the account. The values are the ones the server validated when it started, in the form its pages serve them: an absolute address normalised, a path on this site as written. They change only when the server restarts. GET /api/me carries none of it.",
          responses: {
            "200": {
              description: "The instance's links",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      links: {
                        type: "object",
                        properties: {
                          docs: {
                            type: "string",
                            description:
                              "The operator's docs address, or `/docs` (this server's API reference) when none is configured.",
                          },
                          terms: {
                            type: ["string", "null"],
                            description: "The operator's terms; null when none is configured.",
                          },
                          privacy: {
                            type: ["string", "null"],
                            description:
                              "The operator's privacy policy; null when none is configured.",
                          },
                        },
                        required: ["docs", "terms", "privacy"],
                      },
                    },
                    required: ["links"],
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
      "/api/account": {
        delete: {
          summary: "Delete your account",
          operationId: "deleteAccount",
          description:
            "Deletes the caller's account. Takes a session, the dev token, or an account-wide API key that carries every operation, and the account's username as confirmation. Deleted: the account, its API keys, sessions and device codes, its agents with their versions, bundles and model keys, the notebooks of its agents and the ones other agents keep for it, and the output files of its runs. Its runs, and every run of its agents, stay — cleared (input, output, error and files emptied), detached from the account and the agent, the version they name reduced to `@<version>`; so do the runs of an agent the account deleted earlier, found by the namespace their version names, unless another account shares that namespace. No record of the deletion is kept in the database; a server whose operator keeps a deletion journal keeps the account's internal id, and nothing else of it, in its object storage until its lifecycle rule removes it, so that a database restored from an earlier copy does not bring the account back. Not reached: copies another server instance holds until they expire, notebooks the account wrote in an agent that shares one notebook between its callers, logs, backups. A run still going finishes for its caller, but writes no content and leaves no file. The username is free again at once. A call carried by the session cookie alone must send its JSON body with `Content-Type: application/json`, or the CSRF guard answers 403 before this route. On success, every name of the session cookie is cleared. A request with the dev token after the deletion signs in as a new, empty account.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    confirm: {
                      type: "string",
                      description: "The account's username, exactly as `GET /api/me` returns it.",
                    },
                  },
                  required: ["confirm"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Account deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { deleted: { type: "boolean", const: true } },
                    required: ["deleted"],
                  },
                },
              },
            },
            "400": {
              description:
                "CONFIRMATION_MISMATCH — no JSON body, no `confirm`, or a `confirm` that is not the account's username. Nothing was touched.",
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
                "KEY_SCOPE_FORBIDDEN — deleting an account takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "NOT_FOUND — the account has no record (a dev token whose account could not be stored), or it was deleted meanwhile.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "503": {
              description:
                "STORAGE_UNAVAILABLE — object storage failed before any row went: an object could not be listed or deleted, or, on a server that keeps a deletion journal, the deletion could not be recorded there before anything was deleted. The account still exists, with its sessions and keys; some of its bundles may already be gone, so a version may fail to pull or run until the deletion is finished. Send the same request again to finish.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/admin/accounts/{id}": {
        delete: {
          summary: "Delete another account (admin only)",
          operationId: "adminDeleteAccount",
          description:
            "Deletes the account `id` (its internal id), with the same effects as DELETE /api/account, for an instance administrator. The confirmation is the target's username: the id and the name must designate the same account. A caller who is not an administrator, or holds a key restricted to some agents, gets the same 404 as any admin route, whatever it sends. The caller's session is left alone, unless the id is the caller's own: an administrator deleting their own account this way has every name of the session cookie cleared, as on DELETE /api/account.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
              description: "The account's internal id (`GET /api/me` returns it as `id`).",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    confirm: {
                      type: "string",
                      description:
                        "The username of the account `id`, exactly as that account's `GET /api/me` returns it.",
                    },
                  },
                  required: ["confirm"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Account deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { deleted: { type: "boolean", const: true } },
                    required: ["deleted"],
                  },
                },
              },
            },
            "400": {
              description:
                "CONFIRMATION_MISMATCH — no JSON body, no `confirm`, or a `confirm` that is not the username of the account `id`. Nothing was touched.",
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
                "KEY_SCOPE_FORBIDDEN — an administrator whose key does not carry every operation: deleting an account takes a session, the dev token, or an account-wide API key with agent:run, agent:push and agent:verify.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "NOT_FOUND — the caller is not an administrator or holds a key restricted to some agents (the body every admin route answers such a caller with), the id is not a UUID, or no account has that id.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "503": {
              description:
                "STORAGE_UNAVAILABLE — object storage failed before any row went: an object could not be listed or deleted, or, on a server that keeps a deletion journal, the deletion could not be recorded there before anything was deleted. The account still exists; send the same request again to finish.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/admin/accounts/{id}/plan": {
        put: {
          summary: "Assign another account's plan (admin only)",
          operationId: "adminAssignAccountPlan",
          description:
            "Sets the plan of the account `id` (its internal id) — the plan its quota thresholds are read under, which GET /api/me returns as `plan` — for an instance administrator with a full-access credential. Checked in the order of DELETE /api/admin/accounts/{id}: a caller who is not an administrator, or holds a key restricted to some agents, gets the same 404 as any admin route, whatever it sends; an id that is not a UUID, the same 404; an administrator's key without full access, 403; then the plan, then the account. The plan must be one the server knows — `free`, and every plan its per-plan quota settings name — compared without surrounding spaces and in any letter case, and written in lower case; a server that sets no per-plan quota knows `free` only. The account's next request reads the new plan: nothing caches it.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
              description: "The account's internal id (`GET /api/me` returns it as `id`).",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    plan: {
                      type: "string",
                      description: "A plan the server knows, e.g. `free`.",
                      example: "pro",
                    },
                  },
                  required: ["plan"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Plan assigned",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      plan: { type: "string", description: "The plan written, in lower case." },
                    },
                    required: ["id", "plan"],
                  },
                },
              },
            },
            "400": {
              description:
                "UNKNOWN_PLAN — no JSON body, no `plan`, a `plan` that is not a string, or a plan the server does not know. The message lists the plans it knows, `free` first. Nothing was written.",
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
                "KEY_SCOPE_FORBIDDEN — an administrator whose key does not carry every operation: assigning a plan takes a session, the dev token, or an account-wide API key with agent:run, agent:push and agent:verify.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "NOT_FOUND — the caller is not an administrator or holds a key restricted to some agents (the body every admin route answers such a caller with), the id is not a UUID, or no account has that id.",
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
          description: `Creates a new API key. The raw key (${API_KEY_PREFIX}...) is returned only once — store it securely.`,
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
                    expires_at: {
                      type: "string",
                      format: "date-time",
                      description:
                        "Optional expiry, ISO-8601, must be in the future. No default: omit it and the key never expires (a key minted here is typically wired into someone else's integration, so a lifetime is never imposed). A malformed or past value is refused with 400 INVALID_REQUEST. Keys minted by the CLI login flow are the other case — they carry the operator's SKRUN_API_KEY_TTL_DAYS lifetime, default 90 days.",
                      example: "2027-01-31T23:59:59.000Z",
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
                      key: { type: "string", example: `${API_KEY_PREFIX}3f9a…` },
                      name: { type: "string" },
                      key_prefix: { type: "string", example: `${API_KEY_PREFIX}3f9aK7Qx` },
                      scopes: { type: "array", items: { type: "string" } },
                      scope_kind: { type: "string", enum: ["account", "agents"] },
                      agents: { type: "array", items: { type: "string" } },
                      expires_at: {
                        type: ["string", "null"],
                        format: "date-time",
                        description: "null when the key does not expire.",
                      },
                      created_at: { type: "string", format: "date-time" },
                    },
                    required: ["id", "key", "name", "key_prefix", "scopes", "scope_kind"],
                  },
                },
              },
            },
            "400": {
              description:
                "INVALID_REQUEST — malformed JSON, missing name, an unknown scope, or an expires_at that is not a parseable ISO-8601 instant in the future.",
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
                        last_used_at: { type: ["string", "null"], format: "date-time" },
                        expires_at: {
                          type: ["string", "null"],
                          format: "date-time",
                          description:
                            "When the key stops authenticating; null when it does not expire. A key past this instant is refused with 401 UNAUTHORIZED, like a revoked one.",
                        },
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
            "Run-scoped download. Kept for backward compatibility. New clients should prefer the unified GET /api/files/{id}/content using `file_id` from the run response. Requires authentication AND that the caller may read the run's files: a full-access credential, any run of its account; an account-wide key with fewer operations, only the runs it launched. A key restricted to some agents is refused (403).",
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
              description:
                "File content, as a download (`Content-Disposition: attachment`), with the Content-Type of its extension",
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
              description: "KEY_SCOPE_FORBIDDEN — not available to a resource-scoped API key",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "RUN_NOT_FOUND — no such run, one the caller may not read (another account's, or, for a key without full access, one it did not launch — the same answer, so such a run is not revealed), or its output files are no longer kept; FILE_NOT_FOUND — the run's outputs hold no file of that name",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/runs/{run_id}/files/{filename}/link": {
        get: {
          summary: "Get a fresh download link for a file produced by a run",
          operationId: "getRunFileLink",
          description:
            "A new download link for one of a run's output files, for as long as the run's files are kept (`FILES_RETENTION_S`). `filename` is matched exactly against the names the run lists, once URL-decoded; any other name answers 404. On the cloud runtime (`flyio`), `url` is a presigned object-storage URL whose response is an attachment (`Content-Disposition: attachment`), valid until `expires_at` — at most about 15 minutes, never past the run's retention deadline. On the local runtime, `url` is the run-scoped route of this API (`GET /api/runs/{run_id}/files/{filename}`), which needs the caller's credentials, and `expires_at` is null. The answer is never cached (`Cache-Control: no-store`). Requires authentication AND that the caller may read the run's files: a full-access credential, any run of its account; an account-wide key with fewer operations, only the runs it launched. A key restricted to some agents is refused (403).",
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
              description: "A fresh link",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["url", "expires_at"],
                    properties: {
                      url: {
                        type: "string",
                        description:
                          "Download URL: presigned and absolute on the cloud runtime, a relative route of this API on the local runtime. Opaque — never build it from parts.",
                      },
                      expires_at: {
                        type: ["string", "null"],
                        format: "date-time",
                        description:
                          "When a presigned `url` stops working; null for the local runtime's route, which has no expiry of its own.",
                      },
                    },
                  },
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
              description: "KEY_SCOPE_FORBIDDEN — not available to a resource-scoped API key",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "RUN_NOT_FOUND — no such run, or one the caller may not read (another account's, or, for a key without full access, one it did not launch — the same answer, so such a run is not revealed); FILE_NOT_FOUND — the run lists no file of that exact name",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "410": {
              description:
                "FILE_EXPIRED — the run's output files are no longer kept: past its retention deadline, or deleted",
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
              description:
                "FILE_TOO_LARGE — the file exceeds INPUT_FILES_MAX_SIZE_MB (default 25 MB), or the request body exceeds it plus 1 MB of multipart framing. Refused before the upload is read whole — on a declared Content-Length before anything is read, without one at the first chunk past the cap — and nothing is read before authentication; this 413 replaces the 400 INVALID_MULTIPART of a body cut short.",
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
            "429": {
              description:
                "INPUT_FILES_LIMIT_REACHED — on a server that bounds an account's live uploads: the account already holds as many uploads that have neither expired nor been deleted as its plan allows, whichever of its keys made them. Refused before the body is read — or, when another upload of the account took its last place meanwhile, once the body is read, before anything is kept; Retry-After gives the seconds until the account holds fewer — when the oldest one expires, or, for an account holding more than its plan allows (its plan lowered), when enough of them have — and deleting uploads frees places at once. A full-access credential is told the count, the limit and that instant; any other key, that the account reached a usage limit. Counted by each server process, where the uploads live.",
              headers: { "Retry-After": retryAfter },
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
            "Requires authentication. A full-access credential reads every file of its account: each upload (input) and the outputs of each run (output). Any other key — run-only, or restricted to some agents — reads only the files it uploaded and the outputs of the runs it launched.",
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
              description:
                "FORBIDDEN — the caller may not read this file: another account's, or, for a key without full access, one it did not upload or the output of a run it did not launch",
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
            "Removes the file from storage. Requires authentication AND that the caller may use the upload: a full-access credential, any upload of its account; any other key, only the files it uploaded. Returns 403 DELETE_OUTPUT_FORBIDDEN if the file_id refers to an agent-produced output (callers don't own outputs), or 403 FORBIDDEN for an upload the caller may not use (another account's, or, for a key without full access, another key's).",
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
                "DELETE_OUTPUT_FORBIDDEN — cannot delete output files; or FORBIDDEN — an upload the caller may not use",
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
            "Requires authentication. A full-access credential reads every file of its account: each upload (input) and the outputs of each run (output). Any other key — run-only, or restricted to some agents — reads only the files it uploaded and the outputs of the runs it launched.",
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
              description:
                "Binary file content, as a download (`Content-Disposition: attachment`). Content-Type: the upload's for an input, the extension's for an output.",
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
              description:
                "FORBIDDEN — the caller may not read this file: another account's, or, for a key without full access, one it did not upload or the output of a run it did not launch",
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          },
        },
      },
      "/api/usage": {
        get: {
          summary: "The account's own usage against its quotas",
          operationId: "getUsage",
          description:
            "What the caller's account consumes now, against the quotas its plan gives it on this server: its runs in progress, its compute time in the current window and, while the server's pre-warm pool runs, its fast runs of the rolling hour. The same figures a run's admission reads, at the instant of the request: a run admitted a moment later can change them. quotas is null when the server sets no quota; concurrent_runs and compute are each null when the server leaves their bound unset, fast_runs only while no pre-warm pool runs. Read by a full-access credential only, as the run history is. GET /api/me carries none of it.",
          responses: {
            "200": {
              description: "The account's usage",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      plan: {
                        type: "string",
                        example: "free",
                        description:
                          "The plan whose quotas apply: free for an account without one, for a plan the server's settings do not name, and for the dev token.",
                      },
                      quotas: {
                        type: ["object", "null"],
                        description: "null when the server sets no quota.",
                        properties: {
                          concurrent_runs: {
                            type: ["object", "null"],
                            description:
                              "The account's runs in progress; null when the server sets no such bound.",
                            properties: {
                              limit: { type: "integer", minimum: 1 },
                              in_use: { type: "integer", minimum: 0 },
                            },
                            required: ["limit", "in_use"],
                          },
                          compute: {
                            type: ["object", "null"],
                            description:
                              "The account's compute time in the current window; null when the server sets no such bound.",
                            properties: {
                              limit_seconds: { type: "integer", minimum: 1 },
                              used_seconds: {
                                type: "integer",
                                minimum: 0,
                                description:
                                  "The time charged to the window's runs, in whole seconds rounded down — a run in progress counted so far. It can exceed the limit: a run is checked when it is admitted, never during it.",
                              },
                              window: {
                                type: "object",
                                description:
                                  "The current window, fixed and aligned on UTC: start included, end excluded.",
                                properties: {
                                  start: { type: "string", format: "date-time" },
                                  end: { type: "string", format: "date-time" },
                                },
                                required: ["start", "end"],
                              },
                            },
                            required: ["limit_seconds", "used_seconds", "window"],
                          },
                          fast_runs: {
                            type: ["object", "null"],
                            description:
                              "The account's runs of the rolling hour that keep the right to a ready machine of the pre-warm pool — a run for which no pooled machine was taken gives it back once its machine is ready. null while the server runs no pre-warm pool: no run has the right to one. A run past them is never refused: it starts on a new machine, about a minute slower.",
                            properties: {
                              limit: {
                                type: ["integer", "null"],
                                minimum: 0,
                                description:
                                  "The fast runs per rolling hour; null when the server sets no such bound (every run has the right); 0 for a plan that includes none.",
                              },
                              remaining: {
                                type: ["integer", "null"],
                                minimum: 0,
                                description:
                                  "The fast runs left now, never below 0; null when the server sets no such bound.",
                              },
                              resets_at: {
                                type: ["string", "null"],
                                format: "date-time",
                                description:
                                  "When the next right comes back: the creation of the oldest run of the hour that keeps the right, plus one hour — or, for an account that holds more of them than its limit (its plan or the bound lowered since), the creation of the run whose leaving brings it back under the limit, plus one hour. null when no run of the hour keeps it, when the bound is unset, and for a plan that includes none.",
                              },
                            },
                            required: ["limit", "remaining", "resets_at"],
                          },
                        },
                        required: ["concurrent_runs", "compute", "fast_runs"],
                      },
                    },
                    required: ["plan", "quotas"],
                  },
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
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "NOT_FOUND — the account has no record (a dev token whose account could not be stored): its runs count against no account, so there is nothing to read.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused. Checked after the ownership check: an agent of another account still answers the opaque 404, unless the caller is an instance admin on a full-access credential.",
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
          description:
            "Returns recent runs of the caller's account — those of every key of the account included — sorted by most recent first. Supports filtering. Takes a full-access credential.",
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
                      input: {
                        type: ["object", "null"],
                        additionalProperties: true,
                        description:
                          'The run\'s input, kept whole up to 8 KiB (8,192 bytes) of its JSON text in UTF-8. Beyond, a marker: { "_truncated": { "bytes": <size of the whole JSON text>, "preview": "<its beginning>" } }, the marker itself within 8 KiB. The run itself was handed the whole input.',
                      },
                      output: {
                        type: ["object", "null"],
                        additionalProperties: true,
                        description:
                          "The run's output, kept whole up to 32 KiB (32,768 bytes) of its JSON text; beyond, the same marker as `input`, within 32 KiB. The run's caller got the whole output — in the synchronous result, the stream or the webhook delivery.",
                      },
                      error: {
                        type: ["string", "null"],
                        description:
                          "The run's error, kept whole up to 8 KiB; beyond, its beginning followed by `… [truncated: N bytes]`, N the size of the whole error, the two within 8 KiB. The run's caller got the whole error.",
                      },
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
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused. Checked before the run is looked up, whatever the run.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description: "Run not found, or not of the caller's account (the same answer)",
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
            "Returns the agent directories (each holding an agent.yaml) found one level under SKRUN_AGENTS_DIR, with their registration status in the caller's namespace. Takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). The answer names no path of the server: each path is relative to the configured directory, and a missing directory is reported without its value. Returns { configured: false, agents: [] } if the env var is not set.",
          responses: {
            "200": {
              description: "Scan result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      configured: { type: "boolean" },
                      error: {
                        type: "string",
                        description:
                          'Present when SKRUN_AGENTS_DIR names a directory that does not exist: "Directory not found: the configured agents directory" — the configured value is not repeated.',
                      },
                      agents: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            path: {
                              type: "string",
                              description:
                                "Relative to SKRUN_AGENTS_DIR: the agent's directory name. Never an absolute path of the server.",
                            },
                            registered: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: reading this takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). A run-only key, or a key restricted to some agents, is refused.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
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
            "Reads files from the scanned directory and registers the agent under the authenticated user's namespace. Version is read from the agent.yaml. Useful for importing agents from the dashboard without the CLI. Building from the server's agents directory takes full access, like the scan: any other key is refused 403 before the directory is read, whatever the name.",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Push successful",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PushResult" } },
              },
            },
            "400": {
              description:
                "SKRUN_AGENTS_DIR not configured, or agent invalid: INVALID_AGENT, no agent.yaml in the directory. INVALID_VERSION_FORMAT, as for a push: the version read from the raw text of agent.yaml — the first version:, up to a quote or the end of its line — is not strict semver (an unquoted version followed by a comment is) — refused before anything is stored. BUNDLE_CORRUPT, as for a push: a file of the directory whose path in the bundle cannot be written out where an agent runs — over 1,024 bytes, or a name over 255 bytes between two / —, the file named. MISSING_CONFIG (an empty agent.yaml) or INVALID_CONFIG (an agent.yaml that is not YAML, that declares a YAML version other than 1.2, that holds a YAML alias or the tag !!omap, or that the schema refuses, each issue named, or one the server takes longer than 2 s to read — judged once agent.yaml is within its 128 KB, 413 CONFIG_TOO_LARGE otherwise), as for a push: whatever bounds the server sets, refused first, before anything is stored. INVALID_CONFIG, as for a push: a configuration that holds U+0000 or a lone surrogate, in a value or a key, the field named — refused before anything is stored. UNSUPPORTED_FIELD, MODEL_BASE_URL_REQUIRED or TIMEOUT_OUT_OF_RANGE, as for a push: whatever bounds the server sets, the agent.yaml declares a setting that no code honours — refused before anything is stored. TIMEOUT_ABOVE_LIMIT, as for a push: on a server that sets a longest timeout, the agent.yaml declares a timeout above it — refused before anything is stored.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "403": {
              description:
                "KEY_SCOPE_FORBIDDEN — the key does not carry full access: building from the agents directory takes a session, the dev token, or an account-wide API key that carries every operation (agent:run, agent:push, agent:verify). Checked first, before the directory is read and before SKRUN_AGENTS_DIR is looked up: a run-only key gets this answer whatever the name, and a key restricted to some agents gets the same code with its own message (not available to a resource-scoped key). FORBIDDEN — the name resolves outside the agents directory.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "404": {
              description:
                "NOT_FOUND — no directory of that name in the agents directory. Answered to a full-access credential only.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "413": {
              description:
                "BUNDLE_DECOMPRESSED_TOO_LARGE, as for a push: the bundle built from the directory decompresses to more than BUNDLE_MAX_DECOMPRESSED_MB (default 50 MB) — refused first, whatever bounds the server sets, before anything is stored. CONFIG_TOO_LARGE, as for a push: the directory's agent.yaml weighs more than 128 KB (131,072 bytes), a fixed limit — refused before it is parsed, whatever bounds the server sets, before anything is stored. STORAGE_QUOTA_EXCEEDED, as for a push: on a server that bounds an account's bundle storage, the bundles the account's agents hold, this one included, would exceed its plan's — refused before anything is stored.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
            "503": {
              description: `As for a push, its agent.yaml read in the same line: ${pushBusy}`,
              headers: { "Retry-After": retryAfter },
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
