import { Outlet } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { Header } from "./header";
import { Sidebar } from "./sidebar";

export function Layout() {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  // Not logged in → redirect to login (server-rendered page, outside the SPA).
  // Covers both OAuth-configured (no session) and no-OAuth/dev-auth-off (rejected
  // dev-token) instances — neither must render the dashboard for an anonymous visitor.
  if (!user) {
    window.location.href = "/login";
    return null;
  }

  return (
    <div className="h-screen flex bg-white dark:bg-gray-950">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <Header />
        <main className="flex-1 overflow-auto bg-white dark:bg-gray-950">
          <div className="max-w-[1180px] mx-auto px-7 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
