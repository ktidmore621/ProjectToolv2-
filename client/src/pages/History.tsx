import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtCurrency, fmtDate, Project } from "../api";
import { Page } from "../components/Layout";
import { Card, Chip, CsvLink, EmptyState, inputCls, Mono, Pager, Skeleton } from "../components/ui";

/**
 * Historical / Closed projects — permanent read-only archive (§2.2, §9).
 * E11: search + pagination are server-side across the full archive.
 */
export function History() {
  const [data, setData] = useState<{ rows: Project[]; total: number; page: number; page_size: number } | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ scope: "closed", page: String(page), sort: "closed_date", dir: "desc" });
    if (q.trim()) qs.set("q", q.trim());
    api.get(`/api/projects?${qs}`).then(setData);
  }, [q, page]);
  useEffect(load, [load]);
  useEffect(() => { setPage(1); }, [q]);

  const projects = data?.rows ?? null;

  return (
    <Page
      title="History"
      actions={
        <>
          <input className={inputCls + " !w-56"} placeholder="Search closed projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search closed projects" />
          <CsvLink href="/api/export/wins.csv">Wins report (CSV)</CsvLink>
          <CsvLink href="/api/export/closures.csv">Closure report (CSV)</CsvLink>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Closed projects are permanent, read-only records — never reopened. A returning MCP gets a new project with a new ID.
      </p>
      {!projects ? <Skeleton className="h-96" /> : projects.length === 0 ? (
        <EmptyState title="No closed projects yet" hint="Closed projects stay here as the permanent archive." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {["Project ID", "MCP #", "MCP Name", "Project Name", "Assignee", "AP", "Assigned", "Closed", "Closed By", "Reason", "Final Summary"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-xs font-semibold text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projects.map((p, i) => (
                <tr key={p.id} className={`border-b border-hairline last:border-0 ${i % 2 ? "bg-rowalt" : ""} hover:bg-primary-soft/40`}>
                  <td className="px-3 py-2"><Link to={`/projects/${p.id}`} className="hover:underline"><Mono>{p.project_code}</Mono></Link></td>
                  <td className="px-3 py-2"><Mono className="text-muted">{p.mcp_number}</Mono></td>
                  <td className="px-3 py-2 font-medium">{p.mcp_name}</td>
                  <td className="px-3 py-2">{p.project_name ?? <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2">{p.assignee_name}</td>
                  <td className="px-3 py-2"><Mono>{p.annualized_premium != null ? fmtCurrency(p.annualized_premium) : "—"}</Mono></td>
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
      {data && <Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />}
    </Page>
  );
}
