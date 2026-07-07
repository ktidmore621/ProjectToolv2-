import { Router } from "express";
import { db } from "../db.js";
import { CLOSED_KEYS, DONE_TASK_KEYS, serializeProject, valuesFor } from "../core.js";

export const dashboard = Router();

dashboard.get("/", (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const all = (db.prepare("SELECT * FROM projects").all() as any[]).map((p) => serializeProject(p));
  const active = all.filter((p) => !p.is_closed);

  const ragBreakdown = { red: 0, amber: 0, green: 0 } as Record<string, number>;
  for (const p of active) ragBreakdown[p.rag] = (ragBreakdown[p.rag] ?? 0) + 1;

  const doneIds = valuesFor("Task Status").filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const blockedId = valuesFor("Task Status").find((v) => v.maps_to === "blocked")?.id;
  const closedStatusIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const today = new Date().toISOString().slice(0, 10);

  const openTasks = db
    .prepare(
      `SELECT t.*, p.project_code, p.mcp_name FROM project_tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.conditional_pending = 0
         AND t.status_id NOT IN (${doneIds.map(() => "?").join(",")})
         AND p.status_id NOT IN (${closedStatusIds.map(() => "?").join(",")})`
    )
    .all(...doneIds, ...closedStatusIds) as any[];

  const overdue = openTasks
    .filter((t) => t.due_date && t.due_date < today)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
    .slice(0, 10);
  const blocked = openTasks.filter((t) => t.status_id === blockedId);
  const myOpen = userId
    ? openTasks
        .filter((t) => {
          if (t.assigned_to) return t.assigned_to === userId;
          const p = all.find((x) => x.id === t.project_id);
          return p?.assignee_id === userId;
        })
        .sort((a, b) => ((a.due_date ?? "9999") < (b.due_date ?? "9999") ? -1 : 1))
        .slice(0, 10)
    : [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const recentWins = all
    .filter((p) => p.is_closed && p.status_key === "closed" && p.closed_date && p.closed_date >= cutoff.toISOString())
    .sort((a, b) => (a.closed_date! > b.closed_date! ? -1 : 1))
    .slice(0, 6);

  res.json({
    active_count: active.length,
    closed_count: all.length - active.length,
    rag_breakdown: ragBreakdown,
    overdue_tasks: overdue.map((t) => ({ id: t.id, project_id: t.project_id, name: t.name, due_date: t.due_date, project_code: t.project_code, mcp_name: t.mcp_name })),
    blocked_tasks: blocked.map((t) => ({ id: t.id, project_id: t.project_id, name: t.name, project_code: t.project_code, mcp_name: t.mcp_name })),
    my_open_tasks: myOpen.map((t) => ({ id: t.id, project_id: t.project_id, name: t.name, due_date: t.due_date, project_code: t.project_code, mcp_name: t.mcp_name })),
    recent_wins: recentWins,
    attention: active.filter((p) => p.rag === "red").slice(0, 8),
  });
});
