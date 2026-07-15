import { Router } from "express";
import { db, getSettingNum } from "../db.js";

/**
 * Configuration API.
 *
 * B6 — SECURITY NOTE: there is no authorization on these routes. The per-user
 * `show_configuration` flag only hides the Configuration UI; it does not stop
 * anyone from calling these endpoints directly. Do not mistake it for access
 * control — see the "Security model" section of the README.
 */
export const config = Router();

// ---------- Dynamic (custom) project fields ----------

const CUSTOM_FIELD_TYPES = ["text", "number", "currency", "date", "dropdown", "checkbox"];
const CUSTOM_FIELD_VIEWS = ["project_list", "project_header", "portfolio_card"];
const OPTION_COLORS = ["#2E4E8F", "#12808A", "#8A6FB8", "#C99239", "#4E9468", "#B0632F", "#5C6B84", "#C2554E"];

function customFieldOut(f: any) {
  const values = f.picklist_id
    ? db.prepare("SELECT * FROM picklist_values WHERE picklist_id = ? ORDER BY sort_order, id").all(f.picklist_id)
    : [];
  return { ...f, options: values };
}

config.get("/custom-fields", (_req, res) => {
  const rows = db.prepare("SELECT * FROM custom_fields ORDER BY sort_order, id").all() as any[];
  res.json(rows.map(customFieldOut));
});

