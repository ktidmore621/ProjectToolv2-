import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject, firstUserId, testApp } from "./helpers.js";

let app: ReturnType<typeof testApp>;
let uid: number;
beforeAll(async () => {
  app = testApp();
  uid = firstUserId();
});

describe("E10 — portfolio RAG shows count and total AP", () => {
  it("dashboard returns AP totals per RAG state consistent with the counts", async () => {
    await createProject(app, { annualized_premium: 1000 });
    await createProject(app, { annualized_premium: 250.5 });
    const d = (await request(app).get("/api/dashboard")).body;
    expect(d.rag_ap).toBeDefined();
    const totalCount = d.rag_breakdown.red + d.rag_breakdown.amber + d.rag_breakdown.green;
    const projects = (await request(app).get("/api/projects?scope=active")).body;
    expect(totalCount).toBe(projects.length);
    const apSum = d.rag_ap.red + d.rag_ap.amber + d.rag_ap.green;
    const expected = projects.reduce((s: number, p: any) => s + (p.annualized_premium ?? 0), 0);
    expect(apSum).toBeCloseTo(expected, 2);
  });
});

describe("E11 — server-side pagination", () => {
  it("defaults to 25 per page and reports the full total", async () => {
    const existing = (await request(app).get("/api/projects?scope=active")).body.length;
    for (let i = existing; i < 30; i++) await createProject(app);

    const page1 = (await request(app).get("/api/projects?scope=active&page=1")).body;
    expect(page1.page_size).toBe(25);
    expect(page1.rows).toHaveLength(25);
    expect(page1.total).toBeGreaterThanOrEqual(30);
    const page2 = (await request(app).get("/api/projects?scope=active&page=2")).body;
    expect(page2.rows.length).toBe(page1.total - 25);
    // no overlap between pages
    const ids1 = new Set(page1.rows.map((p: any) => p.id));
    expect(page2.rows.every((p: any) => !ids1.has(p.id))).toBe(true);
  });

  it("filters and sorts apply across the full result set, not just the current page", async () => {
    await createProject(app, { mcp_name: "Zzz Pagination Target", annualized_premium: 1 });
    // the target would never be on page 1 of an unfiltered ascending list…
    const filtered = (await request(app).get("/api/projects?scope=active&page=1&q=zzz pagination")).body;
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0].mcp_name).toBe("Zzz Pagination Target");

    // …but sorting desc by name puts it first on page 1
    const sorted = (await request(app).get("/api/projects?scope=active&page=1&sort=mcp_name&dir=desc")).body;
    expect(sorted.rows[0].mcp_name).toBe("Zzz Pagination Target");
  });

  it("the tasks list paginates too, and non-paged callers still get plain arrays", async () => {
    const paged = (await request(app).get("/api/tasks?page=1")).body;
    expect(Array.isArray(paged.rows)).toBe(true);
    expect(paged.page_size).toBe(25);
    expect(paged.rows.length).toBeLessThanOrEqual(25);
    expect(paged.total).toBeGreaterThan(25);

    const plain = (await request(app).get("/api/tasks")).body;
    expect(Array.isArray(plain)).toBe(true);
    expect(plain.length).toBe(paged.total);

    const plainProjects = (await request(app).get("/api/projects?scope=active")).body;
    expect(Array.isArray(plainProjects)).toBe(true);
  });
});
