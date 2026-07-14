import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "cat.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  dashboard_scope TEXT NOT NULL DEFAULT 'mine',  -- 'mine' | 'all' — per-user dashboard filter
  default_assignee_filter TEXT,                  -- null = match dashboard default | 'all' = everyone | user id
  show_configuration INTEGER NOT NULL DEFAULT 1  -- whether the Configuration page is visible to this user
);

CREATE TABLE IF NOT EXISTS picklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,        -- e.g. 'Project Status'
  object_type TEXT NOT NULL,        -- 'project' | 'task' | 'time_log' | 'activity'
  is_system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS picklist_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  picklist_id INTEGER NOT NULL REFERENCES picklists(id),
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#64748B',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  maps_to TEXT                      -- stable system key for board/business logic
);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  due_offset INTEGER NOT NULL DEFAULT 7,      -- days after assignment date
  default_priority_id INTEGER REFERENCES picklist_values(id),
  can_edit INTEGER NOT NULL DEFAULT 1,
  can_skip INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_code TEXT NOT NULL UNIQUE,          -- auto-generated e.g. CAP-0001
  mcp_number TEXT NOT NULL,
  mcp_name TEXT NOT NULL,
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  annualized_premium REAL,                    -- Annualized Premium (AP) in dollars; required at creation
  assignment_date TEXT NOT NULL,
  target_date TEXT,
  template_id INTEGER NOT NULL REFERENCES workflow_templates(id),
  status_id INTEGER NOT NULL REFERENCES picklist_values(id),
  risk_level_id INTEGER REFERENCES picklist_values(id),
  rag_override TEXT,                          -- 'red'|'amber'|'green' when manually overridden
  rag_override_reason TEXT,
  status_changed_date TEXT NOT NULL DEFAULT (datetime('now')),
  created_date TEXT NOT NULL DEFAULT (datetime('now')),
  closed_date TEXT,
  closed_by INTEGER REFERENCES users(id),
  close_reason_id INTEGER REFERENCES picklist_values(id),
  final_summary TEXT
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_task_id INTEGER REFERENCES template_tasks(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'standard', -- 'standard' | 'adhoc' | 'action_plan'
  step_order INTEGER NOT NULL DEFAULT 0,
  assigned_to INTEGER REFERENCES users(id),
  due_date TEXT,
  status_id INTEGER NOT NULL REFERENCES picklist_values(id),
  priority_id INTEGER REFERENCES picklist_values(id),
  required INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  skip_reason TEXT,
  completed_date TEXT,
  completed_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_task_id INTEGER REFERENCES project_tasks(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  hours INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0,
  activity_type_id INTEGER REFERENCES picklist_values(id),
  notes TEXT DEFAULT '',
  created_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_task_id INTEGER REFERENCES project_tasks(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id),
  activity_date TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL DEFAULT 'note',          -- 'note' | 'activity' | 'status_change' | 'system'
  category_id INTEGER REFERENCES picklist_values(id),
  activity_type_id INTEGER REFERENCES picklist_values(id), -- kind='activity': Phone Call / Site Visit / …
  start_time TEXT,                            -- 'HH:MM' (kind='activity')
  end_time TEXT,                              -- 'HH:MM' (kind='activity')
  note TEXT DEFAULT '',
  old_status TEXT,
  new_status TEXT
);

-- v2: many-to-many links between activities and project tasks
CREATE TABLE IF NOT EXISTS task_activity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_task_id INTEGER NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  UNIQUE(project_task_id, activity_id)
);

-- v2: structured wins, loggable at any point in a project's lifecycle.
-- projects.final_summary stays as the separate closure narrative.
CREATE TABLE IF NOT EXISTS wins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  category_id INTEGER REFERENCES picklist_values(id),
  occurred_date TEXT NOT NULL,
  logged_date TEXT NOT NULL DEFAULT (datetime('now')),
  logged_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS field_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL,                  -- 'project' | 'task'
  field_name TEXT NOT NULL,
  label TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,       -- system fields: locked, always required
  required INTEGER NOT NULL DEFAULT 0,
  required_at TEXT NOT NULL DEFAULT 'creation', -- 'creation' | 'always' | 'closure'
  UNIQUE(object_type, field_name)
);

