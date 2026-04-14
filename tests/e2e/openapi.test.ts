import { describe, expect, it } from "vitest";
import { createTestApp } from "./setup.js";

describe("E2E: OpenAPI", () => {
  const { app } = createTestApp();

  it("GET /openapi.json returns valid OpenAPI schema", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths).toBeDefined();
  });

  it("GET /openapi.json contains all endpoint paths", async () => {
    const res = await app.request("/openapi.json");
    const body = (await res.json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(body.paths);
    expect(paths).toContain("/health");
    expect(paths).toContain("/api/agents/{namespace}/{name}/run");
    expect(paths).toContain("/api/agents/{namespace}/{name}/push");
    expect(paths).toContain("/api/agents");
    expect(paths).toContain("/api/agents/{namespace}/{name}/verify");
  });

  it("GET /docs returns HTML page", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
  });

  it("existing health endpoint still works", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.status).toBe("ok");
  });
});
