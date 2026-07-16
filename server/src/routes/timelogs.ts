import { Router } from "express";
import { db } from "../db.js";
import { durationMinutes, isClosedStatus, logActivity, serializeActivity, valueById } from "../core.js";

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

/** Query: user_id, project_id, task_id, start, end (ISO dates, inclusive). */
timelogs.get("/", (req, res) => {
  const { user_id, project_id, task_id, start, end } = req.query as Record<string, string>;
  let sql = "SELECT * FROM time_logs WHERE 1=1";
  const params: any[] = [];
  if (user_id) { sql += " AND user_id = ?"; params.push(Number(user_id)); }
  if (project_id) { sql += " AND project_id = ?"; params.push(Number(project_id)); }
  // E1: the task modal lists the same records the Time Log area shows — one store, two surfaces
  if (task_id) { sql += " AND project_task_id = ?"; params.push(Number(task_id)); }
  if (start) { sql += " AND date >= ?"; params.push(start); }
  if (end) { sql += " AND date <= ?"; params.push(end); }
  sql += " ORDER BY date DESC, id DESC";
  res.json((db.prepare(sql).all(...params) as any[]).map(serializeLog));
});

/** Shared POST/PATCH validation: whole non-negative duration, ISO date, task in the same project. */
function timeLogProblem(l: { date: unknown; hours: number; minutes: number; project_id: number; project_task_id: unknown }): string | null {
  if (!Number.isInteger(l.hours) || !Number.isInteger(l.minutes) || l.hours < 0 || l.minutes < 0 || l.minutes > 59 || l.hours + l.minutes === 0)
    return "Enter a positive duration (minutes 0–59)";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.date))) return "Date must be YYYY-MM-DD";
  if (l.project_task_id != null) {
    const t = db.prepare("SELECT project_id FROM project_tasks WHERE id = ?").get(l.project_task_id) as any;
    if (!t) return "Task not found";
    if (t.project_id !== l.project_id) return "Task must belong to the same project as the time entry";
  }
  return null;
}

