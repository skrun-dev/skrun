import { generatePath, Navigate, type RouteObject, useParams, useRoutes } from "react-router-dom";
import { Layout } from "./components/layout/layout";
import { AgentDetailPage } from "./pages/agent-detail";
import { AgentsPage } from "./pages/agents";
import { HomePage } from "./pages/home";
import { PlaygroundPage } from "./pages/playground";
import { RunDetailPage } from "./pages/run-detail";
import { RunsPage } from "./pages/runs";
import { SettingsPage } from "./pages/settings";

/**
 * The dashboard's pages, one entry per address under the dashboard base.
 * An address is a contract with every bookmark and link that points at it:
 * a page that moves or goes away keeps its old address in `formerAddresses`.
 * `app.test.tsx` holds this table and `formerAddresses` together to a frozen
 * list of every address published, so an address leaves this table only to
 * become a former address.
 */
export const pageRoutes: RouteObject[] = [
  { index: true, element: <HomePage /> },
  { path: "agents", element: <AgentsPage /> },
  { path: "agents/:namespace/:name", element: <AgentDetailPage /> },
  { path: "agents/:namespace/:name/run", element: <PlaygroundPage /> },
  { path: "runs", element: <RunsPage /> },
  { path: "runs/:id", element: <RunDetailPage /> },
  { path: "settings", element: <SettingsPage /> },
];

export interface FormerAddress {
  /** The old path, written like a `pageRoutes` path (`agents/:namespace/:name/old`). */
  from: string;
  /**
   * The address the page lives at now, as the frozen list writes it
   * (`/agents/:namespace/:name`). Its params are filled from the old address,
   * so it names none that `from` lacks.
   */
  to: string;
}

/** Old addresses of pages that moved, each sent on to the page. None so far. */
export const formerAddresses: readonly FormerAddress[] = [];

/** Sends a former address on to `to`, carrying the old address's params into it. */
export function MovedPage({ to }: { to: string }) {
  const params = useParams();
  return <Navigate to={generatePath(to, params)} replace />;
}

export function App() {
  return useRoutes([
    {
      element: <Layout />,
      children: [
        ...pageRoutes,
        ...formerAddresses.map(({ from, to }) => ({ path: from, element: <MovedPage to={to} /> })),
        // Not an address: anything unknown falls back to the home page.
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}
