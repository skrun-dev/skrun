/**
 * Phase 29 — a three-step tool chain that only a remembered turn can finish.
 *
 * Calls `LLMRouter` (packages/runtime/dist) directly, without a registry, for
 * each model it is given as `provider/name`. No model or provider is written
 * here: the list comes from the caller.
 *
 * Three tools held in memory, chained by HMAC signatures under a key drawn for
 * each model's run:
 *
 *   - `step_one(label)` returns a token and a secret;
 *   - `step_two(token)` returns a value bound to the token;
 *   - `step_three(secret, value)` checks both signatures.
 *
 * The secret exists only in step_one's RESULT — never in step_two's arguments
 * (step_two refuses a secret it is handed) nor in its result. step_three can
 * only be called with the secret if the request that asks for it still carries
 * the first turn and its result: `verified` is what step_three's handler
 * established, never what the model wrote.
 *
 * `globalThis.fetch` is wrapped before each router is built — the Anthropic
 * and OpenAI SDKs take fetch when they are constructed, Google's reads it at
 * each call — so every model request is captured as it was sent, and every
 * response as it was received. The capture reads the three wire shapes the
 * runtime speaks: Anthropic Messages, Gemini generateContent, Chat Completions
 * (OpenAI, Mistral, Groq, xAI). A model declared with a `base_url` is out of
 * reach: that path sends through a guarded transport, not `globalThis.fetch`.
 *
 * Each model's line, from the tool handler and the capture alone:
 *
 *   iterations    model turns that called a tool (3 when the chain completes);
 *   verified      step_three checked the secret and the value it was given;
 *   req3_turns    assistant turns the third request carried (2: both earlier);
 *   native        every earlier turn was sent back identical to the turn the
 *                 adapter returned (`LLMRouterResponse.history`);
 *   stop          the last response's stop reason;
 *   thoughts_tokens  reasoning tokens the responses report apart, or absent;
 *   signatures    thinking signatures counted in each raw response, in each
 *                 returned turn, and in each request's earlier turns — kept,
 *                 lost or none;
 *   leak          where the secret was seen outside step_one's result.
 *
 * Nothing it prints or returns carries a header, a URL or a key; a key value
 * found in what it returns is redacted.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ConversationHistory,
  LLMRouter,
  ToolCallHandler,
} from "../../../packages/runtime/dist/index.js";

/** The providers the router serves from its environment, each from `<PROVIDER>_API_KEY`. */
export const PROVIDERS = ["anthropic", "openai", "google", "mistral", "groq", "xai"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** A model to run: the provider, then the name as `agent.yaml` writes it (it may contain `/`). */
export interface ModelSpec {
  provider: Provider;
  name: string;
}

/** The variable the router reads a provider's key from. */
export function keyVariable(provider: Provider): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

/** `provider/name,provider/name` → specs; the provider is the first segment, the name the rest. */
export function parseModelList(list: string): ModelSpec[] {
  const specs: ModelSpec[] = [];
  for (const item of list.split(",").map((s) => s.trim())) {
    if (item === "") continue;
    const slash = item.indexOf("/");
    const provider = item.slice(0, Math.max(slash, 0));
    const name = item.slice(slash + 1);
    if (slash <= 0 || name === "" || !(PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(
        `"${item}" is not provider/name with a provider among ${PROVIDERS.join(", ")}`,
      );
    }
    specs.push({ provider: provider as Provider, name });
  }
  return specs;
}

// --- The chain ------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are running a three-step check with tools.",
  "Call step_one first.",
  "Then call step_two with the token from step_one's result, and nothing else.",
  "Then call step_three with the secret from step_one's result and the value from step_two's result.",
  "Call one tool at a time, and copy every string exactly as a tool returned it.",
  "When step_three has answered, reply with the single word DONE.",
].join(" ");

const TASK = "Run the three-step check.";

type ToolCall = Parameters<ToolCallHandler>[0];
type ToolResult = Awaited<ReturnType<ToolCallHandler>>;
type ToolDefinition = NonNullable<Parameters<LLMRouter["call"]>[3]>[number];

const TOOLS: ToolDefinition[] = [
  {
    name: "step_one",
    description:
      "First step. Returns a token and a secret. Keep both: step_two needs the token, step_three the secret.",
    parameters: {
      type: "object",
      properties: { label: { type: "string", description: "Any short label for this run." } },
      required: ["label"],
    },
  },
  {
    name: "step_two",
    description:
      "Second step. Takes the token step_one returned, only the token, and returns a value.",
    parameters: {
      type: "object",
      properties: { token: { type: "string", description: "The token step_one returned." } },
      required: ["token"],
    },
  },
  {
    name: "step_three",
    description:
      "Third step. Takes the secret step_one returned and the value step_two returned, and checks them.",
    parameters: {
      type: "object",
      properties: {
        secret: { type: "string", description: "The secret step_one returned." },
        value: { type: "string", description: "The value step_two returned." },
      },
      required: ["secret", "value"],
    },
  },
];

/** What the three tools saw and decided, for one model's run. */
interface ChainState {
  token?: string;
  secret?: string;
  value?: string;
  /** step_three found both signatures valid and both strings the ones issued. */
  verified: boolean;
  /** Where the secret was seen outside step_one's result. */
  leak: "none" | "step_two" | "text";
  /** Each call as the handler received it, with what it returned. */
  calls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
}

/** The three tools, under a key drawn for this run. */
function makeChain(): { state: ChainState; onToolCall: ToolCallHandler } {
  const key = randomBytes(32);
  const state: ChainState = { verified: false, leak: "none", calls: [] };

  const mac = (kind: string, nonce: string, bound = ""): string =>
    createHmac("sha256", key).update(`${kind}|${nonce}|${bound}`).digest("hex").slice(0, 16);
  const issue = (kind: string, bound = ""): string => {
    const nonce = randomBytes(4).toString("hex");
    return `${kind}-${nonce}-${mac(kind, nonce, bound)}`;
  };
  const signed = (kind: string, text: unknown, bound = ""): boolean => {
    if (typeof text !== "string") return false;
    const match = new RegExp(`^${kind}-([0-9a-f]{8})-([0-9a-f]{16})$`).exec(text);
    if (!match) return false;
    const expected = Buffer.from(mac(kind, match[1] as string, bound));
    const given = Buffer.from(match[2] as string);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  const answer = (call: ToolCall, result: Record<string, unknown>): ToolResult => {
    const text = JSON.stringify(result);
    state.calls.push({ name: call.name, args: call.args, result: text });
    return { name: call.name, result: text, ...(call.id !== undefined && { id: call.id }) };
  };

  const onToolCall: ToolCallHandler = async (call) => {
    switch (call.name) {
      case "step_one": {
        state.token ??= issue("tok");
        state.secret ??= issue("sec");
        return answer(call, { token: state.token, secret: state.secret });
      }
      case "step_two": {
        if (state.secret !== undefined && JSON.stringify(call.args).includes(state.secret)) {
          state.leak = "step_two";
          return answer(call, { error: "step_two takes the token only" });
        }
        if (!state.token || call.args.token !== state.token || !signed("tok", call.args.token)) {
          return answer(call, { error: "not the token step_one returned" });
        }
        state.value ??= issue("val", state.token);
        return answer(call, { value: state.value });
      }
      case "step_three": {
        const { secret, value } = call.args;
        const ok =
          state.leak !== "step_two" &&
          state.secret !== undefined &&
          secret === state.secret &&
          signed("sec", secret) &&
          state.value !== undefined &&
          value === state.value &&
          signed("val", value, state.token);
        if (ok) state.verified = true;
        return answer(call, ok ? { ok: true } : { ok: false });
      }
      default:
        return answer(call, { error: `no tool named ${call.name}` });
    }
  };

  return { state, onToolCall };
}

// --- The capture ----------------------------------------------------------

/** One model request and its response, as they crossed `fetch`. The URL never leaves this module. */
interface Exchange {
  url: string;
  request: unknown;
  status: number;
  response: unknown;
  ms: number;
}

let exchanges: Exchange[] | undefined;

async function bodyText(body: unknown): Promise<string | undefined> {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return undefined;
}

function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Wraps `globalThis.fetch` for the duration of `body`; restored after, whatever happens. */
async function withCapture<T>(body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const sent =
      init?.body !== undefined && init.body !== null
        ? await bodyText(init.body)
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    const start = Date.now();
    const res = await original(input, init);
    const ms = Date.now() - start;
    let received: unknown;
    try {
      received = await res.clone().json();
    } catch {
      received = undefined;
    }
    exchanges?.push({ url, request: parsed(sent), status: res.status, response: received, ms });
    return res;
  };
  globalThis.fetch = wrapped as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

// --- Reading each wire shape ----------------------------------------------

type Shape = "messages" | "gemini" | "chat";

function shapeOf(provider: Provider): Shape {
  if (provider === "anthropic") return "messages";
  if (provider === "google") return "gemini";
  return "chat";
}

function isModelRequest(shape: Shape, url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (shape === "messages") return path.endsWith("/messages");
  if (shape === "gemini") return path.endsWith(":generateContent");
  return path.endsWith("/chat/completions");
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The assistant turns a request carries, each in the shape the adapter sends it. */
function sentTurns(shape: Shape, request: unknown): unknown[] {
  const body = obj(request);
  if (shape === "messages") {
    return list(body.messages)
      .filter((m) => obj(m).role === "assistant")
      .map((m) => obj(m).content);
  }
  if (shape === "gemini") return list(body.contents).filter((c) => obj(c).role === "model");
  return list(body.messages).filter((m) => obj(m).role === "assistant");
}

/** The assistant part of a raw response. */
function rawTurn(shape: Shape, response: unknown): unknown {
  const body = obj(response);
  if (shape === "messages") return body.content;
  if (shape === "gemini") return obj(list(body.candidates)[0]).content;
  return obj(list(body.choices)[0]).message;
}

/** The names of the tools a raw response calls. */
function toolsCalled(shape: Shape, response: unknown): string[] {
  const turn = rawTurn(shape, response);
  const names =
    shape === "messages"
      ? list(turn)
          .filter((b) => obj(b).type === "tool_use")
          .map((b) => obj(b).name)
      : shape === "gemini"
        ? list(obj(turn).parts).map((p) => obj(obj(p).functionCall).name)
        : list(obj(turn).tool_calls).map((c) => obj(obj(c).function).name);
  return names.filter((n): n is string => typeof n === "string");
}

function stopReason(shape: Shape, response: unknown): string | undefined {
  const body = obj(response);
  const reason =
    shape === "messages"
      ? body.stop_reason
      : shape === "gemini"
        ? obj(list(body.candidates)[0]).finishReason
        : obj(list(body.choices)[0]).finish_reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Reasoning tokens a response reports apart from its output, when it does. */
function thoughtsTokens(shape: Shape, response: unknown): number | undefined {
  const body = obj(response);
  const n =
    shape === "gemini"
      ? obj(body.usageMetadata).thoughtsTokenCount
      : shape === "chat"
        ? obj(obj(body.usage).completion_tokens_details).reasoning_tokens
        : undefined;
  return typeof n === "number" ? n : undefined;
}

/** Thinking signatures in a turn: Gemini `thoughtSignature`, Anthropic `signature` and redacted thinking. */
function signatures(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + signatures(v), 0);
  if (value === null || typeof value !== "object") return 0;
  let n = (value as Json).type === "redacted_thinking" ? 1 : 0;
  for (const [k, v] of Object.entries(value as Json)) {
    if ((k === "thoughtSignature" || k === "signature") && typeof v === "string") n++;
    else n += signatures(v);
  }
  return n;
}

/** JSON with keys sorted, so two objects compare whatever order their keys came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Json)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// --- One model ------------------------------------------------------------

/** What one model's run established, from the tools and the capture only. */
export interface ToolLoopOutcome {
  provider: Provider;
  name: string;
  status: "done" | "not-done" | "error";
  /** Why a model was not run, or the error a run ended on: its class and status, never its message. */
  reason?: string;
  passed: boolean;
  iterations: number;
  requests: number;
  verified: boolean;
  req3Turns?: number;
  /** `unread` when a request body could not be read off the wire. */
  native: "equal" | "different" | "unread";
  stop?: string;
  thoughtsTokens?: number;
  signatures: {
    state: "kept" | "lost" | "none";
    raw: number[];
    returned: number[];
    sent: number[];
  };
  leak: ChainState["leak"];
  slowestRequestMs: number;
  estimatedCost: number;
  durationMs: number;
  /** The capture, for a file: request and response bodies, returned turns, tool calls. No URL, no header. */
  record: Json;
}

export interface ToolLoopOptions {
  /** Spend ceiling per model, in USD (the router stops the loop past it). */
  maxCost?: number;
}

const DEFAULT_MAX_COST = 0.25;

/** Every value of a `*_API_KEY` variable, replaced wherever it appears. */
export function redactKeys(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith("_API_KEY") || !value || value.length < 8) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

function notDone(spec: ModelSpec, reason: string): ToolLoopOutcome {
  return {
    ...spec,
    status: "not-done",
    reason,
    passed: false,
    iterations: 0,
    requests: 0,
    verified: false,
    native: "different",
    signatures: { state: "none", raw: [], returned: [], sent: [] },
    leak: "none",
    slowestRequestMs: 0,
    estimatedCost: 0,
    durationMs: 0,
    record: {},
  };
}

async function runOne(spec: ModelSpec, options: ToolLoopOptions): Promise<ToolLoopOutcome> {
  const keyName = keyVariable(spec.provider);
  if (!process.env[keyName]) return notDone(spec, `no ${keyName} in the environment`);

  const runtime = await import("../../../packages/runtime/dist/index.js");
  const shape = shapeOf(spec.provider);
  const chain = makeChain();
  const captured: Exchange[] = [];
  const start = Date.now();
  let history: ConversationHistory | undefined;
  let estimatedCost = 0;
  let reason: string | undefined;

  exchanges = captured;
  try {
    await withCapture(async () => {
      // Built inside the capture: an SDK constructed here takes the wrapped fetch.
      const router = new runtime.LLMRouter();
      try {
        const result = await router.call(
          { provider: spec.provider, name: spec.name },
          SYSTEM_PROMPT,
          TASK,
          TOOLS,
          chain.onToolCall,
          undefined,
          undefined,
          { mode: "specific", tool: "step_one" },
          false,
          undefined,
          undefined,
          { maxCost: options.maxCost ?? DEFAULT_MAX_COST },
        );
        history = result.history;
        estimatedCost = result.estimatedCost;
        if (result.costExceeded) reason = "the loop passed its spend ceiling and stopped";
      } catch (err) {
        const f = runtime.errorFields(err);
        reason = [
          f.error_name,
          f.error_code && `code ${f.error_code}`,
          f.error_status && `status ${f.error_status}`,
        ]
          .filter(Boolean)
          .join(", ");
      }
    });
  } finally {
    exchanges = undefined;
  }

  const model = captured.filter((e) => isModelRequest(shape, e.url));
  const sent = model.map((e) => sentTurns(shape, e.request));
  const raw = model.map((e) => rawTurn(shape, e.response));
  const returned = (history?.entries ?? []).flatMap((e) =>
    e.kind === "assistant" ? [e.turn.content] : [],
  );

  // Request k (from 0) must carry the k turns before it, each as returned.
  const native = model.some((e) => e.request === undefined)
    ? "unread"
    : sent.every(
          (turns, k) =>
            turns.length === k &&
            turns.every((t, i) => i < returned.length && canonical(t) === canonical(returned[i])),
        )
      ? "equal"
      : "different";

  const sig = {
    raw: raw.map(signatures),
    returned: returned.map(signatures),
    sent: sent.map((turns) => signatures(turns)),
  };
  const anySignature = [...sig.raw, ...sig.returned, ...sig.sent].some((n) => n > 0);
  const kept =
    sig.returned.every((n, i) => n === sig.raw[i]) &&
    sig.sent.every((n, k) => n === sig.returned.slice(0, k).reduce((a, b) => a + b, 0));
  const signatureState = !anySignature ? "none" : kept ? "kept" : "lost";

  // The secret seen in a turn the model wrote before the one that called step_three.
  let leak = chain.state.leak;
  const secret = chain.state.secret;
  if (leak === "none" && secret !== undefined) {
    const check = model.findIndex((e) => toolsCalled(shape, e.response).includes("step_three"));
    const before = raw.slice(0, check < 0 ? raw.length : check);
    if (before.some((t) => canonical(t).includes(secret))) leak = "text";
  }

  const thoughts = model
    .map((e) => thoughtsTokens(shape, e.response))
    .filter((n) => n !== undefined);
  const iterations = model.filter((e) => toolsCalled(shape, e.response).length > 0).length;
  const req3Turns = sent.length >= 3 ? sent[2]?.length : undefined;
  const status = reason === undefined ? "done" : "error";

  return {
    ...spec,
    status,
    ...(reason !== undefined && { reason }),
    passed:
      status === "done" &&
      chain.state.verified &&
      req3Turns === 2 &&
      native === "equal" &&
      iterations >= 3 &&
      signatureState !== "lost",
    iterations,
    requests: model.length,
    verified: chain.state.verified,
    ...(req3Turns !== undefined && { req3Turns }),
    native,
    ...(model.length > 0 && { stop: stopReason(shape, model[model.length - 1]?.response) }),
    ...(thoughts.length > 0 && { thoughtsTokens: thoughts.reduce((a, b) => a + (b ?? 0), 0) }),
    signatures: { state: signatureState, ...sig },
    leak,
    slowestRequestMs: Math.max(0, ...model.map((e) => e.ms)),
    estimatedCost,
    durationMs: Date.now() - start,
    record: {
      model: `${spec.provider}/${spec.name}`,
      requests: model.map((e, i) => ({ index: i + 1, ms: e.ms, body: e.request })),
      responses: model.map((e, i) => ({ index: i + 1, status: e.status, body: e.response })),
      returnedTurns: returned,
      toolCalls: chain.state.calls,
    },
  };
}

/**
 * Runs the chain on each model, one after the other. A model whose key is not
 * in the environment is not run, and says so.
 */
export async function runToolLoop(
  models: readonly ModelSpec[],
  options: ToolLoopOptions = {},
): Promise<ToolLoopOutcome[]> {
  const outcomes: ToolLoopOutcome[] = [];
  for (const spec of models) outcomes.push(await runOne(spec, options));
  return outcomes;
}

/** One line per model, everything on it from the tools and the capture. */
export function outcomeLine(o: ToolLoopOutcome): string {
  const id = `${o.provider}/${o.name}`;
  if (o.status === "not-done") return redactKeys(`${id} not done: ${o.reason}`);
  const fields = [
    `iterations=${o.iterations}`,
    `verified=${o.verified ? "yes" : "no"}`,
    `req3_turns=${o.req3Turns ?? "absent"}`,
    `native=${o.native}`,
    `stop=${o.stop ?? "absent"}`,
    `thoughts_tokens=${o.thoughtsTokens ?? "absent"}`,
    `signatures=${o.signatures.state} (raw ${o.signatures.raw.join(",") || "-"} · returned ${o.signatures.returned.join(",") || "-"} · sent ${o.signatures.sent.join(",") || "-"})`,
    `leak=${o.leak}`,
    `requests=${o.requests}`,
    `slowest_request_ms=${o.slowestRequestMs}`,
    `cost=$${o.estimatedCost.toFixed(4)}`,
  ];
  const error = o.status === "error" ? ` error=${o.reason}` : "";
  return redactKeys(`${id} ${fields.join(" ")}${error}`);
}

/**
 * The phase as the live suite runs it: one result per model — its line, or,
 * for a model whose key is not set, a skip that says so and fails nothing (the
 * suite's way: a SKIP result counts as passed).
 */
export async function run(models: readonly ModelSpec[]): Promise<void> {
  const { results } = await import("./_ctx.js");
  for (const o of await runToolLoop(models)) {
    if (o.status === "not-done") {
      console.log(`Skipping the tool chain on ${o.provider}/${o.name}: ${o.reason}`);
      results.push({
        agent: `tool-loop ${o.provider}/${o.name}`,
        feature: "a three-step tool chain only a remembered turn can finish",
        passed: true,
        duration: 0,
        cost: 0,
        detail: redactKeys(`skipped, no key — ${o.reason}; not run`),
      });
      continue;
    }
    results.push({
      agent: `tool-loop ${o.provider}/${o.name}`,
      feature: "a three-step tool chain only a remembered turn can finish",
      passed: o.passed,
      duration: o.durationMs,
      cost: o.estimatedCost,
      detail: outcomeLine(o),
    });
  }
}
