/**
 * In-browser data store for the standalone single-file demo build.
 * Mirrors the SQLite schema in server/src/db.ts; data persists to
 * localStorage so demo changes survive a reload.
 */

export interface Row {
  id: number;
  [k: string]: any;
}
export interface DemoDB {
  users: Row[];
  picklists: Row[];
  picklist_values: Row[];
  workflow_templates: Row[];
  template_tasks: Row[];
  projects: Row[];
  project_tasks: Row[];
  time_logs: Row[];
  activities: Row[];
  task_activity_links: Row[];
  wins: Row[];
  field_requirements: Row[];
  view_layout_fields: Row[];
  settings: Record<string, string>;
  seq: number;
}

// v2 bump: adds wins + task_activity_links; older stored v1 data reseeds fresh
const STORE_KEY = "cat_demo_db_v2";

export let db: DemoDB = emptyDb();
{
  const loaded = load();
  if (loaded) db = loaded;
  else freshDb();
}

export function nextId(): number {
  return ++db.seq;
}

export function now(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* storage unavailable (some file:// setups) — demo still works in-memory */
  }
}

export function resetDemoData() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
  freshDb();
}

function load(): DemoDB | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const loaded = raw ? (JSON.parse(raw) as DemoDB) : null;
    // upgrade stored v2 data: users saved before the per-user settings existed
    if (loaded) {
      for (const u of loaded.users) {
        u.dashboard_scope ??= "mine";
        u.default_assignee_filter ??= null;
        u.show_configuration ??= 1;
      }
      if (!loaded.users.some((u) => u.name === "Leader" || u.email === "leader@example.com"))
        loaded.users.push({
          id: ++loaded.seq, name: "Leader", email: "leader@example.com", is_active: 1,
          dashboard_scope: "all", default_assignee_filter: null, show_configuration: 1,
        });
    }
    return loaded;
  } catch {
    return null;
  }
}

function emptyDb(): DemoDB {
  return {
    users: [], picklists: [], picklist_values: [], workflow_templates: [], template_tasks: [],
    projects: [], project_tasks: [], time_logs: [], activities: [], task_activity_links: [], wins: [],
    field_requirements: [], view_layout_fields: [], settings: {}, seq: 0,
  };
}

// ---------------- helpers shared with backend ----------------

export function valuesFor(picklistName: string): Row[] {
  const list = db.picklists.find((p) => p.name === picklistName);
  if (!list) return [];
  return db.picklist_values
    .filter((v) => v.picklist_id === list.id)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}
export function valueByMapsTo(picklistName: string, mapsTo: string): Row | undefined {
  return valuesFor(picklistName).find((v) => v.maps_to === mapsTo);
}
export function valueById(id: number | null | undefined): Row | undefined {
  if (id == null) return undefined;
  return db.picklist_values.find((v) => v.id === id);
}

