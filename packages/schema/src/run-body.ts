/** Why a run request's body was refused: the code and the words its caller reads. */
export interface RunBodyRefusal {
  code: "INVALID_REQUEST";
  message: string;
}

/**
 * What a run request's body gives: the agent's input — the value of its
 * `input` field, whatever it is —, or the reason the body is refused.
 */
export type RunBodyReading = { input: unknown } | { refusal: RunBodyRefusal };

const NOT_AN_OBJECT =
  'The request body must be a JSON object with an "input" field, e.g. {"input": {"query": "hello"}}.';
const NO_INPUT =
  'The request body has no "input" field: send the agent\'s input under it, e.g. {"input": {"query": "hello"}}.';
const INPUT_NULL =
  '"input" is null: send the agent\'s input as an object, e.g. {"input": {"query": "hello"}}.';

function refused(message: string): RunBodyReading {
  return { refusal: { code: "INVALID_REQUEST", message } };
}

/**
 * Reads the agent's input out of a run request's body, parsed from its JSON:
 * the body is an object, and the input is its `input` field. Refused, each by
 * its own words: a body that is not an object (a number, a string, a boolean,
 * an array, null); an object with no `input` field, the empty object
 * included; an `input` that is null. The body is never taken for the input
 * itself.
 *
 * An `input` present is handed back as it is: what its shape must be is the
 * reader's to judge. One definition, read by the run route of the API and by
 * the server of `skrun dev`, so that both refuse the same bodies in the same
 * words.
 */
export function runBodyInput(body: unknown): RunBodyReading {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refused(NOT_AN_OBJECT);
  }
  const input: unknown = Object.hasOwn(body, "input")
    ? (body as { input?: unknown }).input
    : undefined;
  if (input === undefined) return refused(NO_INPUT);
  if (input === null) return refused(INPUT_NULL);
  return { input };
}

/** Why a run request's input was refused: it is not an object. */
export interface RunInputTypeRefusal {
  code: "INVALID_INPUT_TYPE";
  message: string;
}

/**
 * Judges the shape of the input that `runBodyInput` hands back: an input that
 * is a string, a number or a boolean is refused, its type named. An array is
 * not refused here: it goes on to the check of the agent's inputs. Nothing is
 * returned for an input this rule lets through.
 *
 * One definition, read by the run route of the API and by the server of
 * `skrun dev`, so that both refuse the same inputs in the same words.
 */
export function runInputTypeRefusal(input: unknown): RunInputTypeRefusal | undefined {
  if (input === null || typeof input !== "object") {
    return { code: "INVALID_INPUT_TYPE", message: `Input expected object, got ${typeof input}` };
  }
  return undefined;
}

/** Why a run request's input was refused: it misses an input the agent requires. */
export interface RunMissingInputRefusal {
  code: "MISSING_INPUT";
  message: string;
}

/**
 * Whether the input of a run request lacks one of the inputs the agent
 * declares. It is absent when the input does not carry it as a field of its
 * own — a name only the input's prototype carries (`toString` of an object,
 * `filter` of an array) is none of its inputs —, carries it as `undefined` or
 * `null`, or, a `file` input, carries it as an empty list. Any other value is
 * present, whatever it is: `0`, `""`, `false`, an empty list for an `array`
 * input, a list of files that holds `null`. Only presence is judged here,
 * never the type of what is there.
 *
 * One definition, read wherever an input is judged: the check of the declared
 * inputs (the run route of the API, the server of `skrun dev`),
 * `resolveInput` in the runtime, which reads each file, and the simulated
 * runs of `skrun test` (`mockRun`), which judge presence alone.
 */
export function isRunInputAbsent(field: { name: string; type: string }, input: object): boolean {
  if (!Object.hasOwn(input, field.name)) return true;
  const value: unknown = (input as Record<string, unknown>)[field.name];
  if (value === undefined || value === null) return true;
  return field.type === "file" && Array.isArray(value) && value.length === 0;
}

/**
 * The refusal of an input the agent requires that the input of a run request
 * lacks, as `isRunInputAbsent` judges it: its code and its words, whatever the
 * input's type. `runDeclaredInputsRefusal` returns it; `resolveInput`, in the
 * runtime, throws it; `skrun test` (`mockRun`) fails a test with its message.
 * One definition, so that each refuses a missing input in the same words.
 */
export function runMissingInputRefusal(name: string): RunMissingInputRefusal {
  return { code: "MISSING_INPUT", message: `Missing required input: ${name}` };
}

/**
 * Judges the input of a run request, once `runInputTypeRefusal` let it
 * through, against the inputs the agent declares, one after the other in
 * their order. For each input, its absence first, as `isRunInputAbsent`
 * judges it — no field of the input's own, `null`, or an empty list for a
 * `file` input: a required one absent is refused (`MISSING_INPUT`,
 * `runMissingInputRefusal`, by its name), an optional one absent is left, its
 * type not judged. Then, an input present other than a `file` one, its type:
 * one of another type than the declared one is refused (`INVALID_INPUT_TYPE`,
 * the type received named) — an input declared `object` takes any value
 * present. The first refusal is returned, nothing when every input passes. A
 * `file` input is judged here for its absence only: what it holds is judged
 * where it is read.
 *
 * One definition, read by the run route of the API and by the server of
 * `skrun dev`, so that both refuse the same inputs, in the same order and the
 * same words.
 */
export function runDeclaredInputsRefusal(
  fields: ReadonlyArray<{ name: string; type: string; required: boolean }>,
  input: object,
): RunMissingInputRefusal | RunInputTypeRefusal | undefined {
  for (const field of fields) {
    if (isRunInputAbsent(field, input)) {
      if (field.required) return runMissingInputRefusal(field.name);
      continue;
    }
    if (field.type === "file" || field.type === "object") continue;
    const value = (input as Record<string, unknown>)[field.name];
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== field.type) {
      return {
        code: "INVALID_INPUT_TYPE",
        message: `Input "${field.name}" expected ${field.type}, got ${actualType}`,
      };
    }
  }
  return undefined;
}
