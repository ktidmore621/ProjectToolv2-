import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import {
  CLOSED_KEYS, DONE_TASK_KEYS, closureProblems, fmtCurrency, generateTasksFromTemplate, isClosedStatus,
  logActivity, nextProjectCode, saveCustomValues, serializeActivity, serializeProject, serializeTask,
  todayCentral, validateCustomValues, valueById, valueByMapsTo, valuesFor,
} from "../core.js";

export const projects = Router();

const activeStatusIds = () =>
  valuesFor("Project Status").filter((v) => !CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);

/** Enforce configurable field requirements (§5.3) for a given moment. */
function requirementErrors(objectType: string, at: string[], body: Record<string, any>): string[] {
  const rules = db
    .prepare(
      `SELECT field_name, label FROM field_requirements
       WHERE object_type = ? AND required = 1 AND required_at IN (${at.map(() => "?").join(",")})`
    )
    .all(objectType, ...at) as { field_name: string; label: string }[];
  const errs: string[] = [];
  for (const r of rules) {
    const v = body[r.field_name];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) errs.push(`${r.label} is required`);
  }
  return errs;
}

/**
 * E11: pagination is server-side. With ?page= the response becomes
 * { rows, total, page, page_size } (default page size 25) and filters/sorts
 * apply to the FULL result set before slicing. Without ?page= the plain
 * array is returned unchanged (kanban, dashboards, dropdowns).
 */
export function paginate<T>(out: T[], req: any, res: any): boolean {
  if (req.query.page === undefined) return false;
  const size = Math.min(200, Math.max(1, Number(req.query.page_size) || 25));
  const page = Math.max(1, Number(req.query.page) || 1);
  res.json({ rows: out.slice((page - 1) * size, page * size), total: out.length, page, page_size: size });
  return true;
}

const PROJECT_SORT_KEYS = new Set([
  "project_code", "mcp_number", "mcp_name", "project_name", "assignee_name", "annualized_premium",
  "status_label", "rag", "risk_label", "assignment_date", "target_date", "days_in_status",
  "open_task_count", "closed_date", "created_date",
]);

projects.get("/", (req, res) => {
  const { scope, assignee_id, rag, risk_level_id, template_id, q, sort, dir } = req.query as Record<string, string>;
  let rows = db.prepare("SELECT * FROM projects ORDER BY created_date DESC").all() as any[];
  let out = rows.map((p) => serializeProject(p));
  if (scope === "active") out = out.filter((p) => !p.is_closed);
  if (scope === "closed") out = out.filter((p) => p.is_closed);
  if (assignee_id) out = out.filter((p) => p.assignee_id === Number(assignee_id));
  if (rag) out = out.filter((p) => p.rag === rag);
  if (risk_level_id) out = out.filter((p) => p.risk_level_id === Number(risk_level_id));
  if (template_id) out = out.filter((p) => p.template_id === Number(template_id));
  if (q) {
    const s = q.toLowerCase();
    out = out.filter((p) =>
      [p.mcp_name, p.mcp_number, p.project_code, p.project_name, p.assignee_name, p.status_label, p.close_reason_label]
        .some((f) => f?.toLowerCase().includes(s))
    );
  }
  // E11: sorting happens server-side so it covers the full result set
  if (sort && (PROJECT_SORT_KEYS.has(sort) || sort.startsWith("cf_"))) {
    const d = dir === "desc" ? -1 : 1;
    const keyOf = (p: any) => (sort.startsWith("cf_") ? p.custom?.[sort]?.value ?? "" : p[sort] ?? "");
    out = [...out].sort((a, b) => {
      const av = keyOf(a), bv = keyOf(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * d;
    });
  }
  if (paginate(out, req, res)) return;
  res.json(out);
});

projects.get("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  res.json(serializeProject(p, { withTasks: true }));
});

const createSchema = z.object({
  mcp_number: z.string().min(1),
  mcp_name: z.string().min(1),
  project_name: z.string().nullish(), // E3: optional at creation
  assignee_id: z.number(),
  annualized_premium: z.number({ required_error: "Annualized Premium (AP) is required", invalid_type_error: "Annualized Premium (AP) must be a dollar amount" }).nonnegative("Annualized Premium (AP) must be a dollar amount"),
  assignment_date: z.string().min(1),
  target_date: z.string().nullish(),
  risk_level_id: z.number().nullish(),
  template_id: z.number(),
  custom: z.record(z.any()).nullish(), // { field_key: raw value } for admin-defined fields
  user_id: z.number(), // acting user
});

