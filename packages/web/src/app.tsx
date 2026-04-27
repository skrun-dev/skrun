import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/layout/layout";
import { AgentDetailPage } from "./pages/agent-detail";
import { AgentsPage } from "./pages/agents";
import { HomePage } from "./pages/home";
import { PlaygroundPage } from "./pages/playground";
import { RunDetailPage } from "./pages/run-detail";
import { RunsPage } from "./pages/runs";
import { SettingsPage } from "./pages/settings";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:namespace/:name" element={<AgentDetailPage />} />
        <Route path="agents/:namespace/:name/run" element={<PlaygroundPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
