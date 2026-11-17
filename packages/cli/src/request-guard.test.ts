import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every request the CLI sends to a server leaves from one module: the single
 * sender of `utils/auth.ts`, which carries only the token saved for the address
 * it is given and follows no redirect, and the registry client of
 * `utils/registry-client.ts`, whose every route goes through it. Nothing else
 * under `packages/cli/src` may send a request, set an Authorization header,
 * read the sign-in file, build a registry client, or import from
 * `utils/auth.ts` a name outside a closed list — none of which hands out a
 * token. This test reads the sources to keep it so.
 *
 * Read in the syntax (the TypeScript parser, no type check), never in the
 * text: a comment is not in the tree, and a string is told from an identifier.
 * It reads every `.ts`, `.mts` and `.cts` file under `src`, tests (`*.test.*`),
 * shared test helpers (`*.shared.*`) and declarations left out.
 * What it refuses, outside the two modules:
 *   - `fetch` used as a value — called, or passed along by reference
 *     (`{ fetchFn: fetch }`, `{ fetch }`, `const send = fetch`) — and
 *     `globalThis.fetch`, `globalThis["fetch"]`, the same on `self`, `window`
 *     and `global`, the object in brackets or under a type assertion too
 *     (`(globalThis).fetch`); `fetch` in a type (`typeof fetch`), as a key, or
 *     as the member of another object is not;
 *   - the identifier `fetchFn`, anywhere;
 *   - an import — static, `import()`, `require()`, `process.getBuiltinModule()`
 *     (`process["getBuiltinModule"]()` and `globalThis.process.getBuiltinModule()`
 *     too) — of `node:https`, `node:http2`, `node:net`, `node:tls` or `undici`
 *     (with or without the `node:` prefix), and of `node:http` on its request side
 *     (`request`, `get`, `Agent`, `ClientRequest`, or the whole module);
 *     `createServer` stays allowed (the local dev server), and so does an
 *     import of types;
 *   - `WebSocket` used as a value;
 *   - an Authorization header, in any case: a key, a member or a string equal
 *     to `authorization`, or a string or template text that holds
 *     `authorization:` (a header written out) — `"authorization_pending"` is
 *     none of these;
 *   - `new RegistryClient(…)`;
 *   - a string that names `config.json`, the sign-in file;
 *   - an import from `utils/auth.js` of a name outside IMPORTABLE_FROM_AUTH, of
 *     every name at once (`import * as`), or a dynamic one.
 *
 * What it does not see: `Reflect.get(globalThis, "fetch")`, `eval`, the global
 * object under another name (`const g = globalThis; g.fetch(…)`), a computed
 * member (`globalThis[name]`); a module loaded by a function that
 * `createRequire()` of `node:module` returns (`createRequire(…)("node:https")`),
 * or by `process.getBuiltinModule` reached under another name or called as a
 * value (`(0, process.getBuiltinModule)("node:https")`); a process
 * started through `node:child_process` — allowed, it opens the browser at
 * sign-in — so a `spawn("curl", …)` or an `execFile` that sends a request
 * would pass; a request sent by another package
 * (`skrun admin` reaches the cloud provider's machine API through the runtime's
 * client, with that provider's token, never a Skrun server nor the session
 * token); `bin/skrun.js`, outside `src`.
 *
 * EXEMPT names the two modules, each with what it may hold and why: the sender,
 * every kind of finding; the registry client, only building the client and two
 * names of `utils/auth.ts` — a request sent around the sender from its module
 * is seen. An exemption, a kind or a name that covers nothing fails, so none
 * can outlive its module's role. PENDING is the ratchet — the files still
 * holding a finding, with their number — and no entry of it reaches the main
 * branch. Both are closed: an entry that finds fewer or more than it declares
 * fails.
 */

const SRC_ROOT = import.meta.dirname;
const AUTH_MODULE = join(SRC_ROOT, "utils", "auth.js");

/** What a finding is. */
type What =
  | "fetch used as a value"
  | "fetchFn"
  | "a network client imported"
  | "WebSocket used as a value"
  | "an Authorization header"
  | "a registry client built"
  | "the sign-in file named"
  | "imported from utils/auth.js outside the closed list";

interface Finding {
  line: number;
  what: What;
}

