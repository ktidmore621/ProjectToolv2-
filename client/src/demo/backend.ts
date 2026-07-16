/**
 * In-browser "server" for the standalone demo build — a faithful port of the
 * Express routes in server/src/routes/*. Every business rule (one active
 * project per MCP, closure requirements, skip-requires-reason, soft warnings,
 * RAG engine, deactivate-not-delete) behaves identically; the data just
 * lives in this browser.
 */
import {
  db, generateTasksFromTemplate, logActivity, nextId, now, resetDemoData, Row,
  save, valueById, valueByMapsTo, valuesFor,
} from "./db";

export { resetDemoData };

const CLOSED_KEYS = ["closed", "cancelled"];
const DONE_TASK_KEYS = ["complete", "skipped", "cancelled"];

interface Res { status: number; data: any }
const ok = (data: any, status = 200): Res => ({ status, data: clone(data) });
const err = (status: number, error: string, extra: any = {}): Res => ({ status, data: { error, ...extra } });
const clone = (x: any) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

// E6: date-based determinations run on Central Time via the IANA zone (DST-aware)
const CENTRAL_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
const today = () => CENTRAL_DATE.format(new Date());
const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
const settingNum = (key: string, fallback: number) => {
  const n = Number(db.settings[key]);
  return Number.isFinite(n) ? n : fallback;
};
const userName = (id: number | null | undefined) => db.users.find((u) => u.id === id)?.name;

/** B3: sequence-style project codes — never derived from the row count. */
function nextProjectCode(): string {
  const stored = Number(db.settings.project_code_seq ?? 0);
  const maxExisting = Math.max(0, ...db.projects.map((p) => Number(String(p.project_code).slice(4)) || 0));
  const next = Math.max(stored, maxExisting) + 1;
  db.settings.project_code_seq = String(next);
  return `CAP-${String(next).padStart(4, "0")}`;
}
const isClosedStatus = (statusId: number) => CLOSED_KEYS.includes(valueById(statusId)?.maps_to ?? "");
/** Strict calendar-date check: YYYY-MM-DD format AND a real day (rejects 2026-02-30). */
const isIsoDate = (s: unknown): boolean => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  // Round-trip guards against Date rolling 2026-02-30 over to March 2nd
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const doneStatusIds = () => valuesFor("Task Status").filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
const activeStatusIds = () => valuesFor("Project Status").filter((v) => !CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);

// ---------------- core serialization (port of server/src/core.ts) ----------------

function computeRag(p: Row): { rag: string; reason: string; overridden: boolean } {
  if (p.rag_override) return { rag: p.rag_override, reason: p.rag_override_reason || "Manual override", overridden: true };
  if (isClosedStatus(p.status_id)) return { rag: "green", reason: "Project closed", overridden: false };
  const redOverdue = settingNum("rag_red_overdue_days", 3);
  const amberDue = settingNum("rag_amber_due_days", 3);
  const stallDays = settingNum("rag_stall_days", 7);
  const t = today();
  const done = doneStatusIds();
  const blockedId = valueByMapsTo("Task Status", "blocked")?.id;
  const tasks = db.project_tasks.filter((x) => x.project_id === p.id);
  const open = tasks.filter((x) => !done.includes(x.status_id));

  if (blockedId && open.some((x) => x.status_id === blockedId))
    return { rag: "red", reason: "A task is blocked", overridden: false };
  for (const x of open)
    if (x.required && x.due_date && daysBetween(x.due_date, t) >= redOverdue)
      return { rag: "red", reason: `Required task "${x.name}" overdue ${daysBetween(x.due_date, t)}d`, overridden: false };
  if (p.target_date && p.target_date < t)
    return { rag: "red", reason: "Estimated completion date missed", overridden: false };
  for (const x of open) {
    if (x.due_date && x.due_date >= t && daysBetween(t, x.due_date) <= amberDue)
      return { rag: "amber", reason: `Task "${x.name}" due within ${amberDue}d`, overridden: false };
    if (x.due_date && x.due_date < t)
      return { rag: "amber", reason: `Task "${x.name}" overdue`, overridden: false };
  }
  const acts = db.activities.filter((a) => a.project_id === p.id).map((a) => a.activity_date);
  const last = (acts.length ? acts.reduce((a, b) => (a > b ? a : b)) : p.created_date).slice(0, 10);
  if (daysBetween(last, t) >= stallDays)
    return { rag: "amber", reason: `No update for ${daysBetween(last, t)}d`, overridden: false };
  return { rag: "green", reason: "On track", overridden: false };
}

function serializeTask(t: Row) {
  const status = valueById(t.status_id);
  const priority = valueById(t.priority_id);
  const taskNotes = db.activities
    .filter((a) => a.project_task_id === t.id && a.kind === "note")
    .sort((a, b) => (a.activity_date < b.activity_date ? 1 : a.activity_date > b.activity_date ? -1 : b.id - a.id));
  const latest = taskNotes[0];
  return {
    ...t,
    status_label: status?.label ?? "—",
    status_color: status?.color ?? "#64748B",
    status_key: status?.maps_to ?? null,
    priority_label: priority?.label ?? null,
    priority_color: priority?.color ?? null,
    assigned_to_name: userName(t.assigned_to) ?? null,
    completed_by_name: userName(t.completed_by) ?? null,
    custom: serializeCustomValues("task", t.id), // E9
    activity_count: db.task_activity_links.filter((l) => l.project_task_id === t.id).length,
    note_count: taskNotes.length,
    latest_note: latest ? { note: latest.note, activity_date: latest.activity_date, user_name: userName(latest.user_id) ?? null } : null,
  };
}

function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return null;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return Math.max(0, m(end) - m(start));
}

function serializeActivity(a: Row) {
  const cat = valueById(a.category_id);
  const type = valueById(a.activity_type_id);
  const p = db.projects.find((x) => x.id === a.project_id);
  const task = db.project_tasks.find((x) => x.id === a.project_task_id);
  const linked = db.task_activity_links
    .filter((l) => l.activity_id === a.id)
    .map((l) => db.project_tasks.find((t) => t.id === l.project_task_id))
    .filter((t): t is Row => !!t)
    .sort((x, y) => x.step_order - y.step_order)
    .map((t) => ({ id: t.id, name: t.name }));
  return {
    ...a,
    user_name: userName(a.user_id) ?? "System",
    category_label: cat?.label ?? null,
    category_color: cat?.color ?? null,
    activity_type_label: type?.label ?? null,
    activity_type_color: type?.color ?? null,
    activity_type_key: type?.maps_to ?? null,
    duration_minutes: durationMinutes(a.start_time, a.end_time),
    task_name: task?.name ?? null,
    project_code: p?.project_code ?? null,
    mcp_name: p?.mcp_name ?? null,
    linked_tasks: linked,
  };
}

function serializeWin(w: Row): Row {
  const cat = valueById(w.category_id);
  const p = db.projects.find((x) => x.id === w.project_id);
  return {
    ...w,
    category_label: cat?.label ?? null,
    category_color: cat?.color ?? null,
    category_key: cat?.maps_to ?? null,
    project_code: p?.project_code ?? null,
    mcp_name: p?.mcp_name ?? null,
    mcp_number: p?.mcp_number ?? null,
    annualized_premium: p?.annualized_premium ?? null,
    logged_by_name: userName(w.logged_by) ?? null,
  };
}

// ---------------- AP + dynamic custom fields (port of core.ts) ----------------

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "";
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseCurrency(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  return Number(String(raw).replace(/[$,\s]/g, ""));
}

// E9: one custom-field engine for projects and tasks
type CustomObjectType = "project" | "task";
const CUSTOM_VALUE_STORES: Record<CustomObjectType, { rows: () => Row[]; fk: string }> = {
  project: { rows: () => db.project_custom_values, fk: "project_id" },
  task: { rows: () => db.task_custom_values, fk: "task_id" },
};
const activeCustomFields = (objectType: CustomObjectType = "project") =>
  db.custom_fields
    .filter((f) => f.object_type === objectType && f.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

function parseCustomValue(field: Row, raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
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
      const opts = db.picklist_values.filter((v) => v.picklist_id === field.picklist_id);
      const match = opts.find((v) => String(v.id) === s) ?? opts.find((v) => v.label.toLowerCase() === s.toLowerCase());
      if (!match) return { ok: false, error: `${field.label}: unknown option "${s}"` };
      return { ok: true, value: String(match.id) };
    }
    default:
      return { ok: false, error: `${field.label} has an unsupported type` };
  }
}

/** `partial: true` (edits) only parses fields present in the map — a PATCH must not null out omitted fields. */
function validateCustomValues(objectType: CustomObjectType, bodyCustom: Record<string, unknown> | null | undefined, opts: { partial?: boolean } = {}) {
  const errors: string[] = [];
  const parsed = new Map<number, string | null>();
  const flat: Record<string, string | null> = {};
  for (const f of activeCustomFields(objectType)) {
    if (opts.partial && !(bodyCustom && f.field_key in bodyCustom)) continue;
    const r = parseCustomValue(f, bodyCustom?.[f.field_key]);
    if (r.ok) {
      parsed.set(f.id, r.value);
      flat[f.field_key] = r.value;
    } else errors.push(r.error);
  }
  return { errors, parsed, flat };
}

function saveCustomValues(objectType: CustomObjectType, ownerId: number, parsed: Map<number, string | null>) {
  const store = CUSTOM_VALUE_STORES[objectType];
  for (const [fieldId, value] of parsed) {
    const existing = store.rows().find((v) => v[store.fk] === ownerId && v.field_id === fieldId);
    if (existing) existing.value = value;
    else store.rows().push({ id: nextId(), [store.fk]: ownerId, field_id: fieldId, value });
  }
}

function serializeCustomValues(objectType: CustomObjectType, ownerId: number): Record<string, Row> {
  const store = CUSTOM_VALUE_STORES[objectType];
  const out: Record<string, Row> = {};
  for (const f of activeCustomFields(objectType)) {
    const value = store.rows().find((v) => v[store.fk] === ownerId && v.field_id === f.id)?.value ?? null;
    const opt = f.field_type === "dropdown" && value ? valueById(Number(value)) : undefined;
    out[f.field_key] = { id: f.id, type: f.field_type, value, option_label: opt?.label ?? null, option_color: opt?.color ?? null };
  }
  return out;
}

function customCsvValue(v: Row | undefined): string {
  if (!v || v.value == null) return "";
  switch (v.type) {
    case "dropdown": return v.option_label ?? "";
    case "checkbox": return v.value === "1" ? "Yes" : "No";
    case "currency": return fmtCurrency(Number(v.value));
    default: return String(v.value);
  }
}

