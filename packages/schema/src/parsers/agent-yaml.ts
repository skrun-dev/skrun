import { readFile } from "node:fs/promises";
import {
  type CollectionTag,
  CST,
  type Document,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  Lexer,
  LineCounter,
  type Pair,
  parseDocument,
  visit,
  YAMLParseError,
} from "yaml";
import { ValidationError } from "../errors.js";
import type { AgentConfig } from "../schemas/agent-config.js";
import { AgentConfigSchema } from "../schemas/agent-config.js";

export interface ParsedAgentYaml {
  config: AgentConfig;
  raw: string;
  filePath?: string;
  /** The warnings the `yaml` library gave the file: never emitted, returned. */
  warnings: AgentYamlWarnings;
}

/**
 * The warnings the `yaml` library gave a file it read — an unresolved tag, a
 * version it does not know —: how many; the first few, each the first line of
 * the library's message (what it says, and the line and column), never the
 * line of the file it quotes after; and the first one's code and place. One
 * file can carry thousands; its reader says them once — the push in one log
 * line, the CLI's validation in a few warnings —, where the library would
 * emit each.
 */
export interface AgentYamlWarnings {
  count: number;
  /**
   * The first line of each of the first few messages. It can quote the file —
   * an unresolved tag's name, of any length —: for the creator's own eyes,
   * the CLI's.
   */
  first: string[];
  /**
   * The first warning's code, the library's (`TAG_RESOLVE_FAILED`…), and its
   * line and column, from 1 — nothing of the file: what the server logs.
   * Absent when there is no warning.
   */
  firstAt?: { code: string; line: number; column: number };
}

/** How many of a file's warnings `AgentYamlWarnings.first` keeps. */
export const AGENT_YAML_WARNINGS_KEPT = 3;

/** The first line of a warning's message, its trailing `:` left out. */
function warningLine(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/:$/, "");
}

/** What `parseAgentYaml` returns of a document's warnings (`AgentYamlWarnings`). */
function warningsOf(doc: Document.Parsed, lines: LineCounter): AgentYamlWarnings {
  const warnings: AgentYamlWarnings = {
    count: doc.warnings.length,
    first: doc.warnings
      .slice(0, AGENT_YAML_WARNINGS_KEPT)
      .map((warning) => warningLine(warning.message)),
  };
  const [first] = doc.warnings;
  if (first) {
    const { line, col } = lines.linePos(first.pos[0]);
    warnings.firstAt = { code: first.code, line, column: col };
  }
  return warnings;
}

