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

/**
 * E6: all date-based calculations and status determinations run on Central
 * Time via the IANA zone America/Chicago — NOT a hardcoded UTC-6 offset.
 * Central observes DST (CDT, UTC-5) from March to November; a fixed offset
 * would be an hour off for two-thirds of the year and silently flip
 * due/overdue determinations around midnight. Intl handles the transitions.
 */
const CENTRAL_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Central Time, as YYYY-MM-DD. */
export function todayCentral(): string {
  return CENTRAL_DATE.format(new Date());
}

/** Strict calendar-date check: YYYY-MM-DD format AND a real day (rejects 2026-02-30). */
export function isIsoDate(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Round-trip guards against Date rolling 2026-02-30 over to March 2nd
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
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
}): number {
  return db.prepare(
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
  ).lastInsertRowid as number;
}

export function nextProjectCode(): string {
  // Atomic increment of a dedicated sequence (B3). COUNT(*)+1 collided as soon
  // as a project was deleted or two creates raced the unique constraint.
  const row = db
    .prepare("UPDATE counters SET value = value + 1 WHERE key = 'project_code' RETURNING value")
    .get() as { value: number };
  return `CAP-${String(row.value).padStart(4, "0")}`;
}

/** '$0,000.00' — the one AP/currency format used across tables, cards, headers and CSVs. */
export function fmtCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "";
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** '$4,200.00', '4200', '4,200' → 4200; null when blank; NaN when unparseable. */
export function parseCurrency(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  return Number(String(raw).replace(/[$,\s]/g, ""));
}

// ---------- Dynamic (custom) fields — one engine for projects and tasks (E9) ----------

export interface CustomField {
  id: number;
  object_type: string;
  label: string;
  field_key: string;
  field_type: "text" | "number" | "currency" | "date" | "dropdown" | "checkbox";
  picklist_id: number | null;
  is_active: number;
  sort_order: number;
}

/**
 * Where each object type stores its custom values. Adding a new object type
 * here (plus its table in db.ts) is all the engine needs — validation,
 * persistence, serialization and the B1 picklist-deletion check all read
 * from this map.
 */
export const CUSTOM_VALUE_STORES = {
  project: { table: "project_custom_values", fk: "project_id" },
  task: { table: "task_custom_values", fk: "task_id" },
} as const;
export type CustomObjectType = keyof typeof CUSTOM_VALUE_STORES;

export function activeCustomFields(objectType: CustomObjectType = "project"): CustomField[] {
  return db
    .prepare("SELECT * FROM custom_fields WHERE object_type = ? AND is_active = 1 ORDER BY sort_order, id")
    .all(objectType) as CustomField[];
}

/** Validate one raw value against its field definition → canonical stored text or an error. */
export function parseCustomValue(field: CustomField, raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { ok: true, value: null };
  const s = String(raw).trim();
  switch (field.field_type) {
    case "text":
      return { ok: true, value: s };
    case "number": {
      const n = Number(s.replace(/,/g, ""));
      if (!Number.isFinite(n)) return { ok: false, error: `${field.label} must be a number` };
      return { ok: true, value: String(n) };
    }
    case "currency": {
      const n = parseCurrency(s);
      if (n == null || !Number.isFinite(n) || n < 0) return { ok: false, error: `${field.label} must be a dollar amount` };
      return { ok: true, value: n.toFixed(2) };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: `${field.label} must be YYYY-MM-DD` };
      return { ok: true, value: s };
    }
    case "checkbox": {
      if (raw === true || ["1", "true", "yes", "y", "x"].includes(s.toLowerCase())) return { ok: true, value: "1" };
      if (raw === false || ["0", "false", "no", "n"].includes(s.toLowerCase())) return { ok: true, value: "0" };
      return { ok: false, error: `${field.label} must be Yes or No` };
    }
    case "dropdown": {
      const opts = field.picklist_id
        ? (db.prepare("SELECT * FROM picklist_values WHERE picklist_id = ?").all(field.picklist_id) as PickValue[])
        : [];
      const match = opts.find((v) => String(v.id) === s) ?? opts.find((v) => v.label.toLowerCase() === s.toLowerCase());
      if (!match) return { ok: false, error: `${field.label}: unknown option "${s}"` };
      return { ok: true, value: String(match.id) };
    }
    default:
      return { ok: false, error: `${field.label} has an unsupported type` };
  }
}

/**
 * Validate a { field_key: raw } map from a create/edit form or import row.
 * `flat` mirrors the parsed values keyed by field_key so field_requirements
 * checks can treat custom fields exactly like built-in ones.
 *
 * `partial: true` (edits) only parses fields present in the map — a PATCH
 * that sends one field must not null out the others. Without it (creation),
 * every active field is parsed and missing ones store null.
 */
