import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The harness and the runner prepare a run by two exchanges, `POST /claim` and
 * `POST /init`, run its tools by a third, `POST /tool`, and tell a runner ready —
 * and which process answered — by `GET /healthz`. The bodies of the first three,
 * the answers to `/claim`, `/init` and `/healthz`, and the body of a failed
 * `/init` are declared once, as zod schemas, in
 * `packages/runtime/src/runner-contract.ts`. The runner reads them through
 * `@skrun-dev/runtime/runner`; the cloud adapter, its tool provider and its pool
 * from the module itself. (A tool's answer is the runtime's `ToolResult`, one
 * type both sides import.)
 *
 * A second declaration of one of those shapes would compile against itself and
 * drift from the first in silence: the two sides deploy separately, and nothing
 * else compares them. So this file reads, in the syntax (the TypeScript parser,
 * no type check):
 *
 * - the contract module, for its shapes: every object its schemas declare with
 *   at least two properties — the bodies, the answers, and the objects nested in
 *   them (an /init answer's `phases` and `boot`). An object of one property is
 *   not matched: one name says nothing about whose shape it is;
 * - the runner's two modules, the adapter, its tool provider and its pool, for a
 *   copy: a zod object schema
 *   (`z.object`, `z.looseObject`, `z.strictObject`, `.extend`, `.safeExtend`),
 *   an object type, or an interface, at least two of whose properties are a
 *   contract object's, and those more than half of its own. A declaration that
 *   only shares a name or two with a larger shape of its own is not one;
 * - the same five modules, for what they import from the contract: each names
 *   the schemas it parses with and the types it writes, from
 *   `@skrun-dev/runtime/runner` for the runner — which must re-export them from
 *   the contract module — and from the contract module for the harness's three.
 *
 * Each finding names its file and line. What it does not see: a copy written
 * with other property names, a shape assembled without an object literal, a copy
 * in a module it does not read, and whether the two sides agree on values (a test
 * of each side does).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(join(ROOT, "packages/runtime/package.json"))(
  "typescript",
) as typeof import("typescript");

const CONTRACT = "packages/runtime/src/runner-contract.ts";
const RUNNER_ENTRY = "packages/runtime/src/runner.ts";
const RUNNER_PACKAGE = "@skrun-dev/runtime/runner";

/** The calls that declare a zod object schema from an object literal. */
const OBJECT_BUILDERS = new Set(["object", "looseObject", "strictObject", "extend", "safeExtend"]);

/** The contract's schemas, every one of which the read must find. */
const CONTRACT_SCHEMAS = [
  "ClaimRequestSchema",
  "ClaimResultSchema",
  "HealthzResultSchema",
  "InitErrorBodySchema",
  "InitRequestSchema",
  "InitResultSchema",
  "ToolRequestSchema",
];

interface Need {
  name: string;
  /** A schema is parsed with, so it must be imported as a value; a type may be type-only. */
  as: "value" | "type";
}

interface Consumer {
  file: string;
  /** Where it takes the contract from: the runner's package entry, or the contract module. */
  from: typeof RUNNER_PACKAGE | typeof CONTRACT;
  needs: Need[];
}

/** What each side reads from the contract. */
const CONSUMERS: Consumer[] = [
  {
    file: "infra/runtime-image/runner/src/index.ts",
    from: RUNNER_PACKAGE,
    needs: [
      { name: "ClaimRequestSchema", as: "value" },
      { name: "INFRA_HOSTS_CHECKS", as: "value" },
      { name: "InitRequestSchema", as: "value" },
      { name: "ToolRequestSchema", as: "value" },
      { name: "initErrorBody", as: "value" },
      { name: "ClaimResult", as: "type" },
      { name: "HealthzResult", as: "type" },
      { name: "InfraHostsCheck", as: "type" },
      { name: "InitResult", as: "type" },
    ],
  },
  {
    file: "infra/runtime-image/runner/src/dispatch.ts",
    from: RUNNER_PACKAGE,
    needs: [
      { name: "InitRequest", as: "type" },
      { name: "InitResult", as: "type" },
    ],
  },
  {
    file: "packages/runtime/src/adapter/flyio/adapter.ts",
    from: CONTRACT,
    needs: [
      { name: "ClaimResultSchema", as: "value" },
      { name: "InitErrorBodySchema", as: "value" },
      { name: "InitResultSchema", as: "value" },
      { name: "classifyInitFailure", as: "value" },
      { name: "ClaimRequest", as: "type" },
      { name: "InfraHostsCheck", as: "type" },
      { name: "InitErrorBody", as: "type" },
      { name: "InitRequest", as: "type" },
    ],
  },
  {
    file: "packages/runtime/src/adapter/flyio/rpc-script-provider.ts",
    from: CONTRACT,
    needs: [{ name: "ToolRequest", as: "type" }],
  },
  {
    file: "packages/runtime/src/adapter/flyio/pool.ts",
    from: CONTRACT,
    needs: [{ name: "HealthzResultSchema", as: "value" }],
  },
];

type SourceFile = import("typescript").SourceFile;
type Node = import("typescript").Node;

function parse(file: string, text: string): SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function lineOf(source: SourceFile, node: Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function propertyName(name: import("typescript").PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** The object literal a call declares a zod object schema from, if it is such a call. */
function zodObjectLiteral(node: Node): import("typescript").ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !OBJECT_BUILDERS.has(callee.name.text)) {
    return undefined;
  }
  const [argument] = node.arguments;
  return argument !== undefined && ts.isObjectLiteralExpression(argument) ? argument : undefined;
}

interface Declaration {
  line: number;
  keys: string[];
  /** Where it sits: the name it is declared under, and the properties above it. */
  path: string[];
}

/** The names a node sits under: its variable, type or interface, then each property above it. */
function pathOf(node: Node): string[] {
  const path: string[] = [];
  for (let at: Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isPropertyAssignment(at) || ts.isPropertySignature(at)) {
      const name = propertyName(at.name);
      if (name !== undefined) path.unshift(name);
    } else if (
      ts.isVariableDeclaration(at) ||
      ts.isTypeAliasDeclaration(at) ||
      ts.isInterfaceDeclaration(at)
    ) {
      if (ts.isIdentifier(at.name)) path.unshift(at.name.text);
      break;
    }
  }
  return path;
}

