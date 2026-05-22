import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { PlaygroundPage } from "./playground";

const server = setupServer(
  http.get("/api/agents/dev/test-agent", () =>
    HttpResponse.json({
      name: "test-agent",
      namespace: "dev",
      description: "A test agent for playground",
      verified: false,
      run_count: 0,
      token_count: 0,
      created_at: "2026-04-21T00:00:00Z",
      updated_at: "2026-04-21T00:00:00Z",
    }),
  ),
  http.get("/api/agents/dev/test-agent/versions", () => HttpResponse.json({ versions: [] })),
  http.get("/api/agents/dev/nonexistent", () =>
    HttpResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
  ),
  http.get("/api/agents/dev/nonexistent/versions", () =>
    HttpResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPlayground(ns: string, name: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/agents/:namespace/:name/run" element={<PlaygroundPage />} />
    </Routes>,
    { route: `/agents/${ns}/${name}/run` },
  );
}

describe("PlaygroundPage", () => {
  it("UAT-7: renders with agent context", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      expect(screen.getAllByText("dev/test-agent").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Playground").length).toBeGreaterThan(0);
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
  });

  it("shows input textarea with default JSON", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      const textarea = screen.getByDisplayValue("{}");
      expect(textarea).toBeInTheDocument();
    });
  });

  it("EC-3: shows error for nonexistent agent", async () => {
    renderPlayground("dev", "nonexistent");
    await waitFor(() => {
      expect(screen.getByText("Agent not found")).toBeInTheDocument();
      expect(screen.getByText("Back to agents")).toBeInTheDocument();
    });
  });

  // ── Bug G: no JSON-mode "Attach file" button ────────────────────────

  it("does not render an 'Attach file' button in JSON mode", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Attach file/i })).not.toBeInTheDocument();
  });

  it("renders a Form-mode hint when the agent has file-typed inputs", async () => {
    server.use(
      http.get("/api/agents/dev/multimodal-agent", () =>
        HttpResponse.json({
          name: "multimodal-agent",
          namespace: "dev",
          description: "Takes a file input",
          verified: false,
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/multimodal-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              pushed_at: "2026-04-21T00:00:00Z",
              size: 1,
              config_snapshot: {
                inputs: [
                  { name: "audio", type: "file", media: "audio" },
                  { name: "title", type: "string" },
                ],
              },
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "multimodal-agent");
    await waitFor(() => {
      expect(screen.getByText(/This agent takes file inputs\. Switch to/)).toBeInTheDocument();
    });
  });

  it("hides the Form-mode hint for agents with no file inputs", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/This agent takes file inputs/)).not.toBeInTheDocument();
  });

  // ── Per-version Run gating (Phase 7.5 — AC-20, UAT-26..28) ─────────────

  it("UAT-26: Run button is disabled when the selected (latest) version is unverified", async () => {
    server.use(
      http.get("/api/agents/dev/gated", () =>
        HttpResponse.json({
          name: "gated",
          namespace: "dev",
          description: "",
          latest_version_verified: false,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/gated/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: false,
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "gated");

    await waitFor(() => {
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
    const runBtn = screen.getByRole("button", { name: /Run agent/ });
    expect(runBtn).toBeDisabled();
    expect(runBtn).toHaveAttribute("aria-disabled", "true");
    expect(runBtn).toHaveAttribute("aria-describedby", "run-disabled-reason");
  });

  it("AC-20: amber banner with link to versions table is rendered when unverified", async () => {
    server.use(
      http.get("/api/agents/dev/gated", () =>
        HttpResponse.json({
          name: "gated",
          namespace: "dev",
          description: "",
          latest_version_verified: false,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/gated/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: false,
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "gated");

    await waitFor(() => {
      expect(screen.getByText(/is not verified/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/View versions table/i)).toBeInTheDocument();
    // The sr-only span carries the screen-reader explanation
    expect(screen.getByText(/must be verified by an admin/i)).toBeInTheDocument();
  });

  it("UAT-26 (positive): Run button is enabled when the selected version is verified", async () => {
    server.use(
      http.get("/api/agents/dev/ok", () =>
        HttpResponse.json({
          name: "ok",
          namespace: "dev",
          description: "",
          latest_version_verified: true,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/ok/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: true,
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "ok");

    await waitFor(() => {
      const runBtn = screen.getByRole("button", { name: /Run agent/ });
      expect(runBtn).not.toBeDisabled();
    });
    expect(screen.queryByText(/is not verified/i)).not.toBeInTheDocument();
  });
});
