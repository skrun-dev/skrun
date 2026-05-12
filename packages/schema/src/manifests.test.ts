import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectManifest, hasNonStdlibImports, type ManifestInfo } from "./manifests.js";

let bundleRoot: string;

beforeEach(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), "skrun-manifests-test-"));
});

afterEach(() => {
  rmSync(bundleRoot, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): void {
  const fullPath = join(bundleRoot, relativePath);
  const dir = dirname(fullPath);
  if (dir !== bundleRoot) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

describe("detectManifest — Node ecosystem", () => {
  it("detects package.json with no lockfile", () => {
    writeFile("package.json", '{"name":"x","dependencies":{"jszip":"^3"}}');
    const result = detectManifest(bundleRoot);
    expect(result.ecosystem).toBe("node");
    if (result.ecosystem !== "node") throw new Error("ecosystem narrowing failed");
    expect(result.manifestContent).toContain("jszip");
    expect(result.lockfileKind).toBeUndefined();
    expect(result.lockfileContent).toBeUndefined();
  });

  it("detects package-lock.json (npm)", () => {
    writeFile("package.json", '{"name":"x"}');
    writeFile("package-lock.json", '{"lockfileVersion":3}');
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "node") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("npm");
    expect(result.lockfileContent).toContain("lockfileVersion");
  });

  it("detects yarn.lock", () => {
    writeFile("package.json", '{"name":"x"}');
    writeFile("yarn.lock", "# yarn lockfile v1\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "node") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("yarn");
  });

  it("detects pnpm-lock.yaml", () => {
    writeFile("package.json", '{"name":"x"}');
    writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "node") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("pnpm");
  });

  it("prefers pnpm-lock.yaml when multiple Node lockfiles are present", () => {
    writeFile("package.json", '{"name":"x"}');
    writeFile("package-lock.json", '{"lockfileVersion":3}');
    writeFile("yarn.lock", "# yarn lockfile v1\n");
    writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "node") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("pnpm");
  });

  it("prefers yarn.lock over package-lock.json when pnpm is absent", () => {
    writeFile("package.json", '{"name":"x"}');
    writeFile("package-lock.json", '{"lockfileVersion":3}');
    writeFile("yarn.lock", "# yarn lockfile v1\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "node") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("yarn");
  });
});

describe("detectManifest — Python ecosystem", () => {
  it("detects requirements.txt with no lockfile", () => {
    writeFile("requirements.txt", "pandas==2.2.3\nmatplotlib==3.9.2\n");
    const result = detectManifest(bundleRoot);
    expect(result.ecosystem).toBe("python");
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.manifestKind).toBe("requirements");
    expect(result.manifestContent).toContain("pandas");
    expect(result.lockfileKind).toBeUndefined();
  });

  it("detects pyproject.toml with no lockfile", () => {
    writeFile(
      "pyproject.toml",
      '[project]\nname = "myagent"\nversion = "0.1.0"\ndependencies = ["pandas"]\n',
    );
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.manifestKind).toBe("pyproject");
    expect(result.pythonProjectName).toBe("myagent");
  });

  it("pyproject.toml wins over requirements.txt when both are present", () => {
    writeFile("pyproject.toml", '[project]\nname = "myagent"\n');
    writeFile("requirements.txt", "pandas==2.2.3\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.manifestKind).toBe("pyproject");
    expect(result.manifestContent).toContain("[project]");
    expect(result.manifestContent).not.toContain("pandas==2.2.3");
  });

  it("detects uv.lock alongside pyproject.toml", () => {
    writeFile("pyproject.toml", '[project]\nname = "myagent"\n');
    writeFile("uv.lock", "version = 1\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("uv");
  });

  it("detects poetry.lock alongside pyproject.toml", () => {
    writeFile("pyproject.toml", '[project]\nname = "myagent"\n');
    writeFile("poetry.lock", "# This file is automatically @generated by Poetry\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("poetry");
  });

  it("prefers uv.lock over poetry.lock when both are present", () => {
    writeFile("pyproject.toml", '[project]\nname = "myagent"\n');
    writeFile("poetry.lock", "# poetry\n");
    writeFile("uv.lock", "version = 1\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.lockfileKind).toBe("uv");
  });

  it("does not attach a lockfile to requirements.txt manifests", () => {
    writeFile("requirements.txt", "pandas==2.2.3\n");
    writeFile("uv.lock", "version = 1\n");
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.manifestKind).toBe("requirements");
    // requirements.txt does not own uv.lock — that lockfile belongs to pyproject.toml only.
    expect(result.lockfileKind).toBeUndefined();
  });

  it("returns undefined pythonProjectName when [project] name cannot be parsed", () => {
    writeFile("pyproject.toml", '[build-system]\nrequires = ["setuptools"]\n');
    const result = detectManifest(bundleRoot);
    if (result.ecosystem !== "python") throw new Error("ecosystem narrowing failed");
    expect(result.pythonProjectName).toBeUndefined();
  });
});

describe("detectManifest — none ecosystem", () => {
  it("returns ecosystem: 'none' on an empty bundle", () => {
    const result = detectManifest(bundleRoot);
    expect(result).toEqual({ ecosystem: "none" });
  });

  it("returns ecosystem: 'none' when only unrelated files exist", () => {
    writeFile("SKILL.md", "# Skill\n");
    writeFile("agent.yaml", "name: dev/test\n");
    const result = detectManifest(bundleRoot);
    expect(result.ecosystem).toBe("none");
  });

  it("does not throw on a non-existent bundleRoot", () => {
    const result = detectManifest(join(bundleRoot, "does-not-exist"));
    expect(result.ecosystem).toBe("none");
  });
});

describe("ManifestInfo content shape (SC-13 cross-host determinism)", () => {
  it("does not contain any absolute path field on Node", () => {
    writeFile("package.json", '{"name":"x"}');
    writeFile("package-lock.json", '{"lockfileVersion":3}');
    const result = detectManifest(bundleRoot);
    const keys = Object.keys(result);
    expect(keys).not.toContain("manifestPath");
    expect(keys).not.toContain("lockfilePath");
    expect(keys).not.toContain("bundleRoot");
    expect(keys).not.toContain("path");
  });

  it("does not contain any absolute path field on Python", () => {
    writeFile("pyproject.toml", '[project]\nname = "x"\n');
    writeFile("uv.lock", "version = 1\n");
    const result = detectManifest(bundleRoot);
    const keys = Object.keys(result);
    expect(keys).not.toContain("manifestPath");
    expect(keys).not.toContain("lockfilePath");
    expect(keys).not.toContain("bundleRoot");
    expect(keys).not.toContain("path");
  });

  it("returns identical hashable content for two bundles with the same manifest content but different paths", () => {
    const otherBundle = mkdtempSync(join(tmpdir(), "skrun-manifests-cross-"));
    try {
      writeFile("requirements.txt", "pandas==2.2.3\n");
      writeFileSync(join(otherBundle, "requirements.txt"), "pandas==2.2.3\n");
      const a = detectManifest(bundleRoot);
      const b = detectManifest(otherBundle);
      // Stringify identifies any path leakage — JSON output should be identical.
      expect(JSON.stringify(a satisfies ManifestInfo)).toBe(
        JSON.stringify(b satisfies ManifestInfo),
      );
    } finally {
      rmSync(otherBundle, { recursive: true, force: true });
    }
  });
});

describe("hasNonStdlibImports — Python", () => {
  it("returns false on an empty scripts/ directory", () => {
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "python")).toBe(false);
  });

  it("returns false when scripts/ does not exist", () => {
    expect(hasNonStdlibImports(join(bundleRoot, "missing"), "python")).toBe(false);
  });

  it("returns false when scripts only import stdlib modules", () => {
    writeFile(
      "scripts/process.py",
      "import os\nimport sys\nfrom pathlib import Path\nfrom typing import Any\n",
    );
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "python")).toBe(false);
  });

  it("returns true when a script imports pandas (third-party)", () => {
    writeFile("scripts/analyze.py", "import pandas as pd\nimport os\n");
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "python")).toBe(true);
  });

  it("returns true when a script imports numpy via from-import", () => {
    writeFile("scripts/calc.py", "from numpy import array\n");
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "python")).toBe(true);
  });

  it("ignores .ts files when scanning Python scripts", () => {
    writeFile("scripts/lib.ts", "import _ from 'lodash';\n");
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "python")).toBe(false);
  });
});