/** What a module of the single sender may hold, and why. */
interface Exemption {
  reason: string;
  /** The kinds of finding it may hold: every one, or these only. */
  kinds: "every kind" | readonly What[];
  /** The names it may import from `utils/auth.js` beyond the closed list, each with its reason. */
  importsFromAuth?: Readonly<Record<string, string>>;
}

/**
 * The two modules of the single sender. The sender may hold every kind of
 * finding; the registry client, only what it does — build the one client and
 * read the namespace saved with a session: a `fetch`, an Authorization header,
 * a network module or another name of `utils/auth.js` there is a finding, as
 * anywhere else.
 */
const EXEMPT: Readonly<Record<string, Exemption>> = {
  "utils/auth.ts": {
    reason:
      "the single sender: the one module that reads the sign-in file, and the one place a request leaves from — with the token saved for the address it is given, and no redirect followed",
    kinds: "every kind",
  },
  "utils/registry-client.ts": {
    reason:
      "the registry client: every route of a server, each sent through the single sender; the one place a client is built (connect)",
    kinds: ["a registry client built"],
    importsFromAuth: {
      cachedNamespace:
        "the namespace saved with a server's session, without a request: never the token",
      cacheNamespace:
        "saves the namespace a server named with that server's session: it hands no token out",
    },
  },
};

/**
 * The names a source may import from `utils/auth.js`, each with its reason.
 * None hands out a token. Closed: a name that no source imports any more fails.
 */
const IMPORTABLE_FROM_AUTH: Readonly<Record<string, string>> = {
  resolveTarget: "the server a command talks to, and where that came from: an address, no token",
  normalizeRegistryUrl: "an address checked and put in one form: no token",
  isLoopback: "whether an address is this machine: a yes or a no",
  sessionState: "whether a session is saved for a server: its state, never its token",
  signInCommand: "the sign-in command the CLI advises for a server: an address at most, no token",
  saveSession: "saves a session after a sign-in: it writes a token, it hands none out",
  removeSession: "removes one server's session",
  removeOlderConfig: "removes a sign-in file this CLI cannot read, sending nothing",
  send: "the single sender itself: the token it carries is the one saved for the address it is given",
  checkToken:
    "asks a server whether it accepts a token the user typed, before it is saved: the token goes to that server only",
  InvalidRegistryUrl: "a typed error: names where an address came from, never the value",
  NotSignedIn: "a typed error: no session for a server, nothing sent",
  RedirectRefused: "a typed error: a redirect not followed, its target named",
  Unreachable: "a typed error: a server that could not be reached, and the cause",
};

/**
 * The ratchet: files still holding findings, and how many — none left. An
 * entry added here holds a finding for the time of a change, and leaves with it.
 */
const PENDING: Readonly<Record<string, number>> = {};

const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window", "global"]);
/** Modules that open connections, by their name without the `node:` prefix. */
const NETWORK_MODULES = new Set(["https", "http2", "net", "tls", "undici"]);
/** What `node:http` exports to send a request, rather than to serve one. */
const HTTP_REQUEST_SIDE = new Set(["request", "get", "Agent", "ClientRequest"]);
const SIGN_IN_FILE = /(?<![\w-])config\.json/i;

const bareModule = (specifier: string): string => specifier.replace(/^node:/, "");

/** Whether a node sits in a type: it loads and sends nothing. */
function inType(node: ts.Node): boolean {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isTypeNode(n)) return true;
  }
  return false;
}

/** Whether an identifier is the name of a key or a member, rather than a value. */
function isKeyOrMemberName(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  );
}

/**
 * The object of `node` when `node` is its member `name`, written `.name` or
 * `["name"]` — unwrapped (`unwrapped`); undefined when `node` is not that member.
 */
function memberObject(node: ts.Node, name: string): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
    return unwrapped(node.expression);
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === name
  ) {
    return unwrapped(node.expression);
  }
  return undefined;
}

/** Whether `node` is `<global object>.<name>` or `<global object>["<name>"]`. */
function isGlobalMember(node: ts.Node, name: string): boolean {
  const object = memberObject(node, name);
  return object !== undefined && ts.isIdentifier(object) && GLOBAL_OBJECTS.has(object.text);
}

