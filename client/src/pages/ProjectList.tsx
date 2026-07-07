import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, Project, todayIso } from "../api";
import { renderProjectField, useLayout } from "../components/fields";
import { Page } from "../components/Layout";
import { Btn, Card, EmptyState, Field, inputCls, Modal, Skeleton } from "../components/ui";
import { useConfig, useSession, useToast } from "../state";

export function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "project_code", dir: 1 });
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const columns = useLayout("project_list");
  const load = useCallback(() => { api.get<Project[]>("/api/projects?scope=active").then(setProjects); }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => {
    let out = projects ?? [];
    if (q.trim()) {
      const s = q.toLowerCase();
      out = out.filter((p) => [p.mcp_name, p.mcp_number, p.project_code, p.assignee_name, p.status_label].some((f) => f?.toLowerCase().includes(s)));
    }
    return [...out].sort((a: any, b: any) => {
      const av = a[sort.key] ?? "", bv = b[sort.key] ?? "";
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
  }, [projects, q, sort]);

  return (
    <Page
      title="Projects"
      actions={
        <>
          <input className={inputCls + " !w-56"} placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
          <Btn onClick={() => setShowImport(true)}>Import CSV</Btn>
          <a href="/api/export/projects.csv?scope=active" className="rounded-lg border border-hairline bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-canvas">Export CSV</a>
          <Btn kind="primary" onClick={() => setShowNew(true)}>New project</Btn>
        </>
      }
    >
      {!projects ? (
        <Skeleton className="h-96" />
      ) : filtered.length === 0 ? (
        <EmptyState title="No active projects match" hint="Create a project or adjust your search." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {columns.map((c) => (
                  <th key={c.field_key} className="px-3 py-2.5 text-xs font-semibold text-muted">
                    <button
                      className="hover:text-ink"
                      onClick={() => setSort((s) => ({ key: c.field_key, dir: s.key === c.field_key ? ((-s.dir) as 1 | -1) : 1 }))}
                    >
                      {c.label}{sort.key === c.field_key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={p.id} className={`border-b border-hairline last:border-0 ${i % 2 ? "bg-rowalt" : ""} hover:bg-primary-soft/40`}>
                  {columns.map((c, ci) => (
                    <td key={c.field_key} className="px-3 py-2">
                      {ci === 0 ? (
                        <Link to={`/projects/${p.id}`} className="block hover:underline">{renderProjectField(c.field_key, p)}</Link>
                      ) : renderProjectField(c.field_key, p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={load} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={load} />}
    </Page>
  );
}

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { users, currentUser } = useSession();
  const { activeValues } = useConfig();
  const toast = useToast();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<any[]>([]);
  const [form, setForm] = useState({
    mcp_number: "", mcp_name: "", assignee_id: currentUser?.id ?? 0,
    assignment_date: todayIso(), target_date: "", risk_level_id: "", template_id: 0,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/api/templates").then((ts: any[]) => {
      const active = ts.filter((t) => t.is_active);
      setTemplates(active);
      const def = active.find((t) => t.is_default) ?? active[0];
      if (def) setForm((f) => ({ ...f, template_id: def.id }));
    });
  }, []);

  const selectedTpl = templates.find((t) => t.id === form.template_id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const p = await api.post<Project>("/api/projects", {
        ...form,
        assignee_id: Number(form.assignee_id),
        template_id: Number(form.template_id),
        risk_level_id: form.risk_level_id ? Number(form.risk_level_id) : null,
        target_date: form.target_date || null,
        user_id: currentUser?.id,
      });
      toast(`Project ${p.project_code} created for ${p.mcp_name}`, "success");
      onCreated(); onClose();
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally { setBusy(false); }
  }

  return (
    <Modal title="New project" onClose={onClose} wide>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="MCP #"><input className={inputCls} required value={form.mcp_number} onChange={(e) => setForm({ ...form, mcp_number: e.target.value })} placeholder="e.g. MCP-1234" /></Field>
        <Field label="MCP Name"><input className={inputCls} required value={form.mcp_name} onChange={(e) => setForm({ ...form, mcp_name: e.target.value })} placeholder="Customer name" /></Field>
        <Field label="Assignee">
          <select className={inputCls} required value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: Number(e.target.value) })}>
            <option value={0} disabled>Select…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Assignment date"><input type="date" className={inputCls} required value={form.assignment_date} onChange={(e) => setForm({ ...form, assignment_date: e.target.value })} /></Field>
        <Field label="Target date (optional)"><input type="date" className={inputCls} value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} /></Field>
        <Field label="Risk level">
          <select className={inputCls} value={form.risk_level_id} onChange={(e) => setForm({ ...form, risk_level_id: e.target.value })}>
            <option value="">—</option>
            {activeValues("Risk Level").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Workflow template" hint="Generates the project's standard tasks. Standard tasks can't be removed or reordered.">
          <select className={inputCls} required value={form.template_id} onChange={(e) => setForm({ ...form, template_id: Number(e.target.value) })}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_default ? " (default)" : ""}</option>)}
          </select>
        </Field>
        {selectedTpl && (
          <div className="col-span-2 rounded-lg bg-canvas p-3">
            <div className="mb-1.5 text-xs font-semibold text-muted">This template will generate:</div>
            <ol className="list-inside list-decimal space-y-0.5 text-xs text-muted">
              {selectedTpl.tasks.filter((t: any) => t.generation === "standard").map((t: any) => (
                <li key={t.id}>{t.name}{t.required ? " · required" : ""}{t.is_decision ? " · decision point" : ""}</li>
              ))}
              {selectedTpl.tasks.some((t: any) => t.generation === "action_plan") && (
                <li className="list-none pt-1 italic">+ {selectedTpl.tasks.filter((t: any) => t.generation === "action_plan").length} action-plan tasks if the decision point answers Yes</li>
              )}
            </ol>
          </div>
        )}
        {error && <p className="col-span-2 text-sm text-rag-red">{error}</p>}
        <div className="col-span-2 flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create project"}</Btn>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { currentUser } = useSession();
  const toast = useToast();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<any | null>(null);
  const [error, setError] = useState("");

  async function loadFile(f: File) {
    setCsv(await f.text());
    setPreview(null); setError("");
  }
  async function doPreview() {
    setError("");
    try { setPreview(await api.post("/api/import/projects/preview", { csv })); }
    catch (e) { setError(e instanceof Error ? e.message : "Preview failed"); }
  }
  async function commit() {
    try {
      const r = await api.post("/api/import/projects/commit", { csv, user_id: currentUser?.id });
      toast(`Imported ${r.created} project(s)${r.skipped ? `, skipped ${r.skipped} with errors` : ""}`, "success");
      onImported(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed"); }
  }

  return (
    <Modal title="Import projects from CSV" onClose={onClose} wide>
      <p className="mb-3 text-xs text-muted">
        Columns: <code className="font-mono">MCP Number, MCP Name, Assignee, Assignment Date (YYYY-MM-DD), Template</code>.
        Assignee matches by name or email; template defaults to the default template. Rows are validated before anything is created.
      </p>
      <input type="file" accept=".csv,text/csv" aria-label="Choose CSV file"
        onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
        className="mb-3 block text-sm" />
      <textarea className={inputCls + " h-32 font-mono text-xs"} placeholder="…or paste CSV content here" value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} />
      {error && <p className="mt-2 text-sm text-rag-red">{error}</p>}
      {preview && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-hairline">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-canvas">
              <tr className="text-left">{["Line", "MCP #", "MCP Name", "Assignee", "Date", "Result"].map((h) => <th key={h} className="px-2 py-1.5 font-semibold text-muted">{h}</th>)}</tr>
            </thead>
            <tbody>
              {preview.rows.map((r: any) => (
                <tr key={r.line} className="border-t border-hairline">
                  <td className="px-2 py-1 font-mono">{r.line}</td>
                  <td className="px-2 py-1 font-mono">{r.mcp_number}</td>
                  <td className="px-2 py-1">{r.mcp_name}</td>
                  <td className="px-2 py-1">{r.assignee}</td>
                  <td className="px-2 py-1 font-mono">{r.assignment_date}</td>
                  <td className="px-2 py-1">
                    {r.errors.length ? <span className="text-rag-red">{r.errors.join("; ")}</span> : <span className="text-rag-green">Ready</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex items-center justify-end gap-2">
        {preview && <span className="mr-auto text-xs text-muted"><b>{preview.valid}</b> ready · <b>{preview.invalid}</b> with errors</span>}
        <Btn onClick={onClose}>Cancel</Btn>
        {!preview ? (
          <Btn kind="primary" onClick={doPreview} disabled={!csv.trim()}>Validate & preview</Btn>
        ) : (
          <Btn kind="primary" onClick={commit} disabled={!preview.valid}>Import {preview.valid} project(s)</Btn>
        )}
      </div>
    </Modal>
  );
}
