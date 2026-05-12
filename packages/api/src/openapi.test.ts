import { describe, expect, it } from "vitest";
import { getOpenAPISchema } from "./openapi.js";

describe("OpenAPI Schema", () => {
  const schema = getOpenAPISchema();

  it("has openapi 3.1.0 version", () => {
    expect(schema.openapi).toBe("3.1.0");
  });

  it("has all 10 endpoint paths", () => {
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
    expect(paths).toContain("/api/agents/{namespace}/{name}/verify");
  });

  // --- deleteAgentVersion (#77) ---

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

  // --- Version pinning schema (#7) ---

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

  // SC-10 (#68 prompt-caching) — OpenAPI schema documents the new optional
  // cache fields on RunResult.usage. Catches drift between code and schema.
  it("RunResult.usage exposes optional cache_read_tokens + cache_write_tokens (#68)", () => {
    const usage = schema.components.schemas.RunResult.properties.usage;
    expect(usage.properties.cache_read_tokens).toBeDefined();
    expect(usage.properties.cache_read_tokens.type).toBe("integer");
    expect(usage.properties.cache_write_tokens).toBeDefined();
    expect(usage.properties.cache_write_tokens.type).toBe("integer");
    // Pre-#68 fields preserved.
    expect(usage.properties.prompt_tokens.type).toBe("integer");
    expect(usage.properties.completion_tokens.type).toBe("integer");
    expect(usage.properties.total_tokens.type).toBe("integer");
  });

  // VT-18 — cache cost-savings fields documented across Run + Stats + AgentStats
  // schemas + RunResult.cost.saved. Catches drift between the wire format and
  // the schema, which dashboard / SDK consumers depend on.
  it("VT-18: cache cost-savings fields documented across all 4 surfaces", () => {
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
});
