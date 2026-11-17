import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The runner image's root loop (`infra/runtime-image/dns-reresolve.sh`) repeats
 * two things the TypeScript side declares, and nothing else compares them:
 *
 * - the forms of an allowed host it accepts at a pre-created machine's
 *   assignment — a host name, or an IPv6 literal, each tested by a pattern —,
 *   which the schema's own patterns (`SANDBOX_HOST_NAME`, `IPV6_CHARACTERS`,
 *   `packages/schema/src/schemas/environment-config.ts`) must match: the run
 *   route refuses, before any machine, what the loop would refuse; a pattern
 *   that drifted would let a run through to a machine that then refuses it;
 * - the words its infrastructure check writes (`changed`, `unmeasured`,
 *   `unchanged`), which the runner reports and the harness reads against the
 *   contract's list (`INFRA_HOSTS_CHECKS`,
 *   `packages/runtime/src/runner-contract.ts`): a word renamed on one side is
 *   read as absent on the other, every assignment counted unmeasured, in
 *   silence.
 *
 * This file reads the shell as text — each `[[ "$host" =~ <pattern> ]]` in the
 * function that applies an assignment's hosts, each word assigned to the
 * check's verdict in the function that measures — and the TypeScript in its
 * syntax, and fails on any difference, naming the file it read. What it does
 * not see: a pattern the loop tests some other way, and what the patterns mean
 * beyond their text.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(join(ROOT, "packages/runtime/package.json"))(
  "typescript",
) as typeof import("typescript");

const LOOP = "infra/runtime-image/dns-reresolve.sh";
const SCHEMA = "packages/schema/src/schemas/environment-config.ts";
const CONTRACT = "packages/runtime/src/runner-contract.ts";

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** The body of a shell function, from its `name() {` line to its closing `}`. */
function shellFunction(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && line === "}");
  return end < 0 ? undefined : lines.slice(start + 1, end).join("\n");
}

/** The patterns a shell function tests an assigned host against, in order. */
function hostPatterns(text: string): string[] {
  const body = shellFunction(text, "apply_assigned_hosts") ?? "";
  return [...body.matchAll(/\[\[ "\$host" =~ (\S+) \]\]/g)].map((m) => m[1]);
}

/** The words the infrastructure check assigns to its verdict. */
function verdictWords(text: string): string[] {
  const body = shellFunction(text, "infra_check") ?? "";
  return [...new Set([...body.matchAll(/\bverdict=([a-z]+)/g)].map((m) => m[1]))].sort();
}

