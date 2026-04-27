import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { RunDetailPage } from "./run-detail";

const mockRun = {
  id: "run-abc-123-def-456",
  agent_id: "a1",
  agent_version: "dev/test-agent@1.0.0",
  status: "completed",
  input: { topic: "AI agents" },
  output: { result: "Draft written successfully" },
  error: null,
  usage_prompt_tokens: 200,
  usage_completion_tokens: 300,
  usage_total_tokens: 500,
  usage_estimated_cost: 0.0025,
  duration_ms: 1500,
  created_at: "2026-04-21T10:00:00Z",
  completed_at: "2026-04-21T10:00:01Z",
};

const server = setupServer(
  http.get("/api/runs/run-abc-123-def-456", () => HttpResponse.json(mockRun)),
  http.get("/api/runs/nonexistent", () =>
    HttpResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderRunDetail(runId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/runs/:id" element={<RunDetailPage />} />
    </Routes>,
    { route: `/runs/${runId}` },
  );
}

describe("RunDetailPage", () => {
  it("UAT-3: displays input and output", async () => {
    renderRunDetail("run-abc-123-def-456");
    await waitFor(() => {
      expect(screen.getByText(/AI agents/)).toBeInTheDocument();
      expect(screen.getByText(/Draft written successfully/)).toBeInTheDocument();
    });
  });

  it("UAT-5: displays token usage", async () => {
    renderRunDetail("run-abc-123-def-456");
    await waitFor(() => {
      expect(screen.getByText("200")).toBeInTheDocument();
      expect(screen.getByText("300")).toBeInTheDocument();
      expect(screen.getByText("500")).toBeInTheDocument();
    });
  });

  it("has Re-run button", async () => {
    renderRunDetail("run-abc-123-def-456");
    await waitFor(() => {
      expect(screen.getByText("Re-run")).toBeInTheDocument();
    });
  });

  it("EC-1: shows not found for missing run", async () => {
    renderRunDetail("nonexistent");
    await waitFor(() => {
      expect(screen.getByText("Run not found")).toBeInTheDocument();
      expect(screen.getByText("Back to runs")).toBeInTheDocument();
    });
  });
});
