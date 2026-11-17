import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { errorFields as runtimeErrorFields } from "@skrun-dev/runtime";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { errorFields } from "./error-fields.js";

/**
 * No log line of the API, of the runtime it drives, or of the runner inside the
 * sandbox carries a caught error, save through errorFields().
 *
 * errorFields() gives a log line an error's class, code and HTTP status, never
 * its message: a message can quote a storage key, a file name or a URL, and a
 * log store is another destination, kept for another length of time. This test
 * holds every log call of three source trees to that rule — packages/api/src,
 * packages/runtime/src and infra/runtime-image/runner/src — read in the syntax
 * (the TypeScript parser, no type check):
 * - a log call is `<receiver>.<level>(…)` or `<receiver>?.<level>(…)`, the
 *   level one of trace, debug, info, warn, error, fatal and log. In the
 *   runner's sources, `process.stderr.write(…)` and `process.stdout.write(…)`
 *   are log calls too: that is how the runner logs;
 * - a caught error is the variable of a `catch (err)`, or the first parameter
 *   of a function passed to `.catch(…)`, as the second argument of
 *   `.then(…)`, to `.onError(…)`, the app's error handler, or as the third
 *   argument of hono's `stream(…)`, `streamText(…)` or `streamSSE(…)`, the
 *   handler of an error that escapes a stream. Those helpers are known by their
 *   import from `hono/streaming`, under an alias or through a namespace too;
 * - a local variable laundered from a caught error counts as the error itself:
 *   one whose initialiser, or a value assigned to it in its scope, references a
 *   caught error outside errorFields() (`const m = err.message;`). One level
 *   deep: a variable laundered from such a variable is not followed;
 * - a fault is a reference to a caught error, or to a laundered variable,
 *   anywhere in a log call's arguments or in its receiver — a child logger's
 *   bindings end up in the line it logs (`logger.child({ e: err.message })
 *   .warn(…)`) — save as the direct argument of errorFields(). `err.message`,
 *   `err.stack`, `String(err)`, a template that embeds `err`, `{ err }`, `err`
 *   alone and `(err as Error).message` all count.
 * A response (`c.json(…)`), an assignment and a `throw` are not log calls: they
 * stay silent. Sources: the .ts files of the three trees, test files
 * (`*.test.ts`) excluded.
 *
 * A fault kept on purpose is declared in ALLOWLIST, keyed by its file, from the
 * repository's root, and its `event`, with the number of calls that carry it
 * and its reason. The list is closed: an entry that no faulty call carries fails
 * too, so the change that fixes a call has to take its entry out; and an entry
 * the faulty calls outnumber fails, so a second faulty call with a declared
 * event is not covered by the first one's entry. Only a call with a literal
 * `event` can be declared, and only by that event: no entry covers a file, or
 * a call whose event is computed.
 *
 * A second rule holds the API's streaming helpers: every call passes its error
 * handler as its third argument, written in place. Without one, hono prints an
 * error that escapes the stream whole to stderr; passed by name, the rule
 * above could not read it.
 *
 * What it does not see:
 * - an error laundered twice or more (`const m = err.message; const n = m;`,
 *   then `log.warn({ n })`), or returned by a function before it is logged;
 * - an error that no catch binds: a Node-style callback, an `.on("error", …)`
 *   listener, or an error carried inside a value (`event.error.message`);
 * - a caught error handed to a helper that logs it: the helper's parameter is
 *   bound by no catch (`catch (err) { report(err); }`, where `report` writes
 *   `err.message`). The runner's dependency-install failure is logged that
 *   way on purpose: the tail of the installer's output, the run's values
 *   blanked;
 * - a rejection handler passed by name (`p.catch(onError)`,
 *   `p.then(onValue, onError)`): only a function written in place, as the
 *   argument itself, has its first parameter taken for a caught error;
 * - a streaming helper reached other than through an import from
 *   `hono/streaming` — re-exported by another module, say;
 * - a log method reached other than by property access (`logger["warn"]`, a
 *   detached method), and a write to stderr or stdout outside the runner;
 * - identifying fields (a URL, a key, a path): which ones a line may carry is
 *   decided where the line is written, not here;
 * - what a declared call carries beyond the fault it was declared for: an
 *   allowlist entry covers its whole call, every argument and its receiver, so
 *   a second faulty field added to that call passes here. What such a call
 *   writes — which cause, for which step — is held by the tests of the code
 *   that writes it;
 * - any code outside the three trees.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const API_ROOT = join(import.meta.dirname, "..");
const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "log"]);

/** A source tree the rule reads: its root, a file it must find calls in, and how it logs. */
interface Tree {
  root: string;
  anchor: string;
  writesAreLogs: boolean;
}