function serializeProject(p: Row, opts: { withTasks?: boolean } = {}) {
  const status = valueById(p.status_id);
  const risk = valueById(p.risk_level_id);
  const closeReason = valueById(p.close_reason_id);
  const rag = computeRag(p);
  const ragVal = valueByMapsTo("RAG Status", rag.rag);
  const done = doneStatusIds();
  const taskRows = db.project_tasks
    .filter((t) => t.project_id === p.id)
    .sort((a, b) => a.step_order - b.step_order || a.id - b.id);
  const open = taskRows.filter((t) => !done.includes(t.status_id));
  const nextDue = open.filter((t) => t.due_date).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const statusChanged = (p.status_changed_date ?? p.created_date).slice(0, 10);

  return {
    id: p.id, project_code: p.project_code, mcp_number: p.mcp_number, mcp_name: p.mcp_name,
    project_name: p.project_name ?? null,
    assignee_id: p.assignee_id, assignee_name: userName(p.assignee_id) ?? "—",
    annualized_premium: p.annualized_premium ?? null,
    assignment_date: p.assignment_date, target_date: p.target_date, template_id: p.template_id,
    status_id: p.status_id, status_label: status?.label ?? "—", status_color: status?.color ?? "#64748B",
    status_key: status?.maps_to ?? null,
    risk_level_id: p.risk_level_id, risk_label: risk?.label ?? null, risk_color: risk?.color ?? null,
    rag: rag.rag, rag_reason: rag.reason, rag_overridden: rag.overridden,
    rag_color: ragVal?.color ?? "#4E9468", rag_label: ragVal?.label ?? rag.rag,
    created_date: p.created_date, closed_date: p.closed_date,
    closed_by_name: userName(p.closed_by) ?? null,
    close_reason_id: p.close_reason_id, close_reason_label: closeReason?.label ?? null,
    final_summary: p.final_summary,
    is_closed: CLOSED_KEYS.includes(status?.maps_to ?? ""),
    days_in_status: Math.max(0, daysBetween(statusChanged, today())),
    open_task_count: open.length, task_count: taskRows.length,
    next_due_task: nextDue ? { name: nextDue.name, due_date: nextDue.due_date } : null,
    custom: serializeCustomValues("project", p.id),
    tasks: opts.withTasks ? taskRows.map(serializeTask) : undefined,
  };
}

function closureProblems(projectId: number, body: { final_summary?: string | null; close_reason_id?: number | null; [k: string]: any }, opts: { cancelled?: boolean } = {}): string[] {
  // E5: cancellation requires a Close Reason; Final Summary is optional and
  // incomplete required tasks don't block (abandoned work is the point).
  if (opts.cancelled) return body.close_reason_id ? [] : ["Close Reason is required to cancel a project"];
  const problems: string[] = [];
  const done = doneStatusIds();
  for (const t of db.project_tasks)
    if (t.project_id === projectId && t.required && !done.includes(t.status_id))
      problems.push(`Required task not complete: "${t.name}"`);
  for (const r of db.field_requirements)
    if (r.object_type === "project" && r.required && ["closure", "always"].includes(r.required_at)) {
      if (r.field_name === "final_summary" && !body.final_summary?.trim()) problems.push(`${r.label} is required at closure`);
      if (r.field_name === "close_reason_id" && !body.close_reason_id) problems.push(`${r.label} is required at closure`);
    }
  return problems;
}

function requirementErrors(objectType: string, at: string[], body: Record<string, any>): string[] {
  const errs: string[] = [];
  for (const r of db.field_requirements)
    if (r.object_type === objectType && r.required && at.includes(r.required_at)) {
      const v = body[r.field_name];
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) errs.push(`${r.label} is required`);
    }
  return errs;
}

function serializeLog(l: Row) {
  const p = db.projects.find((x) => x.id === l.project_id);
  const task = db.project_tasks.find((x) => x.id === l.project_task_id);
  const act = valueById(l.activity_type_id);
  return {
    ...l, user_name: userName(l.user_id) ?? "—",
    project_code: p?.project_code, mcp_name: p?.mcp_name,
    task_name: task?.name ?? null,
    activity_type_label: act?.label ?? null, activity_type_color: act?.color ?? null,
    total_minutes: l.hours * 60 + l.minutes,
  };
}

// ---------------- router ----------------

type Handler = (m: Record<string, string>, q: URLSearchParams, body: any) => Res;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) => {
  const re = new RegExp("^" + pattern.replace(/:([a-z_]+)/g, "(?<$1>[^/]+)") + "$");
  routes.push([method, re, h]);
};

/** E11: with ?page= the response becomes { rows, total, page, page_size } (default size 25). */
function paginate(out: any[], q: URLSearchParams): Res | null {
  if (q.get("page") === null) return null;
  const size = Math.min(200, Math.max(1, Number(q.get("page_size")) || 25));
  const page = Math.max(1, Number(q.get("page")) || 1);
  return ok({ rows: out.slice((page - 1) * size, page * size), total: out.length, page, page_size: size });
}

export function demoRequest(method: string, url: string, body?: any): Res {
  const u = new URL(url, "http://demo");
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = u.pathname.match(re);
    if (match) {
      const res = h((match.groups ?? {}) as Record<string, string>, u.searchParams, body ?? {});
      if (method !== "GET") save();
      return res;
    }
  }
  return err(404, `No demo handler for ${method} ${u.pathname}`);
}

// ---- users ----
route("GET", "/api/users", () => ok(db.users.filter((u) => u.is_active).sort((a, b) => a.name.localeCompare(b.name))));
route("POST", "/api/users", (_m, _q, b) => {
  if (!b.name?.trim() || !b.email?.trim()) return err(400, "Name and email are required");
  if (db.users.some((u) => u.email === b.email.trim())) return err(409, "A user with that email already exists");
  const u = { id: nextId(), name: b.name.trim(), email: b.email.trim(), is_active: 1, dashboard_scope: "mine", default_assignee_filter: null, show_configuration: 1 };
  db.users.push(u);
  return ok(u, 201);
});
route("PATCH", "/api/users/:id", (m, _q, b) => {
  const u = db.users.find((x) => x.id === Number(m.id));
  if (!u) return err(404, "User not found");
  if (b.dashboard_scope !== undefined) {
    if (!["mine", "all"].includes(b.dashboard_scope)) return err(400, "dashboard_scope must be 'mine' or 'all'");
    u.dashboard_scope = b.dashboard_scope;
  }
  if (b.default_assignee_filter !== undefined) {
    // null = match dashboard default, 'all' = everyone, otherwise a user id
    const v = b.default_assignee_filter;
    if (v === null || v === "") u.default_assignee_filter = null;
    else if (v === "all") u.default_assignee_filter = "all";
    else {
      const target = db.users.find((x) => x.id === Number(v));
      if (!target) return err(400, "default_assignee_filter must be 'all' or a valid user id");
      u.default_assignee_filter = String(target.id);
    }
  }
  if (b.show_configuration !== undefined) u.show_configuration = b.show_configuration ? 1 : 0;
  return ok(u);
});

// ---- picklists ----
route("GET", "/api/picklists", () =>
  ok(db.picklists
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => ({ ...l, values: db.picklist_values.filter((v) => v.picklist_id === l.id).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id) })))
);
route("POST", "/api/picklists/:id/values", (m, _q, b) => {
  const list = db.picklists.find((l) => l.id === Number(m.id));
  if (!list) return err(404, "Picklist not found");
  if (!b.label?.trim()) return err(400, "Label is required");
  const max = Math.max(0, ...db.picklist_values.filter((v) => v.picklist_id === list.id).map((v) => v.sort_order));
  const v = { id: nextId(), picklist_id: list.id, label: b.label.trim(), sort_order: max + 1, color: b.color || "#64748B", is_active: 1, is_default: 0, archived: 0, maps_to: null };
  db.picklist_values.push(v);
  return ok(v, 201);
});
route("PATCH", "/api/picklist-values/:id", (m, _q, b) => {
  const v = db.picklist_values.find((x) => x.id === Number(m.id));
  if (!v) return err(404, "Value not found");
  if (b.label !== undefined) v.label = b.label;
  if (b.color !== undefined) v.color = b.color;
  if (b.sort_order !== undefined) v.sort_order = b.sort_order;
  if (b.is_active !== undefined) {
    const list = db.picklists.find((l) => l.id === v.picklist_id)!;
    if (!b.is_active && list.is_system && v.maps_to)
      return err(400, "System values can't be deactivated — board logic depends on them");
    v.is_active = b.is_active ? 1 : 0;
  }
  if (b.archived !== undefined) {
    // B1: explicit archive/restore, same system-value guard as deactivation
    const list = db.picklists.find((l) => l.id === v.picklist_id)!;
    if (list.is_system && v.maps_to)
      return err(400, "System values can't be archived or restored — board logic depends on them");
    v.archived = b.archived ? 1 : 0;
  }
  if (b.is_default) {
    for (const x of db.picklist_values) if (x.picklist_id === v.picklist_id) x.is_default = 0;
    v.is_default = 1;
  }
  return ok(v);
});
/** B1: used values are archived (never deleted); never-used values may be hard-deleted. */
route("DELETE", "/api/picklist-values/:id", (m) => {
  const v = db.picklist_values.find((x) => x.id === Number(m.id));
  if (!v) return err(404, "Value not found");
  const list = db.picklists.find((l) => l.id === v.picklist_id)!;
  if (list.is_system && v.maps_to)
    return err(400, "System values can't be deleted or archived — board logic depends on them");
  const dropdownFieldIds = new Set(db.custom_fields.filter((f) => f.field_type === "dropdown").map((f) => f.id));
  const refs =
    db.projects.filter((p) => [p.status_id, p.risk_level_id, p.close_reason_id].includes(v.id)).length +
    db.project_tasks.filter((t) => [t.status_id, t.priority_id].includes(v.id)).length +
    db.time_logs.filter((l) => l.activity_type_id === v.id).length +
    db.activities.filter((a) => a.category_id === v.id || a.activity_type_id === v.id).length +
    db.wins.filter((w) => w.category_id === v.id).length +
    db.template_tasks.filter((t) => t.default_priority_id === v.id).length +
    // B1: dropdown selections stored in custom-value tables count as references too
    db.project_custom_values.filter((cv) => dropdownFieldIds.has(cv.field_id) && cv.value === String(v.id)).length +
    db.task_custom_values.filter((cv) => dropdownFieldIds.has(cv.field_id) && cv.value === String(v.id)).length; // E9
  if (refs > 0) {
    v.archived = 1;
    return ok({ archived: true, message: `"${v.label}" is referenced by ${refs} record(s), so it was archived instead of deleted. Existing records keep displaying it; it no longer appears in dropdowns for new entries.` });
  }
  db.picklist_values = db.picklist_values.filter((x) => x.id !== v.id);
  return ok({ deleted: true });
});

