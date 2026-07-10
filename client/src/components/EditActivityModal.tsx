import { FormEvent, useEffect, useState } from "react";
import { Activity, api, Project, Task, User } from "../api";
import { useConfig, useSession, useToast } from "../state";
import { EditIcon } from "./icons";
import { Btn, Field, inputCls, Modal, Skeleton } from "./ui";

/** Author-only edit: notes and logged activities the working-as user created. */
export function canEditActivity(a: Activity, user: User | null): boolean {
  return !!user && a.user_id === user.id && (a.kind === "note" || a.kind === "activity");
}

/** Small pencil button shown next to editable records — same affordance everywhere. */
export function EditActivityButton({ activity, onEdit, className }: {
  activity: Activity;
  onEdit: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Edit this ${activity.kind === "activity" ? "activity" : "note"}`}
      title={activity.kind === "activity" ? "Edit activity" : "Edit note"}
      className={`rounded p-1 text-muted transition-colors hover:bg-canvas hover:text-ink ${className ?? ""}`}
    >
      <EditIcon size={14} />
    </button>
  );
}

/**
 * Shared edit form for a note or logged activity — the same fields captured at
 * creation, saved in place (same ID, a correction rather than a new entry).
 * Used from the Notes & Activity tab, the task modal and drawer, and the
 * dashboard feed so editing behaves identically everywhere.
 */
export function EditActivityModal({ activity, onClose, onSaved }: {
  activity: Activity;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const toast = useToast();
  const isActivity = activity.kind === "activity";
  const [form, setForm] = useState({
    note: activity.note,
    category_id: activity.category_id ? String(activity.category_id) : "",
    activity_type_id: activity.activity_type_id ?? 0,
    activity_date: (activity.activity_date ?? "").slice(0, 10),
    start_time: activity.start_time ?? "",
    end_time: activity.end_time ?? "",
  });
  const [taskIds, setTaskIds] = useState<number[]>(activity.linked_tasks.map((t) => t.id));
  const [projectTasks, setProjectTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isActivity) return;
    api.get<Project>(`/api/projects/${activity.project_id}`).then((p) => setProjectTasks((p.tasks ?? []) as Task[]));
  }, [isActivity, activity.project_id]);

  function toggleTask(id: number) {
    setTaskIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.patch(
        `/api/activities/${activity.id}`,
        isActivity
          ? {
              user_id: currentUser?.id,
              note: form.note,
              activity_type_id: Number(form.activity_type_id),
              activity_date: form.activity_date,
              start_time: form.start_time || null,
              end_time: form.end_time || null,
              task_ids: taskIds,
            }
          : {
              user_id: currentUser?.id,
              note: form.note,
              category_id: form.category_id ? Number(form.category_id) : null,
            }
      );
      toast(isActivity ? "Activity updated." : "Note updated.", "success");
      onSaved();
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Update failed"); }
  }

  if (!isActivity) {
    return (
      <Modal title="Edit note" onClose={onClose}>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Note">
            <textarea className={inputCls + " h-20"} required value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <Field label="Category">
            <select className={inputCls} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
              <option value="">—</option>
              {activeValues("Note Category").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </Field>
          {error && <p className="text-sm text-rag-red">{error}</p>}
          <div className="flex justify-end gap-2">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" type="submit" disabled={!form.note.trim()}>Save changes</Btn>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Edit activity" onClose={onClose} wide>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Activity type">
          <select className={inputCls} value={form.activity_type_id} onChange={(e) => setForm({ ...form, activity_type_id: Number(e.target.value) })}>
            {activeValues("Activity Type").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
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
            <textarea className={inputCls + " h-20"} required value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={`Link to tasks (${taskIds.length} selected)`} hint="One activity can link to any number of tasks; tasks can hold many activities.">
            {!projectTasks ? (
              <Skeleton className="h-16" />
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-hairline p-2">
                {projectTasks.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-canvas">
                    <input type="checkbox" checked={taskIds.includes(t.id)} onChange={() => toggleTask(t.id)} />
                    <span className="truncate">{t.name}</span>
                    <span className="ml-auto text-[11px] text-muted">{t.status_label}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        </div>
        {error && <p className="col-span-2 text-sm text-rag-red">{error}</p>}
        <div className="col-span-2 flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={!form.note.trim()}>Save changes</Btn>
        </div>
      </form>
    </Modal>
  );
}
