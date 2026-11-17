import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { QUOTA_ENV_NAMES } from "./thresholds.js";

/**
 * The quota settings are read in one place: quotas/thresholds.ts, which every
 * other module asks for a reading and never the environment. Read in the
 * syntax (the TypeScript parser, no type check), over packages/api/src and
 * packages/runtime/src — test files (`*.test.ts`) and shared test helpers
 * (`*.shared.ts`) left out. Outside thresholds.ts, none of the eight names
 * may be reached:
 * - as a property (`process.env.NAME`, `env.NAME`) or by a string key
 *   (`env["NAME"]`);
 * - destructured (`const { NAME } = process.env`, renamed or not);
 * - passed as a string to a call (`readEnvInt("NAME", …)`), the shape an
 *   environment helper takes.
 * Each finding names its file and line.
 *
 * What it does not see: a name built at run time (`env[prefix + "WINDOW_S"]`).
 * The rule reads names, not values.
 */

const API_SRC = join(import.meta.dirname, "..");
const REPO_ROOT = join(API_SRC, "..", "..", "..");
const RUNTIME_SRC = join(REPO_ROOT, "packages", "runtime", "src");
const READER_FILE = "packages/api/src/quotas/thresholds.ts";
const NAMES: ReadonlySet<string> = new Set(QUOTA_ENV_NAMES);

/** The quota setting a node reaches, if any, and the node that names it. */
function reachedSetting(node: ts.Node): { name: string; at: ts.Node } | undefined {
  if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text)) {
    return { name: node.name.text, at: node.name };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    NAMES.has(node.argumentExpression.text)
  ) {
    return { name: node.argumentExpression.text, at: node.argumentExpression };
  }
  if (ts.isBindingElement(node)) {
    const key = node.propertyName ?? node.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && NAMES.has(key.text)) {
      return { name: key.text, at: key };
    }
  }
  if (ts.isCallExpression(node)) {
    const named = node.arguments.find(
      (argument) => ts.isStringLiteralLike(argument) && NAMES.has(argument.text),
    );
    if (named) return { name: (named as ts.StringLiteralLike).text, at: named };
  }
  return undefined;
}

