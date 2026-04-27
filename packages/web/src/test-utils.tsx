import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  { route = "/", ...options }: RenderOptions & { route?: string } = {},
) {
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient };
}
