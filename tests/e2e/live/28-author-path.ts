/**
 * Phase 28 — the author's path, end to end, through the real CLI.
 *
 * What an agent author sees at each step, against the local registry:
 *
 *   (1) `skrun build` of an agent that still carries `environment.sandbox` and
 *       `environment.filesystem` prints a RETIRED_FIELD warning that names
 *       each field, and builds.
 *   (2) `skrun push` ends on the note that matches the server's verification
 *       policy (read from GET /api/me): under `admin`, with the dev-token (an
 *       admin), the note says the step is the author's to take.
 *   (3) `skrun run --llm-key-env google=GOOGLE_API_KEY -f <input>` reads the
 *       run's event stream and prints the blocking result's JSON, completed.
 *   (4) An agent that declares its own `model.base_url`, run with no caller
 *       key, is refused before it starts: 400 LLM_KEY_REQUIRED from the API,
 *       and the same code from `skrun run`. The server never sends its own key
 *       to an endpoint the agent chose (unless the operator allows it with
 *       SKRUN_ALLOW_SERVER_KEY_CUSTOM_BASE_URL=true, which this suite does not).
 *   (5) An agent whose forced tool writes a file, run through the event
 *       stream with the author's key: `run_complete.files` names the file with
 *       its download `url`, and that URL serves it.
 *   (6) The same stream's `cost.saved` is the saving the run's record holds
 *       (GET /api/runs/:id): present when it is positive, absent when it is 0.
 *   (7) An `environment` override that carries the retired `sandbox` field is
 *       refused with 400 RETIRED_FIELD, before the run starts.
 *   (8) `skrun build` of an agent whose model refuses two settings it declares
 *       — a `temperature`, a forced tool choice — prints TEMPERATURE_UNSUPPORTED
 *       and TOOL_CHOICE_UNSUPPORTED, each naming the model, and builds. No push,
 *       no model call: the warnings come from the capability matrix.
 *   (9) `skrun build` of an agent whose `state.ttl` is outside 1 to 365 days
 *       fails, on an error that names `state.ttl` and the bounds. The CLI
 *       prints an error's message, not its code: the code,
 *       STATE_TTL_OUT_OF_RANGE, is read from the validator the build runs, on
 *       the same directory. No push.
 *  (10) `skrun build` of an agent that declares a setting no code honours, or
 *       a timeout no timer can hold, fails — four agents, one setting each: a
 *       `secrets` list that names a secret, an MCP server's `auth: api_key`,
 *       `meta` without a `model.base_url`, `timeout: 0s`. Each error names its
 *       field; its code — UNSUPPORTED_FIELD, UNSUPPORTED_FIELD,
 *       MODEL_BASE_URL_REQUIRED, TIMEOUT_OUT_OF_RANGE — is read from the
 *       validator the build runs, on the same directory. No push.
 *  (11) A bundle whose `agent.yaml` names a secret, pushed straight to the API
 *       as the SDK or `curl` sends it — packed without `skrun build`, which
 *       would refuse it —, is refused with 400 UNSUPPORTED_FIELD, and nothing
 *       is published: the agent then reads 404.
 *  (12) An `environment` override of the agent pushed in (2) is refused before
 *       the run starts, no model called: a `secrets` list that names a secret
 *       with 400 UNSUPPORTED_FIELD, a `timeout` of `0s` with 400
 *       TIMEOUT_OUT_OF_RANGE, the retired `filesystem` with 400 RETIRED_FIELD.
 *  (13) A run request that carries the agent's input at the top of its body,
 *       with no `input` field — `{"task": "ping"}` —, is refused with 400
 *       INVALID_REQUEST, its message naming `input`: the whole body is never
 *       taken for the input.
 *  (14) An agent that declares a remote MCP server on a closed port of this
 *       machine, its URL carrying user-info, a path and a query, run with the
 *       author's key: the server cannot be connected to, and the run is
 *       answered 502 MCP_CONNECT_FAILED before it starts, its message and its
 *       `details.location` naming the server by its origin only —
 *       `https://127.0.0.1:<port>`, never the credentials, the path or the
 *       query. No model is called: the connection fails first.
 *
 * (3) and (5) call a model. The refusal of a synchronous request on the
 * `flyio` runtime, SYNC_MODE_UNSUPPORTED, is not met here: this suite's
 * registry runs the `local` runtime, which serves one. Self-bootstrapping:
 * pushes its own fixtures, and DELETEs them before and after.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pushFixture, REGISTRY, results, skrun, TOKEN, verifyLatestVersion } from "./_ctx.js";

const NS = "dev";
const AGENT = "author-path-live";
const BASE_URL_AGENT = "author-path-base-url-live";
const FILES_AGENT = "author-path-files-live";
const SETTINGS_AGENT = "author-path-settings-live";
const TTL_AGENT = "author-path-state-ttl-live";
/** The agents of (10), each refused by `skrun build` for one setting. Never pushed. */
const REFUSED_SECRETS_AGENT = "author-path-refused-secrets-live";
const REFUSED_AUTH_AGENT = "author-path-refused-auth-live";
const REFUSED_META_AGENT = "author-path-refused-meta-live";
const REFUSED_TIMEOUT_AGENT = "author-path-refused-timeout-live";
/** The agent of (11), pushed straight to the API — refused, so never published. */
const RAW_PUSH_AGENT = "author-path-raw-push-live";
/** The agent of (14), whose MCP server cannot be connected to. */
const MCP_AGENT = "author-path-mcp-live";
/** How many times (11) waits out the push route's rate limit, as `pushFixture` does. */
const PUSH_RATE_LIMIT_WAITS = 3;
/** A model the capability matrix marks as refusing both a temperature and a forced tool choice. */
const REFUSING_MODEL = { provider: "anthropic", name: "claude-sonnet-5-5" };
const VERSION = "9.28.1";
/** An OpenAI-compatible endpoint the agent declares — the server's key never goes there. */
const DECLARED_BASE_URL = "https://api.deepseek.com/v1";

