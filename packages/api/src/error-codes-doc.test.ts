import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every code of the global error-code table in docs/api.md is emitted by a
 * source of the API, the runtime or the schema. A listed code that nothing
 * emits tells a client to handle an answer it will never receive.
 *
 * "Emitted" is read in the syntax (the TypeScript parser, no type check),
 * never in the text, so a comment, a document or a test cannot satisfy it:
 * - a string literal that is the value of a `code` property of an object
 *   literal: directly, in parentheses, or as a branch of a conditional that
 *   is that value (`{ code: late ? "TIMEOUT" : "EXECUTION_FAILED" }` emits
 *   both; a literal in the condition emits nothing);
 * - the literal first argument of `new RegistryError(…)`,
 *   `new ResolveError(…)` or `new SkrunError(…)`, the classes that carry a
 *   code.
 * Sources: packages/{api,runtime,schema}/src, test files (`*.test.ts`) and
 * shared test helpers (`*.shared.ts`) excluded.
 *
 * What it does not see: a code passed through a variable or built at run
 * time. Such a code fails here, and is declared in ALLOWLIST with its reason.
 * It checks one direction only: a listed code that no source emits. An
 * emitted code missing from the table is not its concern — save the few of
 * REQUIRED, below, which the table must list by name. And "emitted" is a
 * shape, not a use: any literal in a `code` position anywhere in the three
 * trees counts, whatever object carries it — an example in the published
 * schema, an object that never leaves the process — so such a neighbour would
 * satisfy it for a code nothing answers with.
 *
 * The other direction, for a closed list: REQUIRED names the codes a client
 * is told to handle, and each must be a row of the table. The list is closed
 * on purpose — a code joins it by a change to this file, seen in review —, and
 * it says nothing of whether a code is emitted: the check above does that for
 * every listed code.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const API_DOC = join(REPO_ROOT, "docs", "api.md");
const SOURCE_PACKAGES = ["api", "runtime", "schema"] as const;
const CODE_CLASSES = new Set(["RegistryError", "ResolveError", "SkrunError"]);

/**
 * Codes the table may list although no source emits them as a literal, each
 * with its reason. Closed: an entry for a code that a source emits, or that
 * the table does not list, fails the suite.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  SERVER_STOPPED:
    "emitted through SHUTDOWN_RUN_ERROR_CODE (routes/_helpers.ts), the one constant every answer to a run the server's stop ended reads — the stream's run_error, the webhook delivery, the synchronous 503 — and the 503 that refuses a run sent once the stop has begun",
  DEADLINE_EXCEEDED:
    "emitted through RUN_DEADLINE_ERROR_CODE (routes/_helpers.ts), the one constant every answer to a run its deadline stopped reads — the stream's run_error, the webhook delivery, the synchronous 504",
  MCP_CONNECT_FAILED:
    "emitted through super(…) in McpConnectError (runtime/src/errors.ts), the error every failed connection to an MCP server raises — the local run route's 502 answers with its code",
};

/**
 * Codes the table must list, by name: the refusals a client is told to
 * handle. Closed: a code joins it by a change to this list; removing one of
 * these rows from the table fails the suite.
 */
const REQUIRED: readonly string[] = [
  "KEY_SCOPE_FORBIDDEN", // 403 — a key used beyond its scope
  "VERSION_EXISTS", // 409 — a push of a version already published
  "LLM_KEY_REQUIRED", // 400 — a run no model key can serve
  "CALLER_KEY_NOT_ALLOWED", // 403 — a caller's model key, to an agent that runs on its owner's
  "EXECUTION_FAILED", // 502 — a run whose execution failed
  "CALLER_BASE_URL_NOT_CONSENTED", // 403 — a caller's model key, for an endpoint not named
  "AGENT_NOT_FOUND", // 404 — the model keys of an agent not deployed yet
  "UNSUPPORTED_FIELD", // 400 — a setting no code honours yet: an MCP server's auth, a secret
  "MODEL_BASE_URL_REQUIRED", // 400 — meta with no endpoint, or as a fallback
  "TIMEOUT_OUT_OF_RANGE", // 400 — a timeout no timer can hold
  "SYNC_MODE_UNSUPPORTED", // 400 — a synchronous run, on a runtime that runs none
  "MCP_CONNECT_FAILED", // 502 — an MCP server the run could not connect to
  "TOO_MANY_TOOL_CALLS", // run_error — one answer of the model asked for more than 128 tool calls
  "MODEL_RESPONSE_TOO_LARGE", // run_error — a response of a model.base_url past 4 MiB
  "MODEL_OUTPUT_BUDGET_EXCEEDED", // run_error — the model's answers in a run past 4 MiB in all
  "OUTPUT_TOO_LARGE", // run_error — the JSON object of the final answer past 1 MiB
  "DATABASE_TIMEOUT", // 503 — the database did not answer in time
  "BUNDLE_DECOMPRESSED_TOO_LARGE", // 413 at push, 422 at run — a bundle that unpacks past the server's cap
  "BUNDLE_CORRUPT", // 400 at push — a body that is not a readable .agent archive
  "MISSING_CONFIG", // 400 at push — a bundle without agent.yaml
  "INVALID_CONFIG", // 400 at push — an agent.yaml that is not YAML, or that the schema refuses
  "CONFIG_TOO_LARGE", // 413 at push — an agent.yaml over its fixed 128 KB
  "PUSH_BUSY", // 503 at push — the reads that may wait all taken: send it again
];

interface ListedCode {
  code: string;
  line: number;
}

