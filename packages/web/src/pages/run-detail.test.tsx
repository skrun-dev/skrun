import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
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
  usage_cache_read_tokens: 0,
  usage_cache_write_tokens: 0,
  usage_cache_savings_usd: 0,
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

  // ── Cache cost-savings ([005-cache-cost-savings-dashboard]) ───────────

  it("VT-14: shows 'saved $X.XX' line on completed run with savings > 0", async () => {
    server.use(
      http.get("/api/runs/run-with-savings", () =>
        HttpResponse.json({
          ...mockRun,
          id: "run-with-savings",
          status: "completed",
          usage_cache_read_tokens: 7143,
          usage_cache_savings_usd: 0.12,
        }),
      ),
    );
    renderRunDetail("run-with-savings");
    await waitFor(() => {
      const savedLine = screen.getByTestId("cost-cell-saved");
      expect(savedLine).toBeInTheDocument();
      expect(savedLine.textContent).toContain("saved $0.12");
    });
  });

  it("VT-15: hides 'saved $X.XX' line on failed run (no partial accounting)", async () => {
    server.use(
      http.get("/api/runs/run-failed", () =>
        HttpResponse.json({
          ...mockRun,
          id: "run-failed",
          status: "failed",
          error: "LLM timeout",
          // Even if savings were somehow non-zero, the UI hides the line
          // for non-completed status.
          usage_cache_savings_usd: 0.5,
        }),
      ),
    );
    renderRunDetail("run-failed");
    await waitFor(() => {
      // Page rendered (assert via Re-run button presence)
      expect(screen.getByText("Re-run")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("cost-cell-saved")).not.toBeInTheDocument();
  });

  it("hides 'saved $X.XX' when savings = 0 (no cache activity)", async () => {
    // mockRun has usage_cache_savings_usd: 0 → no saved line should render
    renderRunDetail("run-abc-123-def-456");
    await waitFor(() => {
      expect(screen.getByText("Re-run")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("cost-cell-saved")).not.toBeInTheDocument();
  });

  // ── Bug D: FilesBlock wiring ────────────────────────────────────────

  it("renders the Files block when the run produced files", async () => {
    server.use(
      http.get("/api/runs/run-with-files", () =>
        HttpResponse.json({
          ...mockRun,
          id: "run-with-files",
          files: [
            { name: "report.pdf", size: 8192, file_id: "fil_abc123" },
            { name: "summary.csv", size: 512, file_id: "fil_def456" },
          ],
        }),
      ),
    );
    renderRunDetail("run-with-files");
    await waitFor(() => {
      expect(screen.getByText("Files (2)")).toBeInTheDocument();
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("summary.csv")).toBeInTheDocument();
    });
  });

  it("hides the Files block when the run produced no files", async () => {
    // mockRun has no `files` field → block must not render
    renderRunDetail("run-abc-123-def-456");
    await waitFor(() => {
      expect(screen.getByText("Re-run")).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Files \(/)).not.toBeInTheDocument();
  });

  // ── Bug C: tool_call_error event styling ─────────────────────────────

  it("renders tool_call_error events in red with a 'LLM still received this' subtitle", async () => {
    server.use(
      http.get("/api/runs/run-with-tool-error", () =>
        HttpResponse.json({
          ...mockRun,
          id: "run-with-tool-error",
          output: {
            result: "ok",
            _events: [
              {
                type: "tool_call_error",
                data: {
                  type: "tool_call_error",
                  tool: "fetch_data",
                  message: "Connection refused",
                  code: "ECONNREFUSED",
                },
                timestamp: "2026-04-21T10:00:00Z",
              },
            ],
          },
        }),
      ),
    );
    renderRunDetail("run-with-tool-error");
    await waitFor(() => {
      expect(screen.getByText(/Tool error: fetch_data — Connection refused/)).toBeInTheDocument();
      expect(screen.getByText(/LLM still received this; run continues/)).toBeInTheDocument();
    });
  });
});
