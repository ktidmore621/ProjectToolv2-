import { useEffect, useState } from "react";
import { api, fmtDate, LayoutField, Project, Task } from "../api";
import { Chip, Mono, RagChip } from "./ui";

/** Layout rows for a view, visible-first, ordered. Refetches when `bump` changes. */
export function useLayout(view: string, bump = 0) {
  const [fields, setFields] = useState<LayoutField[]>([]);
  useEffect(() => {
    api.get<LayoutField[]>(`/api/layouts/${view}`).then(setFields).catch(() => setFields([]));
  }, [view, bump]);
  return fields.filter((f) => f.is_visible).sort((a, b) => a.display_order - b.display_order);
}

/**
 * Field renderers keyed by field_key — how each configurable field displays on
 * cards, list columns, and the project header. Adding a field to a layout in
 * Configuration automatically renders it here.
 */
export function renderProjectField(key: string, p: Project): React.ReactNode {
  switch (key) {
    case "mcp_name": return <span className="font-medium">{p.mcp_name}</span>;
    case "mcp_number": return <Mono className="text-muted">{p.mcp_number}</Mono>;
    case "project_code": return <Mono className="text-muted">{p.project_code}</Mono>;
    case "assignee_name": return <span>{p.assignee_name}</span>;
    case "assignment_date": return <Mono>{fmtDate(p.assignment_date)}</Mono>;
    case "target_date": return <Mono>{fmtDate(p.target_date)}</Mono>;
    case "status_label": return <Chip label={p.status_label} color={p.status_color} small />;
    case "rag": return <RagChip rag={p.rag} reason={p.rag_reason} small />;
    case "risk_label": return p.risk_label ? <Chip label={p.risk_label} color={p.risk_color!} small /> : <span className="text-muted">—</span>;
    case "days_in_status": return <span className="text-muted"><Mono>{p.days_in_status}</Mono>d in status</span>;
    case "open_task_count": return <Mono>{p.open_task_count}</Mono>;
    case "next_due_task":
      return p.next_due_task
        ? <span className="text-muted">Next: {p.next_due_task.name} · <Mono>{fmtDate(p.next_due_task.due_date)}</Mono></span>
        : <span className="text-muted">No open dated tasks</span>;
    default: return <span className="text-muted">—</span>;
  }
}

export function renderTaskField(key: string, t: Task): React.ReactNode {
  switch (key) {
    case "name":
      return (
        <span className="font-medium">
          {t.name}
          {t.task_type === "adhoc" && <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-muted">ad-hoc</span>}
          {t.task_type === "action_plan" && <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-accent">action plan</span>}
        </span>
      );
    case "status_label": return <Chip label={t.status_label} color={t.status_color} small />;
    case "assigned_to_name": return <span>{t.assigned_to_name ?? <span className="text-muted">—</span>}</span>;
    case "due_date": return <Mono>{fmtDate(t.due_date)}</Mono>;
    case "priority_label": return t.priority_label ? <Chip label={t.priority_label} color={t.priority_color!} small /> : <span className="text-muted">—</span>;
    case "required":
      return t.required
        ? <span className="rounded bg-primary-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">Required</span>
        : <span className="text-muted">—</span>;
    case "step_order": return <Mono className="text-muted">{t.step_order}</Mono>;
    case "task_type": return <span className="text-muted">{t.task_type.replace("_", " ")}</span>;
    default: return <span className="text-muted">—</span>;
  }
}
