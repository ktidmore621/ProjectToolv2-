import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Configuration } from "./pages/Configuration";
import { Dashboard } from "./pages/Dashboard";
import { History } from "./pages/History";
import { PortfolioKanban } from "./pages/PortfolioKanban";
import { ProjectDetail } from "./pages/ProjectDetail";
import { ProjectList } from "./pages/ProjectList";
import { TeamTimecard } from "./pages/TeamTimecard";
import { Timecard } from "./pages/Timecard";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<ProjectList />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/kanban" element={<PortfolioKanban />} />
        <Route path="/timecard" element={<Timecard />} />
        <Route path="/team-timecard" element={<TeamTimecard />} />
        <Route path="/history" element={<History />} />
        <Route path="/config/*" element={<Configuration />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
