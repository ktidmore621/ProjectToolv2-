import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, fmtDate, fmtHours, Project, Task, todayIso } from "../api";
import { renderProjectField, renderTaskField, useLayout } from "../components/fields";
import { Page } from "../components/Layout";
import { TaskKanban } from "../components/TaskKanban";
import { Btn, Card, Chip, EmptyState, Field, inputCls, Modal, Mono, RagChip, Skeleton } from "../components/ui";
import { useConfig, useSession, useToast } from "../state";

type Tab = "tasks" | "time" | "notes" | "history";

export function ProjectDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { currentUser, users } = useSession();
  const { activeValues } = useConfig();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [taskView, setTaskView] = useState<"list" | "kanban">("list");
  const [showClose, setShowClose] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showRag, setShowRag] = useState(false);
  const [skipTask, setSkipTask] = useState<{ task: Task; statusId: number } | null>(null);
  const [decisionTask, setDecisionTask] = useState<{ task: Task; statusId: number } | null>(null);
  const headerFields = useLayout("project_header");
  const taskColumns = useLayout("task_list");

  const load = useCallback(() => { api.get<Project>(`/api/projects/${id}`).then(setProject); }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (params.get("close")) { setShowClose(true); setParams({}, { replace: true }); }
  }, [params, setParams]);

  /** Shared task status change — same rules from list, kanban, or dropdown (§4.2). */
  async function changeTaskStatus(task: Task, statusId: number, extra?: { skip_reason?: string; decision?: "yes" | "no" }) {
    try {
      const r = await api.post(`/api/tasks/${task.id}/status`, { status_id: statusId, user_id: currentUser?.id, ...extra });
      if (r.warning) toast(r.warning, "warning");
      else toast(`"${task.name}" is now ${r.task.status_label}`, "success");
      load();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.body?.needs_skip_reason) { setSkipTask({ task, statusId }); return false; }
      if (err instanceof ApiError && err.body?.needs_decision) { setDecisionTask({ task, statusId }); return false; }
      toast(err instanceof Error ? err.message : "Update failed", "error");
      return false;
    }
  }

  if (!project) return <Page title="Project"><Skeleton className="h-96" /></Page>;
  const readOnly = project.is_closed;
  const tasks = (project.tasks ?? []) as Task[];

  return (
    <Page
      title={<span className="flex items-center gap-3">{project.mcp_name} <RagChip rag={project.rag} reason={project.rag_reason} /></span>}
      actions={
        !readOnly && (
          <>
            <Btn onClick={() => setShowRag(true)}>RAG override</Btn>
            <StatusSelect project={project} onChanged={load} />
            <Btn kind="primary" onClick={() => setShowClose(true)}>Close project</Btn>
          </>
        )
      }
    >
      {readOnly && (
        <div className="mb-4 rounded-lg border border-hairline bg-primary-soft/50 px-4 py-2.5 text-sm">
          This project is <b>{project.status_label}</b> and permanently read-only. If {project.mcp_name} needs the process again, <Link className="font-medium text-primary underline" to="/projects">create a new project</Link>.
        </div>
      )}

      {/* Header — fields driven by the project_header layout (§5.4) */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          {headerFields.map((f) => (
            <div key={f.field_key}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{f.label}</div>
              <div className="mt-0.5 text-sm">{renderProjectField(f.field_key, project)}</div>
            </div>
          ))}
          {project.rag_overridden && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">RAG note</div>
              <div className="mt-0.5 text-sm text-muted">Manual override — {project.rag_reason}</div>
            </div>
          )}
          {readOnly && (
            <>
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Closed</div>
                <div className="mt-0.5 text-sm"><Mono>{fmtDate(project.closed_date)}</Mono> by {project.closed_by_name}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Close reason</div>
                <div className="mt-0.5 text-sm">{project.close_reason_label ?? "—"}</div>
              </div>
            </>
          )}
        </div>
        {readOnly && project.final_summary && (
          <div className="mt-3 border-t border-hairline pt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Final summary</div>
            <p className="mt-1 text-sm">{project.final_summary}</p>
          </div>
        )}
      </Card>

      {/* Tabs */}
      <div className="mb-4 flex items-center gap-1 border-b border-hairline" role="tablist">
        {(["tasks", "time", "notes", "history"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? "border-primary text-primary" : "border-transparent text-muted hover:text-ink"}`}>
            {t === "notes" ? "Notes / Activity" : t}
          </button>
        ))}
        {tab === "tasks" && (
          <div className="ml-auto flex items-center gap-1 pb-1.5">
            <Btn small kind={taskView === "list" ? "secondary" : "ghost"} onClick={() => setTaskView("list")}>List</Btn>
            <Btn small kind={taskView === "kanban" ? "secondary" : "ghost"} onClick={() => setTaskView("kanban")}>Kanban</Btn>
            {!readOnly && <Btn small kind="primary" onClick={() => setShowAddTask(true)}>Add ad-hoc task</Btn>}
          </div>
        )}
      </div>

      {tab === "tasks" && taskView === "list" && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {taskColumns.map((c) => <th key={c.field_key} className="px-3 py-2.5 text-xs font-semibold text-muted">{c.label}</th>)}
                {!readOnly && <th className="px-3 py-2.5 text-xs font-semibold text-muted">Change status</th>}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t, i) => (
                <tr key={t.id} className={`border-b border-hairline last:border-0 ${i % 2 ? "bg-rowalt" : ""}`}>
                  {taskColumns.map((c) => <td key={c.field_key} className="px-3 py-2">{renderTaskField(c.field_key, t)}</td>)}
                  {!readOnly && (
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Status of ${t.name}`}
                        className="rounded-lg border border-hairline bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                        value={t.status_id}
                        onChange={(e) => changeTaskStatus(t, Number(e.target.value))}
                      >
                        {activeValues("Task Status").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                      {t.skip_reason && <div className="mt-1 text-[11px] text-muted">Skipped: {t.skip_reason}</div>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "tasks" && taskView === "kanban" && (
        <TaskKanban tasks={tasks} readOnly={readOnly} onMove={changeTaskStatus} />
      )}

      {tab === "time" && <TimeTab project={project} readOnly={readOnly} />}
      {tab === "notes" && <NotesTab project={project} readOnly={readOnly} kind="note" />}
      {tab === "history" && <NotesTab project={project} readOnly={readOnly} kind="all" />}

      {showClose && <CloseModal project={project} onClose={() => setShowClose(false)} onClosed={load} />}
      {showAddTask && <AddTaskModal project={project} users={users} onClose={() => setShowAddTask(false)} onAdded={load} />}
      {showRag && <RagModal project={project} onClose={() => setShowRag(false)} onSaved={load} />}
      {skipTask && (
        <SkipModal
          task={skipTask.task}
          onCancel={() => setSkipTask(null)}
          onConfirm={async (reason) => {
            await changeTaskStatus(skipTask.task, skipTask.statusId, { skip_reason: reason });
            setSkipTask(null);
          }}
        />
      )}
      {decisionTask && (
        <DecisionModal
          task={decisionTask.task}
          onCancel={() => setDecisionTask(null)}
          onAnswer={async (decision) => {
            const ok = await changeTaskStatus(decisionTask.task, decisionTask.statusId, { decision });
            if (ok) toast(decision === "yes" ? "Action-plan tasks generated." : "No action plan — conditional tasks removed.", "info");
            setDecisionTask(null);
          }}
        />
      )}
    </Page>
  );
}

function StatusSelect({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const options = activeValues("Project Status").filter((v) => v.maps_to !== "closed");
  return (
    <select
      aria-label="Project status"
      className={inputCls + " !w-auto"}
      value={project.status_id}
      onChange={async (e) => {
        try {
          await api.post(`/api/projects/${project.id}/status`, { status_id: Number(e.target.value), user_id: currentUser?.id });
          onChanged();
        } catch (err) { toast(err instanceof Error ? err.message : "Update failed", "error"); }
      }}
    >
      {[...options, ...(options.some((o) => o.id === project.status_id) ? [] : [{ id: project.status_id, label: project.status_label } as any])].map((v) => (
        <option key={v.id} value={v.id}>{v.label}</option>
      ))}
    </select>
  );
}

function CloseModal({ project, onClose, onClosed }: { project: Project; onClose: () => void; onClosed: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [summary, setSummary] = useState("");
  const [reasonId, setReasonId] = useState<number>(activeValues("Close Reason").find((v) => v.is_default)?.id ?? 0);
  const [problems, setProblems] = useState<string[]>([]);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/close`, {
        user_id: currentUser?.id,
        final_summary: summary,
        close_reason_id: reasonId || undefined,
        override: override || undefined,
        override_reason: override ? overrideReason : undefined,
      });
      toast(`${project.mcp_name} closed. It's now a permanent historical record.`, "success");
      onClosed(); onClose();
    } catch (err) {
      if (err instanceof ApiError && err.body?.problems) {
        setProblems(err.body.problems);
        setError(err.body.problems.length ? "" : err.message);
        if (!err.body.problems.length) setError(err.message);
      } else setError(err instanceof Error ? err.message : "Close failed");
    }
  }

  return (
    <Modal title={`Close ${project.project_code} — ${project.mcp_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">
          Closing is permanent — closed projects are never reopened (§2.2). All required tasks must be Complete or formally Skipped.
        </p>
        <Field label="Final summary">
          <textarea className={inputCls + " h-24"} value={summary} onChange={(e) => setSummary(e.target.value)}
            placeholder="Where did this engagement leave the customer's billing position?" />
        </Field>
        <Field label="Close reason">
          <select className={inputCls} value={reasonId} onChange={(e) => setReasonId(Number(e.target.value))}>
            <option value={0}>—</option>
            {activeValues("Close Reason").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        {problems.length > 0 && (
          <div className="rounded-lg border border-rag-amber/50 bg-rag-amber/10 px-3 py-2.5 text-sm">
            <div className="mb-1 font-semibold">Closure requirements not met:</div>
            <ul className="list-inside list-disc space-y-0.5 text-xs">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
            <label className="mt-2 flex items-center gap-2 text-xs font-medium">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Close anyway (override for edge cases — logged to the activity trail)
            </label>
            {override && (
              <input className={inputCls + " mt-2"} placeholder="Override reason (required)" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
            )}
          </div>
        )}
        {error && <p className="text-sm text-rag-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit">Close project</Btn>
        </div>
      </form>
    </Modal>
  );
}

function AddTaskModal({ project, users, onClose, onAdded }: { project: Project; users: any[]; onClose: () => void; onAdded: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", description: "", due_date: "", assigned_to: "", priority_id: "", required: false });
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/api/projects/${project.id}/tasks`, {
        ...form,
        due_date: form.due_date || null,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
        priority_id: form.priority_id ? Number(form.priority_id) : null,
        user_id: currentUser?.id,
      });
      toast(`Added task "${form.name}"`, "success");
      onAdded(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to add task"); }
  }

  return (
    <Modal title="Add ad-hoc task" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Task name"><input className={inputCls} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Description"><textarea className={inputCls + " h-16"} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date"><input type="date" className={inputCls} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
          <Field label="Assigned to">
            <select className={inputCls} value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}>
              <option value="">—</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select className={inputCls} value={form.priority_id} onChange={(e) => setForm({ ...form, priority_id: e.target.value })}>
              <option value="">—</option>
              {activeValues("Task Priority").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
            Required for closure
          </label>
        </div>
        {error && <p className="text-sm text-rag-red">{error}</p>}
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" type="submit">Add task</Btn></div>
      </form>
    </Modal>
  );
}

function RagModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const { currentUser } = useSession();
  const toast = useToast();
  const [rag, setRag] = useState<string>(project.rag_overridden ? project.rag : "");
  const [reason, setReason] = useState(project.rag_overridden ? project.rag_reason : "");
  const [error, setError] = useState("");

  async function save(clear: boolean) {
    try {
      await api.post(`/api/projects/${project.id}/rag-override`, {
        rag: clear ? null : rag, reason: clear ? null : reason, user_id: currentUser?.id,
      });
      toast(clear ? "RAG back to auto-calculated." : `RAG manually set to ${rag.toUpperCase()}.`, "success");
      onSaved(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed"); }
  }

  return (
    <Modal title="RAG override" onClose={onClose}>
      <p className="mb-3 text-xs text-muted">
        RAG is auto-calculated (currently <b>{project.rag.toUpperCase()}</b>: {project.rag_reason}). A manual override wins until cleared, and the reason is logged to the activity trail (§4.7).
      </p>
      <div className="mb-3 flex gap-2">
        {(["red", "amber", "green"] as const).map((r) => (
          <button key={r} onClick={() => setRag(r)}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors ${rag === r ? "border-accent bg-accent-soft" : "border-hairline hover:bg-canvas"}`}>
            <RagChip rag={r} small />
          </button>
        ))}
      </div>
      <Field label="Override reason (required, audited)">
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why does the calculated RAG not reflect reality?" />
      </Field>
      {error && <p className="mt-2 text-sm text-rag-red">{error}</p>}
      <div className="mt-4 flex justify-between">
        {project.rag_overridden ? <Btn kind="danger" onClick={() => save(true)}>Clear override</Btn> : <span />}
        <div className="flex gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={() => save(false)} disabled={!rag || !reason.trim()}>Apply override</Btn>
        </div>
      </div>
    </Modal>
  );
}

export function SkipModal({ task, onCancel, onConfirm }: { task: Task; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal title={`Skip required task`} onClose={onCancel}>
      <p className="mb-3 text-sm">"<b>{task.name}</b>" is a required task. Skipping it needs a reason, which is recorded in the activity trail (§4.2).</p>
      <Field label="Skip reason">
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this step being skipped?" />
      </Field>
      <div className="mt-4 flex justify-end gap-2">
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" onClick={() => onConfirm(reason)} disabled={!reason.trim()}>Skip task</Btn>
      </div>
    </Modal>
  );
}

export function DecisionModal({ task, onCancel, onAnswer }: { task: Task; onCancel: () => void; onAnswer: (d: "yes" | "no") => void }) {
  return (
    <Modal title="Decision point" onClose={onCancel}>
      <p className="mb-4 text-sm">Completing "<b>{task.name}</b>" — does this customer need an action plan? Answering <b>Yes</b> generates the action-plan tasks from the template; <b>No</b> removes them (§4.4).</p>
      <div className="flex justify-end gap-2">
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => onAnswer("no")}>No action plan</Btn>
        <Btn kind="primary" onClick={() => onAnswer("yes")}>Yes — generate action plan</Btn>
      </div>
    </Modal>
  );
}

// ---------- Time tab ----------

function TimeTab({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [logs, setLogs] = useState<any[] | null>(null);
  const [form, setForm] = useState({ date: todayIso(), hours: "1", minutes: "0", project_task_id: "", activity_type_id: "", notes: "" });

  const load = useCallback(() => { api.get(`/api/timelogs?project_id=${project.id}`).then(setLogs); }, [project.id]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/timelogs", {
        project_id: project.id,
        project_task_id: form.project_task_id ? Number(form.project_task_id) : null,
        user_id: currentUser?.id,
        date: form.date,
        hours: Number(form.hours), minutes: Number(form.minutes),
        activity_type_id: form.activity_type_id ? Number(form.activity_type_id) : null,
        notes: form.notes,
      });
      toast("Time logged.", "success");
      setForm({ ...form, notes: "" });
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed to log time", "error"); }
  }

  const total = (logs ?? []).reduce((s, l) => s + l.total_minutes, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              {["Date", "User", "Task", "Duration", "Activity", "Notes"].map((h) => <th key={h} className="px-3 py-2.5 text-xs font-semibold text-muted">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {(logs ?? []).map((l, i) => (
              <tr key={l.id} className={`border-b border-hairline last:border-0 ${i % 2 ? "bg-rowalt" : ""}`}>
                <td className="px-3 py-2"><Mono>{fmtDate(l.date)}</Mono></td>
                <td className="px-3 py-2">{l.user_name}</td>
                <td className="px-3 py-2 text-muted">{l.task_name ?? "Project-level"}</td>
                <td className="px-3 py-2 text-right"><Mono>{fmtHours(l.total_minutes)}</Mono></td>
                <td className="px-3 py-2">{l.activity_type_label ? <Chip label={l.activity_type_label} color={l.activity_type_color} small /> : "—"}</td>
                <td className="px-3 py-2 text-muted">{l.notes}</td>
              </tr>
            ))}
            {logs?.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-muted">No time logged yet.</td></tr>}
          </tbody>
          {logs && logs.length > 0 && (
            <tfoot><tr className="border-t border-hairline font-medium">
              <td className="px-3 py-2" colSpan={3}>Total</td>
              <td className="px-3 py-2 text-right"><Mono>{fmtHours(total)}</Mono></td><td colSpan={2} />
            </tr></tfoot>
          )}
        </table>
      </Card>
      {!readOnly && (
        <Card className="h-fit p-4">
          <h3 className="mb-3 text-sm font-semibold">Log time</h3>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Date"><input type="date" className={inputCls} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Hours"><input type="number" min="0" className={inputCls} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></Field>
              <Field label="Minutes"><input type="number" min="0" max="59" step="15" className={inputCls} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} /></Field>
            </div>
            <Field label="Task (optional)" hint="Project-level time (e.g. a general customer call) is fine.">
              <select className={inputCls} value={form.project_task_id} onChange={(e) => setForm({ ...form, project_task_id: e.target.value })}>
                <option value="">Project-level</option>
                {(project.tasks ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Activity type">
              <select className={inputCls} value={form.activity_type_id} onChange={(e) => setForm({ ...form, activity_type_id: e.target.value })}>
                <option value="">—</option>
                {activeValues("Time Log Activity Type").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Notes"><input className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            <Btn kind="primary" type="submit">Log time</Btn>
          </form>
        </Card>
      )}
    </div>
  );
}

// ---------- Notes / Activity + History tabs ----------

function NotesTab({ project, readOnly, kind }: { project: Project; readOnly: boolean; kind: "note" | "all" }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [items, setItems] = useState<any[] | null>(null);
  const [note, setNote] = useState("");
  const [catId, setCatId] = useState<number>(activeValues("Note Category").find((v) => v.is_default)?.id ?? 0);

  const load = useCallback(() => {
    api.get(`/api/activities?project_id=${project.id}${kind === "note" ? "&kind=note" : ""}`).then(setItems);
  }, [project.id, kind]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/activities", { project_id: project.id, user_id: currentUser?.id, category_id: catId || null, note });
      setNote(""); load();
      toast("Note added.", "success");
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  return (
    <div className="space-y-4">
      {kind === "note" && !readOnly && (
        <Card className="p-4">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Field label="New note"><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" /></Field>
            </div>
            <Field label="Category">
              <select className={inputCls + " !w-auto"} value={catId} onChange={(e) => setCatId(Number(e.target.value))}>
                {activeValues("Note Category").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </Field>
            <Btn kind="primary" type="submit" disabled={!note.trim()}>Add note</Btn>
          </form>
        </Card>
      )}
      {readOnly && kind === "note" && <p className="text-xs text-muted">Historical notes are read-only once a project is closed (§4.6).</p>}
      <Card>
        <ul className="divide-y divide-hairline">
          {(items ?? []).map((a) => (
            <li key={a.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-canvas font-mono text-[11px] font-semibold text-muted">
                {a.user_name.split(" ").map((s: string) => s[0]).join("").slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-medium text-ink">{a.user_name}</span>
                  <Mono>{a.activity_date?.slice(0, 16).replace("T", " ")}</Mono>
                  {a.category_label && <Chip label={a.category_label} color={a.category_color} small />}
                  {a.kind === "status_change" && <span className="rounded bg-canvas px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide">status</span>}
                  {a.task_name && <span>· {a.task_name}</span>}
                </div>
                <p className="mt-0.5 text-sm">{a.note}</p>
              </div>
            </li>
          ))}
          {items?.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">Nothing here yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
