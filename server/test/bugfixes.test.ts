/**
 * Regression tests for the bug-hunt fixes. Each describe block corresponds to
 * one fix commit and fails against the pre-fix code.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createProject, db, firstUserId, testApp, valueId } from "./helpers.js";

const app = testApp();
const uid = () => firstUserId();
const secondUserId = () =>
  (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1 OFFSET 1").get() as { id: number }).id;

async function closeProject(id: number) {
  const res = await request(app).post(`/api/projects/${id}/close`).send({
    user_id: uid(),
    final_summary: "done",
    close_reason_id: valueId("Close Reason", "issue_resolved"),
    override: true,
    override_reason: "test",
  });
  expect(res.status).toBe(200);
}

async function logTime(projectId: number, overrides: Record<string, unknown> = {}) {
  return request(app).post("/api/timelogs").send({
    project_id: projectId, user_id: uid(), date: "2026-01-15", hours: 1, minutes: 0, ...overrides,
  });
}

describe("Fix 1 — time logs respect closed projects and are author-only", () => {
  it("rejects logging time on a closed project", async () => {
    const p = await createProject(app);
    await closeProject(p.id);
    const res = await logTime(p.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/closed/i);
  });

  it("rejects editing and deleting a time entry on a closed project", async () => {
    const p = await createProject(app);
    const log = await logTime(p.id);
    expect(log.status).toBe(201);
    await closeProject(p.id);
    const patch = await request(app).patch(`/api/timelogs/${log.body.id}`).send({ user_id: uid(), hours: 2 });
    expect(patch.status).toBe(400);
    const del = await request(app).delete(`/api/timelogs/${log.body.id}?user_id=${uid()}`);
    expect(del.status).toBe(400);
  });

  it("only the author can edit or delete a time entry", async () => {
    const p = await createProject(app);
    const log = await logTime(p.id);
    const other = secondUserId();
    const patch = await request(app).patch(`/api/timelogs/${log.body.id}`).send({ user_id: other, hours: 2 });
    expect(patch.status).toBe(403);
    const del = await request(app).delete(`/api/timelogs/${log.body.id}?user_id=${other}`);
    expect(del.status).toBe(403);
    // the author still can
    const ownPatch = await request(app).patch(`/api/timelogs/${log.body.id}`).send({ user_id: uid(), hours: 2 });
    expect(ownPatch.status).toBe(200);
    expect(ownPatch.body.hours).toBe(2);
    const ownDel = await request(app).delete(`/api/timelogs/${log.body.id}?user_id=${uid()}`);
    expect(ownDel.status).toBe(200);
  });

  it("deleting a missing time entry is a 404, not a silent ok", async () => {
    const res = await request(app).delete(`/api/timelogs/999999?user_id=${uid()}`);
    expect(res.status).toBe(404);
  });
});

describe("Fix 2 — time-log validation on edit and non-numeric input", () => {
  it("rejects negative and out-of-range durations on PATCH", async () => {
    const p = await createProject(app);
    const log = await logTime(p.id);
    const res = await request(app).patch(`/api/timelogs/${log.body.id}`).send({ user_id: uid(), hours: -5, minutes: 500 });
    expect(res.status).toBe(400);
    const unchanged = await request(app).get(`/api/timelogs?project_id=${p.id}`);
    expect(unchanged.body[0].total_minutes).toBe(60);
  });

  it("rejects non-numeric hours with a 400 instead of crashing", async () => {
    const p = await createProject(app);
    const res = await logTime(p.id, { hours: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duration/i);
  });

  it("rejects linking a time entry to a task from a different project", async () => {
    const p1 = await createProject(app);
    const p2 = await createProject(app);
    const foreignTask = p2.tasks[0];
    const create = await logTime(p1.id, { project_task_id: foreignTask.id });
    expect(create.status).toBe(400);
    const log = await logTime(p1.id);
    const patch = await request(app).patch(`/api/timelogs/${log.body.id}`).send({ user_id: uid(), project_task_id: foreignTask.id });
    expect(patch.status).toBe(400);
    // a task from the same project is fine
    const okPatch = await request(app).patch(`/api/timelogs/${log.body.id}`).send({ user_id: uid(), project_task_id: p1.tasks[0].id });
    expect(okPatch.status).toBe(200);
    expect(okPatch.body.task_name).toBe(p1.tasks[0].name);
  });

  it("rejects a malformed date", async () => {
    const p = await createProject(app);
    const res = await logTime(p.id, { date: "not-a-date" });
    expect(res.status).toBe(400);
  });
});

describe("Fix 3 — status endpoints only accept values from their own picklist", () => {
  it("rejects a Task Status value as a project status", async () => {
    const p = await createProject(app);
    const res = await request(app).post(`/api/projects/${p.id}/status`)
      .send({ status_id: valueId("Task Status", "in_progress"), user_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown status");
  });

  it("rejects a Win Category value as a task status", async () => {
    const p = await createProject(app);
    const res = await request(app).post(`/api/tasks/${p.tasks[0].id}/status`)
      .send({ status_id: valueId("Win Category", "cost_savings"), user_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown status");
  });

  it("still accepts a legitimate status from the right picklist", async () => {
    const p = await createProject(app);
    const proj = await request(app).post(`/api/projects/${p.id}/status`)
      .send({ status_id: valueId("Project Status", "in_progress"), user_id: uid() });
    expect(proj.status).toBe(200);
    expect(proj.body.status_key).toBe("in_progress");
    const task = await request(app).post(`/api/tasks/${p.tasks[0].id}/status`)
      .send({ status_id: valueId("Task Status", "in_progress"), user_id: uid() });
    expect(task.status).toBe(200);
    expect(task.body.task.status_key).toBe("in_progress");
  });

  it("rejects newly assigning a deactivated value", async () => {
    const p = await createProject(app);
    // deactivate a non-system value (Risk-style: use a fresh custom status)
    const list = db.prepare("SELECT id FROM picklists WHERE name = 'Project Status'").get() as { id: number };
    const custom = await request(app).post(`/api/picklists/${list.id}/values`).send({ label: "Weird Interim" });
    expect(custom.status).toBe(201);
    await request(app).patch(`/api/picklist-values/${custom.body.id}`).send({ is_active: false });
    const res = await request(app).post(`/api/projects/${p.id}/status`)
      .send({ status_id: custom.body.id, user_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deactivated/);
  });
});

describe("Fix 4 — project edits can't blank always-required fields", () => {
  it("rejects blanking MCP Name", async () => {
    const p = await createProject(app);
    const res = await request(app).patch(`/api/projects/${p.id}`).send({ mcp_name: "", user_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MCP Name is required");
    const fresh = await request(app).get(`/api/projects/${p.id}`);
    expect(fresh.body.mcp_name).toBe(p.mcp_name);
  });

  it("rejects nulling the assignee", async () => {
    const p = await createProject(app);
    const res = await request(app).patch(`/api/projects/${p.id}`).send({ assignee_id: null, user_id: uid() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Assignee is required");
  });

  it("still allows normal edits and clearing optional fields", async () => {
    const p = await createProject(app);
    const res = await request(app).patch(`/api/projects/${p.id}`)
      .send({ mcp_name: "Renamed Co", project_name: null, target_date: null, user_id: uid() });
    expect(res.status).toBe(200);
    expect(res.body.mcp_name).toBe("Renamed Co");
  });
});