/** The rows of the table under the "### Error codes" heading. */
function listedCodes(markdown: string): ListedCode[] {
  const lines = markdown.split(/\r?\n/);
  const headings = lines.flatMap((line, i) => (line.trim() === "### Error codes" ? [i] : []));
  if (headings.length !== 1) {
    throw new Error(
      `docs/api.md: expected one "### Error codes" heading, found ${headings.length}`,
    );
  }
  let i = (headings[0] ?? 0) + 1;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  if (!/^\|\s*Code\s*\|/.test(lines[i] ?? "") || !/^\|[\s:|-]+$/.test(lines[i + 1] ?? "")) {
    throw new Error(`docs/api.md:${i + 1}: no "| Code | … |" table under "### Error codes"`);
  }
  const rows: ListedCode[] = [];
  for (i += 2; i < lines.length && lines[i]?.startsWith("|"); i++) {
    const firstCell = lines[i]?.split("|")[1]?.trim() ?? "";
    const match = /^`([A-Z][A-Z0-9_]*)`$/.exec(firstCell);
    if (!match?.[1]) {
      throw new Error(
        `docs/api.md:${i + 1}: the first cell is not one code in backticks: ${firstCell}`,
      );
    }
    rows.push({ code: match[1], line: i + 1 });
  }
  return rows;
}

/** Out of parentheses, and out of a conditional's branches (never its condition). */
function valuePosition(literal: ts.Node): ts.Node {
  let node = literal;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent)) node = parent;
    else if (ts.isConditionalExpression(parent) && parent.condition !== node) node = parent;
    else return node;
  }
}

function isCodePropertyValue(value: ts.Node): boolean {
  const property = value.parent;
  return (
    ts.isPropertyAssignment(property) &&
    property.initializer === value &&
    ts.isObjectLiteralExpression(property.parent) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
    property.name.text === "code"
  );
}

function isCodeClassFirstArgument(literal: ts.Node): boolean {
  const call = literal.parent;
  return (
    ts.isNewExpression(call) &&
    ts.isIdentifier(call.expression) &&
    CODE_CLASSES.has(call.expression.text) &&
    call.arguments?.[0] === literal
  );
}

/** The codes one source emits, read in its syntax. */
function emittedCodes(fileName: string, source: string): Set<string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const codes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) &&
      (isCodePropertyValue(valuePosition(node)) || isCodeClassFirstArgument(node))
    ) {
      codes.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return codes;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isSource = /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts");
    const isTestOnly = /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".shared.ts");
    return isSource && !isTestOnly ? [path] : [];
  });
}

describe("what counts as an emitted error code", () => {
  const emitted = (source: string) => [...emittedCodes("witness.ts", source)].sort();

  it("emits the literal value of a code property, directly or in parentheses", () => {
    expect(
      emitted(`const a = { code: "A" }; const b = { code: ("B") }; const c = { "code": "C" };`),
    ).toEqual(["A", "B", "C"]);
  });

  it("emits both branches of a conditional that is the value of code", () => {
    expect(emitted(`const e = { code: late ? "A" : "B" };`)).toEqual(["A", "B"]);
    expect(emitted(`const e = { code: a ? "A" : (b ? "B" : "D") };`)).toEqual(["A", "B", "D"]);
  });

  it("does not emit a literal of the condition", () => {
    expect(emitted(`const e = { code: x === "C" ? "A" : "B" };`)).toEqual(["A", "B"]);
    // The condition itself a literal: the only shape where climbing out of
    // the condition, not just the branches, would wrongly emit it.
    expect(emitted(`const e = { code: ("C") ? "A" : "B" };`)).toEqual(["A", "B"]);
  });

  it("emits the literal first argument of the three classes that carry a code, only them", () => {
    expect(
      emitted(
        `new RegistryError("R", "m", 409); new ResolveError("S"); new SkrunError("T");` +
          ` new Error("U"); new RegistryError(code, "V"); fail("W");`,
      ),
    ).toEqual(["R", "S", "T"]);
  });

  it("does not emit a code named in a comment, a type, another property or a plain string", () => {
    expect(
      emitted(
        `// { code: "CONFLICT" }\n/* new RegistryError("CONFLICT") */\n` +
          `type E = { code: "TYPED" }; const o = { kind: "KIND", codes: "CODES" };` +
          ` const s = "PLAIN"; const code = "BOUND";`,
      ),
    ).toEqual([]);
  });
});

describe("the error-code table of docs/api.md", () => {
  const listed = listedCodes(readFileSync(API_DOC, "utf-8"));
  const filesByPackage = SOURCE_PACKAGES.map((pkg) => ({
    pkg,
    files: sourceFiles(join(REPO_ROOT, "packages", pkg, "src")),
  }));
  const emitted = new Set<string>();
  for (const { files } of filesByPackage) {
    for (const file of files) {
      for (const code of emittedCodes(file, readFileSync(file, "utf-8"))) emitted.add(code);
    }
  }

  it("is found, not empty, and read from the three source trees", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const { pkg, files } of filesByPackage) {
      expect({ pkg, files: files.length > 0 }).toEqual({ pkg, files: true });
    }
  });

  it("lists only codes that a source emits", () => {
    const notEmitted = listed
      .filter(({ code }) => !emitted.has(code) && !Object.hasOwn(ALLOWLIST, code))
      .map(
        ({ code, line }) => `${relative(REPO_ROOT, API_DOC).replace(/\\/g, "/")}:${line} ${code}`,
      );
    expect(notEmitted).toEqual([]);
  });

  it("lists each code of the closed list a client is told to handle", () => {
    expect(REQUIRED.length).toBe(new Set(REQUIRED).size);
    const missing = REQUIRED.filter((code) => !listed.some((row) => row.code === code));
    expect(missing).toEqual([]);
  });

  it("keeps its allowlist closed: each entry is a listed code that no source emits", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (code) => emitted.has(code) || !listed.some((row) => row.code === code),
    );
    expect(stale).toEqual([]);
  });
});
