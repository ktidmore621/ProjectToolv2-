import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Activity, api, ApiError, fmtDate, fmtHours, fmtTime, Project, Task, todayIso, Win } from "../api";
import { ActivityDrawer } from "../components/ActivityDrawer";
import { canEditActivity, EditActivityButton, EditActivityModal } from "../components/EditActivityModal";
import { CustomFieldInputs, renderProjectField, renderTaskField, useCustomFields, useLayout } from "../components/fields";
import { ActivityTypeIcon, EditIcon, TrophyIcon } from "../components/icons";
import { Page } from "../components/Layout";
import { TaskKanban } from "../components/TaskKanban";
import { ConfirmDeleteTaskModal, TaskModal } from "../components/TaskModal";
import { TrashIcon } from "../components/icons";
import { Btn, Card, Chip, CsvLink, EmptyState, Field, inputCls, Modal, Mono, RagChip, Skeleton, tint } from "../components/ui";
import { useConfig, useSession, useToast } from "../state";

type Tab = "tasks" | "wins" | "time" | "notes" | "history";
const TABS: Tab[] = ["tasks", "wins", "time", "notes", "history"];

export function ProjectDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { currentUser, users } = useSession();
  const { activeValues } = useConfig();
  const toast = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [taskView, setTaskView] = useState<"list" | "kanban">("list");
  const [showEdit, setShowEdit] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showRag, setShowRag] = useState(false);
  const [skipTask, setSkipTask] = useState<{ task: Task; statusId: number } | null>(null);
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [drawerTask, setDrawerTask] = useState<Task | null>(null);
  const [highlightActivity, setHighlightActivity] = useState<number | null>(null);
  const headerFields = useLayout("project_header");
  const taskColumns = useLayout("task_list");

  const load = useCallback(() => { api.get<Project>(`/api/projects/${id}`).then(setProject); }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (params.get("close")) { setShowClose(true); setParams({}, { replace: true }); }
    const t = params.get("tab");
    if (t && TABS.includes(t as Tab)) {
      setTab(t as Tab);
      const act = params.get("activity");
      if (act) setHighlightActivity(Number(act));
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  // Keep the open task modal in sync after edits reload the project
  useEffect(() => {
    if (detailTask && project?.tasks) {
      const fresh = (project.tasks as Task[]).find((t) => t.id === detailTask.id);
      if (fresh && fresh !== detailTask) setDetailTask(fresh);
    }
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  /** E4: permanent, confirmed deletion — time logs & activities are preserved at project level. */
  async function confirmDeleteTask(task: Task) {
    try {
      await api.del(`/api/tasks/${task.id}?user_id=${currentUser?.id}`);
      toast(`Deleted task "${task.name}". Its time logs and activity history stay on the project.`, "success");
      setDeleteTask(null);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
      setDeleteTask(null);
    }
  }

  /** Shared task status change — same rules from list, kanban, or dropdown (§4.2). */
  async function changeTaskStatus(task: Task, statusId: number, extra?: { skip_reason?: string }) {
    try {
      const r = await api.post(`/api/tasks/${task.id}/status`, { status_id: statusId, user_id: currentUser?.id, ...extra });
      if (r.warning) toast(r.warning, "warning");
      else toast(`"${task.name}" is now ${r.task.status_label}`, "success");
      load();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.body?.needs_skip_reason) { setSkipTask({ task, statusId }); return false; }
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
            <Btn onClick={() => setShowEdit(true)}>Edit project</Btn>
            <Btn onClick={() => setShowRag(true)}>RAG override</Btn>
            <StatusSelect project={project} onChanged={load} />
            {/* E5: cancellation goes through the same closure workflow */}
            <Btn kind="danger" onClick={() => setShowCancel(true)}>Cancel project</Btn>
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
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? "border-primary text-primary" : "border-transparent text-muted hover:text-ink"}`}>
            {t === "notes" ? "Notes & Activity" : t}
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
                  {taskColumns.map((c) => (
                    <td key={c.field_key} className="px-3 py-2">
                      {c.field_key === "name" ? (
                        <button className="text-left hover:underline" onClick={() => setDetailTask(t)}
                          aria-label={`Open ${t.name}`}>
                          {renderTaskField("name", t)}
                          {t.latest_note && <span className="mt-0.5 block max-w-sm truncate text-[11px] font-normal text-muted">{t.latest_note.note}</span>}
                        </button>
                      ) : c.field_key === "activity_count" && t.activity_count ? (
                        <button
                          onClick={() => setDrawerTask(t)}
                          aria-label={`${t.activity_count} linked activities for ${t.name}`}
                          className="rounded-full bg-accent-soft px-2.5 py-0.5 font-mono text-xs font-semibold text-accent transition-colors hover:bg-accent hover:text-white"
                        >
                          {t.activity_count}
                        </button>
                      ) : (
                        renderTaskField(c.field_key, t)
                      )}
                    </td>
                  ))}
                  {!readOnly && (
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                      <select
                        aria-label={`Status of ${t.name}`}
                        className="rounded-lg border border-hairline bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                        value={t.status_id}
                        onChange={(e) => changeTaskStatus(t, Number(e.target.value))}
                      >
                        {/* keep the current (possibly archived/deactivated) value rendering correctly */}
                        {!activeValues("Task Status").some((v) => v.id === t.status_id) && (
                          <option value={t.status_id} disabled>{t.status_label}</option>
                        )}
                        {activeValues("Task Status").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                      {/* E4: Delete replaces Skipped as the way to drop a task */}
                      <button onClick={() => setDeleteTask(t)} aria-label={`Delete ${t.name}`} title="Delete this task"
                        className="rounded p-1 text-muted transition-colors hover:bg-canvas hover:text-rag-red">
                        <TrashIcon size={14} />
                      </button>
                      </span>
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

      {tab === "wins" && <WinsTab project={project} readOnly={readOnly} />}
      {tab === "time" && <TimeTab project={project} readOnly={readOnly} />}
      {tab === "notes" && (
        <NotesTab project={project} readOnly={readOnly} kind="note"
          highlightId={highlightActivity} onHighlighted={() => setHighlightActivity(null)} onChanged={load} />
      )}
      {tab === "history" && <NotesTab project={project} readOnly={readOnly} kind="all" onChanged={load} />}

      {detailTask && (
        <TaskModal task={detailTask} project={project} readOnly={readOnly}
          onClose={() => setDetailTask(null)} onChanged={load} />
      )}
      {drawerTask && (
        <ActivityDrawer taskId={drawerTask.id} taskName={drawerTask.name} readOnly={readOnly}
          onClose={() => setDrawerTask(null)} onChanged={load} />
      )}
      {showEdit && <EditProjectModal project={project} onClose={() => setShowEdit(false)} onSaved={load} />}
      {showClose && <CloseModal project={project} onClose={() => setShowClose(false)} onClosed={load} />}
      {showCancel && <CloseModal project={project} cancel onClose={() => setShowCancel(false)} onClosed={load} />}
      {showAddTask && <AddTaskModal project={project} users={users} onClose={() => setShowAddTask(false)} onAdded={load} />}
      {showRag && <RagModal project={project} onClose={() => setShowRag(false)} onSaved={load} />}
      {deleteTask && (
        <ConfirmDeleteTaskModal task={deleteTask} onCancel={() => setDeleteTask(null)} onConfirm={() => confirmDeleteTask(deleteTask)} />
      )}
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
    </Page>
  );
}

function StatusSelect({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  // Closing and cancelling both go through the closure workflow, not a status flip (E5)
  const options = activeValues("Project Status").filter((v) => !["closed", "cancelled"].includes(v.maps_to ?? ""));
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

/**
 * Post-creation project edits — MCP name, assignee, AP, dates, risk and every
 * custom field. Changing the assignee asks whether open tasks should follow;
 * Closed/Complete tasks are never touched either way.
 */
function EditProjectModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const { users, currentUser } = useSession();
  const { activeValues } = useConfig();
  const customFields = useCustomFields();
  const toast = useToast();
  const [form, setForm] = useState({
    mcp_name: project.mcp_name,
    project_name: project.project_name ?? "",
    assignee_id: String(project.assignee_id),
    annualized_premium: project.annualized_premium != null ? String(project.annualized_premium) : "",
    target_date: project.target_date ?? "",
    risk_level_id: project.risk_level_id ? String(project.risk_level_id) : "",
  });
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(project.custom ?? {}).map(([k, v]) => [k, v.value ?? ""]))
  );
  const [confirmReassign, setConfirmReassign] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const newAssignee = users.find((u) => u.id === Number(form.assignee_id));
  const assigneeChanged = Number(form.assignee_id) !== project.assignee_id;

  async function save(reassignOpenTasks: boolean) {
    setBusy(true); setError("");
    try {
      await api.patch(`/api/projects/${project.id}`, {
        mcp_name: form.mcp_name,
        project_name: form.project_name.trim() || null,
        assignee_id: Number(form.assignee_id),
        annualized_premium: Number(form.annualized_premium),
        target_date: form.target_date || null,
        risk_level_id: form.risk_level_id ? Number(form.risk_level_id) : null,
        custom,
        user_id: currentUser?.id,
        reassign_open_tasks: reassignOpenTasks,
      });
      toast(
        assigneeChanged && reassignOpenTasks
          ? `Project updated — open tasks reassigned to ${newAssignee?.name}.`
          : "Project updated.",
        "success"
      );
      onSaved(); onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
      setConfirmReassign(false);
    } finally { setBusy(false); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (assigneeChanged) setConfirmReassign(true); // ask about the task cascade first
    else save(false);
  }

  return (
    // While the nested confirm dialog is open, Escape/backdrop should close it alone
    <Modal title={`Edit ${project.project_code} — ${project.mcp_name}`} onClose={() => !confirmReassign && onClose()} wide>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="MCP Name"><input className={inputCls} required value={form.mcp_name} onChange={(e) => setForm({ ...form, mcp_name: e.target.value })} /></Field>
        <Field label="Project Name (optional)">
          <input className={inputCls} value={form.project_name} onChange={(e) => setForm({ ...form, project_name: e.target.value })} />
        </Field>
        <Field label="Assignee">
          <select className={inputCls} required value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Annualized Premium (AP)">
          <input type="number" min="0" step="0.01" className={inputCls} required value={form.annualized_premium}
            onChange={(e) => setForm({ ...form, annualized_premium: e.target.value })} placeholder="e.g. 12500.00" />
        </Field>
        <Field label="Estimated completion date">
          <input type="date" className={inputCls} value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} />
        </Field>
        <Field label="Risk level">
          <select className={inputCls} value={form.risk_level_id} onChange={(e) => setForm({ ...form, risk_level_id: e.target.value })}>
            <option value="">—</option>
            {activeValues("Risk Level").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        <CustomFieldInputs fields={customFields} values={custom} onChange={(k, v) => setCustom((c) => ({ ...c, [k]: v }))} />
        {error && <p className="col-span-2 text-sm text-rag-red">{error}</p>}
        <div className="col-span-2 flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Btn>
        </div>
      </form>
      {confirmReassign && (
        <Modal title="Update task assignments?" onClose={() => setConfirmReassign(false)}>
          <p className="mb-2 text-sm">
            Would you like to update all project tasks to this same assignee?
          </p>
          <p className="mb-4 text-xs text-muted">
            <b>Yes</b> reassigns every open task to {newAssignee?.name}. Closed/Complete tasks are historical records and are never changed.
            <b> No</b> changes only the project assignee and leaves task assignments as they are.
          </p>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setConfirmReassign(false)} disabled={busy}>Cancel</Btn>
            <Btn onClick={() => save(false)} disabled={busy}>No — just the project</Btn>
            <Btn kind="primary" onClick={() => save(true)} disabled={busy}>Yes — update open tasks</Btn>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/**
 * Close (or, with `cancel`, cancel — E5) a project. Both paths share the same
 * closure processing server-side: audit trail, permanent read-only state,
 * historical treatment, and RAG-override clearing (B2). Cancellation requires
 * a Close Reason but not a Final Summary — a cancelled project often has no
 * outcome to summarize.
 */
function CloseModal({ project, cancel, onClose, onClosed }: { project: Project; cancel?: boolean; onClose: () => void; onClosed: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [summary, setSummary] = useState("");
  const [reasonId, setReasonId] = useState<number>(() =>
    cancel
      ? activeValues("Close Reason").find((v) => v.maps_to === "cancelled")?.id ?? 0
      : activeValues("Close Reason").find((v) => v.is_default)?.id ?? 0
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState("");
  const verb = cancel ? "Cancel" : "Close";

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
        cancelled: cancel || undefined,
      });
      toast(`${project.mcp_name} ${cancel ? "cancelled" : "closed"}. It's now a permanent historical record.`, "success");
      onClosed(); onClose();
    } catch (err) {
      if (err instanceof ApiError && err.body?.problems) {
        setProblems(err.body.problems);
        setError(err.body.problems.length ? "" : err.message);
        if (!err.body.problems.length) setError(err.message);
      } else setError(err instanceof Error ? err.message : `${verb} failed`);
    }
  }

  return (
    <Modal title={`${verb} ${project.project_code} — ${project.mcp_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">
          {cancel
            ? "Cancelling is permanent — like closing, the project becomes a read-only historical record and is never reopened. A close reason is required; a final summary is optional."
            : "Closing is permanent — closed projects are never reopened (§2.2). All required tasks must be Complete (or deleted if they'll never be done; tasks skipped before Skipped was retired still count)."}
        </p>
        <Field label={cancel ? "Final summary (optional)" : "Final summary"}>
          <textarea className={inputCls + " h-24"} value={summary} onChange={(e) => setSummary(e.target.value)}
            placeholder={cancel ? "Anything worth recording about why this ended early" : "Where did this engagement leave the customer's billing position?"} />
        </Field>
        <Field label={cancel ? "Close reason (required)" : "Close reason"}>
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
          <Btn onClick={onClose}>Back</Btn>
          <Btn kind="primary" type="submit">{verb} project</Btn>
        </div>
      </form>
    </Modal>
  );
}

function AddTaskModal({ project, users, onClose, onAdded }: { project: Project; users: any[]; onClose: () => void; onAdded: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", description: "", due_date: "", assigned_to: "", priority_id: "", required: false, initial_note: "" });
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
        <Field label="Initial note (optional)" hint="Starts the task's note history — no separate step needed.">
          <input className={inputCls} value={form.initial_note} onChange={(e) => setForm({ ...form, initial_note: e.target.value })} placeholder="Context for whoever picks this up" />
        </Field>
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

// ---------- Notes & Activity + History tabs (expanded per v2 §5) ----------

type RecordFilter = "all" | "notes" | "activities";

function NotesTab({ project, readOnly, kind, highlightId, onHighlighted, onChanged }: {
  project: Project;
  readOnly: boolean;
  kind: "note" | "all";
  highlightId?: number | null;
  onHighlighted?: () => void;
  onChanged?: () => void;
}) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [items, setItems] = useState<Activity[] | null>(null);
  const [filter, setFilter] = useState<RecordFilter>("all");
  const [note, setNote] = useState("");
  const [catId, setCatId] = useState<number>(activeValues("Note Category").find((v) => v.is_default)?.id ?? 0);
  const [showLog, setShowLog] = useState(false);
  const [editItem, setEditItem] = useState<Activity | null>(null);
  const highlightRef = useRef<HTMLLIElement | null>(null);

  const kindParam = kind === "all" ? "" : filter === "notes" ? "&kind=note" : filter === "activities" ? "&kind=activity" : "&kind=note,activity";
  const load = useCallback(() => {
    api.get<Activity[]>(`/api/activities?project_id=${project.id}${kindParam}`).then(setItems);
  }, [project.id, kindParam]);
  useEffect(load, [load]);

  useEffect(() => {
    if (highlightId && items && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: "center" });
      const t = setTimeout(() => onHighlighted?.(), 2500);
      return () => clearTimeout(t);
    }
  }, [highlightId, items, onHighlighted]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/activities", { project_id: project.id, user_id: currentUser?.id, category_id: catId || null, note });
      setNote(""); load(); onChanged?.();
      toast("Note added.", "success");
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  const filterBtn = (f: RecordFilter, label: string) => (
    <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${filter === f ? "bg-primary-soft text-primary" : "text-muted hover:text-ink"}`}>
      {label}
    </button>
  );

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
            <Btn onClick={() => setShowLog(true)}>Log activity…</Btn>
          </form>
        </Card>
      )}
      {readOnly && kind === "note" && <p className="text-xs text-muted">Historical notes are read-only once a project is closed (§4.6).</p>}
      {kind === "note" && (
        <div className="flex items-center rounded-lg border border-hairline bg-surface p-0.5 w-fit" role="group" aria-label="Record type filter">
          {filterBtn("all", "All records")}
          {filterBtn("notes", "Notes only")}
          {filterBtn("activities", "Activities only")}
        </div>
      )}
      <Card>
        <ul className="divide-y divide-hairline">
          {(items ?? []).map((a) => (
            <li key={a.id} ref={a.id === highlightId ? highlightRef : undefined}
              className={`flex items-start gap-3 px-4 py-3 transition-colors ${a.id === highlightId ? "bg-accent-soft" : ""}`}>
              {a.kind === "activity" ? (
                <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full"
                  style={{ backgroundColor: tint(a.activity_type_color ?? "#5C6B84", 0.15), color: a.activity_type_color ?? "#5C6B84" }}>
                  <ActivityTypeIcon typeKey={a.activity_type_key} />
                </span>
              ) : (
                <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-canvas font-mono text-[11px] font-semibold text-muted">
                  {a.user_name.split(" ").map((s: string) => s[0]).join("").slice(0, 2)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-medium text-ink">{a.user_name}</span>
                  <Mono>{a.activity_date?.slice(0, 16).replace("T", " ")}</Mono>
                  {a.kind === "activity" && a.activity_type_label && <Chip label={a.activity_type_label} color={a.activity_type_color!} small />}
                  {a.kind === "activity" && a.start_time && (
                    <span>
                      <Mono>{fmtTime(a.start_time)}{a.end_time ? ` – ${fmtTime(a.end_time)}` : ""}</Mono>
                      {a.duration_minutes != null && <> · {fmtHours(a.duration_minutes)}</>}
                    </span>
                  )}
                  {a.category_label && <Chip label={a.category_label} color={a.category_color!} small />}
                  {a.kind === "status_change" && <span className="rounded bg-canvas px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide">status</span>}
                  {a.task_name && <span>· {a.task_name}</span>}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{a.note}</p>
                {a.linked_tasks.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span>Linked tasks:</span>
                    {a.linked_tasks.map((t) => (
                      <span key={t.id} className="rounded bg-canvas px-1.5 py-px">{t.name}</span>
                    ))}
                  </div>
                )}
              </div>
              {!readOnly && canEditActivity(a, currentUser) && (
                <EditActivityButton activity={a} onEdit={() => setEditItem(a)} className="mt-0.5 shrink-0" />
              )}
            </li>
          ))}
          {items?.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">Nothing here yet.</li>}
        </ul>
      </Card>
      {showLog && (
        <LogActivityModal project={project} onClose={() => setShowLog(false)}
          onLogged={() => { load(); onChanged?.(); }} />
      )}
      {editItem && (
        <EditActivityModal activity={editItem} onClose={() => setEditItem(null)}
          onSaved={() => { load(); onChanged?.(); }} />
      )}
    </div>
  );
}

/**
 * Log a customer interaction (v2 §5): type, date, start/end time, notes —
 * linkable to any number of the project's tasks in the same action.
 */
function LogActivityModal({ project, onClose, onLogged }: { project: Project; onClose: () => void; onLogged: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const types = activeValues("Activity Type");
  const [form, setForm] = useState({
    activity_type_id: types.find((v) => v.is_default)?.id ?? types[0]?.id ?? 0,
    activity_date: todayIso(),
    start_time: "",
    end_time: "",
    note: "",
  });
  const [taskIds, setTaskIds] = useState<number[]>([]);
  const [error, setError] = useState("");

  function toggleTask(id: number) {
    setTaskIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post("/api/activities", {
        project_id: project.id,
        user_id: currentUser?.id,
        kind: "activity",
        activity_type_id: Number(form.activity_type_id),
        activity_date: form.activity_date,
        start_time: form.start_time || null,
        end_time: form.end_time || null,
        note: form.note,
        task_ids: taskIds,
      });
      toast("Activity logged.", "success");
      onLogged(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to log activity"); }
  }

  return (
    <Modal title="Log activity" onClose={onClose} wide>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Activity type">
          <select className={inputCls} value={form.activity_type_id} onChange={(e) => setForm({ ...form, activity_type_id: Number(e.target.value) })}>
            {types.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" className={inputCls} required value={form.activity_date} onChange={(e) => setForm({ ...form, activity_date: e.target.value })} />
        </Field>
        <Field label="Start time">
          <input type="time" className={inputCls} value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
        </Field>
        <Field label="End time">
          <input type="time" className={inputCls} value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
        </Field>
        <div className="col-span-2">
          <Field label="Notes / comments">
            <textarea className={inputCls + " h-20"} required value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="What was discussed or done?" />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={`Link to tasks (${taskIds.length} selected)`} hint="One activity can link to any number of tasks; tasks can hold many activities.">
            <div className="max-h-40 overflow-y-auto rounded-lg border border-hairline p-2">
              {(project.tasks ?? []).map((t) => (
                <label key={t.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-canvas">
                  <input type="checkbox" checked={taskIds.includes(t.id)} onChange={() => toggleTask(t.id)} />
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto text-[11px] text-muted">{t.status_label}</span>
                </label>
              ))}
            </div>
          </Field>
        </div>
        {error && <p className="col-span-2 text-sm text-rag-red">{error}</p>}
        <div className="col-span-2 flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={!form.note.trim()}>Log activity</Btn>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Wins tab (v2 §3) ----------

/** Portfolio-wide wins export with an occurred-date range (v2 §3 acceptance). */
export function WinsExportCard() {
  const [range, setRange] = useState({ start: "", end: "" });
  const qs = new URLSearchParams();
  if (range.start) qs.set("start", range.start);
  if (range.end) qs.set("end", range.end);
  return (
    <Card className="h-fit p-4">
      <h3 className="mb-1 text-sm font-semibold">Portfolio wins report</h3>
      <p className="mb-3 text-xs text-muted">One export covering wins across <b>all</b> projects — for reporting and leadership decks. Leave the dates empty for everything.</p>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Field label="From"><input type="date" className={inputCls} value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} /></Field>
        <Field label="To"><input type="date" className={inputCls} value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} /></Field>
      </div>
      <CsvLink href={`/api/export/wins.csv${qs.toString() ? `?${qs}` : ""}`}>Export wins (CSV)</CsvLink>
    </Card>
  );
}

function WinsTab({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [wins, setWins] = useState<Win[] | null>(null);
  const [editWin, setEditWin] = useState<Win | null>(null);
  const [form, setForm] = useState({ description: "", category_id: "", occurred_date: todayIso() });

  const load = useCallback(() => { api.get<Win[]>(`/api/wins?project_id=${project.id}`).then(setWins); }, [project.id]);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/wins", {
        project_id: project.id,
        description: form.description,
        category_id: form.category_id ? Number(form.category_id) : null,
        occurred_date: form.occurred_date,
        user_id: currentUser?.id,
      });
      toast("Win logged. 🎉", "success");
      setForm({ ...form, description: "" });
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed to log win", "error"); }
  }

  // B4: deletion is author-only and audited server-side
  async function remove(w: Win) {
    try {
      await api.del(`/api/wins/${w.id}?user_id=${currentUser?.id}`);
      toast("Win removed.", "info");
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {wins?.length === 0 && (
          <EmptyState title="No wins logged yet" hint="Wins can be recorded at any point — not just at closure." />
        )}
        {(wins ?? []).map((w) => (
          <Card key={w.id} className="flex items-start gap-3 p-4">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full"
              style={{ backgroundColor: tint(w.category_color ?? "#4E9468", 0.15), color: w.category_color ?? "#4E9468" }}>
              <TrophyIcon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{w.description}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                {w.category_label && <Chip label={w.category_label} color={w.category_color!} small />}
                <span>Occurred <Mono>{fmtDate(w.occurred_date)}</Mono></span>
                <span>· Logged <Mono>{fmtDate(w.logged_date)}</Mono>{w.logged_by_name && <> by {w.logged_by_name}</>}</span>
              </div>
            </div>
            {/* E8/B4: edit and delete are author-only, enforced server-side too */}
            {!readOnly && currentUser && w.logged_by === currentUser.id && (
              <span className="flex shrink-0 items-center gap-0.5">
                <button onClick={() => setEditWin(w)} aria-label="Edit win" title="Edit this win"
                  className="rounded p-1 text-muted hover:bg-canvas hover:text-ink"><EditIcon size={14} /></button>
                <button onClick={() => remove(w)} aria-label="Remove win" className="rounded p-1 text-muted hover:bg-canvas hover:text-rag-red">✕</button>
              </span>
            )}
          </Card>
        ))}
      </div>
      <div className="space-y-4">
        {!readOnly && (
          <Card className="h-fit p-4">
            <h3 className="mb-3 text-sm font-semibold">Log a win</h3>
            <form onSubmit={submit} className="space-y-3">
              <Field label="What happened?">
                <textarea className={inputCls + " h-20"} required value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="e.g. Recovered $4,200 in misapplied charges" />
              </Field>
              <Field label="Category (optional)">
                <select className={inputCls} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
                  <option value="">—</option>
                  {activeValues("Win Category").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
              </Field>
              <Field label="When it happened">
                <input type="date" className={inputCls} required value={form.occurred_date}
                  onChange={(e) => setForm({ ...form, occurred_date: e.target.value })} />
              </Field>
              <Btn kind="primary" type="submit" disabled={!form.description.trim()}>Log win</Btn>
            </form>
          </Card>
        )}
        <WinsExportCard />
      </div>
      {editWin && (
        <EditWinModal win={editWin} onClose={() => setEditWin(null)} onSaved={() => { setEditWin(null); load(); }} />
      )}
    </div>
  );
}

/**
 * E8: in-place, author-only win editing — same shape as EditActivityModal
 * (same fields captured at creation, saved as a correction under the same ID,
 * recorded in the audit trail server-side).
 */
function EditWinModal({ win, onClose, onSaved }: { win: Win; onClose: () => void; onSaved: () => void }) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const [form, setForm] = useState({
    description: win.description,
    category_id: win.category_id ? String(win.category_id) : "",
    occurred_date: win.occurred_date,
  });
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.patch(`/api/wins/${win.id}`, {
        user_id: currentUser?.id,
        description: form.description,
        category_id: form.category_id ? Number(form.category_id) : null,
        occurred_date: form.occurred_date,
      });
      toast("Win updated.", "success");
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : "Update failed"); }
  }

  return (
    <Modal title="Edit win" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="What happened?">
          <textarea className={inputCls + " h-20"} required value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Category">
          <select className={inputCls} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
            <option value="">—</option>
            {activeValues("Win Category").filter((v) => v.is_active || String(v.id) === form.category_id).map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </Field>
        <Field label="When it happened">
          <input type="date" className={inputCls} required value={form.occurred_date}
            onChange={(e) => setForm({ ...form, occurred_date: e.target.value })} />
        </Field>
        {error && <p className="text-sm text-rag-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={!form.description.trim()}>Save changes</Btn>
        </div>
      </form>
    </Modal>
  );
}