/** An expression without the brackets, type assertions and `!` around it: `(globalThis as T)` is `globalThis`. */
function unwrapped(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** Whether an identifier named `name` is used as a value: neither a key, a member name, nor a type. */
function isValueUse(id: ts.Identifier, name: string): boolean {
  return id.text === name && !isKeyOrMemberName(id) && !inType(id);
}

/**
 * Whether a callee is `process.getBuiltinModule`, which loads a builtin module
 * at run time — written `process["getBuiltinModule"]` too, and on the global
 * object's `process` (`globalThis.process.getBuiltinModule`).
 */
function isGetBuiltinModule(callee: ts.Expression): boolean {
  const object = memberObject(callee, "getBuiltinModule");
  if (object === undefined) return false;
  return (
    (ts.isIdentifier(object) && object.text === "process") || isGlobalMember(object, "process")
  );
}

/**
 * The module an `import()`, a `require()` or a `process.getBuiltinModule()`
 * loads, when it is named by a literal.
 */
function loadedModule(call: ts.CallExpression): string | undefined {
  const callee = unwrapped(call.expression);
  const loads =
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require") ||
    isGetBuiltinModule(callee);
  const first = call.arguments[0];
  return loads && first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
}

/** Whether a static import loads a value of a network module (an import of types loads nothing). */
function importsNetworkClient(declaration: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (
    declaration.moduleSpecifier === undefined ||
    !ts.isStringLiteral(declaration.moduleSpecifier)
  ) {
    return false;
  }
  const module = bareModule(declaration.moduleSpecifier.text);
  if (module !== "http" && !NETWORK_MODULES.has(module)) return false;
  if (ts.isExportDeclaration(declaration)) return !declaration.isTypeOnly;
  const clause = declaration.importClause;
  if (clause === undefined) return true; // loaded for its effects
  if (clause.isTypeOnly) return false;
  const named = clause.namedBindings;
  const valueNames =
    named !== undefined && ts.isNamedImports(named)
      ? named.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text)
      : [];
  if (NETWORK_MODULES.has(module)) {
    return (
      clause.name !== undefined ||
      (named !== undefined && !ts.isNamedImports(named)) ||
      valueNames.length > 0
    );
  }
  // node:http: the whole module, or a name of its request side.
  return (
    clause.name !== undefined ||
    (named !== undefined && ts.isNamespaceImport(named)) ||
    valueNames.some((name) => HTTP_REQUEST_SIDE.has(name))
  );
}

/** Whether a module specifier, written in `fileName`, designates `utils/auth.js`. */
function isAuthModule(fileName: string, specifier: string): boolean {
  return resolve(dirname(join(SRC_ROOT, fileName)), specifier) === AUTH_MODULE;
}

/** The names an import or re-export takes from `utils/auth.js`; `"*"` for all of them at once. */
function namesTakenFromAuth(declaration: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isExportDeclaration(declaration)) {
    if (declaration.isTypeOnly) return [];
    const clause = declaration.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return ["*"];
    return clause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
  }
  const clause = declaration.importClause;
  if (clause === undefined || clause.isTypeOnly) return [];
  const names: string[] = clause.name === undefined ? [] : ["default"];
  const named = clause.namedBindings;
  if (named !== undefined && ts.isNamespaceImport(named)) names.push("*");
  if (named !== undefined && ts.isNamedImports(named)) {
    for (const e of named.elements) if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
  }
  return names;
}

/**
 * Every finding of one source, by line; `fileName` is its path under `src`,
 * `importable` the names it may import from `utils/auth.js`.
 */
