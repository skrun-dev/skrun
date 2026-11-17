import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * One function writes a run's final status: `finalizeRun`, in
 * routes/_helpers.ts. Read in the syntax (the TypeScript parser, no type
 * check), over packages/api/src — test files (`*.test.ts`), shared test
 * helpers (`*.shared.ts`) and the database backends (`src/db/`) left out: the
 * backends implement the two write methods and share one private write of the
 * row between them. What the rule holds is their callers:
 * - `finishRun`, the final write, is called only inside the body of
 *   `finalizeRun` in routes/_helpers.ts;
 * - every call of `updateRun` takes, as its second argument, an object
 *   literal with no `status` property, no spread and no computed name — a
 *   variable, a spread or a computed name could carry a status the syntax
 *   cannot see;
 * - neither method is reached other than as the callee of a call: an alias
 *   (`const write = db.updateRun`, or one destructured) would carry a call out
 *   of sight.
 * Each finding names its file and line.
 *
 * What it does not see: a write reached through another name — a wrapper
 * typed loosely, a reflective call. The rule reads names, not types.
 */

const API_SRC = join(import.meta.dirname, "..");
const REPO_ROOT = join(API_SRC, "..", "..", "..");
const DB_DIR = join(API_SRC, "db");
const FINALIZER_FILE = "packages/api/src/routes/_helpers.ts";
const FINALIZER = "finalizeRun";
const WRITE_METHODS = new Set(["updateRun", "finishRun"]);

/** The write method a property access or a string-keyed element access reaches, if any. */
function reachedMethod(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && WRITE_METHODS.has(node.name.text)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    WRITE_METHODS.has(node.argumentExpression.text)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** Out of parentheses, type assertions and non-null marks. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** The static name of a property of an object literal, or undefined when it has none. */
function staticName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** What is wrong with the second argument of an `updateRun` call, if anything. */
function updateRunArgumentFindings(call: ts.CallExpression): string[] {
  const argument = call.arguments[1];
  if (!argument) return ["updateRun is called without a second argument"];
  const patch = unwrapped(argument);
  if (!ts.isObjectLiteralExpression(patch)) {
    return ["updateRun's second argument is not an object literal"];
  }
  const found: string[] = [];
  for (const property of patch.properties) {
    if (ts.isSpreadAssignment(property)) {
      found.push("updateRun's second argument spreads another object");
      continue;
    }
    if (!property.name) continue;
    if (ts.isComputedPropertyName(property.name)) {
      found.push("updateRun's second argument has a computed property name");
    } else if (staticName(property.name) === "status") {
      found.push("updateRun carries a status");
    }
  }
  return found;
}

/** The body of each `function finalizeRun` declared at the top of the file. */
function finalizerBodies(file: ts.SourceFile): ts.Block[] {
  return file.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === FINALIZER && statement.body
      ? [statement.body]
      : [],
  );
}

/** Findings of one source, each as `<file>:<line> — <what>`. */
function finalWriteFindings(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const bodies = fileName === FINALIZER_FILE ? finalizerBodies(file) : [];
  const inFinalizer = (node: ts.Node) =>
    bodies.some((body) => node.getStart(file) >= body.getStart(file) && node.end <= body.end);
  const found: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    found.push(`${fileName}:${line} — ${what}`);
  };
  const visit = (node: ts.Node): void => {
    const method = reachedMethod(node);
    if (method) {
      // The line of the method's name, not of the object: `db` may sit a line above.
      const named = ts.isPropertyAccessExpression(node)
        ? node.name
        : (node as ts.ElementAccessExpression).argumentExpression;
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.expression !== node) {
        report(named, `${method} is reached other than as the callee of a call`);
      } else if (method === "finishRun") {
        if (!inFinalizer(node)) report(named, `finishRun is called outside ${FINALIZER}`);
      } else {
        for (const what of updateRunArgumentFindings(call)) report(named, what);
      }
    }
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && WRITE_METHODS.has(name.text)) {
        report(node, `${name.text} is destructured`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** packages/api/src sources, test files, shared test helpers and the backends left out. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === DB_DIR ? [] : sourceFiles(path);
    const isSource = /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts");
    const isTestOnly = /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".shared.ts");
    return isSource && !isTestOnly ? [path] : [];
  });
}

/** A repository-relative path with forward slashes, whatever the system writes. */
function repoPath(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, "/");
}

