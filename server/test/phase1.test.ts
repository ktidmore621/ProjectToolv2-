import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject, db, defaultTemplateId, firstUserId, testApp, valueId } from "./helpers.js";

let app: ReturnType<typeof testApp>;
beforeAll(() => {
  app = testApp((a) => {
    // B7 test route: registered before the error middleware via buildApp hook
    a.get("/api/boom", () => {
      throw new Error("deliberate test explosion");
    });
  });
});

describe("B1 — picklist deletion cannot orphan custom-field data", () => {
  it("archives (not deletes) a value referenced only by a project custom value, and keeps it rendering", async () => {
    const field = (
      await request(app).post("/api/custom-fields").send({ label: "Region", field_type: "dropdown", options: ["North", "South"] })
    ).body;
    const north = field.options.find((o: any) => o.label === "North");
    const project = await createProject(app, { custom: { [field.field_key]: String(north.id) } });

    const del = await request(app).delete(`/api/picklist-values/${north.id}`);
    expect(del.body.archived).toBe(true);
    expect(del.body.deleted).toBeUndefined();

    // value still exists, archived
    const row = db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(north.id) as any;
    expect(row).toBeTruthy();
    expect(row.archived).toBe(1);

    // legacy record renders exactly as before — never blank
    const p = (await request(app).get(`/api/projects/${project.id}`)).body;
    expect(p.custom[field.field_key].option_label).toBe("North");
  });

  it("still hard-deletes a never-used value", async () => {
    const field = (
      await request(app).post("/api/custom-fields").send({ label: "Segment", field_type: "dropdown", options: ["A", "Typo"] })
    ).body;
    const typo = field.options.find((o: any) => o.label === "Typo");
    const del = await request(app).delete(`/api/picklist-values/${typo.id}`);
    expect(del.body.deleted).toBe(true);
    expect(db.prepare("SELECT * FROM picklist_values WHERE id = ?").get(typo.id)).toBeUndefined();
  });

  it("archived values stay findable via the picklists listing", async () => {
    const lists = (await request(app).get("/api/picklists")).body;
    const archived = lists.flatMap((l: any) => l.values).filter((v: any) => v.archived);
    expect(archived.some((v: any) => v.label === "North")).toBe(true);
  });
});

describe("B3 — project codes come from a sequence", () => {
  it("stays unique after a project is deleted", async () => {
    const p1 = await createProject(app);
    const p2 = await createProject(app);
    // simulate a manual deletion (there is no delete endpoint for projects)
    db.prepare("DELETE FROM project_custom_values WHERE project_id = ?").run(p1.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(p1.id);
    const p3 = await createProject(app);
    expect(p3.project_code).not.toBe(p2.project_code);
    expect(Number(p3.project_code.slice(4))).toBeGreaterThan(Number(p2.project_code.slice(4)));
  });
});

describe("B2 — manual RAG overrides are cleared at closure", () => {
  it("closes Green with the override clear in the audit log", async () => {
    const p = await createProject(app);
    const uid = firstUserId();
    await request(app).post(`/api/projects/${p.id}/rag-override`).send({ rag: "red", reason: "escalated", user_id: uid });

    const close = await request(app)
      .post(`/api/projects/${p.id}/close`)
      .send({ user_id: uid, final_summary: "done", close_reason_id: valueId("Close Reason", "issue_resolved"), override: true, override_reason: "test closure" });
    expect(close.status).toBe(200);
    expect(close.body.rag).toBe("green");
    expect(close.body.rag_overridden).toBe(false);

    const audit = (await request(app).get(`/api/activities?project_id=${p.id}&kind=system`)).body;
    expect(audit.some((a: any) => a.note.includes("cleared manual RAG override (RED"))).toBe(true);
  });

  it("blocks re-applying an override on a closed project", async () => {
    const closed = (await request(app).get("/api/projects?scope=closed")).body[0];
    const res = await request(app).post(`/api/projects/${closed.id}/rag-override`).send({ rag: "red", reason: "x", user_id: firstUserId() });
    expect(res.status).toBe(400);
  });
});

describe("B5 — CSV formula injection", () => {
  it("exports a project name starting with '=' as inert text", async () => {
    await createProject(app, { mcp_name: "=cmd|' /C calc'!A0" });
    const res = await request(app).get("/api/export/projects.csv");
    expect(res.text).toContain("'=cmd|");
    expect(res.text).not.toMatch(/(^|,)=cmd\|/m);
  });

  it("covers the wins export too", async () => {
    const p = await createProject(app);
    await request(app).post("/api/wins").send({ project_id: p.id, description: "+SUM(A1:A9)", user_id: firstUserId() });
    const res = await request(app).get("/api/export/wins.csv");
    expect(res.text).toContain("'+SUM(A1:A9)");
  });
});

describe("B7 — JSON error middleware", () => {
  it("returns structured JSON instead of an HTML error page", async () => {
    const res = await request(app).get("/api/boom");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error).toBeTruthy();
    // stack traces stay server-side
    expect(JSON.stringify(res.body)).not.toContain("deliberate test explosion");
    expect(JSON.stringify(res.body)).not.toContain("at ");
  });

  it("handles malformed JSON bodies", async () => {
    const res = await request(app).post("/api/projects").set("Content-Type", "application/json").send("{nope");
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe("B4 — win deletion is author-only, audited, and leaves no orphaned note", () => {
  it("rejects a non-author and allows the author, cleaning up the system note", async () => {
    const p = await createProject(app);
    const uid = firstUserId();
    const otherUid = (db.prepare("SELECT id FROM users WHERE id != ? LIMIT 1").get(uid) as any).id;
    const win = (await request(app).post("/api/wins").send({ project_id: p.id, description: "Saved the day", user_id: uid })).body;

    const denied = await request(app).delete(`/api/wins/${win.id}?user_id=${otherUid}`);
    expect(denied.status).toBe(403);

    const okRes = await request(app).delete(`/api/wins/${win.id}?user_id=${uid}`);
    expect(okRes.status).toBe(200);

    const audit = (await request(app).get(`/api/activities?project_id=${p.id}&kind=system`)).body;
    expect(audit.some((a: any) => a.note === 'deleted a win: "Saved the day"')).toBe(true);
    // the creation note is gone — no orphan pointing at a missing win
    expect(audit.some((a: any) => a.note === 'logged a win: "Saved the day"')).toBe(false);
  });
});