/** The refusal of a file that does not parse as one YAML document. */
function invalidYaml(cause: unknown): ValidationError {
  return new ValidationError(
    "Failed to parse agent.yaml",
    [
      {
        code: "INVALID_YAML",
        message: `YAML parse error: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    ],
    cause,
  );
}

/** A key that repeats an earlier key of its mapping. */
interface DuplicateKey {
  /** Where the library placed its refusal: the key's first character. */
  offset: number;
  /**
   * Where the library had read to when it refused the key: the end of the
   * key in a block mapping, of its value in a flow mapping.
   */
  readTo: number;
  flow: boolean;
}

/**
 * Whether the library raised `error` before refusing `duplicate`: an error
 * found before the point it had read to, other than the two it raises about a
 * block mapping's key once it has refused it — a key longer than 1,024
 * characters, a key followed by no value —, placed at the key's first
 * character.
 */
function raisedBefore(error: YAMLParseError, duplicate: DuplicateKey): boolean {
  const at = error.pos[0];
  if (
    !duplicate.flow &&
    at === duplicate.offset &&
    (error.code === "KEY_OVER_1024_CHARS" || error.code === "MISSING_CHAR")
  ) {
    return false;
  }
  return at < duplicate.readTo;
}

/**
 * Whether `pair`'s key repeats a key of `keys`, the keys of its mapping read
 * so far — the key added to them otherwise. Two keys repeat each other as the
 * `yaml` library compares them: two scalars of the same value (`a`, `"a"` and
 * `'a'`; `1`, `1.0` and `0x1`; `null`, `~` and an empty key; `true` and
 * `True`), never two collections, nor two `.nan`.
 */
function duplicateOf(pair: Pair, keys: Set<unknown>, flow: boolean): DuplicateKey | undefined {
  const key = pair.key;
  if (!isScalar(key)) return undefined;
  const { value } = key;
  if (typeof value === "number" && Number.isNaN(value)) return undefined;
  if (!keys.has(value)) {
    keys.add(value);
    return undefined;
  }
  let offset = key.range?.[0] ?? 0;
  // An empty key (`: v`) the library placed after everything before it — the
  // indentation, a `?`, an anchor — where its node starts before them.
  const item = pair.srcToken;
  const last = item?.start[item.start.length - 1];
  if (item && !item.key && last) offset = last.offset + last.source.length;
  const end = flow ? (isNode(pair.value) ? pair.value : key).range?.[2] : key.range?.[1];
  return { offset, readTo: Math.max(offset, end ?? offset), flow };
}

/**
 * The first key that repeats an earlier key of its mapping, in the order the
 * `yaml` library reads them, or `undefined`. The library's own
 * check compares each key with every earlier key of its mapping: 40,000 keys
 * of one mapping held the event loop 8 s, four times longer each time they
 * doubled. The parse turns it off (`uniqueKeys: false`), and this pass keeps a
 * set of each mapping's keys. It reads the document as the library did: a key
 * of a block mapping judged once it is read, one of a flow mapping once its
 * value is; the pairs of a `!!pairs` or `!!omap`, which sit in a sequence,
 * not compared.
 */
function firstDuplicateKey(node: unknown): DuplicateKey | undefined {
  if (isPair(node)) return firstDuplicateKey(node.key) ?? firstDuplicateKey(node.value);
  if (isSeq(node)) {
    for (const item of node.items) {
      const found = firstDuplicateKey(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isMap(node)) return undefined;
  const keys = new Set<unknown>();
  const flow = node.flow === true;
  for (const pair of node.items) {
    const found =
      firstDuplicateKey(pair.key) ??
      (flow ? undefined : duplicateOf(pair, keys, false)) ??
      firstDuplicateKey(pair.value) ??
      (flow ? duplicateOf(pair, keys, true) : undefined);
    if (found) return found;
  }
  return undefined;
}

/**
 * The refusal of a repeated key — the library's, `INVALID_YAML`, in its words:
 * "Map keys must be unique at line 4, column 3:", then the line, the one
 * before it when the key starts its line, and a caret under the key, its
 * formatting (`prettifyError`, which the library does not export) reproduced
 * for this one error. Placed at the repeated key: where the library places it
 * for most, but not all — where an earlier key has an empty value, say, the
 * library pointed after that one. And in a file with another error too, the
 * error refused first is not always the library's first. Measured on 20,000
 * random documents (2026-11-16): the same refusal for every one, the
 * library's message for 19,900; the other 100, about one in twenty of the
 * 2,123 repeated keys, a repeated key placed elsewhere or another error named
 * first. A test holds the two equal on the cases it lists.
 */
function duplicateKeyError(offset: number, source: string, lines: LineCounter): YAMLParseError {
  const error = new YAMLParseError(
    [offset, offset + 1],
    "DUPLICATE_KEY",
    "Map keys must be unique",
  );
  const start = lines.linePos(offset);
  error.linePos = [start, lines.linePos(offset + 1)];
  const { line, col } = start;
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = source
    .substring(lines.lineStarts[line - 1], lines.lineStarts[line])
    .replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = `…${lineStr.substring(trimStart)}`;
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80) lineStr = `${lineStr.substring(0, 79)}…`;
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = source.substring(lines.lineStarts[line - 2], lines.lineStarts[line - 1]);
    if (prev.length > 80) prev = `${prev.substring(0, 79)}…\n`;
    lineStr = prev + lineStr;
  }
  // The error spans one character: the library's caret is one wide.
  if (/[^ ]/.test(lineStr)) error.message += `:\n\n${lineStr}\n${" ".repeat(ci)}^\n`;
  return error;
}

/**
 * The name of the first alias (`*name`) the document holds, or `undefined`.
 * Read on the parsed document, before any value is built. An alias repeats
 * the value its anchor names, so a small file can describe a configuration
 * many times its size — and the `yaml` library's own bound (`maxAliasCount`)
 * counts an alias of a collection of empty collections as nothing. An anchor
 * (`&name`) that no alias repeats is a label, and is left as it is.
 */
function firstAlias(doc: Document.Parsed): string | undefined {
  let found: string | undefined;
  visit(doc, {
    Alias(_key, node) {
      found = node.source;
      return visit.BREAK;
    },
  });
  return found;
}

/**
 * How an agent.yaml is read, by each of its reads — this parse, and the CLI's
 * second read of its retired fields (`validateAgent`): as YAML 1.2, with the
 * core schema. Named here, not left to the `yaml` library's defaults, so that a
 * version of the library that changes them — it already knows a version
 * `"next"` — does not change how a stored or a new agent.yaml is read. The
 * schema named, it holds for every document of the file, whatever its
 * directives; a file that declares another version is refused before it is
 * read (`YAML_VERSION`).
 */
export const AGENT_YAML_READING = { version: "1.2", schema: "core" } as const;

/**
 * The first `%YAML` directive of the file that declares another version than
 * 1.2, as written, or `undefined`. An agent.yaml is read as YAML 1.2, with the
 * core schema, whatever it declares (`AGENT_YAML_READING`): a file that
 * declares another version would be read otherwise than it says — under
 * `%YAML 1.1`, `yes` a string where its author meant a boolean —, so it is
 * refused, and so is a version the library does not know — `1.0`, `1.3`. (Left
 * to the library's defaults, `%YAML 1.1` switched it to the YAML 1.1 types,
 * whose `!!omap` compares each key with every earlier one: 63,000 entries held
 * the event loop 5.4 s.) Read with the library's lexer, which yields the directives
 * before the document starts, and stops there: the document is not read.
 */
function otherVersionDirective(content: string): string | undefined {
  for (const token of new Lexer().lex(content)) {
    const type = CST.tokenType(token);
    if (type === "doc-mode") return undefined;
    if (type === "directive-line") {
      const [name, version] = token.split(/[ \t]+/);
      if (name === "%YAML" && version !== "1.2") return token;
    }
  }
  return undefined;
}

/**
 * The tag of the YAML 1.1 ordered map, whatever names it: `!!omap`,
 * `!<tag:yaml.org,2002:omap>`, a `%TAG` handle.
 */
const OMAP_TAG = "tag:yaml.org,2002:omap";

/**
 * `!!omap` read as the sequence it is written as, nothing checked. The `yaml`
 * library resolves this YAML 1.1 type in a YAML 1.2 document too, and checks
 * its keys by comparing each with every earlier one: 63,000 entries held the
 * event loop 5 s, 107,000 written as one flow sequence 13.5 s — in any
 * document of the file, a second one included, which the parse refuses only
 * once it has read it. Placed first among the tags, it is found before the
 * library's own; the tag is then refused (`YAML_TAG`).
 */
const omapUnchecked: CollectionTag = {
  tag: OMAP_TAG,
  collection: "seq",
  default: false,
  resolve: (seq) => seq,
};

/** Whether the document holds a node tagged `!!omap` — a sequence, a mapping or a scalar. */
function holdsOmap(doc: Document.Parsed): boolean {
  let found = false;
  visit(doc, {
    Node(_key, node) {
      if (node.tag !== OMAP_TAG) return undefined;
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

/**
 * Parse and validate an `agent.yaml` — the one reading of the push, the run
 * and the CLI's validation. Refused with a `ValidationError`: a file that
 * declares another YAML version than 1.2 (`YAML_VERSION`); one that is not
 * one YAML document, a key repeated in its mapping included (`INVALID_YAML`);
 * one that holds an alias (`YAML_ALIAS`); one that holds the tag `!!omap`
 * (`YAML_TAG`); one that is not an object (`INVALID_STRUCTURE`); one the
 * schema refuses (`INVALID_FIELD`, each issue).
 */
export function parseAgentYaml(content: string): ParsedAgentYaml {
  const directive = otherVersionDirective(content);
  if (directive !== undefined) {
    throw new ValidationError("agent.yaml declares another YAML version than 1.2", [
      {
        code: "YAML_VERSION",
        message: `agent.yaml is read as YAML 1.2: the directive ${directive} is not accepted. Remove that line.`,
      },
    ]);
  }

  let doc: Document.Parsed;
  const lines = new LineCounter();
  try {
    doc = parseDocument(content, {
      ...AGENT_YAML_READING,
      customTags: (tags) => [omapUnchecked, ...tags],
      keepSourceTokens: true,
      lineCounter: lines,
      uniqueKeys: false,
    });
    // As the library's `parse` does, the first error thrown — a repeated key
    // in the place the library's own check gave it. Its warnings are
    // returned, never emitted (`AgentYamlWarnings`).
    const duplicate = firstDuplicateKey(doc.contents);
    if (duplicate && !doc.errors.some((error) => raisedBefore(error, duplicate))) {
      throw duplicateKeyError(duplicate.offset, content, lines);
    }
    if (doc.errors.length > 0) throw doc.errors[0];
  } catch (cause) {
    throw invalidYaml(cause);
  }

  const alias = firstAlias(doc);
  if (alias !== undefined) {
    throw new ValidationError("agent.yaml uses a YAML alias", [
      {
        code: "YAML_ALIAS",
        message: `YAML aliases are not accepted in agent.yaml: *${alias} repeats the value anchored as &${alias}. Write the value out in full wherever it is used.`,
      },
    ]);
  }

  if (holdsOmap(doc)) {
    throw new ValidationError("agent.yaml uses the YAML tag !!omap", [
      {
        code: "YAML_TAG",
        message:
          "The YAML tag !!omap is not accepted in agent.yaml. Remove it, and write the entries as a mapping.",
      },
    ]);
  }

  let rawData: unknown;
  try {
    rawData = doc.toJS();
  } catch (cause) {
    throw invalidYaml(cause);
  }

  if (!rawData || typeof rawData !== "object") {
    throw new ValidationError("agent.yaml must contain a YAML object", [
      {
        code: "INVALID_STRUCTURE",
        message: "Expected a YAML object, got a scalar or empty document",
      },
    ]);
  }

  const result = AgentConfigSchema.safeParse(rawData);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      code: "INVALID_FIELD",
      message: `${issue.path.join(".")}: ${issue.message}`,
      field: issue.path.join("."),
    }));
    throw new ValidationError("Invalid agent.yaml", issues, result.error);
  }

  return {
    config: result.data,
    raw: content,
    warnings: warningsOf(doc, lines),
  };
}

export async function parseAgentYamlFile(filePath: string): Promise<ParsedAgentYaml> {
  const content = await readFile(filePath, "utf-8");
  const parsed = parseAgentYaml(content);
  parsed.filePath = filePath;
  return parsed;
}