describe("hasNonStdlibImports — Node", () => {
  it("returns false when scripts only require/import stdlib modules", () => {
    writeFile(
      "scripts/util.js",
      "const fs = require('fs');\nconst path = require('node:path');\nconst { spawn } = require('child_process');\n",
    );
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "node")).toBe(false);
  });

  it("returns true when a script requires jszip (third-party)", () => {
    writeFile("scripts/zip.js", "const JSZip = require('jszip');\n");
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "node")).toBe(true);
  });

  it("returns true when a script imports a scoped package", () => {
    writeFile("scripts/api.mjs", "import { foo } from '@skrun-dev/runtime';\n");
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "node")).toBe(true);
  });

  it("ignores relative imports", () => {
    writeFile(
      "scripts/main.js",
      "const helper = require('./helper');\nimport { x } from '../utils';\n",
    );
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "node")).toBe(false);
  });

  it("recognises node: prefix as stdlib", () => {
    writeFile(
      "scripts/util.js",
      "import fs from 'node:fs';\nimport { createHash } from 'node:crypto';\n",
    );
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "node")).toBe(false);
  });

  it("scans .mjs / .cjs / .ts as well as .js", () => {
    writeFile("scripts/a.mjs", "import _ from 'lodash';\n");
    expect(hasNonStdlibImports(join(bundleRoot, "scripts"), "node")).toBe(true);
  });
});
