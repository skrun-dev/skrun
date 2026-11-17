// Tests for `skrun build` file inclusion/exclusion logic (#57 SC-5, SC-6).
//
// We exercise `collectFiles` directly rather than running `runBuild` end-to-end:
// the exclusion contract is consumed exclusively by `collectFiles`, which then
// feeds the shared tar codec (`packAgentTar`). Verifying the file list returned
// by `collectFiles` is a sufficient unit test for the exclusion contract — the
// tar packaging itself (POSIX names, round-trip, binary fidelity) is covered by
// the codec's own tests in `@skrun-dev/schema`.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AGENT_BUNDLE_EXCLUDES, RETIRED_MODELS, type RetiredModel } from "@skrun-dev/schema";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliExit } from "../utils/exit.js";
import {
  buildBundle,
  collectFiles,
  configSizeWarning,
  decompressedSize,
  registerBuildCommand,
  sizeWarning,
} from "./build.js";

let bundle: string;

beforeEach(() => {
  bundle = mkdtempSync(join(tmpdir(), "skrun-build-test-"));
});

afterEach(() => {
  rmSync(bundle, { recursive: true, force: true });
});

function writeIn(relativePath: string, content: string): void {
  const full = join(bundle, relativePath);
  const parent = dirname(full);
  if (parent !== bundle) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content);
}

describe("AGENT_BUNDLE_EXCLUDES (shared exclude contract)", () => {
  it("includes the legacy patterns", () => {
    expect(AGENT_BUNDLE_EXCLUDES.has("node_modules")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has(".git")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has("dist")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has(".env")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has(".DS_Store")).toBe(true);
  });

  it("includes the #57 Python deps cache patterns", () => {
    expect(AGENT_BUNDLE_EXCLUDES.has("__pycache__")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has(".pytest_cache")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has("venv")).toBe(true);
    expect(AGENT_BUNDLE_EXCLUDES.has(".venv")).toBe(true);
  });
});

describe("collectFiles — manifest packaging (SC-6)", () => {
  it("includes package.json + package-lock.json", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("package.json", '{"name":"x"}');
    writeIn("package-lock.json", '{"lockfileVersion":3}');
    const files = await collectFiles(bundle);
    expect(files).toContain("package.json");
    expect(files).toContain("package-lock.json");
  });

  it("includes requirements.txt", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("requirements.txt", "pandas==2.2.3\n");
    const files = await collectFiles(bundle);
    expect(files).toContain("requirements.txt");
  });

  it("includes pyproject.toml + uv.lock", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("pyproject.toml", '[project]\nname = "x"\n');
    writeIn("uv.lock", "version = 1\n");
    const files = await collectFiles(bundle);
    expect(files).toContain("pyproject.toml");
    expect(files).toContain("uv.lock");
  });

  it("includes pnpm-lock.yaml and yarn.lock when present", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("package.json", '{"name":"x"}');
    writeIn("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeIn("yarn.lock", "# yarn lockfile v1\n");
    const files = await collectFiles(bundle);
    expect(files).toContain("pnpm-lock.yaml");
    expect(files).toContain("yarn.lock");
  });
});

