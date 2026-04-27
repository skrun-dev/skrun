import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
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
});