export function validateCustomValues(
  objectType: CustomObjectType,
  bodyCustom: Record<string, unknown> | null | undefined,
  opts: { partial?: boolean } = {}
): {
  errors: string[];
  parsed: Map<number, string | null>;
  flat: Record<string, string | null>;
} {
  const errors: string[] = [];
  const parsed = new Map<number, string | null>();
  const flat: Record<string, string | null> = {};
  for (const f of activeCustomFields(objectType)) {
    if (opts.partial && !(bodyCustom && f.field_key in bodyCustom)) continue;
    const raw = bodyCustom?.[f.field_key];
    const r = parseCustomValue(f, raw);
    if (r.ok) {
      parsed.set(f.id, r.value);
      flat[f.field_key] = r.value;
    } else errors.push(r.error);
  }
  return { errors, parsed, flat };
}

export function saveCustomValues(objectType: CustomObjectType, ownerId: number, parsed: Map<number, string | null>) {
  const { table, fk } = CUSTOM_VALUE_STORES[objectType];
  const ins = db.prepare(
    `INSERT INTO ${table} (${fk}, field_id, value) VALUES (?, ?, ?)
     ON CONFLICT(${fk}, field_id) DO UPDATE SET value = excluded.value`
  );
  for (const [fieldId, value] of parsed) ins.run(ownerId, fieldId, value);
}

export interface CustomValueOut {
  type: CustomField["field_type"];
  value: string | null;
  option_label: string | null;
  option_color: string | null;
}

/** { field_key: {type, value, option_label, option_color} } for one record — what every view renders from. */
export function serializeCustomValues(objectType: CustomObjectType, ownerId: number): Record<string, CustomValueOut> {
  const fields = activeCustomFields(objectType);
  if (!fields.length) return {};
  const { table, fk } = CUSTOM_VALUE_STORES[objectType];
  const rows = db
    .prepare(`SELECT field_id, value FROM ${table} WHERE ${fk} = ?`)
    .all(ownerId) as { field_id: number; value: string | null }[];
  const byField = new Map(rows.map((r) => [r.field_id, r.value]));
  const out: Record<string, CustomValueOut> = {};
  for (const f of fields) {
    const value = byField.get(f.id) ?? null;
    const opt = f.field_type === "dropdown" && value ? valueById(Number(value)) : undefined;
    out[f.field_key] = {
      type: f.field_type,
      value,
      option_label: opt?.label ?? null,
      option_color: opt?.color ?? null,
    };
  }
  return out;
}

