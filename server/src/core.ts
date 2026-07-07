import { db, getSettingNum } from "./db.js";

export interface PickValue {
  id: number;
  picklist_id: number;
  label: string;
  sort_order: number;
  color: string;
  is_active: number;
  is_default: number;
  maps_to: string | null;
}

export function picklistByName(name: string) {
  return db.prepare("SELECT * FROM picklists WHERE name = ?").get(name) as
    | { id: number; name: string; object_type: string; is_system: number }
    | undefined;
}

export function valuesFor(picklistName: string): PickValue[] {
  return db
    .prepare(
      `SELECT pv.* FROM picklist_values pv
       JOIN picklists p ON p.id = pv.picklist_id
       WHERE p.name = ? ORDER BY pv.sort_order, pv.id`
    )
    .all(picklistName) as PickValue[];
}

export function valueByMapsTo(picklistName: string, mapsTo: string): PickValue | undefined {
  return valuesFor(picklistName).find((v) => v.maps_to === mapsTo);
}

export function defaultValue(picklistName: string): PickValue | undefined {
  const vals = valuesFor(picklistName);
  return vals.find((v) => v.is_default) ?? vals[0];
}

export function valueById(id: number | null | undefined): PickValue | undefined {
  if (id == null) return undefined;
  return db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(id) as PickValue | undefined;
}

/** System keys for statuses that count as "not active". */
export const CLOSED_KEYS = ["closed", "cancelled"];
export const DONE_TASK_KEYS = ["complete", "skipped", "cancelled"];

export function isClosedStatus(statusId: number): boolean {
  const v = valueById(statusId);
  return !!v && CLOSED_KEYS.includes(v.maps_to ?? "");
}