const TREES: readonly Tree[] = [
  {
    root: "packages/api/src",
    anchor: "packages/api/src/routes/run.ts",
    writesAreLogs: false,
  },
  {
    root: "packages/runtime/src",
    anchor: "packages/runtime/src/adapter/flyio/adapter.ts",
    writesAreLogs: false,
  },
  {
    root: "infra/runtime-image/runner/src",
    anchor: "infra/runtime-image/runner/src/index.ts",
    writesAreLogs: true,
  },
];

/** A fault kept: how many calls carry it, and why. */
interface Declared {
  calls: number;
  reason: string;
}

/**
 * The faults kept, keyed `<file from the repository's root>#<event>`, each with
 * the number of calls that carry it and its reason. Closed: an entry that no
 * faulty call carries fails the suite, and so does one whose faulty calls are
 * not as many as it declares. Five, each kept for what it tells an operator.
 */
const ALLOWLIST: Readonly<Record<string, Declared>> = {
  "packages/api/src/index.ts#database_timeout": {
    calls: 1,
    reason:
      "A request whose database did not answer in time, answered 503. The cause is one of four fixed names — statement_timeout, query_read_timeout, pool_wait, connect_timeout — that databaseTimeoutCause reads from the error's code or its message; the line never carries the message itself. It tells an operator a slow statement from a silent connection, a full pool or a database that does not answer a new connection.",
  },
  "packages/api/src/routes/auth.ts#oauth_exchange_failed": {
    calls: 1,
    reason:
      "The token exchange with GitHub failed. Its own message is what tells an operator an outage at GitHub from a misconfigured OAuth app, and it never reaches the browser.",
  },
  "packages/api/src/routes/run.ts#bundle_extraction_failed": {
    calls: 1,
    reason:
      "A run refused because its agent's stored bundle decompresses past the server's cap. Beside errorFields, the line takes one field of the refusal: the cap the decoder stopped at, in bytes — a number BundleDecompressedTooLargeError carries, set from the server's own setting, never anything of the bundle. Read from the error, it is the cap that refused this bundle; the environment read again could say another.",
  },
  "packages/api/src/routes/run.ts#input_url_private_address": {
    calls: 1,
    reason:
      "A file input refused because a name it reaches resolves to a private or reserved address. The line takes the two fields the refusal carries apart from its message — that name, the URL's host or a redirect's, and the address — never the message, the URL or its path. The caller is told the name only: this line is where an operator finds the address. It names the agent, its version and the key, no run id: the API keeps no access log and the refusal comes before the run is recorded, so this line is the only trace of a probe. The agent names its owner. An id is one of the owner's keys — one they keep, or one handed to a client, which the client holds and only this line lets the operator name to the owner — or an administrator's own; null is a session (the owner's or an administrator's) or the development token: the line does not tell them apart.",
  },
  "packages/runtime/src/adapter/flyio/adapter.ts#pool_claim_failed": {
    calls: 1,
    reason:
      "A pooled machine that will not wake. The cause is the body of the platform's answer, which says why — an image gone, a machine in the wrong state — and describes the infrastructure, not a run. Written for that step only, chosen by the step the claim reached; a later step's cause is the runner's answer, and it is never written.",
  },
  "packages/runtime/src/adapter/flyio/adapter.ts#spawn_failed": {
    calls: 1,
    reason:
      "A failed start of a machine for a run. The cause is kept when it comes from the platform — the body of its answer, such as a runner image tag that is gone — from our boot probe — a status or a network error, never a body — or from an /init that got no answer — the wait that ran out, or a network error. It describes the infrastructure, not a run. Chosen by the phase the start failed at and, at /init, by whether the error was built with an HTTP status; once the runner has answered, its cause is never written. The call also names that phase and the platform's HTTP status, read from the error: a step and a number.",
  },
};

