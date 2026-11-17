import { describe, expect, it } from "vitest";
import {
  isRunInputAbsent,
  runBodyInput,
  runDeclaredInputsRefusal,
  runInputTypeRefusal,
  runMissingInputRefusal,
} from "./run-body.js";

// The exact words a caller reads, each pinned whole.
const NOT_AN_OBJECT =
  'The request body must be a JSON object with an "input" field, e.g. {"input": {"query": "hello"}}.';
const NO_INPUT =
  'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.';
const INPUT_NULL =
  '"input" is null: send the agent\'s input as an object, e.g. {"input": {"query": "hello"}}.';

/** The body as a server reads it: parsed from the JSON text a request carries. */
const parsed = (text: string): unknown => JSON.parse(text);

describe("runBodyInput — a body that is not an object", () => {
  it.each([
    ["a number", "5"],
    ["a string", '"abc"'],
    ["a boolean", "true"],
    ["an array", "[1]"],
    ["null", "null"],
  ])("refuses %s as INVALID_REQUEST, saying the body must be an object with an input field", (_label, text) => {
    expect(runBodyInput(parsed(text))).toEqual({
      refusal: { code: "INVALID_REQUEST", message: NOT_AN_OBJECT },
    });
  });
});

describe("runBodyInput — an object with no input field", () => {
  it.each([
    ["the empty object", "{}"],
    ["an object of the agent's fields, sent without input", '{"q":"x"}'],
  ])("refuses %s as INVALID_REQUEST, never taking the body for the input", (_label, text) => {
    expect(runBodyInput(parsed(text))).toEqual({
      refusal: { code: "INVALID_REQUEST", message: NO_INPUT },
    });
  });

  it("reads input as the body's own field, never one its prototype carries", () => {
    const body = Object.create({ input: { q: "x" } }) as Record<string, unknown>;
    body.q = "x";
    expect(runBodyInput(body)).toEqual({
      refusal: { code: "INVALID_REQUEST", message: NO_INPUT },
    });
  });
});

describe("runBodyInput — an input that is null", () => {
  it("refuses it as INVALID_REQUEST, never falling back on the body", () => {
    expect(runBodyInput(parsed('{"input":null,"q":"x"}'))).toEqual({
      refusal: { code: "INVALID_REQUEST", message: INPUT_NULL },
    });
  });
});

describe("runBodyInput — an input present", () => {
  it.each([
    ["an object", '{"input":{"q":"x"}}', { q: "x" }],
    ["a number", '{"input":5}', 5],
    ["an array", '{"input":[1]}', [1]],
    ["zero", '{"input":0}', 0],
    ["an empty string", '{"input":""}', ""],
    ["false", '{"input":false}', false],
  ])("hands back %s as it is, its shape left to the reader", (_label, text, input) => {
    expect(runBodyInput(parsed(text))).toEqual({ input });
  });

  it("hands back the very value the body holds, and nothing of the body's other fields", () => {
    const input = { q: "x" };
    const reading = runBodyInput({ input, version: "1.0.0", webhook_url: "https://example.com/x" });
    expect(reading).toEqual({ input: { q: "x" } });
    expect("input" in reading && reading.input).toBe(input);
  });
});

describe("runInputTypeRefusal — an input that is not an object", () => {
  it.each([
    ["a number", '{"input":5}', "number"],
    ["zero", '{"input":0}', "number"],
    ["a string", '{"input":"x"}', "string"],
    ["an empty string", '{"input":""}', "string"],
    ["a boolean", '{"input":true}', "boolean"],
    ["false", '{"input":false}', "boolean"],
  ])("refuses %s as INVALID_INPUT_TYPE, its type named", (_label, text, type) => {
    const reading = runBodyInput(parsed(text));
    expect("input" in reading && runInputTypeRefusal(reading.input)).toEqual({
      code: "INVALID_INPUT_TYPE",
      message: `Input expected object, got ${type}`,
    });
  });

  it("refuses null too, should a reader hand it over", () => {
    expect(runInputTypeRefusal(null)).toEqual({
      code: "INVALID_INPUT_TYPE",
      message: "Input expected object, got object",
    });
  });

  it.each([
    ["an object", '{"input":{"q":"x"}}'],
    ["an empty object", '{"input":{}}'],
    ["an array, left to the check of the agent's inputs", '{"input":[1]}'],
  ])("lets %s through", (_label, text) => {
    const reading = runBodyInput(parsed(text));
    expect("input" in reading && runInputTypeRefusal(reading.input)).toBeUndefined();
  });
});

