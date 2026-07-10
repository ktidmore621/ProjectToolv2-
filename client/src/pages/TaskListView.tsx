import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtDate, Project, Task } from "../api";
import { ActivityDrawer } from "../components/ActivityDrawer";
import { Card, Chip, EmptyState, inputCls, Mono, Skeleton } from "../components/ui";
import { defaultAssigneeOf, useConfig, useSession } from "../state";

/**
 * Cross-project task list (v2 §1) — every task across every project the user
 * can see, with combinable filters. Filter state lives in the URL so dashboard
 * KPIs can deep-link straight into a pre-filtered view
 * (e.g. /projects?view=tasks&overdue=1).
 */
export function TaskListView() {
  const [params, setParams] = useSearchParams();
  const { users, currentUser } = useSession();
  const { activeValues } = useConfig();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [drawerTask, setDrawerTask] = useState<Task | null>(null);

  // Quick-filter default from the user's Working As settings: applied once per
  // user (so clearing it sticks) and only when the URL doesn't already carry an
  // explicit assignee — deep links keep winning.
  const uid = currentUser?.id;
  const appliedDefaultFor = useRef<number | null>(null);
  useEffect(() => {
    if (uid == null || appliedDefaultFor.current === uid) return;
    appliedDefaultFor.current = uid;
    const def = defaultAssigneeOf(currentUser);
    if (def && params.get("assigned_to") == null) setFilter("assigned_to", def);
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = {
    overdue: params.get("overdue") === "1",
    blocked: params.get("blocked") === "1",
    assigned_to: params.get("assigned_to") ?? "",
    project_id: params.get("project_id") ?? "",
    status_id: params.get("status_id") ?? "",
  };

  function setFilter(key: string, value: string | boolean) {
    const next = new URLSearchParams(params);
    next.set("view", "tasks");
    if (value === false || value === "") next.delete(key);
    else next.set(key, value === true ? "1" : value);
    setParams(next, { replace: true });
  }

  const query = useMemo(() => {
    const qs = new URLSearchParams();
    if (filters.overdue) qs.set("overdue", "1");
    if (filters.blocked) qs.set("blocked", "1");
    if (filters.assigned_to) qs.set("assigned_to", filters.assigned_to);
    if (filters.project_id) qs.set("project_id", filters.project_id);
    if (filters.status_id) qs.set("status_id", filters.status_id);
    return qs.toString();
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTasks(null);
    api.get<Task[]>(`/api/tasks${query ? `?${query}` : ""}`).then(setTasks);
  }, [query]);
  useEffect(() => { api.get<Project[]>("/api/projects?scope=active").then(setProjects); }, []);

  const today = new Date().toISOString().slice(0, 10);
  const toggleCls = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
      on ? "border-accent bg-accent-soft text-accent" : "border-hairline bg-surface text-muted hover:text-ink"
    }`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button className={toggleCls(filters.overdue)} aria-pressed={filters.overdue} onClick={() => setFilter("overdue", !filters.overdue)}>
          Overdue
        </button>
        <button className={toggleCls(filters.blocked)} aria-pressed={filters.blocked} onClick={() => setFilter("blocked", !filters.blocked)}>
          Blocked
        </button>
        <select className={inputCls + " !w-auto"} value={filters.assigned_to} aria-label="Filter by assignee"
          onChange={(e) => setFilter("assigned_to", e.target.value)}>
          <option value="">Assigned to anyone</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className={inputCls + " !w-auto"} value={filters.project_id} aria-label="Filter by project"
          onChange={(e) => setFilter("project_id", e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.mcp_name} · {p.project_code}</option>)}
        </select>
        <select className={inputCls + " !w-auto"} value={filters.status_id} aria-label="Filter by task status"
          onChange={(e) => setFilter("status_id", e.target.value)}>
          <option value="">All statuses</option>
          {activeValues("Task Status").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        {tasks && <span className="ml-auto text-xs text-muted"><Mono>{tasks.length}</Mono> task(s)</span>}
      </div>

      {!tasks ? (
        <Skeleton className="h-96" />
      ) : tasks.length === 0 ? (
        <EmptyState title="No tasks match these filters" hint="Filters combine — try removing one." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {["Task", "Project", "Status", "Assigned To", "Due Date", "Priority", "Activities"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-xs font-semibold text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t, i) => (
                <tr key={t.id} className={`border-b border-hairline last:border-0 ${i % 2 ? "bg-rowalt" : ""} hover:bg-primary-soft/40`}>
                  <td className="px-3 py-2">
                    <Link to={`/projects/${t.project_id}`} className="font-medium hover:underline">{t.name}</Link>
                    {t.latest_note && <div className="mt-0.5 line-clamp-1 max-w-md text-xs text-muted">{t.latest_note.note}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Link to={`/projects/${t.project_id}`} className="hover:underline">{t.mcp_name}</Link>
                    <span className="ml-1.5 text-xs text-muted"><Mono>{t.project_code}</Mono></span>
                  </td>
                  <td className="px-3 py-2"><Chip label={t.status_label} color={t.status_color} small /></td>
                  <td className="px-3 py-2">{t.assigned_to_name ?? <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2">
                    <Mono className={t.due_date && t.due_date < today && !["complete", "skipped", "cancelled"].includes(t.status_key ?? "") ? "text-rag-red" : ""}>
                      {fmtDate(t.due_date)}
                    </Mono>
                  </td>
                  <td className="px-3 py-2">{t.priority_label ? <Chip label={t.priority_label} color={t.priority_color!} small /> : <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2"><ActivityCountButton task={t} onOpen={() => setDrawerTask(t)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {drawerTask && (
        <ActivityDrawer taskId={drawerTask.id} taskName={drawerTask.name} onClose={() => setDrawerTask(null)}
          onChanged={() => api.get<Task[]>(`/api/tasks${query ? `?${query}` : ""}`).then(setTasks)} />
      )}
    </>
  );
}

/** Clickable linked-activity count (v2 §6) — shared by both task list surfaces. */
export function ActivityCountButton({ task, onOpen }: { task: Task; onOpen: () => void }) {
  if (!task.activity_count) return <span className="text-muted">—</span>;
  return (
    <button
      onClick={onOpen}
      aria-label={`${task.activity_count} linked activities for ${task.name}`}
      className="rounded-full bg-accent-soft px-2.5 py-0.5 font-mono text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
    >
      {task.activity_count}
    </button>
  );
}
