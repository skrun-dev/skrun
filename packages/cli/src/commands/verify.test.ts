import { describe, expect, it } from "vitest";
import { parseAgentRef } from "./verify.js";

describe("parseAgentRef", () => {
  it("UAT-33: parses canonical <namespace>/<name>@<version> syntax", () => {
    expect(parseAgentRef("ops/myagent@1.0.0")).toEqual({
      namespace: "ops",
      name: "myagent",
      version: "1.0.0",
    });
  });

  it("accepts kebab-case namespace + name", () => {
    expect(parseAgentRef("my-ns/my-agent@1.0.0")).toEqual({
      namespace: "my-ns",
      name: "my-agent",
      version: "1.0.0",
    });
  });

  it("accepts version with prerelease + build metadata", () => {
    expect(parseAgentRef("ops/a@1.0.0-rc.1+build.42")).toEqual({
      namespace: "ops",
      name: "a",
      version: "1.0.0-rc.1+build.42",
    });
  });

  it("rejects missing @version (forces explicit version)", () => {
    expect(parseAgentRef("ops/myagent")).toBeNull();
  });

  it("rejects single-segment (no namespace separator)", () => {
    expect(parseAgentRef("myagent")).toBeNull();
  });

  it("rejects uppercase / illegal chars in segments", () => {
    expect(parseAgentRef("Ops/myagent@1.0.0")).toBeNull();
    expect(parseAgentRef("ops/My_Agent@1.0.0")).toBeNull();
  });

  it("rejects empty version after @", () => {
    expect(parseAgentRef("ops/agent@")).toBeNull();
  });

  it("rejects empty arg", () => {
    expect(parseAgentRef("")).toBeNull();
  });
});
