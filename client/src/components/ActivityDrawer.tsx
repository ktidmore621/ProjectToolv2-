import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, api, fmtDate, fmtHours, fmtTime } from "../api";
import { useSession } from "../state";
import { canEditActivity, EditActivityButton, EditActivityModal } from "./EditActivityModal";
import { ActivityTypeIcon } from "./icons";
import { EmptyState, Mono, Skeleton, tint } from "./ui";

/**
 * Side drawer listing every activity linked to a task (v2 §6) — type, date,
 * duration (derived from start/end), user, notes — with a jump to the full
 * record in the project's Notes & Activity tab. No page navigation.
 */
export function ActivityDrawer({ taskId, taskName, readOnly, onClose, onChanged }: {
  taskId: number;
  taskName: string;
  readOnly?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [editItem, setEditItem] = useState<Activity | null>(null);
  const { currentUser } = useSession();
  const navigate = useNavigate();

  const load = useCallback(() => {
    api.get<Activity[]>(`/api/tasks/${taskId}/activities`).then(setItems);
  }, [taskId]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !editItem && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editItem]);

  return (
    <div className="fixed inset-0 z-40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-ink/30" aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Activities linked to ${taskName}`}
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-hairline bg-surface shadow-lift"
      >
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Linked activities</h2>
            <p className="mt-0.5 text-xs text-muted">{taskName}</p>
          </div>
          <button onClick={onClose} aria-label="Close drawer" className="rounded p-1 text-muted hover:bg-canvas hover:text-ink">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {!items && <Skeleton className="h-40" />}
          {items?.length === 0 && (
            <EmptyState title="No linked activities" hint="Log a call, visit or meeting from the project's Notes & Activity tab and link it to this task." />
          )}
          <ul className="space-y-3">
            {(items ?? []).map((a) => (
              <li key={a.id} className="rounded-xl border border-hairline p-3.5 shadow-card">
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
                    style={{ backgroundColor: tint(a.activity_type_color ?? "#5C6B84", 0.15), color: a.activity_type_color ?? "#5C6B84" }}
                  >
                    <ActivityTypeIcon typeKey={a.activity_type_key} />
                  </span>
                  <span className="text-sm font-medium">{a.activity_type_label ?? "Activity"}</span>
                  <Mono className="ml-auto text-xs text-muted">{fmtDate(a.activity_date)}</Mono>
                  {!readOnly && canEditActivity(a, currentUser) && (
                    <EditActivityButton activity={a} onEdit={() => setEditItem(a)} />
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {a.start_time && (
                    <span>
                      <Mono>{fmtTime(a.start_time)}{a.end_time ? ` – ${fmtTime(a.end_time)}` : ""}</Mono>
                      {a.duration_minutes != null && <span className="ml-1.5">· {fmtHours(a.duration_minutes)}</span>}
                    </span>
                  )}
                  <span>{a.user_name}</span>
                </div>
                {a.note && <p className="mt-2 whitespace-pre-wrap text-sm leading-snug">{a.note}</p>}
                <button
                  className="mt-2.5 text-xs font-medium text-accent hover:underline"
                  onClick={() => {
                    onClose();
                    navigate(`/projects/${a.project_id}?tab=notes&activity=${a.id}`);
                  }}
                >
                  Open full record →
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      {editItem && (
        <EditActivityModal activity={editItem} onClose={() => setEditItem(null)}
          onSaved={() => { load(); onChanged?.(); }} />
      )}
    </div>
  );
}
