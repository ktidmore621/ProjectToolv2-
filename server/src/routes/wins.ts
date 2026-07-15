import { Router } from "express";
import { db } from "../db.js";
import { isClosedStatus, logActivity, serializeWin, todayCentral } from "../core.js";

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
  const occurred = occurred_date || todayCentral();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred)) return res.status(400).json({ error: "Occurred date must be YYYY-MM-DD" });
  const id = db.prepare(
    "INSERT INTO wins (project_id, description, category_id, occurred_date, logged_by) VALUES (?, ?, ?, ?, ?)"
  ).run(project_id, description.trim(), category_id ?? null, occurred, user_id ?? null).lastInsertRowid;
  // Remember the system note's id so deleting the win can remove it too (B4)
  const activityId = logActivity({ project_id, user_id, kind: "system", note: `logged a win: "${description.trim()}"` });
  db.prepare("UPDATE wins SET activity_id = ? WHERE id = ?").run(activityId, id);
  res.status(201).json(serializeWin(db.prepare("SELECT * FROM wins WHERE id = ?").get(id)));
});

/**
 * B4: wins feed leadership reporting, so deletion is author-only and audited.
 * The acting user comes from ?user_id= (DELETE bodies aren't reliable).
 */
wins.delete("/:id", (req, res) => {
  const w = db.prepare("SELECT * FROM wins WHERE id = ?").get(req.params.id) as any;
  if (!w) return res.status(404).json({ error: "Win not found" });
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(w.project_id) as any;
  if (isClosedStatus(p.status_id)) return res.status(400).json({ error: "Closed projects are read-only" });
  const userId = Number(req.query.user_id ?? req.body?.user_id);
  if (!userId || !w.logged_by || userId !== w.logged_by)
    return res.status(403).json({ error: "Only the author of a win can delete it" });

  const remove = db.transaction(() => {
    // Delete the win first — its activity_id references the system note.
    db.prepare("DELETE FROM wins WHERE id = ?").run(w.id);
    // Remove the "logged a win" system note so it doesn't orphan; legacy wins
    // (created before activity_id existed) are matched by their exact note text.
    if (w.activity_id) {
      db.prepare("DELETE FROM activities WHERE id = ? AND kind = 'system'").run(w.activity_id);
    } else {
      db.prepare("DELETE FROM activities WHERE project_id = ? AND kind = 'system' AND note = ?")
        .run(w.project_id, `logged a win: "${w.description}"`);
    }
    logActivity({ project_id: w.project_id, user_id: userId, kind: "system", note: `deleted a win: "${w.description}"` });
  });
  remove();
  res.json({ ok: true });
});