CREATE TABLE IF NOT EXISTS view_layout_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  view_name TEXT NOT NULL,                    -- 'portfolio_card' | 'task_card' | 'project_list' | 'task_list' | 'project_header'
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  is_locked INTEGER NOT NULL DEFAULT 0,
  UNIQUE(view_name, field_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Admin-defined project fields (no code change needed). Dropdown options live in
-- the standard picklist system so option management reuses Picklists & Values.
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL DEFAULT 'project',
  label TEXT NOT NULL,
  field_key TEXT NOT NULL UNIQUE,             -- 'cf_' + slug, stable across renames
  field_type TEXT NOT NULL,                   -- 'text' | 'number' | 'currency' | 'date' | 'dropdown' | 'checkbox'
  picklist_id INTEGER REFERENCES picklists(id), -- dropdown only
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_custom_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT,                                 -- canonical text: number/currency decimal, date ISO, checkbox '1'/'0', dropdown picklist_value id
  UNIQUE(project_id, field_id)
);
`);

// ---- v2 upgrade migrations (safe no-ops on fresh databases) ----

function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("activities", "activity_type_id", "INTEGER REFERENCES picklist_values(id)");
ensureColumn("activities", "start_time", "TEXT");
ensureColumn("activities", "end_time", "TEXT");
ensureColumn("users", "dashboard_scope", "TEXT NOT NULL DEFAULT 'mine'");
ensureColumn("users", "default_assignee_filter", "TEXT");
ensureColumn("users", "show_configuration", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("projects", "annualized_premium", "REAL");

// Decision-point mechanism removed: databases seeded before the removal may
// still hold hidden conditional tasks (conditional_pending = 1). They were
// never activated, so they're deleted; the legacy columns themselves stay on
// old databases where their defaults are harmless.
{
  const cols = db.prepare("PRAGMA table_info(project_tasks)").all() as { name: string }[];
  if (cols.some((c) => c.name === "conditional_pending"))
    db.prepare("DELETE FROM project_tasks WHERE conditional_pending = 1").run();
}

// "Target Date" is now displayed as "Estimated Completion Date" (field key unchanged)
db.prepare("UPDATE field_requirements SET label = 'Estimated Completion Date' WHERE field_name = 'target_date' AND label = 'Target Date'").run();
db.prepare("UPDATE view_layout_fields SET label = 'Estimated Completion Date' WHERE field_key = 'target_date' AND label = 'Target Date'").run();

db.exec(`
CREATE INDEX IF NOT EXISTS idx_activities_task_date ON activities(project_task_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_task_activity_links_task ON task_activity_links(project_task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_links_activity ON task_activity_links(activity_id);
CREATE INDEX IF NOT EXISTS idx_wins_project ON wins(project_id);
CREATE INDEX IF NOT EXISTS idx_project_custom_values_project ON project_custom_values(project_id);
`);

/** Config a v1-seeded database is missing. Fresh installs get all of this from seed.ts. */
export function ensureV2Config() {
  const seeded = (db.prepare("SELECT COUNT(*) AS n FROM picklists").get() as { n: number }).n > 0;
  if (!seeded) return;

  const addList = (name: string, objectType: string, values: [string, string, string, number?][]) => {
    const exists = db.prepare("SELECT id FROM picklists WHERE name = ?").get(name);
    if (exists) return;
    const pid = db.prepare("INSERT INTO picklists (name, object_type, is_system) VALUES (?, ?, 0)").run(name, objectType)
      .lastInsertRowid as number;
    values.forEach(([label, color, mapsTo, isDefault], i) =>
      db.prepare(
        "INSERT INTO picklist_values (picklist_id, label, sort_order, color, is_active, is_default, maps_to) VALUES (?, ?, ?, ?, 1, ?, ?)"
      ).run(pid, label, i + 1, color, isDefault ?? 0, mapsTo)
    );
  };
  addList("Activity Type", "activity", [
    ["Phone Call", "#12808A", "phone_call", 1],
    ["Site Visit", "#2E4E8F", "site_visit"],
    ["Client Meeting", "#8A6FB8", "client_meeting"],
    ["Other Customer Interaction", "#5C6B84", "other"],
  ]);
  addList("Win Category", "win", [
    ["Cost Savings", "#4E9468", "cost_savings", 1],
    ["Process Improvement", "#12808A", "process_improvement"],
    ["Relationship Recovery", "#8A6FB8", "relationship_recovery"],
    ["Escalation Resolved", "#C99239", "escalation_resolved"],
  ]);

  const hasTaskListLayout =
    (db.prepare("SELECT COUNT(*) AS n FROM view_layout_fields WHERE view_name = 'task_list'").get() as { n: number }).n > 0;
  const hasActivityCol = db
    .prepare("SELECT id FROM view_layout_fields WHERE view_name = 'task_list' AND field_key = 'activity_count'")
    .get();
  if (hasTaskListLayout && !hasActivityCol) {
    const max = db
      .prepare("SELECT MAX(display_order) AS m FROM view_layout_fields WHERE view_name = 'task_list'")
      .get() as { m: number | null };
    db.prepare(
      "INSERT INTO view_layout_fields (view_name, field_key, label, display_order, is_visible, is_locked) VALUES ('task_list', 'activity_count', 'Activities', ?, 1, 0)"
    ).run((max.m ?? 0) + 1);
  }

  // Leader user: dashboard defaults to Show All, no default assignee filter,
  // so every view opens unfiltered for them.
  const hasLeader = db
    .prepare("SELECT id FROM users WHERE name = 'Leader' OR email = 'leader@example.com'")
    .get();
  if (!hasLeader)
    db.prepare("INSERT INTO users (name, email, dashboard_scope) VALUES ('Leader', 'leader@example.com', 'all')").run();

  // Annualized Premium (AP): system-required project field with a column/card/header slot on every surface
  db.prepare(
    `INSERT OR IGNORE INTO field_requirements (object_type, field_name, label, is_system, required, required_at)
     VALUES ('project', 'annualized_premium', 'Annualized Premium (AP)', 1, 1, 'always')`
  ).run();
  for (const view of ["project_list", "portfolio_card", "project_header"]) {
    const has = db
      .prepare("SELECT id FROM view_layout_fields WHERE view_name = ? AND field_key = 'annualized_premium'")
      .get(view);
    if (!has) {
      const max = db
        .prepare("SELECT MAX(display_order) AS m FROM view_layout_fields WHERE view_name = ?")
        .get(view) as { m: number | null };
      db.prepare(
        "INSERT INTO view_layout_fields (view_name, field_key, label, display_order, is_visible, is_locked) VALUES (?, 'annualized_premium', 'AP', ?, 1, 0)"
      ).run(view, (max.m ?? 0) + 1);
    }
  }
}
ensureV2Config();

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function getSettingNum(key: string, fallback: number): number {
  const n = Number(getSetting(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}