/** The source of the regular expression a TypeScript constant is declared with. */
function regexSource(file: string, text: string, name: string): string | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: string | undefined;
  const visit = (node: import("typescript").Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isRegularExpressionLiteral(node.initializer)
    ) {
      const literal = node.initializer.text;
      found = literal.slice(1, literal.lastIndexOf("/"));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The strings of the array a TypeScript constant is declared with (`as const` or not). */
function stringArray(file: string, text: string, name: string): string[] | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: string[] | undefined;
  const visit = (node: import("typescript").Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      let init: import("typescript").Expression = node.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init)) {
        found = init.elements.filter(ts.isStringLiteral).map((e) => e.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Each difference between the loop's host forms and the schema's, named. */
function hostFormFindings(loop: string, schema: string): string[] {
  const shell = hostPatterns(loop);
  const typed = [
    regexSource(SCHEMA, schema, "SANDBOX_HOST_NAME"),
    regexSource(SCHEMA, schema, "IPV6_CHARACTERS"),
  ];
  const findings: string[] = [];
  if (shell.length !== 2) {
    findings.push(`${LOOP} — tests an assigned host against ${shell.length} pattern(s), not 2`);
  }
  const labels = ["a host name", "an IPv6 literal"];
  for (const [i, label] of labels.entries()) {
    if (typed[i] === undefined) {
      findings.push(`${SCHEMA} — declares no pattern for ${label}`);
    } else if (shell[i] !== typed[i]) {
      findings.push(
        `${LOOP} — tests ${label} against ${shell[i] ?? "nothing"}, ${SCHEMA} against ${typed[i]}`,
      );
    }
  }
  return findings;
}

/** Each difference between the words the loop writes and the contract's, named. */
function wordFindings(loop: string, contract: string): string[] {
  const shell = verdictWords(loop);
  const typed = stringArray(CONTRACT, contract, "INFRA_HOSTS_CHECKS");
  if (typed === undefined) return [`${CONTRACT} — declares no INFRA_HOSTS_CHECKS`];
  const findings: string[] = [];
  for (const word of shell.filter((w) => !typed.includes(w))) {
    findings.push(`${LOOP} — writes '${word}', which ${CONTRACT} does not list`);
  }
  for (const word of typed.filter((w) => !shell.includes(w))) {
    findings.push(`${CONTRACT} — lists '${word}', which ${LOOP} never writes`);
  }
  return findings;
}

const LOOP_FIXTURE = [
  "apply_assigned_hosts() {",
  '  if [[ "$host" =~ ^[a-z]+$ ]]; then',
  "    :",
  '  elif [[ "$host" =~ ^[0-9:]+$ ]]; then',
  "    :",
  "  fi",
  "}",
  "infra_check() {",
  "  local verdict=unchanged",
  "  verdict=unmeasured",
  '  [[ "$verdict" == changed ]] || verdict=unmeasured',
  "  verdict=changed",
  "}",
].join("\n");

const SCHEMA_FIXTURE = [
  "const SANDBOX_HOST_NAME = /^[a-z]+$/;",
  "const IPV6_CHARACTERS = /^[0-9:]+$/;",
].join("\n");

const CONTRACT_FIXTURE =
  'export const INFRA_HOSTS_CHECKS = ["changed", "unmeasured", "unchanged"] as const;';

describe("the root loop's copies of the TypeScript side — what the rule reads and refuses", () => {
  it("reads the patterns in the assignment's function, and the words in the check's", () => {
    expect(hostPatterns(LOOP_FIXTURE)).toEqual(["^[a-z]+$", "^[0-9:]+$"]);
    expect(verdictWords(LOOP_FIXTURE)).toEqual(["changed", "unchanged", "unmeasured"]);
    expect(hostFormFindings(LOOP_FIXTURE, SCHEMA_FIXTURE)).toEqual([]);
    expect(wordFindings(LOOP_FIXTURE, CONTRACT_FIXTURE)).toEqual([]);
  });

  it("names a pattern that differs on either side", () => {
    expect(hostFormFindings(LOOP_FIXTURE.replace("^[a-z]+$", "^[a-z.]+$"), SCHEMA_FIXTURE)).toEqual(
      [`${LOOP} — tests a host name against ^[a-z.]+$, ${SCHEMA} against ^[a-z]+$`],
    );
    expect(
      hostFormFindings(LOOP_FIXTURE, SCHEMA_FIXTURE.replace("/^[0-9:]+$/", "/^[0-9a-f:]+$/")),
    ).toEqual([
      `${LOOP} — tests an IPv6 literal against ^[0-9:]+$, ${SCHEMA} against ^[0-9a-f:]+$`,
    ]);
  });

  it("names a word renamed on either side", () => {
    expect(
      wordFindings(
        LOOP_FIXTURE.replaceAll("verdict=unmeasured", "verdict=unknown"),
        CONTRACT_FIXTURE,
      ),
    ).toEqual([
      `${LOOP} — writes 'unknown', which ${CONTRACT} does not list`,
      `${CONTRACT} — lists 'unmeasured', which ${LOOP} never writes`,
    ]);
    expect(wordFindings(LOOP_FIXTURE, CONTRACT_FIXTURE.replace('"changed"', '"moved"'))).toEqual([
      `${LOOP} — writes 'changed', which ${CONTRACT} does not list`,
      `${CONTRACT} — lists 'moved', which ${LOOP} never writes`,
    ]);
  });
});

describe("the root loop's copies of the TypeScript side — the code", () => {
  const loop = read(LOOP);

  // Read line by line: a carriage return would hide every line from the reads
  // below, and bash itself would not run the script.
  it("is read with the line endings bash runs it with", () => {
    expect(loop.includes("\r"), `${LOOP} has CRLF line endings`).toBe(false);
  });

  it("tests an assigned host against the schema's two patterns, in the same order", () => {
    expect(hostPatterns(loop)).toHaveLength(2);
    expect(hostFormFindings(loop, read(SCHEMA))).toEqual([]);
  });

  it("writes exactly the words of the contract's infrastructure check", () => {
    expect(verdictWords(loop)).toHaveLength(3);
    expect(wordFindings(loop, read(CONTRACT))).toEqual([]);
  });
});
