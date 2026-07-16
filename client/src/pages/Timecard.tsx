import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtHours, isoOf, Project } from "../api";
import { Bucket, bucketMinutes, DateRangeBar, timecardExportUrl, useDateRange } from "../components/DateRange";
import { Page } from "../components/Layout";
import { Btn, Card, CsvLink, EmptyState, Field, inputCls, Modal, Mono, Skeleton } from "../components/ui";
import { useConfig, useSession, useToast } from "../state";

interface CellTarget {
  project_id: number;
  project_name: string;
  project_task_id: number | null;
  task_name: string | null;
  date: string;
  existing: any[];
}

/** My Timecard (§7.1): range grid (day/week/month columns), rows = project (tasks expandable), cells = hours. */
export function Timecard() {
  const { currentUser } = useSession();
  const toast = useToast();
  const dateRange = useDateRange();
  const { range, buckets, granularity } = dateRange;
  const [logs, setLogs] = useState<any[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [cell, setCell] = useState<CellTarget | null>(null);
  const [showLogForm, setShowLogForm] = useState(false);

  const load = useCallback(() => {
    if (!currentUser) return;
    api.get(`/api/timelogs?user_id=${currentUser.id}&start=${range.start}&end=${range.end}`).then(setLogs);
    api.get<Project[]>("/api/projects").then(setProjects);
  }, [currentUser, range.start, range.end]);
  useEffect(load, [load]);

  // rows: project → optional task sub-rows
  const rows = useMemo(() => {
    if (!logs) return [];
    const byProject = new Map<number, any[]>();
    for (const l of logs) {
      if (!byProject.has(l.project_id)) byProject.set(l.project_id, []);
      byProject.get(l.project_id)!.push(l);
    }
    return [...byProject.entries()].map(([pid, ls]) => {
      const tasks = new Map<string, { task_id: number | null; name: string; logs: any[] }>();
      for (const l of ls) {
        const key = l.project_task_id ? `t${l.project_task_id}` : "project";
        if (!tasks.has(key)) tasks.set(key, { task_id: l.project_task_id, name: l.task_name ?? "Project-level", logs: [] });
        tasks.get(key)!.logs.push(l);
      }
      return { project_id: pid, code: ls[0].project_code, name: ls[0].mcp_name, logs: ls, tasks: [...tasks.values()] };
    });
  }, [logs]);

  const grand = (logs ?? []).reduce((s, l) => s + l.total_minutes, 0);

  if (!currentUser)
    return <Page title="My Timecard"><EmptyState title="Pick your name in the sidebar to see your timecard" /></Page>;

  function openCell(row: any, taskRow: { task_id: number | null; name: string; logs: any[] } | null, date: string) {
    const existing = (taskRow ? taskRow.logs : row.logs).filter((l: any) => l.date === date);
    setCell({
      project_id: row.project_id, project_name: row.name,
      project_task_id: taskRow?.task_id ?? null, task_name: taskRow ? taskRow.name : null,
      date, existing,
    });
  }

  return (
    <Page
      title="My Timecard"
      actions={
        <>
          <DateRangeBar ctrl={dateRange} />
          <CsvLink href={timecardExportUrl(range, currentUser.id)}>Export</CsvLink>
          <Btn kind="primary" onClick={() => setShowLogForm(true)}>Log time</Btn>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        <Mono>{range.start}</Mono> – <Mono>{range.end}</Mono>
        {granularity === "day"
          ? " — click any cell to add or edit time."
          : ` — columns are ${granularity}s; switch to Week (or a short custom range) for day-level editing.`}
      </p>
      {!logs ? <Skeleton className="h-72" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {/* sticky first column (§10.4) */}
                <th className="sticky left-0 z-10 bg-surface px-3 py-2.5 text-xs font-semibold text-muted">Project / Task</th>
                {buckets.map((b) => (
                  <th key={b.key} className="px-2 py-2.5 text-right text-xs font-semibold text-muted">
                    {b.label}{b.sub && <> <Mono className="font-normal">{b.sub}</Mono></>}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={buckets.length + 2} className="px-3 py-10 text-center text-sm text-muted">No time logged in this range. Click “Log time” to start.</td></tr>
              )}
              {rows.map((row, ri) => (
                <RowGroup key={row.project_id} row={row} buckets={buckets} zebra={ri % 2 === 1}
                  expanded={expanded.has(row.project_id)}
                  onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(row.project_id) ? n.delete(row.project_id) : n.add(row.project_id); return n; })}
                  onCell={openCell} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-hairline font-semibold">
                <td className="sticky left-0 bg-surface px-3 py-2.5">Total</td>
                {buckets.map((b) => (
                  <td key={b.key} className="px-2 py-2.5 text-right"><Mono>{fmtHours(bucketMinutes(logs, b)) || "—"}</Mono></td>
                ))}
                <td className="px-3 py-2.5 text-right"><Mono>{fmtHours(grand)}</Mono></td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
      {cell && <CellModal cell={cell} onClose={() => setCell(null)} onSaved={() => { setCell(null); load(); }} />}
      {showLogForm && <LogTimeModal projects={projects} onClose={() => setShowLogForm(false)} onSaved={() => { setShowLogForm(false); load(); toast("Time logged.", "success"); }} />}
    </Page>
  );
}

function RowGroup({ row, buckets, zebra, expanded, onToggle, onCell }: any) {
  return (
    <>
      <tr className={`border-b border-hairline ${zebra ? "bg-rowalt" : ""}`}>
        <td className={`sticky left-0 z-10 px-3 py-2 ${zebra ? "bg-rowalt" : "bg-surface"}`}>
          <button onClick={onToggle} className="mr-1.5 text-muted hover:text-ink" aria-label={expanded ? "Collapse tasks" : "Expand tasks"}>
            {expanded ? "▾" : "▸"}
          </button>
          <Link to={`/projects/${row.project_id}`} className="font-medium hover:underline">{row.name}</Link>
          <Mono className="ml-2 text-xs text-muted">{row.code}</Mono>
        </td>
        {buckets.map((b: Bucket) => {
          const m = bucketMinutes(row.logs, b);
          // add/edit works cell-by-cell only when a column is a single day
          return b.start === b.end ? (
            <td key={b.key} className="px-1 py-1 text-right">
              <button
                onClick={() => onCell(row, null, b.start)}
                className={`w-full rounded px-1.5 py-1 text-right font-mono text-[13px] transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft ${m ? "" : "text-muted/40"}`}
                aria-label={`${row.name} on ${b.start}: ${m ? fmtHours(m) : "no time"} — click to log`}
              >
                {m ? fmtHours(m) : "·"}
              </button>
            </td>
          ) : (
            <td key={b.key} className={`px-2 py-2 text-right font-mono text-[13px] ${m ? "" : "text-muted/40"}`}>{m ? fmtHours(m) : "·"}</td>
          );
        })}
        <td className="px-3 py-2 text-right font-medium"><Mono>{fmtHours(row.logs.reduce((s: number, l: any) => s + l.total_minutes, 0))}</Mono></td>
      </tr>
      {expanded && row.tasks.map((t: any) => (
        <tr key={t.task_id ?? "project"} className="border-b border-hairline bg-canvas/40 text-xs">
          <td className="sticky left-0 z-10 bg-canvas/40 py-1.5 pl-10 pr-3 text-muted backdrop-blur">{t.name}</td>
          {buckets.map((b: Bucket) => {
            const m = bucketMinutes(t.logs, b);
            return b.start === b.end ? (
              <td key={b.key} className="px-1 py-0.5 text-right">
                <button onClick={() => onCell(row, t, b.start)}
                  className={`w-full rounded px-1.5 py-0.5 text-right font-mono transition-colors hover:bg-accent-soft ${m ? "text-ink" : "text-muted/40"}`}>
                  {m ? fmtHours(m) : "·"}
                </button>
              </td>
            ) : (
              <td key={b.key} className={`px-2 py-1 text-right font-mono ${m ? "text-ink" : "text-muted/40"}`}>{m ? fmtHours(m) : "·"}</td>
            );
          })}
          <td className="px-3 py-1 text-right text-muted"><Mono>{fmtHours(t.logs.reduce((s: number, l: any) => s + l.total_minutes, 0))}</Mono></td>
        </tr>
      ))}
    </>
  );
}

/** Quick add/edit from a grid cell. */
function CellModal({ cell, onClose, onSaved }: { cell: CellTarget; onClose: () => void; onSaved: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [hours, setHours] = useState("1");
  const [minutes, setMinutes] = useState("0");
  const [actId, setActId] = useState<string>(String(activeValues("Time Log Activity Type").find((v) => v.is_default)?.id ?? ""));
  const [notes, setNotes] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/timelogs", {
        project_id: cell.project_id, project_task_id: cell.project_task_id, user_id: currentUser?.id,
        date: cell.date, hours: Number(hours), minutes: Number(minutes),
        activity_type_id: actId ? Number(actId) : null, notes,
      });
      onSaved();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }
  async function remove(id: number) {
    try {
      await api.del(`/api/timelogs/${id}?user_id=${currentUser?.id}`);
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete the entry", "error");
    }
  }

  return (
    <Modal title={`${cell.project_name} · ${cell.date}`} onClose={onClose}>
      {cell.existing.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-xs font-semibold text-muted">Entries this day</div>
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {cell.existing.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span><Mono>{fmtHours(l.total_minutes)}</Mono>{l.activity_type_label && <span className="ml-2 text-xs text-muted">{l.activity_type_label}</span>}{l.task_name && <span className="ml-2 text-xs text-muted">· {l.task_name}</span>}</span>
                <Btn small kind="danger" onClick={() => remove(l.id)}>Delete</Btn>
              </li>
            ))}
          </ul>
        </div>
      )}
      <form onSubmit={add} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hours"><input type="number" min="0" className={inputCls} value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
          <Field label="Minutes"><input type="number" min="0" max="59" step="15" className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
        </div>
        <Field label="Activity type">
          <select className={inputCls} value={actId} onChange={(e) => setActId(e.target.value)}>
            <option value="">—</option>
            {activeValues("Time Log Activity Type").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Notes"><input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Done</Btn><Btn kind="primary" type="submit">Add entry</Btn></div>
      </form>
    </Modal>
  );
}

