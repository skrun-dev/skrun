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
        {
          id: "v1",
          version: "1.0.0",
          size: 1024,
          pushed_at: "2026-04-18T00:00:00Z",
          verified: false,
        },
        {
          id: "v2",
          version: "1.1.0",
          size: 1100,
          pushed_at: "2026-04-19T00:00:00Z",
          verified: true,
        },
        {
          id: "v3",
          version: "1.2.0",
          size: 1200,
          pushed_at: "2026-04-20T00:00:00Z",
          verified: false,
        },
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
      // Agent-level verified badge removed in per-version migration; trust
      // status now lives in the per-row badges of the versions table.
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

  // DSH-A (audit/001 Task 4.11): verify-button visibility gated on user.role
  // Server enforces SEC-005 admin-only PATCH /verify; the dashboard hides
  // the button entirely for non-admin viewers so they don't get teased.
  describe("DSH-A: verify-button gated on user.role", () => {
    it("renders Verify button when /api/me returns role='admin'", async () => {
      server.use(
        http.get("/api/me", () =>
          HttpResponse.json({
            id: "u-admin",
            username: "admin",
            namespace: "admin",
            role: "admin",
          }),
        ),
      );
      renderDetailPage();
      await waitFor(() => {
        // Admin sees Verify/Unverify buttons — the legacy agent-level one in
        // the Danger zone AND per-version buttons in the versions table
        // (Task 7.3). At least one must be present.
        expect(screen.getAllByRole("button", { name: /unverify|verify/i }).length).toBeGreaterThan(
          0,
        );
      });
    });

    it("hides Verify button when /api/me returns role='user'", async () => {
      server.use(
        http.get("/api/me", () =>
          HttpResponse.json({
            id: "u-regular",
            username: "regular",
            namespace: "regular",
            role: "user",
          }),
        ),
      );
      renderDetailPage();
      // Wait for the page to render — agent name appears in the breadcrumb.
      // Delete button is also hidden for a non-admin viewer in a foreign
      // namespace (per AC-22, post-#83), so we use the breadcrumb text as
      // a stable "page loaded" sentinel instead.
      await waitFor(() => {
        expect(screen.getAllByText("dev/test-agent").length).toBeGreaterThan(0);
      });
      expect(screen.queryByRole("button", { name: /^(un)?verify$/i })).not.toBeInTheDocument();
    });

    it("hides Verify button when /api/me 401s (unauthenticated → least-privilege)", async () => {
      server.use(http.get("/api/me", () => new HttpResponse(null, { status: 401 })));
      renderDetailPage();
      await waitFor(() => {
        expect(screen.getAllByText("dev/test-agent").length).toBeGreaterThan(0);
      });
      expect(screen.queryByRole("button", { name: /^(un)?verify$/i })).not.toBeInTheDocument();
    });
  });

  // ── Per-version Status + Actions in versions table (Phase 7.3 — UAT-21..24) ─
  describe("versions table Status + Actions columns", () => {
    it("UAT-21: renders per-row Status badge for each version", async () => {
      renderDetailPage();
      await waitFor(() => {
        expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0);
      });
      // Fixture has 3 versions: v1.0.0 unverified, v1.1.0 verified, v1.2.0 unverified
      // → 2 "unverified" Pills + 1 "verified" Pill (at minimum — could be more
      // if other surfaces render the label).
      const verifiedPills = screen.getAllByText("verified");
      const unverifiedPills = screen.getAllByText("unverified");
      expect(verifiedPills.length).toBeGreaterThanOrEqual(1);
      expect(unverifiedPills.length).toBeGreaterThanOrEqual(2);
    });

    it("UAT-22/23: admin sees Verify/Unverify button per row (mix of states)", async () => {
      server.use(
        http.get("/api/me", () =>
          HttpResponse.json({
            id: "u-admin",
            username: "admin",
            namespace: "admin",
            role: "admin",
          }),
        ),
      );
      renderDetailPage();
      await waitFor(() => {
        expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0);
      });
      // Three versions in the table: 2 unverified → 2 "Verify" buttons,
      // 1 verified → 1 "Unverify" button. Total at least 3.
      const verifyButtons = screen.getAllByRole("button", { name: /^Verify$/ });
      const unverifyButtons = screen.getAllByRole("button", { name: /^Unverify$/ });
      expect(verifyButtons.length).toBeGreaterThanOrEqual(2);
      expect(unverifyButtons.length).toBeGreaterThanOrEqual(1);
    });

    it("UAT-24: non-admin sees NO Verify/Unverify buttons", async () => {
      server.use(
        http.get("/api/me", () =>
          HttpResponse.json({
            id: "u-reg",
            username: "regular",
            namespace: "regular",
            role: "user",
          }),
        ),
      );
      renderDetailPage();
      await waitFor(() => {
        expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0);
      });
      // Status Pills exist (badges visible to everyone), but no
      // Verify/Unverify action buttons for non-admin.
      expect(screen.queryByRole("button", { name: /^Verify$/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Unverify$/ })).not.toBeInTheDocument();
    });
  });
});
