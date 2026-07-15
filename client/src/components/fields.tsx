import { useEffect, useState } from "react";
import { api, CustomField, CustomValue, fmtCurrency, fmtDate, LayoutField, Project, Task } from "../api";
import { Chip, Field, inputCls, Mono, RagChip } from "./ui";

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
  if (key.startsWith("cf_")) return renderCustomValue(p.custom?.[key]);
  switch (key) {
    case "mcp_name": return <span className="font-medium">{p.mcp_name}</span>;
    case "project_name": return p.project_name ? <span>{p.project_name}</span> : <span className="text-muted">—</span>;
    case "mcp_number": return <Mono className="text-muted">{p.mcp_number}</Mono>;
    case "project_code": return <Mono className="text-muted">{p.project_code}</Mono>;
    case "assignee_name": return <span>{p.assignee_name}</span>;
    case "annualized_premium":
      return p.annualized_premium != null ? <Mono>{fmtCurrency(p.annualized_premium)}</Mono> : <span className="text-muted">—</span>;
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

/** Display for a custom-field value — the same rendering on tables, cards and the detail header. */
export function renderCustomValue(v: CustomValue | undefined): React.ReactNode {
  if (!v || v.value == null || v.value === "") return <span className="text-muted">—</span>;
  switch (v.type) {
    case "currency": return <Mono>{fmtCurrency(v.value)}</Mono>;
    case "number": return <Mono>{v.value}</Mono>;
    case "date": return <Mono>{fmtDate(v.value)}</Mono>;
    case "checkbox": return v.value === "1" ? <span>Yes</span> : <span className="text-muted">No</span>;
    case "dropdown":
      return v.option_label ? <Chip label={v.option_label} color={v.option_color ?? "#5C6B84"} small /> : <span className="text-muted">—</span>;
    default: return <span>{v.value}</span>;
  }
}

/** All admin-defined project fields, active-only by default. */
export function useCustomFields(activeOnly = true) {
  const [fields, setFields] = useState<CustomField[]>([]);
  useEffect(() => {
    api.get<CustomField[]>("/api/custom-fields").then(setFields).catch(() => setFields([]));
  }, []);
  return activeOnly ? fields.filter((f) => f.is_active) : fields;
}

/**
 * Form inputs for the custom fields — shared by the create and edit project
 * modals so a new field automatically shows up in both with no code change.
 * `values` is { field_key: raw input string }, checkbox as "1"/"0".
 */
export function CustomFieldInputs({ fields, values, onChange }: {
  fields: CustomField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {fields.map((f) => (
        <Field key={f.field_key} label={f.label}>
          {f.field_type === "dropdown" ? (
            <select className={inputCls} value={values[f.field_key] ?? ""} onChange={(e) => onChange(f.field_key, e.target.value)}>
              <option value="">—</option>
              {f.options.filter((o) => (o.is_active && !o.archived) || String(o.id) === values[f.field_key]).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          ) : f.field_type === "checkbox" ? (
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={values[f.field_key] === "1"}
                onChange={(e) => onChange(f.field_key, e.target.checked ? "1" : "0")} />
              Yes
            </label>
          ) : f.field_type === "date" ? (
            <input type="date" className={inputCls} value={values[f.field_key] ?? ""} onChange={(e) => onChange(f.field_key, e.target.value)} />
          ) : f.field_type === "number" ? (
            <input type="number" step="any" className={inputCls} value={values[f.field_key] ?? ""} onChange={(e) => onChange(f.field_key, e.target.value)} />
          ) : f.field_type === "currency" ? (
            <input type="number" min="0" step="0.01" className={inputCls} placeholder="0.00"
              value={values[f.field_key] ?? ""} onChange={(e) => onChange(f.field_key, e.target.value)} />
          ) : (
            <input className={inputCls} value={values[f.field_key] ?? ""} onChange={(e) => onChange(f.field_key, e.target.value)} />
          )}
        </Field>
      ))}
    </>
  );
}

export function renderTaskField(key: string, t: Task): React.ReactNode {
  switch (key) {
    case "name":
      return (
        <span className="font-medium">
          {t.name}
          {t.task_type === "adhoc" && <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-muted">ad-hoc</span>}
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
    case "activity_count":
      return t.activity_count
        ? <span className="rounded-full bg-accent-soft px-2.5 py-0.5 font-mono text-xs font-semibold text-accent">{t.activity_count}</span>
        : <span className="text-muted">—</span>;
    case "task_type": return <span className="text-muted">{t.task_type.replace("_", " ")}</span>;
    default: return <span className="text-muted">—</span>;
  }
}
