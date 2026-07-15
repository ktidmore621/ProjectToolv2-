import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject, db, firstUserId, testApp, valueId } from "./helpers.js";

let app: ReturnType<typeof testApp>;
let uid: number;
beforeAll(() => {
  app = testApp();
  uid = firstUserId();
});

describe("E3 — Project Name field", () => {
  it("is optional at creation, persists, and serializes", async () => {
    const without = await createProject(app); // no project_name — must succeed
    expect(without.project_name).toBeNull();

    const withName = await createProject(app, { project_name: "2026 Billing Recovery" });
    expect(withName.project_name).toBe("2026 Billing Recovery");
    const fetched = (await request(app).get(`/api/projects/${withName.id}`)).body;
    expect(fetched.project_name).toBe("2026 Billing Recovery");
  });

  it("is editable via PATCH", async () => {
    const p = await createProject(app);
    const patched = await request(app).patch(`/api/projects/${p.id}`).send({ project_name: "Renamed", user_id: uid });
    expect(patched.body.project_name).toBe("Renamed");
  });

  it("has a layout slot immediately following MCP Name on all project views", async () => {
    for (const view of ["project_list", "portfolio_card", "project_header"]) {
      const layout = (await request(app).get(`/api/layouts/${view}`)).body
        .sort((a: any, b: any) => a.display_order - b.display_order);
      const mcpIdx = layout.findIndex((f: any) => f.field_key === "mcp_name");
      const pnIdx = layout.findIndex((f: any) => f.field_key === "project_name");
      expect(pnIdx, view).toBe(mcpIdx + 1);
    }
  });

  it("appears on cross-project task rows and in the projects export", async () => {
    const p = await createProject(app, { project_name: "Named Project" });
    const tasks = (await request(app).get(`/api/tasks?project_id=${p.id}`)).body;
    expect(tasks[0].project_name).toBe("Named Project");
    const csv = (await request(app).get("/api/export/projects.csv")).text;
    expect(csv.split("\n")[0]).toContain("Project Name");
    expect(csv).toContain("Named Project");
  });
});

describe("E5 — cancellation follows the closure workflow", () => {
  it("a plain status change to Cancelled is rejected toward the cancel form", async () => {
    const p = await createProject(app);
    const res = await request(app).post(`/api/projects/${p.id}/status`)
      .send({ status_id: valueId("Project Status", "cancelled"), user_id: uid });
    expect(res.status).toBe(422);
    expect(res.body.needs_close_form).toBe(true);
    expect(res.body.cancelled).toBe(true);
  });

  it("requires a Close Reason but not a Final Summary, and skips open-task blocking", async () => {
    const p = await createProject(app); // has open required tasks
    const noReason = await request(app).post(`/api/projects/${p.id}/close`).send({ user_id: uid, cancelled: true });
    expect(noReason.status).toBe(422);
    expect(noReason.body.problems.join(" ")).toContain("Close Reason");

    const okRes = await request(app).post(`/api/projects/${p.id}/close`)
      .send({ user_id: uid, cancelled: true, close_reason_id: valueId("Close Reason", "cancelled") });
    expect(okRes.status).toBe(200);
    expect(okRes.body.status_key).toBe("cancelled");
    expect(okRes.body.is_closed).toBe(true);
    expect(okRes.body.closed_date).toBeTruthy();
    expect(okRes.body.close_reason_label).toBe("Cancelled");
  });

  it("produces the same closed-state behavior: read-only, cleared RAG override, Green, audited", async () => {
    const p = await createProject(app);
    await request(app).post(`/api/projects/${p.id}/rag-override`).send({ rag: "red", reason: "at risk", user_id: uid });
    const cancelled = await request(app).post(`/api/projects/${p.id}/close`)
      .send({ user_id: uid, cancelled: true, close_reason_id: valueId("Close Reason", "cancelled") });
    expect(cancelled.body.rag).toBe("green");
    expect(cancelled.body.rag_overridden).toBe(false);

    // read-only afterward
    const patch = await request(app).patch(`/api/projects/${p.id}`).send({ mcp_name: "nope", user_id: uid });
    expect(patch.status).toBe(400);

    const audit = (await request(app).get(`/api/activities?project_id=${p.id}`)).body;
    expect(audit.some((a: any) => a.kind === "status_change" && a.note.includes("cancelled project"))).toBe(true);
    expect(audit.some((a: any) => a.note.includes("cleared manual RAG override"))).toBe(true);
  });
});

describe("E7 — Can Skip removed", () => {
  it("the column is gone and template task create/edit still works", async () => {
    const cols = db.prepare("PRAGMA table_info(template_tasks)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "can_skip")).toBe(false);

    const tpl = (await request(app).post("/api/templates").send({ name: "E7 tpl", user_id: uid })).body;
    const task = await request(app).post(`/api/templates/${tpl.id}/tasks`).send({ name: "Step 1", can_skip: 1 });
    expect(task.status).toBe(201);
    expect(task.body.can_skip).toBeUndefined();
    const patched = await request(app).patch(`/api/template-tasks/${task.body.id}`).send({ name: "Step 1b", can_skip: 0 });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Step 1b");
  });
});

describe("E8 — editable wins", () => {
  it("author can edit in place; non-author cannot; edits are audited", async () => {
    const p = await createProject(app);
    const other = (db.prepare("SELECT id FROM users WHERE id != ? LIMIT 1").get(uid) as any).id;
    const win = (await request(app).post("/api/wins").send({ project_id: p.id, description: "Original", user_id: uid })).body;

    const denied = await request(app).patch(`/api/wins/${win.id}`).send({ user_id: other, description: "Hijacked" });
    expect(denied.status).toBe(403);

    const okRes = await request(app).patch(`/api/wins/${win.id}`).send({ user_id: uid, description: "Corrected" });
    expect(okRes.status).toBe(200);
    expect(okRes.body.id).toBe(win.id); // same record — in-place correction
    expect(okRes.body.description).toBe("Corrected");

    const audit = (await request(app).get(`/api/activities?project_id=${p.id}&kind=system`)).body;
    expect(audit.some((a: any) => a.note.includes('edited a win: "Original"'))).toBe(true);
  });
});