/** The forced tool of FILES_AGENT: it writes `note.txt` to the run's output directory. */
const WRITE_NOTE_SCRIPT = `// Write the note to the run's output directory.
// Input (stdin JSON): { text }
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
});
process.stdin.on("end", () => {
  const args = JSON.parse(buf || "{}") as { text?: unknown };
  const dir = process.env.SKRUN_OUTPUT_DIR;
  if (!dir) throw new Error("SKRUN_OUTPUT_DIR is not set");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "note.txt"), String(args.text ?? "ok"), "utf-8");
  process.stdout.write(JSON.stringify({ written: "note.txt" }));
});
`;

/** The `event:` / `data:` blocks of an event stream, the data parsed. */
function parseStream(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6).trim();
    }
    if (!event || !data) continue;
    try {
      events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      // A block that is not JSON is not an event this phase reads.
    }
  }
  return events;
}

/**
 * The run's record, once its final status is written. A streamed run's
 * `run_complete` waits for that write, but for 10 s at most: past that it goes
 * first, so the record is read again for a while rather than trusting the order.
 */
async function completedRunRecord(runId: string): Promise<Record<string, unknown>> {
  let record: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${REGISTRY}/api/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    record = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (record.status === "completed" || record.status === "failed") return record;
    await new Promise((r) => setTimeout(r, 250));
  }
  return record;
}

function record(feature: string, passed: boolean, detail: string): void {
  results.push({ agent: "author-path", feature, passed, duration: 0, cost: 0, detail });
}

async function deleteAgent(name: string): Promise<void> {
  await fetch(`${REGISTRY}/api/agents/${NS}/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

/** A throwaway agent directory: its SKILL.md, and an agent.yaml with `model` and `extra` lines. */
function writeAgent(name: string, model: string[], extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), `skrun-live-28-${name}-`));
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: Live fixture of the author's path - build, push, run with a caller key, and the refusal of a run with no model key.
---

# ${name}

Reply with a JSON object whose "result" field is the literal string "ok".
`,
  );
  writeFileSync(
    join(dir, "agent.yaml"),
    [
      `name: ${name}`,
      `version: ${VERSION}`,
      "model:",
      ...model,
      "inputs:",
      "  - name: task",
      "    type: string",
      "    required: true",
      "outputs:",
      "  - name: result",
      "    type: string",
      ...extra,
      "",
    ].join("\n"),
  );
  return dir;
}

/** What a failed CLI call printed on stderr and stdout, without colour codes. */
function failedOutput(err: unknown): string {
  const { stdout, stderr } = err as { stdout?: unknown; stderr?: unknown };
  return [stderr, stdout]
    .filter((s): s is string => typeof s === "string")
    .map((s) => stripVTControlCharacters(s))
    .join("\n");
}

