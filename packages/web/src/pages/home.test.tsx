import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { HomePage } from "./home";

const server = setupServer(
  http.get("/api/stats", () =>
    HttpResponse.json({
      agents_count: 3,
      runs_today: 5,
      tokens_today: 12500,
      failed_today: 1,
      runs_yesterday: 0,
      tokens_yesterday: 0,
      failed_yesterday: 0,
      daily_runs: [0, 0, 0, 0, 0, 0, 5],
      daily_tokens: [0, 0, 0, 0, 0, 0, 12500],
      daily_failed: [0, 0, 0, 0, 0, 0, 1],
    }),
  ),
  http.get("/api/agents", () => HttpResponse.json({ agents: [], total: 0 })),
  http.get("/api/runs", () =>
    HttpResponse.json([
      {
        id: "run-1",
        agent_id: "a1",
        agent_version: "dev/test-agent@1.0.0",
        status: "completed",
        duration_ms: 1200,
        usage_total_tokens: 500,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      {
        id: "run-2",
        agent_id: "a1",
        agent_version: "dev/test-agent@1.0.0",
        status: "failed",
        duration_ms: 300,
        usage_total_tokens: 100,
        error: "LLM timeout",
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
    ]),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("HomePage", () => {
  it("UAT-2: displays stats from API", async () => {
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("3")).toBeInTheDocument();
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText("12.5K")).toBeInTheDocument();
      expect(screen.getByText("Failed runs")).toBeInTheDocument();
    });
  });

  it("UAT-3: displays activity feed with runs", async () => {
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("Recent activity")).toBeInTheDocument();
      expect(screen.getAllByText("dev/test-agent").length).toBeGreaterThan(0);
    });
  });

  it("EC-1: shows error state when API unreachable", async () => {
    server.use(http.get("/api/stats", () => HttpResponse.error()));
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText(/Cannot reach API/)).toBeInTheDocument();
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  it("shows empty state when no runs", async () => {
    server.use(
      http.get("/api/stats", () =>
        HttpResponse.json({
          agents_count: 0,
          runs_today: 0,
          tokens_today: 0,
          failed_today: 0,
          runs_yesterday: 0,
          tokens_yesterday: 0,
          failed_yesterday: 0,
          daily_runs: [0, 0, 0, 0, 0, 0, 0],
          daily_tokens: [0, 0, 0, 0, 0, 0, 0],
          daily_failed: [0, 0, 0, 0, 0, 0, 0],
        }),
      ),
      http.get("/api/runs", () => HttpResponse.json([])),
    );
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("Welcome to Skrun")).toBeInTheDocument();
    });
  });
});
