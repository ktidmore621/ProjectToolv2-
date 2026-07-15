import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject, db, firstUserId, testApp } from "./helpers.js";

let app: ReturnType<typeof testApp>;
let uid: number;
beforeAll(() => {
  app = testApp();
  uid = firstUserId();
});

async function makeTaskField(body: Record<string, unknown>) {
  const res = await request(app).post("/api/custom-fields").send({ object_type: "task", ...body });
  expect(res.status).toBe(201);
  return res.body;
}

describe("E9 — custom fields extend to Tasks through the same engine", () => {
  it("an admin can define a task field of each supported type and set values via create + edit", async () => {
    const text = await makeTaskField({ label: "Vendor Ref", field_type: "text" });
    const num = await makeTaskField({ label: "Effort Points", field_type: "number" });
    const cur = await makeTaskField({ label: "Est Cost", field_type: "currency" });
    const date = await makeTaskField({ label: "Review Date", field_type: "date" });
    const drop = await makeTaskField({ label: "Work Stream", field_type: "dropdown", options: ["Billing", "Field"] });
    const check = await makeTaskField({ label: "Escalated", field_type: "checkbox" });
    const billing = drop.options.find((o: any) => o.label === "Billing");

    const p = await createProject(app);
    // create an ad-hoc task with custom values
    const created = await request(app).post(`/api/projects/${p.id}/tasks`).send({
      name: "Custom task", user_id: uid,
      custom: {
        [text.field_key]: "VR-9",
        [num.field_key]: "5",
        [cur.field_key]: "1200",
        [date.field_key]: "2026-04-01",
        [drop.field_key]: String(billing.id),
        [check.field_key]: "1",
      },
    });
    expect(created.status).toBe(201);
    const c = created.body.custom;
    expect(c[text.field_key].value).toBe("VR-9");
    expect(c[num.field_key].value).toBe("5");
    expect(c[cur.field_key].value).toBe("1200.00");
    expect(c[date.field_key].value).toBe("2026-04-01");
    expect(c[drop.field_key].option_label).toBe("Billing");
    expect(c[check.field_key].value).toBe("1");

    // edit an existing (template-generated) task's custom values
    const tpl = p.tasks[0];
    const patched = await request(app).patch(`/api/tasks/${tpl.id}`).send({ custom: { [text.field_key]: "VR-10" } });
    expect(patched.status).toBe(200);
    expect(patched.body.custom[text.field_key].value).toBe("VR-10");

    // visible on task surfaces: cross-project list + project detail
    const list = (await request(app).get(`/api/tasks?project_id=${p.id}`)).body;
    expect(list.find((t: any) => t.id === tpl.id).custom[text.field_key].value).toBe("VR-10");
    const detail = (await request(app).get(`/api/projects/${p.id}`)).body;
    expect(detail.tasks.find((t: any) => t.id === tpl.id).custom[text.field_key].value).toBe("VR-10");

    // invalid values are rejected with the same engine rules
    const bad = await request(app).post(`/api/projects/${p.id}/tasks`).send({
      name: "Bad", user_id: uid, custom: { [num.field_key]: "not-a-number" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Effort Points");
  });

  it("task fields get task_list and task_card layout slots (cross-project Task List honors layout)", async () => {
    const f = await makeTaskField({ label: "Layout Slot Check", field_type: "text" });
    for (const view of ["task_list", "task_card"]) {
      const layout = (await request(app).get(`/api/layouts/${view}`)).body;
      expect(layout.some((x: any) => x.field_key === f.field_key), view).toBe(true);
    }
  });

  it("a picklist value used only by a task custom field cannot be deleted (B1 coverage)", async () => {
    const drop = await makeTaskField({ label: "Only Task Usage", field_type: "dropdown", options: ["Solo"] });
    const solo = drop.options[0];
    const p = await createProject(app);
    await request(app).patch(`/api/tasks/${p.tasks[0].id}`).send({ custom: { [drop.field_key]: String(solo.id) } });

    const del = await request(app).delete(`/api/picklist-values/${solo.id}`);
    expect(del.body.archived).toBe(true);
    expect(db.prepare("SELECT archived FROM picklist_values WHERE id = ?").get(solo.id)).toEqual({ archived: 1 });
  });

  it("task custom-field requiredness is enforced via field_requirements", async () => {
    const f = await makeTaskField({ label: "Mandatory Ref", field_type: "text" });
    const rule = db.prepare("SELECT id FROM field_requirements WHERE object_type = 'task' AND field_name = ?").get(f.field_key) as any;
    await request(app).patch(`/api/field-requirements/${rule.id}`).send({ required: 1, required_at: "creation" });

    const p = await createProject(app);
    const missing = await request(app).post(`/api/projects/${p.id}/tasks`).send({ name: "No ref", user_id: uid });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("Mandatory Ref");

    const okRes = await request(app).post(`/api/projects/${p.id}/tasks`).send({
      name: "With ref", user_id: uid, custom: { [f.field_key]: "R-1" },
    });
    expect(okRes.status).toBe(201);
    // reset the rule so other tests aren't affected
    await request(app).patch(`/api/field-requirements/${rule.id}`).send({ required: 0, required_at: "creation" });
  });

  it("deleting a task field with values deactivates instead of deleting", async () => {
    const f = await makeTaskField({ label: "Holds Data", field_type: "text" });
    const p = await createProject(app);
    await request(app).patch(`/api/tasks/${p.tasks[0].id}`).send({ custom: { [f.field_key]: "kept" } });
    const del = await request(app).delete(`/api/custom-fields/${f.id}`);
    expect(del.body.deactivated).toBe(true);
    expect(del.body.message).toContain("task(s)");
  });
});