projects.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const b = parsed.data;

  const custom = validateCustomValues("project", b.custom);
  if (custom.errors.length) return res.status(400).json({ error: custom.errors.join("; ") });

  const reqErrs = requirementErrors("project", ["creation", "always"], { ...b, ...custom.flat, project_code: "auto" });
  if (reqErrs.length) return res.status(400).json({ error: reqErrs.join("; ") });

  // One active project per MCP (§2.3) — enforced server-side
  const ids = activeStatusIds();
  const dup = db
    .prepare(`SELECT project_code FROM projects WHERE mcp_number = ? AND status_id IN (${ids.map(() => "?").join(",")})`)
    .get(b.mcp_number, ...ids) as { project_code: string } | undefined;
  if (dup)
    return res.status(409).json({ error: `MCP ${b.mcp_number} already has an active project (${dup.project_code}). Close it before creating a new one.` });

  const tpl = db.prepare("SELECT * FROM workflow_templates WHERE id = ? AND is_active = 1").get(b.template_id);
  if (!tpl) return res.status(400).json({ error: "Selected template is not available" });

  const statusNew = valueByMapsTo("Project Status", "new")!;
  const create = db.transaction(() => {
    const code = nextProjectCode();
    const pid = db
      .prepare(
        `INSERT INTO projects (project_code, mcp_number, mcp_name, project_name, assignee_id, annualized_premium, assignment_date, target_date, template_id, status_id, risk_level_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(code, b.mcp_number, b.mcp_name, b.project_name?.trim() || null, b.assignee_id, b.annualized_premium, b.assignment_date, b.target_date ?? null, b.template_id, statusNew.id, b.risk_level_id ?? null)
      .lastInsertRowid as number;
    saveCustomValues("project", pid, custom.parsed);
    generateTasksFromTemplate(pid, b.template_id, b.assignment_date, b.assignee_id);
    logActivity({ project_id: pid, user_id: b.user_id, kind: "system", note: `Project ${code} created` });
    return pid;
  });
  const pid = create();
  res.status(201).json(serializeProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(pid), { withTasks: true }));
});

projects.patch("/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });
  const userId = req.body.user_id ?? null;

  if ("annualized_premium" in req.body) {
    const n = Number(req.body.annualized_premium);
    if (!Number.isFinite(n) || n < 0)
      return res.status(400).json({ error: "Annualized Premium (AP) must be a dollar amount" });
    req.body.annualized_premium = n;
  }
  const custom = "custom" in req.body ? validateCustomValues("project", req.body.custom) : null;
  if (custom?.errors.length) return res.status(400).json({ error: custom.errors.join("; ") });

  const allowed = ["mcp_name", "project_name", "assignee_id", "annualized_premium", "target_date", "risk_level_id"] as const;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const f of allowed) {
    if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, p.id);
  }
  if (custom) saveCustomValues("project", p.id, custom.parsed);

  // Audit-log the changes that matter to the project history
  if ("annualized_premium" in req.body && Number(req.body.annualized_premium) !== p.annualized_premium) {
    logActivity({
      project_id: p.id, user_id: userId, kind: "system",
      note: `changed Annualized Premium (AP) from ${fmtCurrency(p.annualized_premium) || "—"} to ${fmtCurrency(Number(req.body.annualized_premium))}`,
    });
  }
  const newAssignee = "assignee_id" in req.body ? Number(req.body.assignee_id) : null;
  if (newAssignee && newAssignee !== p.assignee_id) {
    const nameOf = (id: number) => (db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "—";
    logActivity({
      project_id: p.id, user_id: userId, kind: "system",
      note: `changed project assignee from ${nameOf(p.assignee_id)} to ${nameOf(newAssignee)}`,
    });
    // Optional cascade: reassign only open tasks — Closed/Complete (and other done)
    // tasks are historical records and are never modified.
    if (req.body.reassign_open_tasks) {
      const doneIds = valuesFor("Task Status")
        .filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? ""))
        .map((v) => v.id);
      const r = db
        .prepare(
          `UPDATE project_tasks SET assigned_to = ?
           WHERE project_id = ? AND status_id NOT IN (${doneIds.map(() => "?").join(",")})`
        )
        .run(newAssignee, p.id, ...doneIds);
      logActivity({
        project_id: p.id, user_id: userId, kind: "system",
        note: `reassigned ${r.changes} open task(s) to ${nameOf(newAssignee)}`,
      });
    }
  }
  res.json(serializeProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id), { withTasks: true }));
});

/** Status change (Kanban drag or detail view). Closing goes through /close. */
projects.post("/:id/status", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  const { status_id, user_id } = req.body as { status_id: number; user_id: number };
  const target = valueById(status_id);
  if (!target) return res.status(400).json({ error: "Unknown status" });
  if ((target as any).archived)
    return res.status(400).json({ error: `"${target.label}" is archived and can no longer be assigned` });
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are never reopened (§2.2). Create a new project for this MCP instead." });

  if (target.maps_to === "closed") {
    const problems = closureProblems(p.id, { final_summary: p.final_summary, close_reason_id: p.close_reason_id });
    if (problems.length)
      return res.status(422).json({ error: "Closure requirements not met", problems, needs_close_form: true });
    return res.status(422).json({ error: "Use the Close Project form", needs_close_form: true, problems: [] });
  }
  // E5: Cancelled is a closure status — it goes through the same closure
  // workflow (/close with cancelled:true), never a plain status flip.
  if (target.maps_to === "cancelled") {
    return res.status(422).json({ error: "Use the Cancel Project form", needs_close_form: true, cancelled: true, problems: [] });
  }

  const old = valueById(p.status_id);
  db.prepare("UPDATE projects SET status_id = ?, status_changed_date = datetime('now') WHERE id = ?").run(status_id, p.id);
  logActivity({
    project_id: p.id, user_id, kind: "status_change",
    note: `changed project status from ${old?.label} to ${target.label}`,
    old_status: old?.label, new_status: target.label,
  });
  res.json(serializeProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id)));
});

const closeSchema = z.object({
  user_id: z.number(),
  final_summary: z.string().nullish(),
  close_reason_id: z.number().nullish(),
  override: z.boolean().nullish(),
  override_reason: z.string().nullish(),
  /** E5: cancel instead of close — same closure processing, different inputs. */
  cancelled: z.boolean().nullish(),
});

projects.post("/:id/close", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Project is already closed" });
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const b = parsed.data;

  const problems = closureProblems(p.id, b, { cancelled: !!b.cancelled });
  if (problems.length && !b.override)
    return res.status(422).json({ error: "Closure requirements not met", problems });
  if (problems.length && b.override && !b.override_reason?.trim())
    return res.status(422).json({ error: "An override reason is required", problems });

  const closed = valueByMapsTo("Project Status", b.cancelled ? "cancelled" : "closed")!;
  const old = valueById(p.status_id);
  db.prepare(
    `UPDATE projects SET status_id = ?, status_changed_date = datetime('now'), closed_date = datetime('now'),
       closed_by = ?, close_reason_id = ?, final_summary = ?, rag_override = NULL, rag_override_reason = NULL WHERE id = ?`
  ).run(closed.id, b.user_id, b.close_reason_id ?? null, b.final_summary ?? null, p.id);
  // B2: a manual RAG override outlives its purpose at closure — clearing it
  // here (audited) keeps historical reporting on "Closed = Green" instead of
  // freezing a stale Red/Amber on a read-only record forever.
  if (p.rag_override) {
    logActivity({
      project_id: p.id, user_id: b.user_id, kind: "system",
      note: `cleared manual RAG override (${String(p.rag_override).toUpperCase()}: ${p.rag_override_reason ?? "no reason recorded"}) as part of closure — closed projects report Green`,
    });
  }
  const verb = b.cancelled ? "cancelled" : "closed";
  logActivity({
    project_id: p.id, user_id: b.user_id, kind: "status_change",
    note: b.override
      ? `${verb} project with override: ${b.override_reason}`
      : `${verb} project`,
    old_status: old?.label, new_status: closed.label,
  });
  res.json(serializeProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id)));
});

/** RAG manual override with logged reason (§4.7). */
projects.post("/:id/rag-override", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  // Closed projects report "Closed = Green" (B2) — overrides can't be re-applied
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });
  const { rag, reason, user_id } = req.body as { rag: string | null; reason?: string; user_id: number };
  if (rag && !["red", "amber", "green"].includes(rag)) return res.status(400).json({ error: "Invalid RAG value" });
  if (rag && !reason?.trim()) return res.status(400).json({ error: "An override reason is required for auditability" });
  db.prepare("UPDATE projects SET rag_override = ?, rag_override_reason = ? WHERE id = ?").run(rag, reason ?? null, p.id);
  logActivity({
    project_id: p.id, user_id, kind: "system",
    note: rag ? `manually set RAG to ${rag.toUpperCase()}: ${reason}` : "cleared manual RAG override (back to auto-calculated)",
  });
  res.json(serializeProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(p.id)));
});

// ---------- Tasks ----------

projects.post("/:id/tasks", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });
  const { name, description, due_date, assigned_to, priority_id, required, user_id, initial_note } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Task name is required" });
  // E9: task custom fields validate exactly like project ones
  const custom = validateCustomValues("task", req.body.custom);
  if (custom.errors.length) return res.status(400).json({ error: custom.errors.join("; ") });
  const reqErrs = requirementErrors("task", ["creation", "always"], { ...req.body, ...custom.flat });
  if (reqErrs.length) return res.status(400).json({ error: reqErrs.join("; ") });

  const maxOrder = db
    .prepare("SELECT MAX(step_order) AS m FROM project_tasks WHERE project_id = ?")
    .get(p.id) as { m: number | null };
  const notStarted = valueByMapsTo("Task Status", "not_started")!;
  const id = db
    .prepare(
      `INSERT INTO project_tasks (project_id, name, description, task_type, step_order, due_date, assigned_to, status_id, priority_id, required)
       VALUES (?, ?, ?, 'adhoc', ?, ?, ?, ?, ?, ?)`
    )
    .run(p.id, name.trim(), description ?? "", (maxOrder.m ?? 0) + 1, due_date ?? null, assigned_to ?? null, notStarted.id, priority_id ?? null, required ? 1 : 0)
    .lastInsertRowid as number;
  saveCustomValues("task", id, custom.parsed);
  logActivity({ project_id: p.id, project_task_id: id, user_id, kind: "system", note: `added ad-hoc task "${name.trim()}"` });
  if (initial_note?.trim())
    logActivity({ project_id: p.id, project_task_id: id, user_id, kind: "note", note: initial_note.trim() });
  res.status(201).json(serializeTask(db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(id)));
});

export const tasks = Router();

/**
 * Cross-project task list (v2 §1). Tasks from closed projects are excluded —
 * they live in History. Filters are combinable: overdue=1, blocked=1,
 * assigned_to, project_id, status_id.
 */
tasks.get("/", (req, res) => {
  const { overdue, blocked, assigned_to, project_id, status_id } = req.query as Record<string, string>;
  const closedStatusIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const doneIds = valuesFor("Task Status").filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const blockedId = valueByMapsTo("Task Status", "blocked")?.id;
  const today = todayCentral(); // E6: overdue is judged on the Central calendar date

  let sql = `SELECT t.*, p.project_code, p.mcp_name, p.project_name, p.assignee_id AS project_assignee_id FROM project_tasks t
             JOIN projects p ON p.id = t.project_id
             WHERE p.status_id NOT IN (${closedStatusIds.map(() => "?").join(",")})`;
  const params: any[] = [...closedStatusIds];
  if (project_id) { sql += " AND t.project_id = ?"; params.push(Number(project_id)); }
  if (status_id) { sql += " AND t.status_id = ?"; params.push(Number(status_id)); }
  if (blocked === "1" && blockedId) { sql += " AND t.status_id = ?"; params.push(blockedId); }
  if (overdue === "1") {
    sql += ` AND t.due_date < ? AND t.status_id NOT IN (${doneIds.map(() => "?").join(",")})`;
    params.push(today, ...doneIds);
  }
  // Unassigned tasks belong to the project assignee, same rule as the dashboard
  if (assigned_to) {
    sql += " AND (t.assigned_to = ? OR (t.assigned_to IS NULL AND p.assignee_id = ?))";
    params.push(Number(assigned_to), Number(assigned_to));
  }
  sql += " ORDER BY (t.due_date IS NULL), t.due_date, p.project_code, t.step_order";
  const rows = db.prepare(sql).all(...params) as any[];
  const out = rows.map((t) => ({ ...serializeTask(t), project_code: t.project_code, mcp_name: t.mcp_name, project_name: t.project_name }));
  if (paginate(out, req, res)) return; // E11
  res.json(out);
});

/** All activities linked to this task through the many-to-many join (v2 §6). */
tasks.get("/:id/activities", (req, res) => {
  const t = db.prepare("SELECT id FROM project_tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Task not found" });
  const rows = db.prepare(
    `SELECT a.* FROM task_activity_links l JOIN activities a ON a.id = l.activity_id
     WHERE l.project_task_id = ? ORDER BY a.activity_date DESC, a.id DESC`
  ).all(req.params.id) as any[];
  res.json(rows.map(serializeActivity));
});

tasks.patch("/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Task not found" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(t.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });

  const tplTask = t.template_task_id
    ? (db.prepare("SELECT can_edit FROM template_tasks WHERE id = ?").get(t.template_task_id) as any)
    : null;
  // E9: task custom fields save through the same engine as project ones
  const custom = "custom" in req.body ? validateCustomValues("task", req.body.custom) : null;
  if (custom?.errors.length) return res.status(400).json({ error: custom.errors.join("; ") });
  const editable = ["due_date", "assigned_to", "priority_id", "notes", "description"];
  if (t.task_type === "adhoc" || (tplTask?.can_edit ?? 1)) editable.push("name");
  const sets: string[] = [];
  const vals: any[] = [];
  for (const f of editable) if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) db.prepare(`UPDATE project_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, t.id);
  if (custom) saveCustomValues("task", t.id, custom.parsed);
  res.json(serializeTask(db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(t.id)));
});

