import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing under the cloud adapter reaches the network but two modules:
 *
 * - `runner-call.ts`, the one module that talks to a runner. A runner's machine
 *   also runs the agent's code, so whatever answers there is untrusted: that
 *   module refuses every redirect and reads every answer within its bounds.
 * - `fly-api.ts`, the platform's client: its destination is the platform's
 *   API, a fixed address, never a machine.
 *
 * A call made anywhere else here would read a runner's answer with neither the
 * refusal nor the bounds. This test reads the sources to keep it so.
 */

interface NetworkCall {
  line: number;
  text: string;
  what: string;
}

/** The ways a source reaches the network directly. */
const DIRECT_CALLS: Array<{ what: string; pattern: RegExp }> = [
  // `fetch(`, `globalThis.fetch(` — never `safeFetch(`, `prefetch(`, or `fetch` passed along.
  { what: "a fetch called", pattern: /(?<![\w$])fetch\s*\(/ },
  // `fetchImpl(`, `this.opts.fetchImpl(`, `fetchImpl?.(` — never `callRunner(fetchImpl, …)`.
  { what: "an injected fetch called", pattern: /(?<![\w$])fetchImpl\s*(?:\?\.)?\s*\(/ },
  { what: "an injected fetch called", pattern: /(?<![\w$])fetchImpl\s*\.\s*(?:call|apply)\s*\(/ },
  {
    what: "a network client imported",
    pattern:
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:undici|(?:node:)?(?:https?|http2|net|tls|dgram))["']/,
  },
];

/**
 * Every line of `source` that reaches the network directly. Comments are
 * skipped — they describe calls, they make none — and so is an import of types
 * only, which loads nothing.
 */
function findNetworkCalls(source: string): NetworkCall[] {
  const found: NetworkCall[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
    if (/^import\s+type\b/.test(text)) return;
    for (const { what, pattern } of DIRECT_CALLS) {
      if (pattern.test(raw)) {
        found.push({ line: index + 1, text, what });
        break;
      }
    }
  });
  return found;
}

/** The two modules allowed to reach the network, and why. */
const EXEMPT: Record<string, string> = {
  "runner-call.ts":
    "the one module that talks to a runner: it refuses redirects and bounds every answer",
  "fly-api.ts": "the platform's client: its destination is the platform's API, never a machine",
};

/**
 * Calls not yet moved onto the runner module, listed by their text: none is
 * left. The list cannot grow unseen — a call outside the two modules above fails
 * the test, and only an entry here would let it pass — and an entry that
 * matches nothing fails it too.
 */
const NOT_YET_MOVED: Array<{ file: string; text: string }> = [];

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The cloud adapter's sources, tests left out. */
function adapterSources(): Array<{ file: string; source: string }> {
  return readdirSync(HERE)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort()
    .map((file) => ({ file, source: readFileSync(`${HERE}${file}`, "utf8") }));
}

describe("the network calls under the cloud adapter", () => {
  it("finds each way a source reaches the network directly, by its line", () => {
    const source = [
      "const a = await fetch(url);",
      "const b = await globalThis.fetch(url, init);",
      'const c = await fetchImpl(baseUrl + "/outputs/file", { signal });',
      "const d = await this.opts.fetchImpl(url);",
      "const e = await fetchImpl?.(url);",
      "const f = await fetchImpl.call(undefined, url);",
      'import { request } from "node:http";',
      'import https from "https";',
      'const { connect } = await import("node:net");',
      'import { fetch as undiciFetch } from "undici";',
    ].join("\n");

    expect(findNetworkCalls(source).map((call) => call.line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("takes neither a fetch passed along, nor its type, nor a comment, for a call", () => {
    const source = [
      "const response = await callRunner(fetchImpl, url, init, { headersTimeoutMs });",
      "const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);",
      "fetchImpl?: typeof fetch;",
      "// a comment that says fetch(url) or fetchImpl(url)",
      " * fetchImpl(url), described in a doc comment",
      "/* fetch(url) */",
      "const guarded = await safeFetch(url);",
      "prefetch(url);",
      'import type { Server } from "node:http";',
    ].join("\n");

    expect(findNetworkCalls(source)).toEqual([]);
  });

  it("reaches the network only through the runner module and the platform's client", () => {
    const outside = adapterSources()
      .filter(({ file }) => !(file in EXEMPT))
      .flatMap(({ file, source }) =>
        findNetworkCalls(source).map((call) => ({ file, line: call.line, text: call.text })),
      );

    // Named by file and line, so a failure says where the call is.
    const unlisted = outside.filter(
      (call) => !NOT_YET_MOVED.some((m) => m.file === call.file && m.text === call.text),
    );
    expect(unlisted.map((call) => `${call.file}:${call.line} ${call.text}`)).toEqual([]);
    expect(outside.map(({ file, text }) => ({ file, text }))).toEqual(NOT_YET_MOVED);
  });

  it("exempts only modules that do reach the network: an exemption that covers nothing is stale", () => {
    const sources = new Map(adapterSources().map(({ file, source }) => [file, source]));

    for (const file of Object.keys(EXEMPT)) {
      const source = sources.get(file);
      expect(source, `${file} exists`).toBeDefined();
      expect(findNetworkCalls(source ?? "").length, `${file} reaches the network`).toBeGreaterThan(
        0,
      );
    }
  });
});
