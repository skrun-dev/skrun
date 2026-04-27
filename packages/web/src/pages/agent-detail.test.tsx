import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
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
      const noteEl = container.querySelector(`[title="${note}"]`);
      expect(noteEl).not.toBeNull();
      // Should contain exactly one intact emoji (the 🚀), not a broken surrogate half
      const text = noteEl?.textContent ?? "";
      expect(text).toContain("🚀");
      // Should NOT contain the second emoji (truncated)
      expect(text).not.toContain("🎉");
    });
  });
});