// ---- dynamic custom project fields ----
const CUSTOM_FIELD_TYPES = ["text", "number", "currency", "date", "dropdown", "checkbox"];
// E9: layout slots per object type
const CUSTOM_FIELD_VIEWS: Record<string, string[]> = {
  project: ["project_list", "project_header", "portfolio_card"],
  task: ["task_list", "task_card"],
};
const OPTION_COLORS = ["#2E4E8F", "#12808A", "#8A6FB8", "#C99239", "#4E9468", "#B0632F", "#5C6B84", "#C2554E"];

const customFieldOut = (f: Row) => ({
  ...f,
  options: f.picklist_id
    ? db.picklist_values.filter((v) => v.picklist_id === f.picklist_id).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    : [],
});

route("GET", "/api/custom-fields", () =>
  ok(db.custom_fields.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(customFieldOut))
);
route("POST", "/api/custom-fields", (_m, _q, b) => {
  const label = String(b.label ?? "").trim();
  const objectType: CustomObjectType = b.object_type === "task" ? "task" : "project";
  if (b.object_type && !(b.object_type in CUSTOM_FIELD_VIEWS)) return err(400, "object_type must be one of: project, task");
  if (!label) return err(400, "Field label is required");
  if (!CUSTOM_FIELD_TYPES.includes(b.field_type)) return err(400, `Field type must be one of: ${CUSTOM_FIELD_TYPES.join(", ")}`);
  const opts = (Array.isArray(b.options) ? b.options : []).map((o: unknown) => String(o).trim()).filter(Boolean);
  if (b.field_type === "dropdown" && !opts.length) return err(400, "A dropdown field needs at least one option");

  const base = "cf_" + (label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field");
  let key = base;
  for (let n = 2; db.custom_fields.some((f) => f.field_key === key); n++) key = `${base}_${n}`;

  let picklistId: number | null = null;
  if (b.field_type === "dropdown") {
    let plName = label;
    if (db.picklists.some((l) => l.name === plName)) plName = `${plName} (Custom Field)`;
    picklistId = nextId();
    db.picklists.push({ id: picklistId, name: plName, object_type: objectType, is_system: 0 });
    opts.forEach((o: string, i: number) =>
      db.picklist_values.push({
        id: nextId(), picklist_id: picklistId, label: o, sort_order: i + 1,
        color: OPTION_COLORS[i % OPTION_COLORS.length], is_active: 1, is_default: i === 0 ? 1 : 0, archived: 0, maps_to: null,
      })
    );
  }
  const maxSort = Math.max(0, ...db.custom_fields.map((f) => f.sort_order));
  const f: Row = {
    id: nextId(), object_type: objectType, label, field_key: key, field_type: b.field_type,
    picklist_id: picklistId, is_active: 1, sort_order: maxSort + 1, created_date: now(),
  };
  db.custom_fields.push(f);
  db.field_requirements.push({ id: nextId(), object_type: objectType, field_name: key, label, is_system: 0, required: 0, required_at: "creation" });
  for (const view of CUSTOM_FIELD_VIEWS[objectType]) {
    const max = Math.max(0, ...db.view_layout_fields.filter((x) => x.view_name === view).map((x) => x.display_order));
    db.view_layout_fields.push({ id: nextId(), view_name: view, field_key: key, label, display_order: max + 1, is_visible: 1, is_locked: 0 });
  }
  return ok(customFieldOut(f), 201);
});
route("PATCH", "/api/custom-fields/:id", (m, _q, b) => {
  const f = db.custom_fields.find((x) => x.id === Number(m.id));
  if (!f) return err(404, "Custom field not found");
  if (b.label !== undefined) {
    const label = String(b.label).trim();
    if (!label) return err(400, "Field label is required");
    f.label = label;
    for (const r of db.field_requirements) if (r.object_type === f.object_type && r.field_name === f.field_key) r.label = label;
    for (const v of db.view_layout_fields) if (v.field_key === f.field_key) v.label = label;
  }
  if (b.sort_order !== undefined) f.sort_order = b.sort_order;
  if (b.is_active !== undefined) {
    f.is_active = b.is_active ? 1 : 0;
    for (const v of db.view_layout_fields) if (v.field_key === f.field_key) v.is_visible = f.is_active;
  }
  return ok(customFieldOut(f));
});
route("DELETE", "/api/custom-fields/:id", (m) => {
  const f = db.custom_fields.find((x) => x.id === Number(m.id));
  if (!f) return err(404, "Custom field not found");
  const isTask = f.object_type === "task";
  const values = isTask ? db.task_custom_values : db.project_custom_values;
  const refs = values.filter((v) => v.field_id === f.id && v.value != null).length;
  if (refs > 0) {
    f.is_active = 0;
    for (const v of db.view_layout_fields) if (v.field_key === f.field_key) v.is_visible = 0;
    return ok({ deactivated: true, message: `"${f.label}" holds values on ${refs} ${f.object_type}(s) — deactivated instead of deleted. Reactivate it to bring the data back.` });
  }
  if (isTask) db.task_custom_values = db.task_custom_values.filter((v) => v.field_id !== f.id);
  else db.project_custom_values = db.project_custom_values.filter((v) => v.field_id !== f.id);
  db.view_layout_fields = db.view_layout_fields.filter((v) => v.field_key !== f.field_key);
  db.field_requirements = db.field_requirements.filter((r) => !(r.object_type === f.object_type && r.field_name === f.field_key));
  db.custom_fields = db.custom_fields.filter((x) => x.id !== f.id);
  if (f.picklist_id) {
    db.picklist_values = db.picklist_values.filter((v) => v.picklist_id !== f.picklist_id);
    db.picklists = db.picklists.filter((l) => l.id !== f.picklist_id);
  }
  return ok({ deleted: true });
});

// ---- templates ----
route("GET", "/api/templates", () =>
  ok(db.workflow_templates
    .slice().sort((a, b) => b.is_default - a.is_default || a.name.localeCompare(b.name))
    .map((t) => ({ ...t, tasks: db.template_tasks.filter((x) => x.template_id === t.id).sort((a, b) => a.step_order - b.step_order) })))
);
route("POST", "/api/templates", (_m, _q, b) => {
  if (!b.name?.trim()) return err(400, "Template name is required");
  const t = { id: nextId(), name: b.name.trim(), description: b.description ?? "", is_default: 0, is_active: 1, created_by: b.user_id ?? null, created_date: now() };
  db.workflow_templates.push(t);
  if (b.clone_from) {
    for (const s of db.template_tasks.filter((x) => x.template_id === Number(b.clone_from)).sort((a, b2) => a.step_order - b2.step_order))
      db.template_tasks.push({ ...s, id: nextId(), template_id: t.id });
  }
  return ok(t, 201);
});
route("PATCH", "/api/templates/:id", (m, _q, b) => {
  const t = db.workflow_templates.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Template not found");
  if (b.is_default) for (const x of db.workflow_templates) x.is_default = 0;
  if (b.name !== undefined) t.name = b.name;
  if (b.description !== undefined) t.description = b.description;
  if (b.is_active !== undefined) t.is_active = b.is_active ? 1 : 0;
  if (b.is_default !== undefined) t.is_default = b.is_default ? 1 : 0;
  return ok(t);
});
route("POST", "/api/templates/:id/tasks", (m, _q, b) => {
  const tpl = db.workflow_templates.find((x) => x.id === Number(m.id));
  if (!tpl) return err(404, "Template not found");
  if (!b.name?.trim()) return err(400, "Task name is required");
  const max = Math.max(0, ...db.template_tasks.filter((t) => t.template_id === tpl.id).map((t) => t.step_order));
  const t = {
    id: nextId(), template_id: tpl.id, step_order: max + 1, name: b.name.trim(), description: b.description ?? "",
    required: b.required ? 1 : 0, due_offset: b.due_offset ?? 7,
    default_priority_id: b.default_priority_id ?? null,
    can_edit: b.can_edit === false || b.can_edit === 0 ? 0 : 1,
  };
  db.template_tasks.push(t);
  return ok(t, 201);
});
route("PATCH", "/api/template-tasks/:id", (m, _q, b) => {
  const t = db.template_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Template task not found");
  for (const f of ["name", "description", "required", "due_offset", "default_priority_id", "can_edit", "step_order"])
    if (f in b) t[f] = b[f];
  return ok(t);
});
route("DELETE", "/api/template-tasks/:id", (m) => {
  const t = db.template_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Template task not found");
  db.template_tasks = db.template_tasks.filter((x) => x.id !== t.id);
  return ok({ ok: true });
});
route("POST", "/api/templates/:id/reorder", (m, _q, b) => {
  (b.task_ids as number[]).forEach((id, i) => {
    const t = db.template_tasks.find((x) => x.id === id && x.template_id === Number(m.id));
    if (t) t.step_order = i + 1;
  });
  return ok({ ok: true });
});

// ---- field requirements + settings ----
route("GET", "/api/field-requirements", () =>
  ok(db.field_requirements.slice().sort((a, b) => a.object_type.localeCompare(b.object_type) || b.is_system - a.is_system || a.id - b.id))
);
route("PATCH", "/api/field-requirements/:id", (m, _q, b) => {
  const r = db.field_requirements.find((x) => x.id === Number(m.id));
  if (!r) return err(404, "Rule not found");
  if (r.is_system) return err(400, "System fields are locked — always required (§5.3)");
  r.required = b.required ? 1 : 0;
  r.required_at = b.required_at ?? r.required_at;
  return ok(r);
});
route("GET", "/api/settings", () =>
  ok({
    rag_red_overdue_days: settingNum("rag_red_overdue_days", 3),
    rag_amber_due_days: settingNum("rag_amber_due_days", 3),
    rag_stall_days: settingNum("rag_stall_days", 7),
  })
);
route("PATCH", "/api/settings", (_m, _q, b) => {
  for (const key of ["rag_red_overdue_days", "rag_amber_due_days", "rag_stall_days"])
    if (key in b) {
      const n = Number(b[key]);
      if (!Number.isFinite(n) || n < 0) return err(400, `${key} must be a non-negative number`);
      db.settings[key] = String(n);
    }
  return ok({ ok: true });
});

// ---- layouts ----
route("GET", "/api/layouts", () =>
  ok(db.view_layout_fields.slice().sort((a, b) => a.view_name.localeCompare(b.view_name) || a.display_order - b.display_order))
);
route("GET", "/api/layouts/:view", (m) =>
  ok(db.view_layout_fields.filter((f) => f.view_name === m.view).sort((a, b) => a.display_order - b.display_order))
);
route("PATCH", "/api/layout-fields/:id", (m, _q, b) => {
  const f = db.view_layout_fields.find((x) => x.id === Number(m.id));
  if (!f) return err(404, "Layout field not found");
  if (b.is_visible !== undefined && !b.is_visible && f.is_locked)
    return err(400, `"${f.label}" is locked on this view and can't be hidden (§5.4)`);
  if (b.is_visible !== undefined) f.is_visible = b.is_visible ? 1 : 0;
  if (b.display_order !== undefined) f.display_order = b.display_order;
  return ok(f);
});
route("POST", "/api/layouts/:view/reorder", (m, _q, b) => {
  (b.field_ids as number[]).forEach((id, i) => {
    const f = db.view_layout_fields.find((x) => x.id === id && x.view_name === m.view);
    if (f) f.display_order = i + 1;
  });
  return ok({ ok: true });
});

// ---- projects ----
route("GET", "/api/projects", (_m, q) => {
  let out = db.projects.slice().sort((a, b) => (a.created_date > b.created_date ? -1 : 1)).map((p) => serializeProject(p));
  const scope = q.get("scope");
  if (scope === "active") out = out.filter((p) => !p.is_closed);
  if (scope === "closed") out = out.filter((p) => p.is_closed);
  if (q.get("assignee_id")) out = out.filter((p) => p.assignee_id === Number(q.get("assignee_id")));
  if (q.get("rag")) out = out.filter((p) => p.rag === q.get("rag"));
  if (q.get("risk_level_id")) out = out.filter((p) => p.risk_level_id === Number(q.get("risk_level_id")));
  if (q.get("template_id")) out = out.filter((p) => p.template_id === Number(q.get("template_id")));
  const s = q.get("q")?.toLowerCase();
  if (s)
    out = out.filter((p) =>
      [p.mcp_name, p.mcp_number, p.project_code, p.project_name, p.assignee_name, p.status_label, p.close_reason_label]
        .some((f: any) => f?.toLowerCase().includes(s))
    );
  // E11: server-side sort so it covers the full result set
  const sort = q.get("sort");
  if (sort) {
    const d = q.get("dir") === "desc" ? -1 : 1;
    const keyOf = (p: any) => (sort.startsWith("cf_") ? p.custom?.[sort]?.value ?? "" : p[sort] ?? "");
    out = out.slice().sort((a, b) => { const av = keyOf(a), bv = keyOf(b); return (av < bv ? -1 : av > bv ? 1 : 0) * d; });
  }
  return paginate(out, q) ?? ok(out);
});
route("GET", "/api/projects/:id", (m) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  return ok(serializeProject(p, { withTasks: true }));
});
route("POST", "/api/projects", (_m, _q, b) => {
  if (!b.mcp_number?.trim() || !b.mcp_name?.trim() || !b.assignee_id || !b.assignment_date || !b.template_id)
    return err(400, "MCP #, MCP Name, Assignee, Assignment Date and Template are required");
  const ap = Number(b.annualized_premium);
  if (b.annualized_premium == null || b.annualized_premium === "" || !Number.isFinite(ap) || ap < 0)
    return err(400, "Annualized Premium (AP) is required and must be a dollar amount");
  // Real calendar dates only — a malformed date would corrupt generated task
  // due dates and the RAG date comparisons.
  if (!isIsoDate(b.assignment_date)) return err(400, "Assignment Date must be a valid date (YYYY-MM-DD)");
  if (b.target_date != null && !isIsoDate(b.target_date)) return err(400, "Estimated Completion Date must be a valid date (YYYY-MM-DD)");
  const custom = validateCustomValues("project", b.custom);
  if (custom.errors.length) return err(400, custom.errors.join("; "));
  const reqErrs = requirementErrors("project", ["creation", "always"], { ...b, ...custom.flat, project_code: "auto" });
  if (reqErrs.length) return err(400, reqErrs.join("; "));
  const active = activeStatusIds();
  const dup = db.projects.find((p) => p.mcp_number === b.mcp_number && active.includes(p.status_id));
  if (dup) return err(409, `MCP ${b.mcp_number} already has an active project (${dup.project_code}). Close it before creating a new one.`);
  const tpl = db.workflow_templates.find((t) => t.id === Number(b.template_id) && t.is_active);
  if (!tpl) return err(400, "Selected template is not available");

  const code = nextProjectCode();
  const p: Row = {
    id: nextId(), project_code: code, mcp_number: b.mcp_number, mcp_name: b.mcp_name,
    project_name: (typeof b.project_name === "string" && b.project_name.trim()) || null,
    assignee_id: b.assignee_id, annualized_premium: ap, assignment_date: b.assignment_date, target_date: b.target_date ?? null,
    template_id: b.template_id, status_id: valueByMapsTo("Project Status", "new")!.id,
    risk_level_id: b.risk_level_id ?? null, rag_override: null, rag_override_reason: null,
    status_changed_date: now(), created_date: now(),
    closed_date: null, closed_by: null, close_reason_id: null, final_summary: null,
  };
  db.projects.push(p);
  saveCustomValues("project", p.id, custom.parsed);
  generateTasksFromTemplate(p.id, b.template_id, b.assignment_date, Number(b.assignee_id));
  logActivity({ project_id: p.id, user_id: b.user_id, kind: "system", note: `Project ${code} created` });
  return ok(serializeProject(p, { withTasks: true }), 201);
});
route("PATCH", "/api/projects/:id", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  if ("annualized_premium" in b) {
    const n = Number(b.annualized_premium);
    if (!Number.isFinite(n) || n < 0) return err(400, "Annualized Premium (AP) must be a dollar amount");
    b.annualized_premium = n;
  }
  if ("target_date" in b && b.target_date != null && !isIsoDate(b.target_date))
    return err(400, "Estimated Completion Date must be a valid date (YYYY-MM-DD)");
  const custom = "custom" in b ? validateCustomValues("project", b.custom, { partial: true }) : null;
  if (custom?.errors.length) return err(400, custom.errors.join("; "));

  // A field configured "always required" can't be blanked by an edit — the
  // same rule the create form enforces. Only touched fields are judged.
  const touched = new Set([...Object.keys(b), ...Object.keys(b.custom ?? {})]);
  const provided: Record<string, any> = { ...b, ...(custom?.flat ?? {}) };
  const alwaysErrs = db.field_requirements
    .filter((r) => r.object_type === "project" && r.required && r.required_at === "always" && touched.has(r.field_name))
    .filter((r) => { const v = provided[r.field_name]; return v === undefined || v === null || (typeof v === "string" && !v.trim()); })
    .map((r) => `${r.label} is required`);
  if (alwaysErrs.length) return err(400, alwaysErrs.join("; "));

  const oldAssignee = p.assignee_id;
  const oldAp = p.annualized_premium ?? null;
  for (const f of ["mcp_name", "project_name", "assignee_id", "annualized_premium", "target_date", "risk_level_id"]) if (f in b) p[f] = b[f];
  if (custom) saveCustomValues("project", p.id, custom.parsed);

  if ("annualized_premium" in b && b.annualized_premium !== oldAp) {
    logActivity({
      project_id: p.id, user_id: b.user_id, kind: "system",
      note: `changed Annualized Premium (AP) from ${fmtCurrency(oldAp) || "—"} to ${fmtCurrency(b.annualized_premium)}`,
    });
  }
  if ("assignee_id" in b && Number(b.assignee_id) !== oldAssignee) {
    const newAssignee = Number(b.assignee_id);
    logActivity({
      project_id: p.id, user_id: b.user_id, kind: "system",
      note: `changed project assignee from ${userName(oldAssignee) ?? "—"} to ${userName(newAssignee) ?? "—"}`,
    });
    // Optional cascade: only open tasks move — Closed/Complete stay untouched
    if (b.reassign_open_tasks) {
      const done = doneStatusIds();
      let n = 0;
      for (const t of db.project_tasks)
        if (t.project_id === p.id && !done.includes(t.status_id)) { t.assigned_to = newAssignee; n++; }
      logActivity({
        project_id: p.id, user_id: b.user_id, kind: "system",
        note: `reassigned ${n} open task(s) to ${userName(newAssignee) ?? "—"}`,
      });
    }
  }
  return ok(serializeProject(p, { withTasks: true }));
});
route("POST", "/api/projects/:id/status", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  // Only values from THIS picklist qualify — an id from another picklist would
  // corrupt board columns and the one-active-project-per-MCP guard.
  const target = valuesFor("Project Status").find((v) => v.id === b.status_id);
  if (!target) return err(400, "Unknown status");
  if (target.archived) return err(400, `"${target.label}" is archived and can no longer be assigned`);
  if (!target.is_active && target.id !== p.status_id)
    return err(400, `"${target.label}" is deactivated and can no longer be assigned`);
  if (isClosedStatus(p.status_id))
    return err(400, "Closed projects are never reopened (§2.2). Create a new project for this MCP instead.");
  if (target.maps_to === "closed") {
    const problems = closureProblems(p.id, p);
    if (problems.length) return err(422, "Closure requirements not met", { problems, needs_close_form: true });
    return err(422, "Use the Close Project form", { needs_close_form: true, problems: [] });
  }
  // E5: Cancelled is a closure status — same workflow as closing
  if (target.maps_to === "cancelled")
    return err(422, "Use the Cancel Project form", { needs_close_form: true, cancelled: true, problems: [] });
  const old = valueById(p.status_id);
  p.status_id = b.status_id;
  p.status_changed_date = now();
  logActivity({
    project_id: p.id, user_id: b.user_id, kind: "status_change",
    note: `changed project status from ${old?.label} to ${target.label}`,
    old_status: old?.label, new_status: target.label,
  });
  return ok(serializeProject(p));
});
route("POST", "/api/projects/:id/close", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  if (isClosedStatus(p.status_id)) return err(400, "Project is already closed");
  const problems = closureProblems(p.id, b, { cancelled: !!b.cancelled });
  if (problems.length && !b.override) return err(422, "Closure requirements not met", { problems });
  if (problems.length && b.override && !b.override_reason?.trim())
    return err(422, "An override reason is required", { problems });
  const closed = valueByMapsTo("Project Status", b.cancelled ? "cancelled" : "closed")!;
  const old = valueById(p.status_id);
  // B2: clear any manual RAG override at closure so history reports Closed = Green
  if (p.rag_override) {
    logActivity({
      project_id: p.id, user_id: b.user_id, kind: "system",
      note: `cleared manual RAG override (${String(p.rag_override).toUpperCase()}: ${p.rag_override_reason ?? "no reason recorded"}) as part of closure — closed projects report Green`,
    });
  }
  p.rag_override = null;
  p.rag_override_reason = null;
  p.status_id = closed.id;
  p.status_changed_date = now();
  p.closed_date = now();
  p.closed_by = b.user_id;
  p.close_reason_id = b.close_reason_id ?? null;
  p.final_summary = b.final_summary ?? null;
  logActivity({
    project_id: p.id, user_id: b.user_id, kind: "status_change",
    note: b.override ? `${b.cancelled ? "cancelled" : "closed"} project with override: ${b.override_reason}` : `${b.cancelled ? "cancelled" : "closed"} project`,
    old_status: old?.label, new_status: closed.label,
  });
  return ok(serializeProject(p));
});
route("POST", "/api/projects/:id/rag-override", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  // Closed projects report "Closed = Green" (B2) — overrides can't be re-applied
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  if (b.rag && !["red", "amber", "green"].includes(b.rag)) return err(400, "Invalid RAG value");
  if (b.rag && !b.reason?.trim()) return err(400, "An override reason is required for auditability");
  p.rag_override = b.rag ?? null;
  p.rag_override_reason = b.reason ?? null;
  logActivity({
    project_id: p.id, user_id: b.user_id, kind: "system",
    note: b.rag ? `manually set RAG to ${b.rag.toUpperCase()}: ${b.reason}` : "cleared manual RAG override (back to auto-calculated)",
  });
  return ok(serializeProject(p));
});
route("POST", "/api/projects/:id/tasks", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  if (!b.name?.trim()) return err(400, "Task name is required");
  const custom = validateCustomValues("task", b.custom); // E9
  if (custom.errors.length) return err(400, custom.errors.join("; "));
  const reqErrs = requirementErrors("task", ["creation", "always"], { ...b, ...custom.flat });
  if (reqErrs.length) return err(400, reqErrs.join("; "));
  const max = Math.max(0, ...db.project_tasks.filter((t) => t.project_id === p.id).map((t) => t.step_order));
  const t: Row = {
    id: nextId(), project_id: p.id, template_task_id: null, name: b.name.trim(), description: b.description ?? "",
    task_type: "adhoc", step_order: max + 1, assigned_to: b.assigned_to ?? null, due_date: b.due_date ?? null,
    status_id: valueByMapsTo("Task Status", "not_started")!.id, priority_id: b.priority_id ?? null,
    required: b.required ? 1 : 0,
    notes: "", skip_reason: null, completed_date: null, completed_by: null,
  };
  db.project_tasks.push(t);
  saveCustomValues("task", t.id, custom.parsed);
  logActivity({ project_id: p.id, project_task_id: t.id, user_id: b.user_id, kind: "system", note: `added ad-hoc task "${t.name}"` });
  if (b.initial_note?.trim())
    logActivity({ project_id: p.id, project_task_id: t.id, user_id: b.user_id, kind: "note", note: b.initial_note.trim() });
  return ok(serializeTask(t), 201);
});

