import { Router } from "express";
import { db } from "../db.js";
import {
  CLOSED_KEYS, CustomField, activeCustomFields, customCsvValue, fmtCurrency, generateTasksFromTemplate,
  logActivity, nextProjectCode, parseCurrency, parseCustomValue, saveCustomValues, serializeProject, serializeWin,
  valueByMapsTo, valuesFor,
} from "../core.js";

export const importexport = Router();

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}
function sendCsv(res: any, filename: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

importexport.get("/export/projects.csv", (req, res) => {
  const scope = req.query.scope as string | undefined;
  let projects = (db.prepare("SELECT * FROM projects ORDER BY created_date").all() as any[]).map((p) => serializeProject(p));
  if (scope === "active") projects = projects.filter((p) => !p.is_closed);
  if (scope === "closed") projects = projects.filter((p) => p.is_closed);
  const customFields = activeCustomFields();
  const csv = toCsv(
    ["Project ID", "MCP #", "MCP Name", "Assignee", "AP", "Assignment Date", "Status", "RAG", "Risk", "Open Tasks", "Created", "Closed", "Close Reason", ...customFields.map((f) => f.label)],
    projects.map((p) => [
      p.project_code, p.mcp_number, p.mcp_name, p.assignee_name, fmtCurrency(p.annualized_premium), p.assignment_date,
      p.status_label, p.rag.toUpperCase(), p.risk_label ?? "", p.open_task_count, p.created_date, p.closed_date ?? "", p.close_reason_label ?? "",
      ...customFields.map((f) => customCsvValue(p.custom?.[f.field_key])),
    ])
  );
  sendCsv(res, "projects.csv", csv);
});

importexport.get("/export/timelogs.csv", (req, res) => {
  const { start, end, user_id } = req.query as Record<string, string>;
  let sql = `SELECT tl.*, u.name AS user_name, p.project_code, p.mcp_name FROM time_logs tl
             JOIN users u ON u.id = tl.user_id JOIN projects p ON p.id = tl.project_id WHERE 1=1`;
  const params: any[] = [];
  if (start) { sql += " AND tl.date >= ?"; params.push(start); }
  if (end) { sql += " AND tl.date <= ?"; params.push(end); }
  if (user_id) { sql += " AND tl.user_id = ?"; params.push(Number(user_id)); }
  sql += " ORDER BY tl.date";
  const rows = db.prepare(sql).all(...params) as any[];
  const csv = toCsv(
    ["Date", "User", "Project ID", "MCP Name", "Task", "Hours", "Minutes", "Activity Type", "Notes"],
    rows.map((r) => {
      const task = r.project_task_id ? (db.prepare("SELECT name FROM project_tasks WHERE id = ?").get(r.project_task_id) as any) : null;
      const act = r.activity_type_id ? (db.prepare("SELECT label FROM picklist_values WHERE id = ?").get(r.activity_type_id) as any) : null;
      return [r.date, r.user_name, r.project_code, r.mcp_name, task?.name ?? "", r.hours, r.minutes, act?.label ?? "", r.notes];
    })
  );
  sendCsv(res, "time-entries.csv", csv);
});

/**
 * Portfolio-wide structured wins export (v2 §3) — every win across every
 * project, filterable by occurred-date range (?start=&end=).
 */
importexport.get("/export/wins.csv", (req, res) => {
  const { start, end } = req.query as Record<string, string>;
  let sql = "SELECT * FROM wins WHERE 1=1";
  const params: any[] = [];
  if (start) { sql += " AND occurred_date >= ?"; params.push(start); }
  if (end) { sql += " AND occurred_date <= ?"; params.push(end); }
  sql += " ORDER BY occurred_date DESC, id DESC";
  const rows = (db.prepare(sql).all(...params) as any[]).map(serializeWin);
  const csv = toCsv(
    ["Occurred", "Logged", "Project ID", "MCP #", "MCP Name", "AP", "Category", "Win", "Logged By"],
    rows.map((w) => [w.occurred_date, w.logged_date?.slice(0, 10) ?? "", w.project_code, w.mcp_number, w.mcp_name, fmtCurrency(w.annualized_premium), w.category_label ?? "", w.description, w.logged_by_name ?? ""])
  );
  sendCsv(res, "wins-report.csv", csv);
});

/** Closure report — the v1 "wins" export, now clearly named: closure summaries of closed projects (§8). */
importexport.get("/export/closures.csv", (_req, res) => {
  const closedIds = valuesFor("Project Status").filter((v) => CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const rows = (db
    .prepare(`SELECT * FROM projects WHERE status_id IN (${closedIds.map(() => "?").join(",")}) ORDER BY closed_date`)
    .all(...closedIds) as any[]).map((p) => serializeProject(p));
  const csv = toCsv(
    ["Project ID", "MCP #", "MCP Name", "Assignee", "Assigned", "Closed", "Closed By", "Close Reason", "Final Summary"],
    rows.map((p) => [p.project_code, p.mcp_number, p.mcp_name, p.assignee_name, p.assignment_date, p.closed_date ?? "", p.closed_by_name ?? "", p.close_reason_label ?? "", p.final_summary ?? ""])
  );
  sendCsv(res, "closure-report.csv", csv);
});

// ---------- CSV import of projects with validation + preview (§8) ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

interface ImportRow {
  line: number;
  mcp_number: string;
  mcp_name: string;
  assignee: string;
  annualized_premium: number | null;
  assignment_date: string;
  template: string;
  errors: string[];
  assignee_id?: number;
  template_id?: number;
  custom: Record<string, string | null>; // parsed { field_key: canonical value }
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function validateImport(csvText: string): { rows: ImportRow[]; headerError?: string } {
  const raw = parseCsv(csvText);
  if (!raw.length) return { rows: [], headerError: "File is empty" };
  const header = raw[0].map(normalizeHeader);
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iMcp = col(["mcp_number", "mcp_", "mcp"]);
  const iName = col(["mcp_name", "customer", "customer_name"]);
  const iAssignee = col(["assignee", "assignee_name", "assigned_to"]);
  const iAp = col(["ap", "annualized_premium", "annualized_premium_ap", "annual_premium"]);
  const iDate = col(["assignment_date", "assigned", "date"]);
  const iTpl = col(["template", "template_name", "workflow_template"]);
  if (iMcp < 0 || iName < 0)
    return { rows: [], headerError: "Header must include at least 'MCP Number' and 'MCP Name' columns (plus 'AP'; optional: Assignee, Assignment Date, Template)" };

  const users = db.prepare("SELECT * FROM users").all() as any[];
  const templates = db.prepare("SELECT * FROM workflow_templates WHERE is_active = 1").all() as any[];
  const defaultTpl = templates.find((t) => t.is_default) ?? templates[0];
  const activeIds = valuesFor("Project Status").filter((v) => !CLOSED_KEYS.includes(v.maps_to ?? "")).map((v) => v.id);
  const seen = new Set<string>();
  // Custom-field columns match by label or field_key, so exports round-trip
  const customCols: [CustomField, number][] = activeCustomFields()
    .map((f): [CustomField, number] => [f, col([normalizeHeader(f.label), f.field_key])])
    .filter(([, i]) => i >= 0);

  const rows: ImportRow[] = raw.slice(1).map((r, idx) => {
    const row: ImportRow = {
      line: idx + 2,
      mcp_number: (r[iMcp] ?? "").trim(),
      mcp_name: (r[iName] ?? "").trim(),
      assignee: iAssignee >= 0 ? (r[iAssignee] ?? "").trim() : "",
      annualized_premium: null,
      assignment_date: iDate >= 0 ? (r[iDate] ?? "").trim() : "",
      template: iTpl >= 0 ? (r[iTpl] ?? "").trim() : "",
      errors: [],
      custom: {},
    };
    if (!row.mcp_number) row.errors.push("MCP # is required");
    if (!row.mcp_name) row.errors.push("MCP Name is required");
    if (row.mcp_number) {
      if (seen.has(row.mcp_number)) row.errors.push("Duplicate MCP # within this file");
      seen.add(row.mcp_number);
      const dup = db
        .prepare(`SELECT project_code FROM projects WHERE mcp_number = ? AND status_id IN (${activeIds.map(() => "?").join(",")})`)
        .get(row.mcp_number, ...activeIds) as any;
      if (dup) row.errors.push(`MCP already has an active project (${dup.project_code})`);
    }
    if (row.assignee) {
      const u = users.find((u) => u.name.toLowerCase() === row.assignee.toLowerCase() || u.email.toLowerCase() === row.assignee.toLowerCase());
      if (!u) row.errors.push(`Unknown assignee "${row.assignee}"`);
      else row.assignee_id = u.id;
    } else row.errors.push("Assignee is required");
    // AP is required on every project — same rule as the create form
    const apRaw = iAp >= 0 ? (r[iAp] ?? "").trim() : "";
    if (!apRaw) row.errors.push("Annualized Premium (AP) is required");
    else {
      const n = parseCurrency(apRaw);
      if (n == null || !Number.isFinite(n) || n < 0) row.errors.push(`Invalid AP "${apRaw}" — use a dollar amount like 12500 or $12,500.00`);
      else row.annualized_premium = n;
    }
    if (row.assignment_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.assignment_date))
      row.errors.push("Assignment date must be YYYY-MM-DD");
    if (!row.assignment_date) row.assignment_date = new Date().toISOString().slice(0, 10);
    if (row.template) {
      const t = templates.find((t) => t.name.toLowerCase() === row.template.toLowerCase());
      if (!t) row.errors.push(`Unknown template "${row.template}"`);
      else row.template_id = t.id;
    } else row.template_id = defaultTpl?.id;
    for (const [f, i] of customCols) {
      const parsed = parseCustomValue(f, r[i]);
      if (parsed.ok) row.custom[f.field_key] = parsed.value;
      else row.errors.push(parsed.error);
    }
    return row;
  });
  return { rows };
}

importexport.post("/import/projects/preview", (req, res) => {
  const { csv } = req.body as { csv: string };
  if (!csv?.trim()) return res.status(400).json({ error: "No CSV content provided" });
  const { rows, headerError } = validateImport(csv);
  if (headerError) return res.status(400).json({ error: headerError });
  res.json({ rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length });
});

importexport.post("/import/projects/commit", (req, res) => {
  const { csv, user_id } = req.body as { csv: string; user_id: number };
  const { rows, headerError } = validateImport(csv ?? "");
  if (headerError) return res.status(400).json({ error: headerError });
  const valid = rows.filter((r) => !r.errors.length && r.assignee_id && r.template_id);
  const statusNew = valueByMapsTo("Project Status", "new")!;
  const created: string[] = [];
  const fieldIdByKey = new Map(activeCustomFields().map((f) => [f.field_key, f.id]));
  const run = db.transaction(() => {
    for (const r of valid) {
      const code = nextProjectCode();
      const pid = db
        .prepare(
          `INSERT INTO projects (project_code, mcp_number, mcp_name, assignee_id, annualized_premium, assignment_date, template_id, status_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(code, r.mcp_number, r.mcp_name, r.assignee_id, r.annualized_premium, r.assignment_date, r.template_id, statusNew.id)
        .lastInsertRowid as number;
      const parsed = new Map<number, string | null>();
      for (const [key, value] of Object.entries(r.custom)) {
        const fid = fieldIdByKey.get(key);
        if (fid) parsed.set(fid, value);
      }
      saveCustomValues(pid, parsed);
      generateTasksFromTemplate(pid, r.template_id!, r.assignment_date, r.assignee_id ?? null);
      logActivity({ project_id: pid, user_id, kind: "system", note: `Project ${code} created via CSV import` });
      created.push(code);
    }
  });
  run();
  res.json({ created: created.length, skipped: rows.length - valid.length, codes: created });
});
