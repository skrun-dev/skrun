import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { AgentDetailPage } from "./agent-detail";

const server = setupServer(
  http.get("/api/agents/dev/test-agent", () =>
    HttpResponse.json({
      name: "test-agent",
      namespace: "dev",
      description: "A test agent",
      verified: true,
      run_count: 0,
      token_count: 0,
      created_at: "2026-04-20T00:00:00Z",
      updated_at: "2026-04-20T10:00:00Z",
      latest_version: "1.2.0",
      versions: ["1.0.0", "1.1.0", "1.2.0"],
    }),
  ),
  http.get("/api/agents/dev/test-agent/versions", () =>
    HttpResponse.json({
      versions: [
        { id: "v1", version: "1.0.0", size: 1024, pushed_at: "2026-04-18T00:00:00Z" },
        { id: "v2", version: "1.1.0", size: 1100, pushed_at: "2026-04-19T00:00:00Z" },
        { id: "v3", version: "1.2.0", size: 1200, pushed_at: "2026-04-20T00:00:00Z" },
      ],
    }),
  ),
  http.get("/api/agents/dev/test-agent/stats", () =>
    HttpResponse.json({
      runs: 0,
      tokens: 0,
      failed: 0,
      avg_duration_ms: 0,
      prev_runs: 0,
      prev_tokens: 0,
      prev_failed: 0,
      prev_avg_duration_ms: 0,
      daily_runs: [0, 0, 0, 0, 0, 0, 0],
      daily_tokens: [0, 0, 0, 0, 0, 0, 0],
      daily_failed: [0, 0, 0, 0, 0, 0, 0],
      daily_avg_duration_ms: [0, 0, 0, 0, 0, 0, 0],
      cache_savings: 0,
      prev_cache_savings: 0,
      daily_cache_savings: [0, 0, 0, 0, 0, 0, 0],
      cost: 0,
      prev_cost: 0,
      daily_cost: [0, 0, 0, 0, 0, 0, 0],
    }),
  ),
  http.get("/api/runs", () => HttpResponse.json([])),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderDetailPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/agents/:namespace/:name" element={<AgentDetailPage />} />
    </Routes>,
    { route: "/agents/dev/test-agent" },
  );
}

