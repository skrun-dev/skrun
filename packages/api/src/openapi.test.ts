import { describe, expect, it } from "vitest";
import { getOpenAPISchema } from "./openapi.js";

describe("OpenAPI Schema", () => {
  const schema = getOpenAPISchema();

  it("has openapi 3.1.0 version", () => {
    expect(schema.openapi).toBe("3.1.0");
  });

  it("has all 9 endpoint paths", () => {
    const paths = Object.keys(schema.paths);
    expect(paths).toContain("/health");
    expect(paths).toContain("/api/agents/{namespace}/{name}/run");
    expect(paths).toContain("/api/agents/{namespace}/{name}/push");
    expect(paths).toContain("/api/agents/{namespace}/{name}/pull");
    expect(paths).toContain("/api/agents/{namespace}/{name}/pull/{version}");
    expect(paths).toContain("/api/agents");
    expect(paths).toContain("/api/agents/{namespace}/{name}");
    expect(paths).toContain("/api/agents/{namespace}/{name}/versions");
    expect(paths).toContain("/api/agents/{namespace}/{name}/verify");
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
});
