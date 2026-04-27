import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { AgentsPage } from "./agents";

/** Match text content that spans multiple child elements (e.g. "dev/" + <span>name</span>) */
function byTextContent(text: string) {
  return (_content: string, element: Element | null) =>
    element?.tagName === "A" && element.textContent === text;
}

const mockAgents = [
  {
    id: "a1",
    name: "email-drafter",
    namespace: "dev",
    description: "Drafts emails",
    owner_id: "u1",
    verified: true,
    run_count: 0,
    token_count: 0,
    created_at: "2026-04-20T00:00:00Z",
    updated_at: "2026-04-20T10:00:00Z",
  },
  {
    id: "a2",
    name: "code-review",
    namespace: "dev",
    description: "Reviews code",
    owner_id: "u1",
    verified: false,
    run_count: 0,
    token_count: 0,
    created_at: "2026-04-19T00:00:00Z",
    updated_at: "2026-04-19T10:00:00Z",
  },
  {
    id: "a3",
    name: "analyzer",
    namespace: "alice",
    description: "Analyzes data",
    owner_id: "u2",
    verified: false,
    run_count: 0,
    token_count: 0,
    created_at: "2026-04-18T00:00:00Z",
    updated_at: "2026-04-18T10:00:00Z",
  },
];

const server = setupServer(
  http.get("/api/agents", () => HttpResponse.json({ agents: mockAgents, total: 3 })),
  http.delete("/api/agents/:ns/:name", () => new HttpResponse(null, { status: 204 })),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AgentsPage", () => {
  it("UAT-4: renders agents table with correct columns", async () => {
    renderWithProviders(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText(byTextContent("dev/email-drafter"))).toBeInTheDocument();
      expect(screen.getByText(byTextContent("dev/code-review"))).toBeInTheDocument();
      expect(screen.getByText(byTextContent("alice/analyzer"))).toBeInTheDocument();
    });
  });

  it("UAT-5: filters agents by namespace", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText(byTextContent("dev/email-drafter"))).toBeInTheDocument();
    });

    const filter = screen.getByPlaceholderText("Filter agents...");
    await user.type(filter, "alice");

    await waitFor(() => {
      expect(screen.queryByText(byTextContent("dev/email-drafter"))).not.toBeInTheDocument();
      expect(screen.getByText(byTextContent("alice/analyzer"))).toBeInTheDocument();
    });
  });

  it("UAT-6: row hover actions include Try button", async () => {
    renderWithProviders(<AgentsPage />);

    await waitFor(() => {
      expect(screen.getByText(byTextContent("dev/email-drafter"))).toBeInTheDocument();
    });

    // The new design shows a "Try" button on row hover instead of a Delete button.
    // Delete was moved to the agent detail page's danger zone.
    const tryButtons = screen.getAllByText("Try");
    expect(tryButtons.length).toBeGreaterThan(0);
  });

  it("EC-2: shows empty state when no agents", async () => {
    server.use(http.get("/api/agents", () => HttpResponse.json({ agents: [], total: 0 })));
    renderWithProviders(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("No agents registered")).toBeInTheDocument();
    });
  });
});
