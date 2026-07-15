/**
 * Shared test bootstrap: an in-memory database (ACCIO_DB_PATH=:memory:, set in
 * vitest.config.ts) seeded with the default configuration, plus a fresh app.
 */
import type { Express } from "express";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { seed } from "../src/seedData.js";

let seeded = false;

/** Seed default config (no demo data) once per test file / worker. */
export function testApp(extraRoutes?: (app: Express) => void): Express {
  if (!seeded) {
    seed({ demo: false });
    seeded = true;
  }
  return buildApp(extraRoutes);
}

export { db };

export function valueId(picklist: string, mapsTo: string): number {
  const row = db
    .prepare(
      `SELECT pv.id FROM picklist_values pv JOIN picklists p ON p.id = pv.picklist_id
       WHERE p.name = ? AND pv.maps_to = ?`
    )
    .get(picklist, mapsTo) as { id: number } | undefined;
  if (!row) throw new Error(`No picklist value ${picklist}/${mapsTo}`);
  return row.id;
}

export function firstUserId(): number {
  return (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number }).id;
}

export function defaultTemplateId(): number {
  return (db.prepare("SELECT id FROM workflow_templates WHERE is_default = 1").get() as { id: number }).id;
}

let mcpCounter = 0;

/** Create a project through the API; returns the serialized project. */
export async function createProject(app: Express, overrides: Record<string, unknown> = {}) {
  const request = (await import("supertest")).default;
  const res = await request(app)
    .post("/api/projects")
    .send({
      mcp_number: `MCP-T${++mcpCounter}`,
      mcp_name: `Test Customer ${mcpCounter}`,
      assignee_id: firstUserId(),
      annualized_premium: 1000,
      assignment_date: "2026-01-10",
      template_id: defaultTemplateId(),
      user_id: firstUserId(),
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`createProject failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}
