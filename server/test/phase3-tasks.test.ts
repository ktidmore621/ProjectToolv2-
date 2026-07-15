import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject, db, firstUserId, testApp, valueId } from "./helpers.js";

let app: ReturnType<typeof testApp>;
let uid: number;
beforeAll(() => {
  app = testApp();
  uid = firstUserId();
});

describe("E1 — time logging within tasks is bi-directional", () => {
  it("time logged against a task shows in the task view, the project Time list, and rollups", async () => {
    const p = await createProject(app);
    const task = p.tasks[0];

    // "from the task modal" — POST with project_task_id
    await request(app).post("/api/timelogs").send({
      project_id: p.id, project_task_id: task.id, user_id: uid, date: "2026-02-01", hours: 2, minutes: 30,
    });
    // "from the Time Log area" — same store, task selected there
    await request(app).post("/api/timelogs").send({
      project_id: p.id, project_task_id: task.id, user_id: uid, date: "2026-02-02", hours: 1, minutes: 0,
    });

    const byTask = (await request(app).get(`/api/timelogs?task_id=${task.id}`)).body;
    expect(byTask).toHaveLength(2);
    const byProject = (await request(app).get(`/api/timelogs?project_id=${p.id}`)).body;
    expect(byProject.filter((l: any) => l.project_task_id === task.id)).toHaveLength(2);
    // timecard query (user + range) sees the same records
    const byUser = (await request(app).get(`/api/timelogs?user_id=${uid}&start=2026-02-01&end=2026-02-07`)).body;
    expect(byUser.reduce((s: number, l: any) => s + l.total_minutes, 0)).toBe(210);
  });
});

describe("E2 — task status from the modal endpoint persists", () => {
  it("persists and is visible in list surfaces", async () => {
    const p = await createProject(app);
    const task = p.tasks[0];
    const inProgress = valueId("Task Status", "in_progress");
    const r = await request(app).post(`/api/tasks/${task.id}/status`).send({ status_id: inProgress, user_id: uid });
    expect(r.status).toBe(200);
    expect(r.body.task.status_key).toBe("in_progress");
    const list = (await request(app).get(`/api/tasks?project_id=${p.id}`)).body;
    expect(list.find((t: any) => t.id === task.id).status_key).toBe("in_progress");
  });
});

describe("E4a/b — Skipped is archived, legacy skipped still closes", () => {
  it("Skipped is archived in the seed and cannot be newly assigned", async () => {
    const skippedId = valueId("Task Status", "skipped");
    const row = db.prepare("SELECT archived FROM picklist_values WHERE id = ?").get(skippedId) as any;
    expect(row.archived).toBe(1);

    const p = await createProject(app);
    const res = await request(app)
      .post(`/api/tasks/${p.tasks[0].id}/status`)
      .send({ status_id: skippedId, user_id: uid, skip_reason: "should not matter" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("archived");
  });

  it("legacy Skipped still renders and still satisfies closure", async () => {
    const p = await createProject(app);
    const skippedId = valueId("Task Status", "skipped");
    const completeId = valueId("Task Status", "complete");
    // simulate legacy data: one required task skipped before the retirement
    const legacy = p.tasks.find((t: any) => t.required);
    db.prepare("UPDATE project_tasks SET status_id = ?, skip_reason = 'legacy skip' WHERE id = ?").run(skippedId, legacy.id);
    db.prepare("UPDATE project_tasks SET status_id = ? WHERE project_id = ? AND id != ?").run(completeId, p.id, legacy.id);

    const detail = (await request(app).get(`/api/projects/${p.id}`)).body;
    expect(detail.tasks.find((t: any) => t.id === legacy.id).status_label).toBe("Skipped");

    const close = await request(app).post(`/api/projects/${p.id}/close`).send({
      user_id: uid, final_summary: "done", close_reason_id: valueId("Close Reason", "issue_resolved"),
    });
    expect(close.status).toBe(200);
    expect(close.body.is_closed).toBe(true);
  });

  it("an open required task still blocks closure (Complete or deleted is the new rule)", async () => {
    const p = await createProject(app);
    const close = await request(app).post(`/api/projects/${p.id}/close`).send({
      user_id: uid, final_summary: "done", close_reason_id: valueId("Close Reason", "issue_resolved"),
    });
    expect(close.status).toBe(422);
    expect(close.body.problems.some((x: string) => x.includes("Required task"))).toBe(true);
  });
});

describe("E4c/d — deletion unlinks and preserves", () => {
  it("deleting a task with time and activities loses nothing and keeps timecard totals", async () => {
    const p = await createProject(app);
    const task = p.tasks[0];

    await request(app).post("/api/timelogs").send({ project_id: p.id, project_task_id: task.id, user_id: uid, date: "2026-03-01", hours: 3, minutes: 15 });
    await request(app).post("/api/activities").send({ project_id: p.id, project_task_id: task.id, user_id: uid, note: "task note", task_ids: [task.id] });

    const before = (await request(app).get(`/api/timelogs?user_id=${uid}&start=2026-03-01&end=2026-03-01`)).body
      .reduce((s: number, l: any) => s + l.total_minutes, 0);

    const del = await request(app).delete(`/api/tasks/${task.id}?user_id=${uid}`);
    expect(del.status).toBe(200);

    // task gone
    expect(db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(task.id)).toBeUndefined();

    // time preserved, re-parented to the project — totals unchanged
    const after = (await request(app).get(`/api/timelogs?user_id=${uid}&start=2026-03-01&end=2026-03-01`)).body;
    expect(after.reduce((s: number, l: any) => s + l.total_minutes, 0)).toBe(before);
    expect(after.every((l: any) => l.project_task_id === null)).toBe(true);
    expect(after.every((l: any) => l.project_id === p.id)).toBe(true);

    // note preserved at project level
    const notes = (await request(app).get(`/api/activities?project_id=${p.id}&kind=note`)).body;
    expect(notes.some((a: any) => a.note === "task note" && a.project_task_id === null)).toBe(true);

    // deletion audited
    const audit = (await request(app).get(`/api/activities?project_id=${p.id}&kind=system`)).body;
    expect(audit.some((a: any) => a.note.startsWith(`deleted task "${task.name}"`))).toBe(true);
  });

  it("required template tasks can now be deleted (Delete replaces Skipped)", async () => {
    const p = await createProject(app);
    const required = p.tasks.find((t: any) => t.required && t.task_type === "standard");
    const del = await request(app).delete(`/api/tasks/${required.id}?user_id=${uid}`);
    expect(del.status).toBe(200);
  });
});
