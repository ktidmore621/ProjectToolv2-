/**
 * In-browser "server" for the standalone demo build — a faithful port of the
 * Express routes in server/src/routes/*. Every business rule (one active
 * project per MCP, closure requirements, skip-requires-reason, soft warnings,
 * conditional action-plan generation, RAG engine, deactivate-not-delete)
 * behaves identically; the data just lives in this browser.
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

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
const settingNum = (key: string, fallback: number) => {
  const n = Number(db.settings[key]);
  return Number.isFinite(n) ? n : fallback;
};
const userName = (id: number | null | undefined) => db.users.find((u) => u.id === id)?.name;
const isClosedStatus = (statusId: number) => CLOSED_KEYS.includes(valueById(statusId)?.maps_to ?? "");
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
  const tasks = db.project_tasks.filter((x) => x.project_id === p.id && !x.conditional_pending);
  const open = tasks.filter((x) => !done.includes(x.status_id));

  if (blockedId && open.some((x) => x.status_id === blockedId))
    return { rag: "red", reason: "A task is blocked", overridden: false };
  for (const x of open)
    if (x.required && x.due_date && daysBetween(x.due_date, t) >= redOverdue)
      return { rag: "red", reason: `Required task "${x.name}" overdue ${daysBetween(x.due_date, t)}d`, overridden: false };
  if (p.target_date && p.target_date < t)
    return { rag: "red", reason: "Project target date missed", overridden: false };
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
    logged_by_name: userName(w.logged_by) ?? null,
  };
}

function serializeProject(p: Row, opts: { withTasks?: boolean } = {}) {
  const status = valueById(p.status_id);
  const risk = valueById(p.risk_level_id);
  const closeReason = valueById(p.close_reason_id);
  const rag = computeRag(p);
  const ragVal = valueByMapsTo("RAG Status", rag.rag);
  const done = doneStatusIds();
  const taskRows = db.project_tasks
    .filter((t) => t.project_id === p.id && !t.conditional_pending)
    .sort((a, b) => a.step_order - b.step_order || a.id - b.id);
  const open = taskRows.filter((t) => !done.includes(t.status_id));
  const nextDue = open.filter((t) => t.due_date).sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  const statusChanged = (p.status_changed_date ?? p.created_date).slice(0, 10);

  return {
    id: p.id, project_code: p.project_code, mcp_number: p.mcp_number, mcp_name: p.mcp_name,
    assignee_id: p.assignee_id, assignee_name: userName(p.assignee_id) ?? "—",
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
    tasks: opts.withTasks ? taskRows.map(serializeTask) : undefined,
  };
}

function closureProblems(projectId: number, body: { final_summary?: string | null; close_reason_id?: number | null; [k: string]: any }): string[] {
  const problems: string[] = [];
  const done = doneStatusIds();
  for (const t of db.project_tasks)
    if (t.project_id === projectId && t.required && !t.conditional_pending && !done.includes(t.status_id))
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
  const u = { id: nextId(), name: b.name.trim(), email: b.email.trim(), is_active: 1 };
  db.users.push(u);
  return ok(u, 201);
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
  const v = { id: nextId(), picklist_id: list.id, label: b.label.trim(), sort_order: max + 1, color: b.color || "#64748B", is_active: 1, is_default: 0, maps_to: null };
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
  if (b.is_default) {
    for (const x of db.picklist_values) if (x.picklist_id === v.picklist_id) x.is_default = 0;
    v.is_default = 1;
  }
  return ok(v);
});
route("DELETE", "/api/picklist-values/:id", (m) => {
  const v = db.picklist_values.find((x) => x.id === Number(m.id));
  if (!v) return err(404, "Value not found");
  const list = db.picklists.find((l) => l.id === v.picklist_id)!;
  if (list.is_system && v.maps_to)
    return err(400, "System values can't be deleted — deactivation isn't allowed either since board logic depends on them");
  const refs =
    db.projects.filter((p) => [p.status_id, p.risk_level_id, p.close_reason_id].includes(v.id)).length +
    db.project_tasks.filter((t) => [t.status_id, t.priority_id].includes(v.id)).length +
    db.time_logs.filter((l) => l.activity_type_id === v.id).length +
    db.activities.filter((a) => a.category_id === v.id || a.activity_type_id === v.id).length +
    db.wins.filter((w) => w.category_id === v.id).length +
    db.template_tasks.filter((t) => t.default_priority_id === v.id).length;
  if (refs > 0) {
    v.is_active = 0;
    return ok({ deactivated: true, message: `"${v.label}" is referenced by ${refs} record(s) — deactivated instead of deleted. Existing records keep it; it disappears from new dropdowns.` });
  }
  db.picklist_values = db.picklist_values.filter((x) => x.id !== v.id);
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
    can_edit: b.can_edit === false || b.can_edit === 0 ? 0 : 1, can_skip: b.can_skip ? 1 : 0,
    is_decision: 0, generation: b.generation === "action_plan" ? "action_plan" : "standard",
  };
  db.template_tasks.push(t);
  return ok(t, 201);
});
route("PATCH", "/api/template-tasks/:id", (m, _q, b) => {
  const t = db.template_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Template task not found");
  for (const f of ["name", "description", "required", "due_offset", "default_priority_id", "can_edit", "can_skip", "step_order", "generation"])
    if (f in b) t[f] = b[f];
  return ok(t);
});
route("DELETE", "/api/template-tasks/:id", (m) => {
  const t = db.template_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Template task not found");
  if (t.is_decision) return err(400, "The decision-point task can't be removed while action-plan tasks depend on it");
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
  if (s) out = out.filter((p) => [p.mcp_name, p.mcp_number, p.project_code, p.assignee_name].some((f) => f?.toLowerCase().includes(s)));
  return ok(out);
});
route("GET", "/api/projects/:id", (m) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  return ok(serializeProject(p, { withTasks: true }));
});
route("POST", "/api/projects", (_m, _q, b) => {
  if (!b.mcp_number?.trim() || !b.mcp_name?.trim() || !b.assignee_id || !b.assignment_date || !b.template_id)
    return err(400, "MCP #, MCP Name, Assignee, Assignment Date and Template are required");
  const reqErrs = requirementErrors("project", ["creation", "always"], { ...b, project_code: "auto" });
  if (reqErrs.length) return err(400, reqErrs.join("; "));
  const active = activeStatusIds();
  const dup = db.projects.find((p) => p.mcp_number === b.mcp_number && active.includes(p.status_id));
  if (dup) return err(409, `MCP ${b.mcp_number} already has an active project (${dup.project_code}). Close it before creating a new one.`);
  const tpl = db.workflow_templates.find((t) => t.id === Number(b.template_id) && t.is_active);
  if (!tpl) return err(400, "Selected template is not available");

  const code = `CAP-${String(db.projects.length + 1).padStart(4, "0")}`;
  const p: Row = {
    id: nextId(), project_code: code, mcp_number: b.mcp_number, mcp_name: b.mcp_name,
    assignee_id: b.assignee_id, assignment_date: b.assignment_date, target_date: b.target_date ?? null,
    template_id: b.template_id, status_id: valueByMapsTo("Project Status", "new")!.id,
    risk_level_id: b.risk_level_id ?? null, rag_override: null, rag_override_reason: null,
    status_changed_date: now(), created_date: now(),
    closed_date: null, closed_by: null, close_reason_id: null, final_summary: null,
  };
  db.projects.push(p);
  generateTasksFromTemplate(p.id, b.template_id, b.assignment_date);
  logActivity({ project_id: p.id, user_id: b.user_id, kind: "system", note: `Project ${code} created` });
  return ok(serializeProject(p, { withTasks: true }), 201);
});
route("PATCH", "/api/projects/:id", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  for (const f of ["mcp_name", "assignee_id", "target_date", "risk_level_id"]) if (f in b) p[f] = b[f];
  return ok(serializeProject(p, { withTasks: true }));
});
route("POST", "/api/projects/:id/status", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
  const target = valueById(b.status_id);
  if (!target) return err(400, "Unknown status");
  if (isClosedStatus(p.status_id))
    return err(400, "Closed projects are never reopened (§2.2). Create a new project for this MCP instead.");
  if (target.maps_to === "closed") {
    const problems = closureProblems(p.id, p);
    if (problems.length) return err(422, "Closure requirements not met", { problems, needs_close_form: true });
    return err(422, "Use the Close Project form", { needs_close_form: true, problems: [] });
  }
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
  const problems = closureProblems(p.id, b);
  if (problems.length && !b.override) return err(422, "Closure requirements not met", { problems });
  if (problems.length && b.override && !b.override_reason?.trim())
    return err(422, "An override reason is required", { problems });
  const closed = valueByMapsTo("Project Status", "closed")!;
  const old = valueById(p.status_id);
  p.status_id = closed.id;
  p.status_changed_date = now();
  p.closed_date = now();
  p.closed_by = b.user_id;
  p.close_reason_id = b.close_reason_id ?? null;
  p.final_summary = b.final_summary ?? null;
  logActivity({
    project_id: p.id, user_id: b.user_id, kind: "status_change",
    note: b.override ? `closed project with override: ${b.override_reason}` : "closed project",
    old_status: old?.label, new_status: closed.label,
  });
  return ok(serializeProject(p));
});
route("POST", "/api/projects/:id/rag-override", (m, _q, b) => {
  const p = db.projects.find((x) => x.id === Number(m.id));
  if (!p) return err(404, "Project not found");
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
  const reqErrs = requirementErrors("task", ["creation", "always"], b);
  if (reqErrs.length) return err(400, reqErrs.join("; "));
  const max = Math.max(0, ...db.project_tasks.filter((t) => t.project_id === p.id).map((t) => t.step_order));
  const t: Row = {
    id: nextId(), project_id: p.id, template_task_id: null, name: b.name.trim(), description: b.description ?? "",
    task_type: "adhoc", step_order: max + 1, assigned_to: b.assigned_to ?? null, due_date: b.due_date ?? null,
    status_id: valueByMapsTo("Task Status", "not_started")!.id, priority_id: b.priority_id ?? null,
    required: b.required ? 1 : 0, is_decision: 0, conditional_pending: 0,
    notes: "", skip_reason: null, completed_date: null, completed_by: null,
  };
  db.project_tasks.push(t);
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
    .filter((x) => !x.conditional_pending)
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
  return ok(out.map((x) => {
    const p = db.projects.find((pp) => pp.id === x.project_id)!;
    return { ...serializeTask(x), project_code: p.project_code, mcp_name: p.mcp_name };
  }));
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
  const editable = ["due_date", "assigned_to", "priority_id", "notes", "description"];
  if (t.task_type === "adhoc" || (tplTask?.can_edit ?? 1)) editable.push("name");
  for (const f of editable) if (f in b) t[f] = b[f];
  return ok(serializeTask(t));
});
route("DELETE", "/api/tasks/:id", (m) => {
  const t = db.project_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Task not found");
  if (t.task_type !== "adhoc") return err(400, "Standard template tasks cannot be removed (§2.4)");
  const p = db.projects.find((x) => x.id === t.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  db.project_tasks = db.project_tasks.filter((x) => x.id !== t.id);
  db.task_activity_links = db.task_activity_links.filter((l) => l.project_task_id !== t.id);
  return ok({ ok: true });
});
route("POST", "/api/tasks/:id/status", (m, _q, b) => {
  const t = db.project_tasks.find((x) => x.id === Number(m.id));
  if (!t) return err(404, "Task not found");
  const p = db.projects.find((x) => x.id === t.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  const target = valueById(b.status_id);
  if (!target) return err(400, "Unknown status");
  const old = valueById(t.status_id);

  if (target.maps_to === "skipped" && t.required && !b.skip_reason?.trim())
    return err(422, "Skipping a required task needs a reason", { needs_skip_reason: true });

  let decisionNote = "";
  if (t.is_decision && target.maps_to === "complete") {
    if (b.decision !== "yes" && b.decision !== "no")
      return err(422, "Answer the decision: is an action plan needed?", { needs_decision: true });
    const pending = db.project_tasks.filter((x) => x.project_id === p.id && x.conditional_pending);
    if (b.decision === "yes") {
      const notStarted = valueByMapsTo("Task Status", "not_started")!;
      for (const c of pending) {
        const tpl = db.template_tasks.find((x) => x.id === c.template_task_id);
        const due = new Date();
        due.setDate(due.getDate() + (tpl?.due_offset ?? 7));
        c.conditional_pending = 0;
        c.status_id = notStarted.id;
        c.due_date = due.toISOString().slice(0, 10);
      }
      decisionNote = pending.length ? ` — action plan needed: ${pending.length} action-plan task(s) generated` : " — action plan needed";
    } else {
      db.project_tasks = db.project_tasks.filter((x) => !(x.project_id === p.id && x.conditional_pending));
      decisionNote = " — no action plan needed";
    }
  }

  let warning: string | null = null;
  if (DONE_TASK_KEYS.includes(target.maps_to ?? "")) {
    const done = doneStatusIds();
    const earlier = db.project_tasks.find(
      (x) => x.project_id === p.id && x.required && !x.conditional_pending &&
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
      (target.maps_to === "skipped" && b.skip_reason ? ` — reason: ${b.skip_reason}` : "") + decisionNote,
    old_status: old?.label, new_status: target.label,
  });
  return ok({ task: serializeTask(t), warning });
});

// ---- time logs ----
route("GET", "/api/timelogs", (_m, q) => {
  let out = db.time_logs.slice();
  if (q.get("user_id")) out = out.filter((l) => l.user_id === Number(q.get("user_id")));
  if (q.get("project_id")) out = out.filter((l) => l.project_id === Number(q.get("project_id")));
  if (q.get("start")) out = out.filter((l) => l.date >= q.get("start")!);
  if (q.get("end")) out = out.filter((l) => l.date <= q.get("end")!);
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return ok(out.map(serializeLog));
});
route("POST", "/api/timelogs", (_m, _q, b) => {
  if (!b.project_id || !b.user_id || !b.date) return err(400, "Project, user and date are required");
  const h = Number(b.hours ?? 0), min = Number(b.minutes ?? 0);
  if (h < 0 || min < 0 || min > 59 || h + min === 0) return err(400, "Enter a positive duration (minutes 0–59)");
  if (!db.projects.some((p) => p.id === b.project_id)) return err(404, "Project not found");
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
  for (const f of ["date", "hours", "minutes", "activity_type_id", "notes", "project_task_id"]) if (f in b) l[f] = b[f];
  return ok(serializeLog(l));
});
route("DELETE", "/api/timelogs/:id", (m) => {
  db.time_logs = db.time_logs.filter((x) => x.id !== Number(m.id));
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
  };
  db.wins.push(w);
  logActivity({ project_id: b.project_id, user_id: b.user_id, kind: "system", note: `logged a win: "${w.description}"` });
  return ok(serializeWin(w), 201);
});
route("DELETE", "/api/wins/:id", (m) => {
  const w = db.wins.find((x) => x.id === Number(m.id));
  if (!w) return err(404, "Win not found");
  const p = db.projects.find((x) => x.id === w.project_id)!;
  if (isClosedStatus(p.status_id)) return err(400, "Closed projects are read-only");
  db.wins = db.wins.filter((x) => x.id !== w.id);
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
  const all = db.projects.map((p) => serializeProject(p));
  const active = all.filter((p) => !p.is_closed);
  const ragBreakdown: Record<string, number> = { red: 0, amber: 0, green: 0 };
  for (const p of active) ragBreakdown[p.rag] = (ragBreakdown[p.rag] ?? 0) + 1;

  const done = doneStatusIds();
  const blockedVal = valuesFor("Task Status").find((v) => v.maps_to === "blocked");
  const blockedId = blockedVal?.id;
  const closedIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const t = today();
  const yesterday = addDaysIso(t, -1);
  const weekAgo = addDaysIso(t, -7);
  const openTasks = db.project_tasks
    .filter((x) => !x.conditional_pending && !done.includes(x.status_id))
    .filter((x) => {
      const p = db.projects.find((pp) => pp.id === x.project_id);
      return p && !closedIds.includes(p.status_id);
    })
    .map((x): Row => {
      const p = db.projects.find((pp) => pp.id === x.project_id)!;
      return { ...x, project_code: p.project_code, mcp_name: p.mcp_name };
    });

  const overdue = openTasks.filter((x) => x.due_date && x.due_date < t).sort((a, b) => (a.due_date < b.due_date ? -1 : 1)).slice(0, 10);
  const blocked = openTasks.filter((x) => x.status_id === blockedId);
  const myOpen = userId
    ? openTasks
        .filter((x) => (x.assigned_to ? x.assigned_to === userId : all.find((p) => p.id === x.project_id)?.assignee_id === userId))
        .sort((a, b) => ((a.due_date ?? "9999") < (b.due_date ?? "9999") ? -1 : 1)).slice(0, 10)
    : [];

  // Trend indicators
  const createdThisWeek = active.filter((p) => p.created_date && p.created_date.slice(0, 10) >= weekAgo).length;
  const newlyOverdue = openTasks.filter((x) => x.due_date === yesterday).length;
  const closedThisWeek = all.filter((p) => p.is_closed && p.closed_date && p.closed_date.slice(0, 10) >= weekAgo).length;
  const blockedThisWeek = blockedVal
    ? db.activities.filter((a) => a.kind === "status_change" && a.new_status === blockedVal.label && a.activity_date >= weekAgo).length
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
    if (x.conditional_pending || !x.due_date || x.due_date < wkStart || x.due_date > wkEnd) return false;
    const p = db.projects.find((pp) => pp.id === x.project_id);
    return p && !closedIds.includes(p.status_id);
  });
  const weekActivities = db.activities.filter(
    (a) => a.kind === "activity" && a.activity_date >= wkStart + " 00:00:00" && a.activity_date <= wkEnd + " 23:59:59"
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
    .slice()
    .sort((a, b) => (a.activity_date < b.activity_date ? 1 : a.activity_date > b.activity_date ? -1 : b.id - a.id))
    .slice(0, 15)
    .map(serializeActivity);

  const recentWins = db.wins
    .filter((w) => w.occurred_date >= addDaysIso(t, -30))
    .sort((a, b) => (a.occurred_date < b.occurred_date ? 1 : a.occurred_date > b.occurred_date ? -1 : b.id - a.id))
    .slice(0, 6)
    .map(serializeWin);

  const pick = (x: any) => ({ id: x.id, project_id: x.project_id, name: x.name, due_date: x.due_date, project_code: x.project_code, mcp_name: x.mcp_name });
  return ok({
    active_count: active.length,
    closed_count: all.length - active.length,
    closed_this_week: closedThisWeek,
    trends,
    rag_breakdown: ragBreakdown,
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

function validateImport(csvText: string): { rows: any[]; headerError?: string } {
  const raw = parseCsv(csvText);
  if (!raw.length) return { rows: [], headerError: "File is empty" };
  const header = raw[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iMcp = col(["mcp_number", "mcp_", "mcp"]);
  const iName = col(["mcp_name", "customer", "customer_name"]);
  const iAssignee = col(["assignee", "assignee_name", "assigned_to"]);
  const iDate = col(["assignment_date", "assigned", "date"]);
  const iTpl = col(["template", "template_name", "workflow_template"]);
  if (iMcp < 0 || iName < 0)
    return { rows: [], headerError: "Header must include at least 'MCP Number' and 'MCP Name' columns (optional: Assignee, Assignment Date, Template)" };
  const templates = db.workflow_templates.filter((t) => t.is_active);
  const defaultTpl = templates.find((t) => t.is_default) ?? templates[0];
  const active = activeStatusIds();
  const seen = new Set<string>();

  const rows = raw.slice(1).map((r, idx) => {
    const row: any = {
      line: idx + 2,
      mcp_number: (r[iMcp] ?? "").trim(),
      mcp_name: (r[iName] ?? "").trim(),
      assignee: iAssignee >= 0 ? (r[iAssignee] ?? "").trim() : "",
      assignment_date: iDate >= 0 ? (r[iDate] ?? "").trim() : "",
      template: iTpl >= 0 ? (r[iTpl] ?? "").trim() : "",
      errors: [] as string[],
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
    if (row.assignment_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.assignment_date)) row.errors.push("Assignment date must be YYYY-MM-DD");
    if (!row.assignment_date) row.assignment_date = today();
    if (row.template) {
      const tpl = templates.find((t) => t.name.toLowerCase() === row.template.toLowerCase());
      if (!tpl) row.errors.push(`Unknown template "${row.template}"`);
      else row.template_id = tpl.id;
    } else row.template_id = defaultTpl?.id;
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
  for (const r of valid) {
    const code = `CAP-${String(db.projects.length + 1).padStart(4, "0")}`;
    const pid = nextId();
    db.projects.push({
      id: pid, project_code: code, mcp_number: r.mcp_number, mcp_name: r.mcp_name,
      assignee_id: r.assignee_id, assignment_date: r.assignment_date, target_date: null,
      template_id: r.template_id, status_id: statusNew.id, risk_level_id: null,
      rag_override: null, rag_override_reason: null,
      status_changed_date: now(), created_date: now(),
      closed_date: null, closed_by: null, close_reason_id: null, final_summary: null,
    });
    generateTasksFromTemplate(pid, r.template_id, r.assignment_date);
    logActivity({ project_id: pid, user_id: b.user_id, kind: "system", note: `Project ${code} created via CSV import` });
    created.push(code);
  }
  return ok({ created: created.length, skipped: rows.length - valid.length, codes: created });
});

// ---------------- CSV export (returns content for a blob download) ----------------

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
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
    return {
      filename: "projects.csv",
      csv: toCsv(
        ["Project ID", "MCP #", "MCP Name", "Assignee", "Assignment Date", "Status", "RAG", "Risk", "Open Tasks", "Created", "Closed", "Close Reason"],
        projects.map((p) => [p.project_code, p.mcp_number, p.mcp_name, p.assignee_name, p.assignment_date, p.status_label, p.rag.toUpperCase(), p.risk_label ?? "", p.open_task_count, p.created_date, p.closed_date ?? "", p.close_reason_label ?? ""])
      ),
    };
  }
  if (u.pathname === "/api/export/timelogs.csv") {
    let logs = db.time_logs.slice();
    if (q.get("start")) logs = logs.filter((l) => l.date >= q.get("start")!);
    if (q.get("end")) logs = logs.filter((l) => l.date <= q.get("end")!);
    if (q.get("user_id")) logs = logs.filter((l) => l.user_id === Number(q.get("user_id")));
    logs.sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
      filename: "time-entries.csv",
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
        ["Occurred", "Logged", "Project ID", "MCP #", "MCP Name", "Category", "Win", "Logged By"],
        out.map((w) => [w.occurred_date, w.logged_date?.slice(0, 10) ?? "", w.project_code, w.mcp_number, w.mcp_name, w.category_label ?? "", w.description, w.logged_by_name ?? ""])
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
