import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, Project } from "../api";
import { Page } from "../components/Layout";
import { Card, Chip, CsvLink, EmptyState, inputCls, Mono, Skeleton } from "../components/ui";

/** Historical / Closed projects — permanent read-only archive (§2.2, §9). */
export function History() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => { api.get<Project[]>("/api/projects?scope=closed").then(setProjects); }, []);

  const filtered = useMemo(() => {
    let out = projects ?? [];
    if (q.trim()) {
      const s = q.toLowerCase();
      out = out.filter((p) => [p.mcp_name, p.mcp_number, p.project_code, p.assignee_name, p.close_reason_label ?? ""].some((f) => f?.toLowerCase().includes(s)));
    }
    return [...out].sort((a, b) => ((a.closed_date ?? "") > (b.closed_date ?? "") ? -1 : 1));
  }, [projects, q]);

  return (
    <Page
      title="History"
      actions={
        <>
          <input className={inputCls + " !w-56"} placeholder="Search closed projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search closed projects" />
          <CsvLink href="/api/export/wins.csv">Wins report (CSV)</CsvLink>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Closed projects are permanent, read-only records — never reopened. A returning MCP gets a new project with a new ID.
      </p>
      {!projects ? <Skeleton className="h-96" /> : filtered.length === 0 ? (
        <EmptyState title="No closed projects yet" hint="Closed projects stay here as the permanent archive." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {["Project ID", "MCP #", "MCP Name", "Assignee", "Assigned", "Closed", "Closed By", "Reason", "Final Summary"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-xs font-semibold text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={p.id} className={`border-b border-hairline last:border-0 ${i % 2 ? "bg-rowalt" : ""} hover:bg-primary-soft/40`}>
                  <td className="px-3 py-2"><Link to={`/projects/${p.id}`} className="hover:underline"><Mono>{p.project_code}</Mono></Link></td>
                  <td className="px-3 py-2"><Mono className="text-muted">{p.mcp_number}</Mono></td>
                  <td className="px-3 py-2 font-medium">{p.mcp_name}</td>
                  <td className="px-3 py-2">{p.assignee_name}</td>
                  <td className="px-3 py-2"><Mono>{fmtDate(p.assignment_date)}</Mono></td>
                  <td className="px-3 py-2"><Mono>{fmtDate(p.closed_date)}</Mono></td>
                  <td className="px-3 py-2">{p.closed_by_name ?? "—"}</td>
                  <td className="px-3 py-2">{p.close_reason_label ? <Chip label={p.close_reason_label} color={p.status_color} small /> : "—"}</td>
                  <td className="max-w-md px-3 py-2 text-xs text-muted"><span className="line-clamp-2">{p.final_summary}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
