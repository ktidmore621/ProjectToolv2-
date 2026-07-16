import { describe, expect, it } from "vitest";
import request from "supertest";
import { createProject, firstUserId, testApp } from "./helpers.js";

/** Shared timecard range control: the export is self-describing and matches the displayed range. */
describe("timecard range export", () => {
  it("names the file after the requested range", async () => {
    const app = testApp();
    const res = await request(app).get("/api/export/timelogs.csv?start=2026-07-13&end=2026-07-19");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="timecard-2026-07-13-to-2026-07-19.csv"');
  });

  it("falls back to the generic name without a full valid range", async () => {
    const app = testApp();
    for (const qs of ["", "?start=2026-07-13", "?start=bogus&end=2026-07-19"]) {
      const res = await request(app).get(`/api/export/timelogs.csv${qs}`);
      expect(res.headers["content-disposition"]).toContain('filename="time-entries.csv"');
    }
  });

  it("exports exactly the requested range, inclusive on both ends", async () => {
    const app = testApp();
    const p = await createProject(app);
    const uid = firstUserId();
    for (const [date, hours] of [["2026-06-30", 1], ["2026-07-01", 2], ["2026-07-31", 3], ["2026-08-01", 4]] as const) {
      const r = await request(app).post("/api/timelogs").send({ project_id: p.id, user_id: uid, date, hours, minutes: 0 });
      expect(r.status).toBe(201);
    }
    const res = await request(app).get("/api/export/timelogs.csv?start=2026-07-01&end=2026-07-31");
    expect(res.text).toContain("2026-07-01");
    expect(res.text).toContain("2026-07-31");
    expect(res.text).not.toContain("2026-06-30");
    expect(res.text).not.toContain("2026-08-01");
  });
});
