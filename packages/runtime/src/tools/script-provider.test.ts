import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptDepsInstallError } from "../errors.js";
import type { ResolvedDeps } from "./script-deps-resolver.js";
import { ScriptToolProvider } from "./script-provider.js";

/**
 * Sub-class that overrides `getDepsResolved` to return canned values without
 * touching the actual cache + installers. Lets us assert on the spawn cmd
 * + env without setting up a real venv or a real node_modules tree.
 */
class StubDepsScriptToolProvider extends ScriptToolProvider {
  constructor(
    scriptsDir: string,
    tools: ToolConfig[],
    allowedHosts: string[],
    outputDir: string,
    private readonly stubResult: ResolvedDeps | null,
    private readonly stubError?: Error,
  ) {
    super(scriptsDir, tools, allowedHosts, outputDir);
  }

  protected override getDepsResolved(): Promise<ResolvedDeps | null> {
    if (this.stubError) return Promise.reject(this.stubError);
    return Promise.resolve(this.stubResult);
  }
}

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

  // SEC-021: ENOBUFS path produces a clear, actionable error instead of the
  // opaque "stdout maxBuffer length exceeded" default. The buffer cap is
  // 5 MB; a script writing more than that to stdout trips the branch.
  it("SEC-021: surfaces a clear error when script output exceeds maxBuffer", async () => {
    const floodScriptName = "flood.js";
    writeFileSync(
      join(scriptsDir, floodScriptName),
      // Emit ~6MB on stdout (> 5MB cap). Avoid using stdin so the read end
      // doesn't block; just print and exit. The .on('end')-style stdin loop
      // is unused for this script.
      "process.stdout.write('x'.repeat(6 * 1024 * 1024));",
      "utf-8",
    );
    const floodTool: ToolConfig = {
      name: "flood",
      description: "Flood stdout to trigger maxBuffer",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
    const provider = new ScriptToolProvider(scriptsDir, [floodTool]);
    const result = await provider.callTool("flood", {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/exceeded.*buffer cap|maxBuffer/i);
    // The error must mention SKRUN_OUTPUT_DIR as the recommended escape hatch.
    expect(result.content).toMatch(/SKRUN_OUTPUT_DIR/);
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

  // --- Script-deps integration (#57 Task 5.2b) ---------------------------

  describe("script-deps resolution branching (#57)", () => {
    it("RT-1: no deps configured → spawns system node and runs unchanged", async () => {
      // Default ctor (no options) = legacy path. Existing test above already
      // covers this — this test re-confirms with explicit assertion that
      // spawn proceeds without any NODE_PATH or venv injection.
      writeFileSync(
        join(scriptsDir, "check-node-path.js"),
        `process.stdout.write(process.env.NODE_PATH ?? "UNDEFINED");`,
        "utf-8",
      );
      const tool: ToolConfig = {
        name: "check-node-path",
        description: "Echo NODE_PATH",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      };
      const provider = new ScriptToolProvider(scriptsDir, [tool]);
      const result = await provider.callTool("check-node-path", {});
      expect(result.isError).toBe(false);
      // No deps wired → NODE_PATH should be undefined (or whatever was inherited from process.env).
      // We just confirm we didn't inject a hash-cache path.
      expect(result.content).not.toMatch(/\.skrun[/\\]deps[/\\][0-9a-f]{64}/);
    });

    it("Node deps resolved → injects NODE_PATH=<depsPath>/node_modules into spawn env", async () => {
      // Set up a fake `node_modules/marker` package in a fake depsPath. The
      // script reads NODE_PATH and confirms the injection.
      const fakeDepsPath = mkdtempSync(join(tmpdir(), "skrun-fake-node-deps-"));
      try {
        mkdirSync(join(fakeDepsPath, "node_modules", "marker"), { recursive: true });
        writeFileSync(
          join(fakeDepsPath, "node_modules", "marker", "package.json"),
          '{"name":"marker","main":"index.js"}',
        );
        writeFileSync(
          join(fakeDepsPath, "node_modules", "marker", "index.js"),
          "module.exports = { value: 'INJECTED' };",
        );

        writeFileSync(
          join(scriptsDir, "uses-node-path.js"),
          `process.stdout.write(process.env.NODE_PATH ?? "MISSING");`,
          "utf-8",
        );

        const tool: ToolConfig = {
          name: "uses-node-path",
          description: "Read NODE_PATH",
          input_schema: { type: "object", properties: {}, additionalProperties: true },
        };

        const provider = new StubDepsScriptToolProvider(scriptsDir, [tool], [], "", {
          ecosystem: "node",
          depsPath: fakeDepsPath,
        });

        const result = await provider.callTool("uses-node-path", {});
        expect(result.isError).toBe(false);
        expect(result.content).toBe(join(fakeDepsPath, "node_modules"));
      } finally {
        rmSync(fakeDepsPath, { recursive: true, force: true });
      }
    });

    it("Python deps resolved → spawns venv-local python (path is platform-aware)", async () => {
      // Build a fake depsPath where the venv python doesn't actually exist.
      // The spawn will fail with ENOENT, but the resulting error includes the
      // attempted command path — that's all we need to assert that we tried
      // the venv python rather than the system one.
      const fakeDepsPath = mkdtempSync(join(tmpdir(), "skrun-fake-py-deps-"));
      try {
        writeFileSync(join(scriptsDir, "noop.py"), "print('hi')", "utf-8");
        const tool: ToolConfig = {
          name: "noop",
          description: "Noop python",
          input_schema: { type: "object", properties: {}, additionalProperties: true },
        };

        const provider = new StubDepsScriptToolProvider(scriptsDir, [tool], [], "", {
          ecosystem: "python",
          depsPath: fakeDepsPath,
        });

        const result = await provider.callTool("noop", {});
        // Spawn fails (no python.exe at that path) — that's fine. We assert
        // the failure references the venv python path.
        expect(result.isError).toBe(true);
        const expectedSubstring =
          process.platform === "win32"
            ? join(fakeDepsPath, "venv", "Scripts", "python.exe")
            : join(fakeDepsPath, "venv", "bin", "python");
        expect(result.content).toContain(expectedSubstring);
      } finally {
        rmSync(fakeDepsPath, { recursive: true, force: true });
      }
    });

    it("VT-20: install failure → returns isError WITHOUT spawning the script", async () => {
      const installError = new ScriptDepsInstallError({
        ecosystem: "python",
        command: "python -m venv ...",
        exitCode: 1,
        stderr: "Python is not installed",
      });

      // Use a script path that would CRASH (syntax error) if it ever ran.
      // The test passes only if the script never spawns — i.e., we return
      // the install error directly.
      writeFileSync(
        join(scriptsDir, "would-crash.js"),
        `throw new Error("If you see this, the script ran when it shouldn't have");`,
        "utf-8",
      );
      const tool: ToolConfig = {
        name: "would-crash",
        description: "Should never run",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      };

      const provider = new StubDepsScriptToolProvider(
        scriptsDir,
        [tool],
        [],
        "",
        null,
        installError,
      );

      const result = await provider.callTool("would-crash", {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("SCRIPT_DEPS_INSTALL_FAILED");
      // The original error message must surface to the LLM tool-call loop.
      expect(result.content).toContain("python -m venv");
    });
  });

  // --- SEC-003: env allowlist on spawned scripts ----------------------------
  describe("env allowlist (SEC-003)", () => {
    it("VT-5: spawned script cannot read server-side LLM API keys via process.env", async () => {
      const previousAnthropic = process.env.ANTHROPIC_API_KEY;
      const previousOpenai = process.env.OPENAI_API_KEY;
      const previousWebhook = process.env.WEBHOOK_SIGNING_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-TEST-SHOULD-NOT-LEAK-12345";
      process.env.OPENAI_API_KEY = "sk-TEST-SHOULD-NOT-LEAK-67890";
      process.env.WEBHOOK_SIGNING_KEY = "TEST-WEBHOOK-KEY-SHOULD-NOT-LEAK";

      try {
        writeFileSync(
          join(scriptsDir, "leak-attempt.js"),
          // Try to exfiltrate every secret category at once.
          `process.stdout.write(JSON.stringify({
             anthropic: process.env.ANTHROPIC_API_KEY ?? "MISSING",
             openai: process.env.OPENAI_API_KEY ?? "MISSING",
             webhook: process.env.WEBHOOK_SIGNING_KEY ?? "MISSING",
           }));`,
          "utf-8",
        );
        const tool: ToolConfig = {
          name: "leak-attempt",
          description: "Try to read secrets",
          input_schema: { type: "object", properties: {}, additionalProperties: true },
        };
        const provider = new ScriptToolProvider(scriptsDir, [tool]);
        const result = await provider.callTool("leak-attempt", {});
        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.content as string);
        expect(parsed.anthropic).toBe("MISSING");
        expect(parsed.openai).toBe("MISSING");
        expect(parsed.webhook).toBe("MISSING");
      } finally {
        if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousAnthropic;
        if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousOpenai;
        if (previousWebhook === undefined) delete process.env.WEBHOOK_SIGNING_KEY;
        else process.env.WEBHOOK_SIGNING_KEY = previousWebhook;
      }
    });

    it("VT-5: SKRUN_* vars still pass through (contract preserved)", async () => {
      const previous = process.env.SKRUN_CUSTOM_VAR;
      process.env.SKRUN_CUSTOM_VAR = "skrun-contract-value";
      try {
        writeFileSync(
          join(scriptsDir, "skrun-check.js"),
          `process.stdout.write(process.env.SKRUN_CUSTOM_VAR ?? "MISSING");`,
          "utf-8",
        );
        const tool: ToolConfig = {
          name: "skrun-check",
          description: "Check SKRUN_* pass-through",
          input_schema: { type: "object", properties: {}, additionalProperties: true },
        };
        const provider = new ScriptToolProvider(scriptsDir, [tool]);
        const result = await provider.callTool("skrun-check", {});
        expect(result.isError).toBe(false);
        expect(result.content).toBe("skrun-contract-value");
      } finally {
        if (previous === undefined) delete process.env.SKRUN_CUSTOM_VAR;
        else process.env.SKRUN_CUSTOM_VAR = previous;
      }
    });

    it("VT-5: PATH still propagates (so 'node' binary is findable)", async () => {
      writeFileSync(
        join(scriptsDir, "path-check.js"),
        `process.stdout.write(process.env.PATH ? "HAS_PATH" : "NO_PATH");`,
        "utf-8",
      );
      const tool: ToolConfig = {
        name: "path-check",
        description: "Check PATH propagation",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      };
      const provider = new ScriptToolProvider(scriptsDir, [tool]);
      const result = await provider.callTool("path-check", {});
      expect(result.isError).toBe(false);
      expect(result.content).toBe("HAS_PATH");
    });
  });

  // Bug A (audit/002): scripts spawned with cwd anchored at the bundle root
  // so relative paths in user-authored scripts resolve from the bundle dir,
  // not from the registry's own process.cwd(). Closes the silent failure
  // pattern surfaced by `csv-to-executive-report` (which tried to read
  // `./fixtures/sample-revenue.csv` and found nothing).
  describe("Bug A: script cwd anchored at bundleRoot", () => {
    it("spawns scripts with cwd === options.bundleRoot when set", async () => {
      // Tiny script that prints its own process.cwd() to stdout
      writeFileSync(
        join(scriptsDir, "where.js"),
        `let _=""; process.stdin.on("data",c=>_+=c); process.stdin.on("end",()=>{process.stdout.write(process.cwd());});`,
        "utf-8",
      );
      const tool: ToolConfig = {
        name: "where",
        description: "Print cwd",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      };
      const provider = new ScriptToolProvider(scriptsDir, [tool], [], "", {
        bundleRoot: tmpDir,
      });
      const result = await provider.callTool("where", {});
      expect(result.isError).toBe(false);
      // On macOS/Linux tmpdir() may include `/private/var/...` or `/var/...`
      // depending on platform; we just assert the cwd ends with the bundle
      // root's basename to keep the assertion robust across OSes.
      expect(result.content).toContain(tmpDir);
    });

    it("falls back to process.cwd() when bundleRoot is unset (legacy path)", async () => {
      writeFileSync(
        join(scriptsDir, "where.js"),
        `let _=""; process.stdin.on("data",c=>_+=c); process.stdin.on("end",()=>{process.stdout.write(process.cwd());});`,
        "utf-8",
      );
      const tool: ToolConfig = {
        name: "where",
        description: "Print cwd",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      };
      // No bundleRoot in options — legacy path
      const provider = new ScriptToolProvider(scriptsDir, [tool]);
      const result = await provider.callTool("where", {});
      expect(result.isError).toBe(false);
      // Just assert it returns some path (parent process cwd). We don't pin
      // the exact value since the test runner's cwd varies between local and
      // CI environments.
      expect(result.content.length).toBeGreaterThan(0);
    });
  });
});
