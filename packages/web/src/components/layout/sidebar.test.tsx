import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar";

// The foot of the sidebar: "API Docs", then the operator's terms and privacy
// policy when the instance sets them, then "Collapse". The links come from
// GET /api/instance, the only request the sidebar makes.

const TERMS = "https://example.com/legal/terms";
const PRIVACY = "/legal/privacy";
const TERMS_NAME = "Terms (opens in a new tab)";
const PRIVACY_NAME = "Privacy Policy (opens in a new tab)";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => localStorage.clear());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function answering(respond: () => Response) {
  server.use(http.get("/api/instance", respond));
}

function links(values: { docs?: unknown; terms?: unknown; privacy?: unknown }) {
  return () =>
    HttpResponse.json({ links: { docs: "/docs", terms: null, privacy: null, ...values } });
}

/** The sidebar, expanded; the query client, to tell when the read has settled. */
function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** Waits until the read of the instance has an answer or has failed. */
async function settled(client: QueryClient) {
  await waitFor(() =>
    expect(["success", "error"]).toContain(client.getQueryState(["instance"])?.status),
  );
}

function collapse() {
  fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
}

/** The link to the API reference; collapsed, it has no accessible name, so it is found by its address. */
function apiDocs(): HTMLAnchorElement {
  const found = document.querySelector<HTMLAnchorElement>('aside a[href="/docs"]');
  if (!found) throw new Error('no "API Docs" link');
  return found;
}

function legalLinks() {
  return [
    screen.queryByRole("link", { name: TERMS_NAME }),
    screen.queryByRole("link", { name: PRIVACY_NAME }),
  ];
}

/** Whether `a` comes before `b` in the page. */
function comesBefore(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("Sidebar — the operator's terms and privacy policy", () => {
  it("both set: Terms and Privacy under API Docs, before Collapse, opening in a new tab with nothing of the dashboard", async () => {
    answering(links({ terms: TERMS, privacy: PRIVACY }));
    renderSidebar();

    const terms = await screen.findByRole("link", { name: TERMS_NAME });
    const privacy = screen.getByRole("link", { name: PRIVACY_NAME });
    for (const [link, href, label] of [
      [terms, TERMS, "Terms"],
      [privacy, PRIVACY, "Privacy"],
    ] as const) {
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(within(link).getByText(label)).toBeVisible();
      expect(link.querySelector("svg")).toBeVisible();
    }
    const collapseButton = screen.getByRole("button", { name: "Collapse" });
    expect(comesBefore(apiDocs(), terms)).toBe(true);
    expect(comesBefore(terms, privacy)).toBe(true);
    expect(comesBefore(privacy, collapseButton)).toBe(true);
  });

  it("collapsed: the same links, the same names, an icon and no label — three shapes apart from API Docs", async () => {
    answering(links({ terms: TERMS, privacy: PRIVACY }));
    renderSidebar();
    await screen.findByRole("link", { name: TERMS_NAME });

    collapse();

    const terms = screen.getByRole("link", { name: TERMS_NAME });
    const privacy = screen.getByRole("link", { name: PRIVACY_NAME });
    expect(terms.getAttribute("href")).toBe(TERMS);
    expect(privacy.getAttribute("href")).toBe(PRIVACY);
    for (const link of [terms, privacy]) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.textContent).toBe("");
      expect(link.querySelector("svg")).toBeVisible();
    }
    const shapes = [apiDocs(), terms, privacy].map((link) => link.querySelector("svg")?.innerHTML);
    expect(new Set(shapes).size).toBe(3);
  });

  it.each([
    ["terms only", { terms: TERMS }, TERMS_NAME, PRIVACY_NAME],
    ["privacy only", { privacy: PRIVACY }, PRIVACY_NAME, TERMS_NAME],
  ])("%s: one link, and no other", async (_case, values, shown, absent) => {
    answering(links(values));
    const client = renderSidebar();

    expect(await screen.findByRole("link", { name: shown })).toBeInTheDocument();
    await settled(client);
    expect(screen.queryByRole("link", { name: absent })).toBeNull();
  });

  it("the server's default answer: no terms nor privacy link, expanded as collapsed", async () => {
    answering(links({}));
    const client = renderSidebar();
    await settled(client);

    expect(client.getQueryState(["instance"])?.status).toBe("success");
    expect(legalLinks()).toEqual([null, null]);
    collapse();
    expect(legalLinks()).toEqual([null, null]);
  });

  it.each([
    ["a failed connection", () => HttpResponse.error()],
    [
      "a 500 answer",
      () =>
        HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "no" } }, { status: 500 }),
    ],
    ["an answer with no links", () => HttpResponse.json({})],
    ["links that are not strings", links({ terms: { href: TERMS }, privacy: [PRIVACY] })],
  ])("%s: no terms nor privacy link", async (_case, respond) => {
    answering(respond);
    const client = renderSidebar();
    await settled(client);

    expect(legalLinks()).toEqual([null, null]);
    expect(apiDocs().getAttribute("href")).toBe("/docs");
  });

  it("API Docs stays on this server's API reference when the operator sets its own docs", async () => {
    answering(links({ docs: "https://docs.example.com", terms: TERMS }));
    renderSidebar();
    await screen.findByRole("link", { name: TERMS_NAME });

    expect(apiDocs().getAttribute("href")).toBe("/docs");
    expect(screen.getByRole("link", { name: "API Docs" }).getAttribute("href")).toBe("/docs");
  });
});