function findingsIn(
  fileName: string,
  source: string,
  importable: Readonly<Record<string, string>> = IMPORTABLE_FROM_AUTH,
): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = new Map<string, Finding>();
  const add = (node: ts.Node, what: What): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    found.set(`${line} ${what}`, { line, what });
  };

  const authImports = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isAuthModule(fileName, node.moduleSpecifier.text)
    ) {
      const outside = namesTakenFromAuth(node).filter((name) => !Object.hasOwn(importable, name));
      if (outside.length > 0) add(node, "imported from utils/auth.js outside the closed list");
    }
    if (ts.isCallExpression(node)) {
      const module = loadedModule(node);
      if (module !== undefined && isAuthModule(fileName, module)) {
        add(node, "imported from utils/auth.js outside the closed list");
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (isValueUse(node, "fetch")) add(node, "fetch used as a value");
      if (node.text === "fetchFn") add(node, "fetchFn");
      if (isValueUse(node, "WebSocket")) add(node, "WebSocket used as a value");
      if (node.text.toLowerCase() === "authorization") add(node, "an Authorization header");
    }
    if (isGlobalMember(node, "fetch")) add(node, "fetch used as a value");
    if (isGlobalMember(node, "WebSocket")) add(node, "WebSocket used as a value");
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.text.toLowerCase();
      if (text === "authorization" || text.includes("authorization:")) {
        add(node, "an Authorization header");
      }
      if (SIGN_IN_FILE.test(node.text)) add(node, "the sign-in file named");
    }
    if (
      ts.isNewExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "RegistryClient") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "RegistryClient"))
    ) {
      add(node, "a registry client built");
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      importsNetworkClient(node)
    ) {
      add(node, "a network client imported");
    }
    if (ts.isCallExpression(node)) {
      const module = loadedModule(node);
      if (module !== undefined) {
        const bare = bareModule(module);
        if (bare === "http" || NETWORK_MODULES.has(bare)) add(node, "a network client imported");
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const bare = bareModule(node.moduleReference.expression.text);
      if (bare === "http" || NETWORK_MODULES.has(bare)) add(node, "a network client imported");
    }
    authImports(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found.values()].sort((a, b) => a.line - b.line || a.what.localeCompare(b.what));
}

/** The names each source imports from `utils/auth.js`, read in its syntax. */
function namesImportedFromAuth(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return file.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    isAuthModule(fileName, statement.moduleSpecifier.text)
      ? namesTakenFromAuth(statement)
      : [],
  );
}

/** The findings of a source, read with the names its module may import from `utils/auth.js`. */
function findingsOf(file: string, source: string): Finding[] {
  const extra = Object.hasOwn(EXEMPT, file) ? EXEMPT[file]?.importsFromAuth : undefined;
  return findingsIn(file, source, { ...IMPORTABLE_FROM_AUTH, ...extra });
}

/** Whether the exemption of `file`, if any, covers a finding of that kind. */
function covered(file: string, what: What): boolean {
  if (!Object.hasOwn(EXEMPT, file)) return false;
  const kinds = EXEMPT[file]?.kinds;
  return kinds === "every kind" || (kinds?.includes(what) ?? false);
}

/** The findings of a source that the exemption of its module does not cover. */
function uncovered(file: string, source: string): Finding[] {
  return findingsOf(file, source).filter((finding) => !covered(file, finding.what));
}

/**
 * Whether a file name is a source the guard reads — `.ts`, `.mts` or `.cts`,
 * all three compiled into the CLI; tests, shared test helpers and declarations
 * are not.
 */
function isSourceName(name: string): boolean {
  return (
    /\.[cm]?ts$/.test(name) &&
    !/\.d\.[cm]?ts$/.test(name) &&
    !name.includes(".test.") &&
    !name.includes(".shared.")
  );
}

/** The CLI's sources, tests and shared test helpers left out, by their path under `src`. */
function cliSources(dir = SRC_ROOT): Array<{ file: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cliSources(path);
    return isSourceName(entry.name)
      ? [
          {
            file: relative(SRC_ROOT, path).replaceAll("\\", "/"),
            source: readFileSync(path, "utf8"),
          },
        ]
      : [];
  });
}

