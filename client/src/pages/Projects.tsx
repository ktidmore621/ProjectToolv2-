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
const VIEW_STORE = "cat_projects_view";

/**
 * Projects (v2 §1): one nav item, three view states. The Kanban board lost its
 * own nav slot and lives here; the Task List is the new cross-project view.
 * The chosen view sticks for the session; explicit ?view= links (dashboard
 * KPI deep links) always win.
 */
export function Projects() {
  const [params, setParams] = useSearchParams();
  const urlView = params.get("view") as View | null;
  const view: View =
    urlView && VIEWS.some((v) => v.key === urlView)
      ? urlView
      : ((sessionStorage.getItem(VIEW_STORE) as View | null) ?? "list");
  if (urlView) sessionStorage.setItem(VIEW_STORE, urlView);

  function switchTo(v: View) {
    sessionStorage.setItem(VIEW_STORE, v);
    setParams({ view: v }); // drops stale filter params from the previous view
  }

  return (
    <Page
      title="Projects"
      actions={
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
      }
    >
      {view === "list" && <ProjectListView />}
      {view === "kanban" && <PortfolioKanbanView />}
      {view === "tasks" && <TaskListView />}
    </Page>
  );
}
