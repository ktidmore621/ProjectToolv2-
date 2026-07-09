import { Router } from "express";
import { db } from "../db.js";
import { CLOSED_KEYS, DONE_TASK_KEYS, serializeActivity, serializeProject, serializeWin, valuesFor } from "../core.js";

export const dashboard = Router();

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Monday of the week containing `d` — same convention as the timecard grid. */
function weekStartIso(d: Date): string {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return isoOf(x);
}
function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

dashboard.get("/", (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const all = (db.prepare("SELECT * FROM projects").all() as any[]).map((p) => serializeProject(p));
  const active = all.filter((p) => !p.is_closed);

  const ragBreakdown = { red: 0, amber: 0, green: 0 } as Record<string, number>;
  for (const p of active) ragBreakdown[p.rag] = (ragBreakdown[p.rag] ?? 0) + 1;

  const doneIds = valuesFor("Task Status").filter((v) => DONE_TASK_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const blockedVal = valuesFor("Task Status").find((v) => v.maps_to === "blocked");
  const blockedId = blockedVal?.id;
  const closedStatusIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const now = new Date();
  const today = isoOf(now);
  const yesterday = addDaysIso(today, -1);
  const weekAgo = addDaysIso(today, -7);

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

  // ---- Trend indicators (§2.1) ----
  const createdThisWeek = active.filter((p) => p.created_date && p.created_date.slice(0, 10) >= weekAgo).length;
  const newlyOverdue = openTasks.filter((t) => t.due_date === yesterday).length;
  const closedThisWeek = all.filter((p) => p.is_closed && p.closed_date && p.closed_date.slice(0, 10) >= weekAgo).length;
  const blockedThisWeek = blockedVal
    ? (db.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE kind = 'status_change' AND new_status = ? AND activity_date >= ?"
      ).get(blockedVal.label, weekAgo) as { n: number }).n
    : 0;
  const trends = {
    active: createdThisWeek ? `+${createdThisWeek} this week` : "No change this week",
    overdue: newlyOverdue ? `+${newlyOverdue} since yesterday` : "No change since yesterday",
    blocked: blockedThisWeek ? `+${blockedThisWeek} this week` : "No change this week",
    closed: closedThisWeek ? `+${closedThisWeek} this week` : "No change this week",
  };

  // ---- "This Week" panel (§2.2): tasks due + logged/scheduled activities, Mon–Sun ----
  const wkStart = weekStartIso(now);
  const wkEnd = addDaysIso(wkStart, 6);
  const nowStamp = now.toISOString().slice(0, 16).replace("T", " ");

  const weekTasks = db
    .prepare(
      `SELECT t.*, p.mcp_name, p.project_code FROM project_tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.conditional_pending = 0 AND t.due_date >= ? AND t.due_date <= ?
         AND p.status_id NOT IN (${closedStatusIds.map(() => "?").join(",")})`
    )
    .all(wkStart, wkEnd, ...closedStatusIds) as any[];
  const weekActivities = db
    .prepare(
      `SELECT a.*, p.mcp_name, p.project_code FROM activities a
       JOIN projects p ON p.id = a.project_id
       WHERE a.kind = 'activity' AND a.activity_date >= ? AND a.activity_date <= ?`
    )
    .all(wkStart + " 00:00:00", wkEnd + " 23:59:59") as any[];

  const thisWeek = [
    ...weekTasks.map((t) => ({
      kind: "task" as const,
      id: t.id,
      project_id: t.project_id,
      name: t.name,
      date: t.due_date,
      time: null as string | null,
      type_key: "task",
      type_label: "Task due",
      mcp_name: t.mcp_name,
      done: doneIds.includes(t.status_id),
    })),
    ...weekActivities.map((a) => {
      const type = a.activity_type_id ? valuesFor("Activity Type").find((v) => v.id === a.activity_type_id) : undefined;
      return {
        kind: "activity" as const,
        id: a.id,
        project_id: a.project_id,
        name: a.note?.length > 60 ? a.note.slice(0, 57) + "…" : a.note || type?.label || "Activity",
        date: a.activity_date.slice(0, 10),
        time: a.start_time ?? null,
        type_key: type?.maps_to ?? "other",
        type_label: type?.label ?? "Activity",
        mcp_name: a.mcp_name,
        done: a.activity_date <= nowStamp,
      };
    }),
  ].sort((a, b) => (a.date + (a.time ?? "99:99")).localeCompare(b.date + (b.time ?? "99:99")));

  // ---- Recent activity feed (§2.3) — newest N records across all projects ----
  const recentActivity = (db
    .prepare("SELECT * FROM activities ORDER BY activity_date DESC, id DESC LIMIT 15")
    .all() as any[]).map(serializeActivity);

  // ---- Recent wins (§2.5) — structured wins, last 30 days ----
  const recentWins = (db
    .prepare("SELECT * FROM wins WHERE occurred_date >= ? ORDER BY occurred_date DESC, id DESC LIMIT 6")
    .all(addDaysIso(today, -30)) as any[]).map(serializeWin);

  res.json({
    active_count: active.length,
    closed_count: all.length - active.length,
    closed_this_week: closedThisWeek,
    trends,
    rag_breakdown: ragBreakdown,
    overdue_tasks: overdue.map((t) => ({ id: t.id, project_id: t.project_id, name: t.name, due_date: t.due_date, project_code: t.project_code, mcp_name: t.mcp_name })),
    blocked_tasks: blocked.map((t) => ({ id: t.id, project_id: t.project_id, name: t.name, project_code: t.project_code, mcp_name: t.mcp_name })),
    my_open_tasks: myOpen.map((t) => ({ id: t.id, project_id: t.project_id, name: t.name, due_date: t.due_date, project_code: t.project_code, mcp_name: t.mcp_name })),
    week_start: wkStart,
    this_week: thisWeek,
    recent_activity: recentActivity,
    recent_wins: recentWins,
    attention: active.filter((p) => p.rag === "red").slice(0, 8),
  });
});
