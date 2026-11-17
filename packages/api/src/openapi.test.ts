import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getOpenAPISchema } from "./openapi.js";
import { QUOTA_HEADERS } from "./quotas/admission.js";

/**
 * This package's own version. Resolves the same from `src/` and from `dist/`,
 * since both sit one level under the package root.
 */
const PKG_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version;

/**
 * Every place where a key called `name` appears in a JSON-like value, as a
 * readable path (`$.paths["/api/me"].get…`). Walks objects and arrays alike.
 */
function findKeyPaths(value: unknown, name: string, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findKeyPaths(item, name, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = /^[A-Za-z_$][\w$]*$/.test(key)
      ? `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`;
    if (key === name) found.push(childPath);
    found.push(...findKeyPaths(child, name, childPath));
  }
  return found;
}

describe("OpenAPI Schema", () => {
  const schema = getOpenAPISchema();

  it("has openapi 3.1.0 version", () => {
    expect(schema.openapi).toBe("3.1.0");
  });

  // OpenAPI 3.1 has no `nullable` keyword (it was 3.0 syntax): a 3.1 tool
  // ignores it, so the field reads as never null. A field that may be null
  // says so in its `type`, the form the rest of this document already uses.
  it("never uses the 3.0 nullable keyword, anywhere in the document", () => {
    expect(findKeyPaths(schema, "nullable")).toEqual([]);
  });

  it("writes the fields of /api/me and /api/keys that may be null as a type that includes null", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const paths = schema.paths as any;
    const me = paths["/api/me"].get.responses["200"].content["application/json"].schema.properties;
    const created =
      paths["/api/keys"].post.responses["201"].content["application/json"].schema.properties;
    const listed =
      paths["/api/keys"].get.responses["200"].content["application/json"].schema.items.properties;

    const mayBeNull = {
      "GET /api/me email": me.email,
      "GET /api/me avatar_url": me.avatar_url,
      "POST /api/keys expires_at": created.expires_at,
      "GET /api/keys last_used_at": listed.last_used_at,
      "GET /api/keys expires_at": listed.expires_at,
    };
    for (const [field, fieldSchema] of Object.entries(mayBeNull)) {
      expect({ field, type: fieldSchema.type }).toEqual({ field, type: ["string", "null"] });
    }

    // The date-time formats and the descriptions stay.
    expect(created.expires_at.format).toBe("date-time");
    expect(created.expires_at.description).toMatch(/null when the key does not expire/);
    expect(listed.last_used_at.format).toBe("date-time");
    expect(listed.expires_at.format).toBe("date-time");
    expect(listed.expires_at.description).toMatch(/null when it does not expire/);
  });

  it("/api/keys documents scope_kind, agents, and KEY_SCOPE_FORBIDDEN", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const keys = schema.paths["/api/keys"] as any;
    const reqProps = keys.post.requestBody.content["application/json"].schema.properties;
    expect(reqProps.scope_kind).toBeDefined();
    expect(reqProps.agents).toBeDefined();
    expect(keys.post.responses["403"]).toBeDefined();
    expect(
      keys.post.responses["201"].content["application/json"].schema.properties.scope_kind,
    ).toBeDefined();
    expect(
      keys.get.responses["200"].content["application/json"].schema.items.properties.scope_kind,
    ).toBeDefined();
    expect(keys.get.responses["403"]).toBeDefined();
  });

  it("has all expected endpoint paths", () => {
    const paths = Object.keys(schema.paths);
    expect(paths).toContain("/health");
    expect(paths).toContain("/api/agents/{namespace}/{name}/run");
    expect(paths).toContain("/api/agents/{namespace}/{name}/push");
    expect(paths).toContain("/api/agents/{namespace}/{name}/pull");
    expect(paths).toContain("/api/agents/{namespace}/{name}/pull/{version}");
    expect(paths).toContain("/api/agents");
    expect(paths).toContain("/api/agents/{namespace}/{name}");
    expect(paths).toContain("/api/agents/{namespace}/{name}/versions");
    expect(paths).toContain("/api/agents/{namespace}/{name}/versions/{version}");
    expect(paths).toContain("/auth/device/code");
    expect(paths).toContain("/auth/device/token");
    expect(paths).toContain("/api/usage");
    expect(paths).toContain("/api/instance");
    // Per-version verify route replaces the legacy agent-level
    // `/agents/:ns/:name/verify`. Listed once below; the legacy path is
    // absent from the schema.
    expect(paths).not.toContain("/api/agents/{namespace}/{name}/verify");
  });

  // --- deleteAgentVersion ---

  it("DELETE /agents/:ns/:name/versions/:version exists with deleteAgentVersion operationId", () => {
    const path = schema.paths["/api/agents/{namespace}/{name}/versions/{version}"];
    expect(path).toBeDefined();
    expect(path.delete).toBeDefined();
    expect(path.delete.operationId).toBe("deleteAgentVersion");
    expect(path.delete.summary).toBeTruthy();
    // Documents 5 response codes: 204 / 401 / 403 / 404 / 409
    expect(path.delete.responses["204"]).toBeDefined();
    expect(path.delete.responses["401"]).toBeDefined();
    expect(path.delete.responses["403"]).toBeDefined();
    expect(path.delete.responses["404"]).toBeDefined();
    expect(path.delete.responses["409"]).toBeDefined();
    // No requestBody
    expect(path.delete.requestBody).toBeUndefined();
    // Path parameters: namespace + name + version
    const paramNames = path.delete.parameters.map((p: { name: string }) => p.name);
    expect(paramNames).toEqual(["namespace", "name", "version"]);
  });

  it("documents the two account deletion routes: a confirmation body, their codes, and never a 409", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const paths = schema.paths as any;
    const routes = {
      self: paths["/api/account"]?.delete,
      admin: paths["/api/admin/accounts/{id}"]?.delete,
    };
    expect(routes.self?.operationId).toBe("deleteAccount");
    expect(routes.admin?.operationId).toBe("adminDeleteAccount");
    for (const [route, op] of Object.entries(routes)) {
      const body = op.requestBody.content["application/json"].schema;
      expect({ route, required: op.requestBody.required, fields: body.required }).toEqual({
        route,
        required: true,
        fields: ["confirm"],
      });
      expect({ route, codes: Object.keys(op.responses).sort() }).toEqual({
        route,
        codes: ["200", "400", "401", "403", "404", "503"],
      });
      expect(op.responses["200"].content["application/json"].schema.required).toEqual(["deleted"]);
      expect(op.responses["400"].description).toMatch(/CONFIRMATION_MISMATCH/);
      expect(op.responses["403"].description).toMatch(/KEY_SCOPE_FORBIDDEN/);
      expect(op.responses["503"].description).toMatch(/STORAGE_UNAVAILABLE/);
    }
    expect(routes.self.description).toMatch(/Content-Type: application\/json/);
    expect(
      routes.admin.parameters.map((p: { name: string; in: string }) => [p.name, p.in]),
    ).toEqual([["id", "path"]]);
  });

  it("has bearerAuth security scheme", () => {
    expect(schema.components.securitySchemes.bearerAuth).toBeDefined();
    expect(schema.components.securitySchemes.bearerAuth.type).toBe("http");
    expect(schema.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("has ErrorResponse schema", () => {
    expect(schema.components.schemas.ErrorResponse).toBeDefined();
    expect(schema.components.schemas.ErrorResponse.properties.error).toBeDefined();
  });

  it("ErrorResponse is referenced by multiple endpoints", () => {
    const json = JSON.stringify(schema);
    const refs = json.match(/#\/components\/schemas\/ErrorResponse/g) ?? [];
    expect(refs.length).toBeGreaterThan(5);
  });

  it("POST /run has text/event-stream response", () => {
    const runPath = schema.paths["/api/agents/{namespace}/{name}/run"];
    const responses = runPath.post.responses;
    const ok = responses["200"];
    expect(ok.content["text/event-stream"]).toBeDefined();
  });

  it("has RunEvent schema", () => {
    expect(schema.components.schemas.RunEvent).toBeDefined();
    expect(schema.components.schemas.RunEvent.properties.type.enum).toContain("run_start");
    expect(schema.components.schemas.RunEvent.properties.type.enum).toContain("run_complete");
  });

  // --- Version pinning schema ---

  it("POST /run request body accepts optional `version` with semver pattern", () => {
    const runPath = schema.paths["/api/agents/{namespace}/{name}/run"];
    const body = runPath.post.requestBody.content["application/json"].schema;
    expect(body.properties.version).toBeDefined();
    expect(body.properties.version.type).toBe("string");
    expect(body.properties.version.pattern).toBe("^\\d+\\.\\d+\\.\\d+$");
    expect(body.required).not.toContain("version");
  });

  it("RunResult schema requires agent_version", () => {
    const rr = schema.components.schemas.RunResult;
    expect(rr.properties.agent_version).toBeDefined();
    expect(rr.properties.agent_version.type).toBe("string");
    expect(rr.required).toContain("agent_version");
  });

  it("AsyncRunResult schema requires agent_version", () => {
    const ar = schema.components.schemas.AsyncRunResult;
    expect(ar.properties.agent_version).toBeDefined();
    expect(ar.required).toContain("agent_version");
  });

  it("documents files_excluded on the run result and on run_complete: counts by reason, always present", () => {
    const excluded = schema.components.schemas.FilesExcluded;
    expect(excluded.type).toBe("object");
    expect(Object.keys(excluded.properties).sort()).toEqual([
      "name_refused",
      "over_count",
      "pull_failed",
      "too_large",
      "upload_budget",
    ]);
    for (const count of Object.values(excluded.properties)) {
      expect(count).toMatchObject({ type: "integer", minimum: 1 });
    }
    const result = schema.components.schemas.RunResult;
    expect(result.properties.files_excluded.$ref).toBe("#/components/schemas/FilesExcluded");
    expect(result.required).toContain("files_excluded");
    const event = schema.components.schemas.RunEvent;
    expect(event.properties.files_excluded.$ref).toBe("#/components/schemas/FilesExcluded");
    expect(event.properties.files_excluded.description).toContain("run_complete");
  });

  it("RunEvent carries agent and agent_version (run_start only)", () => {
    const re = schema.components.schemas.RunEvent;
    expect(re.properties.agent).toBeDefined();
    expect(re.properties.agent_version).toBeDefined();
    expect(re.properties.agent_version.pattern).toBe("^\\d+\\.\\d+\\.\\d+$");
  });

  it("VersionNotFoundResponse schema includes `available` array", () => {
    const vnf = schema.components.schemas.VersionNotFoundResponse;
    expect(vnf).toBeDefined();
    expect(vnf.properties.error.properties.available).toBeDefined();
    expect(vnf.properties.error.properties.available.type).toBe("array");
    expect(vnf.properties.error.required).toContain("available");
  });

  it("POST /run 404 uses oneOf to surface VersionNotFoundResponse", () => {
    const runPath = schema.paths["/api/agents/{namespace}/{name}/run"];
    const resp404 = runPath.post.responses["404"].content["application/json"].schema;
    expect(resp404.oneOf).toBeDefined();
    const refs = resp404.oneOf.map((s: { $ref: string }) => s.$ref);
    expect(refs).toContain("#/components/schemas/VersionNotFoundResponse");
    expect(refs).toContain("#/components/schemas/ErrorResponse");
  });

  // Prompt caching — the OpenAPI schema documents the optional
  // cache fields on RunResult.usage. Catches drift between code and schema.
  it("RunResult.usage exposes optional cache_read_tokens + cache_write_tokens", () => {
    const usage = schema.components.schemas.RunResult.properties.usage;
    expect(usage.properties.cache_read_tokens).toBeDefined();
    expect(usage.properties.cache_read_tokens.type).toBe("integer");
    expect(usage.properties.cache_write_tokens).toBeDefined();
    expect(usage.properties.cache_write_tokens.type).toBe("integer");
    // The fields from before prompt caching, preserved.
    expect(usage.properties.prompt_tokens.type).toBe("integer");
    expect(usage.properties.completion_tokens.type).toBe("integer");
    expect(usage.properties.total_tokens.type).toBe("integer");
  });

  // Cache cost-savings fields documented across Run + Stats + AgentStats
  // schemas + RunResult.cost.saved. Catches drift between the wire format and
  // the schema, which dashboard / SDK consumers depend on.
  it("cache cost-savings fields documented across all 4 surfaces", () => {
    // 1. RunResult.cost.saved
    const cost = schema.components.schemas.RunResult.properties.cost;
    expect(cost.properties.saved).toBeDefined();
    expect(cost.properties.saved.type).toBe("number");

    // 2. GET /api/runs/:id response (the Run shape) gains 3 cache columns
    const runDetail = schema.paths["/api/runs/{id}"].get.responses["200"];
    const runProps = runDetail.content["application/json"].schema.properties;
    expect(runProps.usage_cache_read_tokens?.type).toBe("integer");
    expect(runProps.usage_cache_write_tokens?.type).toBe("integer");
    expect(runProps.usage_cache_savings_usd?.type).toBe("number");

    // 3. GET /api/stats response (3 new fields)
    const stats = schema.paths["/api/stats"].get.responses["200"];
    const statsProps = stats.content["application/json"].schema.properties;
    expect(statsProps.cache_savings_today?.type).toBe("number");
    expect(statsProps.cache_savings_yesterday?.type).toBe("number");
    expect(statsProps.daily_cache_savings?.type).toBe("array");
    expect(statsProps.daily_cache_savings?.items?.type).toBe("number");

    // 4. GET /api/agents/:ns/:name/stats response (3 new fields)
    const agentStats = schema.paths["/api/agents/{namespace}/{name}/stats"].get.responses["200"];
    const agentStatsProps = agentStats.content["application/json"].schema.properties;
    expect(agentStatsProps.cache_savings?.type).toBe("number");
    expect(agentStatsProps.prev_cache_savings?.type).toBe("number");
    expect(agentStatsProps.daily_cache_savings?.type).toBe("array");
    expect(agentStatsProps.daily_cache_savings?.items?.type).toBe("number");
  });

  // The 5 registry GET endpoints inherit the global bearerAuth security (no
  // `security: []` override) and declare 401 + an opaque 404: a non-owner read
  // gets the 404 path, never a 403, so the existence of another account's agent
  // is not revealed. The 403 these routes may answer is the key's scope, and
  // only once the agent is the caller's own: each of the five documents it, and
  // so does the list, which a key restricted to some agents may not call.
  //
  // The version assertion reads package.json instead of a literal. The release
  // process requires `info.version` to TRACK the package version, and that is
  // the property worth pinning — a hardcoded string asserted neither half of it:
  // it broke on every single release, and it never once checked that the two
  // actually agree. Pinned to a literal it would have passed at v1.0.0 with the
  // document still announcing 0.8.0 to every generated client.
  it("5 GET endpoints — security + 401 + opaque 404, a 403 only for the key's scope + version tracks the package", () => {
    // The 5 per-agent GET endpoints — all gated by `assertAgentVisibleOrThrow`,
    // all return 404 opaque on non-owner. The list endpoint at /api/agents
    // is checked separately below since it has no 404 (filters return [] for
    // new users with no agents, not a 404).
    const perAgentTargets = [
      { path: "/api/agents/{namespace}/{name}", op: "getAgent" },
      { path: "/api/agents/{namespace}/{name}/versions", op: "getAgentVersions" },
      { path: "/api/agents/{namespace}/{name}/pull", op: "pullAgent" },
      { path: "/api/agents/{namespace}/{name}/pull/{version}", op: "pullAgentVersion" },
      { path: "/api/agents/{namespace}/{name}/stats", op: "getAgentStats" },
    ];

    // The published document must announce the version we actually shipped.
    expect(schema.info.version).toBe(PKG_VERSION);

    // Global security IS bearerAuth (so endpoints without an override inherit it)
    expect(schema.security).toEqual([{ bearerAuth: [] }]);

    // List endpoint: auth required (no `security: []` override) + 401, but
    // no 404 (empty filtered list returns 200 with `agents: [], total: 0`).
    // Its 403 is the key's scope: a key restricted to some agents cannot list.
    const listRoute = schema.paths["/api/agents"].get;
    expect(listRoute.operationId).toBe("listAgents");
    expect(listRoute.security).toBeUndefined();
    expect(listRoute.responses["401"]).toBeDefined();
    const listForbidden = listRoute.responses["403"];
    expect(listForbidden, "/api/agents").toBeDefined();
    expect(listForbidden.description, "/api/agents").toMatch(/^KEY_SCOPE_FORBIDDEN/);
    expect(listRoute.responses["404"]).toBeUndefined();

    for (const { path, op } of perAgentTargets) {
      const route = schema.paths[path].get;
      expect(route.operationId).toBe(op);

      // No security override — inherits global bearerAuth
      // (presence of `security: []` here would mean "no auth required" per OpenAPI 3.1)
      expect(route.security).toBeUndefined();

      // 401 response declared
      expect(route.responses["401"]).toBeDefined();
      expect(route.responses["401"].content["application/json"].schema.$ref).toBe(
        "#/components/schemas/ErrorResponse",
      );

      // 404 response declared with description NOT mentioning permissions/visibility
      expect(route.responses["404"]).toBeDefined();
      const fourOhFourDescription: string = route.responses["404"].description;
      expect(fourOhFourDescription).toMatch(/not found/i);
      expect(fourOhFourDescription).not.toMatch(/permission|forbidden|access denied|private/i);
    }

    // A 403 on a read is the key's scope, never the agent's owner: it names
    // KEY_SCOPE_FORBIDDEN, and the ownership check that answers 404 runs first.
    for (const { path } of perAgentTargets) {
      const forbidden = schema.paths[path].get.responses["403"];
      expect(forbidden, path).toBeDefined();
      expect(forbidden.description, path).toMatch(/^KEY_SCOPE_FORBIDDEN/);
      expect(forbidden.description, path).toMatch(/opaque 404/);
    }
  });

  it("the reads that take full access document their 403, and the scan names no server path", () => {
    const fullAccessReads = [
      "/api/stats",
      "/api/usage",
      "/api/agents/{namespace}/{name}/stats",
      "/api/runs",
      "/api/runs/{id}",
      "/api/agents/{namespace}/{name}/pull",
      "/api/agents/{namespace}/{name}/pull/{version}",
      "/api/agents/scan",
    ];
    for (const path of fullAccessReads) {
      const forbidden = schema.paths[path].get.responses["403"];
      expect(forbidden, path).toBeDefined();
      expect(forbidden.description, path).toMatch(
        /^KEY_SCOPE_FORBIDDEN — the key does not carry full access/,
      );
    }

    const versions = schema.paths["/api/agents/{namespace}/{name}/versions"].get;
    const item =
      versions.responses["200"].content["application/json"].schema.properties.versions.items;
    expect(item.required).not.toContain("config_snapshot");
    expect(item.properties.config_snapshot.description).toMatch(
      /Absent \(not null\) for a key without full access/,
    );

    // Setting a version's flag answers with the version: the same rule.
    const verified =
      schema.paths["/api/agents/{namespace}/{name}/versions/{version}/verify"].patch.responses[
        "200"
      ].content["application/json"].schema;
    expect(verified.required).not.toContain("config_snapshot");
    expect(verified.properties.config_snapshot.description).toMatch(
      /Absent \(not null\) for a key without full access/,
    );

    const scanItem =
      schema.paths["/api/agents/scan"].get.responses["200"].content["application/json"].schema
        .properties.agents.items;
    expect(scanItem.properties.path.description).toMatch(/Relative to SKRUN_AGENTS_DIR/);

    // Building from the agents directory reads the same disk: the same refusal,
    // before anything is read.
    const scanPush = schema.paths["/api/agents/scan/{name}/push"].post.responses["403"];
    expect(scanPush.description).toMatch(
      /^KEY_SCOPE_FORBIDDEN — the key does not carry full access/,
    );
    expect(scanPush.description).toMatch(/before the directory is read/);
  });

  // The machine-readable half of the published surface. The run path already
  // advertised a 429 while no request on it ever crossed the limiter; the push
  // path advertised none at all. Both are now true, and this pins them: a
  // generated client that does not know about 429 / 413 retries into a wall.
  // Every route that reads a body has a cap; the ones a client calls with a body
  // of its own say so, with the code their refusal carries.
  it("the run, the upload and the device-login routes document their 413", () => {
    const capped: Array<[string, RegExp]> = [
      ["/api/agents/{namespace}/{name}/run", /^REQUEST_TOO_LARGE/],
      ["/api/files", /^FILE_TOO_LARGE/],
      ["/auth/device/code", /^REQUEST_TOO_LARGE — .*SKRUN_MAX_BODY_MB/],
      ["/auth/device/token", /^REQUEST_TOO_LARGE — .*SKRUN_MAX_BODY_MB/],
    ];
    for (const [path, code] of capped) {
      // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
      const tooLarge = (schema.paths[path] as any).post.responses["413"];
      expect(tooLarge, path).toBeDefined();
      expect(tooLarge.description, path).toMatch(code);
    }
  });

  it("push documents 429 + 413, run keeps its 429, and /api/keys documents expires_at", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const push = schema.paths["/api/agents/{namespace}/{name}/push"] as any;
    expect(push.post.responses["429"]).toBeDefined();
    expect(push.post.responses["429"].description).toMatch(/RATE_LIMITED/);
    expect(push.post.responses["413"]).toBeDefined();
    expect(push.post.responses["413"].description).toMatch(/BUNDLE_TOO_LARGE/);
    expect(push.post.responses["413"].description).toMatch(/SKRUN_PUSH_MAX_BODY_MB/);

    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = schema.paths["/api/agents/{namespace}/{name}/run"] as any;
    expect(run.post.responses["429"]).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const keys = schema.paths["/api/keys"] as any;
    const reqSchema = keys.post.requestBody.content["application/json"].schema;
    expect(reqSchema.properties.expires_at).toBeDefined();
    expect(reqSchema.properties.expires_at.format).toBe("date-time");
    // Optional on the request — a delegated key gets no imposed lifetime.
    expect(reqSchema.required).not.toContain("expires_at");
    expect(keys.post.responses["400"]).toBeDefined();
    expect(
      keys.post.responses["201"].content["application/json"].schema.properties.expires_at,
    ).toBeDefined();
    expect(
      keys.get.responses["200"].content["application/json"].schema.items.properties.expires_at,
    ).toBeDefined();
  });

  it("creator LLM key endpoints + error codes documented", () => {
    const paths = Object.keys(schema.paths);
    expect(paths).toContain("/api/agents/{namespace}/{name}/llm-keys");
    expect(paths).toContain("/api/agents/{namespace}/{name}/llm-keys/{provider}");
    expect(paths).toContain("/api/agents/{namespace}/{name}/llm-key-policy");

    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const keys = schema.paths["/api/agents/{namespace}/{name}/llm-keys"] as any;
    // GET surfaces { policy, keys: [{ provider, last4, updated_at }] } — never the key.
    const getProps = keys.get.responses["200"].content["application/json"].schema.properties;
    expect(getProps.policy.enum).toEqual(["open", "creator_only"]);
    expect(getProps.keys.items.properties.last4).toBeDefined();
    expect(getProps.keys.items.properties.key).toBeUndefined();
    expect(keys.get.responses["403"]).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const provider = schema.paths["/api/agents/{namespace}/{name}/llm-keys/{provider}"] as any;
    expect(provider.put.responses["500"].description).toMatch(/ENCRYPTION_NOT_CONFIGURED/);
    expect(provider.put.responses["400"].description).toMatch(/INVALID_LLM_PROVIDER/);
    expect(provider.delete.responses["204"]).toBeDefined();

    // The run endpoint's 403 documents CALLER_KEY_NOT_ALLOWED.
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = schema.paths["/api/agents/{namespace}/{name}/run"] as any;
    expect(run.post.responses["403"].description).toMatch(/CALLER_KEY_NOT_ALLOWED/);
  });

  it("the run endpoint's 400 documents LLM_KEY_REQUIRED, refused before the run starts", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = schema.paths["/api/agents/{namespace}/{name}/run"] as any;
    const description = run.post.responses["400"].description as string;
    expect(description).toMatch(/LLM_KEY_REQUIRED/);
    expect(description).toMatch(/before any event stream opens/);
    expect(description).toMatch(/fallback model without a key does not refuse/);
    expect(description).toMatch(/primary has no key but whose fallback has one is accepted/);
  });

  it("the run endpoint's 503 documents SERVER_STOPPED: the run did not finish, running it again makes sense — and a run sent during the stop is refused before it starts", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = schema.paths["/api/agents/{namespace}/{name}/run"] as any;
    const stopped = run.post.responses["503"];
    expect(stopped).toBeDefined();
    expect(stopped.description).toMatch(/^SERVER_STOPPED — /);
    expect(stopped.description).toMatch(/synchronous/);
    expect(stopped.description).toMatch(/its tools may already have run/);
    expect(stopped.description).toContain(
      "The server is stopping and did not start this run; send it again.",
    );
    expect(stopped.description).toMatch(/no row was written/);
    expect(stopped.description).toContain(
      "A run whose row was being written as the stop began is not started either",
    );
    expect(stopped.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ErrorResponse",
    });
  });

  it("the run endpoint documents its quota refusals, their Retry-After and the account's numbers", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const responses = (schema.paths["/api/agents/{namespace}/{name}/run"] as any).post.responses;
    expect(responses["429"].description).toMatch(/^RATE_LIMITED — /);
    expect(responses["429"].description).toMatch(/CONCURRENCY_LIMIT_REACHED/);
    expect(responses["429"].description).toMatch(/COMPUTE_QUOTA_EXCEEDED/);
    expect(responses["503"].description).toMatch(/CAPACITY_EXHAUSTED/);
    expect(responses["400"].description).toMatch(/TIMEOUT_ABOVE_LIMIT/);
    expect(responses["400"].description).toMatch(/INVALID_ENVIRONMENT/);
    const numbers = [
      "X-Quota-Compute-Limit",
      "X-Quota-Compute-Remaining",
      "X-Quota-Compute-Reset",
      "X-Quota-Fast-Runs-Limit",
      "X-Quota-Fast-Runs-Remaining",
      "X-Quota-Runs-Limit",
      "X-Quota-Runs-Remaining",
    ];
    for (const status of ["200", "202"]) {
      expect({ status, headers: Object.keys(responses[status].headers).sort() }).toEqual({
        status,
        headers: numbers,
      });
    }
    for (const status of ["429", "503"]) {
      expect({ status, headers: Object.keys(responses[status].headers).sort() }).toEqual({
        status,
        headers: ["Retry-After", ...numbers],
      });
    }
    // Every header the admission sends is declared: a name added to the
    // server alone turns this red.
    expect(Object.keys(responses["200"].headers).sort()).toEqual(
      Object.values(QUOTA_HEADERS).sort(),
    );
    // The fast runs: only while a pre-warm pool runs, and a plan that includes
    // none is told its limit alone.
    expect(responses["200"].headers["X-Quota-Fast-Runs-Limit"].description).toMatch(
      /only while such a pool runs/,
    );
    expect(responses["200"].headers["X-Quota-Fast-Runs-Remaining"].description).toMatch(
      /Not sent for a plan that includes none/,
    );
  });

  it("the push, the push from the agents directory and the upload document their quota refusals", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const paths = schema.paths as any;
    for (const path of ["/api/agents/{namespace}/{name}/push", "/api/agents/scan/{name}/push"]) {
      const responses = paths[path].post.responses;
      expect(responses["400"].description, path).toMatch(/TIMEOUT_ABOVE_LIMIT/);
      expect(responses["413"].description, path).toMatch(/STORAGE_QUOTA_EXCEEDED/);
    }
    const upload = paths["/api/files"].post.responses["429"];
    expect(upload.description).toMatch(/^INPUT_FILES_LIMIT_REACHED — /);
    expect(Object.keys(upload.headers)).toEqual(["Retry-After"]);
  });

  it("both push routes document their 503 PUSH_BUSY: the reads that may wait, and its Retry-After", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const paths = schema.paths as any;
    for (const path of ["/api/agents/{namespace}/{name}/push", "/api/agents/scan/{name}/push"]) {
      const busy = paths[path].post.responses["503"];
      expect(busy?.description, path).toMatch(/PUSH_BUSY — /);
      expect(busy.description, path).toMatch(
        /reads at most two at once — a push's, or a run's first read of a bundle —, and a push that finds 16 waiting is refused/,
      );
      expect(busy.description, path).toMatch(/a run's read is never refused so/);
      expect(busy.description, path).toMatch(/Retry-After: 3/);
      expect(Object.keys(busy.headers), path).toEqual(["Retry-After"]);
    }
  });

  it("documents the account's usage: its plan, each bound or null, the fast runs only while a pre-warm pool runs", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const op = (schema.paths as any)["/api/usage"]?.get;
    expect(op?.operationId).toBe("getUsage");
    expect(Object.keys(op.responses).sort()).toEqual(["200", "401", "403", "404"]);
    expect(op.responses["404"].description).toMatch(/^NOT_FOUND — the account has no record/);
    expect(op.description).toMatch(/GET \/api\/me carries none of it/);
    const body = op.responses["200"].content["application/json"].schema;
    expect(body.required).toEqual(["plan", "quotas"]);
    const quotas = body.properties.quotas;
    expect(quotas.type).toEqual(["object", "null"]);
    expect(quotas.required).toEqual(["concurrent_runs", "compute", "fast_runs"]);
    const { concurrent_runs, compute, fast_runs } = quotas.properties;
    expect({
      concurrent_runs: [concurrent_runs.type, concurrent_runs.required],
      compute: [compute.type, compute.required],
      window: compute.properties.window.required,
      fast_runs: [fast_runs.type, fast_runs.required],
    }).toEqual({
      concurrent_runs: [
        ["object", "null"],
        ["limit", "in_use"],
      ],
      compute: [
        ["object", "null"],
        ["limit_seconds", "used_seconds", "window"],
      ],
      window: ["start", "end"],
      fast_runs: [
        ["object", "null"],
        ["limit", "remaining", "resets_at"],
      ],
    });
    expect({
      limit: fast_runs.properties.limit.type,
      remaining: fast_runs.properties.remaining.type,
      resets_at: fast_runs.properties.resets_at.type,
    }).toEqual({
      limit: ["integer", "null"],
      remaining: ["integer", "null"],
      resets_at: ["string", "null"],
    });
    expect(fast_runs.description).toMatch(/null while the server runs no pre-warm pool/);
    expect(fast_runs.properties.resets_at.description).toMatch(/plus one hour/);
  });

  it("documents the instance's links: docs always a string, terms and privacy a string or null, a 401 without a credential", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const op = (schema.paths["/api/instance"] as any).get;
    expect(op.operationId).toBe("getInstance");
    // Authenticated like every route under /api: no route-level override of the bearer scheme.
    expect(op.security).toBeUndefined();
    const body = op.responses["200"].content["application/json"].schema;
    expect(body.required).toEqual(["links"]);
    const links = body.properties.links;
    expect(links.required).toEqual(["docs", "terms", "privacy"]);
    expect(links.properties.docs.type).toBe("string");
    expect(links.properties.terms.type).toEqual(["string", "null"]);
    expect(links.properties.privacy.type).toEqual(["string", "null"]);
    expect(op.responses["401"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ErrorResponse",
    );
  });

  it("documents the operator's sign-in page as a redirect of /login, and the configured path of the callback", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const login = (schema.paths["/login"] as any).get;
    expect(Object.keys(login.responses).sort()).toEqual(["200", "302"]);
    expect(login.responses["302"].description).toMatch(/sign-in page/);
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const callback = (schema.paths["/auth/github/callback"] as any).get;
    expect(callback.description).toMatch(
      /the configured path\s+on the site's origin, its root by default/,
    );
    expect(callback.responses["302"].description).toMatch(/its root by default/);
  });

  it("every rate-limited route documents its 429 with Retry-After", () => {
    const limited: Array<[string, string]> = [
      ["/api/agents/{namespace}/{name}/run", "post"],
      ["/api/agents/{namespace}/{name}/push", "post"],
      ["/auth/device/code", "post"],
      ["/auth/device/token", "post"],
    ];
    for (const [path, method] of limited) {
      // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
      const tooMany = (schema.paths[path] as any)[method].responses["429"];
      expect({ path, retryAfter: tooMany?.headers?.["Retry-After"] !== undefined }).toEqual({
        path,
        retryAfter: true,
      });
    }
  });

  it("documents the plan assignment: a plan body, its codes, and the plan written", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const op = (schema.paths as any)["/api/admin/accounts/{id}/plan"]?.put;
    expect(op?.operationId).toBe("adminAssignAccountPlan");
    expect(op.requestBody.required).toBe(true);
    expect(op.requestBody.content["application/json"].schema.required).toEqual(["plan"]);
    expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "403", "404"]);
    expect(op.responses["200"].content["application/json"].schema.required).toEqual(["id", "plan"]);
    expect(op.responses["400"].description).toMatch(/^UNKNOWN_PLAN — /);
    expect(op.responses["403"].description).toMatch(/^KEY_SCOPE_FORBIDDEN — /);
    expect(op.parameters.map((p: { name: string; in: string }) => [p.name, p.in])).toEqual([
      ["id", "path"],
    ]);
  });

  it("the run detail says what a run's record keeps of a large input, output or error", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = (schema.paths["/api/runs/{id}"] as any).get.responses["200"].content[
      "application/json"
    ].schema.properties;
    expect(run.input.description).toMatch(/8 KiB/);
    expect(run.input.description).toContain('"_truncated"');
    expect(run.output.description).toMatch(/32 KiB/);
    expect(run.error.description).toContain("… [truncated: N bytes]");
  });

  it("the run endpoint's 400 documents RETIRED_FIELD for an environment override", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = schema.paths["/api/agents/{namespace}/{name}/run"] as any;
    const description = run.post.responses["400"].description as string;
    expect(description).toMatch(/RETIRED_FIELD/);
    expect(description).toMatch(/environment\.sandbox/);
  });

  it("documents the fresh link to a run's output file, its two forms and its refusals", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const link = schema.paths["/api/runs/{run_id}/files/{filename}/link"] as any;
    expect(link.get.operationId).toBe("getRunFileLink");
    const ok = link.get.responses["200"].content["application/json"].schema;
    expect(ok.required).toEqual(["url", "expires_at"]);
    expect(ok.properties.expires_at.type).toEqual(["string", "null"]);
    expect(link.get.description).toMatch(/Content-Disposition: attachment/);
    expect(link.get.description).toMatch(/Cache-Control: no-store/);
    expect(link.get.responses["403"].description).toMatch(/KEY_SCOPE_FORBIDDEN/);
    expect(link.get.responses["404"].description).toMatch(/RUN_NOT_FOUND/);
    expect(link.get.responses["404"].description).toMatch(/FILE_NOT_FOUND/);
    expect(link.get.responses["410"].description).toMatch(/FILE_EXPIRED/);
  });

  it("the run endpoint's environment override presents neither the retired sandbox and filesystem fields nor secrets", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = schema.paths["/api/agents/{namespace}/{name}/run"] as any;
    const environment = run.post.requestBody.content["application/json"].schema.properties
      .environment as { properties: Record<string, unknown> };
    expect(Object.keys(environment.properties)).toEqual(["networking", "timeout", "max_cost"]);
    expect(environment.properties).not.toHaveProperty("sandbox");
    expect(environment.properties).not.toHaveProperty("filesystem");
    expect(environment.properties).not.toHaveProperty("secrets");
  });

  it("names the refusals of a bundle that does not load: the push its five codes, the push from the agents directory the five it can meet", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const paths = schema.paths as any;
    const push = paths["/api/agents/{namespace}/{name}/push"].post.responses;
    for (const code of ["BUNDLE_CORRUPT", "MISSING_CONFIG", "INVALID_CONFIG"]) {
      expect(push["400"].description, code).toContain(code);
    }
    // An archive an entry of which cannot be written out: BUNDLE_CORRUPT too.
    expect(push["400"].description).toMatch(
      /BUNDLE_CORRUPT: .*an entry of which cannot be written out/,
    );
    expect(push["413"].description).toContain("BUNDLE_DECOMPRESSED_TOO_LARGE");
    expect(push["413"].description).toMatch(/decompresses to more than the cap/);
    // An agent.yaml past its fixed 128 KB: a 413 of its own, at both entrypoints.
    expect(push["413"].description).toMatch(/CONFIG_TOO_LARGE — .*128 KB \(131,072 bytes\)/);
    // The directory's bundle is built by the server: it always unpacks and its
    // files never contradict each other, but a path of it can be too long; a
    // directory without agent.yaml is refused by its own code.
    const scan = paths["/api/agents/scan/{name}/push"].post.responses;
    for (const code of ["BUNDLE_CORRUPT", "MISSING_CONFIG", "INVALID_CONFIG"]) {
      expect(scan["400"].description, code).toContain(code);
    }
    expect(scan["400"].description).toMatch(/BUNDLE_CORRUPT, as for a push: .*over 1,024 bytes/);
    expect(scan["413"].description).toContain("BUNDLE_DECOMPRESSED_TOO_LARGE");
    expect(scan["413"].description).toContain("CONFIG_TOO_LARGE");
  });

  it("names what a run answers for a stored bundle it cannot extract: 422 past the cap, 500 otherwise", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = (schema.paths as any)["/api/agents/{namespace}/{name}/run"].post.responses;
    expect(run["422"].description).toMatch(/^BUNDLE_DECOMPRESSED_TOO_LARGE — /);
    expect(run["422"].description).toContain("BUNDLE_MAX_DECOMPRESSED_MB");
    for (const code of [
      "BUNDLE_CORRUPT",
      "MISSING_CONFIG",
      "INVALID_CONFIG",
      "BUNDLE_NOT_FOUND",
      "BUNDLE_INTEGRITY_FAILED",
      "CREATOR_KEY_UNREADABLE",
    ]) {
      expect(run["500"].description, code).toContain(code);
    }
    expect(run["500"].description).not.toContain("BUNDLE_DECOMPRESSED_TOO_LARGE");
    // An error no route handles is the app's own answer: a plain-text 500,
    // wherever it happens — not a JSON code answered before the run starts.
    expect(Object.keys(run["500"].content)).toEqual(["application/json", "text/plain"]);
    expect(run["500"].description).toContain("plain-text body, Internal Server Error");
  });

  it("names the refusals of a setting that no code honours: each push entrypoint its three codes, the run those of its override", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const paths = schema.paths as any;
    for (const path of ["/api/agents/{namespace}/{name}/push", "/api/agents/scan/{name}/push"]) {
      const description = paths[path].post.responses["400"].description as string;
      for (const code of ["UNSUPPORTED_FIELD", "MODEL_BASE_URL_REQUIRED", "TIMEOUT_OUT_OF_RANGE"]) {
        expect(description, `${path} ${code}`).toContain(code);
      }
      expect(description, path).toMatch(/whatever bounds the server sets/);
      expect(description, path).toMatch(/before anything is stored/);
    }
    const run = paths["/api/agents/{namespace}/{name}/run"].post;
    const runRefusals = run.responses["400"].description as string;
    for (const code of ["UNSUPPORTED_FIELD", "TIMEOUT_OUT_OF_RANGE"]) {
      expect(runRefusals, code).toContain(code);
    }
    expect(runRefusals).toMatch(/environment\.filesystem/);
    expect(runRefusals).toMatch(/judged as sent/);
    const override = run.requestBody.content["application/json"].schema.properties.environment
      .description as string;
    for (const code of ["RETIRED_FIELD", "UNSUPPORTED_FIELD", "TIMEOUT_OUT_OF_RANGE"]) {
      expect(override, code).toContain(code);
    }
    expect(override).toMatch(/\(sandbox, filesystem\)/);
  });

  it("names the run's synchronous and missing-input refusals, and its 502s: a failed execution, an MCP connection failure, a file input's failed fetch", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const run = (schema.paths as any)["/api/agents/{namespace}/{name}/run"].post;
    const description = run.description as string;
    expect(description).toMatch(/on the local runtime only/);
    expect(description).toContain("SYNC_MODE_UNSUPPORTED");
    const refusals = run.responses["400"].description as string;
    for (const code of ["INVALID_REQUEST", "SYNC_MODE_UNSUPPORTED"]) {
      expect(refusals, code).toContain(code);
    }
    expect(refusals).toMatch(/an object with no input \(\{\} included\)/);
    expect(refusals).toMatch(/on the flyio runtime only/);
    expect(refusals).toMatch(/never a 404/);
    const failures = run.responses["502"].description as string;
    for (const code of ["EXECUTION_FAILED", "MCP_CONNECT_FAILED", "URL_FETCH_FAILED"]) {
      expect(failures, code).toContain(code);
    }
    expect(failures).toMatch(/by its origin only/);
    expect(failures).toContain("a URL with no origin");
  });

  it("says public visibility is disabled for now, and promises nothing in its place", () => {
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/marketplace/i);
    // biome-ignore lint/suspicious/noExplicitAny: deep schema traversal in a test
    const setVisibility = schema.paths["/api/agents/{namespace}/{name}/visibility"] as any;
    expect(setVisibility.patch.description).toMatch(/PUBLIC_VISIBILITY_DISABLED for now/);
  });
});
