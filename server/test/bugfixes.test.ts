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
