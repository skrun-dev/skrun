import type { QueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test-utils";
import { HomePage } from "./home";

// A switch that makes the usage strip throw while it renders, and counts each throw.
const stripRender = vi.hoisted(() => ({ fails: false, thrown: 0 }));
vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api-client")>();
  return {
    ...actual,
    useUsage: () => {
      if (stripRender.fails) {
        stripRender.thrown += 1;
        throw new Error("the usage strip failed to render");
      }
      return actual.useUsage();
    },
  };
});

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
      cache_savings_today: 1.42,
      cache_savings_yesterday: 0.5,
      daily_cache_savings: [0, 0, 0, 0, 0, 0.5, 1.42],
      cost_today: 0.05,
      cost_yesterday: 0.03,
      daily_cost: [0, 0, 0, 0, 0, 0.03, 0.05],
    }),
  ),
  http.get("/api/agents", () => HttpResponse.json({ agents: [], total: 0 })),
  // A server that sets no quota: no usage strip.
  http.get("/api/usage", () => HttpResponse.json({ plan: "free", quotas: null })),
  // A server whose operator sets no links of its own: the docs are its API reference.
  http.get("/api/instance", () =>
    HttpResponse.json({ links: { docs: "/docs", terms: null, privacy: null } }),
  ),
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
          cache_savings_today: 0,
          cache_savings_yesterday: 0,
          daily_cache_savings: [0, 0, 0, 0, 0, 0, 0],
          cost_today: 0,
          cost_yesterday: 0,
          daily_cost: [0, 0, 0, 0, 0, 0, 0],
        }),
      ),
      http.get("/api/runs", () => HttpResponse.json([])),
    );
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("Welcome to Skrun")).toBeInTheDocument();
    });
  });

  it("renders 'Cost saved' tile with formatted USD when cache_savings_today > 0", async () => {
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("Cost saved")).toBeInTheDocument();
      // formatUsd(1.42) -> "$1.42"
      expect(screen.getByText("$1.42")).toBeInTheDocument();
    });
  });

  it("'Cost saved' tile shows tooltip when no cache activity", async () => {
    server.use(
      http.get("/api/stats", () =>
        HttpResponse.json({
          agents_count: 1,
          runs_today: 1,
          tokens_today: 100,
          failed_today: 0,
          runs_yesterday: 0,
          tokens_yesterday: 0,
          failed_yesterday: 0,
          daily_runs: [0, 0, 0, 0, 0, 0, 1],
          daily_tokens: [0, 0, 0, 0, 0, 0, 100],
          daily_failed: [0, 0, 0, 0, 0, 0, 0],
          cache_savings_today: 0,
          cache_savings_yesterday: 0,
          daily_cache_savings: [0, 0, 0, 0, 0, 0, 0],
          cost_today: 0,
          cost_yesterday: 0,
          daily_cost: [0, 0, 0, 0, 0, 0, 0],
        }),
      ),
    );
    renderWithProviders(<HomePage />);
    await waitFor(() => {
      const tile = screen.getByTestId("cost-saved-tile");
      expect(tile).toBeInTheDocument();
      expect(tile.getAttribute("title")).toContain(
        "Caching kicks in automatically on Anthropic, Gemini, OpenAI, xAI and Groq",
      );
      // The Cost saved tile itself shows $0.00 (the Cost tile may also show
      // $0.00 — scope the assertion to the Cost saved wrapper).
      expect(tile.textContent).toContain("$0.00");
    });
  });
});

