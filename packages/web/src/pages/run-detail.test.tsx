import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  // The server stores a run's files as names and sizes only — no URL, no id —
  // and GET /api/runs/:id returns them as stored.
  it("renders the Files block when the run produced files", async () => {
    server.use(
      http.get("/api/runs/run-with-files", () =>
        HttpResponse.json({
          ...mockRun,
          id: "run-with-files",
          files: [
            { name: "report.pdf", size: 8192 },
            { name: "summary.csv", size: 512 },
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

  it("downloads a file of the run through a fresh link, navigating to a presigned one", async () => {
    const presigned =
      "https://objects.example/bucket/_runs/run-with-files/outputs/report.pdf?sig=x";
    let asked: string | null = null;
    server.use(
      http.get("/api/runs/run-with-files", () =>
        HttpResponse.json({
          ...mockRun,
          id: "run-with-files",
          files: [{ name: "report.pdf", size: 8192 }],
        }),
      ),
      http.get("/api/runs/:run_id/files/:filename/link", ({ request }) => {
        asked = new URL(request.url).pathname;
        return HttpResponse.json({ url: presigned, expires_at: "2026-10-01T12:15:00.000Z" });
      }),
      // Answered, so that a page which did fetch the store fails on the origin
      // assertion below, never on a request leaving the test.
      http.get("https://objects.example/*", () => new HttpResponse("%PDF")),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const clicks: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.href);
    });
    const user = userEvent.setup();

    try {
      renderRunDetail("run-with-files");
      await user.click(await screen.findByRole("button", { name: /Download/i }));

      // Settled: either the browser was sent somewhere, or an error is shown.
      await waitFor(() =>
        expect(clicks.length + screen.queryAllByRole("alert").length).toBeGreaterThan(0),
      );
      expect(screen.queryByRole("alert")?.textContent ?? null).toBeNull();
      const fetched = fetchSpy.mock.calls.map(
        ([input]) =>
          new URL(String(input instanceof Request ? input.url : input), window.location.href),
      );
      expect(fetched.filter((url) => url.origin !== window.location.origin)).toEqual([]);
      expect(asked).toBe("/api/runs/run-with-files/files/report.pdf/link");
      expect(clicks).toEqual([presigned]);
    } finally {
      clickSpy.mockRestore();
      fetchSpy.mockRestore();
    }
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

  // ── The Input card's size ───────────────────────────────────────────

  // On an input kept whole, the card gives the size of its JSON text, in UTF-8
  // bytes — as the server counts it; on the marker kept in place of one too
  // large, the size the server read — never the marker's own — and that it was
  // truncated.
  describe("the Input card's size", () => {
    const MARKER = { _truncated: { bytes: 16416, preview: '{"topic":"AI agen' } };

    it("on an input kept truncated, is the original input's size in bytes, said truncated", async () => {
      server.use(
        http.get("/api/runs/run-truncated-size", () =>
          HttpResponse.json({ ...mockRun, id: "run-truncated-size", input: MARKER }),
        ),
      );
      renderRunDetail("run-truncated-size");

      expect(await screen.findByText("16416 B, truncated")).toBeInTheDocument();
      expect(screen.queryByText(`${JSON.stringify(MARKER).length} B`)).not.toBeInTheDocument();
    });

    it("on an input kept whole, is the size of its JSON text in bytes, with no word of truncation", async () => {
      renderRunDetail("run-abc-123-def-456");

      expect(
        await screen.findByText(
          `${new TextEncoder().encode(JSON.stringify(mockRun.input)).length} B`,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/truncated/)).not.toBeInTheDocument();
    });

    it("on an input kept whole that is not ASCII, is its size in bytes, not in characters", async () => {
      // {"topic":"café"}: 16 characters, 17 bytes — the "é" takes two.
      server.use(
        http.get("/api/runs/run-input-utf8", () =>
          HttpResponse.json({ ...mockRun, id: "run-input-utf8", input: { topic: "café" } }),
        ),
      );
      renderRunDetail("run-input-utf8");

      expect(await screen.findByText("17 B")).toBeInTheDocument();
      expect(screen.queryByText("16 B")).not.toBeInTheDocument();
    });
  });

  // ── The Output and Error cards' size ────────────────────────────────

  // The same for the second card: an output kept truncated gives the size the
  // server read, said truncated; an error, its size in bytes — the original
  // size its suffix carries when the row kept it cut.
  describe("the Output and Error cards' size", () => {
    function renderWith(runId: string, fields: Record<string, unknown>) {
      server.use(
        http.get(`/api/runs/${runId}`, () =>
          HttpResponse.json({ ...mockRun, id: runId, ...fields }),
        ),
      );
      renderRunDetail(runId);
    }

    it("on an output kept truncated, is the original output's size in bytes, said truncated", async () => {
      const marker = { _truncated: { bytes: 70000, preview: '{"result":"Dra' } };
      renderWith("run-truncated-output", { output: marker });

      expect(await screen.findByText("70000 B, truncated")).toBeInTheDocument();
      expect(screen.queryByText(`${JSON.stringify(marker).length} B`)).not.toBeInTheDocument();
    });

    it("on an error kept whole, is its size in bytes, not in characters", async () => {
      // 17 characters, 18 bytes: the "é" takes two.
      renderWith("run-error-whole", { status: "failed", output: null, error: "Tool failed: café" });

      expect(await screen.findByText("18 B")).toBeInTheDocument();
      expect(screen.queryByText("17 B")).not.toBeInTheDocument();
      expect(screen.queryByText(/B, truncated/)).not.toBeInTheDocument();
    });

    it("on an output kept whole that is not ASCII, is its size in bytes, not in characters", async () => {
      // {"result":"€"}: 14 characters, 16 bytes — the "€" takes three.
      renderWith("run-output-utf8", { output: { result: "€" } });

      expect(await screen.findByText("16 B")).toBeInTheDocument();
      expect(screen.queryByText("14 B")).not.toBeInTheDocument();
      expect(screen.queryByText(/B, truncated/)).not.toBeInTheDocument();
    });

    it("on an error kept whole that merely ends with the suffix's words, its N no larger than itself, is its own size, not truncated", async () => {
      // 34 bytes, its suffix saying 9: not a cut error — the row kept it whole.
      const error = "Tool said … [truncated: 9 bytes]";
      renderWith("run-error-suffix-words", { status: "failed", output: null, error });
      const own = new TextEncoder().encode(error).length;

      expect(await screen.findByText(`${own} B`)).toBeInTheDocument();
      expect(screen.queryByText("9 B, truncated")).not.toBeInTheDocument();
      expect(screen.queryByText(/B, truncated/)).not.toBeInTheDocument();
    });

    it("on an error kept cut, is the original error's size its suffix carries, said truncated", async () => {
      // 66 characters, 68 bytes as kept; 20000 bytes as received.
      const error = `${"x".repeat(40)}… [truncated: 20000 bytes]`;
      renderWith("run-error-cut", { status: "failed", output: null, error });

      expect(await screen.findByText("20000 B, truncated")).toBeInTheDocument();
      expect(screen.queryByText("66 B")).not.toBeInTheDocument();
      expect(screen.queryByText("68 B")).not.toBeInTheDocument();
    });
  });

  // ── Re-run and an input kept truncated ──────────────────────────────

  // The server keeps a run's input whole up to a size, and a marker in its
  // place beyond: re-running from the marker would send the marker.
  describe("Re-run", () => {
    const HINT =
      "This run's input was too large to keep — run it again from the playground or the API.";

    /** The run page, and a stand-in for the playground that shows the input it was sent. */
    function renderWithPlayground(runId: string) {
      function Playground() {
        const { search } = useLocation();
        return <p>playground {new URLSearchParams(search).get("input")}</p>;
      }
      return renderWithProviders(
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/agents/:namespace/:name/run" element={<Playground />} />
        </Routes>,
        { route: `/runs/${runId}` },
      );
    }

    it("is off on a run whose input was kept truncated, and says why", async () => {
      server.use(
        http.get("/api/runs/run-truncated-input", () =>
          HttpResponse.json({
            ...mockRun,
            id: "run-truncated-input",
            input: { _truncated: { bytes: 16416, preview: '{"topic":"AI agen' } },
          }),
        ),
      );
      const user = userEvent.setup();
      renderWithPlayground("run-truncated-input");

      const button = await screen.findByRole("button", { name: /Re-run/ });
      expect(button).toBeDisabled();
      expect(screen.getByTitle(HINT)).toContainElement(button);
      await user.click(button);
      expect(screen.queryByText(/^playground/)).not.toBeInTheDocument();
    });

    it("is on for a run whose input was kept whole, and sends that input to the playground", async () => {
      const user = userEvent.setup();
      renderWithPlayground("run-abc-123-def-456");

      const button = await screen.findByRole("button", { name: "Re-run" });
      expect(button).toBeEnabled();
      expect(screen.queryByTitle(HINT)).not.toBeInTheDocument();
      await user.click(button);
      expect(await screen.findByText('playground {"topic":"AI agents"}')).toBeInTheDocument();
    });
  });
});