describe("what the request guard sees in a source", () => {
  const seen = (source: string): string[] =>
    findingsIn("commands/witness.ts", source).map((f) => `${f.line} ${f.what}`);

  it("sees each way a source could send a request, read a token or reach the sign-in file, by its line", () => {
    const source = [
      /* 1 */ "const a = await fetch(url);",
      /* 2 */ "const b = await globalThis.fetch(url, init);",
      /* 3 */ 'const c = globalThis["fetch"];',
      /* 4 */ "const d = [self.fetch, window.fetch, global.fetch];",
      /* 5 */ "const sendIt = fetch;",
      /* 6 */ "await deviceLogin({ fetchFn: fetch });",
      /* 7 */ "call({ fetch });",
      /* 8 */ "await deps.fetchFn(url);",
      /* 9 */ 'import { request } from "node:http";',
      /* 10 */ 'import * as http from "node:http";',
      /* 11 */ 'import httpDefault from "http";',
      /* 12 */ 'import { Agent } from "node:http";',
      /* 13 */ 'import https from "node:https";',
      /* 14 */ 'import { connect } from "node:net";',
      /* 15 */ 'import { connect as tlsConnect } from "tls";',
      /* 16 */ 'import { connect as h2 } from "node:http2";',
      /* 17 */ 'const undici = await import("undici");',
      /* 18 */ 'const tls = require("node:tls");',
      /* 19 */ "const ws = new WebSocket(url);",
      /* 20 */ "headers.Authorization = token;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a source, whose template is the point
      /* 21 */ "const h = { Authorization: `Bearer ${t}` };",
      /* 22 */ 'const h2 = { "authorization": t };',
      /* 23 */ `console.log('  -H "Authorization: Bearer <your-token>"');`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a source, whose template is the point
      /* 24 */ 'console.log(`    -H "Authorization: Bearer ${t}" \\\\`);',
      /* 25 */ "const client = new RegistryClient(address, token);",
      /* 26 */ 'const path = join(homedir(), ".skrun", "config.json");',
      /* 27 */ 'import { readToken } from "../utils/auth.js";',
      /* 28 */ 'import * as auth from "../utils/auth.js";',
      /* 29 */ 'const later = await import("../utils/auth.js");',
      /* 30 */ 'const https2 = process.getBuiltinModule("node:https");',
      /* 31 */ 'const http2 = process.getBuiltinModule("http");',
      /* 32 */ "const g = await (globalThis).fetch(url);",
      /* 33 */ "const h = (globalThis as typeof globalThis).fetch;",
      /* 34 */ 'const https3 = process["getBuiltinModule"]("node:https");',
      /* 35 */ 'const tls2 = globalThis.process.getBuiltinModule("node:tls");',
    ].join("\n");

    expect(seen(source)).toEqual([
      "1 fetch used as a value",
      "2 fetch used as a value",
      "3 fetch used as a value",
      "4 fetch used as a value",
      "5 fetch used as a value",
      "6 fetch used as a value",
      "6 fetchFn",
      "7 fetch used as a value",
      "8 fetchFn",
      "9 a network client imported",
      "10 a network client imported",
      "11 a network client imported",
      "12 a network client imported",
      "13 a network client imported",
      "14 a network client imported",
      "15 a network client imported",
      "16 a network client imported",
      "17 a network client imported",
      "18 a network client imported",
      "19 WebSocket used as a value",
      "20 an Authorization header",
      "21 an Authorization header",
      "22 an Authorization header",
      "23 an Authorization header",
      "24 an Authorization header",
      "25 a registry client built",
      "26 the sign-in file named",
      "27 imported from utils/auth.js outside the closed list",
      "28 imported from utils/auth.js outside the closed list",
      "29 imported from utils/auth.js outside the closed list",
      "30 a network client imported",
      "31 a network client imported",
      "32 fetch used as a value",
      "33 fetch used as a value",
      "34 a network client imported",
      "35 a network client imported",
    ]);
  });

  it.each([
    ["commands/elsewhere.ts", true],
    ["commands/elsewhere.mts", true],
    ["commands/elsewhere.cts", true],
    ["commands/elsewhere.test.ts", false],
    ["commands/elsewhere.test.mts", false],
    ["utils/helper.shared.ts", false],
    ["utils/helper.shared.cts", false],
    ["types/globals.d.ts", false],
    ["types/globals.d.mts", false],
    ["bin/skrun.js", false],
  ])("reads %s as a source: %s", (file, read) => {
    expect(isSourceName(file.split("/").at(-1) as string)).toBe(read);
  });

  it("does not see a message, a comment, a server, a type, a key, the opener of the browser or a name of the closed list", () => {
    const source = [
      // The message of a failed request, a device-flow code, and comments that name the header.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a source, whose template is the point
      "throw new Error(`Failed to fetch logs (${res.status})`);",
      'if (code === "authorization_pending") {}',
      "/**",
      " * Run the OAuth 2.0 Device Authorization Grant (RFC 8628) login.",
      " */",
      "// fetch(url) with an Authorization header, then new RegistryClient(url)",
      // Serving, not sending; types; the browser's opener.
      'import { createServer } from "node:http";',
      'import type { Server } from "node:http";',
      'import { type IncomingMessage } from "node:http";',
      'import { execFile } from "node:child_process";',
      "interface Deps { send: typeof fetch; socket?: WebSocket }",
      // A key named fetch, the member of another object, a string about sockets.
      "const options = { fetch: 1 };",
      "const r = res.fetch;",
      'const note = "WebSocket is not used";',
      'const tsconfig = "tsconfig.json";',
      // A builtin that opens no connection, loaded at run time.
      'const fs = process.getBuiltinModule("node:fs");',
      // Names of the closed list, and an import of types.
      'import { InvalidRegistryUrl, resolveTarget, send } from "../utils/auth.js";',
      'import type { Session } from "../utils/auth.js";',
    ].join("\n");

    expect(seen(source)).toEqual([]);
  });

  it("sees, in the registry client's own module, a request sent around the single sender: that module is exempt for what it does, not whole", () => {
    const client = readFileSync(join(SRC_ROOT, "utils", "registry-client.ts"), "utf8");
    const added = [
      "export async function runDirect(url: string, key: string): Promise<Response> {",
      '  return fetch(url, { method: "POST", headers: { "X-LLM-API-Key": key }, body: "{}" });',
      "}",
      'export const tokenHeader = (t: string) => ({ Authorization: "Bearer " + t });',
      'import { request } from "node:https";',
      'import { readToken } from "./auth.js";',
    ];
    const first = client.split(/\r?\n/).length + 1;
    const witness = `${client}\n${added.join("\n")}\n`;

    expect(uncovered("utils/registry-client.ts", client)).toEqual([]);
    expect(
      uncovered("utils/registry-client.ts", witness).map((f) => `${f.line - first} ${f.what}`),
    ).toEqual([
      "1 fetch used as a value",
      "3 an Authorization header",
      "4 a network client imported",
      "5 imported from utils/auth.js outside the closed list",
    ]);
  });
});

