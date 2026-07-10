/**
 * Seeds default configuration (picklists, default workflow template, field
 * requirement rules, view layouts, RAG thresholds) and demo data.
 * Idempotent: skips seeding if picklists already exist. Run `npm run seed -- --reset`
 * to wipe and reseed.
 */
import { db } from "./db.js";
import { generateTasksFromTemplate, logActivity, valueByMapsTo, valuesFor } from "./core.js";

const RESET = process.argv.includes("--reset");

if (RESET) {
  db.exec(`
    DELETE FROM task_activity_links; DELETE FROM wins;
    DELETE FROM activities; DELETE FROM time_logs; DELETE FROM project_tasks;
    DELETE FROM projects; DELETE FROM template_tasks; DELETE FROM workflow_templates;
    DELETE FROM picklist_values; DELETE FROM picklists; DELETE FROM field_requirements;
    DELETE FROM view_layout_fields; DELETE FROM settings; DELETE FROM users;
    DELETE FROM sqlite_sequence;
  `);
}

const existing = db.prepare("SELECT COUNT(*) AS n FROM picklists").get() as { n: number };
if (existing.n > 0) {
  console.log("Database already seeded — run with --reset to wipe and reseed.");
  process.exit(0);
}

export function seed() {
  const insPicklist = db.prepare(
    "INSERT INTO picklists (name, object_type, is_system) VALUES (?, ?, ?)"
  );
  const insValue = db.prepare(
    `INSERT INTO picklist_values (picklist_id, label, sort_order, color, is_active, is_default, maps_to)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  );

  function makeList(
    name: string,
    objectType: string,
    isSystem: number,
    values: [label: string, color: string, mapsTo: string | null, isDefault?: number][]
  ) {
    const pid = insPicklist.run(name, objectType, isSystem).lastInsertRowid as number;
    values.forEach(([label, color, mapsTo, isDefault], i) =>
      insValue.run(pid, label, i + 1, color, isDefault ?? 0, mapsTo)
    );
    return pid;
  }

  // ---- Picklists (defaults per §4.1, 4.2, 4.5, 4.6, 4.7, 4.8) ----
  makeList("Project Status", "project", 1, [
    ["New", "#5C6B84", "new", 1],
    ["Assigned", "#2E4E8F", "assigned"],
    ["In Progress", "#12808A", "in_progress"],
    ["Pending Customer", "#C99239", "pending_customer"],
    ["Pending Internal", "#8A6FB8", "pending_internal"],
    ["Action Plan Needed", "#C2554E", "action_plan_needed"],
    ["Action Plan In Progress", "#B0632F", "action_plan_in_progress"],
    ["Ready to Close", "#4E9468", "ready_to_close"],
    ["Closed", "#3B4A63", "closed"],
    ["Cancelled", "#94A3B8", "cancelled"],
  ]);
  makeList("Task Status", "task", 1, [
    ["Not Started", "#5C6B84", "not_started", 1],
    ["In Progress", "#12808A", "in_progress"],
    ["Blocked", "#C2554E", "blocked"],
    ["Complete", "#4E9468", "complete"],
    ["Skipped", "#94A3B8", "skipped"],
    ["Cancelled", "#94A3B8", "cancelled"],
  ]);
  makeList("RAG Status", "project", 1, [
    ["Red", "#C2554E", "red"],
    ["Amber", "#C99239", "amber"],
    ["Green", "#4E9468", "green", 1],
  ]);
  makeList("Risk Level", "project", 0, [
    ["Low", "#4E9468", "low", 1],
    ["Medium", "#C99239", "medium"],
    ["High", "#B0632F", "high"],
    ["Critical", "#C2554E", "critical"],
  ]);
  makeList("Task Priority", "task", 0, [
    ["Low", "#94A3B8", "low"],
    ["Medium", "#C99239", "medium", 1],
    ["High", "#C2554E", "high"],
  ]);
  makeList("Close Reason", "project", 0, [
    ["Billing Improved", "#4E9468", "billing_improved", 1],
    ["Issue Resolved", "#4E9468", "issue_resolved"],
    ["No Further Action Needed", "#5C6B84", "no_action"],
    ["Customer Unresponsive", "#C99239", "unresponsive"],
    ["Transferred / Escalated", "#8A6FB8", "escalated"],
    ["Cancelled", "#94A3B8", "cancelled"],
  ]);
  makeList("Note Category", "activity", 0, [
    ["General Update", "#5C6B84", "general", 1],
    ["Customer Contact", "#12808A", "customer_contact"],
    ["Billing Finding", "#2E4E8F", "billing_finding"],
    ["Internal Follow-Up", "#8A6FB8", "internal_followup"],
    ["Risk", "#C2554E", "risk"],
    ["Issue", "#B0632F", "issue"],
    ["Action Plan", "#C99239", "action_plan"],
    ["Resolution", "#4E9468", "resolution"],
  ]);
  makeList("Activity Type", "activity", 0, [
    ["Phone Call", "#12808A", "phone_call", 1],
    ["Site Visit", "#2E4E8F", "site_visit"],
    ["Client Meeting", "#8A6FB8", "client_meeting"],
    ["Other Customer Interaction", "#5C6B84", "other"],
  ]);
  makeList("Win Category", "win", 0, [
    ["Cost Savings", "#4E9468", "cost_savings", 1],
    ["Process Improvement", "#12808A", "process_improvement"],
    ["Relationship Recovery", "#8A6FB8", "relationship_recovery"],
    ["Escalation Resolved", "#C99239", "escalation_resolved"],
  ]);
  makeList("Time Log Activity Type", "time_log", 0, [
    ["Billing Analysis", "#2E4E8F", "billing_analysis", 1],
    ["Customer Visit", "#12808A", "customer_visit"],
    ["Internal Review", "#8A6FB8", "internal_review"],
    ["Action Plan Work", "#C99239", "action_plan"],
    ["Follow-Up", "#B0632F", "follow_up"],
    ["Documentation", "#5C6B84", "documentation"],
    ["Administrative", "#94A3B8", "admin"],
  ]);

  // ---- Users ----
  const insUser = db.prepare("INSERT INTO users (name, email, dashboard_scope) VALUES (?, ?, ?)");
  const users = [
    ["Morgan Hale", "morgan.hale@example.com", "mine"],
    ["Priya Raman", "priya.raman@example.com", "mine"],
    ["Devon Carter", "devon.carter@example.com", "mine"],
    ["Alex Kim", "alex.kim@example.com", "mine"],
    // Leader: dashboard defaults to Show All and no default assignee filter,
    // so every view opens unfiltered
    ["Leader", "leader@example.com", "all"],
  ].map(([n, e, scope]) => insUser.run(n, e, scope).lastInsertRowid as number);

  // ---- Default workflow template (§4.3) ----
  const prio = (key: string) => valueByMapsTo("Task Priority", key)!.id;
  const tplId = db
    .prepare(
      `INSERT INTO workflow_templates (name, description, is_default, is_active, created_by)
       VALUES ('Standard MCP Engagement', 'Default customer assignment workflow: analysis, visit, conditional action plan, closure.', 1, 1, ?)`
    )
    .run(users[0]).lastInsertRowid as number;

  const insTT = db.prepare(
    `INSERT INTO template_tasks (template_id, step_order, name, description, required, due_offset,
       default_priority_id, can_edit, can_skip, is_decision, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tts: [string, string, number, number, number, number, number, number, string][] = [
    // name, description, required, due_offset, priority, can_skip, is_decision, ---, generation
    ["Review customer billing history", "Pull and review the MCP's billing history for anomalies and trends.", 1, 5, prio("high"), 0, 0, 1, "standard"],
    ["Complete billing analysis", "Full billing analysis with documented findings.", 1, 10, prio("high"), 0, 0, 1, "standard"],
    ["Schedule / complete customer visit", "Arrange and complete the on-site or remote customer visit.", 1, 14, prio("high"), 1, 0, 1, "standard"],
    ["Identify billing concerns", "Document specific billing concerns discovered in analysis/visit.", 1, 16, prio("medium"), 1, 0, 1, "standard"],
    ["Determine if action plan is needed", "Decision point: does this MCP need a formal action plan?", 1, 18, prio("medium"), 0, 1, 1, "standard"],
    ["Create action plan tasks", "Define the concrete action plan steps with the customer.", 1, 21, prio("medium"), 0, 0, 1, "action_plan"],
    ["Complete action plan follow-up", "Work the plan and confirm outcomes with the customer.", 1, 28, prio("medium"), 0, 0, 1, "action_plan"],
    ["Final review", "Confirm the customer is in a better billing position; verify all work is documented.", 1, 30, prio("medium"), 0, 0, 1, "standard"],
    ["Close project", "Enter final summary, select close reason, and close.", 1, 30, prio("medium"), 0, 0, 1, "standard"],
  ];
  tts.forEach(([name, desc, req, offset, prioId, canSkip, isDecision, canEdit, generation], i) =>
    insTT.run(tplId, i + 1, name, desc, req, offset, prioId, canEdit, canSkip, isDecision, generation)
  );

  // ---- Field requirement rules (§5.3) ----
  const insFR = db.prepare(
    `INSERT INTO field_requirements (object_type, field_name, label, is_system, required, required_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // System fields — locked, always required
  insFR.run("project", "project_code", "Project ID", 1, 1, "always");
  insFR.run("project", "mcp_number", "MCP #", 1, 1, "always");
  insFR.run("project", "mcp_name", "MCP Name", 1, 1, "always");
  insFR.run("project", "assignee_id", "Assignee", 1, 1, "always");
  insFR.run("project", "assignment_date", "Assignment Date", 1, 1, "always");
  // Configurable
  insFR.run("project", "target_date", "Target Date", 0, 0, "creation");
  insFR.run("project", "risk_level_id", "Risk Level", 0, 0, "creation");
  insFR.run("project", "final_summary", "Final Summary", 0, 1, "closure");
  insFR.run("project", "close_reason_id", "Close Reason", 0, 1, "closure");
  insFR.run("task", "due_date", "Due Date", 0, 0, "creation");
  insFR.run("task", "assigned_to", "Assigned To", 0, 0, "creation");
  insFR.run("task", "priority_id", "Priority", 0, 0, "creation");

  // ---- View layouts (§5.4) ----
  const insVL = db.prepare(
    `INSERT INTO view_layout_fields (view_name, field_key, label, display_order, is_visible, is_locked)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const layouts: Record<string, [string, string, number, number][]> = {
    portfolio_card: [
      ["mcp_name", "MCP Name", 1, 1],
      ["rag", "RAG", 1, 1],
      ["project_code", "Project ID", 1, 0],
      ["assignee_name", "Assignee", 1, 0],
      ["days_in_status", "Days in Status", 1, 0],
      ["next_due_task", "Next Due Task", 1, 0],
      ["risk_label", "Risk Level", 0, 0],
      ["mcp_number", "MCP #", 0, 0],
    ],
    task_card: [
      ["name", "Task Name", 1, 1],
      ["assigned_to_name", "Assigned To", 1, 0],
      ["due_date", "Due Date", 1, 0],
      ["required", "Required Flag", 1, 1],
      ["priority_label", "Priority", 1, 0],
      ["step_order", "Step #", 0, 0],
    ],
    project_list: [
      ["project_code", "Project ID", 1, 1],
      ["mcp_number", "MCP #", 1, 0],
      ["mcp_name", "MCP Name", 1, 1],
      ["assignee_name", "Assignee", 1, 0],
      ["status_label", "Status", 1, 1],
      ["rag", "RAG", 1, 0],
      ["risk_label", "Risk", 1, 0],
      ["assignment_date", "Assigned", 1, 0],
      ["days_in_status", "Days in Status", 0, 0],
      ["open_task_count", "Open Tasks", 1, 0],
    ],
    task_list: [
      ["step_order", "#", 1, 1],
      ["name", "Task Name", 1, 1],
      ["status_label", "Status", 1, 1],
      ["assigned_to_name", "Assigned To", 1, 0],
      ["due_date", "Due Date", 1, 0],
      ["priority_label", "Priority", 1, 0],
      ["required", "Required", 1, 0],
      ["activity_count", "Activities", 1, 0],
      ["task_type", "Type", 0, 0],
    ],
    project_header: [
      ["mcp_name", "MCP Name", 1, 1],
      ["mcp_number", "MCP #", 1, 1],
      ["project_code", "Project ID", 1, 1],
      ["status_label", "Status", 1, 1],
      ["rag", "RAG", 1, 1],
      ["assignee_name", "Assignee", 1, 0],
      ["assignment_date", "Assignment Date", 1, 0],
      ["target_date", "Target Date", 1, 0],
      ["risk_label", "Risk Level", 1, 0],
    ],
  };
  for (const [view, fields] of Object.entries(layouts)) {
    fields.forEach(([key, label, visible, locked], i) => insVL.run(view, key, label, i + 1, visible, locked));
  }

  // ---- Settings: RAG thresholds (§4.7, configurable per §5.3) ----
  const insSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  insSetting.run("rag_red_overdue_days", "3");
  insSetting.run("rag_amber_due_days", "3");
  insSetting.run("rag_stall_days", "7");

  // ---- Demo data ----
  seedDemo(users, tplId);
  console.log("Seed complete.");
}

function iso(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function seedDemo(users: number[], tplId: number) {
  const status = (key: string) => valueByMapsTo("Project Status", key)!.id;
  const taskStatus = (key: string) => valueByMapsTo("Task Status", key)!.id;
  const risk = (key: string) => valueByMapsTo("Risk Level", key)!.id;
  const closeReason = (key: string) => valueByMapsTo("Close Reason", key)!.id;
  const noteCat = (key: string) => valueByMapsTo("Note Category", key)!.id;
  const actType = (key: string) => valueByMapsTo("Time Log Activity Type", key)!.id;

  const insProject = db.prepare(
    `INSERT INTO projects (project_code, mcp_number, mcp_name, assignee_id, assignment_date, target_date,
       template_id, status_id, risk_level_id, status_changed_date, created_date, closed_date, closed_by, close_reason_id, final_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  type Demo = {
    mcp: [string, string];
    assignee: number;
    assignedDaysAgo: number;
    status: string;
    risk: string;
    target?: number; // days from now (negative = past)
    closed?: { daysAgo: number; reason: string; summary: string };
    completeThrough?: number; // complete the first N template tasks
    blockTask?: number; // 1-based step to mark blocked
    wins?: [description: string, categoryKey: string, occurredDaysAgo: number][];
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
    const pid = insProject.run(
      code,
      d.mcp[0],
      d.mcp[1],
      d.assignee,
      assigned,
      d.target != null ? iso(-d.target) : null,
      tplId,
      status(d.status),
      risk(d.risk),
      iso(Math.min(d.assignedDaysAgo, isClosed ? d.closed!.daysAgo : Math.ceil(d.assignedDaysAgo / 3))) + " 09:00:00",
      assigned + " 09:00:00",
      isClosed ? iso(d.closed!.daysAgo) : null,
      isClosed ? d.assignee : null,
      isClosed ? closeReason(d.closed!.reason) : null,
      isClosed ? d.closed!.summary : null
    ).lastInsertRowid as number;

    generateTasksFromTemplate(pid, tplId, assigned);
    logActivity({ project_id: pid, user_id: d.assignee, kind: "system", note: `Project ${code} created for ${d.mcp[1]}` });

    const tasks = db
      .prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY step_order")
      .all(pid) as any[];
    const visible = tasks.filter((t) => !t.conditional_pending);
    const completeN = d.completeThrough ?? 0;

    if (completeN >= 5 || isClosed) {
      // decision answered Yes → activate conditional action-plan tasks
      db.prepare("UPDATE project_tasks SET conditional_pending = 0 WHERE project_id = ? AND conditional_pending = 1").run(pid);
    }
    const allTasks = db
      .prepare("SELECT * FROM project_tasks WHERE project_id = ? AND conditional_pending = 0 ORDER BY step_order")
      .all(pid) as any[];

    let done = 0;
    for (const t of allTasks) {
      if (done < completeN || isClosed) {
        const when = iso(Math.max(1, d.assignedDaysAgo - 2 - done * 2));
        db.prepare(
          "UPDATE project_tasks SET status_id = ?, completed_date = ?, completed_by = ? WHERE id = ?"
        ).run(taskStatus("complete"), when, d.assignee, t.id);
        logActivity({
          project_id: pid, project_task_id: t.id, user_id: d.assignee, kind: "status_change",
          note: `changed "${t.name}" from Not Started to Complete`, old_status: "Not Started", new_status: "Complete",
          category_id: noteCat("general"),
        });
        done++;
      } else if (d.blockTask && t.step_order === d.blockTask) {
        db.prepare("UPDATE project_tasks SET status_id = ? WHERE id = ?").run(taskStatus("blocked"), t.id);
        logActivity({
          project_id: pid, project_task_id: t.id, user_id: d.assignee, kind: "status_change",
          note: `changed "${t.name}" from Not Started to Blocked`, old_status: "Not Started", new_status: "Blocked",
          category_id: noteCat("issue"),
        });
      } else if (done === completeN && !isClosed && completeN > 0) {
        db.prepare("UPDATE project_tasks SET status_id = ? WHERE id = ?").run(taskStatus("in_progress"), t.id);
        done++; // only the first open task moves to in progress
      }
    }

    // Notes
    const noteSamples: [string, string][] = [
      ["customer_contact", `Spoke with billing contact at ${d.mcp[1]}; walked through recent invoices.`],
      ["billing_finding", "Found rate-class mismatch on two service points; quantifying impact."],
    ];
    for (const [cat, note] of noteSamples) {
      logActivity({ project_id: pid, user_id: d.assignee, kind: "note", category_id: noteCat(cat), note });
    }

    // v2: logged activities (calls / visits / meetings) with times, many-to-many linked to tasks
    const actTypeIdOf = (key: string) => valueByMapsTo("Activity Type", key)!.id;
    const insAct = db.prepare(
      `INSERT INTO activities (project_id, user_id, activity_date, kind, activity_type_id, start_time, end_time, note)
       VALUES (?, ?, ?, 'activity', ?, ?, ?, ?)`
    );
    const insLink = db.prepare("INSERT OR IGNORE INTO task_activity_links (project_task_id, activity_id) VALUES (?, ?)");
    if (!isClosed && completeN > 0) {
      const visit = insAct.run(pid, d.assignee, iso(3) + " 10:00:00", actTypeIdOf("site_visit"), "10:00", "11:30",
        `On-site visit at ${d.mcp[1]} — walked the metering setup with facilities.`).lastInsertRowid as number;
      if (allTasks[2]) insLink.run(allTasks[2].id, visit);
      if (allTasks[3]) insLink.run(allTasks[3].id, visit);
      const call = insAct.run(pid, d.assignee, iso(0) + " 09:30:00", actTypeIdOf("phone_call"), "09:30", "10:00",
        "Check-in call on outstanding billing questions.").lastInsertRowid as number;
      if (allTasks[1]) insLink.run(allTasks[1].id, call);
      const meeting = insAct.run(pid, d.assignee, iso(-(1 + (n % 3))) + " 14:00:00", actTypeIdOf("client_meeting"), "14:00", "15:00",
        "Review findings and agree next steps with the customer.").lastInsertRowid as number;
      if (allTasks[4]) insLink.run(allTasks[4].id, meeting);
    }

    // v2: structured wins
    const winCatId = (key: string) => valueByMapsTo("Win Category", key)!.id;
    const insWin = db.prepare(
      `INSERT INTO wins (project_id, description, category_id, occurred_date, logged_date, logged_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const [descr, catKey, daysAgo] of d.wins ?? []) {
      insWin.run(pid, descr, winCatId(catKey), iso(daysAgo), iso(Math.max(0, daysAgo - 1)) + " 09:00:00", d.assignee);
    }

    // Time logs across the current + previous week
    const insTL = db.prepare(
      `INSERT INTO time_logs (project_id, project_task_id, user_id, date, hours, minutes, activity_type_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    if (!isClosed) {
      const acts = ["billing_analysis", "customer_visit", "internal_review", "documentation"];
      for (let i = 0; i < 5; i++) {
        const daysAgo = (n + i * 2) % 12;
        insTL.run(
          pid,
          allTasks[Math.min(i, allTasks.length - 1)].id,
          d.assignee,
          iso(daysAgo),
          1 + ((n + i) % 3),
          (i % 2) * 30,
          actType(acts[i % acts.length]),
          i === 0 ? "Initial billing data pull" : ""
        );
      }
      insTL.run(pid, null, d.assignee, iso(1), 0, 45, actType("admin"), "General customer call — no specific task");
    } else {
      insTL.run(pid, allTasks[1]?.id ?? null, d.assignee, iso(d.closed!.daysAgo + 3), 3, 0, actType("billing_analysis"), "");
      insTL.run(pid, null, d.assignee, iso(d.closed!.daysAgo + 1), 1, 30, actType("documentation"), "Closure documentation");
    }
  }
}

seed();