export function logActivity(opts: {
  project_id: number; project_task_id?: number | null; user_id?: number | null;
  kind?: string; category_id?: number | null; note?: string;
  old_status?: string | null; new_status?: string | null; activity_date?: string;
  activity_type_id?: number | null; start_time?: string | null; end_time?: string | null;
}): Row {
  const row: Row = {
    id: nextId(),
    project_id: opts.project_id,
    project_task_id: opts.project_task_id ?? null,
    user_id: opts.user_id ?? null,
    activity_date: opts.activity_date ?? now(),
    kind: opts.kind ?? "note",
    category_id: opts.category_id ?? null,
    activity_type_id: opts.activity_type_id ?? null,
    start_time: opts.start_time ?? null,
    end_time: opts.end_time ?? null,
    note: opts.note ?? "",
    old_status: opts.old_status ?? null,
    new_status: opts.new_status ?? null,
  };
  db.activities.push(row);
  return row;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Snapshot the template into project tasks (conditional tasks hidden until the decision). */
export function generateTasksFromTemplate(projectId: number, templateId: number, assignmentDate: string) {
  const notStarted = valueByMapsTo("Task Status", "not_started")!;
  const tasks = db.template_tasks
    .filter((t) => t.template_id === templateId)
    .sort((a, b) => a.step_order - b.step_order);
  for (const t of tasks) {
    const conditional = t.generation === "action_plan" ? 1 : 0;
    db.project_tasks.push({
      id: nextId(),
      project_id: projectId,
      template_task_id: t.id,
      name: t.name,
      description: t.description ?? "",
      task_type: conditional ? "action_plan" : "standard",
      step_order: t.step_order,
      assigned_to: null,
      due_date: conditional ? null : addDays(assignmentDate, t.due_offset),
      status_id: notStarted.id,
      priority_id: t.default_priority_id ?? null,
      required: t.required,
      is_decision: t.is_decision,
      conditional_pending: conditional,
      notes: "",
      skip_reason: null,
      completed_date: null,
      completed_by: null,
    });
  }
}

// ---------------- seed (port of server/src/seed.ts) ----------------

function iso(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Rebuilds the global db in place with default config + demo data. */
function freshDb(): void {
  db = emptyDb();

  function makeList(name: string, objectType: string, isSystem: number,
    values: [string, string, string | null, number?][]) {
    const pid = nextId();
    db.picklists.push({ id: pid, name, object_type: objectType, is_system: isSystem });
    values.forEach(([label, color, mapsTo, isDefault], i) =>
      db.picklist_values.push({
        id: nextId(), picklist_id: pid, label, sort_order: i + 1, color,
        is_active: 1, is_default: isDefault ?? 0, maps_to: mapsTo,
      })
    );
  }

  makeList("Project Status", "project", 1, [
    ["New", "#5C6B84", "new", 1], ["Assigned", "#2E4E8F", "assigned"], ["In Progress", "#12808A", "in_progress"],
    ["Pending Customer", "#C99239", "pending_customer"], ["Pending Internal", "#8A6FB8", "pending_internal"],
    ["Action Plan Needed", "#C2554E", "action_plan_needed"], ["Action Plan In Progress", "#B0632F", "action_plan_in_progress"],
    ["Ready to Close", "#4E9468", "ready_to_close"], ["Closed", "#3B4A63", "closed"], ["Cancelled", "#94A3B8", "cancelled"],
  ]);
  makeList("Task Status", "task", 1, [
    ["Not Started", "#5C6B84", "not_started", 1], ["In Progress", "#12808A", "in_progress"],
    ["Blocked", "#C2554E", "blocked"], ["Complete", "#4E9468", "complete"],
    ["Skipped", "#94A3B8", "skipped"], ["Cancelled", "#94A3B8", "cancelled"],
  ]);
  makeList("RAG Status", "project", 1, [
    ["Red", "#C2554E", "red"], ["Amber", "#C99239", "amber"], ["Green", "#4E9468", "green", 1],
  ]);
  makeList("Risk Level", "project", 0, [
    ["Low", "#4E9468", "low", 1], ["Medium", "#C99239", "medium"], ["High", "#B0632F", "high"], ["Critical", "#C2554E", "critical"],
  ]);
  makeList("Task Priority", "task", 0, [
    ["Low", "#94A3B8", "low"], ["Medium", "#C99239", "medium", 1], ["High", "#C2554E", "high"],
  ]);
  makeList("Close Reason", "project", 0, [
    ["Billing Improved", "#4E9468", "billing_improved", 1], ["Issue Resolved", "#4E9468", "issue_resolved"],
    ["No Further Action Needed", "#5C6B84", "no_action"], ["Customer Unresponsive", "#C99239", "unresponsive"],
    ["Transferred / Escalated", "#8A6FB8", "escalated"], ["Cancelled", "#94A3B8", "cancelled"],
  ]);
  makeList("Note Category", "activity", 0, [
    ["General Update", "#5C6B84", "general", 1], ["Customer Contact", "#12808A", "customer_contact"],
    ["Billing Finding", "#2E4E8F", "billing_finding"], ["Internal Follow-Up", "#8A6FB8", "internal_followup"],
    ["Risk", "#C2554E", "risk"], ["Issue", "#B0632F", "issue"], ["Action Plan", "#C99239", "action_plan"],
    ["Resolution", "#4E9468", "resolution"],
  ]);
  makeList("Activity Type", "activity", 0, [
    ["Phone Call", "#12808A", "phone_call", 1], ["Site Visit", "#2E4E8F", "site_visit"],
    ["Client Meeting", "#8A6FB8", "client_meeting"], ["Other Customer Interaction", "#5C6B84", "other"],
  ]);
  makeList("Win Category", "win", 0, [
    ["Cost Savings", "#4E9468", "cost_savings", 1], ["Process Improvement", "#12808A", "process_improvement"],
    ["Relationship Recovery", "#8A6FB8", "relationship_recovery"], ["Escalation Resolved", "#C99239", "escalation_resolved"],
  ]);
  makeList("Time Log Activity Type", "time_log", 0, [
    ["Billing Analysis", "#2E4E8F", "billing_analysis", 1], ["Customer Visit", "#12808A", "customer_visit"],
    ["Internal Review", "#8A6FB8", "internal_review"], ["Action Plan Work", "#C99239", "action_plan"],
    ["Follow-Up", "#B0632F", "follow_up"], ["Documentation", "#5C6B84", "documentation"], ["Administrative", "#94A3B8", "admin"],
  ]);

  const users = [
    ["Morgan Hale", "morgan.hale@example.com", "mine"],
    ["Priya Raman", "priya.raman@example.com", "mine"],
    ["Devon Carter", "devon.carter@example.com", "mine"],
    ["Alex Kim", "alex.kim@example.com", "mine"],
    // Leader: dashboard defaults to Show All, no default assignee filter
    ["Leader", "leader@example.com", "all"],
  ].map(([name, email, scope]) => {
    const id = nextId();
    db.users.push({ id, name, email, is_active: 1, dashboard_scope: scope, default_assignee_filter: null, show_configuration: 1 });
    return id;
  });

  const prio = (key: string) => valueByMapsTo("Task Priority", key)!.id;
  const tplId = nextId();
  db.workflow_templates.push({
    id: tplId, name: "Standard MCP Engagement",
    description: "Default customer assignment workflow: analysis, visit, conditional action plan, closure.",
    is_default: 1, is_active: 1, created_by: users[0], created_date: now(),
  });

  const tts: [string, string, number, number, number, number, number, string][] = [
    ["Review customer billing history", "Pull and review the MCP's billing history for anomalies and trends.", 1, 5, prio("high"), 0, 0, "standard"],
    ["Complete billing analysis", "Full billing analysis with documented findings.", 1, 10, prio("high"), 0, 0, "standard"],
    ["Schedule / complete customer visit", "Arrange and complete the on-site or remote customer visit.", 1, 14, prio("high"), 1, 0, "standard"],
    ["Identify billing concerns", "Document specific billing concerns discovered in analysis/visit.", 1, 16, prio("medium"), 1, 0, "standard"],
    ["Determine if action plan is needed", "Decision point: does this MCP need a formal action plan?", 1, 18, prio("medium"), 0, 1, "standard"],
    ["Create action plan tasks", "Define the concrete action plan steps with the customer.", 1, 21, prio("medium"), 0, 0, "action_plan"],
    ["Complete action plan follow-up", "Work the plan and confirm outcomes with the customer.", 1, 28, prio("medium"), 0, 0, "action_plan"],
    ["Final review", "Confirm the customer is in a better billing position; verify all work is documented.", 1, 30, prio("medium"), 0, 0, "standard"],
    ["Close project", "Enter final summary, select close reason, and close.", 1, 30, prio("medium"), 0, 0, "standard"],
  ];
  tts.forEach(([name, desc, required, due_offset, priorityId, can_skip, is_decision, generation], i) =>
    db.template_tasks.push({
      id: nextId(), template_id: tplId, step_order: i + 1, name, description: desc,
      required, due_offset, default_priority_id: priorityId, can_edit: 1, can_skip, is_decision, generation,
    })
  );

  const fr = (object_type: string, field_name: string, label: string, is_system: number, required: number, required_at: string) =>
    db.field_requirements.push({ id: nextId(), object_type, field_name, label, is_system, required, required_at });
  fr("project", "project_code", "Project ID", 1, 1, "always");
  fr("project", "mcp_number", "MCP #", 1, 1, "always");
  fr("project", "mcp_name", "MCP Name", 1, 1, "always");
  fr("project", "assignee_id", "Assignee", 1, 1, "always");
  fr("project", "assignment_date", "Assignment Date", 1, 1, "always");
  fr("project", "target_date", "Target Date", 0, 0, "creation");
  fr("project", "risk_level_id", "Risk Level", 0, 0, "creation");
  fr("project", "final_summary", "Final Summary", 0, 1, "closure");
  fr("project", "close_reason_id", "Close Reason", 0, 1, "closure");
  fr("task", "due_date", "Due Date", 0, 0, "creation");
  fr("task", "assigned_to", "Assigned To", 0, 0, "creation");
  fr("task", "priority_id", "Priority", 0, 0, "creation");

  const layouts: Record<string, [string, string, number, number][]> = {
    portfolio_card: [
      ["mcp_name", "MCP Name", 1, 1], ["rag", "RAG", 1, 1], ["project_code", "Project ID", 1, 0],
      ["assignee_name", "Assignee", 1, 0], ["days_in_status", "Days in Status", 1, 0],
      ["next_due_task", "Next Due Task", 1, 0], ["risk_label", "Risk Level", 0, 0], ["mcp_number", "MCP #", 0, 0],
    ],
    task_card: [
      ["name", "Task Name", 1, 1], ["assigned_to_name", "Assigned To", 1, 0], ["due_date", "Due Date", 1, 0],
      ["required", "Required Flag", 1, 1], ["priority_label", "Priority", 1, 0], ["step_order", "Step #", 0, 0],
    ],
    project_list: [
      ["project_code", "Project ID", 1, 1], ["mcp_number", "MCP #", 1, 0], ["mcp_name", "MCP Name", 1, 1],
      ["assignee_name", "Assignee", 1, 0], ["status_label", "Status", 1, 1], ["rag", "RAG", 1, 0],
      ["risk_label", "Risk", 1, 0], ["assignment_date", "Assigned", 1, 0],
      ["days_in_status", "Days in Status", 0, 0], ["open_task_count", "Open Tasks", 1, 0],
    ],
    task_list: [
      ["step_order", "#", 1, 1], ["name", "Task Name", 1, 1], ["status_label", "Status", 1, 1],
      ["assigned_to_name", "Assigned To", 1, 0], ["due_date", "Due Date", 1, 0],
      ["priority_label", "Priority", 1, 0], ["required", "Required", 1, 0],
      ["activity_count", "Activities", 1, 0], ["task_type", "Type", 0, 0],
    ],
    project_header: [
      ["mcp_name", "MCP Name", 1, 1], ["mcp_number", "MCP #", 1, 1], ["project_code", "Project ID", 1, 1],
      ["status_label", "Status", 1, 1], ["rag", "RAG", 1, 1], ["assignee_name", "Assignee", 1, 0],
      ["assignment_date", "Assignment Date", 1, 0], ["target_date", "Target Date", 1, 0], ["risk_label", "Risk Level", 1, 0],
    ],
  };
  for (const [view, fields] of Object.entries(layouts)) {
    fields.forEach(([field_key, label, is_visible, is_locked], i) =>
      db.view_layout_fields.push({ id: nextId(), view_name: view, field_key, label, display_order: i + 1, is_visible, is_locked })
    );
  }

  db.settings = { rag_red_overdue_days: "3", rag_amber_due_days: "3", rag_stall_days: "7" };

  seedDemoProjects(users, tplId);
  save();
}

function seedDemoProjects(users: number[], tplId: number) {
  const status = (key: string) => valueByMapsTo("Project Status", key)!.id;
  const taskStatus = (key: string) => valueByMapsTo("Task Status", key)!.id;
  const risk = (key: string) => valueByMapsTo("Risk Level", key)!.id;
  const closeReason = (key: string) => valueByMapsTo("Close Reason", key)!.id;
  const noteCat = (key: string) => valueByMapsTo("Note Category", key)!.id;
  const actType = (key: string) => valueByMapsTo("Time Log Activity Type", key)!.id;

  type Demo = {
    mcp: [string, string]; assignee: number; assignedDaysAgo: number; status: string; risk: string;
    closed?: { daysAgo: number; reason: string; summary: string };
    completeThrough?: number; blockTask?: number;
    wins?: [string, string, number][];
  };
  const demos: Demo[] = [
    { mcp: ["MCP-1042", "Harborview Medical Group"], assignee: users[0], assignedDaysAgo: 21, status: "in_progress", risk: "high", completeThrough: 2, blockTask: 3,
      wins: [["Recovered $4,200 in misapplied charges found during the billing history review.", "cost_savings", 6]] },
    { mcp: ["MCP-2088", "Cedar Ridge Utilities"], assignee: users[1], assignedDaysAgo: 12, status: "in_progress", risk: "medium", completeThrough: 2,
      wins: [["Customer agreed to a monthly reconciliation cadence going forward.", "process_improvement", 4]] },
    { mcp: ["MCP-3110", "Lakeside Logistics"], assignee: users[0], assignedDaysAgo: 5, status: "assigned", risk: "low", completeThrough: 0 },
    { mcp: ["MCP-1544", "Summit Dental Partners"], assignee: users[2], assignedDaysAgo: 30, status: "action_plan_in_progress", risk: "critical", completeThrough: 5,
      wins: [["De-escalated the pending complaint; customer re-engaged with the action plan.", "escalation_resolved", 10]] },
    { mcp: ["MCP-4021", "Birchwood Manufacturing"], assignee: users[3], assignedDaysAgo: 3, status: "new", risk: "low" },
    { mcp: ["MCP-2760", "Fairfield Grocers Co-op"], assignee: users[1], assignedDaysAgo: 40, status: "ready_to_close", risk: "medium", completeThrough: 8,
      wins: [["Corrected rate class saves the co-op roughly $700/month going forward.", "cost_savings", 8]] },
    { mcp: ["MCP-0917", "Northgate Auto Group"], assignee: users[2], assignedDaysAgo: 75, status: "closed", risk: "medium", completeThrough: 9, closed: { daysAgo: 14, reason: "billing_improved", summary: "Corrected meter mapping and renegotiated billing cycle; customer now on accurate monthly invoicing with a 12% reduction in disputes." },
      wins: [["Rebuilt trust with the fleet manager after the disputed invoices were credited.", "relationship_recovery", 20], ["Meter remapping cut disputed line items by 12%.", "cost_savings", 16]] },
    { mcp: ["MCP-1203", "Elm Street Bakery"], assignee: users[0], assignedDaysAgo: 90, status: "closed", risk: "low", completeThrough: 9, closed: { daysAgo: 30, reason: "issue_resolved", summary: "Duplicate account consolidation completed; billing disputes resolved and no further action required." },
      wins: [["Consolidated duplicate accounts into a single clean billing record.", "process_improvement", 35]] },
  ];

  let n = 0;
  for (const d of demos) {
    n++;
    const code = `CAP-${String(n).padStart(4, "0")}`;
    const assigned = iso(d.assignedDaysAgo);
    const isClosed = !!d.closed;
    const pid = nextId();
    db.projects.push({
      id: pid, project_code: code, mcp_number: d.mcp[0], mcp_name: d.mcp[1],
      assignee_id: d.assignee, assignment_date: assigned, target_date: null,
      template_id: tplId, status_id: status(d.status), risk_level_id: risk(d.risk),
      rag_override: null, rag_override_reason: null,
      status_changed_date: iso(Math.min(d.assignedDaysAgo, isClosed ? d.closed!.daysAgo : Math.ceil(d.assignedDaysAgo / 3))) + " 09:00:00",
      created_date: assigned + " 09:00:00",
      closed_date: isClosed ? iso(d.closed!.daysAgo) : null,
      closed_by: isClosed ? d.assignee : null,
      close_reason_id: isClosed ? closeReason(d.closed!.reason) : null,
      final_summary: isClosed ? d.closed!.summary : null,
    });

    generateTasksFromTemplate(pid, tplId, assigned);
    logActivity({ project_id: pid, user_id: d.assignee, kind: "system", note: `Project ${code} created for ${d.mcp[1]}` });

    const completeN = d.completeThrough ?? 0;
    if (completeN >= 5 || isClosed) {
      for (const t of db.project_tasks) if (t.project_id === pid && t.conditional_pending) t.conditional_pending = 0;
    }
    const allTasks = db.project_tasks
      .filter((t) => t.project_id === pid && !t.conditional_pending)
      .sort((a, b) => a.step_order - b.step_order);

    let done = 0;
    for (const t of allTasks) {
      if (done < completeN || isClosed) {
        const when = iso(Math.max(1, d.assignedDaysAgo - 2 - done * 2));
        t.status_id = taskStatus("complete");
        t.completed_date = when;
        t.completed_by = d.assignee;
        logActivity({
          project_id: pid, project_task_id: t.id, user_id: d.assignee, kind: "status_change",
          note: `changed "${t.name}" from Not Started to Complete`, old_status: "Not Started", new_status: "Complete",
          category_id: noteCat("general"),
        });
        done++;
      } else if (d.blockTask && t.step_order === d.blockTask) {
        t.status_id = taskStatus("blocked");
        logActivity({
          project_id: pid, project_task_id: t.id, user_id: d.assignee, kind: "status_change",
          note: `changed "${t.name}" from Not Started to Blocked`, old_status: "Not Started", new_status: "Blocked",
          category_id: noteCat("issue"),
        });
      } else if (done === completeN && !isClosed && completeN > 0) {
        t.status_id = taskStatus("in_progress");
        done++;
      }
    }

    const noteSamples: [string, string][] = [
      ["customer_contact", `Spoke with billing contact at ${d.mcp[1]}; walked through recent invoices.`],
      ["billing_finding", "Found rate-class mismatch on two service points; quantifying impact."],
    ];
    for (const [cat, note] of noteSamples) {
      logActivity({ project_id: pid, user_id: d.assignee, kind: "note", category_id: noteCat(cat), note });
    }

    // v2: logged activities with times, many-to-many linked to tasks
    const actTypeId = (key: string) => valueByMapsTo("Activity Type", key)!.id;
    const link = (taskIdx: number, activityId: number) => {
      const t = allTasks[taskIdx];
      if (t) db.task_activity_links.push({ id: nextId(), project_task_id: t.id, activity_id: activityId });
    };
    const completeN2 = d.completeThrough ?? 0;
    if (!isClosed && completeN2 > 0) {
      const visit = logActivity({
        project_id: pid, user_id: d.assignee, kind: "activity", activity_type_id: actTypeId("site_visit"),
        activity_date: iso(3) + " 10:00:00", start_time: "10:00", end_time: "11:30",
        note: `On-site visit at ${d.mcp[1]} — walked the metering setup with facilities.`,
      });
      link(2, visit.id); link(3, visit.id);
      const call = logActivity({
        project_id: pid, user_id: d.assignee, kind: "activity", activity_type_id: actTypeId("phone_call"),
        activity_date: iso(0) + " 09:30:00", start_time: "09:30", end_time: "10:00",
        note: "Check-in call on outstanding billing questions.",
      });
      link(1, call.id);
      const meeting = logActivity({
        project_id: pid, user_id: d.assignee, kind: "activity", activity_type_id: actTypeId("client_meeting"),
        activity_date: iso(-(1 + (n % 3))) + " 14:00:00", start_time: "14:00", end_time: "15:00",
        note: "Review findings and agree next steps with the customer.",
      });
      link(4, meeting.id);
    }

    // v2: structured wins
    const winCatId = (key: string) => valueByMapsTo("Win Category", key)!.id;
    for (const [descr, catKey, daysAgo] of d.wins ?? []) {
      db.wins.push({
        id: nextId(), project_id: pid, description: descr, category_id: winCatId(catKey),
        occurred_date: iso(daysAgo), logged_date: iso(Math.max(0, daysAgo - 1)) + " 09:00:00", logged_by: d.assignee,
      });
    }

    const addLog = (project_task_id: number | null, date: string, hours: number, minutes: number, act: string, notes: string) =>
      db.time_logs.push({
        id: nextId(), project_id: pid, project_task_id, user_id: d.assignee, date,
        hours, minutes, activity_type_id: actType(act), notes, created_date: now(),
      });
    if (!isClosed) {
      const acts = ["billing_analysis", "customer_visit", "internal_review", "documentation"];
      for (let i = 0; i < 5; i++) {
        const daysAgo = (n + i * 2) % 12;
        addLog(allTasks[Math.min(i, allTasks.length - 1)].id, iso(daysAgo), 1 + ((n + i) % 3), (i % 2) * 30, acts[i % acts.length], i === 0 ? "Initial billing data pull" : "");
      }
      addLog(null, iso(1), 0, 45, "admin", "General customer call — no specific task");
    } else {
      addLog(allTasks[1]?.id ?? null, iso(d.closed!.daysAgo + 3), 3, 0, "billing_analysis", "");
      addLog(null, iso(d.closed!.daysAgo + 1), 1, 30, "documentation", "Closure documentation");
    }
  }
}
