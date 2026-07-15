import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { todayCentral } from "../src/core.js";
import { createProject, db, testApp } from "./helpers.js";

let app: ReturnType<typeof testApp>;
beforeAll(() => {
  app = testApp();
});

// Only fake Date — faking timers would stall supertest's sockets
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
afterEach(() => vi.useRealTimers());

describe("E6 — todayCentral() follows America/Chicago through DST", () => {
  it("summer (CDT, UTC-5)", () => {
    at("2026-07-15T04:30:00Z"); // 23:30 CDT on the 14th
    expect(todayCentral()).toBe("2026-07-14");
    at("2026-07-15T05:30:00Z"); // 00:30 CDT on the 15th — a hardcoded UTC-6 would still say the 14th
    expect(todayCentral()).toBe("2026-07-15");
  });

  it("winter (CST, UTC-6)", () => {
    at("2026-01-15T05:30:00Z"); // 23:30 CST on the 14th
    expect(todayCentral()).toBe("2026-01-14");
    at("2026-01-15T06:30:00Z"); // 00:30 CST on the 15th
    expect(todayCentral()).toBe("2026-01-15");
  });

  it("spring-forward boundary (2026-03-08 02:00 CST → 03:00 CDT)", () => {
    at("2026-03-08T07:59:00Z"); // 01:59 CST
    expect(todayCentral()).toBe("2026-03-08");
    at("2026-03-08T08:30:00Z"); // 03:30 CDT
    expect(todayCentral()).toBe("2026-03-08");
  });

  it("fall-back boundary (2026-11-01)", () => {
    at("2026-11-01T04:59:00Z"); // 23:59 CDT on Oct 31 — UTC already says Nov 1
    expect(todayCentral()).toBe("2026-10-31");
    at("2026-11-01T07:30:00Z"); // 01:30 CST after the fall-back
    expect(todayCentral()).toBe("2026-11-01");
  });
});

describe("E6 — RAG engine and overdue determinations use the Central date", () => {
  it("a task due 'today' in Central is due-soon, not overdue, when UTC has rolled past midnight", async () => {
    at("2026-07-15T03:00:00Z"); // 22:00 CDT on 2026-07-14
    const p = await createProject(app, { assignment_date: "2026-07-01" });
    db.prepare("UPDATE project_tasks SET due_date = '2026-07-14' WHERE project_id = ?").run(p.id);

    // not overdue in the cross-project task list
    const overdue = (await request(app).get("/api/tasks?overdue=1")).body;
    expect(overdue.filter((t: any) => t.project_id === p.id)).toHaveLength(0);

    // RAG reads "due within", not "overdue"
    const proj = (await request(app).get(`/api/projects/${p.id}`)).body;
    expect(proj.rag).toBe("amber");
    expect(proj.rag_reason).toContain("due within");
  });

  it("the same clock instant marks the task overdue once the Central date has passed", async () => {
    at("2026-07-16T05:30:00Z"); // 00:30 CDT on 2026-07-16 → due 07-14 is now overdue
    const p = await createProject(app, { assignment_date: "2026-07-01", mcp_number: "MCP-E6B" });
    db.prepare("UPDATE project_tasks SET due_date = '2026-07-14' WHERE project_id = ?").run(p.id);
    const overdue = (await request(app).get("/api/tasks?overdue=1")).body;
    expect(overdue.filter((t: any) => t.project_id === p.id).length).toBeGreaterThan(0);
    const proj = (await request(app).get(`/api/projects/${p.id}`)).body;
    expect(proj.rag_reason.toLowerCase()).toContain("overdue");
  });
});
