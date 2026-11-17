import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The SDK re-declares the run event union of the runtime (it depends on no
 * workspace package), and nothing but this test compares the copy with its
 * source. Both files are read as syntax (the TypeScript parser, no type
 * check), never imported: the SDK gains no dependency, and its compiler,
 * whose rootDir is this directory, never sees the runtime's file.
 *
 * What it holds, in one direction: every event `type` of the runtime's
 * `RunEvent` union is a member of the SDK's, and every `stage` value of the
 * runtime's `run_heartbeat` event is a value of the SDK's. An addition to the
 * runtime alone turns it red, naming what the SDK lacks. What the SDK has on
 * top is not its concern, nor are the fields of an event: the types and the
 * stages are the discriminants a consumer switches on.
 *
 * How it reads: the members of the `RunEvent` alias are type references;
 * each is resolved to an interface or type alias of the same file, and the
 * discriminant is the string literal type of its `type` property. A member it
 * cannot read that way fails the suite rather than being skipped.
 */

const RUNTIME_TYPES = join(import.meta.dirname, "..", "..", "runtime", "src", "types.ts");
const SDK_TYPES = join(import.meta.dirname, "..", "src", "types.ts");
const UNION = "RunEvent";
const HEARTBEAT = "run_heartbeat";

interface WireUnion {
  /** Event `type` literal → the name of the declaration that carries it. */
  types: Map<string, string>;
  /** The `stage` literals of the heartbeat event; undefined when it has none. */
  heartbeatStages: string[] | undefined;
}

type Members = ts.NodeArray<ts.TypeElement>;

function membersOf(file: ts.SourceFile, name: string): Members | undefined {
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      return statement.members;
    }
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === name &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      return statement.type.members;
    }
  }
  return undefined;
}

function propertyType(members: Members, property: string): ts.TypeNode | undefined {
  for (const member of members) {
    if (
      ts.isPropertySignature(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === property
    ) {
      return member.type;
    }
  }
  return undefined;
}

/** The string literals of `"a"` or `"a" | "b"`; undefined for any other shape. */
function stringLiterals(node: ts.TypeNode | undefined): string[] | undefined {
  if (!node) return undefined;
  const parts = ts.isUnionTypeNode(node) ? [...node.types] : [node];
  const values: string[] = [];
  for (const part of parts) {
    if (!ts.isLiteralTypeNode(part) || !ts.isStringLiteral(part.literal)) return undefined;
    values.push(part.literal.text);
  }
  return values;
}

function readWireUnion(fileName: string, source: string): WireUnion {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const alias = file.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === UNION,
  );
  if (!alias) throw new Error(`${fileName}: no type alias ${UNION}`);
  const references = ts.isUnionTypeNode(alias.type) ? [...alias.type.types] : [alias.type];
  const types = new Map<string, string>();
  let heartbeatStages: string[] | undefined;
  for (const reference of references) {
    if (!ts.isTypeReferenceNode(reference) || !ts.isIdentifier(reference.typeName)) {
      throw new Error(`${fileName}: a ${UNION} member is not a plain type reference`);
    }
    const name = reference.typeName.text;
    const members = membersOf(file, name);
    if (!members) throw new Error(`${fileName}: ${name} is not declared in this file`);
    const literal = stringLiterals(propertyType(members, "type"));
    if (literal?.length !== 1 || literal[0] === undefined) {
      throw new Error(`${fileName}: ${name}.type is not one string literal`);
    }
    types.set(literal[0], name);
    if (literal[0] === HEARTBEAT) {
      heartbeatStages = stringLiterals(propertyType(members, "stage"));
      if (!heartbeatStages) {
        throw new Error(`${fileName}: ${name}.stage is not a union of string literals`);
      }
    }
  }
  return { types, heartbeatStages };
}

