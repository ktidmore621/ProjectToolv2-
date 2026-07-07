import { Router } from "express";
import { db } from "../db.js";
import { isClosedStatus, logActivity, valueById } from "../core.js";

export const timelogs = Router();
export const activities = Router();

function serializeLog(l: any) {
  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(l.user_id) as any;
  const project = db.prepare("SELECT project_code, mcp_name FROM projects WHERE id = ?").get(l.project_id) as any;
  const task = l.project_task_id
    ? (db.prepare("SELECT name FROM project_tasks WHERE id = ?").get(l.project_task_id) as any)
    : null;
  const act = valueById(l.activity_type_id);
  return {
    ...l,
    user_name: user?.name ?? "—",
    project_code: project?.project_code,
    mcp_name: project?.mcp_name,
    task_name: task?.name ?? null,
    activity_type_label: act?.label ?? null,
    activity_type_color: act?.color ?? null,
    total_minutes: l.hours * 60 + l.minutes,
  };
}

/** Query: user_id, project_id, start, end (ISO dates, inclusive). */
timelogs.get("/", (req, res) => {
  const { user_id, project_id, start, end } = req.query as Record<string, string>;
  let sql = "SELECT * FROM time_logs WHERE 1=1";
  const params: any[] = [];
  if (user_id) { sql += " AND user_id = ?"; params.push(Number(user_id)); }
  if (project_id) { sql += " AND project_id = ?"; params.push(Number(project_id)); }
  if (start) { sql += " AND date >= ?"; params.push(start); }
  if (end) { sql += " AND date <= ?"; params.push(end); }
  sql += " ORDER BY date DESC, id DESC";
  res.json((db.prepare(sql).all(...params) as any[]).map(serializeLog));
});

timelogs.post("/", (req, res) => {
  const { project_id, project_task_id, user_id, date, hours, minutes, activity_type_id, notes } = req.body;
  if (!project_id || !user_id || !date) return res.status(400).json({ error: "Project, user and date are required" });
  const h = Number(hours ?? 0), m = Number(minutes ?? 0);
  if (h < 0 || m < 0 || m > 59 || h + m === 0) return res.status(400).json({ error: "Enter a positive duration (minutes 0–59)" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(project_id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  const id = db
    .prepare(
      `INSERT INTO time_logs (project_id, project_task_id, user_id, date, hours, minutes, activity_type_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(project_id, project_task_id ?? null, user_id, date, h, m, activity_type_id ?? null, notes ?? "")
    .lastInsertRowid;
  res.status(201).json(serializeLog(db.prepare("SELECT * FROM time_logs WHERE id = ?").get(id)));
});

timelogs.patch("/:id", (req, res) => {
  const l = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(req.params.id) as any;
  if (!l) return res.status(404).json({ error: "Time entry not found" });
  const fields = ["date", "hours", "minutes", "activity_type_id", "notes", "project_task_id"];
  const sets: string[] = []; const vals: any[] = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) db.prepare(`UPDATE time_logs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, l.id);
  res.json(serializeLog(db.prepare("SELECT * FROM time_logs WHERE id = ?").get(l.id)));
});

timelogs.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM time_logs WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Notes / Activity (§4.6) ----------

activities.get("/", (req, res) => {
  const { project_id, kind } = req.query as Record<string, string>;
  let sql = "SELECT * FROM activities WHERE 1=1";
  const params: any[] = [];
  if (project_id) { sql += " AND project_id = ?"; params.push(Number(project_id)); }
  if (kind) { sql += " AND kind = ?"; params.push(kind); }
  sql += " ORDER BY activity_date DESC, id DESC";
  const rows = db.prepare(sql).all(...params) as any[];
  res.json(
    rows.map((a) => {
      const user = a.user_id ? (db.prepare("SELECT name FROM users WHERE id = ?").get(a.user_id) as any) : null;
      const cat = valueById(a.category_id);
      const task = a.project_task_id
        ? (db.prepare("SELECT name FROM project_tasks WHERE id = ?").get(a.project_task_id) as any)
        : null;
      return {
        ...a,
        user_name: user?.name ?? "System",
        category_label: cat?.label ?? null,
        category_color: cat?.color ?? null,
        task_name: task?.name ?? null,
      };
    })
  );
});

activities.post("/", (req, res) => {
  const { project_id, project_task_id, user_id, category_id, note } = req.body;
  if (!project_id || !note?.trim()) return res.status(400).json({ error: "Project and note text are required" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(project_id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  // Historical notes are read-only once closed (§4.6) — and no new ones can be added
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "This project is closed — its history is read-only" });
  logActivity({ project_id, project_task_id, user_id, kind: "note", category_id, note: note.trim() });
  res.status(201).json({ ok: true });
});
