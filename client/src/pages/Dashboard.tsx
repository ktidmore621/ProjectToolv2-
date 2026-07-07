import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, Project } from "../api";
import { Page } from "../components/Layout";
import { Card, EmptyState, Mono, RagChip, ragColor, Skeleton } from "../components/ui";
import { useSession } from "../state";

interface DashData {
  active_count: number;
  closed_count: number;
  rag_breakdown: Record<string, number>;
  overdue_tasks: any[];
  blocked_tasks: any[];
  my_open_tasks: any[];
  recent_wins: Project[];
  attention: Project[];
}

export function Dashboard() {
  const { currentUser } = useSession();
  const [data, setData] = useState<DashData | null>(null);

  useEffect(() => {
    api.get<DashData>(`/api/dashboard${currentUser ? `?user_id=${currentUser.id}` : ""}`).then(setData);
  }, [currentUser]);

  if (!data)
    return (
      <Page title="Dashboard" breathe>
        <div className="grid grid-cols-4 gap-5">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      </Page>
    );

  const total = Math.max(1, data.rag_breakdown.red + data.rag_breakdown.amber + data.rag_breakdown.green);

  return (
    <Page title="Dashboard" breathe>
      {/* Stat row */}
      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <Stat label="Active projects" value={data.active_count} to="/projects" />
        <Stat label="Overdue tasks" value={data.overdue_tasks.length} tone={data.overdue_tasks.length ? "red" : undefined} />
        <Stat label="Blocked tasks" value={data.blocked_tasks.length} tone={data.blocked_tasks.length ? "red" : undefined} />
        <Stat label="Closed (all time)" value={data.closed_count} to="/history" />
      </div>

      {/* RAG breakdown — the signature visual (§10.1) */}
      <Card className="mt-5 p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Portfolio RAG</h2>
          <Link to="/kanban" className="text-xs font-medium text-accent hover:underline">Open Kanban →</Link>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full" role="img"
          aria-label={`RAG: ${data.rag_breakdown.red} red, ${data.rag_breakdown.amber} amber, ${data.rag_breakdown.green} green`}>
          {(["red", "amber", "green"] as const).map((r) =>
            data.rag_breakdown[r] > 0 ? (
              <div key={r} style={{ width: `${(data.rag_breakdown[r] / total) * 100}%`, backgroundColor: ragColor(r) }} />
            ) : null
          )}
        </div>
        <div className="mt-3 flex gap-5 text-sm">
          {(["red", "amber", "green"] as const).map((r) => (
            <span key={r} className="flex items-center gap-2">
              <RagChip rag={r} small /> <Mono>{data.rag_breakdown[r] ?? 0}</Mono>
            </span>
          ))}
        </div>
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* Needs attention */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Needs attention</h2>
          {data.attention.length === 0 && <EmptyState title="Nothing is red right now" hint="Blocked or overdue projects appear here." />}
          <ul className="divide-y divide-hairline">
            {data.attention.map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-canvas -mx-2 px-2 rounded-lg">
                  <span>
                    <span className="font-medium">{p.mcp_name}</span>
                    <span className="ml-2 text-xs text-muted"><Mono>{p.project_code}</Mono> · {p.rag_reason}</span>
                  </span>
                  <RagChip rag={p.rag} small />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* My open work */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">My open work {currentUser && <span className="font-normal text-muted">· {currentUser.name}</span>}</h2>
          {!currentUser && <EmptyState title="Pick your name in the sidebar" hint="Your assigned open tasks will show here." />}
          {currentUser && data.my_open_tasks.length === 0 && <EmptyState title="No open tasks assigned to you" />}
          <ul className="divide-y divide-hairline">
            {data.my_open_tasks.map((t) => (
              <li key={t.id}>
                <Link to={`/projects/${t.project_id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-canvas -mx-2 px-2 rounded-lg">
                  <span>
                    <span className="font-medium">{t.name}</span>
                    <span className="ml-2 text-xs text-muted">{t.mcp_name}</span>
                  </span>
                  <Mono className="shrink-0 text-xs text-muted">{t.due_date ? fmtDate(t.due_date) : "no due date"}</Mono>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* Overdue & blocked */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Overdue & blocked tasks</h2>
          {data.overdue_tasks.length + data.blocked_tasks.length === 0 && <EmptyState title="All clear" />}
          <ul className="divide-y divide-hairline">
            {data.blocked_tasks.map((t) => (
              <li key={`b${t.id}`}>
                <Link to={`/projects/${t.project_id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-canvas -mx-2 px-2 rounded-lg">
                  <span><span className="font-medium">{t.name}</span><span className="ml-2 text-xs text-muted">{t.mcp_name}</span></span>
                  <span className="rounded bg-rag-red/10 px-2 py-px text-[11px] font-semibold text-rag-red">Blocked</span>
                </Link>
              </li>
            ))}
            {data.overdue_tasks.map((t) => (
              <li key={`o${t.id}`}>
                <Link to={`/projects/${t.project_id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-canvas -mx-2 px-2 rounded-lg">
                  <span><span className="font-medium">{t.name}</span><span className="ml-2 text-xs text-muted">{t.mcp_name}</span></span>
                  <Mono className="shrink-0 text-xs text-rag-red">{fmtDate(t.due_date)}</Mono>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* Recent wins */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Recent wins <span className="font-normal text-muted">· last 30 days</span></h2>
          {data.recent_wins.length === 0 && <EmptyState title="No closures in the last 30 days" />}
          <ul className="divide-y divide-hairline">
            {data.recent_wins.map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`} className="block py-2.5 hover:bg-canvas -mx-2 px-2 rounded-lg">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{p.mcp_name}</span>
                    <span className="text-xs text-muted">{p.close_reason_label}</span>
                  </div>
                  {p.final_summary && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{p.final_summary}</p>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Page>
  );
}

function Stat({ label, value, to, tone }: { label: string; value: number; to?: string; tone?: "red" }) {
  const body = (
    <Card className={`p-5 ${to ? "transition-shadow hover:shadow-lift" : ""}`}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 font-mono text-3xl font-semibold tracking-tight ${tone === "red" ? "text-rag-red" : ""}`}>{value}</div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}