describe("AgentDetailPage", () => {
  it("UAT-7: displays agent metadata and versions", async () => {
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getAllByText("dev/test-agent").length).toBeGreaterThan(0);
      expect(screen.getByText("verified")).toBeInTheDocument();
      expect(screen.getByText("1.0.0")).toBeInTheDocument();
      expect(screen.getAllByText("1.2.0").length).toBeGreaterThan(0);
    });
  });

  it("has a Try button", async () => {
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByText("Try in playground")).toBeInTheDocument();
    });
  });

  it("EC-5: shows not found for missing agent", async () => {
    server.use(
      http.get("/api/agents/dev/test-agent", () =>
        HttpResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
      ),
    );
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByText("Agent not found")).toBeInTheDocument();
      expect(screen.getByText("Back to agents")).toBeInTheDocument();
    });
  });

  // ── Version notes (#14c) ───────────────────────────────────────────

  it("renders version notes when present", async () => {
    server.use(
      http.get("/api/agents/dev/test-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              id: "v1",
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-18T00:00:00Z",
              notes: "Added retry logic",
            },
          ],
        }),
      ),
    );
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByText("Added retry logic")).toBeInTheDocument();
    });
  });

  it("renders nothing when notes is null", async () => {
    server.use(
      http.get("/api/agents/dev/test-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              id: "v1",
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-18T00:00:00Z",
              notes: null,
            },
          ],
        }),
      ),
    );
    const { container } = renderDetailPage();
    await waitFor(() => {
      expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0);
    });
    // No element with title attribute (which is only added for notes)
    expect(container.querySelector('[title][class*="text-gray-600"]')).toBeNull();
  });

  it("escapes HTML in notes (XSS defense)", async () => {
    const payload = "<script>alert(1)</script>";
    server.use(
      http.get("/api/agents/dev/test-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              id: "v1",
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-18T00:00:00Z",
              notes: payload,
            },
          ],
        }),
      ),
    );
    const { container } = renderDetailPage();
    await waitFor(() => {
      expect(screen.getByText(payload)).toBeInTheDocument();
    });
    // No real <script> element injected
    expect(container.querySelector("script")).toBeNull();
  });

  it("truncates long notes at 80 graphemes with full text in title attribute", async () => {
    const longNote = `${"a".repeat(95)}`;
    server.use(
      http.get("/api/agents/dev/test-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              id: "v1",
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-18T00:00:00Z",
              notes: longNote,
            },
          ],
        }),
      ),
    );
    const { container } = renderDetailPage();
    await waitFor(() => {
      const noteEl = container.querySelector(`[title="${longNote}"]`);
      expect(noteEl).not.toBeNull();
      expect(noteEl?.textContent ?? "").toMatch(/a{80}…$/);
    });
  });

  // ── Cache cost-savings ([005-cache-cost-savings-dashboard]) ───────────

  it("VT-16: renders 'Cache savings 7d' cell with formatted USD value", async () => {
    server.use(
      http.get("/api/agents/dev/test-agent/stats", () =>
        HttpResponse.json({
          runs: 5,
          tokens: 1000,
          failed: 0,
          avg_duration_ms: 1200,
          prev_runs: 0,
          prev_tokens: 0,
          prev_failed: 0,
          prev_avg_duration_ms: 0,
          daily_runs: [0, 0, 0, 0, 0, 0, 5],
          daily_tokens: [0, 0, 0, 0, 0, 0, 1000],
          daily_failed: [0, 0, 0, 0, 0, 0, 0],
          daily_avg_duration_ms: [0, 0, 0, 0, 0, 0, 1200],
          cache_savings: 1.42,
          prev_cache_savings: 0,
          daily_cache_savings: [0, 0, 0, 0, 0, 0.5, 0.92],
          cost: 0.05,
          prev_cost: 0,
          daily_cost: [0, 0, 0, 0, 0, 0.02, 0.03],
        }),
      ),
    );
    renderDetailPage();
    await waitFor(() => {
      const cell = screen.getByTestId("agent-cache-savings");
      expect(cell).toBeInTheDocument();
      expect(cell.textContent).toContain("Cache savings 7d");
      expect(cell.textContent).toContain("$1.42");
    });
  });

  it("Cache savings cell shows $0.00 when no cache activity", async () => {
    // Default mock has cache_savings: 0
    renderDetailPage();
    await waitFor(() => {
      const cell = screen.getByTestId("agent-cache-savings");
      expect(cell.textContent).toContain("$0.00");
    });
  });

  it("preserves emoji when truncating (grapheme-safe)", async () => {
    // 79 'a' chars + 2 emoji = 81 graphemes → truncated to 80 without splitting the emoji
    const note = `${"a".repeat(79)}🚀🎉`;
    server.use(
      http.get("/api/agents/dev/test-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              id: "v1",
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-18T00:00:00Z",
              notes: note,
            },
          ],
        }),
      ),
    );
    const { container } = renderDetailPage();
    await waitFor(() => {
      // Use getAttribute lookup rather than `[title="..."]` CSS selector:
      // jsdom 29 tightened CSS attribute-selector parsing and emoji in the
      // selector value match nothing. Pulling the elements then comparing
      // attribute strings directly bypasses the selector parser.
      const noteEl = Array.from(container.querySelectorAll("[title]")).find(
        (el) => el.getAttribute("title") === note,
      );
      expect(noteEl).not.toBeUndefined();
      // Should contain exactly one intact emoji (the 🚀), not a broken surrogate half
      const text = noteEl?.textContent ?? "";
      expect(text).toContain("🚀");
      // Should NOT contain the second emoji (truncated)
      expect(text).not.toContain("🎉");
    });
  });
});