config.post("/custom-fields", (req, res) => {
  const { label, field_type, options } = req.body as { label?: string; field_type?: string; options?: string[] };
  if (!label?.trim()) return res.status(400).json({ error: "Field label is required" });
  if (!field_type || !CUSTOM_FIELD_TYPES.includes(field_type))
    return res.status(400).json({ error: `Field type must be one of: ${CUSTOM_FIELD_TYPES.join(", ")}` });
  const opts = (options ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (field_type === "dropdown" && !opts.length)
    return res.status(400).json({ error: "A dropdown field needs at least one option" });

  // Stable key survives later renames; disambiguate collisions with a suffix
  const base = "cf_" + (label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field");
  let key = base;
  for (let n = 2; db.prepare("SELECT id FROM custom_fields WHERE field_key = ?").get(key); n++) key = `${base}_${n}`;

  const create = db.transaction(() => {
    let picklistId: number | null = null;
    if (field_type === "dropdown") {
      // Options live in the standard picklist system → managed from Picklists & Values
      let plName = label.trim();
      if (db.prepare("SELECT id FROM picklists WHERE name = ?").get(plName)) plName = `${plName} (Custom Field)`;
      picklistId = db
        .prepare("INSERT INTO picklists (name, object_type, is_system) VALUES (?, 'project', 0)")
        .run(plName).lastInsertRowid as number;
      opts.forEach((o, i) =>
        db.prepare(
          "INSERT INTO picklist_values (picklist_id, label, sort_order, color, is_active, is_default) VALUES (?, ?, ?, ?, 1, ?)"
        ).run(picklistId, o, i + 1, OPTION_COLORS[i % OPTION_COLORS.length], i === 0 ? 1 : 0)
      );
    }
    const maxSort = db.prepare("SELECT MAX(sort_order) AS m FROM custom_fields").get() as { m: number | null };
    const id = db
      .prepare("INSERT INTO custom_fields (object_type, label, field_key, field_type, picklist_id, sort_order) VALUES ('project', ?, ?, ?, ?, ?)")
      .run(label.trim(), key, field_type, picklistId, (maxSort.m ?? 0) + 1).lastInsertRowid as number;

    // Requiredness is managed alongside built-in fields in Field Requirements
    db.prepare(
      "INSERT INTO field_requirements (object_type, field_name, label, is_system, required, required_at) VALUES ('project', ?, ?, 0, 0, 'creation')"
    ).run(key, label.trim());
    // …and visibility/order alongside built-in fields in Card & View Layouts
    for (const view of CUSTOM_FIELD_VIEWS) {
      const max = db.prepare("SELECT MAX(display_order) AS m FROM view_layout_fields WHERE view_name = ?").get(view) as { m: number | null };
      db.prepare(
        "INSERT INTO view_layout_fields (view_name, field_key, label, display_order, is_visible, is_locked) VALUES (?, ?, ?, ?, 1, 0)"
      ).run(view, key, label.trim(), (max.m ?? 0) + 1);
    }
    return id;
  });
  const id = create();
  res.status(201).json(customFieldOut(db.prepare("SELECT * FROM custom_fields WHERE id = ?").get(id)));
});

config.patch("/custom-fields/:id", (req, res) => {
  const f = db.prepare("SELECT * FROM custom_fields WHERE id = ?").get(req.params.id) as any;
  if (!f) return res.status(404).json({ error: "Custom field not found" });
  const { label, is_active, sort_order } = req.body;
  if (label !== undefined) {
    if (!String(label).trim()) return res.status(400).json({ error: "Field label is required" });
    db.prepare("UPDATE custom_fields SET label = ? WHERE id = ?").run(String(label).trim(), f.id);
    db.prepare("UPDATE field_requirements SET label = ? WHERE object_type = 'project' AND field_name = ?").run(String(label).trim(), f.field_key);
    db.prepare("UPDATE view_layout_fields SET label = ? WHERE field_key = ?").run(String(label).trim(), f.field_key);
  }
  if (sort_order !== undefined) db.prepare("UPDATE custom_fields SET sort_order = ? WHERE id = ?").run(sort_order, f.id);
  if (is_active !== undefined) {
    db.prepare("UPDATE custom_fields SET is_active = ? WHERE id = ?").run(is_active ? 1 : 0, f.id);
    // Mirror to the layout slots so cards/tables drop the field immediately
    db.prepare("UPDATE view_layout_fields SET is_visible = ? WHERE field_key = ?").run(is_active ? 1 : 0, f.field_key);
  }
  res.json(customFieldOut(db.prepare("SELECT * FROM custom_fields WHERE id = ?").get(f.id)));
});

/** Same guardrail as picklist values: fields holding data are deactivated, never hard-deleted. */
config.delete("/custom-fields/:id", (req, res) => {
  const f = db.prepare("SELECT * FROM custom_fields WHERE id = ?").get(req.params.id) as any;
  if (!f) return res.status(404).json({ error: "Custom field not found" });
  const refs = (db.prepare("SELECT COUNT(*) AS n FROM project_custom_values WHERE field_id = ? AND value IS NOT NULL").get(f.id) as any).n;
  if (refs > 0) {
    db.prepare("UPDATE custom_fields SET is_active = 0 WHERE id = ?").run(f.id);
    db.prepare("UPDATE view_layout_fields SET is_visible = 0 WHERE field_key = ?").run(f.field_key);
    return res.json({ deactivated: true, message: `"${f.label}" holds values on ${refs} project(s) — deactivated instead of deleted. Reactivate it to bring the data back.` });
  }
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM project_custom_values WHERE field_id = ?").run(f.id);
    db.prepare("DELETE FROM view_layout_fields WHERE field_key = ?").run(f.field_key);
    db.prepare("DELETE FROM field_requirements WHERE object_type = 'project' AND field_name = ?").run(f.field_key);
    db.prepare("DELETE FROM custom_fields WHERE id = ?").run(f.id);
    if (f.picklist_id) {
      db.prepare("DELETE FROM picklist_values WHERE picklist_id = ?").run(f.picklist_id);
      db.prepare("DELETE FROM picklists WHERE id = ?").run(f.picklist_id);
    }
  });
  remove();
  res.json({ deleted: true });
});

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
/** Per-user settings, edited from Configuration → Working As. */
config.patch("/users/:id", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  const { dashboard_scope, default_assignee_filter, show_configuration } = req.body;
  if (dashboard_scope !== undefined) {
    if (!["mine", "all"].includes(dashboard_scope))
      return res.status(400).json({ error: "dashboard_scope must be 'mine' or 'all'" });
    db.prepare("UPDATE users SET dashboard_scope = ? WHERE id = ?").run(dashboard_scope, req.params.id);
  }
  if (default_assignee_filter !== undefined) {
    // null = match dashboard default, 'all' = everyone, otherwise a user id
    let v: string | null = default_assignee_filter;
    if (v === null || v === "") v = null;
    else if (v !== "all") {
      const target = db.prepare("SELECT id FROM users WHERE id = ?").get(Number(v)) as { id: number } | undefined;
      if (!target) return res.status(400).json({ error: "default_assignee_filter must be 'all' or a valid user id" });
      v = String(target.id);
    }
    db.prepare("UPDATE users SET default_assignee_filter = ? WHERE id = ?").run(v, req.params.id);
  }
  if (show_configuration !== undefined) {
    // B6 — SECURITY NOTE: show_configuration is UI visibility only, NOT access
    // control. It hides the Configuration nav item and redirects the page, but
    // every /api/* configuration endpoint in this file remains reachable by
    // anyone who can reach the API. Real authorization would need server-side
    // permission checks on these routes (see README "Security model").
    db.prepare("UPDATE users SET show_configuration = ? WHERE id = ?").run(show_configuration ? 1 : 0, req.params.id);
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
  const { label, color, is_active, is_default, sort_order, archived } = req.body;
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
  if (archived !== undefined) {
    // B1: explicit archive/restore. Same system-value guard as deactivation —
    // board/business logic depends on maps_to values existing.
    const list = db.prepare("SELECT is_system FROM picklists WHERE id = ?").get(v.picklist_id) as any;
    if (list.is_system && v.maps_to)
      return res.status(400).json({ error: "System values can't be archived or restored — board logic depends on them" });
    sets.push("archived = ?"); vals.push(archived ? 1 : 0);
  }
  if (is_default !== undefined && is_default) {
    db.prepare("UPDATE picklist_values SET is_default = 0 WHERE picklist_id = ?").run(v.picklist_id);
    sets.push("is_default = 1");
  }
  if (sets.length) db.prepare(`UPDATE picklist_values SET ${sets.join(", ")} WHERE id = ?`).run(...vals, v.id);
  res.json(db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(v.id));
});

