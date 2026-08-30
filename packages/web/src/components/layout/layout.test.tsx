import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../lib/auth";
import { renderWithProviders } from "../../test-utils";
import { Layout } from "./layout";

// Drive the guard deterministically by mocking `useAuth`; keep the rest of the
// module (AuthProvider, used by renderWithProviders) intact.
vi.mock("../../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth")>()),
  useAuth: vi.fn(),
}));

const mockedUseAuth = vi.mocked(useAuth);

function setAuth(value: Partial<ReturnType<typeof useAuth>>) {
  mockedUseAuth.mockReturnValue({
    user: null,
    isLoading: false,
    isOAuthMode: false,
    logout: vi.fn(),
    ...value,
  });
}

describe("Layout auth guard (SC-12)", () => {
  beforeEach(() => {
    // Replace window.location with a plain object so `location.href = "/login"`
    // is observable and does not trigger jsdom's "navigation not implemented".
    vi.stubGlobal("location", { href: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("VT-10: redirects to /login when unauthenticated (no OAuth)", () => {
    setAuth({ isLoading: false, isOAuthMode: false, user: null });
    renderWithProviders(<Layout />);
    expect(window.location.href).toBe("/login");
  });

  it("VT-10b: still redirects in OAuth mode when not logged in (regression)", () => {
    setAuth({ isLoading: false, isOAuthMode: true, user: null });
    renderWithProviders(<Layout />);
    expect(window.location.href).toBe("/login");
  });

  it("VT-loading: shows the spinner and does NOT redirect while loading", () => {
    setAuth({ isLoading: true, user: null });
    renderWithProviders(<Layout />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(window.location.href).toBe("");
  });

  it("VT-11: renders the dashboard for an authenticated user (no redirect, real identity)", () => {
    setAuth({
      isLoading: false,
      isOAuthMode: false,
      user: { id: "u1", username: "dev", namespace: "dev", role: "admin" },
    });
    renderWithProviders(<Layout />);
    expect(window.location.href).toBe("");
    // Header renders the real username — never the removed "Local Dev" fallback.
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.queryByText("Local Dev")).not.toBeInTheDocument();
  });
});