/** Every zod object schema, object type and interface a source declares, with its properties. */
function declarations(source: SourceFile, kinds: "schemas" | "all"): Declaration[] {
  const found: Declaration[] = [];
  const visit = (node: Node) => {
    let keys: string[] | undefined;
    const literal = zodObjectLiteral(node);
    if (literal !== undefined) {
      keys = literal.properties.map((p) => propertyName(p.name)).filter((k) => k !== undefined);
    } else if (kinds === "all" && (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node))) {
      keys = node.members
        .filter(ts.isPropertySignature)
        .map((m) => propertyName(m.name))
        .filter((k) => k !== undefined);
    }
    if (keys !== undefined) {
      const path = ts.isInterfaceDeclaration(node) ? [node.name.text] : pathOf(node);
      found.push({ line: lineOf(source, node), keys, path });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

interface Shape {
  label: string;
  keys: Set<string>;
}

/** The contract's object shapes: each object its schemas declare with two properties or more. */
function contractShapes(text: string): Shape[] {
  return declarations(parse(CONTRACT, text), "schemas")
    .filter((d) => d.keys.length >= 2)
    .map((d) => ({ label: d.path.join(" › "), keys: new Set(d.keys) }));
}

/** The contract object a declaration copies, if it copies one: the one it shares the most with. */
function copied(declaration: Declaration, shapes: Shape[]): Shape | undefined {
  let best: { shape: Shape; shared: number } | undefined;
  for (const shape of shapes) {
    const shared = declaration.keys.filter((k) => shape.keys.has(k)).length;
    if (shared < 2 || shared * 2 <= declaration.keys.length) continue;
    if (best === undefined || shared > best.shared) best = { shape, shared };
  }
  return best?.shape;
}

/** Each copy of a contract shape a source declares, named by its file and line. */
function copies(file: string, text: string, shapes: Shape[], from: string): string[] {
  const findings: string[] = [];
  for (const declaration of declarations(parse(file, text), "all")) {
    const shape = copied(declaration, shapes);
    if (shape === undefined) continue;
    findings.push(
      `${file}:${declaration.line} — declares { ${declaration.keys.join(", ")} }, the contract's ` +
        `${shape.label} again; import it from ${from}`,
    );
  }
  return findings;
}

/** The module an import specifier names, relative to the root: a relative `./x.js` is `x.ts`. */
function moduleOf(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const target = resolve(ROOT, dirname(file), specifier).replace(/\.js$/, ".ts");
  return relative(ROOT, target).split("\\").join("/");
}

/** The names a source imports from `module`, each with whether it is imported as a value. */
function importsFrom(file: string, source: SourceFile, module: string): Map<string, boolean> {
  const names = new Map<string, boolean>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (moduleOf(file, statement.moduleSpecifier.text) !== module) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const asValue = !clause.isTypeOnly && !element.isTypeOnly;
      const name = (element.propertyName ?? element.name).text;
      names.set(name, (names.get(name) ?? false) || asValue);
    }
  }
  return names;
}