timelogs.post("/", (req, res) => {
  const { project_id, project_task_id, user_id, date, hours, minutes, activity_type_id, notes } = req.body;
  if (!project_id || !user_id || !date) return res.status(400).json({ error: "Project, user and date are required" });
  const h = Number(hours ?? 0), m = Number(minutes ?? 0);
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(project_id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  const problem = timeLogProblem({ date, hours: h, minutes: m, project_id: p.id, project_task_id: project_task_id ?? null });
  if (problem) return res.status(400).json({ error: problem });
  // Closed projects are permanent historical records — their timecards included
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "This project is closed — its time log is read-only" });
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
  // Author-only, like notes and wins — a time entry is the author's record
  const editorId = Number(req.body.user_id);
  if (!editorId || editorId !== l.user_id)
    return res.status(403).json({ error: "Only the author can edit this time entry" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(l.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "This project is closed — its time log is read-only" });
  const fields = ["date", "hours", "minutes", "activity_type_id", "notes", "project_task_id"];
  // Validate the merged record with the same rules as POST — an edit can't
  // produce an entry that creation would have rejected.
  const next = { ...l, ...Object.fromEntries(fields.filter((f) => f in req.body).map((f) => [f, req.body[f]])) };
  const problem = timeLogProblem({
    date: next.date, hours: Number(next.hours), minutes: Number(next.minutes),
    project_id: l.project_id, project_task_id: next.project_task_id ?? null,
  });
  if (problem) return res.status(400).json({ error: problem });
  const sets: string[] = []; const vals: any[] = [];
  for (const f of fields) if (f in req.body) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  if (sets.length) db.prepare(`UPDATE time_logs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, l.id);
  res.json(serializeLog(db.prepare("SELECT * FROM time_logs WHERE id = ?").get(l.id)));
});

timelogs.delete("/:id", (req, res) => {
  const l = db.prepare("SELECT * FROM time_logs WHERE id = ?").get(req.params.id) as any;
  if (!l) return res.status(404).json({ error: "Time entry not found" });
  const userId = Number(req.query.user_id ?? req.body?.user_id);
  if (!userId || userId !== l.user_id)
    return res.status(403).json({ error: "Only the author can delete this time entry" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(l.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "This project is closed — its time log is read-only" });
  db.prepare("DELETE FROM time_logs WHERE id = ?").run(l.id);
  res.json({ ok: true });
});

// ---------- Notes & Activity (§4.6, expanded per v2 §5) ----------

/**
 * Query params: project_id; kind (comma-separated, e.g. 'note' or 'note,activity');
 * task_id (notes/records attached directly to that task); limit.
 */
activities.get("/", (req, res) => {
  const { project_id, kind, task_id, limit } = req.query as Record<string, string>;
  let sql = "SELECT * FROM activities WHERE 1=1";
  const params: any[] = [];
  if (project_id) { sql += " AND project_id = ?"; params.push(Number(project_id)); }
  if (task_id) { sql += " AND project_task_id = ?"; params.push(Number(task_id)); }
  if (kind) {
    const kinds = kind.split(",").map((k) => k.trim()).filter(Boolean);
    sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds);
  }
  sql += " ORDER BY activity_date DESC, id DESC";
  if (limit && Number(limit) > 0) { sql += " LIMIT ?"; params.push(Number(limit)); }
  res.json((db.prepare(sql).all(...params) as any[]).map(serializeActivity));
});

activities.get("/:id", (req, res) => {
  const a = db.prepare("SELECT * FROM activities WHERE id = ?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Activity not found" });
  res.json(serializeActivity(a));
});

/**
 * Create a note (kind='note', default) or a logged activity (kind='activity':
 * phone call / site visit / meeting with date + start/end times). `task_ids`
 * links an activity to any number of tasks in one action (many-to-many);
 * `project_task_id` keeps the v1 behavior of attaching a note to one task.
 */
activities.post("/", (req, res) => {
  const { project_id, project_task_id, user_id, category_id, note, kind,
    activity_type_id, activity_date, start_time, end_time, task_ids } = req.body;
  const isActivity = kind === "activity";
  if (!project_id || !note?.trim()) return res.status(400).json({ error: "Project and note text are required" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(project_id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  // Historical notes are read-only once closed (§4.6) — and no new ones can be added
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "This project is closed — its history is read-only" });

  if (isActivity) {
    if (!activity_type_id) return res.status(400).json({ error: "Pick an activity type (call, visit, meeting…)" });
    if (!activity_date) return res.status(400).json({ error: "Activity date is required" });
    const timeRe = /^\d{2}:\d{2}$/;
    for (const [label, v] of [["Start time", start_time], ["End time", end_time]] as const)
      if (v && !timeRe.test(v)) return res.status(400).json({ error: `${label} must be HH:MM` });
    const dur = durationMinutes(start_time ?? null, end_time ?? null);
    if (start_time && end_time && dur === 0 && start_time >= end_time)
      return res.status(400).json({ error: "End time must be after start time" });
  }

  const linkIds: number[] = Array.isArray(task_ids) ? task_ids.map(Number).filter(Boolean) : [];
  for (const tid of linkIds) {
    const t = db.prepare("SELECT project_id FROM project_tasks WHERE id = ?").get(tid) as any;
    if (!t) return res.status(400).json({ error: `Linked task ${tid} not found` });
    if (t.project_id !== Number(project_id)) return res.status(400).json({ error: "Linked tasks must belong to the same project" });
  }

  const create = db.transaction(() => {
    const id = db.prepare(
      `INSERT INTO activities (project_id, project_task_id, user_id, activity_date, kind, category_id, activity_type_id, start_time, end_time, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project_id,
      project_task_id ?? null,
      user_id ?? null,
      isActivity ? `${activity_date} ${start_time ?? "00:00"}:00` : new Date().toISOString().slice(0, 19).replace("T", " "),
      isActivity ? "activity" : "note",
      category_id ?? null,
      isActivity ? activity_type_id : null,
      isActivity ? start_time ?? null : null,
      isActivity ? end_time ?? null : null,
      note.trim()
    ).lastInsertRowid as number;
    const link = db.prepare("INSERT OR IGNORE INTO task_activity_links (project_task_id, activity_id) VALUES (?, ?)");
    for (const tid of linkIds) link.run(tid, id);
    return id;
  });
  const id = create();
  res.status(201).json(serializeActivity(db.prepare("SELECT * FROM activities WHERE id = ?").get(id)));
});