/**
 * E4: Delete replaces Skipped as the way to take a task out of a project —
 * any task type can be deleted (a required task that will never be done is
 * deleted outright rather than skipped). Linked data is unlinked and
 * preserved, never cascaded: time logs and notes/activities are re-parented
 * to the project so timecards, rollups and history lose nothing.
 */
tasks.delete("/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Task not found" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(t.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });
  const userId = Number(req.query.user_id ?? req.body?.user_id) || null;

  const remove = db.transaction(() => {
    const logs = db.prepare("UPDATE time_logs SET project_task_id = NULL WHERE project_task_id = ?").run(t.id);
    const acts = db.prepare("UPDATE activities SET project_task_id = NULL WHERE project_task_id = ?").run(t.id);
    // many-to-many links go with the task; the activity records themselves stay
    db.prepare("DELETE FROM task_activity_links WHERE project_task_id = ?").run(t.id);
    db.prepare("DELETE FROM project_tasks WHERE id = ?").run(t.id);
    const kept: string[] = [];
    if (logs.changes) kept.push(`${logs.changes} time log(s) re-parented to the project`);
    if (acts.changes) kept.push(`${acts.changes} note/activity record(s) kept at project level`);
    logActivity({
      project_id: p.id, user_id: userId, kind: "system",
      note: `deleted task "${t.name}"${kept.length ? ` — ${kept.join(", ")}` : ""}`,
    });
  });
  remove();
  res.json({ ok: true });
});