describe("collectFiles — deps directories excluded (SC-5)", () => {
  it("excludes node_modules/", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("package.json", '{"name":"x"}');
    writeIn("node_modules/jszip/package.json", '{"name":"jszip"}');
    writeIn("node_modules/jszip/index.js", "module.exports = {};");
    const files = await collectFiles(bundle);
    expect(files).toContain("package.json");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("excludes venv/ (Unix-style Python venv)", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("requirements.txt", "pandas\n");
    writeIn("venv/bin/python", "#!/usr/bin/env python3");
    writeIn("venv/lib/python3.11/site-packages/pandas/__init__.py", "");
    const files = await collectFiles(bundle);
    expect(files).toContain("requirements.txt");
    expect(files.some((f) => f.includes("venv"))).toBe(false);
  });

  it("excludes .venv/ (alternative Python venv naming)", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("pyproject.toml", "[project]\nname = 'x'\n");
    writeIn(".venv/bin/python", "");
    writeIn(".venv/Lib/site-packages/numpy/__init__.py", "");
    const files = await collectFiles(bundle);
    expect(files).toContain("pyproject.toml");
    expect(files.some((f) => f.includes(".venv"))).toBe(false);
  });

  it("excludes __pycache__/ and .pytest_cache/", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("scripts/util.py", "import os\n");
    writeIn("scripts/__pycache__/util.cpython-311.pyc", "compiled-bytecode");
    writeIn(".pytest_cache/v/cache/lastfailed", "{}");
    writeIn(".pytest_cache/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55");
    const files = await collectFiles(bundle);
    expect(files).toContain(join("scripts", "util.py"));
    expect(files.some((f) => f.includes("__pycache__"))).toBe(false);
    expect(files.some((f) => f.includes(".pytest_cache"))).toBe(false);
  });

  it("preserves scripts/ contents while excluding caches inside it", async () => {
    writeIn("SKILL.md", "# x");
    writeIn("agent.yaml", "name: x-fixture");
    writeIn("requirements.txt", "pandas\n");
    writeIn("scripts/process.py", "import pandas as pd\n");
    writeIn("scripts/helpers.py", "def x(): pass\n");
    writeIn("scripts/__pycache__/process.cpython-311.pyc", "compiled");
    const files = await collectFiles(bundle);
    expect(files).toContain(join("scripts", "process.py"));
    expect(files).toContain(join("scripts", "helpers.py"));
    expect(files.some((f) => f.includes("__pycache__"))).toBe(false);
  });
});

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * Run `skrun build <args>` through the real command, from `dir`: every output
 * is captured, and neither commander nor the command may end the test process.
 */
async function skrunBuild(
  dir: string,
  args: string[],
): Promise<{ printed: string; exitCode: number | undefined; processExitCalled: boolean }> {
  const lines: string[] = [];
  const record = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(" "));
  };
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const error = vi.spyOn(console, "error").mockImplementation(record);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  const program = new Command();
  program.exitOverride().configureOutput({ writeOut: record, writeErr: record });
  registerBuildCommand(program);
  let exitCode: number | undefined;
  let processExitCalled = false;
  try {
    await program.parseAsync(["build", ...args], { from: "user" });
  } catch (err) {
    if (err instanceof CliExit) exitCode = err.code;
    else if (err instanceof ExitCalled) {
      exitCode = err.code;
      processExitCalled = true;
    } else if (err instanceof CommanderError) exitCode = err.exitCode;
    else throw err;
  } finally {
    cwd.mockRestore();
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { printed: lines.join("\n"), exitCode, processExitCalled };
}

describe("skrun build — a failure ends the command, not the process", () => {
  it("ends with 1 on an invalid agent, by throwing, and never calls process.exit", async () => {
    writeIn("agent.yaml", "name: no-skill\n");

    const { printed, exitCode, processExitCalled } = await skrunBuild(bundle, []);

    expect(processExitCalled).toBe(false);
    expect(exitCode).toBe(1);
    expect(printed).toContain("Build failed.");
  });
});

