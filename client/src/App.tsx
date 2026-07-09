import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Configuration } from "./pages/Configuration";
import { Dashboard } from "./pages/Dashboard";
import { History } from "./pages/History";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Projects } from "./pages/Projects";
import { TeamTimecard } from "./pages/TeamTimecard";
import { Timecard } from "./pages/Timecard";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        {/* v1's standalone Kanban nav item merged into Projects (v2 §1) */}
        <Route path="/kanban" element={<Navigate to="/projects?view=kanban" replace />} />
        <Route path="/timecard" element={<Timecard />} />
        <Route path="/team-timecard" element={<TeamTimecard />} />
        <Route path="/history" element={<History />} />
        <Route path="/config/*" element={<Configuration />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