/** What a consumer fails to import from where it must take the contract. */
function missingImports(consumer: Consumer, text: string): string[] {
  const imported = importsFrom(consumer.file, parse(consumer.file, text), consumer.from);
  const findings: string[] = [];
  for (const need of consumer.needs) {
    const asValue = imported.get(need.name);
    if (asValue === undefined) {
      findings.push(`${consumer.file} — does not import ${need.name} from ${consumer.from}`);
    } else if (need.as === "value" && !asValue) {
      findings.push(
        `${consumer.file} — imports ${need.name} from ${consumer.from} as a type only; it parses with it`,
      );
    }
  }
  return findings;
}

/** The names an entry re-exports from the contract module, types included. */
function reexportedFromContract(file: string, text: string): Set<string> {
  const names = new Set<string>();
  for (const statement of parse(file, text).statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (moduleOf(file, statement.moduleSpecifier.text) !== CONTRACT) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) names.add(element.name.text);
  }
  return names;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const SHAPES = contractShapes(
  [
    'import { z } from "zod";',
    "export const ReqSchema = z.object({",
    "  url: z.string(),",
    "  hosts: z.array(z.string()),",
    "  sum: z.string().optional(),",
    "  entries: z.array(z.looseObject({ name: z.string() })),",
    "});",
    "export const ResSchema = z.object({",
    "  ok: z.literal(true),",
    "  timings: z.object({ a_ms: z.number(), b_ms: z.number() }).optional(),",
    "});",
  ].join("\n"),
);