describe("what the final-write rule sees", () => {
  const seen = (source: string, fileName = "packages/api/src/routes/witness.ts") =>
    finalWriteFindings(fileName, source).map((finding) => finding.replace(/^.*?:\d+ — /, ""));

  it("lets an updateRun through whose second argument is a literal without a status", () => {
    expect(seen(`db.updateRun(id, { machine_id: m, phase_timings: p });`)).toEqual([]);
    expect(seen(`await this.db.updateRun(runId, ({ usage_total_tokens: 1 }) as Patch);`)).toEqual(
      [],
    );
  });

  it("refuses a status, however it is written", () => {
    expect(seen(`db.updateRun(id, { status: "failed" });`)).toEqual(["updateRun carries a status"]);
    expect(seen(`db.updateRun(id, { "status": "failed" });`)).toEqual([
      "updateRun carries a status",
    ]);
    expect(seen(`db.updateRun(id, { status });`)).toEqual(["updateRun carries a status"]);
    expect(seen(`db?.updateRun(id, ({ status: "x" }) as Patch);`)).toEqual([
      "updateRun carries a status",
    ]);
    expect(seen(`db["updateRun"](id, { status: "x" });`)).toEqual(["updateRun carries a status"]);
  });

  it("refuses a second argument the syntax cannot read: a variable, a spread, a computed name, none", () => {
    expect(seen(`db.updateRun(id, patch);`)).toEqual([
      "updateRun's second argument is not an object literal",
    ]);
    expect(seen(`db.updateRun(id, { ...patch });`)).toEqual([
      "updateRun's second argument spreads another object",
    ]);
    expect(seen(`db.updateRun(id, { [key]: value });`)).toEqual([
      "updateRun's second argument has a computed property name",
    ]);
    expect(seen(`db.updateRun(id);`)).toEqual(["updateRun is called without a second argument"]);
  });

  it("refuses either method reached other than as the callee of a call", () => {
    expect(seen(`const write = db.updateRun; write(id, {});`)).toEqual([
      "updateRun is reached other than as the callee of a call",
    ]);
    expect(seen(`const { finishRun } = db;`)).toEqual(["finishRun is destructured"]);
    expect(seen(`const { updateRun: write } = db;`)).toEqual(["updateRun is destructured"]);
  });

  it("lets finishRun through only inside finalizeRun of routes/_helpers.ts", () => {
    const finalizer = `export async function finalizeRun() { await db.finishRun(id, w); }`;
    expect(seen(finalizer, FINALIZER_FILE)).toEqual([]);
    expect(seen(finalizer)).toEqual(["finishRun is called outside finalizeRun"]);
    expect(
      seen(
        `${finalizer}\nexport async function other() { await db.finishRun(id, w); }`,
        FINALIZER_FILE,
      ),
    ).toEqual(["finishRun is called outside finalizeRun"]);
  });

  it("does not see a write named in a comment or a string", () => {
    expect(seen(`// db.updateRun(id, { status })\nconst s = "db.finishRun(id, w)";`)).toEqual([]);
  });

  it("names the file and the line", () => {
    expect(
      finalWriteFindings("packages/api/src/x.ts", `\n\ndb.updateRun(id, { status: "failed" });`),
    ).toEqual(["packages/api/src/x.ts:3 — updateRun carries a status"]);
  });
});

describe("the final write of a run, in the API's sources", () => {
  const files = sourceFiles(API_SRC).map((path) => ({
    path: repoPath(path),
    source: readFileSync(path, "utf-8"),
  }));

  it("reads the API's sources, the backends left out", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(({ path }) => path === FINALIZER_FILE)).toBe(true);
    expect(files.some(({ path }) => path.startsWith("packages/api/src/db/"))).toBe(false);
  });

  it("finds one finalizeRun in routes/_helpers.ts, and the final write inside it", () => {
    const helpers = files.find(({ path }) => path === FINALIZER_FILE);
    const file = ts.createSourceFile(
      FINALIZER_FILE,
      helpers?.source ?? "",
      ts.ScriptTarget.Latest,
      true,
    );
    const bodies = finalizerBodies(file);
    expect(bodies).toHaveLength(1);
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (reachedMethod(node) === "finishRun") calls.push(node.getText(file));
      ts.forEachChild(node, visit);
    };
    for (const body of bodies) visit(body);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("writes a final status nowhere else", () => {
    expect(files.flatMap(({ path, source }) => finalWriteFindings(path, source))).toEqual([]);
  });
});
