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
});