/** One log call of a source: where it is, its event, and whether it is at fault. */
interface LogCall {
  file: string;
  line: number;
  event: string | undefined;
  faulty: boolean;
}

/** How a source logs, beyond its log calls. */
interface ReadOptions {
  /** `process.stderr.write(…)` and `process.stdout.write(…)` are log calls: the runner's way. */
  writesAreLogs?: boolean;
}

/** The names a binding declares: an identifier, or every identifier of a pattern. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name),
  );
}

/** hono's streaming helpers: each takes an error handler as its third argument. */
const STREAMING_HELPERS = new Set(["stream", "streamText", "streamSSE"]);
const STREAMING_MODULE = "hono/streaming";

/** How a source names the streaming helpers: by its imports from hono/streaming. */
interface StreamingNames {
  /** Local names bound to a helper: `streamSSE`, or `sse` for `streamSSE as sse`. */
  locals: Set<string>;
  /** Names bound to the whole module: `import * as streaming`. */
  namespaces: Set<string>;
}

const streamingNamesOf = new WeakMap<ts.SourceFile, StreamingNames>();

function streamingNames(sourceFile: ts.SourceFile): StreamingNames {
  const known = streamingNamesOf.get(sourceFile);
  if (known) return known;
  const names: StreamingNames = { locals: new Set(), namespaces: new Set() };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== STREAMING_MODULE
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.namespaces.add(bindings.name.text);
    else if (bindings) {
      for (const element of bindings.elements) {
        if (STREAMING_HELPERS.has((element.propertyName ?? element.name).text)) {
          names.locals.add(element.name.text);
        }
      }
    }
  }
  streamingNamesOf.set(sourceFile, names);
  return names;
}

/** Whether `call` calls one of hono's streaming helpers, found through its import. */
function isStreamingCall(call: ts.CallExpression): boolean {
  const names = streamingNames(call.getSourceFile());
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return names.locals.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    names.namespaces.has(callee.expression.text) &&
    STREAMING_HELPERS.has(callee.name.text)
  );
}

/**
 * Whether `fn` receives a caught error as its first parameter: the handler of
 * `.catch(fn)`, the second argument of `.then(_, fn)`, the app's error
 * handler, `.onError(fn)`, or the third argument of a streaming helper,
 * `streamSSE(c, cb, fn)`.
 */
function isErrorHandler(fn: ts.SignatureDeclaration): boolean {
  const call = fn.parent;
  if (!ts.isCallExpression(call)) return false;
  if (isStreamingCall(call)) return call.arguments[2] === fn;
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  return (
    ((method === "catch" || method === "onError") && call.arguments[0] === fn) ||
    (method === "then" && call.arguments[1] === fn)
  );
}

/** What a name refers to where it is read: a caught error, a local variable, or anything else. */
type Binding =
  | { kind: "caught" }
  | { kind: "local"; declaration: ts.VariableDeclaration; scope: ts.Node }
  | { kind: "other" };

/** The declaration of `name` that `scope` holds itself: among a block's statements, or a `for` head. */
function declaredIn(scope: ts.Node, name: string): ts.VariableDeclaration | undefined {
  const lists: ts.VariableDeclarationList[] = [];
  if (
    ts.isBlock(scope) ||
    ts.isSourceFile(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  ) {
    for (const statement of scope.statements) {
      if (ts.isVariableStatement(statement)) lists.push(statement.declarationList);
    }
  } else if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    lists.push(scope.initializer);
  }
  for (const list of lists) {
    for (const declaration of list.declarations) {
      if (boundNames(declaration.name).includes(name)) return declaration;
    }
  }
  return undefined;
}

