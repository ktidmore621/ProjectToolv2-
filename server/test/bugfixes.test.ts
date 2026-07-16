/**
 * Regression tests for the bug-hunt fixes. Each describe block corresponds to
 * one fix commit and fails against the pre-fix code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("Fix 5 — partial custom-field updates keep omitted fields", () => {
  it("PATCHing one custom field leaves the others untouched", async () => {
    const f1 = await request(app).post("/api/custom-fields").send({ label: "Region A", field_type: "text" });
    const f2 = await request(app).post("/api/custom-fields").send({ label: "Segment A", field_type: "text" });
    expect(f1.status).toBe(201);
    expect(f2.status).toBe(201);
    const k1 = f1.body.field_key, k2 = f2.body.field_key;
    const p = await createProject(app, { custom: { [k1]: "West", [k2]: "Enterprise" } });
    const res = await request(app).patch(`/api/projects/${p.id}`)
      .send({ user_id: uid(), custom: { [k1]: "East" } });
    expect(res.status).toBe(200);
    expect(res.body.custom[k1].value).toBe("East");
    expect(res.body.custom[k2].value).toBe("Enterprise");
    // an explicit null/blank still clears
    const clear = await request(app).patch(`/api/projects/${p.id}`)
      .send({ user_id: uid(), custom: { [k2]: "" } });
    expect(clear.body.custom[k2].value).toBeNull();
    expect(clear.body.custom[k1].value).toBe("East");
  });
});

describe("Fix 6 — deleting a legacy win with a twin description", () => {
  it("succeeds and leaves the other win's audit note intact", async () => {
    const p = await createProject(app);
    const w1 = await request(app).post("/api/wins").send({ project_id: p.id, description: "Saved money", user_id: uid(), occurred_date: "2026-01-11" });
    const w2 = await request(app).post("/api/wins").send({ project_id: p.id, description: "Saved money", user_id: uid(), occurred_date: "2026-01-12" });
    expect(w1.status).toBe(201);
    expect(w2.status).toBe(201);
    // simulate a legacy win created before wins.activity_id existed
    db.prepare("UPDATE wins SET activity_id = NULL WHERE id = ?").run(w1.body.id);
    db.prepare("DELETE FROM activities WHERE id = ?").run(w1.body.activity_id ?? -1);

    const del = await request(app).delete(`/api/wins/${w1.body.id}?user_id=${uid()}`);
    expect(del.status).toBe(200); // pre-fix: FK constraint -> 500, win undeletable
    expect(db.prepare("SELECT id FROM wins WHERE id = ?").get(w1.body.id)).toBeUndefined();
    // w2 and its linked audit note survive
    expect(db.prepare("SELECT id FROM wins WHERE id = ?").get(w2.body.id)).toBeTruthy();
    expect(db.prepare("SELECT id FROM activities WHERE id = ?").get(w2.body.activity_id)).toBeTruthy();
  });

  it("removes exactly one note when a legacy win still has its own", async () => {
    const p = await createProject(app);
    const w1 = await request(app).post("/api/wins").send({ project_id: p.id, description: "Twin note", user_id: uid(), occurred_date: "2026-01-11" });
    const w2 = await request(app).post("/api/wins").send({ project_id: p.id, description: "Twin note", user_id: uid(), occurred_date: "2026-01-12" });
    // both legacy: neither remembers its note id
    db.prepare("UPDATE wins SET activity_id = NULL WHERE id IN (?, ?)").run(w1.body.id, w2.body.id);
    const countNotes = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM activities WHERE project_id = ? AND kind = 'system' AND note = ?")
        .get(p.id, 'logged a win: "Twin note"') as any).n;
    expect(countNotes()).toBe(2);
    await request(app).delete(`/api/wins/${w1.body.id}?user_id=${uid()}`);
    expect(countNotes()).toBe(1); // pre-fix: both notes deleted
  });
});

describe("Fix 7 — project dates are validated as real calendar dates", () => {
  it("rejects a malformed assignment date with a 400 instead of a 500", async () => {
    const res = await request(app).post("/api/projects").send({
      mcp_number: "MCP-BADDATE", mcp_name: "Bad Date Co", assignee_id: uid(),
      annualized_premium: 100, assignment_date: "not-a-date",
      template_id: (db.prepare("SELECT id FROM workflow_templates WHERE is_default = 1").get() as any).id,
      user_id: uid(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Assignment Date/);
  });

  it("rejects an impossible calendar day", async () => {
    const res = await request(app).post("/api/projects").send({
      mcp_number: "MCP-BADDATE2", mcp_name: "Bad Date Co 2", assignee_id: uid(),
      annualized_premium: 100, assignment_date: "2026-02-30",
      template_id: (db.prepare("SELECT id FROM workflow_templates WHERE is_default = 1").get() as any).id,
      user_id: uid(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects garbage target_date on create and edit", async () => {
    const create = await request(app).post("/api/projects").send({
      mcp_number: "MCP-BADTGT", mcp_name: "Bad Target Co", assignee_id: uid(),
      annualized_premium: 100, assignment_date: "2026-01-10", target_date: "soon",
      template_id: (db.prepare("SELECT id FROM workflow_templates WHERE is_default = 1").get() as any).id,
      user_id: uid(),
    });
    expect(create.status).toBe(400);
    const p = await createProject(app);
    const patch = await request(app).patch(`/api/projects/${p.id}`).send({ target_date: "soon", user_id: uid() });
    expect(patch.status).toBe(400);
    const okPatch = await request(app).patch(`/api/projects/${p.id}`).send({ target_date: "2026-06-30", user_id: uid() });
    expect(okPatch.status).toBe(200);
    expect(okPatch.body.target_date).toBe("2026-06-30");
  });
});

describe("Fix 8 — CSV import: preview matches commit and requirement rules apply", () => {
  const csvFor = (mcp: string) => `MCP Number,MCP Name,Assignee,AP\n${mcp},Import Co,Morgan Hale,1000`;

  it("flags rows as invalid in preview when no active template exists (instead of silently skipping at commit)", async () => {
    const tpls = db.prepare("SELECT id FROM workflow_templates").all() as { id: number }[];
    db.prepare("UPDATE workflow_templates SET is_active = 0").run();
    try {
      const prev = await request(app).post("/api/import/projects/preview").send({ csv: csvFor("MCP-IMP-NT") });
      expect(prev.status).toBe(200);
      expect(prev.body.valid).toBe(0);
      expect(prev.body.rows[0].errors.join(" ")).toMatch(/template/i);
      const commit = await request(app).post("/api/import/projects/commit").send({ csv: csvFor("MCP-IMP-NT"), user_id: uid() });
      expect(commit.body.created).toBe(0);
      expect(commit.body.skipped).toBe(1);
    } finally {
      for (const t of tpls) db.prepare("UPDATE workflow_templates SET is_active = 1 WHERE id = ?").run(t.id);
    }
  });

  it("enforces admin-configured required-at-creation fields", async () => {
    // make Estimated Completion Date required at creation
    const rule = db.prepare("SELECT id FROM field_requirements WHERE object_type = 'project' AND field_name = 'target_date'").get() as { id: number };
    await request(app).patch(`/api/field-requirements/${rule.id}`).send({ required: true, required_at: "creation" });
    try {
      const prev = await request(app).post("/api/import/projects/preview").send({ csv: csvFor("MCP-IMP-REQ") });
      expect(prev.body.valid).toBe(0);
      expect(prev.body.rows[0].errors).toContain("Estimated Completion Date is required");
      const commit = await request(app).post("/api/import/projects/commit").send({ csv: csvFor("MCP-IMP-REQ"), user_id: uid() });
      expect(commit.body.created).toBe(0);
    } finally {
      await request(app).patch(`/api/field-requirements/${rule.id}`).send({ required: false, required_at: "creation" });
    }
  });

  it("a clean row still imports", async () => {
    const commit = await request(app).post("/api/import/projects/commit").send({ csv: csvFor("MCP-IMP-OK"), user_id: uid() });
    expect(commit.body.created).toBe(1);
    expect(commit.body.skipped).toBe(0);
  });
});

describe("Fix 9 — notes can't attach to another project's task", () => {
  it("rejects a foreign project_task_id", async () => {
    const p1 = await createProject(app);
    const p2 = await createProject(app);
    const res = await request(app).post("/api/activities").send({
      project_id: p1.id, project_task_id: p2.tasks[0].id, user_id: uid(), note: "cross-project note",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same project/);
  });

  it("still accepts a task from the same project", async () => {
    const p = await createProject(app);
    const res = await request(app).post("/api/activities").send({
      project_id: p.id, project_task_id: p.tasks[0].id, user_id: uid(), note: "task note",
    });
    expect(res.status).toBe(201);
    expect(res.body.task_name).toBe(p.tasks[0].name);
  });
});

describe("Fix 10 — dashboard 'This Week' runs on Central Time and skips closed projects", () => {
  afterEach(() => vi.useRealTimers());

  it("does not mark an evening activity done before it happens (Central, not UTC)", async () => {
    // 23:30 UTC on Thu 2026-07-16 is 18:30 in Chicago (CDT). An activity at
    // 20:00 Central that evening has NOT happened yet — the old UTC comparison
    // ("2026-07-16 23:30") called it done.
    vi.useFakeTimers({ now: new Date("2026-07-16T23:30:00Z"), toFake: ["Date"] });
    const p = await createProject(app);
    const act = await request(app).post("/api/activities").send({
      project_id: p.id, user_id: uid(), kind: "activity",
      activity_type_id: valueId("Activity Type", "phone_call"),
      activity_date: "2026-07-16", start_time: "20:00", end_time: "21:00",
      note: "Evening call",
    });
    expect(act.status).toBe(201);
    const dash = await request(app).get("/api/dashboard");
    const entry = dash.body.this_week.find((x: any) => x.kind === "activity" && x.id === act.body.id);
    expect(entry).toBeTruthy();
    expect(entry.done).toBe(false);
  });

  it("excludes closed projects' activities from This Week, like tasks", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-16T12:00:00Z"), toFake: ["Date"] });
    const p = await createProject(app);
    const act = await request(app).post("/api/activities").send({
      project_id: p.id, user_id: uid(), kind: "activity",
      activity_type_id: valueId("Activity Type", "site_visit"),
      activity_date: "2026-07-17", start_time: "09:00",
      note: "Visit before closure",
    });
    expect(act.status).toBe(201);
    await closeProject(p.id);
    const dash = await request(app).get("/api/dashboard");
    expect(dash.body.this_week.some((x: any) => x.kind === "activity" && x.id === act.body.id)).toBe(false);
  });
});

describe("Fix 11 — numeric custom fields sort numerically", () => {
  it("sorts a number custom field by value, not by string", async () => {
    const f = await request(app).post("/api/custom-fields").send({ label: "Headcount", field_type: "number" });
    expect(f.status).toBe(201);
    const key = f.body.field_key;
    const p9 = await createProject(app, { custom: { [key]: "9" } });
    const p10 = await createProject(app, { custom: { [key]: "10" } });
    const p100 = await createProject(app, { custom: { [key]: "100" } });
    const res = await request(app).get(`/api/projects?sort=${key}&dir=asc`);
    const order = res.body
      .filter((p: any) => [p9.id, p10.id, p100.id].includes(p.id))
      .map((p: any) => p.custom[key].value);
    expect(order).toEqual(["9", "10", "100"]); // pre-fix: ["10", "100", "9"]
  });
});