describe("the CLI's sources", () => {
  const sources = cliSources();
  const all = sources.flatMap(({ file, source }) =>
    findingsOf(file, source).map((finding) => ({
      file,
      ...finding,
      text: source.split(/\r?\n/)[finding.line - 1]?.trim() ?? "",
    })),
  );
  const outside = all.filter((finding) => !covered(finding.file, finding.what));

  it("are read, the two modules of the single sender among them", () => {
    const files = sources.map(({ file }) => file);
    expect(files).toContain("commands/login.ts");
    for (const file of Object.keys(EXEMPT)) expect(files).toContain(file);
  });

  it("send requests, set the Authorization header, read the sign-in file and build registry clients only in the two modules of the single sender", () => {
    const undeclared = outside.filter((finding) => !Object.hasOwn(PENDING, finding.file));
    // Named by file and line, so a failure says where it is.
    expect(undeclared.map((f) => `${f.file}:${f.line} ${f.what} — ${f.text}`)).toEqual([]);
  });

  it("keep the ratchet closed: each pending file still has exactly the findings it declares", () => {
    const wrong = Object.entries(PENDING).flatMap(([file, declared]) => {
      const found = outside.filter((finding) => finding.file === file).length;
      return found === declared ? [] : [`${file}: ${declared} declared, ${found} found`];
    });
    expect(wrong).toEqual([]);
  });

  it("exempt only modules that do send, for what they do: an exemption, a kind or a name that covers nothing is stale", () => {
    const stale = Object.entries(EXEMPT).flatMap(([file, { kinds, importsFromAuth }]) => {
      const found = all.filter((finding) => finding.file === file);
      const source = sources.find((s) => s.file === file)?.source ?? "";
      const imported = new Set(namesImportedFromAuth(file, source));
      return [
        ...(kinds === "every kind"
          ? found.length > 0
            ? []
            : [`${file}: no finding`]
          : kinds
              .filter((what) => !found.some((f) => f.what === what))
              .map((w) => `${file}: ${w}`)),
        ...Object.keys(importsFromAuth ?? {})
          .filter((name) => !imported.has(name))
          .map((name) => `${file}: ${name} no longer imported`),
      ];
    });
    expect(stale).toEqual([]);
  });

  it("import from utils/auth.js the names of the closed list, and each of them is still imported", () => {
    const imported = new Set(
      sources
        .filter(({ file }) => !covered(file, "imported from utils/auth.js outside the closed list"))
        .flatMap(({ file, source }) => namesImportedFromAuth(file, source)),
    );
    const unused = Object.keys(IMPORTABLE_FROM_AUTH).filter((name) => !imported.has(name));
    expect(unused).toEqual([]);
  });
});
