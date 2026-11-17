import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic.js";

// The Messages API version decides which request parameters a Claude model
// takes. On the version the SDK sends today, `temperature` is refused only by
// some models, the ones the capability matrix marks `temperature: false`.
// Anthropic's API version 2026-10-21 refuses `temperature`, `top_p` and
// `top_k` on every model, with a 400. The SDK picks the version, not this
// runtime: a new SDK can move it without a line of ours changing.
const API_VERSION_THE_MATRIX_WAS_READ_AGAINST = "2023-06-01";

const WHAT_TO_DO =
  "The Anthropic SDK now sends another `anthropic-version`. Anthropic's API version 2026-10-21 " +
  "refuses temperature, top_p and top_k on every model: before moving this pin, review every " +
  "Claude row marked `temperature: true` in the capability matrix (packages/schema/src/capability.ts) " +
  "against the version now sent, or the runtime will send a temperature the API refuses.";

function aMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_api_version_probe",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("AnthropicProvider — the Messages API version it sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the API version the capability matrix's temperature flags were read against", async () => {
    // The real SDK builds the request; only the network is replaced. The SDK
    // takes the global fetch when the client is built.
    const sent: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : {})));
        return aMessage();
      }),
    );

    const provider = new AnthropicProvider("test-key");
    await provider.call({
      model: "claude-sonnet-4-6",
      systemPrompt: "system",
      userContent: [{ kind: "text", text: "hello" }],
      userMessage: "hello",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("anthropic-version"), WHAT_TO_DO).toBe(
      API_VERSION_THE_MATRIX_WAS_READ_AGAINST,
    );
  });
});
