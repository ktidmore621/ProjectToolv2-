import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { useMemo, useState } from "react";
import { Task } from "../api";
import { useConfig } from "../state";
import { renderTaskField, useLayout } from "./fields";

/**
 * Project Task Kanban (§6.2). Columns = Task Status. Cards move between columns
 * but can't be reordered within one — preserving the no-reorder rule for
 * template tasks. Skip prompts are handled by the parent via onMove.
 */
export function TaskKanban({ tasks, readOnly, onMove }: {
  tasks: Task[];
  readOnly: boolean;
  onMove: (task: Task, statusId: number) => Promise<boolean>;
}) {
  const { activeValues, archivedValues } = useConfig();
  const cardFields = useLayout("task_card");
  const [dragging, setDragging] = useState<Task | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // B1/E4: archived statuses (e.g. legacy Skipped) can't be assigned anymore,
  // but tasks still in them must remain visible — keep a column when occupied.
  const columns = [
    ...activeValues("Task Status"),
    ...archivedValues("Task Status").filter((v) => tasks.some((t) => t.status_id === v.id)),
  ];

  const byStatus = useMemo(() => {
    const m = new Map<number, Task[]>();
    for (const t of tasks) {
      if (!m.has(t.status_id)) m.set(t.status_id, []);
      m.get(t.status_id)!.push(t);
    }
    // within a column, keep template step order
    for (const list of m.values()) list.sort((a, b) => a.step_order - b.step_order);
    return m;
  }, [tasks]);

  async function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const task = tasks.find((t) => t.id === Number(e.active.id));
    const statusId = e.over ? Number(e.over.id) : null;
    if (!task || !statusId || task.status_id === statusId) return;
    await onMove(task, statusId);
  }

  return (
    <DndContext sensors={sensors}
      onDragStart={(e: DragStartEvent) => setDragging(tasks.find((t) => t.id === Number(e.active.id)) ?? null)}
      onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((col) => {
          const list = byStatus.get(col.id) ?? [];
          return <TaskColumn key={col.id} col={col} tasks={list} cardFields={cardFields} readOnly={readOnly} />;
        })}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
        {dragging && <TaskCard t={dragging} cardFields={cardFields} lifted />}
      </DragOverlay>
    </DndContext>
  );
}

function TaskColumn({ col, tasks, cardFields, readOnly }: { col: any; tasks: Task[]; cardFields: any[]; readOnly: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id, disabled: readOnly });
  return (
    <div className="flex w-64 shrink-0 flex-col rounded-xl bg-canvas">
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-xl bg-canvas px-3 pb-2 pt-1">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: col.color }} aria-hidden />
        <span className="text-[13px] font-semibold">{col.label}</span>
        <span className="ml-auto rounded-full bg-hairline px-2 py-px font-mono text-[11px] font-medium text-muted">{tasks.length}</span>
      </div>
      <div ref={setNodeRef}
        className={`flex min-h-32 flex-1 flex-col gap-2 rounded-lg p-1.5 transition-colors ${isOver ? "bg-accent-soft outline-2 outline-dashed outline-accent/50" : ""}`}>
        {tasks.map((t) => <DraggableTask key={t.id} t={t} cardFields={cardFields} readOnly={readOnly} />)}
      </div>
    </div>
  );
}

function DraggableTask({ t, cardFields, readOnly }: { t: Task; cardFields: any[]; readOnly: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id, disabled: readOnly });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? "opacity-40" : ""}>
      <TaskCard t={t} cardFields={cardFields} readOnly={readOnly} />
    </div>
  );
}

function TaskCard({ t, cardFields, lifted, readOnly }: { t: Task; cardFields: any[]; lifted?: boolean; readOnly?: boolean }) {
  return (
    <div
      tabIndex={0}
      className={`rounded-lg border border-hairline bg-surface p-3 transition-shadow ${readOnly ? "" : "cursor-grab"} ${lifted ? "scale-[1.02] shadow-lift" : "shadow-card hover:shadow-lift"}`}
    >
      <div className="space-y-1.5 text-xs">
        {cardFields.map((f) => (
          <div key={f.field_key} className={f.field_key === "name" ? "text-[13px]" : ""}>{renderTaskField(f.field_key, t)}</div>
        ))}
        {t.skip_reason && <div className="text-[11px] italic text-muted">Skipped: {t.skip_reason}</div>}
      </div>
    </div>
  );
}
