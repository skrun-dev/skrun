import { render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setAuthToken } from "./api-client";
import { AuthProvider, useAuth } from "./auth";

// Partial-mock api-client so we can assert the auth provider never wires a
// phantom `dev-token` (VT-8, #009). The rest of the module is preserved.
vi.mock("./api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api-client")>();
  return { ...actual, setAuthToken: vi.fn() };
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

function Probe() {
  const { user, isLoading } = useAuth();
  return (
    <div data-testid="state">{isLoading ? "loading" : user ? `user:${user.username}` : "anon"}</div>
  );
}

describe("AuthProvider — no phantom dev-token (VT-8, #009)", () => {
  it("double 401 (dev-auth off): stays anon, never wires dev-token", async () => {
    // No OAuth (oauth:false) + dev-token retry also rejected → both /api/me 401.
    server.use(
      http.get("*/api/me", () =>
        HttpResponse.json({ error: { code: "UNAUTHORIZED", oauth: false } }, { status: 401 }),
      ),
    );
    const { getByTestId } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(getByTestId("state").textContent).toBe("anon"));
    expect(setAuthToken).not.toHaveBeenCalledWith("dev-token");
  });

  it("api error (fetch throws): stays anon, never wires dev-token", async () => {
    server.use(http.get("*/api/me", () => HttpResponse.error()));
    const { getByTestId } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(getByTestId("state").textContent).toBe("anon"));
    expect(setAuthToken).not.toHaveBeenCalledWith("dev-token");
  });
});
