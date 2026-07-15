import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, fmtCurrency, PickValue, Project } from "../api";
import { renderProjectField, useLayout } from "../components/fields";
import { inputCls, ragEdge, Skeleton } from "../components/ui";
import { useConfig, useDefaultAssignee, useSession, useToast } from "../state";

/** Portfolio Kanban — v1's standalone screen, now a view state inside Projects (v2 §1). */
export function PortfolioKanbanView({ toolbar }: { toolbar?: React.ReactNode }) {
  const { activeValues, archivedValues } = useConfig();
  const { users, currentUser } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [dragging, setDragging] = useState<Project | null>(null);
  // Assignee quick filter defaults from the current user's Working As settings
  const [assignee, setAssignee] = useDefaultAssignee();
  const [filters, setFilters] = useState({ rag: "", risk_level_id: "", template_id: "" });
  const [templates, setTemplates] = useState<any[]>([]);
  const cardFields = useLayout("portfolio_card");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const statuses = activeValues("Project Status").filter((v) => !["closed", "cancelled"].includes(v.maps_to ?? ""));
  // B1: an archived status can't be assigned anymore, but projects still in it
  // must stay visible — render a column for any archived status holding projects.
  const archivedWithProjects = archivedValues("Project Status").filter(
    (v) => !["closed", "cancelled"].includes(v.maps_to ?? "") && (projects ?? []).some((p) => p.status_id === v.id)
  );
  const closedCol = activeValues("Project Status").find((v) => v.maps_to === "closed");
  const columns = [...statuses, ...archivedWithProjects, ...(closedCol ? [closedCol] : [])];

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (assignee) qs.set("assignee_id", assignee);
    Object.entries(filters).forEach(([k, v]) => v && qs.set(k, v));
    api.get<Project[]>(`/api/projects?${qs}`).then(setProjects);
  }, [filters, assignee]);
  useEffect(load, [load]);
  useEffect(() => { api.get("/api/templates").then(setTemplates); }, []);

  const byStatus = useMemo(() => {
    const m = new Map<number, Project[]>();
    for (const p of projects ?? []) {
      if (!m.has(p.status_id)) m.set(p.status_id, []);
      m.get(p.status_id)!.push(p);
    }
    return m;
  }, [projects]);

  async function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const projectId = Number(e.active.id);
    const statusId = e.over ? Number(e.over.id) : null;
    const project = projects?.find((p) => p.id === projectId);
    if (!statusId || !project || project.status_id === statusId) return;
    const target = columns.find((c) => c.id === statusId);

    // Optimistic move, roll back on rejection
    setProjects((ps) => ps!.map((p) => (p.id === projectId ? { ...p, status_id: statusId, status_label: target?.label ?? p.status_label, status_color: target?.color ?? p.status_color } : p)));
    try {
      await api.post(`/api/projects/${projectId}/status`, { status_id: statusId, user_id: currentUser?.id });
      toast(`${project.mcp_name} moved to ${target?.label}`, "success");
      load();
    } catch (err) {
      load();
      if (err instanceof ApiError && err.body?.needs_close_form) {
        const problems: string[] = err.body.problems ?? [];
        if (problems.length) {
          toast(`Can't close ${project.mcp_name} yet: ${problems.join(" · ")}`, "warning");
        } else {
          toast("Closing needs a final summary and close reason — opening the project.", "info");
          navigate(`/projects/${projectId}?close=1`);
        }
      } else if (err instanceof Error) toast(err.message, "error");
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
          {toolbar}
          <select className={inputCls + " !w-auto"} value={assignee} aria-label="Filter by assignee"
            onChange={(e) => setAssignee(e.target.value)}>
            <option value="">All assignees</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select className={inputCls + " !w-auto"} value={filters.rag} aria-label="Filter by RAG"
            onChange={(e) => setFilters({ ...filters, rag: e.target.value })}>
            <option value="">All RAG</option>
            <option value="red">Red</option><option value="amber">Amber</option><option value="green">Green</option>
          </select>
          <select className={inputCls + " !w-auto"} value={filters.risk_level_id} aria-label="Filter by risk"
            onChange={(e) => setFilters({ ...filters, risk_level_id: e.target.value })}>
            <option value="">All risk levels</option>
            {activeValues("Risk Level").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            {/* B1: archived values remain findable in filters */}
            {archivedValues("Risk Level").length > 0 && (
              <optgroup label="Archived">
                {archivedValues("Risk Level").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </optgroup>
            )}
          </select>
          <select className={inputCls + " !w-auto"} value={filters.template_id} aria-label="Filter by template"
            onChange={(e) => setFilters({ ...filters, template_id: e.target.value })}>
            <option value="">All templates</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
      </div>
      {!projects ? (
        <div className="flex gap-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-96 w-72" />)}</div>
      ) : (
        <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragging(projects.find((p) => p.id === Number(e.active.id)) ?? null)} onDragEnd={onDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4">
            {columns.map((col) => (
              <Column key={col.id} col={col} projects={byStatus.get(col.id) ?? []} cardFields={cardFields} />
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
            {dragging && <ProjectCard p={dragging} cardFields={cardFields} lifted />}
          </DragOverlay>
        </DndContext>
      )}
    </>
  );
}

function Column({ col, projects, cardFields }: { col: PickValue; projects: Project[]; cardFields: any[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  // E10: each status column shows its project count AND total Annualized Premium
  const totalAp = projects.reduce((s, p) => s + (p.annualized_premium ?? 0), 0);
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl bg-canvas">
      {/* Sticky header with live count + AP badges (§10.4, E10) */}
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-xl bg-canvas px-3 pb-2 pt-1">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: col.color }} aria-hidden />
        <span className="text-[13px] font-semibold">{col.label}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-medium text-muted" title="Total Annualized Premium in this column">{fmtCurrency(totalAp)}</span>
          <span className="rounded-full bg-hairline px-2 py-px font-mono text-[11px] font-medium text-muted">{projects.length}</span>
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-40 flex-1 flex-col gap-2 rounded-lg p-1.5 transition-colors ${isOver ? "bg-accent-soft outline-2 outline-dashed outline-accent/50" : ""}`}
      >
        {projects.map((p) => <DraggableCard key={p.id} p={p} cardFields={cardFields} />)}
      </div>
    </div>
  );
}

function DraggableCard({ p, cardFields }: { p: Project; cardFields: any[] }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: p.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? "opacity-40" : ""}>
      <ProjectCard p={p} cardFields={cardFields} />
    </div>
  );
}

function ProjectCard({ p, cardFields, lifted }: { p: Project; cardFields: any[]; lifted?: boolean }) {
  // RAG as a left-edge bar, not full-color background (§6.1)
  return (
    <Link
      to={`/projects/${p.id}`}
      draggable={false}
      className={`block cursor-grab rounded-lg border border-hairline bg-surface p-3 transition-shadow ${lifted ? "scale-[1.02] shadow-lift" : "shadow-card hover:shadow-lift"}`}
      style={ragEdge(p.rag)}
    >
      <div className="space-y-1.5 pl-1.5 text-xs">
        {cardFields.filter((f) => f.field_key !== "rag").map((f) => (
          <div key={f.field_key} className={f.field_key === "mcp_name" ? "text-sm" : ""}>{renderProjectField(f.field_key, p)}</div>
        ))}
      </div>
    </Link>
  );
}
