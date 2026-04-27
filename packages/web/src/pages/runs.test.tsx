import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { RunsPage } from "./runs";

const mockRuns = [
  {
    id: "run-001",
    agent_id: "a1",
    agent_version: "dev/test@1.0.0",
    status: "completed",
    duration_ms: 1200,
    usage_total_tokens: 500,
    created_at: new Date().toISOString(),
  },
  {
    id: "run-002",
    agent_id: "a1",
    agent_version: "dev/test@1.0.0",
    status: "failed",
    duration_ms: 300,
    usage_total_tokens: 100,
    error: "timeout",
    created_at: new Date().toISOString(),
  },
  {
    id: "run-003",
    agent_id: "a2",
    agent_version: "dev/other@1.0.0",
    status: "completed",
    duration_ms: 2000,
    usage_total_tokens: 800,
    created_at: new Date().toISOString(),
  },
];

const server = setupServer(
  http.get("/api/runs", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const filtered = status ? mockRuns.filter((r) => r.status === status) : mockRuns;
    return HttpResponse.json(filtered);
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("RunsPage", () => {
  it("UAT-1: renders runs list", async () => {
    renderWithProviders(<RunsPage />);
    await waitFor(() => {
      expect(screen.getByText("Runs")).toBeInTheDocument();
      // 2 runs with "dev/test" + 1 with "dev/other"
      expect(screen.getAllByText("dev/test").length).toBe(2);
      expect(screen.getByText("dev/other")).toBeInTheDocument();
    });
  });

  it("UAT-2: filters by status", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RunsPage />);

    await waitFor(() => {
      expect(screen.getAllByText("dev/test").length).toBe(2);
    });

    const failedButton = screen.getByRole("button", { name: /failed/i });
    await user.click(failedButton);

    await waitFor(() => {
      // Only 1 failed run (dev/test)
      expect(screen.getAllByText("dev/test").length).toBe(1);
      expect(screen.queryByText("dev/other")).not.toBeInTheDocument();
    });
  });

  it("EC-2: shows empty state when no runs", async () => {
    server.use(http.get("/api/runs", () => HttpResponse.json([])));
    renderWithProviders(<RunsPage />);
    await waitFor(() => {
      expect(screen.getByText("No runs yet")).toBeInTheDocument();
    });
  });
});
