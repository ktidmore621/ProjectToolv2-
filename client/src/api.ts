/**
 * Thin fetch layer. All endpoints live under /api (Vite proxies to the Express
 * server). In the standalone demo build (VITE_DEMO=1) every call is answered
 * by the in-browser backend in src/demo/ instead — no server needed.
 */

export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (IS_DEMO) {
    const { demoRequest } = await import("./demo/backend");
    const r = demoRequest(method, url, body);
    if (r.status >= 400) throw new ApiError(r.status, r.data);
    return r.data as T;
  }
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>("GET", url),
  post: <T = any>(url: string, body?: unknown) => request<T>("POST", url, body),
  patch: <T = any>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T = any>(url: string) => request<T>("DELETE", url),
};

// ---- Shared shapes (loose on purpose; the server serializes everything) ----

export interface PickValue {
  id: number;
  picklist_id: number;
  label: string;
  sort_order: number;
  color: string;
  is_active: number;
  is_default: number;
  maps_to: string | null;
}
export interface Picklist {
  id: number;
  name: string;
  object_type: string;
  is_system: number;
  values: PickValue[];
}
export interface User {
  id: number;
  name: string;
  email: string;
}
export interface LayoutField {
  id: number;
  view_name: string;
  field_key: string;
  label: string;
  display_order: number;
  is_visible: number;
  is_locked: number;
}
export type Rag = "red" | "amber" | "green";

export interface Project {
  id: number;
  project_code: string;
  mcp_number: string;
  mcp_name: string;
  assignee_id: number;
  assignee_name: string;
  assignment_date: string;
  target_date: string | null;
  template_id: number;
  status_id: number;
  status_label: string;
  status_color: string;
  status_key: string | null;
  risk_level_id: number | null;
  risk_label: string | null;
  risk_color: string | null;
  rag: Rag;
  rag_reason: string;
  rag_overridden: boolean;
  rag_color: string;
  rag_label: string;
  created_date: string;
  closed_date: string | null;
  closed_by_name: string | null;
  close_reason_id: number | null;
  close_reason_label: string | null;
  final_summary: string | null;
  is_closed: boolean;
  days_in_status: number;
  open_task_count: number;
  task_count: number;
  next_due_task: { name: string; due_date: string } | null;
  tasks?: Task[];
}

export interface Task {
  id: number;
  project_id: number;
  name: string;
  description: string;
  task_type: "standard" | "adhoc" | "action_plan";
  step_order: number;
  assigned_to: number | null;
  assigned_to_name: string | null;
  due_date: string | null;
  status_id: number;
  status_label: string;
  status_color: string;
  status_key: string | null;
  priority_id: number | null;
  priority_label: string | null;
  priority_color: string | null;
  required: number;
  is_decision: number;
  notes: string;
  skip_reason: string | null;
  completed_date: string | null;
  completed_by_name: string | null;
}

/** CSV export: normal build navigates to the server endpoint; demo build generates the file in-browser. */
export async function csvDownload(url: string) {
  if (!IS_DEMO) {
    window.location.href = url;
    return;
  }
  const { demoCsv } = await import("./demo/backend");
  const { filename, csv } = demoCsv(url);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtHours(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Monday of the week containing `d`. */
export function weekStart(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
