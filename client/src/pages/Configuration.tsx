import { FormEvent, useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, CustomField, CustomFieldType, LayoutField, Picklist, PickValue, Project, Task, User } from "../api";
import { renderProjectField, renderTaskField } from "../components/fields";
import { Page } from "../components/Layout";
import { Btn, Card, Chip, Field, inputCls, Modal, Mono, ragEdge, Skeleton } from "../components/ui";
import { useConfig, useSession, useToast } from "../state";

const TABS = [
  { to: "working-as", label: "Working As" },
  { to: "picklists", label: "Picklists & Values" },
  { to: "templates", label: "Workflow Templates" },
  { to: "fields", label: "Field Requirements" },
  { to: "custom-fields", label: "Custom Fields" },
  { to: "layouts", label: "Card & View Layouts" },
];

export function Configuration() {
  const { currentUser } = useSession();
  // Users with Show Configuration off (Working As tab) can't see this page.
  // B6 — SECURITY NOTE: this is UI visibility only, NOT access control. The
  // /api/* configuration endpoints stay reachable regardless of this flag;
  // see the "Security model" section of the README.
  if (currentUser && !currentUser.show_configuration) return <Navigate to="/" replace />;
  return (
    <Page title="Configuration">
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Visible to every user whose <b>Show Configuration</b> setting is on (Working As tab). Two guardrails always
        apply: in-use picklist values are deactivated rather than deleted, and template edits are never retroactive —
        in-flight projects keep the task list they were generated with.
      </p>
      <div className="mb-5 flex gap-1 border-b border-hairline">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to}
            className={({ isActive }) => `-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${isActive ? "border-primary text-primary" : "border-transparent text-muted hover:text-ink"}`}>
            {t.label}
          </NavLink>
        ))}
      </div>
      <Routes>
        <Route path="working-as" element={<WorkingAs />} />
        <Route path="picklists" element={<Picklists />} />
        <Route path="templates" element={<Templates />} />
        <Route path="fields" element={<FieldRequirements />} />
        <Route path="custom-fields" element={<CustomFields />} />
        <Route path="layouts" element={<Layouts />} />
        <Route path="*" element={<Navigate to="working-as" replace />} />
      </Routes>
    </Page>
  );
}

// ================= Working As (v2) =================

/**
 * Single source of truth for who can use the system: this list drives the
 * sidebar user switcher and every assignment dropdown (both read /api/users),
 * plus the per-user defaults — dashboard scope, the assignee quick-filter
 * pre-applied on the Projects views, and Configuration visibility.
 */
