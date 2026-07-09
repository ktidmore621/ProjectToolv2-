import { FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, api, fmtDate, fmtHours, fmtTime, Project, Task } from "../api";
import { useConfig, useSession, useToast } from "../state";
import { ActivityTypeIcon } from "./icons";
import { Btn, Chip, Field, inputCls, Modal, Mono, tint } from "./ui";

/**
 * Task detail (v2 §4 + §6): edit the task, keep an append-only note history
 * with the latest note surfaced first, and see linked activities — all without
 * leaving the task.
 */
export function TaskModal({ task, project, readOnly, onClose, onChanged }: {
  task: Task;
  project: Project;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => void;
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

  const loadNotes = useCallback(() => {
    api.get<Activity[]>(`/api/activities?task_id=${task.id}&kind=note`).then(setNotes);
  }, [task.id]);
  useEffect(loadNotes, [loadNotes]);
  useEffect(() => { api.get<Activity[]>(`/api/tasks/${task.id}/activities`).then(setLinked); }, [task.id]);

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
    <Modal title={task.name} onClose={onClose} wide>
      <div className="grid gap-5 md:grid-cols-2">
        {/* Left: task fields */}
        <form onSubmit={saveFields} className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Chip label={task.status_label} color={task.status_color} small />
            {task.required ? <span className="rounded bg-primary-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">Required</span> : null}
            <span className="capitalize">{task.task_type.replace("_", " ")}</span>
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
                    <button className="font-medium hover:underline"
                      onClick={() => { onClose(); navigate(`/projects/${a.project_id}?tab=notes&activity=${a.id}`); }}>
                      {a.activity_type_label ?? "Activity"}
                    </button>
                    <span className="text-muted"> · <Mono>{fmtDate(a.activity_date)}</Mono>
                      {a.duration_minutes != null && <> · {fmtHours(a.duration_minutes)}</>} · {a.user_name}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </form>

        {/* Right: append-only note history, newest first (§4) */}
        <div className="flex flex-col">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Notes · {notes?.length ?? 0}</h3>
          {!readOnly && (
            <form onSubmit={addNote} className="mb-3 flex gap-2">
              <input className={inputCls} placeholder="Add a note to this task…" value={note}
                onChange={(e) => setNote(e.target.value)} aria-label="New task note" />
              <Btn kind="primary" type="submit" disabled={!note.trim()}>Add</Btn>
            </form>
          )}
          {notes?.length === 0 && <p className="text-xs text-muted">No notes yet.</p>}
          <ul className="space-y-2.5 overflow-y-auto">
            {visibleNotes.map((n, i) => (
              <li key={n.id} className={`rounded-lg border p-3 ${i === 0 ? "border-accent/40 bg-accent-soft/40" : "border-hairline"}`}>
                {i === 0 && <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent">Latest</div>}
                <p className="text-sm leading-snug">{n.note}</p>
                <div className="mt-1.5 text-[11px] text-muted">
                  {n.user_name} · <Mono>{n.activity_date?.slice(0, 16).replace("T", " ")}</Mono>
                  {n.category_label && <> · {n.category_label}</>}
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
    </Modal>
  );
}