describe("skrun build — a setting that no code honours stops the build", () => {
  function writeAgent(name: string, model: string[], extra: string[]): void {
    writeIn(
      "SKILL.md",
      `---\nname: ${name}\ndescription: Declares a refused setting.\n---\n\n# R\n`,
    );
    writeIn(
      "agent.yaml",
      [
        `name: ${name}`,
        "version: 1.0.0",
        "model:",
        ...model,
        "inputs:",
        "  - name: q",
        "    type: string",
        "    required: true",
        "outputs:",
        "  - name: answer",
        "    type: string",
        ...extra,
        "",
      ].join("\n"),
    );
  }
  const ANTHROPIC = ["  provider: anthropic", "  name: claude-sonnet-4-20250514"];

  it.each([
    [
      "a secrets list that names a secret",
      "secrets-fixture",
      ANTHROPIC,
      ["environment:", "  secrets: [X]"],
      "environment.secrets is not yet supported",
    ],
    [
      "meta without a base_url",
      "meta-fixture",
      ["  provider: meta", "  name: llama"],
      [],
      "model.provider meta has no endpoint of its own",
    ],
  ])("ends with 1 on %s, naming the field, and writes no bundle", async (_case, name, model, extra, said) => {
    writeAgent(name, model, extra);
    const out = mkdtempSync(join(tmpdir(), "skrun-build-out-"));
    try {
      const { printed, exitCode, processExitCalled } = await skrunBuild(bundle, ["--output", out]);

      expect(processExitCalled).toBe(false);
      expect(exitCode).toBe(1);
      expect(printed).toContain(said);
      expect(printed).toContain("Build failed.");
      expect(existsSync(join(out, `${name}-1.0.0.agent`))).toBe(false);
      expect(existsSync(join(bundle, `${name}-1.0.0.agent`))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("skrun build — validation warnings are printed", () => {
  // An agent that is valid and draws two warnings: a retired field in its
  // agent.yaml, and a script importing a package with no manifest to resolve it.
  function writeWarningAgent(): void {
    writeIn("SKILL.md", "---\nname: warn-fixture\ndescription: Draws two warnings.\n---\n\n# W\n");
    writeIn(
      "agent.yaml",
      [
        "name: warn-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-20250514",
        "inputs:",
        "  - name: q",
        "    type: string",
        "    required: true",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "environment:",
        "  sandbox: strict",
        "",
      ].join("\n"),
    );
    writeIn("scripts/fetch.py", "import requests\n");
  }

  it("prints both warnings, by code, and still builds the bundle", async () => {
    writeWarningAgent();
    const out = mkdtempSync(join(tmpdir(), "skrun-build-out-"));
    try {
      const { printed, exitCode } = await skrunBuild(bundle, ["--output", out]);

      expect(exitCode).toBeUndefined();
      expect(printed).toContain("RETIRED_FIELD");
      expect(printed).toContain("environment.sandbox");
      expect(printed).toContain("SCRIPTS_NO_MANIFEST");
      expect(existsSync(join(out, "warn-fixture-1.0.0.agent"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("prints the host-pattern warning, naming the pattern, and still builds", async () => {
    writeIn("SKILL.md", "---\nname: glob-fixture\ndescription: A host pattern.\n---\n\n# G\n");
    writeIn(
      "agent.yaml",
      [
        "name: glob-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-20250514",
        "inputs:",
        "  - name: q",
        "    type: string",
        "    required: true",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "environment:",
        "  networking:",
        "    allowed_hosts:",
        '      - "*.slack.com"',
        "",
      ].join("\n"),
    );
    const out = mkdtempSync(join(tmpdir(), "skrun-build-out-"));
    try {
      const { printed, exitCode } = await skrunBuild(bundle, ["--output", out]);

      expect(exitCode).toBeUndefined();
      expect(printed).toContain("EGRESS_HOST_UNSUPPORTED");
      expect(printed).toContain("*.slack.com");
      expect(existsSync(join(out, "glob-fixture-1.0.0.agent"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("prints the retired-model warning, naming the model, its day and its replacement, and still builds", async () => {
    // A witness entry of the retired-model list, listed for this case only.
    const witness: RetiredModel = {
      provider: "openai",
      id: "gpt-witness-retired",
      retiredOn: "2020-01-15",
      replacement: "gpt-witness-current",
    };
    const list = RETIRED_MODELS as RetiredModel[];
    list.push(witness);
    writeIn("SKILL.md", "---\nname: retired-fixture\ndescription: A retired model.\n---\n\n# R\n");
    writeIn(
      "agent.yaml",
      [
        "name: retired-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: openai",
        "  name: gpt-witness-retired",
        "inputs:",
        "  - name: q",
        "    type: string",
        "    required: true",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "",
      ].join("\n"),
    );
    const out = mkdtempSync(join(tmpdir(), "skrun-build-out-"));
    try {
      const { printed, exitCode } = await skrunBuild(bundle, ["--output", out]);

      expect(exitCode).toBeUndefined();
      expect(printed).toContain("MODEL_RETIRED");
      expect(printed).toContain("openai/gpt-witness-retired");
      expect(printed).toContain("2020-01-15");
      expect(printed).toContain("openai/gpt-witness-current");
      expect(existsSync(join(out, "retired-fixture-1.0.0.agent"))).toBe(true);
    } finally {
      list.splice(list.indexOf(witness), 1);
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("skrun build --output — a directory that does not exist yet", () => {
  function writeValidAgent(): void {
    writeIn("SKILL.md", "---\nname: out-fixture\ndescription: A plain agent.\n---\n\n# O\n");
    writeIn(
      "agent.yaml",
      [
        "name: out-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-20250514",
        "inputs:",
        "  - name: q",
        "    type: string",
        "    required: true",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "",
      ].join("\n"),
    );
  }

  it("is created, and the bundle is written in it", async () => {
    writeValidAgent();
    const parent = mkdtempSync(join(tmpdir(), "skrun-build-out-"));
    const out = join(parent, "absent", "nested");
    try {
      await expect(skrunBuild(bundle, ["--output", out])).resolves.toMatchObject({
        exitCode: undefined,
      });
      expect(existsSync(join(out, "out-fixture-1.0.0.agent"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("is refused by name when a file is in its place, and the process lives on", async () => {
    writeValidAgent();
    const parent = mkdtempSync(join(tmpdir(), "skrun-build-out-"));
    const file = join(parent, "not-a-directory");
    writeFileSync(file, "a file");
    try {
      const run = await skrunBuild(bundle, ["--output", file]).catch((err: unknown) => ({
        printed: `threw: ${String(err)}`,
        exitCode: undefined,
        processExitCalled: false,
      }));

      expect(run.printed).toContain(`${file} is not a directory`);
      expect(run.exitCode).toBe(1);
      expect(run.processExitCalled).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("skrun build — a bundle's size: both sizes measured, warned about, never refused", () => {
  const MIB = 1024 * 1024;

  function writeSizeAgent(): void {
    writeIn("SKILL.md", "---\nname: size-fixture\ndescription: A plain agent.\n---\n\n# S\n");
    writeIn(
      "agent.yaml",
      [
        "name: size-fixture",
        "version: 1.0.0",
        "model:",
        "  provider: anthropic",
        "  name: claude-sonnet-4-6",
        "inputs:",
        "  - name: q",
        "    type: string",
        "    required: true",
        "outputs:",
        "  - name: answer",
        "    type: string",
        "",
      ].join("\n"),
    );
  }

  /** The length of the tar stream of these files, as a ustar archive lays it out: a header block per file, its content padded to a block, two end blocks. */
  function tarLength(sizes: number[]): number {
    return sizes.reduce((sum, size) => sum + 512 + Math.ceil(size / 512) * 512, 0) + 1024;
  }

  it("the unpacked size is the length of the tar stream, headers counted — not the sum of the files", async () => {
    writeSizeAgent();
    for (let i = 0; i < 200; i++) writeIn(`references/note-${i}.txt`, "ten bytes!");
    const files = await collectFiles(bundle);
    const sizes = files.map((file) => readFileSync(join(bundle, file)).length);

    const built = await buildBundle(bundle);

    const written = readFileSync(built.path);
    expect(built.size).toBe(written.length);
    expect(built.decompressedSize).toBe(tarLength(sizes));
    expect(built.decompressedSize).toBe(gunzipSync(written).length);
    // 202 files of a few bytes each: the headers weigh a hundred times the files.
    const sumOfFiles = sizes.reduce((a, b) => a + b, 0);
    expect(built.decompressedSize).toBeGreaterThan(50 * sumOfFiles);
    expect(await decompressedSize(written)).toBe(built.decompressedSize);
  });

  it("prints both sizes on its size line", async () => {
    writeSizeAgent();
    const { printed, exitCode } = await skrunBuild(bundle, []);
    expect(exitCode).toBeUndefined();
    const written = readFileSync(join(bundle, "size-fixture-1.0.0.agent"));
    // Two small files: two header blocks, two content blocks, two end blocks — 3 KB unpacked.
    expect(gunzipSync(written).length).toBe(3 * 1024);
    expect(printed).toContain(`Files: 2 | Size: ${written.length} B compressed, 3.0 KB unpacked`);
    expect(printed).not.toContain("⚠");
  });

  it("warns, and still builds, past what a server with the default limits unpacks", async () => {
    writeSizeAgent();
    writeIn("assets/zeros.bin", "");
    writeFileSync(join(bundle, "assets", "zeros.bin"), Buffer.alloc(51 * MIB));

    const { printed, exitCode, processExitCalled } = await skrunBuild(bundle, []);

    expect(processExitCalled).toBe(false);
    expect(exitCode).toBeUndefined();
    expect(existsSync(join(bundle, "size-fixture-1.0.0.agent"))).toBe(true);
    expect(printed).toMatch(/⚠ Bundle is \d+\.\d KB compressed, 51\.1 MB unpacked: /);
    expect(printed).toContain(
      "over 50 MB unpacked, tar headers counted (413 BUNDLE_DECOMPRESSED_TOO_LARGE)",
    );
    expect(printed).toContain("(BUNDLE_MAX_DECOMPRESSED_MB)");
    expect(printed).not.toContain("BUNDLE_TOO_LARGE)");
    expect(printed).toContain("✓ Built size-fixture-1.0.0.agent");
  });

  it("warns, and still builds, past what a server with the default limits takes compressed", async () => {
    writeSizeAgent();
    writeIn("assets/noise.bin", "");
    writeFileSync(join(bundle, "assets", "noise.bin"), randomBytes(51 * MIB));

    const { printed, exitCode, processExitCalled } = await skrunBuild(bundle, []);

    expect(processExitCalled).toBe(false);
    expect(exitCode).toBeUndefined();
    expect(existsSync(join(bundle, "size-fixture-1.0.0.agent"))).toBe(true);
    expect(printed).toMatch(/⚠ Bundle is 51\.\d MB compressed, 51\.\d MB unpacked: /);
    expect(printed).toContain("over 50 MB compressed (413 BUNDLE_TOO_LARGE)");
    expect(printed).toContain("(413 BUNDLE_DECOMPRESSED_TOO_LARGE)");
    expect(printed).toContain("(SKRUN_PUSH_MAX_BODY_MB, BUNDLE_MAX_DECOMPRESSED_MB)");
    expect(printed).toContain("✓ Built size-fixture-1.0.0.agent");
  }, 60_000);

  describe("sizeWarning — one line, both sizes, the limits of a server with the default settings", () => {
    it("says nothing under the recommended size", () => {
      expect(sizeWarning(10 * MIB, 50 * MIB)).toBeUndefined();
      expect(sizeWarning(1024, 1536)).toBeUndefined();
    });

    it("recommends a smaller bundle past 10 MB compressed, when no limit is crossed", () => {
      expect(sizeWarning(12 * MIB, 40 * MIB)).toBe(
        "Bundle is 12.0 MB compressed, 40.0 MB unpacked (recommended < 10 MB compressed).",
      );
    });

    it("past 50 MB unpacked: the push's refusal, its setting, both sizes", () => {
      expect(sizeWarning(30 * MIB, 50 * MIB + 1)).toBe(
        "Bundle is 30.0 MB compressed, 50.1 MB unpacked: a server with the default limits refuses its push — over 50 MB unpacked, tar headers counted (413 BUNDLE_DECOMPRESSED_TOO_LARGE). A server's operator may set another limit (BUNDLE_MAX_DECOMPRESSED_MB). Leave out the files the agent does not need when it runs.",
      );
    });

    it("past 50 MB compressed: the push's refusal, its setting, both sizes", () => {
      expect(sizeWarning(50 * MIB + 1, 49 * MIB)).toBe(
        "Bundle is 50.1 MB compressed, 49.0 MB unpacked: a server with the default limits refuses its push — over 50 MB compressed (413 BUNDLE_TOO_LARGE). A server's operator may set another limit (SKRUN_PUSH_MAX_BODY_MB). Leave out the files the agent does not need when it runs.",
      );
    });

    it("past both: each refusal and each setting, in the order the server judges them", () => {
      expect(sizeWarning(51 * MIB, 52 * MIB)).toBe(
        "Bundle is 51.0 MB compressed, 52.0 MB unpacked: a server with the default limits refuses its push — over 50 MB compressed (413 BUNDLE_TOO_LARGE), and over 50 MB unpacked, tar headers counted (413 BUNDLE_DECOMPRESSED_TOO_LARGE). A server's operator may set other limits (SKRUN_PUSH_MAX_BODY_MB, BUNDLE_MAX_DECOMPRESSED_MB). Leave out the files the agent does not need when it runs.",
      );
    });

    it("at exactly 50 MB, a limit is not crossed", () => {
      expect(sizeWarning(50 * MIB, 50 * MIB)).toBe(
        "Bundle is 50.0 MB compressed, 50.0 MB unpacked (recommended < 10 MB compressed).",
      );
    });
  });
});

describe("skrun build — an agent.yaml past 128 KB: warned about, never refused", () => {
  /** The limit: 128 KB. */
  const LIMIT = 128 * 1024;
  const WARNING_PAST_LIMIT =
    "agent.yaml is 128.1 KB: every server refuses its push past 128 KB (413 CONFIG_TOO_LARGE) — a fixed limit, no setting. agent.yaml holds the agent's configuration: put long content — instructions, context, data — in SKILL.md, AGENTS.md or other files of the agent.";

  /** An agent whose agent.yaml weighs exactly `bytes` bytes, padded by a YAML comment. */
  function writeAgentWithConfigOf(bytes: number): void {
    writeIn("SKILL.md", "---\nname: wordy\ndescription: A plain agent.\n---\n\n# W\n");
    const head = `${[
      "name: wordy",
      "version: 1.0.0",
      "model:",
      "  provider: anthropic",
      "  name: claude-sonnet-4-6",
      "inputs:",
      "  - name: q",
      "    type: string",
      "outputs:",
      "  - name: answer",
      "    type: string",
    ].join("\n")}\n# `;
    writeIn("agent.yaml", head + "x".repeat(bytes - Buffer.byteLength(head)));
    expect(readFileSync(join(bundle, "agent.yaml")).length).toBe(bytes);
  }

  it("one byte past 128 KB: warns — the push's refusal, the limit, where long content goes — and still builds", async () => {
    writeAgentWithConfigOf(LIMIT + 1);
    const { printed, exitCode, processExitCalled } = await skrunBuild(bundle, []);
    expect(processExitCalled).toBe(false);
    expect(exitCode).toBeUndefined();
    expect(existsSync(join(bundle, "wordy-1.0.0.agent"))).toBe(true);
    expect(printed).toContain(`⚠ ${WARNING_PAST_LIMIT}`);
    expect(printed).toContain("✓ Built wordy-1.0.0.agent");
  });

  it("at 128 KB: no warning", async () => {
    writeAgentWithConfigOf(LIMIT);
    const { printed, exitCode } = await skrunBuild(bundle, []);
    expect(exitCode).toBeUndefined();
    expect(printed).not.toContain("CONFIG_TOO_LARGE");
    expect(printed).not.toContain("⚠");
  });

  it("configSizeWarning: nothing up to 128 KB, the size rounded up past it", () => {
    expect(configSizeWarning(4 * 1024)).toBeUndefined();
    expect(configSizeWarning(LIMIT)).toBeUndefined();
    expect(configSizeWarning(LIMIT + 1)).toBe(WARNING_PAST_LIMIT);
  });
});