// ---- tasks ----
/** Cross-project task list (v2 §1) — combinable filters, closed projects excluded. */
route("GET", "/api/tasks", (_m, q) => {
  const closedIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const done = doneStatusIds();
  const blockedId = valueByMapsTo("Task Status", "blocked")?.id;
  const t = today();
  let out = db.project_tasks
    .filter((x) => {
      const p = db.projects.find((pp) => pp.id === x.project_id);
      return p && !closedIds.includes(p.status_id);
    });
  if (q.get("project_id")) out = out.filter((x) => x.project_id === Number(q.get("project_id")));
  if (q.get("status_id")) out = out.filter((x) => x.status_id === Number(q.get("status_id")));
  if (q.get("blocked") === "1" && blockedId) out = out.filter((x) => x.status_id === blockedId);
  if (q.get("overdue") === "1") out = out.filter((x) => x.due_date && x.due_date < t && !done.includes(x.status_id));
  if (q.get("assigned_to")) {
    const uid = Number(q.get("assigned_to"));
    out = out.filter((x) => {
      if (x.assigned_to) return x.assigned_to === uid;
      return db.projects.find((pp) => pp.id === x.project_id)?.assignee_id === uid;
    });
  }
  out = out.slice().sort((a, b) =>
    ((a.due_date ? "0" + a.due_date : "1") + String(a.step_order).padStart(4, "0"))
      .localeCompare((b.due_date ? "0" + b.due_date : "1") + String(b.step_order).padStart(4, "0"))
  );
  const rows = out.map((x) => {
    const p = db.projects.find((pp) => pp.id === x.project_id)!;
    return { ...serializeTask(x), project_code: p.project_code, mcp_name: p.mcp_name, project_name: p.project_name ?? null };
  });
  return paginate(rows, q) ?? ok(rows);
});
/** All activities linked to a task through the join table (v2 §6). */
route("GET", "/api/tasks/:id/activities", (m) => {
  const t = db.project_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Task not found");
  const acts = db.task_activity_links
    .filter((l) => l.project_task_id === t.id)
    .map((l) => db.activities.find((a) => a.id === l.activity_id))
    .filter((a): a is Row => !!a)
    .sort((a, b) => (a.activity_date < b.activity_date ? 1 : a.activity_date > b.activity_date ? -1 : b.id - a.id));
  return ok(acts.map(serializeActivity));
});
route("PATCH", "/api/tasks/:id", (m, _q, b) => {
  const t = db.project_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Task not found");
  const p = db.projects.find((x) => x.id === t.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  const tplTask = t.template_task_id ? db.template_tasks.find((x) => x.id === t.template_task_id) : null;
  const custom = "custom" in b ? validateCustomValues("task", b.custom, { partial: true }) : null; // E9
  if (custom?.errors.length) return err(400, custom.errors.join("; "));
  const editable = ["due_date", "assigned_to", "priority_id", "notes", "description"];
  if (t.task_type === "adhoc" || (tplTask?.can_edit ?? 1)) editable.push("name");
  for (const f of editable) if (f in b) t[f] = b[f];
  if (custom) saveCustomValues("task", t.id, custom.parsed);
  return ok(serializeTask(t));
});
/** E4: Delete replaces Skipped — unlink and preserve time logs & activities, never cascade. */
route("DELETE", "/api/tasks/:id", (m, q, b) => {
  const t = db.project_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Task not found");
  const p = db.projects.find((x) => x.id === t.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  const userId = Number(q.get("user_id") ?? b?.user_id) || null;
  let logCount = 0, actCount = 0;
  for (const l of db.time_logs) if (l.project_task_id === t.id) { l.project_task_id = null; logCount++; }
  for (const a of db.activities) if (a.project_task_id === t.id) { a.project_task_id = null; actCount++; }
  db.task_activity_links = db.task_activity_links.filter((l) => l.project_task_id !== t.id);
  db.task_custom_values = db.task_custom_values.filter((v) => v.task_id !== t.id); // E9
  db.project_tasks = db.project_tasks.filter((x) => x.id !== t.id);
  const kept: string[] = [];
  if (logCount) kept.push(`${logCount} time log(s) re-parented to the project`);
  if (actCount) kept.push(`${actCount} note/activity record(s) kept at project level`);
  logActivity({
    project_id: p.id, user_id: userId, kind: "system",
    note: `deleted task "${t.name}"${kept.length ? ` — ${kept.join(", ")}` : ""}`,
  });
  return ok({ ok: true });
});
route("POST", "/api/tasks/:id/status", (m, _q, b) => {
  const t = db.project_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Task not found");
  const p = db.projects.find((x) => x.id === t.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  // Only Task Status values qualify — an id from another picklist would make
  // the task invisible to done/blocked logic and closure checks.
  const target = valuesFor("Task Status").find((v) => v.id === b.status_id);
  if (!target) return err(400, "Unknown status");
  // E4: archived statuses (Skipped) can't be newly assigned
  if (target.archived && target.id !== t.status_id)
    return err(400, `"${target.label}" is archived and can no longer be assigned. Delete the task instead.`);
  if (!target.is_active && target.id !== t.status_id)
    return err(400, `"${target.label}" is deactivated and can no longer be assigned`);
  const old = valueById(t.status_id);

  if (target.maps_to === "skipped" && t.required && !b.skip_reason?.trim())
    return err(422, "Skipping a required task needs a reason", { needs_skip_reason: true });

  let warning: string | null = null;
  if (DONE_TASK_KEYS.includes(target.maps_to ?? "")) {
    const done = doneStatusIds();
    const earlier = db.project_tasks.find(
      (x) => x.project_id === p.id && x.required &&
        x.step_order < t.step_order && x.id !== t.id && !done.includes(x.status_id)
    );
    if (earlier) warning = `Heads up: earlier required task "${earlier.name}" is still open.`;
  }

  const isDone = target.maps_to === "complete";
  t.status_id = b.status_id;
  if (target.maps_to === "skipped") t.skip_reason = b.skip_reason ?? null;
  t.completed_date = isDone ? today() : null;
  t.completed_by = isDone ? b.user_id : null;
  logActivity({
    project_id: p.id, project_task_id: t.id, user_id: b.user_id, kind: "status_change",
    note: `changed "${t.name}" from ${old?.label} to ${target.label}` +
      (target.maps_to === "skipped" && b.skip_reason ? ` — reason: ${b.skip_reason}` : ""),
    old_status: old?.label, new_status: target.label,
  });
  return ok({ task: serializeTask(t), warning });
});

// ---- time logs ----
/** Shared POST/PATCH validation: whole non-negative duration, ISO date, task in the same project. */
function timeLogProblem(l: { date: unknown; hours: number; minutes: number; project_id: number; project_task_id: unknown }): string | null {
  if (!Number.isInteger(l.hours) || !Number.isInteger(l.minutes) || l.hours < 0 || l.minutes < 0 || l.minutes > 59 || l.hours + l.minutes === 0)
    return "Enter a positive duration (minutes 0–59)";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.date))) return "Date must be YYYY-MM-DD";
  if (l.project_task_id != null) {
    const t = db.project_tasks.find((x) => x.id === Number(l.project_task_id));
    if (!t) return "Task not found";
    if (t.project_id !== l.project_id) return "Task must belong to the same project as the time entry";
  }
  return null;
}
route("GET", "/api/timelogs", (_m, q) => {
  let out = db.time_logs.slice();
  if (q.get("user_id")) out = out.filter((l) => l.user_id === Number(q.get("user_id")));
  if (q.get("project_id")) out = out.filter((l) => l.project_id === Number(q.get("project_id")));
  // E1: the task modal lists the same records the Time Log area shows
  if (q.get("task_id")) out = out.filter((l) => l.project_task_id === Number(q.get("task_id")));
  if (q.get("start")) out = out.filter((l) => l.date >= q.get("start")!);
  if (q.get("end")) out = out.filter((l) => l.date <= q.get("end")!);
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return ok(out.map(serializeLog));
});
route("POST", "/api/timelogs", (_m, _q, b) => {
  if (!b.project_id || !b.user_id || !b.date) return err(400, "Project, user and date are required");
  const h = Number(b.hours ?? 0), min = Number(b.minutes ?? 0);
  const p = db.projects.find((x) => x.id === b.project_id);
  if (!p) return err(404, "Project not found");
  const problem = timeLogProblem({ date: b.date, hours: h, minutes: min, project_id: p.id, project_task_id: b.project_task_id ?? null });
  if (problem) return err(400, problem);
  // Closed projects are permanent historical records — their timecards included
  if (isClosedStatus(p.status_id)) return err(400, "This project is closed — its time log is read-only");
  const l: Row = {
    id: nextId(), project_id: b.project_id, project_task_id: b.project_task_id ?? null,
    user_id: b.user_id, date: b.date, hours: h, minutes: min,
    activity_type_id: b.activity_type_id ?? null, notes: b.notes ?? "", created_date: now(),
  };
  db.time_logs.push(l);
  return ok(serializeLog(l), 201);
});
route("PATCH", "/api/timelogs/:id", (m, _q, b) => {
  const l = db.time_logs.find((x) => x.id === Number(m.id));
  if (!l) return err(404, "Time entry not found");
  // Author-only, like notes and wins — a time entry is the author's record
  const editorId = Number(b.user_id);
  if (!editorId || editorId !== l.user_id) return err(403, "Only the author can edit this time entry");
  const p = db.projects.find((x) => x.id === l.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "This project is closed — its time log is read-only");
  const fields = ["date", "hours", "minutes", "activity_type_id", "notes", "project_task_id"];
  // Validate the merged record with the same rules as POST
  const next = { ...l, ...Object.fromEntries(fields.filter((f) => f in b).map((f) => [f, b[f]])) };
  const problem = timeLogProblem({
    date: next.date, hours: Number(next.hours), minutes: Number(next.minutes),
    project_id: l.project_id, project_task_id: next.project_task_id ?? null,
  });
  if (problem) return err(400, problem);
  for (const f of fields) if (f in b) l[f] = b[f];
  return ok(serializeLog(l));
});
route("DELETE", "/api/timelogs/:id", (m, q, b) => {
  const l = db.time_logs.find((x) => x.id === Number(m.id));
  if (!l) return err(404, "Time entry not found");
  const userId = Number(q.get("user_id") ?? b?.user_id);
  if (!userId || userId !== l.user_id) return err(403, "Only the author can delete this time entry");
  const p = db.projects.find((x) => x.id === l.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "This project is closed — its time log is read-only");
  db.time_logs = db.time_logs.filter((x) => x.id !== l.id);
  return ok({ ok: true });
});