describe("how a RunEvent union is read", () => {
  const witness = (body: string) => readWireUnion("witness.ts", body);

  it("maps each member to its type literal, and reads the heartbeat's stages", () => {
    const union = witness(
      `interface Base { run_id: string }
       export interface A extends Base { type: "a_event"; x: number }
       export type B = { "type": "b_event" };
       export interface H extends Base { type: "run_heartbeat"; stage: "one" | "two" }
       export type RunEvent = A | B | H;`,
    );
    expect([...union.types.entries()]).toEqual([
      ["a_event", "A"],
      ["b_event", "B"],
      ["run_heartbeat", "H"],
    ]);
    expect(union.heartbeatStages).toEqual(["one", "two"]);
  });

  it("has no stages when no member is the heartbeat", () => {
    expect(
      witness(`interface A { type: "a" } export type RunEvent = A;`).heartbeatStages,
    ).toBeUndefined();
  });

  it("fails on a member it cannot read, rather than skipping it", () => {
    expect(() => witness(`export type RunEvent = Missing;`)).toThrow(/Missing is not declared/);
    expect(() => witness(`interface A { type: string } export type RunEvent = A;`)).toThrow(
      /A\.type is not one string literal/,
    );
    expect(() => witness(`export type RunEvent = { type: "a" };`)).toThrow(
      /not a plain type reference/,
    );
    expect(() =>
      witness(`interface H { type: "run_heartbeat"; stage: string } export type RunEvent = H;`),
    ).toThrow(/H\.stage is not a union of string literals/);
    expect(() => witness(`export type Other = string;`)).toThrow(/no type alias RunEvent/);
  });
});

describe("the SDK's RunEvent union against the runtime's", () => {
  const runtime = readWireUnion(RUNTIME_TYPES, readFileSync(RUNTIME_TYPES, "utf-8"));
  const sdk = readWireUnion(SDK_TYPES, readFileSync(SDK_TYPES, "utf-8"));

  it("reads both unions, not empty, and the runtime's heartbeat stages", () => {
    expect(runtime.types.size).toBeGreaterThan(0);
    expect(sdk.types.size).toBeGreaterThan(0);
    expect(runtime.types.has(HEARTBEAT)).toBe(true);
    expect(runtime.heartbeatStages?.length ?? 0).toBeGreaterThan(0);
  });

  it("has every event type of the runtime", () => {
    const missing = [...runtime.types.keys()].filter((type) => !sdk.types.has(type));
    expect(missing, "event types of the runtime missing from the SDK").toEqual([]);
  });

  it("has every heartbeat stage of the runtime", () => {
    const sdkStages = new Set(sdk.heartbeatStages ?? []);
    const missing = (runtime.heartbeatStages ?? []).filter((stage) => !sdkStages.has(stage));
    expect(missing, "heartbeat stages of the runtime missing from the SDK").toEqual([]);
  });
});

/**
 * The seam between two numbers in two packages. A streamed call of the SDK
 * gives up after a silence of its timeout; the server breaks every wait of a
 * run with a heartbeat at its own cadence. A cadence at or above the SDK's
 * default timeout would cut every long run of a client that keeps the default
 * — each value correct on its own side. Read as syntax, like the unions above:
 * nothing is imported.
 */
const RUNTIME_LOOP = join(
  import.meta.dirname,
  "..",
  "..",
  "runtime",
  "src",
  "adapter",
  "agent-loop.ts",
);
const SDK_CLIENT = join(import.meta.dirname, "..", "src", "client.ts");

/** The numeric initializer of a top-level `const <name> = <number>;` of a source file. */
function numericConstant(fileName: string, source: string, name: string): number {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const init = declaration.initializer;
      if (init && ts.isNumericLiteral(init)) return Number(init.text.replace(/_/g, ""));
      throw new Error(`${fileName}: ${name} is not initialised with a number literal`);
    }
  }
  throw new Error(`${fileName}: no top-level constant ${name}`);
}

describe("the runtime's heartbeat cadence against the SDK's default timeout", () => {
  const cadence = numericConstant(
    RUNTIME_LOOP,
    readFileSync(RUNTIME_LOOP, "utf-8"),
    "DEFAULT_HEARTBEAT_INTERVAL_MS",
  );
  const timeout = numericConstant(SDK_CLIENT, readFileSync(SDK_CLIENT, "utf-8"), "DEFAULT_TIMEOUT");

  it("reads both values, as positive numbers", () => {
    expect(cadence).toBeGreaterThan(0);
    expect(timeout).toBeGreaterThan(0);
  });

  it("beats strictly more often than the SDK's default timeout gives up", () => {
    expect(cadence, "runtime heartbeat cadence (ms) vs SDK default timeout (ms)").toBeLessThan(
      timeout,
    );
  });

  it("reads a constant the way it is written, and fails on one it cannot read", () => {
    expect(numericConstant("w.ts", "export const X = 30_000;", "X")).toBe(30000);
    expect(() => numericConstant("w.ts", "const X = 2 * 1000;", "X")).toThrow(/number literal/);
    expect(() => numericConstant("w.ts", "const Y = 1;", "X")).toThrow(/no top-level constant X/);
  });
});
