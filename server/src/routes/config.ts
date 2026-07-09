import { Router } from "express";
import { db, getSettingNum } from "../db.js";

export const config = Router();

// ---------- Users ----------
config.get("/users", (_req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE is_active = 1 ORDER BY name").all());
});
config.post("/users", (req, res) => {
  const { name, email } = req.body;
  if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: "Name and email are required" });
  try {
    const id = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(name.trim(), email.trim()).lastInsertRowid;
    res.status(201).json(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  } catch {
    res.status(409).json({ error: "A user with that email already exists" });
  }
});
/** Per-user preferences (not the shared Configuration data) — currently just dashboard scope. */
config.patch("/users/:id", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  const { dashboard_scope } = req.body;
  if (dashboard_scope !== undefined) {
    if (!["mine", "all"].includes(dashboard_scope))
      return res.status(400).json({ error: "dashboard_scope must be 'mine' or 'all'" });
    db.prepare("UPDATE users SET dashboard_scope = ? WHERE id = ?").run(dashboard_scope, req.params.id);
  }
  res.json(db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id));
});

// ---------- Picklists & values (§5.1) ----------
config.get("/picklists", (_req, res) => {
  const lists = db.prepare("SELECT * FROM picklists ORDER BY name").all() as any[];
  const values = db.prepare("SELECT * FROM picklist_values ORDER BY sort_order, id").all() as any[];
  res.json(lists.map((l) => ({ ...l, values: values.filter((v) => v.picklist_id === l.id) })));
});

config.post("/picklists/:id/values", (req, res) => {
  const list = db.prepare("SELECT * FROM picklists WHERE id = ?").get(req.params.id) as any;
  if (!list) return res.status(404).json({ error: "Picklist not found" });
  const { label, color } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: "Label is required" });
  const max = db.prepare("SELECT MAX(sort_order) AS m FROM picklist_values WHERE picklist_id = ?").get(list.id) as any;
  const id = db
    .prepare("INSERT INTO picklist_values (picklist_id, label, sort_order, color) VALUES (?, ?, ?, ?)")
    .run(list.id, label.trim(), (max.m ?? 0) + 1, color || "#64748B").lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(id));
});

config.patch("/picklist-values/:id", (req, res) => {
  const v = db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(req.params.id) as any;
  if (!v) return res.status(404).json({ error: "Value not found" });
  const { label, color, is_active, is_default, sort_order } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  if (label !== undefined) { sets.push("label = ?"); vals.push(label); }
  if (color !== undefined) { sets.push("color = ?"); vals.push(color); }
  if (sort_order !== undefined) { sets.push("sort_order = ?"); vals.push(sort_order); }
  if (is_active !== undefined) {
    // System values can be relabeled/reordered/recolored but not deactivated (§5.1)
    const list = db.prepare("SELECT is_system FROM picklists WHERE id = ?").get(v.picklist_id) as any;
    if (!is_active && list.is_system && v.maps_to)
      return res.status(400).json({ error: "System values can't be deactivated — board logic depends on them" });
    sets.push("is_active = ?"); vals.push(is_active ? 1 : 0);
  }
  if (is_default !== undefined && is_default) {
    db.prepare("UPDATE picklist_values SET is_default = 0 WHERE picklist_id = ?").run(v.picklist_id);
    sets.push("is_default = 1");
  }
  if (sets.length) db.prepare(`UPDATE picklist_values SET ${sets.join(", ")} WHERE id = ?`).run(...vals, v.id);
  res.json(db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(v.id));
});

function referenceCount(valueId: number): number {
  const queries = [
    "SELECT COUNT(*) AS n FROM projects WHERE status_id = ? OR risk_level_id = ? OR close_reason_id = ?",
    "SELECT COUNT(*) AS n FROM project_tasks WHERE status_id = ? OR priority_id = ? OR priority_id = ?",
    "SELECT COUNT(*) AS n FROM time_logs WHERE activity_type_id = ? OR activity_type_id = ? OR activity_type_id = ?",
    "SELECT COUNT(*) AS n FROM activities WHERE category_id = ? OR activity_type_id = ? OR category_id = ?",
    "SELECT COUNT(*) AS n FROM wins WHERE category_id = ? OR category_id = ? OR category_id = ?",
    "SELECT COUNT(*) AS n FROM template_tasks WHERE default_priority_id = ? OR default_priority_id = ? OR default_priority_id = ?",
  ];
  return queries.reduce((sum, q) => sum + (db.prepare(q).get(valueId, valueId, valueId) as any).n, 0);
}