// ---- activities (Notes & Activity module, v2 §5) ----
route("GET", "/api/activities", (_m, q) => {
  let out = db.activities.slice();
  if (q.get("project_id")) out = out.filter((a) => a.project_id === Number(q.get("project_id")));
  if (q.get("task_id")) out = out.filter((a) => a.project_task_id === Number(q.get("task_id")));
  if (q.get("kind")) {
    const kinds = q.get("kind")!.split(",").map((k) => k.trim()).filter(Boolean);
    out = out.filter((a) => kinds.includes(a.kind));
  }
  out.sort((a, b) => (a.activity_date < b.activity_date ? 1 : a.activity_date > b.activity_date ? -1 : b.id - a.id));
  const limit = Number(q.get("limit"));
  if (limit > 0) out = out.slice(0, limit);
  return ok(out.map(serializeActivity));
});
route("GET", "/api/activities/:id", (m) => {
  const a = db.activities.find((x) => x.id === Number(m.id));
  if (!a) return err(404, "Activity not found");
  return ok(serializeActivity(a));
});
route("POST", "/api/activities", (_m, _q, b) => {
  const isActivity = b.kind === "activity";
  if (!b.project_id || !b.note?.trim()) return err(400, "Project and note text are required");
  const p = db.projects.find((x) => x.id === b.project_id);
  if (!p) return err(404, "Project not found");
  if (isClosedStatus(p.status_id)) return err(400, "This project is closed — its history is read-only");

  if (isActivity) {
    if (!b.activity_type_id) return err(400, "Pick an activity type (call, visit, meeting…)");
    if (!b.activity_date) return err(400, "Activity date is required");
    const timeRe = /^\d{2}:\d{2}$/;
    for (const [label, v] of [["Start time", b.start_time], ["End time", b.end_time]] as const)
      if (v && !timeRe.test(v)) return err(400, `${label} must be HH:MM`);
    if (b.start_time && b.end_time && b.start_time >= b.end_time) return err(400, "End time must be after start time");
  }
  const linkIds: number[] = Array.isArray(b.task_ids) ? b.task_ids.map(Number).filter(Boolean) : [];
  for (const tid of linkIds) {
    const t = db.project_tasks.find((x) => x.id === tid);
    if (!t) return err(400, `Linked task ${tid} not found`);
    if (t.project_id !== Number(b.project_id)) return err(400, "Linked tasks must belong to the same project");
  }
  // The v1 single-task attachment gets the same membership check as task_ids
  if (b.project_task_id != null) {
    const t = db.project_tasks.find((x) => x.id === Number(b.project_task_id));
    if (!t) return err(400, "Task not found");
    if (t.project_id !== Number(b.project_id)) return err(400, "The task must belong to the same project as the note");
  }

  const a = logActivity({
    project_id: b.project_id,
    project_task_id: b.project_task_id,
    user_id: b.user_id,
    kind: isActivity ? "activity" : "note",
    category_id: isActivity ? null : b.category_id,
    activity_type_id: isActivity ? b.activity_type_id : null,
    activity_date: isActivity ? `${b.activity_date} ${b.start_time ?? "00:00"}:00` : undefined,
    start_time: isActivity ? b.start_time ?? null : null,
    end_time: isActivity ? b.end_time ?? null : null,
    note: b.note.trim(),
  });
  for (const tid of linkIds) db.task_activity_links.push({ id: nextId(), project_task_id: tid, activity_id: a.id });
  return ok(serializeActivity(a), 201);
});
/** Author-only in-place edit of a note or logged activity — port of PATCH /api/activities/:id. */
route("PATCH", "/api/activities/:id", (m, _q, b) => {
  const a = db.activities.find((x) => x.id === Number(m.id));
  if (!a) return err(404, "Activity not found");
  if (a.kind !== "note" && a.kind !== "activity")
    return err(400, "Status changes and system entries can't be edited");
  const editorId = Number(b.user_id);
  if (!a.user_id || !editorId || a.user_id !== editorId) return err(403, "Only the author can edit this record");
  const p = db.projects.find((x) => x.id === a.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "This project is closed — its history is read-only");
  if ("note" in b && !b.note?.trim()) return err(400, "Note text is required");

  if (a.kind === "note") {
    if ("note" in b) a.note = b.note.trim();
    if ("category_id" in b) a.category_id = b.category_id ?? null;
    return ok(serializeActivity(a));
  }

  // kind === 'activity' — merge submitted fields over current values, then re-validate like POST
  const next = {
    note: "note" in b ? b.note.trim() : a.note,
    activity_type_id: "activity_type_id" in b ? b.activity_type_id : a.activity_type_id,
    activity_date: "activity_date" in b ? b.activity_date : (a.activity_date ?? "").slice(0, 10),
    start_time: "start_time" in b ? b.start_time || null : a.start_time,
    end_time: "end_time" in b ? b.end_time || null : a.end_time,
  };
  if (!next.activity_type_id) return err(400, "Pick an activity type (call, visit, meeting…)");
  if (!next.activity_date || !/^\d{4}-\d{2}-\d{2}$/.test(next.activity_date)) return err(400, "Activity date is required");
  const timeRe = /^\d{2}:\d{2}$/;
  for (const [label, v] of [["Start time", next.start_time], ["End time", next.end_time]] as const)
    if (v && !timeRe.test(v)) return err(400, `${label} must be HH:MM`);
  if (next.start_time && next.end_time && next.start_time >= next.end_time)
    return err(400, "End time must be after start time");

  const linkIds: number[] | null = "task_ids" in b
    ? (Array.isArray(b.task_ids) ? b.task_ids.map(Number).filter(Boolean) : [])
    : null;
  for (const tid of linkIds ?? []) {
    const t = db.project_tasks.find((x) => x.id === tid);
    if (!t) return err(400, `Linked task ${tid} not found`);
    if (t.project_id !== a.project_id) return err(400, "Linked tasks must belong to the same project");
  }
  a.note = next.note;
  a.activity_type_id = next.activity_type_id;
  a.start_time = next.start_time;
  a.end_time = next.end_time;
  a.activity_date = `${next.activity_date} ${next.start_time ?? "00:00"}:00`;
  if (linkIds) {
    db.task_activity_links = db.task_activity_links.filter((l) => l.activity_id !== a.id);
    for (const tid of linkIds) db.task_activity_links.push({ id: nextId(), project_task_id: tid, activity_id: a.id });
  }
  return ok(serializeActivity(a));
});