export function logActivity(opts: {
  project_id: number;
  project_task_id?: number | null;
  user_id?: number | null;
  kind?: string;
  category_id?: number | null;
  note?: string;
  old_status?: string | null;
  new_status?: string | null;
}) {
  db.prepare(
    `INSERT INTO activities (project_id, project_task_id, user_id, kind, category_id, note, old_status, new_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.project_id,
    opts.project_task_id ?? null,
    opts.user_id ?? null,
    opts.kind ?? "note",
    opts.category_id ?? null,
    opts.note ?? "",
    opts.old_status ?? null,
    opts.new_status ?? null
  );
}

export function nextProjectCode(): string {
  const row = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  return `CAP-${String(row.n + 1).padStart(4, "0")}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Generate project tasks from a template (snapshot at creation — later template
 * edits never touch this project). Conditional action-plan tasks are copied too,
 * but hidden behind conditional_pending until the decision task answers Yes.
 */
export function generateTasksFromTemplate(projectId: number, templateId: number, assignmentDate: string) {
  const notStarted = valueByMapsTo("Task Status", "not_started");
  const tasks = db
    .prepare("SELECT * FROM template_tasks WHERE template_id = ? ORDER BY step_order")
    .all(templateId) as any[];
  const ins = db.prepare(
    `INSERT INTO project_tasks (project_id, template_task_id, name, description, task_type, step_order,
        due_date, status_id, priority_id, required, is_decision, conditional_pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of tasks) {
    const conditional = t.generation === "action_plan" ? 1 : 0;
    ins.run(
      projectId,
      t.id,
      t.name,
      t.description ?? "",
      conditional ? "action_plan" : "standard",
      t.step_order,
      conditional ? null : addDays(assignmentDate, t.due_offset),
      notStarted!.id,
      t.default_priority_id ?? null,
      t.required,
      t.is_decision,
      conditional
    );
  }
}

/** Closure requirements per §4.8. Returns list of unmet requirements. */
export function closureProblems(projectId: number, body: { final_summary?: string | null; close_reason_id?: number | null }): string[] {
  const problems: string[] = [];
  const doneIds = valuesFor("Task Status")
    .filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? ""))
    .map((v) => v.id);
  const open = db
    .prepare(
      `SELECT name FROM project_tasks
       WHERE project_id = ? AND required = 1 AND conditional_pending = 0
         AND status_id NOT IN (${doneIds.map(() => "?").join(",")})`
    )
    .all(projectId, ...doneIds) as { name: string }[];
  for (const t of open) problems.push(`Required task not complete: "${t.name}"`);

  const reqRules = db
    .prepare(
      `SELECT field_name, label FROM field_requirements
       WHERE object_type = 'project' AND required = 1 AND required_at IN ('closure','always')`
    )
    .all() as { field_name: string; label: string }[];
  for (const r of reqRules) {
    if (r.field_name === "final_summary" && !body.final_summary?.trim())
      problems.push(`${r.label} is required at closure`);
    if (r.field_name === "close_reason_id" && !body.close_reason_id)
      problems.push(`${r.label} is required at closure`);
  }
  return problems;
}

/** RAG engine per §4.7 — thresholds live in settings, override wins. */
export function computeRag(project: any): { rag: "red" | "amber" | "green"; reason: string; overridden: boolean } {
  if (project.rag_override) {
    return { rag: project.rag_override, reason: project.rag_override_reason || "Manual override", overridden: true };
  }
  const statusVal = valueById(project.status_id);
  if (CLOSED_KEYS.includes(statusVal?.maps_to ?? "")) {
    return { rag: "green", reason: "Project closed", overridden: false };
  }
  const redOverdue = getSettingNum("rag_red_overdue_days", 3);
  const amberDue = getSettingNum("rag_amber_due_days", 3);
  const stallDays = getSettingNum("rag_stall_days", 7);
  const today = new Date().toISOString().slice(0, 10);

  const doneIds = valuesFor("Task Status")
    .filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? ""))
    .map((v) => v.id);
  const blockedId = valueByMapsTo("Task Status", "blocked")?.id;

  const tasks = db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? AND conditional_pending = 0")
    .all(project.id) as any[];
  const openTasks = tasks.filter((t) => !doneIds.includes(t.status_id));

  if (blockedId && openTasks.some((t) => t.status_id === blockedId))
    return { rag: "red", reason: "A task is blocked", overridden: false };

  const daysBetween = (a: string, b: string) =>
    Math.floor((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);

  for (const t of openTasks) {
    if (t.required && t.due_date && daysBetween(t.due_date, today) >= redOverdue)
      return { rag: "red", reason: `Required task "${t.name}" overdue ${daysBetween(t.due_date, today)}d`, overridden: false };
  }
  if (project.target_date && project.target_date < today)
    return { rag: "red", reason: "Project target date missed", overridden: false };

  for (const t of openTasks) {
    if (t.due_date && t.due_date >= today && daysBetween(today, t.due_date) <= amberDue)
      return { rag: "amber", reason: `Task "${t.name}" due within ${amberDue}d`, overridden: false };
    if (t.due_date && t.due_date < today)
      return { rag: "amber", reason: `Task "${t.name}" overdue`, overridden: false };
  }
  const lastAct = db
    .prepare("SELECT MAX(activity_date) AS d FROM activities WHERE project_id = ?")
    .get(project.id) as { d: string | null };
  const lastDate = (lastAct.d ?? project.created_date).slice(0, 10);
  if (daysBetween(lastDate, today) >= stallDays)
    return { rag: "amber", reason: `No update for ${daysBetween(lastDate, today)}d`, overridden: false };

  return { rag: "green", reason: "On track", overridden: false };
}

const userName = db.prepare("SELECT name FROM users WHERE id = ?");

/** Full project payload used by list/detail/kanban views. */
export function serializeProject(p: any, opts: { withTasks?: boolean } = {}) {
  const status = valueById(p.status_id);
  const risk = valueById(p.risk_level_id);
  const closeReason = valueById(p.close_reason_id);
  const assignee = userName.get(p.assignee_id) as { name: string } | undefined;
  const closedBy = p.closed_by ? (userName.get(p.closed_by) as { name: string } | undefined) : undefined;
  const rag = computeRag(p);
  const ragVal = valueByMapsTo("RAG Status", rag.rag);

  const doneIds = valuesFor("Task Status")
    .filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? ""))
    .map((v) => v.id);
  const taskRows = db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? AND conditional_pending = 0 ORDER BY step_order, id")
    .all(p.id) as any[];
  const openTasks = taskRows.filter((t) => !doneIds.includes(t.status_id));
  const nextDue = openTasks
    .filter((t) => t.due_date)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];

  const statusChanged = (p.status_changed_date ?? p.created_date).slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const daysInStatus = Math.max(
    0,
    Math.floor((new Date(today + "T00:00:00Z").getTime() - new Date(statusChanged + "T00:00:00Z").getTime()) / 86400000)
  );

  return {
    id: p.id,
    project_code: p.project_code,
    mcp_number: p.mcp_number,
    mcp_name: p.mcp_name,
    assignee_id: p.assignee_id,
    assignee_name: assignee?.name ?? "—",
    assignment_date: p.assignment_date,
    target_date: p.target_date,
    template_id: p.template_id,
    status_id: p.status_id,
    status_label: status?.label ?? "—",
    status_color: status?.color ?? "#64748B",
    status_key: status?.maps_to ?? null,
    risk_level_id: p.risk_level_id,
    risk_label: risk?.label ?? null,
    risk_color: risk?.color ?? null,
    rag: rag.rag,
    rag_reason: rag.reason,
    rag_overridden: rag.overridden,
    rag_color: ragVal?.color ?? "#4E9468",
    rag_label: ragVal?.label ?? rag.rag,
    created_date: p.created_date,
    closed_date: p.closed_date,
    closed_by_name: closedBy?.name ?? null,
    close_reason_id: p.close_reason_id,
    close_reason_label: closeReason?.label ?? null,
    final_summary: p.final_summary,
    is_closed: CLOSED_KEYS.includes(status?.maps_to ?? ""),
    days_in_status: daysInStatus,
    open_task_count: openTasks.length,
    task_count: taskRows.length,
    next_due_task: nextDue ? { name: nextDue.name, due_date: nextDue.due_date } : null,
    tasks: opts.withTasks ? taskRows.map(serializeTask) : undefined,
  };
}

export function serializeTask(t: any) {
  const status = valueById(t.status_id);
  const priority = valueById(t.priority_id);
  const assigned = t.assigned_to ? (userName.get(t.assigned_to) as { name: string } | undefined) : undefined;
  const completedBy = t.completed_by ? (userName.get(t.completed_by) as { name: string } | undefined) : undefined;
  return {
    ...t,
    status_label: status?.label ?? "—",
    status_color: status?.color ?? "#64748B",
    status_key: status?.maps_to ?? null,
    priority_label: priority?.label ?? null,
    priority_color: priority?.color ?? null,
    assigned_to_name: assigned?.name ?? null,
    completed_by_name: completedBy?.name ?? null,
  };
}