/**
 * Task status change — Kanban drag or detail view share this endpoint so rules
 * are enforced consistently (§4.2): skip-requires-reason, soft out-of-order
 * warning.
 */
tasks.post("/:id/status", (req, res) => {
  const t = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Task not found" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(t.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });

  const { status_id, user_id, skip_reason } = req.body as {
    status_id: number; user_id: number; skip_reason?: string;
  };
  const target = valueById(status_id);
  if (!target) return res.status(400).json({ error: "Unknown status" });
  // E4: archived statuses (Skipped) can't be newly assigned — legacy tasks
  // keep their status; delete the task instead of skipping it.
  if ((target as any).archived && target.id !== t.status_id)
    return res.status(400).json({ error: `"${target.label}" is archived and can no longer be assigned. Delete the task instead.` });
  const old = valueById(t.status_id);

  // Legacy skip rule kept for completeness; unreachable while Skipped is
  // archived (guarded above). E7 removed the never-consumed can_skip flag.
  if (target.maps_to === "skipped" && t.required && !skip_reason?.trim())
    return res.status(422).json({ error: "Skipping a required task needs a reason", needs_skip_reason: true });

  // Soft warning (§4.2): completing while an earlier required task is open
  let warning: string | null = null;
  if (DONE_TASK_KEYS.includes(target.maps_to ?? "")) {
    const doneIds = valuesFor("Task Status").filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
    const earlier = db
      .prepare(
        `SELECT name FROM project_tasks WHERE project_id = ? AND required = 1
           AND step_order < ? AND id != ? AND status_id NOT IN (${doneIds.map(() => "?").join(",")}) LIMIT 1`
      )
      .get(p.id, t.step_order, t.id, ...doneIds) as { name: string } | undefined;
    if (earlier) warning = `Heads up: earlier required task "${earlier.name}" is still open.`;
  }

  const isDone = target.maps_to === "complete";
  db.prepare(
    `UPDATE project_tasks SET status_id = ?, skip_reason = ?, completed_date = ?, completed_by = ? WHERE id = ?`
  ).run(
    status_id,
    target.maps_to === "skipped" ? (skip_reason ?? null) : t.skip_reason,
    isDone ? todayCentral() : null,
    isDone ? user_id : null,
    t.id
  );
  logActivity({
    project_id: p.id, project_task_id: t.id, user_id, kind: "status_change",
    note: `changed "${t.name}" from ${old?.label} to ${target.label}` +
      (target.maps_to === "skipped" && skip_reason ? ` — reason: ${skip_reason}` : ""),
    old_status: old?.label, new_status: target.label,
  });
  res.json({ task: serializeTask(db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(t.id)), warning });
});
