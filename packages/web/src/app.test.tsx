import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  type RouteObject,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, formerAddresses, MovedPage, pageRoutes } from "./app";
import { useAuth } from "./lib/auth";
import { renderWithProviders } from "./test-utils";

// Each page is replaced by a marker: these tests guard which page an address
// shows, not what a page renders (every page has its own tests).
vi.mock("./pages/home", () => ({ HomePage: () => <p>page: home</p> }));
vi.mock("./pages/agents", () => ({ AgentsPage: () => <p>page: agents</p> }));
vi.mock("./pages/agent-detail", () => ({ AgentDetailPage: () => <p>page: agent-detail</p> }));
vi.mock("./pages/playground", () => ({ PlaygroundPage: () => <p>page: playground</p> }));
vi.mock("./pages/runs", () => ({ RunsPage: () => <p>page: runs</p> }));
vi.mock("./pages/run-detail", () => ({ RunDetailPage: () => <p>page: run-detail</p> }));
vi.mock("./pages/settings", () => ({ SettingsPage: () => <p>page: settings</p> }));

// A signed-in user, so the layout renders its pages instead of sending to
// /login. The provider passes through: its own request for the user is not
// what these tests are about.
vi.mock("./lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/auth")>()),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: vi.fn(),
}));

/**
 * Every address the dashboard has published, frozen, each with a concrete
 * address to visit and the page it shows there. A new page is added here in the
 * same change. A page that moves keeps its old address here, and that address
 * must then be one of `formerAddresses`, sent on to the page: the page table
 * and the former addresses together serve exactly this list. Breaking a
 * bookmark takes taking its address out of this list, in plain sight in the
 * diff.
 */
const FROZEN_ADDRESSES: Record<string, { visit: string; page: string }> = {
  "/": { visit: "/", page: "home" },
  "/agents": { visit: "/agents", page: "agents" },
  "/agents/:namespace/:name": { visit: "/agents/dev/a", page: "agent-detail" },
  "/agents/:namespace/:name/run": { visit: "/agents/dev/a/run", page: "playground" },
  "/runs": { visit: "/runs", page: "runs" },
  "/runs/:id": { visit: "/runs/r1", page: "run-detail" },
  "/settings": { visit: "/settings", page: "settings" },
};

/** The address of a page route under the dashboard base: index → "/", else "/" + path. */
function addressOf(route: RouteObject): string {
  return route.index ? "/" : `/${route.path}`;
}

/** The params an address names: `/agents/:namespace/:name` → namespace, name. */
function paramsOf(address: string): string[] {
  return [...address.matchAll(/:(\w+)/g)].map((match) => match[1] ?? "");
}

const liveAddresses = new Set(pageRoutes.map(addressOf));

function shownPages(): string[] {
  return screen.queryAllByText(/^page: /).map((el) => el.textContent?.slice("page: ".length) ?? "");
}

describe("dashboard addresses", () => {
  beforeEach(() => {
    // A plain object, so a `location.href = "/login"` would be observable.
    vi.stubGlobal("location", { href: "" });
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u1", username: "dev", namespace: "dev", role: "admin" },
      isLoading: false,
      isOAuthMode: false,
      logout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("serves exactly the frozen addresses, pages and former addresses together, no more and no fewer", () => {
    const served = [...pageRoutes.map(addressOf), ...formerAddresses.map(({ from }) => `/${from}`)];
    expect(
      served.sort(),
      "A page's address that leaves the page table stays in FROZEN_ADDRESSES and gains a " +
        "formerAddresses entry that sends it on to the page. Taking it out of FROZEN_ADDRESSES " +
        "breaks every bookmark to it: do that only on purpose.",
    ).toEqual(Object.keys(FROZEN_ADDRESSES).sort());
  });

  it("sends every former address to a live page, never to another former address", () => {
    expect(formerAddresses.filter(({ to }) => !liveAddresses.has(to))).toEqual([]);
  });

  it("sends every former address on with no param its old address lacks", () => {
    expect(
      formerAddresses.filter(({ from, to }) =>
        paramsOf(to).some((param) => !paramsOf(from).includes(param)),
      ),
    ).toEqual([]);
  });

  it.each(
    Object.entries(FROZEN_ADDRESSES),
  )("shows the page of %s there, never the fallback to home, never a login redirect", (_address, {
    visit,
    page,
  }) => {
    renderWithProviders(<App />, { route: visit });
    expect({ visit, shown: shownPages() }).toEqual({ visit, shown: [page] });
    expect(window.location.href).toBe("");
  });

  it("falls back to the home page at an unknown address", () => {
    renderWithProviders(<App />, { route: "/no-such-page" });
    expect(shownPages()).toEqual(["home"]);
  });
});

describe("a former address", () => {
  it("lands on the page it names, with the old address's params, replacing it in the history", () => {
    function Where() {
      return (
        <p>
          at: {useLocation().pathname} ({useNavigationType()})
        </p>
      );
    }
    render(
      <MemoryRouter initialEntries={["/old/r1"]}>
        <Routes>
          <Route path="/old/:id" element={<MovedPage to="/runs/:id" />} />
          <Route path="/runs/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("at: /runs/r1 (REPLACE)")).toBeInTheDocument();
  });
});
