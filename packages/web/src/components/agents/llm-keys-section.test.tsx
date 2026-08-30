// VT-25 — the dashboard LLM-keys section renders attached keys as provider +
// last4 only (never the key), attaches a key by sending it in the PUT body, and
// toggles the caller-key policy via the policy PUT.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test-utils";
import { LlmKeysSection } from "./llm-keys-section";

const server = setupServer(
  http.get("/api/me", () =>
    HttpResponse.json({
      id: "u",
      username: "alice",
      namespace: "alice",
      email: null,
      avatar_url: null,
      plan: "free",
      role: "user",
    }),
  ),
  http.get("/api/agents/:ns/:name/llm-keys", () =>
    HttpResponse.json({
      policy: "open",
      keys: [{ provider: "anthropic", last4: "7890", updated_at: "2026-06-19T00:00:00Z" }],
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("LlmKeysSection — VT-25", () => {
  it("renders an attached key as provider + last4 (never the key)", async () => {
    renderWithProviders(<LlmKeysSection namespace="alice" name="bot" />);
    // The masked last4 is unique to the list row.
    await screen.findByText("••••7890");
  });

  it("attaches a key — the PUT carries the key in the body", async () => {
    let capturedProvider = "";
    let capturedKey = "";
    server.use(
      http.put("/api/agents/:ns/:name/llm-keys/:provider", async ({ request, params }) => {
        capturedProvider = String(params.provider);
        capturedKey = ((await request.json()) as { key: string }).key;
        return HttpResponse.json({ provider: capturedProvider, last4: capturedKey.slice(-4) });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LlmKeysSection namespace="alice" name="bot" />);
    await screen.findByText("••••7890");

    await user.type(screen.getByLabelText("LLM key"), "sk-ant-abcdef1234567890");
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() => expect(capturedKey).toBe("sk-ant-abcdef1234567890"));
    expect(capturedProvider).toBe("anthropic"); // the default provider in the select
  });

  it("toggles the caller-key policy — the PUT carries the new policy", async () => {
    let capturedPolicy = "";
    server.use(
      http.put("/api/agents/:ns/:name/llm-key-policy", async ({ request }) => {
        capturedPolicy = ((await request.json()) as { policy: string }).policy;
        return HttpResponse.json({ policy: capturedPolicy });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LlmKeysSection namespace="alice" name="bot" />);
    await screen.findByText("••••7890");

    await user.click(screen.getByRole("button", { name: "My key only" }));
    await waitFor(() => expect(capturedPolicy).toBe("creator_only"));
  });
});