/** The nearest binding of the identifier's name, read outwards from where it is. */
function bindingOf(id: ts.Identifier): Binding {
  for (let node: ts.Node = id.parent; ; node = node.parent) {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      if (boundNames(node.variableDeclaration.name).includes(id.text)) return { kind: "caught" };
    }
    if (ts.isFunctionLike(node)) {
      const index = node.parameters.findIndex((p) => boundNames(p.name).includes(id.text));
      // A parameter of the same name shadows whatever binds it further out.
      if (index === 0 && isErrorHandler(node)) return { kind: "caught" };
      if (index !== -1) return { kind: "other" };
    }
    const declaration = declaredIn(node, id.text);
    if (declaration) return { kind: "local", declaration, scope: node };
    if (ts.isSourceFile(node)) return { kind: "other" };
  }
}

const launderedOf = new WeakMap<ts.VariableDeclaration, boolean>();

/**
 * Whether a local variable carries a caught error: its initialiser, or a value
 * assigned to it in its scope, references one outside errorFields(). One level:
 * whether the error reached it through another laundered variable is not asked.
 */
function isLaundered(declaration: ts.VariableDeclaration, scope: ts.Node): boolean {
  const known = launderedOf.get(declaration);
  if (known !== undefined) return known;
  launderedOf.set(declaration, false);
  let laundered =
    declaration.initializer !== undefined && referencesCaughtError(declaration.initializer, false);
  const visit = (node: ts.Node): void => {
    if (laundered) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      const target = bindingOf(node.left);
      if (
        target.kind === "local" &&
        target.declaration === declaration &&
        referencesCaughtError(node.right, false)
      ) {
        laundered = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  launderedOf.set(declaration, laundered);
  return laundered;
}

/** Whether the identifier only names a property, rather than reading a value. */
function isPropertyName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) &&
      parent.name === id) ||
    (ts.isBindingElement(parent) && parent.propertyName === id)
  );
}

/**
 * Whether `node` references a caught error — or, with `launderedToo`, a local
 * variable laundered from one — save as the direct argument of errorFields().
 */
function referencesCaughtError(node: ts.Node, launderedToo = true): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "errorFields"
  ) {
    return node.arguments.some(
      (argument) => !ts.isIdentifier(argument) && referencesCaughtError(argument, launderedToo),
    );
  }
  if (ts.isIdentifier(node) && !isPropertyName(node)) {
    const binding = bindingOf(node);
    if (binding.kind === "caught") return true;
    const local = launderedToo && binding.kind === "local" ? binding : undefined;
    if (local && isLaundered(local.declaration, local.scope)) return true;
  }
  return (
    ts.forEachChild(node, (child) => referencesCaughtError(child, launderedToo) || undefined) ??
    false
  );
}

/** Whether `call` writes to the process's stderr or stdout: `process.stderr.write(…)`. */
function isStdioWrite(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "write" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    ts.isIdentifier(callee.expression.expression) &&
    callee.expression.expression.text === "process" &&
    (callee.expression.name.text === "stderr" || callee.expression.name.text === "stdout")
  );
}