/**
 * Edit a note or logged activity in place (same ID — a correction, not a new
 * entry). Author-only: `user_id` in the body must match the record's author.
 * Status-change/system entries are audit history and stay immutable.
 */
activities.patch("/:id", (req, res) => {
  const a = db.prepare("SELECT * FROM activities WHERE id = ?").get(req.params.id) as any;
  if (!a) return res.status(404).json({ error: "Activity not found" });
  if (a.kind !== "note" && a.kind !== "activity")
    return res.status(400).json({ error: "Status changes and system entries can't be edited" });
  const editorId = Number(req.body.user_id);
  if (!a.user_id || !editorId || a.user_id !== editorId)
    return res.status(403).json({ error: "Only the author can edit this record" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(a.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "This project is closed — its history is read-only" });
  if ("note" in req.body && !req.body.note?.trim())
    return res.status(400).json({ error: "Note text is required" });

  if (a.kind === "note") {
    db.prepare("UPDATE activities SET note = ?, category_id = ? WHERE id = ?").run(
      "note" in req.body ? req.body.note.trim() : a.note,
      "category_id" in req.body ? req.body.category_id ?? null : a.category_id,
      a.id
    );
    return res.json(serializeActivity(db.prepare("SELECT * FROM activities WHERE id = ?").get(a.id)));
  }

  // kind === 'activity' — merge submitted fields over current values, then re-validate like POST
  const next = {
    note: "note" in req.body ? req.body.note.trim() : a.note,
    activity_type_id: "activity_type_id" in req.body ? req.body.activity_type_id : a.activity_type_id,
    activity_date: "activity_date" in req.body ? req.body.activity_date : (a.activity_date ?? "").slice(0, 10),
    start_time: "start_time" in req.body ? req.body.start_time || null : a.start_time,
    end_time: "end_time" in req.body ? req.body.end_time || null : a.end_time,
  };
  if (!next.activity_type_id) return res.status(400).json({ error: "Pick an activity type (call, visit, meeting…)" });
  if (!next.activity_date || !/^\d{4}-\d{2}-\d{2}$/.test(next.activity_date))
    return res.status(400).json({ error: "Activity date is required" });
  const timeRe = /^\d{2}:\d{2}$/;
  for (const [label, v] of [["Start time", next.start_time], ["End time", next.end_time]] as const)
    if (v && !timeRe.test(v)) return res.status(400).json({ error: `${label} must be HH:MM` });
  if (next.start_time && next.end_time && next.start_time >= next.end_time)
    return res.status(400).json({ error: "End time must be after start time" });

  const newLinks: number[] | null = "task_ids" in req.body
    ? (Array.isArray(req.body.task_ids) ? req.body.task_ids.map(Number).filter(Boolean) : [])
    : null;
  for (const tid of newLinks ?? []) {
    const t = db.prepare("SELECT project_id FROM project_tasks WHERE id = ?").get(tid) as any;
    if (!t) return res.status(400).json({ error: `Linked task ${tid} not found` });
    if (t.project_id !== a.project_id) return res.status(400).json({ error: "Linked tasks must belong to the same project" });
  }

  const update = db.transaction(() => {
    db.prepare(
      "UPDATE activities SET note = ?, activity_type_id = ?, activity_date = ?, start_time = ?, end_time = ? WHERE id = ?"
    ).run(next.note, next.activity_type_id, `${next.activity_date} ${next.start_time ?? "00:00"}:00`, next.start_time, next.end_time, a.id);
    if (newLinks) {
      db.prepare("DELETE FROM task_activity_links WHERE activity_id = ?").run(a.id);
      const link = db.prepare("INSERT OR IGNORE INTO task_activity_links (project_task_id, activity_id) VALUES (?, ?)");
      for (const tid of newLinks) link.run(tid, a.id);
    }
  });
  update();
  res.json(serializeActivity(db.prepare("SELECT * FROM activities WHERE id = ?").get(a.id)));
});