// ---- wins (v2 §3) ----
route("GET", "/api/wins", (_m, q) => {
  let out = db.wins.slice();
  if (q.get("project_id")) out = out.filter((w) => w.project_id === Number(q.get("project_id")));
  if (q.get("category_id")) out = out.filter((w) => w.category_id === Number(q.get("category_id")));
  if (q.get("start")) out = out.filter((w) => w.occurred_date >= q.get("start")!);
  if (q.get("end")) out = out.filter((w) => w.occurred_date <= q.get("end")!);
  out.sort((a, b) => (a.occurred_date < b.occurred_date ? 1 : a.occurred_date > b.occurred_date ? -1 : b.id - a.id));
  return ok(out.map(serializeWin));
});
route("POST", "/api/wins", (_m, _q, b) => {
  if (!b.project_id || !b.description?.trim()) return err(400, "Project and description are required");
  const p = db.projects.find((x) => x.id === b.project_id);
  if (!p) return err(404, "Project not found");
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only — wins are logged while the project is open");
  const occurred = b.occurred_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred)) return err(400, "Occurred date must be YYYY-MM-DD");
  const w: Row = {
    id: nextId(), project_id: b.project_id, description: b.description.trim(),
    category_id: b.category_id ?? null, occurred_date: occurred, logged_date: now(), logged_by: b.user_id ?? null,
    activity_id: null,
  };
  db.wins.push(w);
  const note = logActivity({ project_id: b.project_id, user_id: b.user_id, kind: "system", note: `logged a win: "${w.description}"` });
  w.activity_id = note.id;
  return ok(serializeWin(w), 201);
});
/** E8: in-place, author-only win editing (same pattern as note/activity edits). Audited. */
route("PATCH", "/api/wins/:id", (m, _q, b) => {
  const w = db.wins.find((x) => x.id === Number(m.id));
  if (!w) return err(404, "Win not found");
  const p = db.projects.find((x) => x.id === w.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  const editorId = Number(b.user_id);
  if (!editorId || !w.logged_by || editorId !== w.logged_by) return err(403, "Only the author of a win can edit it");
  const next = {
    description: "description" in b ? String(b.description ?? "").trim() : w.description,
    category_id: "category_id" in b ? b.category_id ?? null : w.category_id,
    occurred_date: "occurred_date" in b ? b.occurred_date : w.occurred_date,
  };
  if (!next.description) return err(400, "Description is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next.occurred_date ?? "")) return err(400, "Occurred date must be YYYY-MM-DD");
  logActivity({
    project_id: w.project_id, user_id: editorId, kind: "system",
    note: next.description !== w.description
      ? `edited a win: "${w.description}" \u2192 "${next.description}"`
      : `edited a win: "${next.description}"`,
  });
  w.description = next.description;
  w.category_id = next.category_id;
  w.occurred_date = next.occurred_date;
  return ok(serializeWin(w));
});

/** B4: author-only, audited deletion; the creation system note is cleaned up too. */
route("DELETE", "/api/wins/:id", (m, q, b) => {
  const w = db.wins.find((x) => x.id === Number(m.id));
  if (!w) return err(404, "Win not found");
  const p = db.projects.find((x) => x.id === w.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  const userId = Number(q.get("user_id") ?? b?.user_id);
  if (!userId || !w.logged_by || userId !== w.logged_by) return err(403, "Only the author of a win can delete it");
  if (w.activity_id) {
    db.activities = db.activities.filter((a) => !(a.id === w.activity_id && a.kind === "system"));
  } else {
    // At most ONE matching note, and never one another win still points at —
    // an unscoped text match could delete a twin win's note.
    const referenced = new Set(db.wins.filter((x) => x.id !== w.id && x.activity_id != null).map((x) => x.activity_id));
    const victim = db.activities
      .filter((a) => a.project_id === w.project_id && a.kind === "system" && a.note === `logged a win: "${w.description}"` && !referenced.has(a.id))
      .sort((a, b2) => a.id - b2.id)[0];
    if (victim) db.activities = db.activities.filter((a) => a.id !== victim.id);
  }
  db.wins = db.wins.filter((x) => x.id !== w.id);
  logActivity({ project_id: w.project_id, user_id: userId, kind: "system", note: `deleted a win: "${w.description}"` });
  return ok({ ok: true });
});

// ---- dashboard (v2 §2) ----
function isoOfDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return isoOfDate(d);
}

route("GET", "/api/dashboard", (_m, q) => {
  const userId = q.get("user_id") ? Number(q.get("user_id")) : null;
  const user = userId ? db.users.find((u) => u.id === userId) : undefined;
  // dashboard_scope = 'mine' narrows every panel to the user's projects/tasks
  // (same rule as "My open work"); no signed-in user means no scoping.
  const mine = !!user && (user.dashboard_scope ?? "mine") === "mine";
  const everyProject = db.projects.map((p) => serializeProject(p));
  const all = mine ? everyProject.filter((p) => p.assignee_id === userId) : everyProject;
  const mineProjectIds = new Set(all.map((p) => p.id));
  const taskIsMine = (x: Row) => (x.assigned_to ? x.assigned_to === userId : mineProjectIds.has(x.project_id));
  const active = all.filter((p) => !p.is_closed);
  const ragBreakdown: Record<string, number> = { red: 0, amber: 0, green: 0 };
  // E10: total Annualized Premium alongside the count for each RAG state
  const ragAp: Record<string, number> = { red: 0, amber: 0, green: 0 };
  for (const p of active) {
    ragBreakdown[p.rag] = (ragBreakdown[p.rag] ?? 0) + 1;
    ragAp[p.rag] = (ragAp[p.rag] ?? 0) + (p.annualized_premium ?? 0);
  }

  const done = doneStatusIds();
  const blockedVal = valuesFor("Task Status").find((v) => v.maps_to === "blocked");
  const blockedId = blockedVal?.id;
  const closedIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const t = today();
  const yesterday = addDaysIso(t, -1);
  const weekAgo = addDaysIso(t, -7);
  const openTasks = db.project_tasks
    .filter((x) => !done.includes(x.status_id))
    .filter((x) => {
      const p = db.projects.find((pp) => pp.id === x.project_id);
      return p && !closedIds.includes(p.status_id);
    })
    .filter((x) => !mine || taskIsMine(x))
    .map((x): Row => {
      const p = db.projects.find((pp) => pp.id === x.project_id)!;
      return { ...x, project_code: p.project_code, mcp_name: p.mcp_name };
    });

  const overdue = openTasks.filter((x) => x.due_date && x.due_date < t).sort((a, b) => (a.due_date < b.due_date ? -1 : 1)).slice(0, 10);
  const blocked = openTasks.filter((x) => x.status_id === blockedId);
  const myOpen = userId
    ? openTasks
        .filter((x) => (x.assigned_to ? x.assigned_to === userId : everyProject.find((p) => p.id === x.project_id)?.assignee_id === userId))
        .sort((a, b) => ((a.due_date ?? "9999") < (b.due_date ?? "9999") ? -1 : 1)).slice(0, 10)
    : [];

  // Trend indicators
  const createdThisWeek = active.filter((p) => p.created_date && p.created_date.slice(0, 10) >= weekAgo).length;
  const newlyOverdue = openTasks.filter((x) => x.due_date === yesterday).length;
  const closedThisWeek = all.filter((p) => p.is_closed && p.closed_date && p.closed_date.slice(0, 10) >= weekAgo).length;
  const blockedThisWeek = blockedVal
    ? db.activities.filter(
        (a) => a.kind === "status_change" && a.new_status === blockedVal.label && a.activity_date >= weekAgo &&
          (!mine || db.projects.find((p) => p.id === a.project_id)?.assignee_id === userId)
      ).length
    : 0;
  const trends = {
    active: createdThisWeek ? `+${createdThisWeek} this week` : "No change this week",
    overdue: newlyOverdue ? `+${newlyOverdue} since yesterday` : "No change since yesterday",
    blocked: blockedThisWeek ? `+${blockedThisWeek} this week` : "No change this week",
    closed: closedThisWeek ? `+${closedThisWeek} this week` : "No change this week",
  };

  // "This Week": tasks due + activities, Monday–Sunday
  const nowDate = new Date();
  const monday = new Date(nowDate);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const wkStart = isoOfDate(monday);
  const wkEnd = addDaysIso(wkStart, 6);
  const nowStamp = nowDate.toISOString().slice(0, 16).replace("T", " ");

  const weekTasks = db.project_tasks.filter((x) => {
    if (!x.due_date || x.due_date < wkStart || x.due_date > wkEnd) return false;
    if (mine && !taskIsMine(x)) return false;
    const p = db.projects.find((pp) => pp.id === x.project_id);
    return p && !closedIds.includes(p.status_id);
  });
  const weekActivities = db.activities.filter(
    (a) => a.kind === "activity" && a.activity_date >= wkStart + " 00:00:00" && a.activity_date <= wkEnd + " 23:59:59" &&
      (!mine || mineProjectIds.has(a.project_id))
  );
  const thisWeek = [
    ...weekTasks.map((x) => {
      const p = db.projects.find((pp) => pp.id === x.project_id)!;
      return {
        kind: "task", id: x.id, project_id: x.project_id, name: x.name, date: x.due_date,
        time: null as string | null, type_key: "task", type_label: "Task due",
        mcp_name: p.mcp_name, done: done.includes(x.status_id),
      };
    }),
    ...weekActivities.map((a) => {
      const p = db.projects.find((pp) => pp.id === a.project_id)!;
      const type = valueById(a.activity_type_id);
      return {
        kind: "activity", id: a.id, project_id: a.project_id,
        name: a.note?.length > 60 ? a.note.slice(0, 57) + "…" : a.note || type?.label || "Activity",
        date: a.activity_date.slice(0, 10), time: a.start_time ?? null,
        type_key: type?.maps_to ?? "other", type_label: type?.label ?? "Activity",
        mcp_name: p.mcp_name, done: a.activity_date <= nowStamp,
      };
    }),
  ].sort((a, b) => (a.date + (a.time ?? "99:99")).localeCompare(b.date + (b.time ?? "99:99")));

  const recentActivity = db.activities
    .filter((a) => !mine || mineProjectIds.has(a.project_id))
    .sort((a, b) => (a.activity_date < b.activity_date ? 1 : a.activity_date > b.activity_date ? -1 : b.id - a.id))
    .slice(0, 15)
    .map(serializeActivity);

  const recentWins = db.wins
    .filter((w) => w.occurred_date >= addDaysIso(t, -30) && (!mine || mineProjectIds.has(w.project_id)))
    .sort((a, b) => (a.occurred_date < b.occurred_date ? 1 : a.occurred_date > b.occurred_date ? -1 : b.id - a.id))
    .slice(0, 6)
    .map(serializeWin);

  const pick = (x: any) => ({ id: x.id, project_id: x.project_id, name: x.name, due_date: x.due_date, project_code: x.project_code, mcp_name: x.mcp_name });
  return ok({
    scope: mine ? "mine" : "all",
    active_count: active.length,
    closed_count: all.length - active.length,
    closed_this_week: closedThisWeek,
    trends,
    rag_breakdown: ragBreakdown,
    rag_ap: ragAp,
    overdue_tasks: overdue.map(pick),
    blocked_tasks: blocked.map(pick),
    my_open_tasks: myOpen.map(pick),
    week_start: wkStart,
    this_week: thisWeek,
    recent_activity: recentActivity,
    recent_wins: recentWins,
    attention: active.filter((p) => p.rag === "red").slice(0, 8),
  });
});

// ---- import ----
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function validateImport(csvText: string): { rows: any[]; headerError?: string } {
  const raw = parseCsv(csvText);
  if (!raw.length) return { rows: [], headerError: "File is empty" };
  const header = raw[0].map(normalizeHeader);
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iMcp = col(["mcp_number", "mcp_", "mcp"]);
  const iName = col(["mcp_name", "customer", "customer_name"]);
  const iProjectName = col(["project_name"]); // E3: optional
  const iAssignee = col(["assignee", "assignee_name", "assigned_to"]);
  const iAp = col(["ap", "annualized_premium", "annualized_premium_ap", "annual_premium"]);
  const iDate = col(["assignment_date", "assigned", "date"]);
  const iTpl = col(["template", "template_name", "workflow_template"]);
  if (iMcp < 0 || iName < 0)
    return { rows: [], headerError: "Header must include at least 'MCP Number' and 'MCP Name' columns (plus 'AP'; optional: Assignee, Assignment Date, Template)" };
  const templates = db.workflow_templates.filter((t) => t.is_active);
  const defaultTpl = templates.find((t) => t.is_default) ?? templates[0];
  const active = activeStatusIds();
  const seen = new Set<string>();
  const customCols: [Row, number][] = activeCustomFields("project")
    .map((f): [Row, number] => [f, col([normalizeHeader(f.label), f.field_key])])
    .filter(([, i]) => i >= 0);

  const rows = raw.slice(1).map((r, idx) => {
    const row: any = {
      line: idx + 2,
      mcp_number: (r[iMcp] ?? "").trim(),
      mcp_name: (r[iName] ?? "").trim(),
      project_name: iProjectName >= 0 ? (r[iProjectName] ?? "").trim() : "",
      assignee: iAssignee >= 0 ? (r[iAssignee] ?? "").trim() : "",
      annualized_premium: null as number | null,
      assignment_date: iDate >= 0 ? (r[iDate] ?? "").trim() : "",
      template: iTpl >= 0 ? (r[iTpl] ?? "").trim() : "",
      errors: [] as string[],
      custom: {} as Record<string, string | null>,
    };
    if (!row.mcp_number) row.errors.push("MCP # is required");
    if (!row.mcp_name) row.errors.push("MCP Name is required");
    if (row.mcp_number) {
      if (seen.has(row.mcp_number)) row.errors.push("Duplicate MCP # within this file");
      seen.add(row.mcp_number);
      const dup = db.projects.find((p) => p.mcp_number === row.mcp_number && active.includes(p.status_id));
      if (dup) row.errors.push(`MCP already has an active project (${dup.project_code})`);
    }
    if (row.assignee) {
      const u = db.users.find((u) => u.name.toLowerCase() === row.assignee.toLowerCase() || u.email.toLowerCase() === row.assignee.toLowerCase());
      if (!u) row.errors.push(`Unknown assignee "${row.assignee}"`);
      else row.assignee_id = u.id;
    } else row.errors.push("Assignee is required");
    // AP is required on every project — same rule as the create form
    const apRaw = iAp >= 0 ? (r[iAp] ?? "").trim() : "";
    if (!apRaw) row.errors.push("Annualized Premium (AP) is required");
    else {
      const n = parseCurrency(apRaw);
      if (n == null || !Number.isFinite(n) || n < 0) row.errors.push(`Invalid AP "${apRaw}" — use a dollar amount like 12500 or $12,500.00`);
      else row.annualized_premium = n;
    }
    if (row.assignment_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.assignment_date)) row.errors.push("Assignment date must be YYYY-MM-DD");
    if (!row.assignment_date) row.assignment_date = today();
    if (row.template) {
      const tpl = templates.find((t) => t.name.toLowerCase() === row.template.toLowerCase());
      if (!tpl) row.errors.push(`Unknown template "${row.template}"`);
      else row.template_id = tpl.id;
    } else {
      row.template_id = defaultTpl?.id;
      // Without this, preview called the row "Ready" and commit silently skipped it
      if (!row.template_id) row.errors.push("No active workflow template available — create or activate one first");
    }
    for (const [f, i] of customCols) {
      const parsed = parseCustomValue(f, r[i]);
      if (parsed.ok) row.custom[f.field_key] = parsed.value;
      else row.errors.push(parsed.error);
    }
    // Imported projects obey the same admin-configured requirement rules as the create form
    const provided: Record<string, unknown> = {
      project_code: "auto",
      mcp_number: row.mcp_number, mcp_name: row.mcp_name, project_name: row.project_name,
      // raw-cell fallback: a provided-but-invalid value is already flagged above
      assignee_id: row.assignee_id ?? (row.assignee || undefined),
      annualized_premium: row.annualized_premium ?? ((iAp >= 0 ? (r[iAp] ?? "").trim() : "") || undefined),
      assignment_date: row.assignment_date, template_id: row.template_id,
      ...row.custom,
    };
    for (const rule of db.field_requirements) {
      if (rule.object_type !== "project" || !rule.required || !["creation", "always"].includes(rule.required_at)) continue;
      const v = provided[rule.field_name];
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
        const msg = `${rule.label} is required`;
        if (!row.errors.includes(msg)) row.errors.push(msg);
      }
    }
    return row;
  });
  return { rows };
}

