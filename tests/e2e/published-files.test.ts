import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What each published package would put in its npm archive, read from `pnpm pack --dry-run --json`
// in the package's directory: the list pnpm publishes, nothing written. The test fails when that
// list holds:
//  - a test file (a path with `.test.`);
//  - a test helper (a path with `.shared.`, the suffix of the modules several tests share);
//  - a compiled module without source: a file under dist/ whose source under src/ is gone. `.js`,
//    `.d.ts` and their maps come from the `.ts` of the same name; any other file (the API's SQL
//    migrations) from the same path. tsc never removes an output whose source disappeared.
// Anchors: every target of `exports` (and the CLI's `bin`) is in the list, so a list that comes back
// short or empty fails too.
// What it does not see: a file built from a source that still exists but should not ship (a fixture
// under src/ named without `.test.` or `.shared.`); what is inside a file; anything a prepack script
// would change (none of the five has one). It reads the build: run it after `pnpm build`, as CI does.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PUBLISHED = ["sdk", "schema", "runtime", "api", "cli"] as const;

const RECIPE =
  "A published package would ship a file its source does not build. To fix: keep tests and test " +
  "helpers out of the package's emitting tsconfig (tsconfig.build.json where there is one), and " +
  "make its build script empty dist/ before emitting; then run `pnpm build` again. Faults";

// A constant command: `pnpm` is a .cmd on Windows, which Node runs only through a shell, and a
// constant carries nothing to inject.
const PACK = "pnpm pack --dry-run --json";

interface Manifest {
  exports?: unknown;
  bin?: string | Record<string, string>;
}

/** Every string target under `exports`, plus `bin`, as pack paths. */
function anchorsOf(manifest: Manifest): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value.replace(/^\.\//, ""));
    else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v);
  };
  walk(manifest.exports);
  walk(manifest.bin);
  return [...new Set(out)].sort();
}

/** The source a dist/ file is built from. */
function sourceOf(distPath: string): string {
  const rel = distPath.slice("dist/".length);
  for (const ext of [".d.ts.map", ".d.ts", ".js.map", ".js"]) {
    if (rel.endsWith(ext)) return `src/${rel.slice(0, -ext.length)}.ts`;
  }
  return `src/${rel}`;
}

/** The rule, pure: the faults of a pack list. */
function faults(
  pkg: string,
  files: string[],
  hasSource: (path: string) => boolean,
  anchors: string[],
): string[] {
  const out: string[] = [];
  for (const path of files) {
    if (path.includes(".test.")) out.push(`${pkg}: ${path} is a test file`);
    else if (path.includes(".shared.")) out.push(`${pkg}: ${path} is a test helper`);
    else if (path.startsWith("dist/") && !hasSource(sourceOf(path))) {
      out.push(`${pkg}: ${path} has no source (${sourceOf(path)} is gone)`);
    }
  }
  const listed = new Set(files);
  for (const anchor of anchors) {
    if (!listed.has(anchor)) out.push(`${pkg}: ${anchor}, a target of its manifest, is not listed`);
  }
  return out;
}

/** What `pnpm pack` would put in the package's archive. */
function packList(dir: string): string[] {
  const out = execSync(PACK, {
    cwd: join(ROOT, dir),
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const parsed = JSON.parse(out) as { files?: Array<{ path: string }> };
  return (parsed.files ?? []).map((f) => f.path).sort();
}

describe("E2E: the published packages ship what their source builds, and nothing else", () => {
  it.each(PUBLISHED)("@skrun-dev/%s: no test, no test helper, no module without source", (p) => {
    const dir = `packages/${p}`;
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf-8")) as Manifest;
    const anchors = anchorsOf(manifest);
    expect(anchors.length, `${dir}/package.json exports`).toBeGreaterThan(0);
    const files = packList(dir);
    const problems = faults(
      `@skrun-dev/${p}`,
      files,
      (source) => existsSync(join(ROOT, dir, source)),
      anchors,
    );
    expect(problems, RECIPE).toEqual([]);
  }, 60_000);
});

describe("E2E: the published-files rule judges its witnesses", () => {
  const sources = new Set(["src/index.ts", "src/index.test.ts", "src/db/x.shared.ts"]);
  const hasSource = (path: string): boolean => sources.has(path);

  it("faults a test file, a test helper and a module without source", () => {
    const files = [
      "dist/index.js",
      "dist/index.test.js",
      "dist/db/x.shared.d.ts",
      "dist/ghost.js",
      "package.json",
    ];
    expect(faults("w", files, hasSource, ["dist/index.js"])).toEqual([
      "w: dist/index.test.js is a test file",
      "w: dist/db/x.shared.d.ts is a test helper",
      "w: dist/ghost.js has no source (src/ghost.ts is gone)",
    ]);
  });

  it("stays silent on a healthy list, maps and migrations included", () => {
    const healthy = new Set(["src/index.ts", "src/db/migrations/001_init.sql"]);
    const files = [
      "LICENSE",
      "bin/w.js",
      "dist/db/migrations/001_init.sql",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/index.js",
      "dist/index.js.map",
      "package.json",
    ];
    const anchors = anchorsOf({
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      bin: { w: "./bin/w.js" },
    });
    expect(anchors).toEqual(["bin/w.js", "dist/index.d.ts", "dist/index.js"]);
    expect(faults("w", files, (p) => healthy.has(p), anchors)).toEqual([]);
  });

  it("faults a target of the manifest that the list lacks", () => {
    expect(faults("w", [], hasSource, ["dist/index.js"])).toEqual([
      "w: dist/index.js, a target of its manifest, is not listed",
    ]);
  });
});
