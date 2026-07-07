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
  is_active INTEGER NOT NULL DEFAULT 1
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
  can_skip INTEGER NOT NULL DEFAULT 0,
  is_decision INTEGER NOT NULL DEFAULT 0,     -- 'Action Plan Needed?' decision point
  generation TEXT NOT NULL DEFAULT 'standard' -- 'standard' | 'action_plan' (conditional)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_code TEXT NOT NULL UNIQUE,          -- auto-generated e.g. CAP-0001
  mcp_number TEXT NOT NULL,
  mcp_name TEXT NOT NULL,
  assignee_id INTEGER NOT NULL REFERENCES users(id),
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
  is_decision INTEGER NOT NULL DEFAULT 0,
  conditional_pending INTEGER NOT NULL DEFAULT 0, -- snapshot of conditional template tasks, hidden until activated
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
  kind TEXT NOT NULL DEFAULT 'note',          -- 'note' | 'status_change' | 'system'
  category_id INTEGER REFERENCES picklist_values(id),
  note TEXT DEFAULT '',
  old_status TEXT,
  new_status TEXT
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
`);

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
