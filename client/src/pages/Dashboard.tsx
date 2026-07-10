import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, api, fmtDate, fmtDayOrdinal, fmtTime, Project, Win } from "../api";
import {
  ActivityTypeIcon, AlertIcon, ArchiveIcon, BlockedIcon, CheckIcon, FolderIcon, TrophyIcon,
} from "../components/icons";
import { Card, CsvLink, EmptyState, Mono, RagChip, ragColor, Skeleton, tint } from "../components/ui";
import { useSession } from "../state";

interface WeekItem {
  kind: "task" | "activity";
  id: number;
  project_id: number;
  name: string;
  date: string;
  time: string | null;
  type_key: string;
  type_label: string;
  mcp_name: string;
  done: boolean;
}

interface DashData {
  scope: "mine" | "all";
  active_count: number;
  closed_count: number;
  closed_this_week: number;
  trends: { active: string; overdue: string; blocked: string; closed: string };
  rag_breakdown: Record<string, number>;
  overdue_tasks: any[];
  blocked_tasks: any[];
  my_open_tasks: any[];
  week_start: string;
  this_week: WeekItem[];
  recent_activity: Activity[];
  recent_wins: Win[];
  attention: Project[];
}

export function Dashboard() {
  const { currentUser } = useSession();
  const [data, setData] = useState<DashData | null>(null);

  useEffect(() => {
    api.get<DashData>(`/api/dashboard${currentUser ? `?user_id=${currentUser.id}` : ""}`).then(setData);
  }, [currentUser]);

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = currentUser?.name.split(" ")[0];

  if (!data)
    return (
      <div className="mx-auto max-w-[1400px] px-8 py-7">
        <Skeleton className="mb-6 h-12 w-96" />
        <div className="grid grid-cols-4 gap-5">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
      </div>
    );

  const total = Math.max(1, data.rag_breakdown.red + data.rag_breakdown.amber + data.rag_breakdown.green);

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-7">
      {/* Executive summary header (§2.1) */}
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {now.toLocaleDateString(undefined, { weekday: "long" })}, {fmtDayOrdinal(now)}
          {!firstName && <> — pick your name in the sidebar to personalize this view</>}
          {firstName && <> — showing {data.scope === "mine" ? "only your data" : "data for all users"} · set per user in Configuration → Working As</>}
        </p>
      </header>

      {/* KPI row — every card deep-links into a pre-filtered Projects view (§1) */}
      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <KpiCard to="/projects?view=list" icon={<FolderIcon size={18} />} color="#2E4E8F"
          value={data.active_count} label="Active projects" trend={data.trends.active} />
        <KpiCard to="/projects?view=tasks&overdue=1" icon={<AlertIcon size={18} />} color="#C2554E"
          value={data.overdue_tasks.length} label="Overdue tasks" trend={data.trends.overdue} alert={data.overdue_tasks.length > 0} />
        <KpiCard to="/projects?view=tasks&blocked=1" icon={<BlockedIcon size={18} />} color="#C99239"
          value={data.blocked_tasks.length} label="Blocked tasks" trend={data.trends.blocked} alert={data.blocked_tasks.length > 0} />
        <KpiCard to="/history" icon={<ArchiveIcon size={18} />} color="#4E9468"
          value={data.closed_this_week} label="Closed this week" trend={`${data.closed_count} all time`} />
      </div>

      {/* Portfolio RAG summary (§2.1) */}
      <Card className="mt-5 p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Portfolio RAG</h2>
          <Link to="/projects?view=kanban" className="text-xs font-medium text-accent hover:underline">Open Kanban →</Link>
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
        {/* This Week (§2.2) */}
        <ThisWeekPanel items={data.this_week} weekStart={data.week_start} />

        {/* Recent activity feed (§2.3) */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Recent activity</h2>
          {data.recent_activity.length === 0 && <EmptyState title="No activity yet" />}
          <ul className="divide-y divide-hairline">
            {data.recent_activity.slice(0, 10).map((a) => (
              <li key={a.id}>
                <Link to={`/projects/${a.project_id}`} className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-canvas">
                  {a.kind === "activity" ? (
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full"
                      style={{ backgroundColor: tint(a.activity_type_color ?? "#5C6B84", 0.15), color: a.activity_type_color ?? "#5C6B84" }}>
                      <ActivityTypeIcon typeKey={a.activity_type_key} size={13} />
                    </span>
                  ) : (
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-canvas font-mono text-[10px] font-semibold text-muted">
                      {a.user_name.split(" ").map((s) => s[0]).join("").slice(0, 2)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-xs leading-snug">
                    <span className="font-medium">{a.user_name}</span>{" "}
                    <span className="text-muted">{a.kind === "status_change" || a.kind === "system" ? a.note : a.kind === "activity" ? `logged: ${a.note}` : `noted: ${a.note}`}</span>
                    <span className="mt-0.5 block text-[11px] text-muted">{a.mcp_name} · <Mono>{a.activity_date?.slice(0, 16).replace("T", " ")}</Mono></span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* Overdue & blocked — carried forward as-is (§2.4) */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Overdue & blocked tasks</h2>
          {data.overdue_tasks.length + data.blocked_tasks.length === 0 && <EmptyState title="All clear" />}
          <ul className="divide-y divide-hairline">
            {data.blocked_tasks.map((t) => (
              <li key={`b${t.id}`}>
                <Link to={`/projects/${t.project_id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-canvas">
                  <span><span className="font-medium">{t.name}</span><span className="ml-2 text-xs text-muted">{t.mcp_name}</span></span>
                  <span className="rounded bg-rag-red/10 px-2 py-px text-[11px] font-semibold text-rag-red">Blocked</span>
                </Link>
              </li>
            ))}
            {data.overdue_tasks.map((t) => (
              <li key={`o${t.id}`}>
                <Link to={`/projects/${t.project_id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-canvas">
                  <span><span className="font-medium">{t.name}</span><span className="ml-2 text-xs text-muted">{t.mcp_name}</span></span>
                  <Mono className="shrink-0 text-xs text-rag-red">{fmtDate(t.due_date)}</Mono>
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
                <Link to={`/projects/${t.project_id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-canvas">
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
      </div>

      {/* Recent wins — highlight reel (§2.5) */}
      <div className="mt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Recent wins <span className="font-normal text-muted">· last 30 days</span></h2>
          <CsvLink href="/api/export/wins.csv">Export wins (CSV)</CsvLink>
        </div>
        {data.recent_wins.length === 0 && <EmptyState title="No wins logged in the last 30 days" hint="Log wins from any project's Wins tab — at any point, not just at closure." />}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.recent_wins.map((w) => (
            <Link key={w.id} to={`/projects/${w.project_id}`}>
              <Card className="h-full p-4 transition-shadow hover:shadow-lift"
                style={{ boxShadow: `inset 0 3px 0 0 ${w.category_color ?? "#4E9468"}` }}>
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full"
                    style={{ backgroundColor: tint(w.category_color ?? "#4E9468", 0.15), color: w.category_color ?? "#4E9468" }}>
                    <TrophyIcon size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">{w.description}</p>
                    <div className="mt-1.5 text-xs text-muted">
                      {w.mcp_name} · <Mono>{fmtDate(w.occurred_date)}</Mono>
                    </div>
                    {w.category_label && (
                      <span className="mt-1.5 inline-block rounded-full px-2 py-px text-[11px] font-semibold"
                        style={{ backgroundColor: tint(w.category_color!, 0.14), color: w.category_color! }}>
                        {w.category_label}
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ to, icon, color, value, label, trend, alert }: {
  to: string; icon: React.ReactNode; color: string; value: number; label: string; trend: string; alert?: boolean;
}) {
  return (
    <Link to={to} aria-label={`${label}: ${value}. ${trend}. Open filtered view.`}>
      <Card className="p-5 transition-shadow hover:shadow-lift">
        <span className="grid h-9 w-9 place-items-center rounded-full" style={{ backgroundColor: tint(color, 0.15), color }}>
          {icon}
        </span>
        <div className={`mt-3 font-mono text-3xl font-semibold tracking-tight ${alert ? "text-rag-red" : ""}`}>{value}</div>
        <div className="mt-0.5 text-xs font-medium text-muted">{label}</div>
        <div className="mt-1 text-[11px] text-muted/80">{trend}</div>
      </Card>
    </Link>
  );
}

// Deterministic token-palette color for customer initial badges (per reference image)
const AVATAR_COLORS = ["#2E4E8F", "#12808A", "#8A6FB8", "#C99239", "#4E9468", "#B0632F"];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function ThisWeekPanel({ items, weekStart }: { items: WeekItem[]; weekStart: string }) {
  const [fullWeek, setFullWeek] = useState(false);
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const groups = useMemo(() => {
    const byDate = new Map<string, WeekItem[]>();
    for (const it of items) {
      if (!byDate.has(it.date)) byDate.set(it.date, []);
      byDate.get(it.date)!.push(it);
    }
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const visible = fullWeek ? groups : groups.filter(([d]) => d >= todayIso);
  const hiddenPast = groups.length - visible.length;

  function dayLabel(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    const diff = Math.round((d.getTime() - new Date(todayIso + "T00:00:00").getTime()) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">This Week <span className="font-normal text-muted">· from {fmtDate(weekStart)}</span></h2>
        <Link to="/timecard" className="text-xs font-medium text-accent hover:underline">View Calendar →</Link>
      </div>
      {visible.length === 0 && <EmptyState title="Nothing scheduled this week" hint="Tasks due and logged calls, visits and meetings appear here." />}
      <div className="space-y-4">
        {visible.map(([date, dayItems]) => (
          <div key={date}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className={`text-xs font-semibold ${date === todayIso ? "text-primary" : ""}`}>{dayLabel(date)}</span>
              <span className="text-[11px] text-muted">{fmtDayOrdinal(new Date(date + "T00:00:00"))}</span>
            </div>
            <ul className="space-y-1">
              {dayItems.map((it) => (
                <li key={`${it.kind}${it.id}`}>
                  <Link to={`/projects/${it.project_id}`}
                    className={`-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-canvas ${it.done ? "opacity-55" : ""}`}>
                    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${it.done ? "bg-rag-green/15 text-rag-green" : "bg-canvas text-muted"}`}>
                      {it.done ? <CheckIcon size={13} /> : <ActivityTypeIcon typeKey={it.type_key} size={13} />}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-sm ${it.done ? "text-muted line-through decoration-hairline" : ""}`}>{it.name}</span>
                    {it.time && <Mono className="shrink-0 text-[11px] text-muted">{fmtTime(it.time)}</Mono>}
                    <span className="hidden max-w-28 truncate text-[11px] text-muted sm:block">{it.mcp_name}</span>
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[9px] font-semibold text-white"
                      style={{ backgroundColor: avatarColor(it.mcp_name) }} title={it.mcp_name}>
                      {it.mcp_name.split(" ").map((s) => s[0]).join("").slice(0, 2)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {(hiddenPast > 0 || fullWeek) && (
        <button onClick={() => setFullWeek(!fullWeek)} className="mt-3 text-xs font-medium text-accent hover:underline">
          {fullWeek ? "Hide earlier days" : `View full week (${hiddenPast} earlier day${hiddenPast === 1 ? "" : "s"})`}
        </button>
      )}
    </Card>
  );
}