/** The first printed line that `matches`, or the start of the output: a result's detail. */
function excerpt(printed: string, matches: (line: string) => boolean): string {
  const line = printed.split("\n").find(matches);
  return (line ?? printed).trim().slice(0, 200);
}

/**
 * A bundle pushed straight to the API, as the SDK or `curl` sends it — no
 * `skrun build` before. The push route is rate-limited per address: a 429 is
 * waited out, for its `Retry-After`, as `pushFixture` does.
 */
async function pushRaw(name: string, bundle: Buffer): Promise<Response> {
  for (let waits = 0; ; waits++) {
    const res = await fetch(`${REGISTRY}/api/agents/${NS}/${name}/push?version=${VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bundle),
    });
    if (res.status !== 429 || waits === PUSH_RATE_LIMIT_WAITS) return res;
    const seconds = (Number(res.headers.get("retry-after")) || 60) + 5;
    console.log(
      `  push rate-limited (429) for ${name}: waiting ${seconds}s (${waits + 1}/${PUSH_RATE_LIMIT_WAITS})`,
    );
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

/** A port of this machine nothing listens on: taken from the system, then given back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The keys of the blocking result, which `skrun run` prints from the stream. */
const RESULT_KEYS = ["run_id", "status", "agent_version", "output", "usage", "cost", "duration_ms"];

/** The policy the server reports, as the CLI reads it after a push. */
async function verificationPolicy(): Promise<string> {
  const res = await fetch(`${REGISTRY}/api/me`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const me = (await res.json().catch(() => ({}))) as { verification_policy?: string };
  return me.verification_policy ?? "unknown";
}

/** The sentence of the post-push note each policy prints (for an admin caller). */
const NOTE_BY_POLICY: Record<string, string> = {
  admin: "you are an admin on this server.",
  owner: "can be called now. Verifying it is optional on this server",
  disabled: "can be called now. This server does not gate runs on verification.",
};

export async function run(): Promise<void> {
  await deleteAgent(AGENT);
  await deleteAgent(BASE_URL_AGENT);
  await deleteAgent(FILES_AGENT);
  await deleteAgent(RAW_PUSH_AGENT);
  await deleteAgent(MCP_AGENT);
  const dirs: string[] = [];
  try {
    const dir = writeAgent(
      AGENT,
      ["  provider: google", "  name: gemini-3.8-flash"],
      ["environment:", "  sandbox: strict", "  filesystem: read-write"],
    );
    dirs.push(dir);

    // ── (1) build: each retired field is named, the bundle is built ──────
    {
      let printed = "";
      let built = false;
      try {
        printed = stripVTControlCharacters(skrun(["build"], dir));
        built = printed.includes(`Built ${AGENT}-${VERSION}.agent`);
      } catch (err) {
        printed = failedOutput(err);
      }
      const warns = (field: string): boolean =>
        printed.split("\n").some((l) => l.includes("RETIRED_FIELD") && l.includes(field));
      const sandbox = warns("environment.sandbox");
      const filesystem = warns("environment.filesystem");
      record(
        "skrun build names each retired agent.yaml field in a warning — sandbox and filesystem —, and still builds",
        sandbox && filesystem && built,
        `sandbox=${sandbox} filesystem=${filesystem} built=${built} | ${excerpt(printed, (l) => l.includes("environment.filesystem"))}`,
      );
    }

    // ── (2) push: the note follows the server's verification policy ─────
    {
      const policy = await verificationPolicy();
      const expected = NOTE_BY_POLICY[policy];
      let printed = "";
      try {
        printed = await pushFixture(dir, { acceptExisting: false });
      } catch (err) {
        printed = err instanceof Error ? err.message : String(err);
      }
      const noted = expected !== undefined && printed.includes(expected);
      const note = excerpt(printed, (l) => l.includes("verif") || l.includes("called"));
      record(
        "skrun push ends on the note of the server's verification policy",
        noted,
        `policy=${policy} expected="${expected ?? "?"}" | ${note}`,
      );
    }

    // ── (3) run with the author's own key, through the stream ────────────
    {
      await verifyLatestVersion(NS, AGENT);
      const inputFile = join(dir, "input.json");
      writeFileSync(inputFile, JSON.stringify({ task: "ping" }));
      if (!process.env.GOOGLE_API_KEY) {
        record(
          "skrun run --llm-key-env sends the author's key and prints the completed result",
          false,
          "GOOGLE_API_KEY is not set in the suite's environment: the option has no variable to read",
        );
      } else {
        let result: Record<string, unknown> = {};
        let detail = "";
        try {
          const printed = skrun(
            ["run", `${NS}/${AGENT}`, "--llm-key-env", "google=GOOGLE_API_KEY", "-f", inputFile],
            dir,
          );
          result = JSON.parse(printed) as Record<string, unknown>;
        } catch (err) {
          detail = failedOutput(err).trim().slice(0, 300);
        }
        const missing = RESULT_KEYS.filter((k) => !(k in result));
        const completed = result.status === "completed";
        record(
          "skrun run --llm-key-env sends the author's key and prints the completed result",
          completed && missing.length === 0,
          detail ||
            `status=${String(result.status)} version=${String(result.agent_version)} missing=[${missing.join(", ")}] output keys=[${Object.keys((result.output as object) ?? {}).join(", ")}]`,
        );
      }
    }

    // ── (4) no model key for the agent's own endpoint: refused before it starts ──
    {
      const baseDir = writeAgent(BASE_URL_AGENT, [
        "  provider: openai",
        "  name: deepseek-chat",
        `  base_url: ${DECLARED_BASE_URL}`,
      ]);
      dirs.push(baseDir);
      skrun(["build"], baseDir);
      await pushFixture(baseDir, { acceptExisting: false });
      // Past the verification gate, which comes first under the `admin` policy.
      await verifyLatestVersion(NS, BASE_URL_AGENT);

      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${BASE_URL_AGENT}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: { task: "ping" } }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      const code = body.error?.code ?? "-";
      record(
        "POST /run with no model key for the agent's own endpoint is refused before it starts",
        res.status === 400 && code === "LLM_KEY_REQUIRED",
        `status=${res.status} code=${code}`,
      );

      let printed = "";
      let exited = false;
      try {
        printed = skrun(["run", `${NS}/${BASE_URL_AGENT}`, "-i", '{"task":"ping"}'], baseDir);
      } catch (err) {
        exited = true;
        printed = failedOutput(err);
      }
      const named = printed.includes("LLM_KEY_REQUIRED");
      record(
        "skrun run with no model key prints LLM_KEY_REQUIRED and fails",
        exited && named,
        `failed=${exited} | ${excerpt(printed, (l) => l.includes("LLM_KEY_REQUIRED"))}`,
      );
    }

    // ── (5)-(6) the stream's run_complete: files with their url, and the saving ──
    {
      const filesDir = writeAgent(
        FILES_AGENT,
        ["  provider: google", "  name: gemini-3.8-flash"],
        [
          "tool_choice: write_note",
          "tools:",
          "  - name: write_note",
          "    description: Write a short text note to the run's output directory, as note.txt.",
          "    input_schema:",
          "      type: object",
          "      properties:",
          "        text:",
          "          type: string",
          "          description: The text of the note.",
          "      required: [text]",
          "      additionalProperties: false",
        ],
      );
      dirs.push(filesDir);
      mkdirSync(join(filesDir, "scripts"));
      writeFileSync(join(filesDir, "scripts", "write_note.ts"), WRITE_NOTE_SCRIPT);
      skrun(["build"], filesDir);
      await pushFixture(filesDir, { acceptExisting: false });
      await verifyLatestVersion(NS, FILES_AGENT);

      const key = process.env.GOOGLE_API_KEY;
      if (!key) {
        const why = "GOOGLE_API_KEY is not set in the suite's environment: no model to call";
        record("the stream's run_complete lists each file with a url that serves it", false, why);
        record("the stream's cost.saved is the saving the run's record holds", false, why);
      } else {
        const res = await fetch(`${REGISTRY}/api/agents/${NS}/${FILES_AGENT}/run`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-LLM-API-Key": JSON.stringify({ google: key }),
          },
          body: JSON.stringify({ input: { task: "Write the note 'ok' with your tool." } }),
        });
        const events = parseStream(await res.text());
        const complete = events.find((e) => e.event === "run_complete")?.data;
        const failure = events.find((e) => e.event === "run_error")?.data;

        // (5) each file named with its download url, and the url serves it
        const files = (complete?.files as Array<Record<string, unknown>> | undefined) ?? [];
        const served: string[] = [];
        for (const file of files) {
          if (typeof file.url !== "string") continue;
          const url = file.url.startsWith("/") ? `${REGISTRY}${file.url}` : file.url;
          const download = await fetch(url, {
            headers: file.url.startsWith("/") ? { Authorization: `Bearer ${TOKEN}` } : {},
          });
          if (download.ok && (await download.text()).length > 0) served.push(String(file.name));
        }
        const everyUrl = files.length > 0 && files.every((f) => typeof f.url === "string");
        record(
          "the stream's run_complete lists each file with a url that serves it",
          everyUrl && served.length === files.length,
          complete
            ? `files=[${files.map((f) => String(f.name)).join(", ")}] with url=${everyUrl} served=[${served.join(", ")}]`
            : `no run_complete: status=${res.status} ${JSON.stringify(failure ?? {}).slice(0, 200)}`,
        );

        // (6) cost.saved, as the run's record holds it
        const runId = String(complete?.run_id ?? "");
        const saved = (complete?.cost as { saved?: number } | undefined)?.saved;
        const runRecord = runId ? await completedRunRecord(runId) : {};
        const recorded = Number(runRecord.usage_cache_savings_usd ?? Number.NaN);
        const agrees =
          Number.isFinite(recorded) &&
          (recorded > 0
            ? saved !== undefined && Math.abs(saved - recorded) < 1e-9
            : saved === undefined);
        record(
          "the stream's cost.saved is the saving the run's record holds",
          agrees,
          `stream saved=${saved ?? "absent"} record usage_cache_savings_usd=${Number.isFinite(recorded) ? recorded : "?"}`,
        );
      }
    }

    // ── (7) an override carrying a retired field: refused before the run ──
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: { task: "ping" }, environment: { sandbox: "strict" } }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      const code = body.error?.code ?? "-";
      record(
        "an environment override carrying sandbox is refused with 400 RETIRED_FIELD",
        res.status === 400 && code === "RETIRED_FIELD",
        `status=${res.status} code=${code} | ${(body.error?.message ?? "").slice(0, 120)}`,
      );
    }

    // ── (8) build: the settings the model refuses are named, the bundle is built ──
    {
      const settingsDir = writeAgent(
        SETTINGS_AGENT,
        [
          `  provider: ${REFUSING_MODEL.provider}`,
          `  name: ${REFUSING_MODEL.name}`,
          "  temperature: 0.3",
        ],
        [
          "tool_choice: write_note",
          "tools:",
          "  - name: write_note",
          "    description: Write a short text note.",
          "    input_schema:",
          "      type: object",
          "      properties:",
          "        text:",
          "          type: string",
          "      required: [text]",
        ],
      );
      dirs.push(settingsDir);
      let printed = "";
      let built = false;
      try {
        printed = stripVTControlCharacters(skrun(["build"], settingsDir));
        built = printed.includes(`Built ${SETTINGS_AGENT}-${VERSION}.agent`);
      } catch (err) {
        printed = failedOutput(err);
      }
      const model = `${REFUSING_MODEL.provider}/${REFUSING_MODEL.name}`;
      const temperature =
        printed.includes("TEMPERATURE_UNSUPPORTED") &&
        printed.includes(`model ${model} does not accept a temperature`);
      record(
        "skrun build names a temperature the model refuses in a warning, and still builds",
        temperature && built,
        `warning=${temperature} built=${built} | ${excerpt(printed, (l) => l.includes("TEMPERATURE_UNSUPPORTED"))}`,
      );
      const toolChoice =
        printed.includes("TOOL_CHOICE_UNSUPPORTED") &&
        printed.includes(`model ${model} refuses a forced tool choice`);
      record(
        "skrun build names a forced tool choice the model refuses in a warning, and still builds",
        toolChoice && built,
        `warning=${toolChoice} built=${built} | ${excerpt(printed, (l) => l.includes("TOOL_CHOICE_UNSUPPORTED"))}`,
      );
    }

    // ── (9) build: a state ttl outside 1 to 365 days is refused ─────────
    {
      const ttlDir = writeAgent(
        TTL_AGENT,
        ["  provider: google", "  name: gemini-3.8-flash"],
        ["state:", "  type: kv", "  ttl: 0d"],
      );
      dirs.push(ttlDir);
      let printed = "";
      let failed = false;
      try {
        printed = stripVTControlCharacters(skrun(["build"], ttlDir));
      } catch (err) {
        failed = true;
        printed = failedOutput(err);
      }
      const named = printed.includes("state.ttl") && printed.includes("between 1 and 365 days");
      // The code the CLI does not print, from the validator `skrun build` runs.
      const { validateAgent } = await import("../../../packages/schema/dist/index.js");
      const validation = await validateAgent(ttlDir);
      const code = validation.errors.find((e) => e.field === "state.ttl")?.code ?? "-";
      record(
        "skrun build refuses a state ttl outside 1 to 365 days, naming the bounds",
        failed && named && code === "STATE_TTL_OUT_OF_RANGE",
        `failed=${failed} code=${code} | ${excerpt(printed, (l) => l.includes("state.ttl"))}`,
      );
    }

    // ── (10) build: a setting no code honours, or a timeout no timer holds, is refused ──
    {
      const google = ["  provider: google", "  name: gemini-3.8-flash"];
      const refusals = [
        {
          agent: REFUSED_SECRETS_AGENT,
          what: "a secrets list that names a secret",
          model: google,
          extra: ["environment:", "  secrets: [X]"],
          field: "environment.secrets",
          said: "environment.secrets is not yet supported",
          expected: "UNSUPPORTED_FIELD",
        },
        {
          agent: REFUSED_AUTH_AGENT,
          what: "an MCP server's auth other than none",
          model: google,
          extra: [
            "mcp_servers:",
            "  - name: search",
            "    url: https://mcp.example.com/sse",
            "    auth: api_key",
          ],
          field: "mcp_servers[0].auth",
          said: "mcp_servers[0].auth: api_key is not yet supported",
          expected: "UNSUPPORTED_FIELD",
        },
        {
          agent: REFUSED_META_AGENT,
          what: "meta without a model.base_url",
          model: ["  provider: meta", "  name: llama"],
          extra: [],
          field: "model.provider",
          said: "model.provider meta has no endpoint of its own",
          expected: "MODEL_BASE_URL_REQUIRED",
        },
        {
          agent: REFUSED_TIMEOUT_AGENT,
          what: "a timeout of 0s",
          model: google,
          extra: ["environment:", "  timeout: 0s"],
          field: "environment.timeout",
          said: 'environment.timeout "0s" is outside the allowed range',
          expected: "TIMEOUT_OUT_OF_RANGE",
        },
      ];
      // The code the CLI does not print, from the validator `skrun build` runs.
      const { validateAgent } = await import("../../../packages/schema/dist/index.js");
      for (const refusal of refusals) {
        const refusedDir = writeAgent(refusal.agent, refusal.model, refusal.extra);
        dirs.push(refusedDir);
        let printed = "";
        let failed = false;
        try {
          printed = stripVTControlCharacters(skrun(["build"], refusedDir));
        } catch (err) {
          failed = true;
          printed = failedOutput(err);
        }
        const named = printed.includes(refusal.said);
        const validation = await validateAgent(refusedDir);
        const code = validation.errors.find((e) => e.field === refusal.field)?.code ?? "-";
        record(
          `skrun build refuses ${refusal.what}, naming ${refusal.field}`,
          failed && named && code === refusal.expected,
          `failed=${failed} code=${code} | ${excerpt(printed, (l) => l.includes(refusal.field))}`,
        );
      }
    }

    // ── (11) a bundle naming a secret, pushed without skrun build: refused, nothing published ──
    {
      const rawDir = writeAgent(
        RAW_PUSH_AGENT,
        ["  provider: google", "  name: gemini-3.8-flash"],
        ["environment:", "  secrets: [X]"],
      );
      dirs.push(rawDir);
      const { packAgentTar } = await import("../../../packages/schema/dist/index.js");
      const bundle = await packAgentTar(
        ["agent.yaml", "SKILL.md"].map((name) => ({
          name,
          content: readFileSync(join(rawDir, name)),
        })),
      );
      const res = await pushRaw(RAW_PUSH_AGENT, bundle);
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      const code = body.error?.code ?? "-";
      const read = await fetch(`${REGISTRY}/api/agents/${NS}/${RAW_PUSH_AGENT}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      record(
        "a push of a bundle naming a secret, sent without skrun build, is refused with 400 UNSUPPORTED_FIELD, and nothing is published",
        res.status === 400 && code === "UNSUPPORTED_FIELD" && read.status === 404,
        `status=${res.status} code=${code} agent=${read.status} | ${(body.error?.message ?? "").slice(0, 120)}`,
      );
    }

    // ── (12) an override carrying a refused setting, or filesystem: refused before the run ──
    {
      const overrides = [
        {
          what: "a secrets list that names a secret",
          environment: { secrets: ["X"] },
          expected: "UNSUPPORTED_FIELD",
        },
        {
          what: "a timeout of 0s",
          environment: { timeout: "0s" },
          expected: "TIMEOUT_OUT_OF_RANGE",
        },
        { what: "filesystem", environment: { filesystem: "none" }, expected: "RETIRED_FIELD" },
      ];
      for (const override of overrides) {
        const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: { task: "ping" }, environment: override.environment }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const code = body.error?.code ?? "-";
        record(
          `an environment override carrying ${override.what} is refused with 400 ${override.expected}`,
          res.status === 400 && code === override.expected,
          `status=${res.status} code=${code} | ${(body.error?.message ?? "").slice(0, 120)}`,
        );
      }
    }

    // ── (13) a body with no input field: refused, never taken for the input ──
    {
      const res = await fetch(`${REGISTRY}/api/agents/${NS}/${AGENT}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ task: "ping" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      const code = body.error?.code ?? "-";
      const message = body.error?.message ?? "";
      const named = message.includes('"input"');
      record(
        "a run request whose body has no input field is refused with 400 INVALID_REQUEST, naming input",
        res.status === 400 && code === "INVALID_REQUEST" && named,
        `status=${res.status} code=${code} names_input=${named} | ${message.slice(0, 120)}`,
      );
    }

    // ── (14) an MCP server that cannot be connected to: its origin only, in the 502 ──
    {
      const port = await closedPort();
      const origin = `https://127.0.0.1:${port}`;
      const mcpDir = writeAgent(
        MCP_AGENT,
        ["  provider: google", "  name: gemini-3.8-flash"],
        [
          "environment:",
          "  networking:",
          "    allowed_hosts:",
          "      - 127.0.0.1",
          "mcp_servers:",
          "  - name: search",
          `    url: https://u:p@127.0.0.1:${port}/sse?key=abc`,
          "    transport: sse",
        ],
      );
      dirs.push(mcpDir);
      skrun(["build"], mcpDir);
      await pushFixture(mcpDir, { acceptExisting: false });
      await verifyLatestVersion(NS, MCP_AGENT);

      const feature =
        "POST /run on an agent whose MCP server cannot be connected to answers 502 MCP_CONNECT_FAILED, naming the server by its origin only";
      const key = process.env.GOOGLE_API_KEY;
      if (!key) {
        record(
          feature,
          false,
          "GOOGLE_API_KEY is not set in the suite's environment: with no model key, the run is refused before its MCP server is reached",
        );
      } else {
        const res = await fetch(`${REGISTRY}/api/agents/${NS}/${MCP_AGENT}/run`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            "X-LLM-API-Key": JSON.stringify({ google: key }),
          },
          body: JSON.stringify({ input: { task: "ping" } }),
        });
        const text = await res.text();
        let body: { error?: { code?: string; message?: string; details?: { location?: string } } } =
          {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          // Not JSON: the detail below says what came back.
        }
        const code = body.error?.code ?? "-";
        const location = body.error?.details?.location ?? "-";
        const message = body.error?.message ?? "";
        const pathHidden = ["u:p", "/sse", "key=abc"].every((part) => !text.includes(part));
        record(
          feature,
          res.status === 502 &&
            code === "MCP_CONNECT_FAILED" &&
            location === origin &&
            message.endsWith(`: ${origin}`) &&
            pathHidden,
          `status=${res.status} code=${code} origin=${location} path_hidden=${pathHidden} | ${(message || text).slice(0, 160)}`,
        );
      }
    }
  } catch (err) {
    record("the author's path phase", false, err instanceof Error ? err.message : String(err));
  } finally {
    await deleteAgent(AGENT);
    await deleteAgent(BASE_URL_AGENT);
    await deleteAgent(FILES_AGENT);
    await deleteAgent(RAW_PUSH_AGENT);
    await deleteAgent(MCP_AGENT);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}