route("POST", "/api/import/projects/preview", (_m, _q, b) => {
  if (!b.csv?.trim()) return err(400, "No CSV content provided");
  const { rows, headerError } = validateImport(b.csv);
  if (headerError) return err(400, headerError);
  return ok({ rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length });
});
route("POST", "/api/import/projects/commit", (_m, _q, b) => {
  const { rows, headerError } = validateImport(b.csv ?? "");
  if (headerError) return err(400, headerError);
  const valid = rows.filter((r) => !r.errors.length && r.assignee_id && r.template_id);
  const statusNew = valueByMapsTo("Project Status", "new")!;
  const created: string[] = [];
  const fieldIdByKey = new Map(activeCustomFields("project").map((f) => [f.field_key, f.id]));
  for (const r of valid) {
    const code = nextProjectCode();
    const pid = nextId();
    db.projects.push({
      id: pid, project_code: code, mcp_number: r.mcp_number, mcp_name: r.mcp_name,
      project_name: r.project_name || null,
      assignee_id: r.assignee_id, annualized_premium: r.annualized_premium, assignment_date: r.assignment_date, target_date: null,
      template_id: r.template_id, status_id: statusNew.id, risk_level_id: null,
      rag_override: null, rag_override_reason: null,
      status_changed_date: now(), created_date: now(),
      closed_date: null, closed_by: null, close_reason_id: null, final_summary: null,
    });
    const parsed = new Map<number, string | null>();
    for (const [key, value] of Object.entries(r.custom as Record<string, string | null>)) {
      const fid = fieldIdByKey.get(key);
      if (fid) parsed.set(fid, value);
    }
    saveCustomValues("project", pid, parsed);
    generateTasksFromTemplate(pid, r.template_id, r.assignment_date, r.assignee_id ?? null);
    logActivity({ project_id: pid, user_id: b.user_id, kind: "system", note: `Project ${code} created via CSV import` });
    created.push(code);
  }
  return ok({ created: created.length, skipped: rows.length - valid.length, codes: created });
});