/** Findings of one source, each as `<file>:<line> — <what>`. */
function settingReadFindings(fileName: string, source: string): string[] {
  if (fileName === READER_FILE) return [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const reached = reachedSetting(node);
    if (reached) {
      const line = file.getLineAndCharacterOfPosition(reached.at.getStart(file)).line + 1;
      found.push(`${fileName}:${line} — ${reached.name} is read outside ${READER_FILE}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The sources under a directory, test files and shared test helpers left out. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isSource = /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts");
    const isTestOnly = /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".shared.ts");
    return isSource && !isTestOnly ? [path] : [];
  });
}

/** A repository-relative path with forward slashes, whatever the system writes. */
function repoPath(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, "/");
}

describe("what the one-reader rule for the quota settings sees", () => {
  const seen = (source: string, fileName = "packages/api/src/routes/witness.ts") =>
    settingReadFindings(fileName, source).map((finding) => finding.replace(/^.*?:\d+ — /, ""));
  const outside = (name: string) => `${name} is read outside ${READER_FILE}`;

  it("refuses a read by property, on the process environment or any other", () => {
    expect(seen("const w = process.env.SKRUN_QUOTA_WINDOW_S;")).toEqual([
      outside("SKRUN_QUOTA_WINDOW_S"),
    ]);
    expect(seen("const m = env.SKRUN_RUN_MAX_TIMEOUT_S;")).toEqual([
      outside("SKRUN_RUN_MAX_TIMEOUT_S"),
    ]);
    expect(seen("const c = process.env?.SKRUN_QUOTA_CONCURRENT_RUNS;")).toEqual([
      outside("SKRUN_QUOTA_CONCURRENT_RUNS"),
    ]);
  });

  it("refuses a read by string key", () => {
    expect(seen(`const s = process.env["SKRUN_QUOTA_STORAGE_MB"];`)).toEqual([
      outside("SKRUN_QUOTA_STORAGE_MB"),
    ]);
  });

  it("refuses a destructured read, renamed or not", () => {
    expect(seen("const { SKRUN_QUOTA_INPUT_FILES } = process.env;")).toEqual([
      outside("SKRUN_QUOTA_INPUT_FILES"),
    ]);
    expect(seen("const { SKRUN_QUOTA_FAST_RUNS_PER_HOUR: fast } = env;")).toEqual([
      outside("SKRUN_QUOTA_FAST_RUNS_PER_HOUR"),
    ]);
  });

  it("refuses a name handed to an environment helper", () => {
    expect(seen(`const n = readEnvInt("SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS", 1);`)).toEqual([
      outside("SKRUN_QUOTA_INSTANCE_CONCURRENT_RUNS"),
    ]);
  });

  it("does not see a name in a comment, or inside a longer text", () => {
    expect(
      seen(
        '// process.env.SKRUN_QUOTA_WINDOW_S\nconst t = `set SKRUN_QUOTA_WINDOW_S to 21600`;\nlog("see SKRUN_QUOTA_COMPUTE_SECONDS");',
      ),
    ).toEqual([]);
  });

  it("lets every form through in quotas/thresholds.ts", () => {
    expect(
      seen(
        `const a = env.SKRUN_QUOTA_WINDOW_S; const { SKRUN_RUN_MAX_TIMEOUT_S } = env; readEnvInt("SKRUN_QUOTA_STORAGE_MB");`,
        READER_FILE,
      ),
    ).toEqual([]);
  });

  it("names the file and the line", () => {
    expect(
      settingReadFindings(
        "packages/runtime/src/x.ts",
        "\n\nconst w = process.env.SKRUN_QUOTA_WINDOW_S;",
      ),
    ).toEqual([`packages/runtime/src/x.ts:3 — ${outside("SKRUN_QUOTA_WINDOW_S")}`]);
  });
});

describe("the quota settings, in the API's and the runtime's sources", () => {
  const files = [...sourceFiles(API_SRC), ...sourceFiles(RUNTIME_SRC)].map((path) => ({
    path: repoPath(path),
    source: readFileSync(path, "utf-8"),
  }));

  it("reads both trees, test files left out, the reader among them", () => {
    expect(files.some(({ path }) => path.startsWith("packages/api/src/"))).toBe(true);
    expect(files.some(({ path }) => path.startsWith("packages/runtime/src/"))).toBe(true);
    expect(files.some(({ path }) => path === READER_FILE)).toBe(true);
    expect(files.some(({ path }) => /\.test\.tsx?$/.test(path))).toBe(false);
  });

  it("the reader reads each of the eight by its name", () => {
    const reader = files.find(({ path }) => path === READER_FILE);
    const file = ts.createSourceFile(
      READER_FILE,
      reader?.source ?? "",
      ts.ScriptTarget.Latest,
      true,
    );
    const read = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text))
        read.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect([...read].sort()).toEqual([...NAMES].sort());
  });

  it("reads the eight quota settings nowhere else", () => {
    expect(files.flatMap(({ path, source }) => settingReadFindings(path, source))).toEqual([]);
  });
});

/**
 * A run's row is written by its admission alone — `quotas/admission.ts`,
 * through `db.admitRun`, which writes it only if the account and the instance
 * still have room. `createRun` stays in the stores' contract, for the tests
 * that seed rows, and no source reaches it: a second way to write a run would
 * be a way around every bound. Read in the syntax, over the same trees, test
 * files and shared test helpers left out: `createRun` may not be reached as a
 * property (`db.createRun(…)`, `db?.createRun`, `const w = db.createRun`) or by
 * a string key (`db["createRun"]`). The stores' own declarations of the method
 * are not a reach. Each finding names its file and line.
 */
function createRunFindings(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const at =
      ts.isPropertyAccessExpression(node) && node.name.text === "createRun"
        ? node.name
        : ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            node.argumentExpression.text === "createRun"
          ? node.argumentExpression
          : undefined;
    if (at) {
      const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line + 1;
      found.push(`${fileName}:${line} — createRun is reached; a run is written by its admission`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("what the one-writer rule for a run's row sees", () => {
  const seen = (source: string) =>
    createRunFindings("packages/api/src/routes/witness.ts", source).map((finding) =>
      finding.replace(/^.*?:\d+ — /, ""),
    );
  const REACHED = "createRun is reached; a run is written by its admission";

  it("refuses a call, an optional call, a reference and a string key", () => {
    expect(seen("await db.createRun({ id });")).toEqual([REACHED]);
    expect(seen("await this.db?.createRun({ id });")).toEqual([REACHED]);
    expect(seen("const write = db.createRun; await write({ id });")).toEqual([REACHED]);
    expect(seen(`await db["createRun"]({ id });`)).toEqual([REACHED]);
  });

  it("does not see a store's declaration of the method, a longer name, or a comment", () => {
    expect(
      seen(
        "class S { async createRun(data) { return data; } }\ninterface A { createRun(d: unknown): void }\ncreateRunRoutes(service);\n// db.createRun(x)",
      ),
    ).toEqual([]);
  });

  it("names the file and the line", () => {
    expect(createRunFindings("packages/api/src/x.ts", "\nawait db.createRun({});")).toEqual([
      `packages/api/src/x.ts:2 — ${REACHED}`,
    ]);
  });
});

describe("a run's row, in the API's and the runtime's sources", () => {
  const files = [...sourceFiles(API_SRC), ...sourceFiles(RUNTIME_SRC)].map((path) => ({
    path: repoPath(path),
    source: readFileSync(path, "utf-8"),
  }));

  it("is written by its admission: createRun is reached nowhere", () => {
    expect(files.flatMap(({ path, source }) => createRunFindings(path, source))).toEqual([]);
  });

  it("and the admission is where db.admitRun is called", () => {
    const callers = files
      .filter(({ source }) => /\.admitRun\(/.test(source))
      .map(({ path }) => path)
      .filter((path) => !path.startsWith("packages/api/src/db/"));
    expect(callers).toEqual(["packages/api/src/quotas/admission.ts"]);
  });
});

/**
 * A run's right to a pooled machine is given back on its engine's
 * `runner_spawned`, read in one envelope of the engine's events —
 * `engineEvents`, in routes/run.ts —, which both readings of the route go
 * through, the stream and the background task: a reading around it would run
 * without the give-back. Read in the syntax, over the API's sources only (the
 * runtime reads its own stream, LocalAdapter.execute), test files and shared
 * test helpers left out:
 * - `executeStream` may be reached — as a property or by a string key — only
 *   inside the envelope, the function nearest around the reach; a function
 *   nested in it is not the envelope;
 * - `returnPoolRight` is reached from routes/run.ts alone, the stores that
 *   declare it (packages/api/src/db/) aside.
 * Each finding names its file and line.
 */
const ENVELOPE_FILE = "packages/api/src/routes/run.ts";
const ENVELOPE = "engineEvents";
const STORES_DIR = "packages/api/src/db/";

/** The nodes of `file` that reach the member `name`, as a property or by a string key. */
function reachesOf(file: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) found.push(node.name);
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === name
    ) {
      found.push(node.argumentExpression);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether the function nearest around `node` is the envelope, in its file. */
function insideEnvelope(fileName: string, node: ts.Node): boolean {
  if (fileName !== ENVELOPE_FILE) return false;
  let at: ts.Node | undefined = node.parent;
  while (at !== undefined && !ts.isFunctionLike(at)) at = at.parent;
  return at !== undefined && ts.isFunctionDeclaration(at) && at.name?.text === ENVELOPE;
}

/** Each reach of `executeStream` outside the envelope, as `<file>:<line> — <what>`. */
function engineReadFindings(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return reachesOf(file, "executeStream")
    .filter((at) => !insideEnvelope(fileName, at))
    .map((at) => {
      const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line + 1;
      return `${fileName}:${line} — executeStream is read outside ${ENVELOPE}`;
    });
}

/** The files, the stores aside, that reach `returnPoolRight`. */
function giveBackCallers(files: Array<{ path: string; source: string }>): string[] {
  return files
    .filter(({ path, source }) => {
      if (path.startsWith(STORES_DIR)) return false;
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      return reachesOf(file, "returnPoolRight").length > 0;
    })
    .map(({ path }) => path);
}

describe("what the one-reading rule for the engine's events sees", () => {
  const READ_OUTSIDE = `executeStream is read outside ${ENVELOPE}`;
  const seen = (source: string, fileName = "packages/api/src/routes/witness.ts") =>
    engineReadFindings(fileName, source).map((finding) => finding.replace(/^.*?:\d+ — /, ""));

  it("refuses a reading anywhere but the envelope: a call, a reference, a string key", () => {
    expect(
      seen("async function handler() { for await (const e of adapter.executeStream(r)) {} }"),
    ).toEqual([READ_OUTSIDE]);
    expect(seen("const read = adapter.executeStream;")).toEqual([READ_OUTSIDE]);
    expect(seen(`const events = adapter["executeStream"](r);`)).toEqual([READ_OUTSIDE]);
  });

  it("lets the envelope's own reading through, in routes/run.ts only", () => {
    const envelope = `async function* ${ENVELOPE}(a, r) { for await (const e of a.executeStream(r)) yield e; }`;
    expect(seen(envelope, ENVELOPE_FILE)).toEqual([]);
    expect(seen(envelope)).toEqual([READ_OUTSIDE]);
  });

  it("refuses a reading beside the envelope in its file, or in a function nested in it", () => {
    expect(seen("const stream = () => adapter.executeStream(r);", ENVELOPE_FILE)).toEqual([
      READ_OUTSIDE,
    ]);
    expect(
      seen(
        `async function* ${ENVELOPE}(a, r) { const f = () => a.executeStream(r); yield* f(); }`,
        ENVELOPE_FILE,
      ),
    ).toEqual([READ_OUTSIDE]);
  });

  it("does not see a declaration of the method, or a comment", () => {
    expect(
      seen(
        "class A { async *executeStream(r) { yield r; } }\ninterface R { executeStream(r: unknown): void }\n// adapter.executeStream(r)",
      ),
    ).toEqual([]);
  });

  it("names the file and the line", () => {
    expect(engineReadFindings("packages/api/src/x.ts", "\n\nadapter.executeStream(r);")).toEqual([
      `packages/api/src/x.ts:3 — ${READ_OUTSIDE}`,
    ]);
  });
});

describe("what the one-caller rule for a right given back sees", () => {
  it("names a file that reaches it, the route among them", () => {
    expect(
      giveBackCallers([
        { path: ENVELOPE_FILE, source: "void db.returnPoolRight(runId);" },
        { path: "packages/api/src/routes/usage.ts", source: "await db?.returnPoolRight(id);" },
        { path: "packages/api/src/routes/stats.ts", source: `db["returnPoolRight"](id);` },
      ]),
    ).toEqual([
      ENVELOPE_FILE,
      "packages/api/src/routes/usage.ts",
      "packages/api/src/routes/stats.ts",
    ]);
  });

  it("does not see the stores that declare it, a declaration elsewhere, or a comment", () => {
    expect(
      giveBackCallers([
        { path: `${STORES_DIR}memory.ts`, source: "this.returnPoolRight(id);" },
        {
          path: "packages/api/src/routes/witness.ts",
          source:
            "interface S { returnPoolRight(id: string): Promise<boolean> }\n// db.returnPoolRight(id)",
        },
      ]),
    ).toEqual([]);
  });
});

describe("the engine's events and a right given back, in the API's sources", () => {
  const files = sourceFiles(API_SRC).map((path) => ({
    path: repoPath(path),
    source: readFileSync(path, "utf-8"),
  }));

  it("reads the API's tree, test files and shared test helpers left out, the route among them", () => {
    expect(files.some(({ path }) => path === ENVELOPE_FILE)).toBe(true);
    expect(files.some(({ path }) => /\.test\.tsx?$|\.shared\.ts$/.test(path))).toBe(false);
  });

  it("are read through the envelope alone: executeStream is reached nowhere else", () => {
    expect(files.flatMap(({ path, source }) => engineReadFindings(path, source))).toEqual([]);
  });

  it("and the route is where a right is given back", () => {
    expect(giveBackCallers(files)).toEqual([ENVELOPE_FILE]);
  });
});
