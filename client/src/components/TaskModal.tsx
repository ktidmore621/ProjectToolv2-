import { FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, api, ApiError, fmtDate, fmtHours, fmtTime, Project, Task, todayIso } from "../api";
import { useConfig, useSession, useToast } from "../state";
import { canEditActivity, EditActivityButton, EditActivityModal } from "./EditActivityModal";
import { ActivityTypeIcon, TrashIcon } from "./icons";
import { Btn, Chip, Field, inputCls, Modal, Mono, tint } from "./ui";

/**
 * Task detail (v2 §4 + §6): edit the task, change its status (E2), log time
 * against it (E1), keep an append-only note history with the latest note
 * surfaced first, see linked activities, and delete it (E4) — all without
 * leaving the task.
 */
export function TaskModal({ task, project, readOnly, onClose, onChanged, onDeleted }: {
  task: Task;
  project: Project;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** Called after the task is deleted (E4). Defaults to onChanged. */
  onDeleted?: () => void;
}) {
  const { users, currentUser } = useSession();
  const { activeValues } = useConfig();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: task.name,
    description: task.description ?? "",
    due_date: task.due_date ?? "",
    assigned_to: task.assigned_to ? String(task.assigned_to) : "",
    priority_id: task.priority_id ? String(task.priority_id) : "",
  });
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState<Activity[] | null>(null);
  const [showAllNotes, setShowAllNotes] = useState(false);
  const [linked, setLinked] = useState<Activity[] | null>(null);
  const [editRecord, setEditRecord] = useState<Activity | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logs, setLogs] = useState<any[] | null>(null);
  const [timeForm, setTimeForm] = useState({ date: todayIso(), hours: "1", minutes: "0", activity_type_id: "", notes: "" });

  const loadNotes = useCallback(() => {
    api.get<Activity[]>(`/api/activities?task_id=${task.id}&kind=note`).then(setNotes);
  }, [task.id]);
  useEffect(loadNotes, [loadNotes]);
  const loadLinked = useCallback(() => {
    api.get<Activity[]>(`/api/tasks/${task.id}/activities`).then(setLinked);
  }, [task.id]);
  useEffect(loadLinked, [loadLinked]);
  // E1: same records as the Time Log area, filtered to this task
  const loadLogs = useCallback(() => {
    api.get<any[]>(`/api/timelogs?task_id=${task.id}`).then(setLogs);
  }, [task.id]);
  useEffect(loadLogs, [loadLogs]);

  /** E2: status changes from the modal go through the same endpoint as list/Kanban. */
  async function changeStatus(statusId: number) {
    try {
      const r = await api.post(`/api/tasks/${task.id}/status`, { status_id: statusId, user_id: currentUser?.id });
      if (r.warning) toast(r.warning, "warning");
      else toast(`"${task.name}" is now ${r.task.status_label}`, "success");
      onChanged(); // list/Kanban views refresh through the parent reload
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Status update failed", "error");
    }
  }

  /** E1: log time directly from the task — lands in the shared time_logs store. */
  async function logTime() {
    try {
      await api.post("/api/timelogs", {
        project_id: project.id,
        project_task_id: task.id,
        user_id: currentUser?.id,
        date: timeForm.date,
        hours: Number(timeForm.hours),
        minutes: Number(timeForm.minutes),
        activity_type_id: timeForm.activity_type_id ? Number(timeForm.activity_type_id) : null,
        notes: timeForm.notes,
      });
      toast("Time logged.", "success");
      setTimeForm({ ...timeForm, notes: "" });
      loadLogs();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed to log time", "error"); }
  }

  /** E4: permanent delete with confirmation; time logs & activities are preserved at project level. */
  async function deleteTask() {
    try {
      await api.del(`/api/tasks/${task.id}?user_id=${currentUser?.id}`);
      toast(`Deleted task "${task.name}". Its time logs and activity history stay on the project.`, "success");
      setConfirmDelete(false);
      onClose();
      (onDeleted ?? onChanged)();
    } catch (err) { toast(err instanceof Error ? err.message : "Delete failed", "error"); }
  }

  const totalMinutes = (logs ?? []).reduce((s, l) => s + l.total_minutes, 0);

  async function saveFields(e: FormEvent) {
    e.preventDefault();
    try {
      await api.patch(`/api/tasks/${task.id}`, {
        name: form.name,
        description: form.description,
        due_date: form.due_date || null,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
        priority_id: form.priority_id ? Number(form.priority_id) : null,
      });
      toast("Task updated.", "success");
      onChanged();
    } catch (err) { toast(err instanceof Error ? err.message : "Update failed", "error"); }
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      await api.post("/api/activities", {
        project_id: project.id,
        project_task_id: task.id,
        user_id: currentUser?.id,
        note: note.trim(),
      });
      setNote("");
      loadNotes();
      onChanged(); // refresh latest_note / note_count on the list
      toast("Note added.", "success");
    } catch (err) { toast(err instanceof Error ? err.message : "Failed to add note", "error"); }
  }

  const visibleNotes = showAllNotes ? notes ?? [] : (notes ?? []).slice(0, 1);

  return (
    // While a nested dialog is open, Escape/backdrop should close it alone
    <Modal title={task.name} onClose={() => !editRecord && !confirmDelete && onClose()} wide>
      <div className="grid gap-5 md:grid-cols-2">
        {/* Left: task fields */}
        <form onSubmit={saveFields} className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted">
            {readOnly ? (
              <Chip label={task.status_label} color={task.status_color} small />
            ) : (
              /* E2: status editable right here — persists and reflects on list/Kanban without a refresh */
              <select
                aria-label="Task status"
                className="rounded-lg border border-hairline bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                value={task.status_id}
                onChange={(e) => changeStatus(Number(e.target.value))}
              >
                {!activeValues("Task Status").some((v) => v.id === task.status_id) && (
                  <option value={task.status_id} disabled>{task.status_label}</option>
                )}
                {activeValues("Task Status").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            )}
            {task.required ? <span className="rounded bg-primary-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">Required</span> : null}
            <span className="capitalize">{task.task_type.replace("_", " ")}</span>
            {!readOnly && (
              <button type="button" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${task.name}`}
                title="Delete this task" className="ml-auto rounded p-1 text-muted transition-colors hover:bg-canvas hover:text-rag-red">
                <TrashIcon size={15} />
              </button>
            )}
          </div>
          <Field label="Task name">
            <input className={inputCls} value={form.name} disabled={readOnly}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea className={inputCls + " h-16"} value={form.description} disabled={readOnly}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due date">
              <input type="date" className={inputCls} value={form.due_date} disabled={readOnly}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </Field>
            <Field label="Assigned to">
              <select className={inputCls} value={form.assigned_to} disabled={readOnly}
                onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}>
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Priority">
            <select className={inputCls} value={form.priority_id} disabled={readOnly}
              onChange={(e) => setForm({ ...form, priority_id: e.target.value })}>
              <option value="">—</option>
              {activeValues("Task Priority").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </Field>
          {!readOnly && <Btn kind="primary" type="submit">Save task</Btn>}

          {/* Linked activities (§6) */}
          <div className="border-t border-hairline pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Linked activities · {linked?.length ?? 0}</h3>
            {linked?.length === 0 && <p className="text-xs text-muted">None yet — log one from the Notes & Activity tab.</p>}
            <ul className="space-y-2">
              {(linked ?? []).map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-xs">
                  <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full"
                    style={{ backgroundColor: tint(a.activity_type_color ?? "#5C6B84", 0.15), color: a.activity_type_color ?? "#5C6B84" }}>
                    <ActivityTypeIcon typeKey={a.activity_type_key} size={12} />
                  </span>
                  <span className="min-w-0">
                    <button type="button" className="font-medium hover:underline"
                      onClick={() => { onClose(); navigate(`/projects/${a.project_id}?tab=notes&activity=${a.id}`); }}>
                      {a.activity_type_label ?? "Activity"}
                    </button>
                    <span className="text-muted"> · <Mono>{fmtDate(a.activity_date)}</Mono>
                      {a.duration_minutes != null && <> · {fmtHours(a.duration_minutes)}</>} · {a.user_name}</span>
                  </span>
                  {!readOnly && canEditActivity(a, currentUser) && (
                    <EditActivityButton activity={a} onEdit={() => setEditRecord(a)} className="ml-auto shrink-0 !p-0.5" />
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* E1: time logged from here is the same record set as the Time Log area */}
          <div className="border-t border-hairline pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Time logged · {logs ? fmtHours(totalMinutes) || "0m" : "…"}
            </h3>
            {logs?.length === 0 && <p className="mb-2 text-xs text-muted">No time on this task yet.</p>}
            <ul className="mb-2 space-y-1">
              {(logs ?? []).map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs">
                  <Mono>{fmtDate(l.date)}</Mono>
                  <span className="text-muted">{l.user_name}</span>
                  {l.activity_type_label && <span className="text-muted">· {l.activity_type_label}</span>}
                  {l.notes && <span className="truncate text-muted">· {l.notes}</span>}
                  <Mono className="ml-auto shrink-0">{fmtHours(l.total_minutes)}</Mono>
                </li>
              ))}
            </ul>
            {!readOnly && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Date"><input type="date" className={inputCls + " !w-36"} value={timeForm.date}
                  onChange={(e) => setTimeForm({ ...timeForm, date: e.target.value })} /></Field>
                <Field label="Hours"><input type="number" min="0" className={inputCls + " !w-16"} value={timeForm.hours}
                  onChange={(e) => setTimeForm({ ...timeForm, hours: e.target.value })} /></Field>
                <Field label="Min"><input type="number" min="0" max="59" step="15" className={inputCls + " !w-16"} value={timeForm.minutes}
                  onChange={(e) => setTimeForm({ ...timeForm, minutes: e.target.value })} /></Field>
                <Field label="Activity type">
                  <select className={inputCls + " !w-36"} value={timeForm.activity_type_id}
                    onChange={(e) => setTimeForm({ ...timeForm, activity_type_id: e.target.value })}>
                    <option value="">—</option>
                    {activeValues("Time Log Activity Type").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                  </select>
                </Field>
                <Btn small kind="primary" onClick={logTime}>Log time</Btn>
              </div>
            )}
          </div>
        </form>

        {/* Right: append-only note history, newest first (§4) */}
        <div className="flex flex-col">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Notes · {notes?.length ?? 0}</h3>
          {!readOnly && (
            <form onSubmit={addNote} className="mb-3 flex items-end gap-2">
              <textarea className={inputCls + " min-h-16 flex-1"} placeholder="Add a note to this task…" value={note}
                onChange={(e) => setNote(e.target.value)} aria-label="New task note" />
              <Btn kind="primary" type="submit" disabled={!note.trim()}>Add</Btn>
            </form>
          )}
          {notes?.length === 0 && <p className="text-xs text-muted">No notes yet.</p>}
          <ul className="space-y-2.5 overflow-y-auto">
            {visibleNotes.map((n, i) => (
              <li key={n.id} className={`rounded-lg border p-3 ${i === 0 ? "border-accent/40 bg-accent-soft/40" : "border-hairline"}`}>
                {i === 0 && <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent">Latest</div>}
                <p className="whitespace-pre-wrap text-sm leading-snug">{n.note}</p>
                <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
                  <span>
                    {n.user_name} · <Mono>{n.activity_date?.slice(0, 16).replace("T", " ")}</Mono>
                    {n.category_label && <> · {n.category_label}</>}
                  </span>
                  {!readOnly && canEditActivity(n, currentUser) && (
                    <EditActivityButton activity={n} onEdit={() => setEditRecord(n)} className="ml-auto !p-0.5" />
                  )}
                </div>
              </li>
            ))}
          </ul>
          {(notes?.length ?? 0) > 1 && (
            <button className="mt-2 self-start text-xs font-medium text-accent hover:underline" onClick={() => setShowAllNotes(!showAllNotes)}>
              {showAllNotes ? "Show latest only" : `Show full history (${notes!.length})`}
            </button>
          )}
        </div>
      </div>
      {editRecord && (
        <EditActivityModal activity={editRecord} onClose={() => setEditRecord(null)}
          onSaved={() => { loadNotes(); loadLinked(); onChanged(); }} />
      )}
      {confirmDelete && (
        <ConfirmDeleteTaskModal task={task} onCancel={() => setConfirmDelete(false)} onConfirm={deleteTask} />
      )}
    </Modal>
  );
}

/** E4: deletion is permanent, so it always confirms first. Shared by the modal and the task list. */
export function ConfirmDeleteTaskModal({ task, onCancel, onConfirm }: {
  task: Task;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="Delete task?" onClose={onCancel}>
      <p className="mb-2 text-sm">
        "<b>{task.name}</b>" will be permanently removed from this project.
      </p>
      <p className="mb-4 text-xs text-muted">
        Nothing else is lost: any time logged against it stays on the project (timecard totals are unchanged),
        and its notes and activity history remain in the project's Notes &amp; Activity.
      </p>
      <div className="flex justify-end gap-2">
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="danger" onClick={onConfirm}>Delete task</Btn>
      </div>
    </Modal>
  );
}
