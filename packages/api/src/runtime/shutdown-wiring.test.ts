import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Both entry points of the API — server.ts, the published image's, and
 * dev.ts, the source tree's — stop on a signal by ending their runs in
 * flight. Read in the syntax (the TypeScript parser, no type check), each
 * must:
 * - import `installShutdownHandlers` from ./runtime/in-flight-runs.js, as a
 *   value (an alias is fine, a type-only import is not);
 * - call it once, as a statement at the module's top level — never inside a
 *   function, which might never run;
 * - hand it, as `server`, the server it starts: a top-level `const` whose
 *   value is a call of `serve` from @hono/node-server;
 * - hand it, as `pool`, the pool of the runtime it runs — a property read
 *   ending in `.pool` (`runtime.flyioDeps?.pool`): without it, a stop leaves
 *   the cloud runtime's maintenance running and its ready machines paused,
 *   billing. Absent on the local runtime, the read gives nothing, and the stop
 *   does what it did.
 * Each finding names its file and line.
 *
 * What it does not see: what the handlers do (the stop's own tests), and
 * whether a signal reaches them — a real process does (shutdown-signal.test.ts).
 */

const API_SRC = join(import.meta.dirname, "..");
const ENTRY_POINTS = ["server.ts", "dev.ts"];
const HANDLERS_MODULE = "./runtime/in-flight-runs.js";
const HANDLERS = "installShutdownHandlers";
const SERVER_MODULE = "@hono/node-server";
const SERVE = "serve";

/** The local names a file binds, by value, to `exported` of `module`. */
function importedAs(source: ts.SourceFile, module: string, exported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== module) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      if ((element.propertyName ?? element.name).text === exported) names.add(element.name.text);
    }
  }
  return names;
}

/** The top-level `const` names whose value is a call of one of `callees`. */
function constsFromCall(source: ts.SourceFile, callees: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        value !== undefined &&
        ts.isCallExpression(value) &&
        ts.isIdentifier(value.expression) &&
        callees.has(value.expression.text)
      ) {
        names.add(declaration.name.text);
      }
    }
  }
  return names;
}

/** The identifier an object literal hands as its `server` property, if it hands one so. */
function serverHanded(argument: ts.Expression | undefined): ts.Identifier | undefined {
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) return undefined;
  for (const property of argument.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "server") {
      return property.name;
    }
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "server" &&
      ts.isIdentifier(property.initializer)
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * Whether an object literal hands, as its `pool` property, a property read
 * named `pool` — `runtime.flyioDeps?.pool`, `deps.pool` —, never a literal, an
 * `undefined`, or nothing.
 */
function poolHanded(argument: ts.Expression | undefined): boolean {
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) return false;
  for (const property of argument.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "pool" &&
      ts.isPropertyAccessExpression(property.initializer) &&
      property.initializer.name.text === "pool"
    ) {
      return true;
    }
  }
  return false;
}

/** What is wrong with an entry point's wiring of the stop; empty when it is right. */
function wiringFaults(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const handlers = importedAs(source, HANDLERS_MODULE, HANDLERS);
  if (handlers.size === 0) {
    return [`${fileName} — ${HANDLERS} is not imported from ${HANDLERS_MODULE}`];
  }
  const servers = constsFromCall(source, importedAs(source, SERVER_MODULE, SERVE));

  const faults: string[] = [];
  let calls = 0;
  const visit = (node: ts.Node, topLevel: boolean) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      handlers.has(node.expression.text)
    ) {
      calls++;
      const asStatement = topLevel && ts.isExpressionStatement(node.parent);
      if (!asStatement) {
        faults.push(
          `${fileName}:${lineOf(node)} — ${HANDLERS} is called other than as a top-level statement`,
        );
      }
      const server = serverHanded(node.arguments[0]);
      if (server === undefined || !servers.has(server.text)) {
        faults.push(
          `${fileName}:${lineOf(node)} — ${HANDLERS} is not handed the server ${SERVE}() returned`,
        );
      }
      if (!poolHanded(node.arguments[0])) {
        faults.push(
          `${fileName}:${lineOf(node)} — ${HANDLERS} is not handed the pool of the runtime it runs`,
        );
      }
    }
    // A function's body may never run: nothing inside one is the module's top level.
    const nested = topLevel && !ts.isFunctionLike(node) && !ts.isClassLike(node);
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  for (const statement of source.statements) visit(statement, true);
  if (calls !== 1)
    faults.push(`${fileName} — ${HANDLERS} is called ${calls} times; once is required`);
  return faults;
}

const CALL = "installShutdownHandlers({ server, pool: runtime.flyioDeps?.pool });";

const RIGHT = [
  'import { serve } from "@hono/node-server";',
  'import { installShutdownHandlers } from "./runtime/in-flight-runs.js";',
  "const server = serve({ fetch: app.fetch, port }, () => {});",
  CALL,
].join("\n");