/**
 * B1: every column that can reference a picklist value. Direct foreign keys
 * are listed per table; custom-field values live in the generic value tables
 * below, where dropdown selections are stored as the value id in a TEXT
 * column — a table added there (e.g. task custom values in E9) is covered
 * with a one-line change.
 */
const VALUE_REF_COLUMNS: [table: string, columns: string[]][] = [
  ["projects", ["status_id", "risk_level_id", "close_reason_id"]],
  ["project_tasks", ["status_id", "priority_id"]],
  ["time_logs", ["activity_type_id"]],
  ["activities", ["category_id", "activity_type_id"]],
  ["wins", ["category_id"]],
  ["template_tasks", ["default_priority_id"]],
];
const CUSTOM_VALUE_TABLES: [table: string, fkColumn: string][] = [
  ["project_custom_values", "project_id"],
];

export function referenceCount(valueId: number): number {
  let n = 0;
  for (const [table, cols] of VALUE_REF_COLUMNS) {
    const where = cols.map((c) => `${c} = ?`).join(" OR ");
    n += (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...cols.map(() => valueId)) as any).n;
  }
  for (const [table] of CUSTOM_VALUE_TABLES) {
    // Only dropdown fields store picklist value ids; other field types could
    // coincidentally hold the same digits as text. The id is bound as a string
    // because the value column is TEXT.
    n += (db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} cv
       JOIN custom_fields f ON f.id = cv.field_id
       WHERE f.field_type = 'dropdown' AND cv.value = ?`
    ).get(String(valueId)) as any).n;
  }
  return n;
}

/**
 * B1: once a value has been used it is archived, never deleted — hidden from
 * dropdowns going forward but rendered unchanged on every legacy record.
 * Hard delete stays available only for values no record has ever referenced.
 */
config.delete("/picklist-values/:id", (req, res) => {
  const v = db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(req.params.id) as any;
  if (!v) return res.status(404).json({ error: "Value not found" });
  const list = db.prepare("SELECT is_system FROM picklists WHERE id = ?").get(v.picklist_id) as any;
  if (list.is_system && v.maps_to)
    return res.status(400).json({ error: "System values can't be deleted or archived — board logic depends on them" });
  const refs = referenceCount(v.id);
  if (refs > 0) {
    db.prepare("UPDATE picklist_values SET archived = 1 WHERE id = ?").run(v.id);
    return res.json({ archived: true, message: `"${v.label}" is referenced by ${refs} record(s), so it was archived instead of deleted. Existing records keep displaying it; it no longer appears in dropdowns for new entries.` });
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
      `INSERT INTO template_tasks (template_id, step_order, name, description, required, due_offset, default_priority_id, can_edit, can_skip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of src)
      ins.run(id, t.step_order, t.name, t.description, t.required, t.due_offset, t.default_priority_id, t.can_edit, t.can_skip);
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
  const { name, description, required, due_offset, default_priority_id, can_edit, can_skip } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Task name is required" });
  const max = db.prepare("SELECT MAX(step_order) AS m FROM template_tasks WHERE template_id = ?").get(tpl.id) as any;
  const id = db.prepare(
    `INSERT INTO template_tasks (template_id, step_order, name, description, required, due_offset, default_priority_id, can_edit, can_skip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tpl.id, (max.m ?? 0) + 1, name.trim(), description ?? "", required ? 1 : 0, due_offset ?? 7,
    default_priority_id ?? null, can_edit === false ? 0 : 1, can_skip ? 1 : 0
  ).lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(id));
});

config.patch("/template-tasks/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Template task not found" });
  const fields = ["name", "description", "required", "due_offset", "default_priority_id", "can_edit", "can_skip", "step_order"];
  const sets: string[] = []; const vals: any[] = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) db.prepare(`UPDATE template_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, t.id);
  res.json(db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(t.id));
});

config.delete("/template-tasks/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM template_tasks WHERE id = ?").get(req.params.id) as any;
  if (!t) return res.status(404).json({ error: "Template task not found" });
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