describe("HomePage — the usage strip", () => {
  const USAGE = {
    plan: "free",
    quotas: {
      concurrent_runs: { limit: 2, in_use: 1 },
      compute: {
        limit_seconds: 3600,
        used_seconds: 720,
        window: { start: "2026-10-20T06:00:00.000Z", end: "2026-10-20T12:00:00.000Z" },
      },
      fast_runs: null,
    },
  };

  /** Whether `a` comes before `b` in the page. */
  function comesBefore(a: Element, b: Element): boolean {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  it("sits between the metric cards and the page's content", async () => {
    server.use(http.get("/api/usage", () => HttpResponse.json(USAGE)));
    renderWithProviders(<HomePage />);

    const strip = await screen.findByRole("region", { name: "Usage" });
    const metric = await screen.findByText("Failed runs");
    const content = await screen.findByText("Recent activity");
    expect(comesBefore(metric, strip)).toBe(true);
    expect(comesBefore(strip, content)).toBe(true);
  });

  it("is there for a new account too, above the welcome", async () => {
    server.use(
      http.get("/api/usage", () => HttpResponse.json(USAGE)),
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
          cache_savings_today: 0,
          cache_savings_yesterday: 0,
          daily_cache_savings: [0, 0, 0, 0, 0, 0, 0],
          cost_today: 0,
          cost_yesterday: 0,
          daily_cost: [0, 0, 0, 0, 0, 0, 0],
        }),
      ),
      http.get("/api/runs", () => HttpResponse.json([])),
    );
    renderWithProviders(<HomePage />);

    const welcome = await screen.findByText("Welcome to Skrun");
    const strip = await screen.findByRole("region", { name: "Usage" });
    expect(comesBefore(strip, welcome)).toBe(true);
  });

  it("a strip that fails to render is left out, and the rest of the page is shown", async () => {
    server.use(http.get("/api/usage", () => HttpResponse.json(USAGE)));
    // The error the strip's boundary catches is logged by React: kept out of the test's output.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stripRender.fails = true;
    stripRender.thrown = 0;
    try {
      expect(() => renderWithProviders(<HomePage />)).not.toThrow();

      expect(await screen.findByText("Recent activity")).toBeInTheDocument();
      expect(screen.getByText("Failed runs")).toBeInTheDocument();
      expect(stripRender.thrown).toBeGreaterThan(0);
      expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
      expect(screen.queryByTestId("usage-strip-skeleton")).toBeNull();
    } finally {
      stripRender.fails = false;
      logged.mockRestore();
    }
  });

  it("a server that sets no quota: the page as before, no strip", async () => {
    renderWithProviders(<HomePage />);

    expect(await screen.findByText("Recent activity")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("usage-strip-skeleton")).toBeNull());
    expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
  });
});

describe("HomePage — Read docs", () => {
  const DOCS = "https://docs.example.com";

  /** A new account's statistics: the page shows the welcome instead of its activity. */
  function aNewAccount() {
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
          cache_savings_today: 0,
          cache_savings_yesterday: 0,
          daily_cache_savings: [0, 0, 0, 0, 0, 0, 0],
          cost_today: 0,
          cost_yesterday: 0,
          daily_cost: [0, 0, 0, 0, 0, 0, 0],
        }),
      ),
      http.get("/api/runs", () => HttpResponse.json([])),
    );
  }

  function instanceAnswering(respond: () => Response) {
    server.use(http.get("/api/instance", respond));
  }

  /** Waits until the read of the instance has an answer or has failed. */
  async function settled(client: QueryClient) {
    await waitFor(() =>
      expect(["success", "error"]).toContain(client.getQueryState(["instance"])?.status),
    );
  }

  // The quick start's "Read docs", on a page with activity; the welcome's, on a new account's.
  describe.each([
    ["the quick start's", "Read docs", () => undefined],
    ["the welcome's", "Read Docs", aNewAccount],
  ])("%s", (_card, name, arrange) => {
    it("leads to the operator's docs when it sets them", async () => {
      arrange();
      instanceAnswering(() =>
        HttpResponse.json({ links: { docs: DOCS, terms: null, privacy: null } }),
      );
      renderWithProviders(<HomePage />);

      const link = await screen.findByRole("link", { name });
      await waitFor(() => expect(link.getAttribute("href")).toBe(DOCS));
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it.each([
      [
        "the server's default answer",
        () => HttpResponse.json({ links: { docs: "/docs", terms: null, privacy: null } }),
      ],
      ["a failed connection", () => HttpResponse.error()],
      [
        "a 500 answer",
        () =>
          HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "no" } }, { status: 500 }),
      ],
      ["an answer with no links", () => HttpResponse.json({})],
    ])("%s: this server's API reference", async (_case, respond) => {
      arrange();
      instanceAnswering(respond);
      const { queryClient } = renderWithProviders(<HomePage />);
      await settled(queryClient);

      expect((await screen.findByRole("link", { name })).getAttribute("href")).toBe("/docs");
    });
  });
});