describe("both entry points install the stop's signal handlers — what the rule refuses", () => {
  it("a top-level call handed the served server and the runtime's pool passes, by its own name or an alias", () => {
    expect(wiringFaults("entry.ts", RIGHT)).toEqual([]);
    const aliased = RIGHT.replace(
      "import { installShutdownHandlers }",
      "import { installShutdownHandlers as onStop }",
    ).replace(CALL, "onStop({ server: server, pool: deps.pool });");
    expect(wiringFaults("entry.ts", aliased)).toEqual([]);
  });

  it("a call handed no pool, or something else than the runtime's, is named", () => {
    const without = RIGHT.replace(CALL, "installShutdownHandlers({ server });");
    expect(wiringFaults("entry.ts", without)).toEqual([
      "entry.ts:4 — installShutdownHandlers is not handed the pool of the runtime it runs",
    ]);
    for (const other of ["pool: undefined", "pool: pool", "pool: null", "pool"]) {
      const wrong = RIGHT.replace(CALL, `installShutdownHandlers({ server, ${other} });`);
      expect(wiringFaults("entry.ts", wrong), other).toEqual([
        "entry.ts:4 — installShutdownHandlers is not handed the pool of the runtime it runs",
      ]);
    }
  });

  it("no import, or a type-only one, is named", () => {
    const without = RIGHT.replace(
      'import { installShutdownHandlers } from "./runtime/in-flight-runs.js";\n',
      "",
    );
    expect(wiringFaults("entry.ts", without)).toEqual([
      "entry.ts — installShutdownHandlers is not imported from ./runtime/in-flight-runs.js",
    ]);
    const typeOnly = RIGHT.replace(
      "import { installShutdownHandlers }",
      "import type { installShutdownHandlers }",
    );
    expect(wiringFaults("entry.ts", typeOnly)).toEqual([
      "entry.ts — installShutdownHandlers is not imported from ./runtime/in-flight-runs.js",
    ]);
  });

  it("an import never called — or called only in a comment or a string — is named", () => {
    const uncalled = RIGHT.replace(
      CALL,
      `// ${CALL}\nconst s = "installShutdownHandlers({ server })";`,
    );
    expect(wiringFaults("entry.ts", uncalled)).toEqual([
      "entry.ts — installShutdownHandlers is called 0 times; once is required",
    ]);
  });

  it("a call inside a function, which may never run, is named", () => {
    const nested = RIGHT.replace(CALL, `function later() {\n  ${CALL}\n}`);
    expect(wiringFaults("entry.ts", nested)).toEqual([
      "entry.ts:5 — installShutdownHandlers is called other than as a top-level statement",
    ]);
    const inCallback = RIGHT.replace(
      CALL,
      "process.on('ready', () => installShutdownHandlers({ server, pool: runtime.flyioDeps?.pool }));",
    );
    expect(wiringFaults("entry.ts", inCallback)).toEqual([
      "entry.ts:4 — installShutdownHandlers is called other than as a top-level statement",
    ]);
  });

  it("a call handed another server, or none, is named", () => {
    const other = RIGHT.replace(
      CALL,
      "installShutdownHandlers({ server: other, pool: runtime.flyioDeps?.pool });",
    );
    expect(wiringFaults("entry.ts", other)).toEqual([
      "entry.ts:4 — installShutdownHandlers is not handed the server serve() returned",
    ]);
    const none = RIGHT.replace(CALL, "installShutdownHandlers({ pool: runtime.flyioDeps?.pool });");
    expect(wiringFaults("entry.ts", none)).toEqual([
      "entry.ts:4 — installShutdownHandlers is not handed the server serve() returned",
    ]);
    const notServed = RIGHT.replace(
      "const server = serve({ fetch: app.fetch, port }, () => {});",
      "const server = createServer();",
    );
    expect(wiringFaults("entry.ts", notServed)).toEqual([
      "entry.ts:4 — installShutdownHandlers is not handed the server serve() returned",
    ]);
    // Handed nothing at all: both are named.
    const empty = RIGHT.replace(CALL, "installShutdownHandlers({});");
    expect(wiringFaults("entry.ts", empty)).toEqual([
      "entry.ts:4 — installShutdownHandlers is not handed the server serve() returned",
      "entry.ts:4 — installShutdownHandlers is not handed the pool of the runtime it runs",
    ]);
  });

  it("two calls are named", () => {
    const twice = `${RIGHT}\n${CALL}`;
    expect(wiringFaults("entry.ts", twice)).toEqual([
      "entry.ts — installShutdownHandlers is called 2 times; once is required",
    ]);
  });
});

describe("both entry points install the stop's signal handlers", () => {
  it.each(
    ENTRY_POINTS,
  )("%s calls installShutdownHandlers once, at its top level, with the server it serves and its runtime's pool", (file) => {
    const text = readFileSync(join(API_SRC, file), "utf-8");
    expect(wiringFaults(file, text)).toEqual([]);
  });
});
