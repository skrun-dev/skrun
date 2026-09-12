import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../test-utils";
import { SettingsPage } from "./settings";

const mockKeys = [
  {
    id: "key-1",
    key_prefix: "sk_live_abc1",
    name: "CI pipeline",
    scopes: [],
    scope_kind: "account",
    created_at: "2026-04-20T00:00:00Z",
    last_used_at: "2026-04-21T10:00:00Z",
    expires_at: "2026-07-19T00:00:00Z",
  },
  {
    id: "key-2",
    key_prefix: "sk_live_def2",
    name: "Dashboard key",
    scopes: ["agent:run"],
    scope_kind: "agents",
    created_at: "2026-04-21T00:00:00Z",
    last_used_at: null,
    // A key with no expiry — the list must say so rather than leave a blank.
    expires_at: null,
  },
];

/** Bodies the mint endpoint actually received — asserted, not inferred. */
const mintedBodies: Array<{ name: string; scope_kind?: string; expires_at?: string }> = [];

const server = setupServer(
  // The dashboard's AuthProvider fetches /api/me on mount; return a real user so the
  // profile renders the authenticated identity (not the removed "Local Dev" fallback).
  http.get("/api/me", () =>
    HttpResponse.json({
      id: "u1",
      username: "alice",
      namespace: "acme",
      email: null,
      avatar_url: null,
      plan: "pro",
      role: "user",
    }),
  ),
  http.get("/api/keys", () => HttpResponse.json(mockKeys)),
  http.get("/api/agents", () =>
    HttpResponse.json({
      agents: [{ id: "a1", namespace: "acme", name: "my-agent" }],
      total: 1,
      page: 1,
      limit: 50,
    }),
  ),
  http.post("/api/keys", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      scope_kind?: string;
      expires_at?: string;
    };
    mintedBodies.push(body);
    return HttpResponse.json({
      id: "key-3",
      key: "sk_live_full_key_shown_once_abc123def456",
      key_prefix: "sk_live_full",
      name: body.name || "Dashboard key",
      scopes: [],
      scope_kind: body.scope_kind ?? "account",
      agents: [],
      created_at: new Date().toISOString(),
      last_used_at: null,
      expires_at: body.expires_at ?? null,
    });
  }),
  http.delete("/api/keys/:id", () => new HttpResponse(null, { status: 204 })),
);

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  mintedBodies.length = 0;
});
afterAll(() => server.close());

describe("SettingsPage", () => {
  it("UAT-1: renders profile and API keys sections", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("Profile")).toBeInTheDocument();
      expect(screen.getByText("API Keys")).toBeInTheDocument();
    });
  });

  it("UAT-3: lists API keys", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("sk_live_abc1...")).toBeInTheDocument();
      expect(screen.getByText("CI pipeline")).toBeInTheDocument();
      expect(screen.getByText("sk_live_def2...")).toBeInTheDocument();
    });
  });

  it("UAT-4: create key dialog opens", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("API Keys")).toBeInTheDocument();
    });

    const createButtons = screen.getAllByText("Create Key");
    const firstButton = createButtons[0];
    if (!firstButton) throw new Error("Expected at least one Create Key button");
    await user.click(firstButton);

    expect(screen.getByText("Create API Key")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. CI pipeline, local dev...")).toBeInTheDocument();
  });

  it("VT-24: scoped keys show a badge; the create dialog exposes Access + Scope pickers", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    // key-2 is agents-scoped → a "Scoped" badge; key-1 (account) has none.
    await waitFor(() => expect(screen.getByText("Scoped")).toBeInTheDocument());

    const createButtons = screen.getAllByText("Create Key");
    const firstButton = createButtons[0];
    if (!firstButton) throw new Error("Expected at least one Create Key button");
    await user.click(firstButton);

    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.getByText("Run-only")).toBeInTheDocument();
    expect(screen.getByText("One agent")).toBeInTheDocument();

    // Picking "One agent" reveals the agent dropdown (fed by /api/agents).
    await user.click(screen.getByText("One agent"));
    await waitFor(() => expect(screen.getByLabelText("Agent")).toBeInTheDocument());
  });

  it("VT-21: the list shows each key's expiry, and an em-dash when there is none", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("CI pipeline")).toBeInTheDocument());
    expect(screen.getByText("Expires")).toBeInTheDocument();

    // Assert inside each key's own row: the em-dash is also used elsewhere on
    // the page, so a page-wide query would prove nothing about this column.
    const rowOf = (keyName: string): HTMLElement => {
      const row = screen.getByText(keyName).closest('[class*="grid-cols-"]');
      if (!(row instanceof HTMLElement)) throw new Error(`No row for ${keyName}`);
      return row;
    };
    const expiryOfKey1 = new Date("2026-07-19T00:00:00Z").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(rowOf("CI pipeline").textContent).toContain(expiryOfKey1);
    expect(rowOf("Dashboard key").textContent).toContain("—");
  });

  it("VT-21: creating a key sends the preselected duration, and 'No expiration' sends none", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByText("API Keys")).toBeInTheDocument());

    const openDialog = async () => {
      const buttons = screen.getAllByText("Create Key");
      const first = buttons[0];
      if (!first) throw new Error("Expected at least one Create Key button");
      await user.click(first);
    };

    await openDialog();
    const selector = screen.getByLabelText("Expiration");
    // 90 days is preselected — the choice a creator gets by doing nothing.
    expect((selector as HTMLSelectElement).value).toBe("90");
    await user.click(screen.getByText("Create"));

    await waitFor(() => expect(mintedBodies).toHaveLength(1));
    const sent = mintedBodies[0]?.expires_at;
    expect(sent).toBeTruthy();
    const days = (new Date(sent as string).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    // Now the explicit gesture: "No expiration" must send no field at all,
    // because the endpoint imposes no default of its own.
    await user.click(screen.getByText("Done"));
    await openDialog();
    await user.selectOptions(screen.getByLabelText("Expiration"), "never");
    await user.click(screen.getByText("Create"));

    await waitFor(() => expect(mintedBodies).toHaveLength(2));
    expect(mintedBodies[1]).not.toHaveProperty("expires_at");
  });

  it("EC-1: shows empty state when no keys", async () => {
    server.use(http.get("/api/keys", () => HttpResponse.json([])));
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("No API keys")).toBeInTheDocument();
    });
  });

  it("VT-12: shows the authenticated user's real identity, not a fake default (inverts old EC-2)", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByText("acme")).toBeInTheDocument(); // namespace
    expect(screen.getByText("pro")).toBeInTheDocument(); // plan
    // The hardcoded "Local Dev" / "free" fallbacks are gone — a null user never
    // renders a fake identity (the Layout guard redirects it to /login instead).
    expect(screen.queryByText("Local Dev")).not.toBeInTheDocument();
    expect(screen.queryByText("free")).not.toBeInTheDocument();
  });
});