/** Hard delete only when zero records reference it — otherwise deactivate (§5 guardrail). */
config.delete("/picklist-values/:id", (req, res) => {
  const v = db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(req.params.id) as any;
  if (!v) return res.status(404).json({ error: "Value not found" });
  const list = db.prepare("SELECT is_system FROM picklists WHERE id = ?").get(v.picklist_id) as any;
  if (list.is_system && v.maps_to)
    return res.status(400).json({ error: "System values can't be deleted — deactivation isn't allowed either since board logic depends on them" });
  const refs = referenceCount(v.id);
  if (refs > 0) {
    db.prepare("UPDATE picklist_values SET is_active = 0 WHERE id = ?").run(v.id);
    return res.json({ deactivated: true, message: `"${v.label}" is referenced by ${refs} record(s) — deactivated instead of deleted. Existing records keep it; it disappears from new dropdowns.` });
  }
  db.prepare("DELETE FROM picklist_values WHERE id = ?").run(v.id);
  res.json({ deleted: true });
});

// ---------- Workflow templates (§5.2) ----------
config.get("/templates", (_req, res) => {
  const tpls = db.prepare("SELECT * FROM workflow_templates ORDER BY is_default DESC, name").all() as any[];
  const tasks = db.prepare("SELECT * FROM template_tasks ORDER BY step_order").all() as any[];
  res.json(tpls.map((t) => ({ ...t, tasks: tasks.filter((x) => x.template_id === t.id) })));
});

config.post("/templates", (req, res) => {
  const { name, description, clone_from, user_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Template name is required" });
  const id = db
    .prepare("INSERT INTO workflow_templates (name, description, created_by) VALUES (?, ?, ?)")
    .run(name.trim(), description ?? "", user_id ?? null).lastInsertRowid as number;
  if (clone_from) {
    const src = db.prepare("SELECT * FROM template_tasks WHERE template_id = ? ORDER BY step_order").all(clone_from) as any[];
    const ins = db.prepare(
      `INSERT INTO template_tasks (template_id, step_order, name, description, required, due_offset, default_priority_id, can_edit, can_skip, is_decision, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of src)
      ins.run(id, t.step_order, t.name, t.description, t.required, t.due_offset, t.default_priority_id, t.can_edit, t.can_skip, t.is_decision, t.generation);
  }
  res.status(201).json(db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(id));
});

config.patch("/templates/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Template not found" });
  const { name, description, is_active, is_default } = req.body;
  if (is_default) db.prepare("UPDATE workflow_templates SET is_default = 0").run();
  const sets: string[] = []; const vals: any[] = [];
  if (name !== undefined) { sets.push("name = ?"); vals.push(name); }
  if (description !== undefined) { sets.push("description = ?"); vals.push(description); }
  if (is_active !== undefined) { sets.push("is_active = ?"); vals.push(is_active ? 1 : 0); }
  if (is_default !== undefined) { sets.push("is_default = ?"); vals.push(is_default ? 1 : 0); }
  if (sets.length) db.prepare(`UPDATE workflow_templates SET ${sets.join(", ")} WHERE id = ?`).run(...vals, t.id);
  res.json(db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(t.id));
});

config.post("/templates/:id/tasks", (req, res) => {
  const tpl = db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(req.params.id) as any;
  if (!tpl) return res.status(404).json({ error: "Template not found" });
  const { name, description, required, due_offset, default_priority_id, can_edit, can_skip, generation } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Task name is required" });
  const max = db.prepare("SELECT MAX(step_order) AS m FROM template_tasks WHERE template_id = ?").get(tpl.id) as any;
  const id = db.prepare(
    `INSERT INTO template_tasks (template_id, step_order, name, description, required, due_offset, default_priority_id, can_edit, can_skip, is_decision, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(tpl.id, (max.m ?? 0) + 1, name.trim(), description ?? "", required ? 1 : 0, due_offset ?? 7,
    default_priority_id ?? null, can_edit === false ? 0 : 1, can_skip ? 1 : 0, generation === "action_plan" ? "action_plan" : "standard"
  ).lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(id));
});

config.patch("/template-tasks/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Template task not found" });
  const fields = ["name", "description", "required", "due_offset", "default_priority_id", "can_edit", "can_skip", "step_order", "generation"];
  const sets: string[] = []; const vals: any[] = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) db.prepare(`UPDATE template_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, t.id);
  res.json(db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(t.id));
});

config.delete("/template-tasks/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Template task not found" });
  if (t.is_decision) return res.status(400).json({ error: "The decision-point task can't be removed while action-plan tasks depend on it" });
  db.prepare("DELETE FROM template_tasks WHERE id = ?").run(t.id);
  res.json({ ok: true });
});

config.post("/templates/:id/reorder", (req, res) => {
  const order = req.body.task_ids as number[];
  const upd = db.prepare("UPDATE template_tasks SET step_order = ? WHERE id = ? AND template_id = ?");
  order.forEach((id, i) => upd.run(i + 1, id, req.params.id));
  res.json({ ok: true });
});

// ---------- Field requirements + RAG thresholds (§5.3) ----------
config.get("/field-requirements", (_req, res) => {
  res.json(db.prepare("SELECT * FROM field_requirements ORDER BY object_type, is_system DESC, id").all());
});
config.patch("/field-requirements/:id", (req, res) => {
  const r = db.prepare("SELECT * FROM field_requirements WHERE id = ?").get(req.params.id) as any;
  if (!r) return res.status(404).json({ error: "Rule not found" });
  if (r.is_system) return res.status(400).json({ error: "System fields are locked — always required (§5.3)" });
  const { required, required_at } = req.body;
  db.prepare("UPDATE field_requirements SET required = ?, required_at = ? WHERE id = ?").run(
    required ? 1 : 0, required_at ?? r.required_at, r.id
  );
  res.json(db.prepare("SELECT * FROM field_requirements WHERE id = ?").get(r.id));
});

config.get("/settings", (_req, res) => {
  res.json({
    rag_red_overdue_days: getSettingNum("rag_red_overdue_days", 3),
    rag_amber_due_days: getSettingNum("rag_amber_due_days", 3),
    rag_stall_days: getSettingNum("rag_stall_days", 7),
  });
});
config.patch("/settings", (req, res) => {
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const key of ["rag_red_overdue_days", "rag_amber_due_days", "rag_stall_days"]) {
    if (key in req.body) {
      const n = Number(req.body[key]);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${key} must be a non-negative number` });
      upsert.run(key, String(n));
    }
  }
  res.json({ ok: true });
});

