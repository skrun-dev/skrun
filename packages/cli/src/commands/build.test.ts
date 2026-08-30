// Tests for `skrun build` file inclusion/exclusion logic (#57 SC-5, SC-6).
//
// We exercise `collectFiles` directly rather than running `runBuild` end-to-end:
// the exclusion contract is consumed exclusively by `collectFiles`, which then
// feeds the shared tar codec (`packAgentTar`). Verifying the file list returned
// by `collectFiles` is a sufficient unit test for the exclusion contract — the
// tar packaging itself (POSIX names, round-trip, binary fidelity) is covered by
// the codec's own tests in `@skrun-dev/schema`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_BUNDLE_EXCLUDES } from "@skrun-dev/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "./build.js";

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