// ---------------- CSV export (returns content for a blob download) ----------------

function csvEscape(v: unknown): string {
  let s = v == null ? "" : String(v);
  // B5: neutralize spreadsheet formula injection (=, +, -, @ prefixes) — see server importexport.ts
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (headers: string[], rows: unknown[][]) =>
  [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");

export function demoCsv(url: string): { filename: string; csv: string } {
  const u = new URL(url, "http://demo");
  const q = u.searchParams;
  if (u.pathname === "/api/export/projects.csv") {
    let projects = db.projects.slice().sort((a, b) => (a.created_date < b.created_date ? -1 : 1)).map((p) => serializeProject(p));
    if (q.get("scope") === "active") projects = projects.filter((p) => !p.is_closed);
    if (q.get("scope") === "closed") projects = projects.filter((p) => p.is_closed);
    const customFields = activeCustomFields("project");
    return {
      filename: "projects.csv",
      csv: toCsv(
        ["Project ID", "MCP #", "MCP Name", "Project Name", "Assignee", "AP", "Assignment Date", "Status", "RAG", "Risk", "Open Tasks", "Created", "Closed", "Close Reason", ...customFields.map((f) => f.label)],
        projects.map((p) => [
          p.project_code, p.mcp_number, p.mcp_name, p.project_name ?? "", p.assignee_name, fmtCurrency(p.annualized_premium), p.assignment_date,
          p.status_label, p.rag.toUpperCase(), p.risk_label ?? "", p.open_task_count, p.created_date, p.closed_date ?? "", p.close_reason_label ?? "",
          ...customFields.map((f) => customCsvValue(p.custom?.[f.field_key])),
        ])
      ),
    };
  }
  if (u.pathname === "/api/export/timelogs.csv") {
    let logs = db.time_logs.slice();
    if (q.get("start")) logs = logs.filter((l) => l.date >= q.get("start")!);
    if (q.get("end")) logs = logs.filter((l) => l.date <= q.get("end")!);
    if (q.get("user_id")) logs = logs.filter((l) => l.user_id === Number(q.get("user_id")));
    logs.sort((a, b) => (a.date < b.date ? -1 : 1));
    // self-describing name matching the server: timecard-<start>-to-<end>.csv
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const start = q.get("start"), endDate = q.get("end");
    return {
      filename: start && endDate && iso.test(start) && iso.test(endDate) ? `timecard-${start}-to-${endDate}.csv` : "time-entries.csv",
      csv: toCsv(
        ["Date", "User", "Project ID", "MCP Name", "Task", "Hours", "Minutes", "Activity Type", "Notes"],
        logs.map((l) => {
          const s = serializeLog(l);
          return [l.date, s.user_name, s.project_code, s.mcp_name, s.task_name ?? "", l.hours, l.minutes, s.activity_type_label ?? "", l.notes];
        })
      ),
    };
  }
  if (u.pathname === "/api/export/wins.csv") {
    // Portfolio-wide structured wins (v2 §3), filterable by occurred-date range
    let rows = db.wins.slice();
    if (q.get("start")) rows = rows.filter((w) => w.occurred_date >= q.get("start")!);
    if (q.get("end")) rows = rows.filter((w) => w.occurred_date <= q.get("end")!);
    rows.sort((a, b) => (a.occurred_date < b.occurred_date ? 1 : -1));
    const out = rows.map(serializeWin);
    return {
      filename: "wins-report.csv",
      csv: toCsv(
        ["Occurred", "Logged", "Project ID", "MCP #", "MCP Name", "AP", "Category", "Win", "Logged By"],
        out.map((w) => [w.occurred_date, w.logged_date?.slice(0, 10) ?? "", w.project_code, w.mcp_number, w.mcp_name, fmtCurrency(w.annualized_premium), w.category_label ?? "", w.description, w.logged_by_name ?? ""])
      ),
    };
  }
  if (u.pathname === "/api/export/closures.csv") {
    const closedIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
    const rows = db.projects.filter((p) => closedIds.includes(p.status_id)).map((p) => serializeProject(p));
    return {
      filename: "closure-report.csv",
      csv: toCsv(
        ["Project ID", "MCP #", "MCP Name", "Assignee", "Assigned", "Closed", "Closed By", "Close Reason", "Final Summary"],
        rows.map((p) => [p.project_code, p.mcp_number, p.mcp_name, p.assignee_name, p.assignment_date, p.closed_date ?? "", p.closed_by_name ?? "", p.close_reason_label ?? "", p.final_summary ?? ""])
      ),
    };
  }
  return { filename: "export.csv", csv: "" };
}