function WorkingAs() {
  const { users, currentUser, setCurrentUser, refreshUsers } = useSession();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");

  async function patchUser(u: User, patch: Record<string, unknown>) {
    try {
      const updated = await api.patch<User>(`/api/users/${u.id}`, patch);
      if (currentUser?.id === u.id) setCurrentUser(updated);
      await refreshUsers();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  async function addUser(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/users", { name: newName, email: newEmail });
      await refreshUsers();
      toast(`Added ${newName} — they now appear in the user switcher and assignment dropdowns.`, "success");
      setNewName(""); setNewEmail("");
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  if (!users.length) return <Skeleton className="h-72" />;

  return (
    <Card className="max-w-4xl p-4">
      <p className="mb-3 text-sm text-muted">
        These users can access the system and appear in every assignment dropdown. <b>Home Default</b> controls
        whether their Home page opens scoped to their own items or to everything; <b>Default Assignee Filter</b> is the
        assignee pre-applied on the Project List, Kanban Board and Task List (they can still change it there);
        <b> Show Configuration</b> controls whether this Configuration page is visible to them
        (visibility only — it is <b>not</b> a security control; see the README's "Security model").
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hairline text-left text-xs font-semibold text-muted">
            <th className="py-2 pr-3">User</th>
            <th className="py-2 pr-3">Home Default</th>
            <th className="py-2 pr-3">Default Assignee Filter</th>
            <th className="py-2">Show Configuration</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-hairline last:border-0">
              <td className="py-2 pr-3">
                <span className="font-medium">{u.name}</span>
                {currentUser?.id === u.id && (
                  <span className="ml-1.5 rounded bg-primary-soft px-1.5 py-px text-[10px] font-semibold uppercase text-primary">you</span>
                )}
                <div className="text-xs text-muted">{u.email}</div>
              </td>
              <td className="py-2 pr-3">
                <select className={inputCls + " !w-auto"} value={u.dashboard_scope ?? "mine"}
                  aria-label={`Home default for ${u.name}`}
                  onChange={(e) => patchUser(u, { dashboard_scope: e.target.value })}>
                  <option value="mine">My Items Only</option>
                  <option value="all">Show All</option>
                </select>
              </td>
              <td className="py-2 pr-3">
                <select className={inputCls + " !w-auto"} value={u.default_assignee_filter ?? ""}
                  aria-label={`Default assignee filter for ${u.name}`}
                  onChange={(e) => patchUser(u, { default_assignee_filter: e.target.value || null })}>
                  <option value="">Match Home default</option>
                  <option value="all">Everyone (no filter)</option>
                  {users.map((x) => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
                </select>
              </td>
              <td className="py-2">
                <input type="checkbox" checked={!!u.show_configuration}
                  disabled={currentUser?.id === u.id}
                  title={currentUser?.id === u.id ? "You can't hide Configuration from yourself" : undefined}
                  aria-label={`Show Configuration to ${u.name}`}
                  onChange={(e) => patchUser(u, { show_configuration: e.target.checked ? 1 : 0 })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={addUser} className="mt-3 flex items-end gap-2 border-t border-hairline pt-3">
        <Field label="Name"><input className={inputCls + " !w-48"} required value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>
        <Field label="Email"><input type="email" className={inputCls + " !w-64"} required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></Field>
        <Btn kind="primary" type="submit">Add user</Btn>
      </form>
    </Card>
  );
}

// ================= Picklists & Values (§5.1) =================

function Picklists() {
  const { picklists, refreshPicklists } = useConfig();
  const toast = useToast();
  const [selected, setSelected] = useState<string>("Project Status");
  // B1: Archived filter — archived values stay findable here
  const [valueFilter, setValueFilter] = useState<"active" | "archived" | "all">("active");
  const list = picklists.find((p) => p.name === selected);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#2E4E8F");

  async function addValue(e: FormEvent) {
    e.preventDefault();
    if (!list) return;
    await api.post(`/api/picklists/${list.id}/values`, { label: newLabel, color: newColor });
    setNewLabel("");
    refreshPicklists();
    toast(`Added "${newLabel}" to ${list.name}.`, "success");
  }

  async function move(v: PickValue, dir: -1 | 1) {
    if (!list) return;
    const vals = [...list.values];
    const i = vals.findIndex((x) => x.id === v.id);
    const j = i + dir;
    if (j < 0 || j >= vals.length) return;
    [vals[i], vals[j]] = [vals[j], vals[i]];
    await Promise.all(vals.map((x, idx) => api.patch(`/api/picklist-values/${x.id}`, { sort_order: idx + 1 })));
    refreshPicklists();
  }

  async function update(v: PickValue, patch: any) {
    try {
      await api.patch(`/api/picklist-values/${v.id}`, patch);
      refreshPicklists();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  async function remove(v: PickValue) {
    try {
      const r = await api.del(`/api/picklist-values/${v.id}`);
      toast(r.archived ? r.message : `Deleted "${v.label}".`, r.archived ? "warning" : "success");
      refreshPicklists();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  if (!picklists.length) return <Skeleton className="h-72" />;

  const visibleValues = (list?.values ?? []).filter((v) =>
    valueFilter === "all" ? true : valueFilter === "archived" ? !!v.archived : !v.archived
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <Card className="h-fit p-2">
        {picklists.map((p) => (
          <button key={p.id} onClick={() => setSelected(p.name)}
            className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${selected === p.name ? "bg-primary-soft text-primary" : "text-muted hover:bg-canvas hover:text-ink"}`}>
            {p.name}
            {!!p.is_system && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-60">system</span>}
          </button>
        ))}
      </Card>
      {list && (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">{list.name}</h2>
            <span className="flex items-center gap-3">
              {!!list.is_system && <span className="text-xs text-muted">System list — values can be relabeled, reordered and recolored, but not removed.</span>}
              <select className={inputCls + " !w-auto !py-1 text-xs"} value={valueFilter} aria-label="Filter values"
                onChange={(e) => setValueFilter(e.target.value as any)}>
                <option value="active">Active values</option>
                <option value="archived">Archived values</option>
                <option value="all">All values</option>
              </select>
            </span>
          </div>
          {visibleValues.length === 0 && (
            <p className="py-6 text-center text-sm text-muted">
              {valueFilter === "archived" ? "No archived values in this list." : "No values match this filter."}
            </p>
          )}
          <ul className="divide-y divide-hairline">
            {visibleValues.map((v, i) => (
              <li key={v.id} className={`flex flex-wrap items-center gap-2 py-2 ${v.is_active && !v.archived ? "" : "opacity-60"}`}>
                <span className="flex gap-0.5">
                  <button onClick={() => move(v, -1)} disabled={i === 0} className="rounded px-1 text-muted hover:bg-canvas disabled:opacity-30" aria-label={`Move ${v.label} up`}>↑</button>
                  <button onClick={() => move(v, 1)} disabled={i === visibleValues.length - 1} className="rounded px-1 text-muted hover:bg-canvas disabled:opacity-30" aria-label={`Move ${v.label} down`}>↓</button>
                </span>
                <input type="color" value={v.color} onChange={(e) => update(v, { color: e.target.value })}
                  className="h-7 w-9 cursor-pointer rounded border border-hairline" aria-label={`Color of ${v.label}`} />
                <input
                  className="w-52 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm hover:border-hairline focus:border-accent focus:outline-none"
                  defaultValue={v.label}
                  onBlur={(e) => e.target.value !== v.label && update(v, { label: e.target.value })}
                  aria-label={`Rename ${v.label}`}
                />
                <Chip label={v.label} color={v.color} small />
                {!!v.is_default && <span className="rounded bg-primary-soft px-1.5 py-px text-[10px] font-semibold uppercase text-primary">default</span>}
                {!!v.archived && <span className="rounded bg-canvas px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted" title="Hidden from dropdowns for new entries; legacy records still display it.">archived</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  {!v.is_default && !!v.is_active && !v.archived && <Btn small kind="ghost" onClick={() => update(v, { is_default: true })}>Set default</Btn>}
                  {!v.archived && (v.is_active ? (
                    <Btn small kind="ghost" onClick={() => update(v, { is_active: false })}>Deactivate</Btn>
                  ) : (
                    <Btn small kind="ghost" onClick={() => update(v, { is_active: true })}>Reactivate</Btn>
                  ))}
                  {/* B1: in-use values archive (hidden going forward, intact on legacy records); never-used values may still be hard-deleted */}
                  {!(list.is_system && v.maps_to) && (v.archived ? (
                    <Btn small kind="ghost" onClick={() => update(v, { archived: false })}>Restore</Btn>
                  ) : (
                    <>
                      <Btn small kind="ghost" onClick={() => update(v, { archived: true })}
                        title="Hide from dropdowns going forward; existing records keep displaying it.">Archive</Btn>
                      <Btn small kind="danger" onClick={() => remove(v)}
                        title="Deletes only if no record has ever used it — otherwise it is archived.">Delete</Btn>
                    </>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <form onSubmit={addValue} className="mt-3 flex items-end gap-2 border-t border-hairline pt-3">
            <Field label="New value"><input className={inputCls + " !w-52"} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} required /></Field>
            <Field label="Color"><input type="color" className="h-9 w-12 cursor-pointer rounded-lg border border-hairline" value={newColor} onChange={(e) => setNewColor(e.target.value)} /></Field>
            <Btn kind="primary" type="submit">Add value</Btn>
          </form>
        </Card>
      )}
    </div>
  );
}

// ================= Workflow Templates (§5.2) =================

function Templates() {
  const toast = useToast();
  const { activeValues } = useConfig();
  const { currentUser } = useSession();
  const [templates, setTemplates] = useState<any[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editTask, setEditTask] = useState<any | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    const ts = await api.get("/api/templates");
    setTemplates(ts);
    setSelectedId((id) => id ?? ts[0]?.id ?? null);
  }, []);
  useEffect(() => { load(); }, [load]);

  const tpl = templates?.find((t) => t.id === selectedId);

  async function patchTpl(patch: any) {
    await api.patch(`/api/templates/${tpl.id}`, patch);
    load();
  }
  async function moveTask(i: number, dir: -1 | 1) {
    const ids = tpl.tasks.map((t: any) => t.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.post(`/api/templates/${tpl.id}/reorder`, { task_ids: ids });
    load();
  }
  async function removeTask(t: any) {
    try {
      await api.del(`/api/template-tasks/${t.id}`);
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  if (!templates) return <Skeleton className="h-72" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="space-y-2">
        <Card className="p-2">
          {templates.map((t) => (
            <button key={t.id} onClick={() => setSelectedId(t.id)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${selectedId === t.id ? "bg-primary-soft text-primary" : "text-muted hover:bg-canvas hover:text-ink"}`}>
              <span className="font-medium">{t.name}</span>
              <span className="mt-0.5 block text-[11px]">
                {t.is_default ? "Default · " : ""}{t.is_active ? "Active" : "Inactive"} · {t.tasks.length} tasks
              </span>
            </button>
          ))}
        </Card>
        <Btn kind="primary" onClick={() => setShowNew(true)}>New template</Btn>
      </div>

      {tpl && (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <input className="min-w-56 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-hairline focus:border-accent focus:outline-none"
                defaultValue={tpl.name} onBlur={(e) => e.target.value !== tpl.name && patchTpl({ name: e.target.value })} aria-label="Template name" />
              {!tpl.is_default && <Btn small onClick={() => patchTpl({ is_default: true })}>Set as default</Btn>}
              <Btn small onClick={() => patchTpl({ is_active: !tpl.is_active })}>{tpl.is_active ? "Deactivate" : "Activate"}</Btn>
              <Btn small onClick={async () => {
                await api.post("/api/templates", { name: `${tpl.name} (copy)`, description: tpl.description, clone_from: tpl.id, user_id: currentUser?.id });
                load(); toast("Template cloned.", "success");
              }}>Clone</Btn>
            </div>
            <textarea className={inputCls + " mt-2 h-14 text-xs"} defaultValue={tpl.description}
              onBlur={(e) => e.target.value !== tpl.description && patchTpl({ description: e.target.value })} aria-label="Template description" />
            <p className="mt-2 text-xs text-muted">
              Edits are <b>not retroactive</b> — they only affect projects created after the change (§5 guardrail).
            </p>
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Template tasks</h3>
              <Btn small kind="primary" onClick={() => setEditTask({ template_id: tpl.id })}>Add task</Btn>
            </div>
            <ul className="divide-y divide-hairline">
              {tpl.tasks.map((t: any, i: number) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="flex gap-0.5">
                    <button onClick={() => moveTask(i, -1)} disabled={i === 0} className="rounded px-1 text-muted hover:bg-canvas disabled:opacity-30" aria-label="Move up">↑</button>
                    <button onClick={() => moveTask(i, 1)} disabled={i === tpl.tasks.length - 1} className="rounded px-1 text-muted hover:bg-canvas disabled:opacity-30" aria-label="Move down">↓</button>
                  </span>
                  <Mono className="w-6 text-muted">{i + 1}</Mono>
                  <span className="font-medium">{t.name}</span>
                  {!!t.required && <span className="rounded bg-primary-soft px-1.5 py-px text-[10px] font-semibold uppercase text-primary">required</span>}
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                    due +<Mono>{t.due_offset}</Mono>d
                    <Btn small kind="ghost" onClick={() => setEditTask(t)}>Edit</Btn>
                    <Btn small kind="danger" onClick={() => removeTask(t)}>Remove</Btn>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {/* Live preview (§5.2) */}
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold">Live preview — tasks a new project gets</h3>
            <ol className="list-inside list-decimal space-y-1 text-sm text-muted">
              {tpl.tasks.map((t: any) => (
                <li key={t.id}>{t.name}{t.required ? " · required" : ""} · due +{t.due_offset}d</li>
              ))}
            </ol>
          </Card>
        </div>
      )}

      {editTask && (
        <TemplateTaskModal task={editTask} priorities={activeValues("Task Priority")}
          onClose={() => setEditTask(null)}
          onSaved={() => { setEditTask(null); load(); }} />
      )}
      {showNew && (
        <NewTemplateModal templates={templates} onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); setSelectedId(id); load(); }} />
      )}
    </div>
  );
}

function NewTemplateModal({ templates, onClose, onCreated }: { templates: any[]; onClose: () => void; onCreated: (id: number) => void }) {
  const { currentUser } = useSession();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = await api.post("/api/templates", { name, description, clone_from: cloneFrom ? Number(cloneFrom) : undefined, user_id: currentUser?.id });
    onCreated(t.id);
  }
  return (
    <Modal title="New workflow template" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name"><input className={inputCls} required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><textarea className={inputCls + " h-16"} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Start from">
          <select className={inputCls} value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)}>
            <option value="">Blank template</option>
            {templates.map((t) => <option key={t.id} value={t.id}>Clone "{t.name}"</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" type="submit">Create</Btn></div>
      </form>
    </Modal>
  );
}

function TemplateTaskModal({ task, priorities, onClose, onSaved }: { task: any; priorities: PickValue[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !task.id;
  const [form, setForm] = useState({
    name: task.name ?? "", description: task.description ?? "",
    required: !!(task.required ?? 1), due_offset: task.due_offset ?? 7,
    default_priority_id: task.default_priority_id ?? "", can_edit: !!(task.can_edit ?? 1),
  });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      required: form.required ? 1 : 0, can_edit: form.can_edit ? 1 : 0,
      default_priority_id: form.default_priority_id ? Number(form.default_priority_id) : null,
      due_offset: Number(form.due_offset),
    };
    if (isNew) await api.post(`/api/templates/${task.template_id}/tasks`, payload);
    else await api.patch(`/api/template-tasks/${task.id}`, payload);
    onSaved();
  }
  return (
    <Modal title={isNew ? "Add template task" : `Edit "${task.name}"`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Task name"><input className={inputCls} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Description"><textarea className={inputCls + " h-16"} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default due offset (days after assignment)">
            <input type="number" min="0" className={inputCls} value={form.due_offset} onChange={(e) => setForm({ ...form, due_offset: e.target.value as any })} />
          </Field>
          <Field label="Default priority">
            <select className={inputCls} value={form.default_priority_id} onChange={(e) => setForm({ ...form, default_priority_id: e.target.value as any })}>
              <option value="">—</option>
              {priorities.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> Required</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.can_edit} onChange={(e) => setForm({ ...form, can_edit: e.target.checked })} /> User can edit name</label>
        </div>
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" type="submit">{isNew ? "Add task" : "Save"}</Btn></div>
      </form>
    </Modal>
  );
}

// ================= Field Requirements + RAG thresholds (§5.3) =================

function FieldRequirements() {
  const toast = useToast();
  const [rules, setRules] = useState<any[] | null>(null);
  const [settings, setSettings] = useState<any | null>(null);

  const load = useCallback(() => {
    api.get("/api/field-requirements").then(setRules);
    api.get("/api/settings").then(setSettings);
  }, []);
  useEffect(load, [load]);

  async function patchRule(r: any, patch: any) {
    try {
      await api.patch(`/api/field-requirements/${r.id}`, { required: patch.required ?? r.required, required_at: patch.required_at ?? r.required_at });
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }
  async function saveSettings() {
    await api.patch("/api/settings", settings);
    toast("RAG thresholds saved — they take effect immediately, no deploy needed.", "success");
  }

  if (!rules || !settings) return <Skeleton className="h-72" />;

  const groups = [
    { key: "project", label: "Project fields" },
    { key: "task", label: "Task fields" },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        {groups.map((g) => (
          <Card key={g.key} className="p-4">
            <h3 className="mb-2 text-sm font-semibold">{g.label}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs font-semibold text-muted">
                  <th className="py-2">Field</th><th className="py-2">Required</th><th className="py-2">Required at</th>
                </tr>
              </thead>
              <tbody>
                {rules.filter((r) => r.object_type === g.key).map((r) => (
                  <tr key={r.id} className="border-b border-hairline last:border-0">
                    <td className="py-2">
                      {r.label}
                      {!!r.is_system && <span className="ml-1.5 rounded bg-canvas px-1.5 py-px text-[10px] font-semibold uppercase text-muted">locked</span>}
                    </td>
                    <td className="py-2">
                      <input type="checkbox" checked={!!r.required} disabled={!!r.is_system}
                        onChange={(e) => patchRule(r, { required: e.target.checked ? 1 : 0 })}
                        aria-label={`${r.label} required`} />
                    </td>
                    <td className="py-2">
                      {r.is_system ? (
                        <span className="text-xs text-muted">Always</span>
                      ) : (
                        <select className="rounded-lg border border-hairline bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
                          value={r.required_at} onChange={(e) => patchRule(r, { required_at: e.target.value })}
                          aria-label={`${r.label} required at`}>
                          <option value="creation">Creation</option>
                          <option value="always">Always</option>
                          <option value="closure">At closure</option>
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
        <p className="text-xs text-muted">Runtime validation reads these rules directly — changes take effect immediately (§5.3).</p>
      </div>

      <Card className="h-fit p-4">
        <h3 className="mb-2 text-sm font-semibold">RAG thresholds</h3>
        <p className="mb-3 text-xs text-muted">The [X]-day values from §4.7 — configurable, not hardcoded.</p>
        <div className="space-y-3">
          <Field label="Red: required task overdue by (days)">
            <input type="number" min="0" className={inputCls} value={settings.rag_red_overdue_days}
              onChange={(e) => setSettings({ ...settings, rag_red_overdue_days: e.target.value })} />
          </Field>
          <Field label="Amber: task due within (days)">
            <input type="number" min="0" className={inputCls} value={settings.rag_amber_due_days}
              onChange={(e) => setSettings({ ...settings, rag_amber_due_days: e.target.value })} />
          </Field>
          <Field label="Amber: stalled — no update for (days)">
            <input type="number" min="0" className={inputCls} value={settings.rag_stall_days}
              onChange={(e) => setSettings({ ...settings, rag_stall_days: e.target.value })} />
          </Field>
          <Btn kind="primary" onClick={saveSettings}>Save thresholds</Btn>
        </div>
      </Card>
    </div>
  );
}

// ================= Custom Fields (dynamic project fields) =================

const FIELD_TYPES: { key: CustomFieldType; label: string; hint: string }[] = [
  { key: "text", label: "Text", hint: "Free text" },
  { key: "number", label: "Number", hint: "Numeric value" },
  { key: "currency", label: "Currency", hint: "Dollar amount, shown as $0,000.00" },
  { key: "date", label: "Date", hint: "Calendar date" },
  { key: "dropdown", label: "Dropdown", hint: "Pick one from a managed option list" },
  { key: "checkbox", label: "Checkbox", hint: "Yes / No" },
];

/**
 * Admin-defined project fields. A new field immediately shows up on the
 * create/edit forms, the project detail header, list/Kanban layouts and
 * imports/exports — no code change. Dropdown options are a normal picklist
 * (editable under Picklists & Values); requiredness lives in Field
 * Requirements; per-view visibility in Card & View Layouts.
 */
function CustomFields() {
  const toast = useToast();
  const { refreshPicklists } = useConfig();
  const [fields, setFields] = useState<CustomField[] | null>(null);
  const [form, setForm] = useState({ label: "", field_type: "text" as CustomFieldType, options: "" });

  const load = useCallback(() => { api.get<CustomField[]>("/api/custom-fields").then(setFields); }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/custom-fields", {
        label: form.label,
        field_type: form.field_type,
        options: form.field_type === "dropdown" ? form.options.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      toast(`Added field "${form.label}" — it now appears on project forms, views and imports/exports.`, "success");
      setForm({ label: "", field_type: "text", options: "" });
      load();
      refreshPicklists(); // dropdown fields add a picklist
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  async function patch(f: CustomField, body: Record<string, unknown>) {
    try {
      await api.patch(`/api/custom-fields/${f.id}`, body);
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  async function remove(f: CustomField) {
    try {
      const r = await api.del(`/api/custom-fields/${f.id}`);
      toast(r.deactivated ? r.message : `Deleted "${f.label}".`, r.deactivated ? "warning" : "success");
      load();
      refreshPicklists();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }

  if (!fields) return <Skeleton className="h-72" />;
  const typeLabel = (t: string) => FIELD_TYPES.find((x) => x.key === t)?.label ?? t;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold">Project fields</h3>
        <p className="mb-3 text-xs text-muted">
          New fields appear automatically on the create/edit forms, project details, list and Kanban layouts,
          reporting exports and CSV import. Dropdown options are managed under <b>Picklists & Values</b>;
          make a field required under <b>Field Requirements</b>; show/hide it per view under <b>Card & View Layouts</b>.
        </p>
        {fields.length === 0 && <p className="py-6 text-center text-sm text-muted">No custom fields yet.</p>}
        <ul className="divide-y divide-hairline">
          {fields.map((f) => (
            <li key={f.id} className={`flex flex-wrap items-center gap-2 py-2 text-sm ${f.is_active ? "" : "opacity-50"}`}>
              <input
                className="w-52 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium hover:border-hairline focus:border-accent focus:outline-none"
                defaultValue={f.label}
                onBlur={(e) => e.target.value.trim() && e.target.value !== f.label && patch(f, { label: e.target.value })}
                aria-label={`Rename ${f.label}`}
              />
              <span className="rounded bg-canvas px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted">{typeLabel(f.field_type)}</span>
              {f.field_type === "dropdown" && (
                <span className="text-xs text-muted">{f.options.filter((o) => o.is_active).map((o) => o.label).join(" · ")}</span>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                {f.is_active ? (
                  <Btn small kind="ghost" onClick={() => patch(f, { is_active: false })}>Deactivate</Btn>
                ) : (
                  <Btn small kind="ghost" onClick={() => patch(f, { is_active: true })}>Reactivate</Btn>
                )}
                <Btn small kind="danger" onClick={() => remove(f)}>Delete</Btn>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="h-fit p-4">
        <h3 className="mb-3 text-sm font-semibold">Add a field</h3>
        <form onSubmit={add} className="space-y-3">
          <Field label="Field label"><input className={inputCls} required value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Region" /></Field>
          <Field label="Type" hint={FIELD_TYPES.find((t) => t.key === form.field_type)?.hint}>
            <select className={inputCls} value={form.field_type}
              onChange={(e) => setForm({ ...form, field_type: e.target.value as CustomFieldType })}>
              {FIELD_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          {form.field_type === "dropdown" && (
            <Field label="Options (comma-separated)" hint="Becomes a picklist you can recolor/reorder later.">
              <input className={inputCls} required value={form.options}
                onChange={(e) => setForm({ ...form, options: e.target.value })} placeholder="e.g. North, South, East, West" />
            </Field>
          )}
          <Btn kind="primary" type="submit">Add field</Btn>
        </form>
      </Card>
    </div>
  );
}

// ================= Card & View Layouts (§5.4) =================

const SAMPLE_PROJECT: Project = {
  id: 0, project_code: "CAP-0042", mcp_number: "MCP-9876", mcp_name: "Sample Customer Co.",
  project_name: "2026 Billing Recovery",
  assignee_id: 0, assignee_name: "Morgan Hale", annualized_premium: 12500, assignment_date: "2026-06-15", target_date: "2026-08-01",
  template_id: 0, status_id: 0, status_label: "In Progress", status_color: "#12808A", status_key: "in_progress",
  risk_level_id: 0, risk_label: "High", risk_color: "#B0632F",
  rag: "amber", rag_reason: "Task due within 3d", rag_overridden: false, rag_color: "#C99239", rag_label: "Amber",
  created_date: "", closed_date: null, closed_by_name: null, close_reason_id: null, close_reason_label: null,
  final_summary: null, is_closed: false, days_in_status: 4, open_task_count: 5, task_count: 9,
  next_due_task: { name: "Complete billing analysis", due_date: "2026-07-09" },
};
const SAMPLE_TASK: Task = {
  id: 0, project_id: 0, name: "Complete billing analysis", description: "", task_type: "standard", step_order: 2,
  assigned_to: 0, assigned_to_name: "Morgan Hale", due_date: "2026-07-09",
  status_id: 0, status_label: "In Progress", status_color: "#12808A", status_key: "in_progress",
  priority_id: 0, priority_label: "High", priority_color: "#C2554E", required: 1,
  notes: "", skip_reason: null, completed_date: null, completed_by_name: null,
  activity_count: 2, note_count: 1,
  latest_note: { note: "Waiting on the customer's usage export.", activity_date: "2026-07-08 14:00:00", user_name: "Morgan Hale" },
};

const VIEWS = [
  { key: "portfolio_card", label: "Portfolio Kanban card", kind: "project-card" },
  { key: "task_card", label: "Project Task Kanban card", kind: "task-card" },
  { key: "project_list", label: "Project List columns", kind: "project-row" },
  { key: "task_list", label: "Task List columns", kind: "task-row" },
  { key: "project_header", label: "Project Detail header", kind: "project-header" },
] as const;

function Layouts() {
  const toast = useToast();
  const [view, setView] = useState<(typeof VIEWS)[number]>(VIEWS[0]);
  const [fields, setFields] = useState<LayoutField[] | null>(null);

  const load = useCallback(() => {
    api.get<LayoutField[]>(`/api/layouts/${view.key}`).then((f) => setFields(f.sort((a, b) => a.display_order - b.display_order)));
  }, [view]);
  useEffect(load, [load]);

  async function toggle(f: LayoutField) {
    try {
      await api.patch(`/api/layout-fields/${f.id}`, { is_visible: f.is_visible ? 0 : 1 });
      load();
    } catch (err) { toast(err instanceof Error ? err.message : "Failed", "error"); }
  }
  async function move(i: number, dir: -1 | 1) {
    if (!fields) return;
    const ids = fields.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.post(`/api/layouts/${view.key}/reorder`, { field_ids: ids });
    load();
  }

  const visible = (fields ?? []).filter((f) => f.is_visible);

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr_360px]">
      <Card className="h-fit p-2">
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => setView(v)}
            className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${view.key === v.key ? "bg-primary-soft text-primary" : "text-muted hover:bg-canvas hover:text-ink"}`}>
            {v.label}
          </button>
        ))}
      </Card>

      <Card className="h-fit p-4">
        <h3 className="mb-2 text-sm font-semibold">{view.label} — fields</h3>
        {!fields ? <Skeleton className="h-40" /> : (
          <ul className="divide-y divide-hairline">
            {fields.map((f, i) => (
              <li key={f.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="flex gap-0.5">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1 text-muted hover:bg-canvas disabled:opacity-30" aria-label="Move up">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === fields.length - 1} className="rounded px-1 text-muted hover:bg-canvas disabled:opacity-30" aria-label="Move down">↓</button>
                </span>
                <label className="flex flex-1 items-center gap-2">
                  <input type="checkbox" checked={!!f.is_visible} disabled={!!f.is_locked} onChange={() => toggle(f)} />
                  {f.label}
                </label>
                {!!f.is_locked && <span className="rounded bg-canvas px-1.5 py-px text-[10px] font-semibold uppercase text-muted">locked</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Locked fields (e.g. MCP Name and RAG on the portfolio card) can't be hidden, so a card can't be configured into uselessness.</p>
      </Card>

      {/* Live preview (§5.4) */}
      <Card className="h-fit p-4">
        <h3 className="mb-3 text-sm font-semibold">Live preview</h3>
        {view.kind === "project-card" && (
          <div className="w-64 rounded-lg border border-hairline bg-surface p-3 shadow-card" style={ragEdge(SAMPLE_PROJECT.rag)}>
            <div className="space-y-1.5 pl-1.5 text-xs">
              {visible.filter((f) => f.field_key !== "rag").map((f) => (
                <div key={f.id} className={f.field_key === "mcp_name" ? "text-sm" : ""}>{renderProjectField(f.field_key, SAMPLE_PROJECT)}</div>
              ))}
            </div>
          </div>
        )}
        {view.kind === "task-card" && (
          <div className="w-60 rounded-lg border border-hairline bg-surface p-3 shadow-card">
            <div className="space-y-1.5 text-xs">
              {visible.map((f) => <div key={f.id}>{renderTaskField(f.field_key, SAMPLE_TASK)}</div>)}
            </div>
          </div>
        )}
        {(view.kind === "project-row" || view.kind === "task-row") && (
          <div className="overflow-x-auto rounded-lg border border-hairline">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-hairline text-left">
                {visible.map((f) => <th key={f.id} className="whitespace-nowrap px-2 py-1.5 font-semibold text-muted">{f.label}</th>)}
              </tr></thead>
              <tbody><tr>
                {visible.map((f) => (
                  <td key={f.id} className="whitespace-nowrap px-2 py-1.5">
                    {view.kind === "project-row" ? renderProjectField(f.field_key, SAMPLE_PROJECT) : renderTaskField(f.field_key, SAMPLE_TASK)}
                  </td>
                ))}
              </tr></tbody>
            </table>
          </div>
        )}
        {view.kind === "project-header" && (
          <div className="rounded-lg border border-hairline bg-surface p-3">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {visible.map((f) => (
                <div key={f.id}>
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{f.label}</div>
                  <div className="mt-0.5 text-xs">{renderProjectField(f.field_key, SAMPLE_PROJECT)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
