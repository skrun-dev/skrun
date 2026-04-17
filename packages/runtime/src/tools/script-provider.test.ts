import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptToolProvider } from "./script-provider.js";

describe("ScriptToolProvider", () => {
  let tmpDir: string;
  let scriptsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skrun-tool-"));
    scriptsDir = join(tmpDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    // Tiny echo script: reads JSON from stdin, echoes it on stdout
    writeFileSync(
      join(scriptsDir, "echo.js"),
      `let data=""; process.stdin.on("data",c=>data+=c); process.stdin.on("end",()=>{process.stdout.write(data);});`,
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const echoTool: ToolConfig = {
    name: "echo",
    description: "Echo the input back",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
  };

  it("listTools returns declared input_schema (not the stub)", async () => {
    const provider = new ScriptToolProvider(scriptsDir, [echoTool]);
    const tools = await provider.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");
    expect(tools[0].description).toBe("Echo the input back");
    expect(tools[0].parameters).toEqual(echoTool.input_schema);
  });

  it("rejects args with missing required field and does not spawn script", async () => {
    const provider = new ScriptToolProvider(scriptsDir, [echoTool]);
    const result = await provider.callTool("echo", {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Invalid arguments for tool 'echo'/);
    expect(result.content).toMatch(/message|required/i);
  });

  it("runs the script with valid args", async () => {
    const provider = new ScriptToolProvider(scriptsDir, [echoTool]);
    const result = await provider.callTool("echo", { message: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
  });

  it("rejects extra field when additionalProperties:false", async () => {
    const provider = new ScriptToolProvider(scriptsDir, [echoTool]);
    const result = await provider.callTool("echo", { message: "hi", extra: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Invalid arguments/);
  });

  it("rejects a tool not declared in agent.yaml", async () => {
    const provider = new ScriptToolProvider(scriptsDir, [echoTool]);
    const result = await provider.callTool("unknown", {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not declared in agent\.yaml/);
  });

  it("passes SKRUN_ALLOWED_HOSTS env var to subprocess (VT-12)", async () => {
    // Write a script that outputs the env var
    writeFileSync(
      join(scriptsDir, "check-env.js"),
      `process.stdout.write(process.env.SKRUN_ALLOWED_HOSTS || "MISSING");`,
      "utf-8",
    );
    const envTool: ToolConfig = {
      name: "check-env",
      description: "Check env var",
      input_schema: { type: "object", properties: {}, additionalProperties: true },
    };
    const provider = new ScriptToolProvider(
      scriptsDir,
      [envTool],
      ["api.github.com", "*.slack.com"],
    );
    const result = await provider.callTool("check-env", {});
    expect(result.isError).toBe(false);
    expect(result.content).toBe("api.github.com,*.slack.com");
  });

  it("passes empty SKRUN_ALLOWED_HOSTS when allowedHosts is empty", async () => {
    writeFileSync(
      join(scriptsDir, "check-env2.js"),
      `process.stdout.write(process.env.SKRUN_ALLOWED_HOSTS ?? "UNDEFINED");`,
      "utf-8",
    );
    const envTool: ToolConfig = {
      name: "check-env2",
      description: "Check env var empty",
      input_schema: { type: "object", properties: {}, additionalProperties: true },
    };
    const provider = new ScriptToolProvider(scriptsDir, [envTool], []);
    const result = await provider.callTool("check-env2", {});
    expect(result.isError).toBe(false);
    expect(result.content).toBe("");
  });

  it("rejects a declared tool whose script file is missing", async () => {
    const ghost: ToolConfig = {
      name: "ghost",
      description: "No matching script",
      input_schema: { type: "object", properties: {}, additionalProperties: true },
    };
    const provider = new ScriptToolProvider(scriptsDir, [ghost]);
    const result = await provider.callTool("ghost", {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not found in scripts\//);
  });
});