/** The value of the `event` property of the call's first argument, when it is a literal. */
function eventOf(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return undefined;
  for (const property of first.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "event" &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return undefined;
}

/** Every log call of one source, each with its event and whether it is at fault. */
function logCalls(file: string, source: string, options: ReadOptions = {}): LogCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls: LogCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        LOG_LEVELS.has(node.expression.name.text)) ||
        (options.writesAreLogs === true && isStdioWrite(node)))
    ) {
      // The receiver too: `logger.child({ e: err.message }).warn(…)` writes the
      // child's bindings into the line it logs.
      const receiver = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : undefined;
      calls.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        event: eventOf(node),
        faulty:
          node.arguments.some((argument) => referencesCaughtError(argument)) ||
          (receiver !== undefined && referencesCaughtError(receiver)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

/** The rule: the log calls of one source that carry a caught error outside errorFields(). */
function logFaults(file: string, source: string, options: ReadOptions = {}): LogCall[] {
  return logCalls(file, source, options).filter((call) => call.faulty);
}

function keyOf(call: LogCall): string {
  return `${call.file}#${call.event ?? ""}`;
}

/** The entry that covers a faulty call: its event's, or none. */
function entryOf(call: LogCall, allowlist: Readonly<Record<string, Declared>>): string | undefined {
  return call.event !== undefined && Object.hasOwn(allowlist, keyOf(call))
    ? keyOf(call)
    : undefined;
}

function isDeclared(call: LogCall, allowlist: Readonly<Record<string, Declared>>): boolean {
  return entryOf(call, allowlist) !== undefined;
}

/** The entries that no faulty call carries: a sound call with the same event keeps none alive. */
function staleEntries(allowlist: Readonly<Record<string, Declared>>, faults: LogCall[]): string[] {
  const carried = new Set(faults.map((call) => entryOf(call, allowlist)));
  return Object.keys(allowlist).filter((key) => !carried.has(key));
}

/**
 * The entries whose faulty calls are not as many as they declare — one more
 * faulty call with a declared event is not covered by the entry. An entry with
 * no faulty call at all is stale, and reported as such, not here.
 */
function miscountedEntries(
  allowlist: Readonly<Record<string, Declared>>,
  faults: LogCall[],
): string[] {
  return Object.entries(allowlist).flatMap(([key, { calls }]) => {
    const found = faults.filter((call) => entryOf(call, allowlist) === key).length;
    return found === 0 || found === calls ? [] : [`${key}: ${calls} declared, ${found} found`];
  });
}

/** One call of a streaming helper: where it is, and whether its error handler is written in place. */
interface StreamingCall {
  where: string;
  handlerInPlace: boolean;
}

/** The second rule's input: every call of a streaming helper in one source. */
function streamingCalls(file: string, source: string): StreamingCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls: StreamingCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isStreamingCall(node)) {
      const handler = node.arguments[2];
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      calls.push({
        where: `${file}:${line} ${node.expression.getText(sourceFile)}`,
        handlerInPlace:
          handler !== undefined &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// One implementation: the API logs through the runtime's errorFields, whose
// own tests sit beside it.
describe("the API's errorFields", () => {
  it("is the runtime's", () => {
    expect(errorFields).toBe(runtimeErrorFields);
  });
});

describe("what the log guard counts as a fault", () => {
  const faultEvents = (source: string) => logFaults("witness.ts", source).map((c) => c.event);

  it("counts a caught error's message in a log call", () => {
    expect(
      faultEvents(`try { run(); } catch (err) { log.warn({ event: "raw", e: err.message }); }`),
    ).toEqual(["raw"]);
  });

  it("does not count the caught error handed to errorFields", () => {
    expect(
      faultEvents(
        `try { run(); } catch (err) { log.warn({ event: "fields", ...errorFields(err) }); }`,
      ),
    ).toEqual([]);
  });

  it("does not count a response, an assignment or a throw, none of them a log call", () => {
    expect(
      faultEvents(`
        try { run(); } catch (err) {
          const detail = err.message;
          c.json({ error: { message: err.message } }, 400);
          throw new Error(err.message);
        }`),
    ).toEqual([]);
  });

  it("counts every shape of a caught error, bound by catch, .catch, .then, .onError or streamSSE, at every level", () => {
    expect(
      faultEvents(`
        import { streamSSE, streamText as text } from "hono/streaming";
        import * as streaming from "hono/streaming";
        try { run(); } catch (err) {
          log.info({ event: "message", e: err.message });
          log.warn({ event: "stack", e: err.stack });
          log.error({ event: "string", e: String(err) });
          log.debug({ event: "template" }, \`failed: \${err}\`);
          log.trace({ event: "shorthand", err });
          log.fatal({ event: "alone" }, err);
          console.log({ event: "cast", e: (err as Error).message });
          logger?.warn({ event: "optional", e: err.message });
          log.warn({ event: "wrapped", ...errorFields({ code: err.message }) });
        }
        db.update().catch((e) => log.error({ event: "catch-handler", e: e.message }));
        db.update().then(() => {}, (e) => log.error({ event: "then-rejection", e: String(e) }));
        app.onError((e, c) => {
          log.error({ event: "error-handler", e: e.message });
          return c.text("Internal Server Error", 500);
        });
        streamSSE(c, async (s) => {}, async (e, s) => {
          log.error({ event: "stream-handler", e: e.message });
        });
        text(c, async (s) => {}, async (e) => {
          log.error({ event: "aliased-stream-handler", e: e.message });
        });
        streaming.stream(c, async (s) => {}, async (e) => {
          log.error({ event: "namespaced-stream-handler", e: e.message });
        });`),
    ).toEqual([
      "message",
      "stack",
      "string",
      "template",
      "shorthand",
      "alone",
      "cast",
      "optional",
      "wrapped",
      "catch-handler",
      "then-rejection",
      "error-handler",
      "stream-handler",
      "aliased-stream-handler",
      "namespaced-stream-handler",
    ]);
  });

  it("does not count a name that no catch binds, nor one a parameter shadows", () => {
    expect(
      faultEvents(`
        const err = new Error("built, not caught");
        log.warn({ event: "built", e: err.message });
        try { run(); } catch (err) {
          items.forEach((err) => log.warn({ event: "shadowed", err }));
        }
        db.update().then((value) => log.info({ event: "resolved", value }));
        function stream(c, cb, after) {}
        stream(c, async (s) => {}, (e) => log.info({ event: "not-hono", e }));`),
    ).toEqual([]);
  });

  it("counts a local variable laundered from a caught error, by its initialiser or an assignment", () => {
    expect(
      faultEvents(`
        try { run(); } catch (err) {
          const m = err.message;
          log.warn({ event: "initialised", m });
          let detail = "none";
          detail = String(err);
          log.warn({ event: "assigned", detail });
          const { message } = err;
          log.warn({ event: "destructured", e: message });
        }
        db.update().catch((e) => {
          const text = \`failed: \${e.message}\`;
          log.error({ event: "in-a-handler" }, text);
        });`),
    ).toEqual(["initialised", "assigned", "destructured", "in-a-handler"]);
  });

  it("does not count a laundered variable handed to errorFields, nor one laundered from errorFields", () => {
    expect(
      faultEvents(`
        try { run(); } catch (err) {
          const kept = err;
          log.warn({ event: "handed", ...errorFields(kept) });
          const fields = errorFields(err);
          log.warn({ event: "from-fields", ...fields });
          const sound = "fixed text";
          log.warn({ event: "sound", sound });
        }`),
    ).toEqual([]);
  });

  it("counts a caught error in the receiver of a log call, as in a child logger's bindings", () => {
    expect(
      faultEvents(`
        try { run(); } catch (err) {
          logger.child({ e: err.message }).warn({ event: "child-bindings" }, "fixed text");
          const m = String(err);
          log.child({ m }).error({ event: "child-laundered" });
          log.child({ ...errorFields(err) }).warn({ event: "child-fields" });
        }`),
    ).toEqual(["child-bindings", "child-laundered"]);
  });

  it("counts a write to stderr or stdout as a log call in the runner's sources, and only there", () => {
    const source = `
      try { run(); } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(\`claim failed: \${message}\`);
        process.stdout.write(String(err));
        process.stderr.write("a fixed line");
      }`;
    expect(logFaults("runner.ts", source, { writesAreLogs: true }).map((c) => c.line)).toEqual([
      4, 5,
    ]);
    expect(logFaults("api.ts", source)).toEqual([]);
  });

  it("finds stale an allowlist entry that no faulty call carries, a sound call with its event included", () => {
    const faults = logFaults(
      "witness.ts",
      `try { run(); } catch (err) { log.warn({ event: "kept", error: err.message }); }
       log.warn({ event: "sound", status: 500 });`,
    );
    const entry = { calls: 1, reason: "r" };
    expect(
      staleEntries(
        { "witness.ts#kept": entry, "witness.ts#sound": entry, "witness.ts#gone": entry },
        faults,
      ),
    ).toEqual(["witness.ts#sound", "witness.ts#gone"]);
  });

  it("counts the faulty calls an entry covers: one more with its event is not covered", () => {
    const faults = logFaults(
      "witness.ts",
      `try { run(); } catch (err) { log.warn({ event: "kept", error: err.message }); }
       try { run(); } catch (err) { log.warn({ event: "kept", error: err.message }); }
       try { run(); } catch (err) { log.warn({ event: "pair", error: err.message }); }
       try { run(); } catch (err) { log.warn({ event: "pair", error: err.message }); }`,
    );
    expect(
      miscountedEntries(
        {
          "witness.ts#kept": { calls: 1, reason: "r" },
          "witness.ts#pair": { calls: 2, reason: "r" },
        },
        faults,
      ),
    ).toEqual(["witness.ts#kept: 1 declared, 2 found"]);
  });
});

describe("the log calls of the API, the runtime and the runner", () => {
  const calls = TREES.flatMap(({ root, writesAreLogs }) =>
    sourceFiles(join(REPO_ROOT, root)).flatMap((path) =>
      logCalls(relative(REPO_ROOT, path).replace(/\\/g, "/"), readFileSync(path, "utf-8"), {
        writesAreLogs,
      }),
    ),
  );
  const faults = calls.filter((call) => call.faulty);

  it("are read from the three source trees, a known file of each among them", () => {
    const missing = TREES.filter(({ anchor }) => !calls.some((call) => call.file === anchor));
    expect(missing.map(({ anchor }) => anchor)).toEqual([]);
  });

  it("carry no caught error outside errorFields, save the declared ones", () => {
    const undeclared = faults
      .filter((call) => !isDeclared(call, ALLOWLIST))
      .map((call) => `${call.file}:${call.line} ${call.event ?? "(no event)"}`);
    expect(undeclared).toEqual([]);
  });

  it("keep the allowlist closed: each entry names a call still at fault", () => {
    expect(staleEntries(ALLOWLIST, faults)).toEqual([]);
  });

  it("keep each entry to the number of faulty calls it declares", () => {
    expect(miscountedEntries(ALLOWLIST, faults)).toEqual([]);
  });
});

describe("what the streaming rule asks of a call", () => {
  const withoutHandler = (source: string) =>
    streamingCalls("witness.ts", source)
      .filter((call) => !call.handlerInPlace)
      .map((call) => call.where);

  it("asks every call of a streaming helper for an error handler written in place", () => {
    expect(
      withoutHandler(`
        import { stream, streamSSE as sse } from "hono/streaming";
        import * as streaming from "hono/streaming";
        sse(c, async (s) => {}, async (e, s) => {});
        stream(c, async (s) => {}, function (e, s) {});
        sse(c, async (s) => {});
        stream(c, async (s) => {}, onError);
        streaming.streamText(c, async (s) => {});
        streaming.streamSSE(c, async (s) => {}, async (e) => {});`),
    ).toEqual(["witness.ts:6 sse", "witness.ts:7 stream", "witness.ts:8 streaming.streamText"]);
  });

  it("leaves alone a function that only shares a helper's name", () => {
    expect(
      withoutHandler(`
        function streamSSE(c, cb) {}
        streamSSE(c, async (s) => {});`),
    ).toEqual([]);
  });
});

describe("the streaming calls of packages/api/src", () => {
  const calls = sourceFiles(API_ROOT).flatMap((path) =>
    streamingCalls(relative(API_ROOT, path).replace(/\\/g, "/"), readFileSync(path, "utf-8")),
  );

  it("are read from the source tree, routes/run.ts among them", () => {
    expect(calls.some((call) => call.where.startsWith("routes/run.ts:"))).toBe(true);
  });

  it("each write their error handler in place", () => {
    expect(calls.filter((call) => !call.handlerInPlace).map((call) => call.where)).toEqual([]);
  });
});