describe("one declaration of what the harness and the runner exchange — what the rule refuses", () => {
  it("reads the contract's objects of two properties or more, nested ones included", () => {
    expect(SHAPES.map((s) => [s.label, [...s.keys]])).toEqual([
      ["ReqSchema", ["url", "hosts", "sum", "entries"]],
      ["ResSchema", ["ok", "timings"]],
      ["ResSchema › timings", ["a_ms", "b_ms"]],
    ]);
  });

  it("names a copy as a zod schema, an object type, an interface, or a cast, each by its line", () => {
    const source = [
      "const Body = z.object({ url: z.string().url(), hosts: z.array(z.string()) });",
      "interface Options { url: string; hosts: string[]; sum?: string }",
      "function f(body: { url: string; hosts: string[] }): void {}",
      "const t = raw as { ok?: boolean; timings?: { a_ms?: number; b_ms?: number } };",
    ].join("\n");

    expect(copies("x.ts", source, SHAPES, "the contract")).toEqual([
      "x.ts:1 — declares { url, hosts }, the contract's ReqSchema again; import it from the contract",
      "x.ts:2 — declares { url, hosts, sum }, the contract's ReqSchema again; import it from the contract",
      "x.ts:3 — declares { url, hosts }, the contract's ReqSchema again; import it from the contract",
      "x.ts:4 — declares { ok, timings }, the contract's ResSchema again; import it from the contract",
      "x.ts:4 — declares { a_ms, b_ms }, the contract's ResSchema › timings again; import it from the contract",
    ]);
  });

  it("leaves a declaration that shares one name, or that is mostly properties of its own", () => {
    const source = [
      "const Tool = z.object({ kind: z.string(), name: z.string(), args: z.unknown() });",
      "interface Spawned { machineId: string; privateIp: string; url: string; hosts: string[]; tools: unknown[] }",
      "let only: { url: string };",
      "const narrowed: { entries: Thing[]; other: number } = x;",
    ].join("\n");

    expect(copies("x.ts", source, SHAPES, "the contract")).toEqual([]);
  });

  it("names a missing import, and a schema imported as a type only", () => {
    const consumer: Consumer = {
      file: "infra/runtime-image/runner/src/x.ts",
      from: RUNNER_PACKAGE,
      needs: [
        { name: "ReqSchema", as: "value" },
        { name: "Res", as: "type" },
      ],
    };

    expect(
      missingImports(consumer, 'import { ReqSchema, type Res } from "@skrun-dev/runtime/runner";'),
    ).toEqual([]);
    expect(
      missingImports(consumer, 'import type { ReqSchema, Res } from "@skrun-dev/runtime/runner";'),
    ).toEqual([
      "infra/runtime-image/runner/src/x.ts — imports ReqSchema from @skrun-dev/runtime/runner as a type only; it parses with it",
    ]);
    expect(missingImports(consumer, 'import { ReqSchema } from "./copy.js";')).toEqual([
      "infra/runtime-image/runner/src/x.ts — does not import ReqSchema from @skrun-dev/runtime/runner",
      "infra/runtime-image/runner/src/x.ts — does not import Res from @skrun-dev/runtime/runner",
    ]);
  });

  it("takes the adapter's relative import of the contract module for the module itself", () => {
    const consumer: Consumer = {
      file: "packages/runtime/src/adapter/flyio/adapter.ts",
      from: CONTRACT,
      needs: [{ name: "InitResultSchema", as: "value" }],
    };

    expect(
      missingImports(consumer, 'import { InitResultSchema } from "../../runner-contract.js";'),
    ).toEqual([]);
    expect(missingImports(consumer, 'import { InitResultSchema } from "../../types.js";')).toEqual([
      `packages/runtime/src/adapter/flyio/adapter.ts — does not import InitResultSchema from ${CONTRACT}`,
    ]);
  });
});

describe("one declaration of what the harness and the runner exchange — the code", () => {
  const shapes = contractShapes(read(CONTRACT));

  it("the contract module declares each of its schemas, so an empty read cannot pass", () => {
    const roots = new Set(shapes.map((s) => s.label.split(" › ")[0]));

    expect(CONTRACT_SCHEMAS.filter((name) => !roots.has(name))).toEqual([]);
  });

  it("the runner's entry hands the runner every name it takes, from the contract module", () => {
    const reexported = reexportedFromContract(RUNNER_ENTRY, read(RUNNER_ENTRY));
    const taken = CONSUMERS.filter((c) => c.from === RUNNER_PACKAGE).flatMap((c) => c.needs);

    expect(taken.map((n) => n.name).filter((name) => !reexported.has(name))).toEqual([]);
  });

  it("neither the runner nor the harness declares a copy of a contract shape", () => {
    const findings = CONSUMERS.flatMap((c) =>
      copies(c.file, read(c.file), shapes, c.from === CONTRACT ? CONTRACT : RUNNER_PACKAGE),
    );

    expect(findings).toEqual([]);
  });

  it("each imports what it reads from the contract, from where it must take it", () => {
    const findings = CONSUMERS.flatMap((c) => missingImports(c, read(c.file)));

    expect(findings).toEqual([]);
  });
});