/** Standalone Log Time form (§7.1) — updates the grid on save. */
function LogTimeModal({ projects, onClose, onSaved }: { projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [projectId, setProjectId] = useState<number>(0);
  const [tasks, setTasks] = useState<any[]>([]);
  const [form, setForm] = useState({ project_task_id: "", date: isoOf(new Date()), hours: "1", minutes: "0", activity_type_id: "", notes: "" });

  useEffect(() => {
    if (!projectId) { setTasks([]); return; }
    api.get<Project>(`/api/projects/${projectId}`).then((p) => setTasks(p.tasks ?? []));
  }, [projectId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/timelogs", {
        project_id: projectId,
        project_task_id: form.project_task_id ? Number(form.project_task_id) : null,
        user_id: currentUser?.id, date: form.date,
        hours: Number(form.hours), minutes: Number(form.minutes),
        activity_type_id: form.activity_type_id ? Number(form.activity_type_id) : null,
        notes: form.notes,
      });
      onSaved();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  return (
    <Modal title="Log time" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Project">
          <select className={inputCls} required value={projectId} onChange={(e) => setProjectId(Number(e.target.value))}>
            <option value={0} disabled>Select…</option>
            {projects.filter((p) => !p.is_closed).map((p) => <option key={p.id} value={p.id}>{p.mcp_name} ({p.project_code})</option>)}
          </select>
        </Field>
        <Field label="Task (optional)">
          <select className={inputCls} value={form.project_task_id} onChange={(e) => setForm({ ...form, project_task_id: e.target.value })}>
            <option value="">Project-level</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date"><input type="date" className={inputCls} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="Hours"><input type="number" min="0" className={inputCls} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></Field>
          <Field label="Minutes"><input type="number" min="0" max="59" step="15" className={inputCls} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} /></Field>
        </div>
        <Field label="Activity type">
          <select className={inputCls} value={form.activity_type_id} onChange={(e) => setForm({ ...form, activity_type_id: e.target.value })}>
            <option value="">—</option>
            {activeValues("Time Log Activity Type").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Notes"><input className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" type="submit" disabled={!projectId}>Log time</Btn></div>
      </form>
    </Modal>
  );
}