/** Display text for CSV exports — dropdown label, Yes/No, formatted currency, raw otherwise. */
export function customCsvValue(v: CustomValueOut | undefined): string {
  if (!v || v.value == null) return "";
  switch (v.type) {
    case "dropdown": return v.option_label ?? "";
    case "checkbox": return v.value === "1" ? "Yes" : "No";
    case "currency": return fmtCurrency(Number(v.value));
    default: return v.value;
  }
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Generate project tasks from a template (snapshot at creation — later template
 * edits never touch this project). Every generated task starts assigned to the
 * project assignee.
 */
export function generateTasksFromTemplate(projectId: number, templateId: number, assignmentDate: string, assigneeId: number | null = null) {
  const notStarted = valueByMapsTo("Task Status", "not_started");
  const tasks = db
    .prepare("SELECT * FROM template_tasks WHERE template_id = ? ORDER BY step_order")
    .all(templateId) as any[];
  const ins = db.prepare(
    `INSERT INTO project_tasks (project_id, template_task_id, name, description, task_type, step_order,
        assigned_to, due_date, status_id, priority_id, required)
     VALUES (?, ?, ?, ?, 'standard', ?, ?, ?, ?, ?, ?)`
  );
  for (const t of tasks) {
    ins.run(
      projectId,
      t.id,
      t.name,
      t.description ?? "",
      t.step_order,
      assigneeId,
      addDays(assignmentDate, t.due_offset),
      notStarted!.id,
      t.default_priority_id ?? null,
      t.required
    );
  }
}

/**
 * Closure requirements per §4.8. Returns list of unmet requirements.
 * E4: required tasks must be Complete (or deleted) going forward — but
 * legacy Skipped/Cancelled tasks still satisfy closure (DONE_TASK_KEYS keeps
 * 'skipped'), so projects with historically skipped tasks are not
 * retroactively invalidated. Skipped can no longer be newly assigned.
 */
export function closureProblems(
  projectId: number,
  body: { final_summary?: string | null; close_reason_id?: number | null },
  opts: { cancelled?: boolean } = {}
): string[] {
  // E5: cancellation follows the same closure processing but different inputs —
  // Close Reason is required, Final Summary is optional (a cancelled project
  // often has no outcome to summarize), and incomplete required tasks don't
  // block: cancellation is precisely how abandoned work gets recorded.
  if (opts.cancelled) {
    return body.close_reason_id ? [] : ["Close Reason is required to cancel a project"];
  }
  const problems: string[] = [];
  const doneIds = valuesFor("Task Status")
    .filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? ""))
    .map((v) => v.id);
  const open = db
    .prepare(
      `SELECT name FROM project_tasks
       WHERE project_id = ? AND required = 1
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
  const today = todayCentral(); // E6: due/overdue flips at Central midnight, not UTC's

  const doneIds = valuesFor("Task Status")
    .filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? ""))
    .map((v) => v.id);
  const blockedId = valueByMapsTo("Task Status", "blocked")?.id;

  const tasks = db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ?")
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
    return { rag: "red", reason: "Estimated completion date missed", overridden: false };

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
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY step_order, id")
    .all(p.id) as any[];
  const openTasks = taskRows.filter((t) => !doneIds.includes(t.status_id));
  const nextDue = openTasks
    .filter((t) => t.due_date)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];

  const statusChanged = (p.status_changed_date ?? p.created_date).slice(0, 10);
  const today = todayCentral();
  const daysInStatus = Math.max(
    0,
    Math.floor((new Date(today + "T00:00:00Z").getTime() - new Date(statusChanged + "T00:00:00Z").getTime()) / 86400000)
  );

  return {
    id: p.id,
    project_code: p.project_code,
    mcp_number: p.mcp_number,
    mcp_name: p.mcp_name,
    project_name: p.project_name ?? null,
    assignee_id: p.assignee_id,
    assignee_name: assignee?.name ?? "—",
    annualized_premium: p.annualized_premium,
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
    custom: serializeCustomValues("project", p.id),
    tasks: opts.withTasks ? taskRows.map(serializeTask) : undefined,
  };
}

const taskActivityCount = db.prepare("SELECT COUNT(*) AS n FROM task_activity_links WHERE project_task_id = ?");
const taskNoteCount = db.prepare("SELECT COUNT(*) AS n FROM activities WHERE project_task_id = ? AND kind = 'note'");
const taskLatestNote = db.prepare(
  `SELECT a.note, a.activity_date, u.name AS user_name FROM activities a
   LEFT JOIN users u ON u.id = a.user_id
   WHERE a.project_task_id = ? AND a.kind = 'note'
   ORDER BY a.activity_date DESC, a.id DESC LIMIT 1`
);

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
    activity_count: (taskActivityCount.get(t.id) as { n: number }).n,
    note_count: (taskNoteCount.get(t.id) as { n: number }).n,
    latest_note: (taskLatestNote.get(t.id) as { note: string; activity_date: string; user_name: string | null } | undefined) ?? null,
    custom: serializeCustomValues("task", t.id), // E9
  };
}

/** Minutes between 'HH:MM' start/end times (same day); null when either is missing. */
export function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return null;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return Math.max(0, m(end) - m(start));
}

const linkedTasksFor = db.prepare(
  `SELECT pt.id, pt.name FROM task_activity_links l
   JOIN project_tasks pt ON pt.id = l.project_task_id
   WHERE l.activity_id = ? ORDER BY pt.step_order, pt.id`
);

export function serializeActivity(a: any) {
  const user = a.user_id ? (userName.get(a.user_id) as { name: string } | undefined) : undefined;
  const cat = valueById(a.category_id);
  const type = valueById(a.activity_type_id);
  const task = a.project_task_id
    ? (db.prepare("SELECT name FROM project_tasks WHERE id = ?").get(a.project_task_id) as { name: string } | undefined)
    : undefined;
  const project = db
    .prepare("SELECT project_code, mcp_name FROM projects WHERE id = ?")
    .get(a.project_id) as { project_code: string; mcp_name: string } | undefined;
  return {
    ...a,
    user_name: user?.name ?? "System",
    category_label: cat?.label ?? null,
    category_color: cat?.color ?? null,
    activity_type_label: type?.label ?? null,
    activity_type_color: type?.color ?? null,
    activity_type_key: type?.maps_to ?? null,
    duration_minutes: durationMinutes(a.start_time, a.end_time),
    task_name: task?.name ?? null,
    project_code: project?.project_code ?? null,
    mcp_name: project?.mcp_name ?? null,
    linked_tasks: linkedTasksFor.all(a.id),
  };
}

export function serializeWin(w: any) {
  const cat = valueById(w.category_id);
  const project = db
    .prepare("SELECT project_code, mcp_name, mcp_number, annualized_premium FROM projects WHERE id = ?")
    .get(w.project_id) as { project_code: string; mcp_name: string; mcp_number: string; annualized_premium: number | null } | undefined;
  const loggedBy = w.logged_by ? (userName.get(w.logged_by) as { name: string } | undefined) : undefined;
  return {
    ...w,
    category_label: cat?.label ?? null,
    category_color: cat?.color ?? null,
    category_key: cat?.maps_to ?? null,
    project_code: project?.project_code ?? null,
    mcp_name: project?.mcp_name ?? null,
    mcp_number: project?.mcp_number ?? null,
    annualized_premium: project?.annualized_premium ?? null,
    logged_by_name: loggedBy?.name ?? null,
  };
}
