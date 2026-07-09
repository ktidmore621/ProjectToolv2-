import { Router } from "express";
import { db } from "../db.js";
import { isClosedStatus, logActivity, serializeWin } from "../core.js";

export const wins = Router();

/**
 * Portfolio-wide wins (v2 §3). Filters: project_id, category_id,
 * start / end (inclusive, against occurred_date).
 */
wins.get("/", (req, res) => {
  const { project_id, category_id, start, end } = req.query as Record<string, string>;
  let sql = "SELECT * FROM wins WHERE 1=1";
  const params: any[] = [];
  if (project_id) { sql += " AND project_id = ?"; params.push(Number(project_id)); }
  if (category_id) { sql += " AND category_id = ?"; params.push(Number(category_id)); }
  if (start) { sql += " AND occurred_date >= ?"; params.push(start); }
  if (end) { sql += " AND occurred_date <= ?"; params.push(end); }
  sql += " ORDER BY occurred_date DESC, id DESC";
  res.json((db.prepare(sql).all(...params) as any[]).map(serializeWin));
});

/** Wins can be logged at any point in a project's lifecycle — not just at closure. */
wins.post("/", (req, res) => {
  const { project_id, description, category_id, occurred_date, user_id } = req.body;
  if (!project_id || !description?.trim()) return res.status(400).json({ error: "Project and description are required" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(project_id) as any;
  if (!p) return res.status(404).json({ error: "Project not found" });
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only — wins are logged while the project is open" });
  const occurred = occurred_date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred)) return res.status(400).json({ error: "Occurred date must be YYYY-MM-DD" });
  const id = db.prepare(
    "INSERT INTO wins (project_id, description, category_id, occurred_date, logged_by) VALUES (?, ?, ?, ?, ?)"
  ).run(project_id, description.trim(), category_id ?? null, occurred, user_id ?? null).lastInsertRowid;
  logActivity({ project_id, user_id, kind: "system", note: `logged a win: "${description.trim()}"` });
  res.status(201).json(serializeWin(db.prepare("SELECT * FROM wins WHERE id = ?").get(id)));
});

wins.delete("/:id", (req, res) => {
  const w = db.prepare("SELECT * FROM wins WHERE id = ?").get(req.params.id) as any;
  if (!w) return res.status(404).json({ error: "Win not found" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(w.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });
  db.prepare("DELETE FROM wins WHERE id = ?").run(w.id);
  res.json({ ok: true });
});
