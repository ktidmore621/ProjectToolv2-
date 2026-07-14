import { useSearchParams } from "react-router-dom";
import { Page } from "../components/Layout";
import { PortfolioKanbanView } from "./PortfolioKanban";
import { ProjectListView } from "./ProjectList";
import { TaskListView } from "./TaskListView";

type View = "list" | "kanban" | "tasks";
const VIEWS: { key: View; label: string; icon: string }[] = [
  { key: "list", label: "Project List", icon: "▤" },
  { key: "kanban", label: "Kanban", icon: "▥" },
  { key: "tasks", label: "Task List", icon: "☰" },
];

/**
 * Projects (v2 §1): one nav item, three view states. The Kanban board lost its
 * own nav slot and lives here; the Task List is the new cross-project view.
 * The active view lives only in the URL (?view=), so clicking Projects in the
 * nav always opens the default Project List; explicit ?view= links (dashboard
 * KPI deep links) still land on the right view. The toggle sits at the front
 * of each view's filter row — ahead of the search field — so it's easy to find.
 */
export function Projects() {
  const [params, setParams] = useSearchParams();
  const urlView = params.get("view") as View | null;
  const view: View = urlView && VIEWS.some((v) => v.key === urlView) ? urlView : "list";

  function switchTo(v: View) {
    setParams({ view: v }); // drops stale filter params from the previous view
  }

  const toggle = (
    <div className="flex items-center rounded-lg border border-hairline bg-surface p-0.5" role="tablist" aria-label="Projects view">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          role="tab"
          aria-selected={view === v.key}
          title={v.label}
          onClick={() => switchTo(v.key)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            view === v.key ? "bg-primary-soft text-primary" : "text-muted hover:text-ink"
          }`}
        >
          <span aria-hidden>{v.icon}</span>
          {v.label}
        </button>
      ))}
    </div>
  );

  return (
    <Page title="Projects">
      {view === "list" && <ProjectListView toolbar={toggle} />}
      {view === "kanban" && <PortfolioKanbanView toolbar={toggle} />}
      {view === "tasks" && <TaskListView toolbar={toggle} />}
    </Page>
  );
}