describe("runDeclaredInputsRefusal — each input the agent declares, in its order: its absence, then its type", () => {
  const q = { name: "q", type: "string", required: true };
  const a = { name: "a", type: "string", required: true };
  const b = { name: "b", type: "string", required: true };

  it.each([
    ["an empty object", {}],
    ["an object of other fields", { other: "x" }],
    ["an array", [1]],
  ])("refuses %s as MISSING_INPUT, naming the required input in the API's words", (_label, input) => {
    expect(runDeclaredInputsRefusal([q], input)).toEqual({
      code: "MISSING_INPUT",
      message: "Missing required input: q",
    });
  });

  it("judges the inputs in the order the agent declares them, each its absence then its type", () => {
    expect(runDeclaredInputsRefusal([a, b], { a: 5 })).toEqual({
      code: "INVALID_INPUT_TYPE",
      message: 'Input "a" expected string, got number',
    });
    expect(runDeclaredInputsRefusal([a, b], { b: "x" })).toEqual({
      code: "MISSING_INPUT",
      message: "Missing required input: a",
    });
    expect(runDeclaredInputsRefusal([a, b], { a: "x" })).toEqual({
      code: "MISSING_INPUT",
      message: "Missing required input: b",
    });
  });

  it.each([
    ["a number for a string", "string", 5, "number"],
    ["a string for a number", "number", "5", "string"],
    ["a string for a boolean", "boolean", "true", "string"],
    ["an object for an array", "array", { x: 1 }, "object"],
    ["an array for a string", "string", [1], "array"],
  ])("refuses %s as INVALID_INPUT_TYPE, naming the type received", (_label, type, value, received) => {
    expect(runDeclaredInputsRefusal([{ name: "v", type, required: true }], { v: value })).toEqual({
      code: "INVALID_INPUT_TYPE",
      message: `Input "v" expected ${type}, got ${received}`,
    });
  });

  it.each([
    ["the required input carried", [q], { q: "x" }],
    ["an optional input missing", [{ ...q, required: false }], {}],
    ["an input declared object, whatever its value", [{ ...q, type: "object" }], { q: "x" }],
    ["an array for an array", [{ ...q, type: "array" }], { q: [1] }],
    [
      "a required file input carried, whatever it holds — what it holds is judged where it is read",
      [{ ...q, type: "file" }],
      { q: 5 },
    ],
    [
      "a required file input carried as a list that holds null: a list of one is not empty",
      [{ ...q, type: "file" }],
      { q: [null] },
    ],
    [
      "a required array input carried as an empty list: a value",
      [{ ...q, type: "array" }],
      { q: [] },
    ],
  ])("lets %s through", (_label, fields, input) => {
    expect(runDeclaredInputsRefusal(fields, input)).toBeUndefined();
  });

  it.each([
    ["toString", "the empty object", {}],
    ["constructor", "the empty object", {}],
    ["hasOwnProperty", "an object of other fields", { other: "x" }],
    ["filter", "an array", [1]],
  ])("counts a required input named %s present only as the input's own field — %s does not carry it", (name, _label, input) => {
    expect(runDeclaredInputsRefusal([{ name, type: "string", required: true }], input)).toEqual({
      code: "MISSING_INPUT",
      message: `Missing required input: ${name}`,
    });
  });

  it.each([
    ["toString", "the empty object", {}],
    ["filter", "an array", [1]],
  ])("lets an optional input named %s through when only the input's prototype carries it — %s does not carry it, so it is absent", (name, _label, input) => {
    expect(
      runDeclaredInputsRefusal([{ name, type: "string", required: false }], input),
    ).toBeUndefined();
  });

  it.each([
    ["absent", {}],
    ["null", { doc: null }],
    ["an empty list", { doc: [] }],
  ])("refuses a required file input that is %s as MISSING_INPUT, in the words of any other missing input", (_label, input) => {
    expect(
      runDeclaredInputsRefusal([{ name: "doc", type: "file", required: true }], input),
    ).toEqual({
      code: "MISSING_INPUT",
      message: "Missing required input: doc",
    });
  });

  it.each([
    ["null", { doc: null }],
    ["an empty list", { doc: [] }],
  ])("lets an optional file input that is %s through: it is absent, left out", (_label, input) => {
    expect(
      runDeclaredInputsRefusal([{ name: "doc", type: "file", required: false }], input),
    ).toBeUndefined();
  });

  it("refuses a required file input sent as an empty list before the type of an input declared after it", () => {
    expect(
      runDeclaredInputsRefusal(
        [
          { name: "doc", type: "file", required: true },
          { name: "n", type: "number", required: true },
        ],
        { doc: [], n: "x" },
      ),
    ).toEqual({ code: "MISSING_INPUT", message: "Missing required input: doc" });
  });

  it.each([
    ["string", "string"],
    ["number", "number"],
    ["boolean", "boolean"],
    ["array", "array"],
    ["object, which takes any value but null", "object"],
  ])("refuses a required %s input sent as null as MISSING_INPUT — null is never a wrong type", (_label, type) => {
    expect(runDeclaredInputsRefusal([{ name: "v", type, required: true }], { v: null })).toEqual({
      code: "MISSING_INPUT",
      message: "Missing required input: v",
    });
  });

  it.each([
    ["string", "string"],
    ["number", "number"],
    ["object", "object"],
  ])("lets an optional %s input sent as null through, its type not judged: it is absent", (_label, type) => {
    expect(
      runDeclaredInputsRefusal([{ name: "v", type, required: false }], { v: null }),
    ).toBeUndefined();
  });
});

