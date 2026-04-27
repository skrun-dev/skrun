import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
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
    created_at: "2026-04-20T00:00:00Z",
    last_used_at: "2026-04-21T10:00:00Z",
  },
  {
    id: "key-2",
    key_prefix: "sk_live_def2",
    name: "Dashboard key",
    scopes: [],
    created_at: "2026-04-21T00:00:00Z",
    last_used_at: null,
  },
];

const server = setupServer(
  http.get("/api/keys", () => HttpResponse.json(mockKeys)),
  http.post("/api/keys", async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({
      id: "key-3",
      key: "sk_live_full_key_shown_once_abc123def456",
      key_prefix: "sk_live_full",
      name: body.name || "Dashboard key",
      scopes: [],
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
  }),
  http.delete("/api/keys/:id", () => new HttpResponse(null, { status: 204 })),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
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
    await user.click(createButtons[0]!);

    expect(screen.getByText("Create API Key")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. CI pipeline, local dev...")).toBeInTheDocument();
  });

  it("EC-1: shows empty state when no keys", async () => {
    server.use(http.get("/api/keys", () => HttpResponse.json([])));
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("No API keys")).toBeInTheDocument();
    });
  });

  it("EC-2: shows Local Dev profile when no user", async () => {
    renderWithProviders(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("Local Dev")).toBeInTheDocument();
    });
  });
});