// ---------- View layouts (§5.4) ----------
config.get("/layouts", (_req, res) => {
  res.json(db.prepare("SELECT * FROM view_layout_fields ORDER BY view_name, display_order").all());
});
config.get("/layouts/:view", (req, res) => {
  res.json(
    db.prepare("SELECT * FROM view_layout_fields WHERE view_name = ? ORDER BY display_order").all(req.params.view)
  );
});
config.patch("/layout-fields/:id", (req, res) => {
  const f = db.prepare("SELECT * FROM view_layout_fields WHERE id = ?").get(req.params.id) as any;
  if (!f) return res.status(404).json({ error: "Layout field not found" });
  const { is_visible, display_order } = req.body;
  if (is_visible !== undefined && !is_visible && f.is_locked)
    return res.status(400).json({ error: `"${f.label}" is locked on this view and can't be hidden (§5.4)` });
  const sets: string[] = []; const vals: any[] = [];
  if (is_visible !== undefined) { sets.push("is_visible = ?"); vals.push(is_visible ? 1 : 0); }
  if (display_order !== undefined) { sets.push("display_order = ?"); vals.push(display_order); }
  if (sets.length) db.prepare(`UPDATE view_layout_fields SET ${sets.join(", ")} WHERE id = ?`).run(...vals, f.id);
  res.json(db.prepare("SELECT * FROM view_layout_fields WHERE id = ?").get(f.id));
});
config.post("/layouts/:view/reorder", (req, res) => {
  const order = req.body.field_ids as number[];
  const upd = db.prepare("UPDATE view_layout_fields SET display_order = ? WHERE id = ? AND view_name = ?");
  order.forEach((id, i) => upd.run(i + 1, id, req.params.view));
  res.json({ ok: true });
});