describe("isRunInputAbsent — what an absent input is, whatever its type", () => {
  it.each([
    ["not a field of the input", { name: "q", type: "string" }, {}],
    ["a name only the prototype carries: toString", { name: "toString", type: "string" }, {}],
    ["a name only the prototype carries: constructor", { name: "constructor", type: "object" }, {}],
    ["a name only an array's prototype carries: filter", { name: "filter", type: "string" }, [1]],
    ["undefined", { name: "q", type: "string" }, { q: undefined }],
    ["null, for a string input", { name: "q", type: "string" }, { q: null }],
    ["null, for an object input", { name: "q", type: "object" }, { q: null }],
    ["null, for a file input", { name: "doc", type: "file" }, { doc: null }],
    ["an empty list, for a file input", { name: "doc", type: "file" }, { doc: [] }],
  ])("counts %s as absent", (_label, field, input) => {
    expect(isRunInputAbsent(field, input)).toBe(true);
  });

  it.each([
    ["an empty list, for an array input", { name: "q", type: "array" }, { q: [] }],
    ["a list that holds null, for a file input", { name: "doc", type: "file" }, { doc: [null] }],
    [
      "one descriptor alone, for a file input",
      { name: "doc", type: "file" },
      { doc: { type: "file", source: "id", file_id: "f" } },
    ],
    ["zero", { name: "q", type: "number" }, { q: 0 }],
    ["an empty string", { name: "q", type: "string" }, { q: "" }],
    ["false", { name: "q", type: "boolean" }, { q: false }],
    [
      "a value of another type than declared: no type is judged",
      { name: "q", type: "string" },
      { q: 5 },
    ],
    [
      "a field of the input's own named toString",
      { name: "toString", type: "string" },
      { toString: "x" },
    ],
  ])("counts %s as present", (_label, field, input) => {
    expect(isRunInputAbsent(field, input)).toBe(false);
  });
});

describe("runMissingInputRefusal — the refusal of a required input that is absent", () => {
  it("gives MISSING_INPUT, naming the input in the API's words", () => {
    expect(runMissingInputRefusal("x")).toEqual({
      code: "MISSING_INPUT",
      message: "Missing required input: x",
    });
  });
});
