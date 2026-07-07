import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, api, fmtHours, isoOf, weekStart } from "../api";
import { Page } from "../components/Layout";
import { Btn, Card, inputCls, Mono, Skeleton } from "../components/ui";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Team Timecard (§7.2): user-level weekly grid with project drill-down + activity-type rollup + export. */
export function TeamTimecard() {
  const [start, setStart] = useState(() => weekStart(new Date()));
  const [logs, setLogs] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [range, setRange] = useState({ start: "", end: "" });

  const days = useMemo(() => [...Array(7)].map((_, i) => isoOf(addDays(start, i))), [start]);
  const end = days[6];

  const load = useCallback(() => {
    api.get(`/api/timelogs?start=${days[0]}&end=${end}`).then(setLogs);
  }, [days, end]);
  useEffect(load, [load]);

  const byUser = useMemo(() => {
    const m = new Map<number, { name: string; logs: any[] }>();
    for (const l of logs ?? []) {
      if (!m.has(l.user_id)) m.set(l.user_id, { name: l.user_name, logs: [] });
      m.get(l.user_id)!.logs.push(l);
    }
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [logs]);

  const byActivity = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of logs ?? []) {
      const k = l.activity_type_label ?? "Uncategorised";
      m.set(k, (m.get(k) ?? 0) + l.total_minutes);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [logs]);

  const minutesFor = (ls: any[], date: string) => ls.filter((l) => l.date === date).reduce((s, l) => s + l.total_minutes, 0);
  const grand = (logs ?? []).reduce((s, l) => s + l.total_minutes, 0);
  const maxAct = Math.max(1, ...byActivity.map(([, m]) => m));

  return (
    <Page
      title="Team Timecard"
      actions={
        <>
          <div className="flex items-center gap-1 rounded-lg border border-hairline bg-surface p-0.5">
            <Btn small kind="ghost" onClick={() => setStart(addDays(start, -7))}>← Prev</Btn>
            <Btn small kind="ghost" onClick={() => setStart(weekStart(new Date()))}>Today</Btn>
            <Btn small kind="ghost" onClick={() => setStart(addDays(start, 7))}>Next →</Btn>
          </div>
          <a href={`/api/export/timelogs.csv?start=${days[0]}&end=${end}`}
            className="rounded-lg border border-hairline bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-canvas">Export week</a>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">Week of <Mono>{days[0]}</Mono> · all users · expand a row for per-project detail.</p>
      {!logs ? <Skeleton className="h-72" /> : (
        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="sticky left-0 z-10 bg-surface px-3 py-2.5 text-xs font-semibold text-muted">User / Project</th>
                  {days.map((d, i) => <th key={d} className="px-2 py-2.5 text-right text-xs font-semibold text-muted">{DAY_LABELS[i]} <Mono className="font-normal">{d.slice(8)}</Mono></th>)}
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted">Total</th>
                </tr>
              </thead>
              <tbody>
                {byUser.length === 0 && <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-muted">No time logged this week.</td></tr>}
                {byUser.map(([uid, u], i) => {
                  const byProject = new Map<string, any[]>();
                  for (const l of u.logs) {
                    const k = `${l.project_code} ${l.mcp_name}`;
                    if (!byProject.has(k)) byProject.set(k, []);
                    byProject.get(k)!.push(l);
                  }
                  return (
                    <UserRows key={uid} uid={uid} u={u} byProject={byProject} days={days} zebra={i % 2 === 1}
                      expanded={expanded.has(uid)} minutesFor={minutesFor}
                      onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; })} />
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-hairline font-semibold">
                  <td className="sticky left-0 bg-surface px-3 py-2.5">Team total</td>
                  {days.map((d) => <td key={d} className="px-2 py-2.5 text-right"><Mono>{fmtHours(minutesFor(logs, d)) || "—"}</Mono></td>)}
                  <td className="px-3 py-2.5 text-right"><Mono>{fmtHours(grand)}</Mono></td>
                </tr>
              </tfoot>
            </table>
          </Card>

          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold">Hours by activity type</h2>
              <ul className="space-y-2.5">
                {byActivity.map(([label, mins]) => (
                  <li key={label}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="font-medium">{label}</span>
                      <Mono className="text-muted">{fmtHours(mins)}</Mono>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-canvas">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${(mins / maxAct) * 100}%` }} />
                    </div>
                  </li>
                ))}
                {byActivity.length === 0 && <li className="text-sm text-muted">No data this week.</li>}
              </ul>
            </Card>
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold">Export custom range</h2>
              <div className="flex items-center gap-2">
                <input type="date" className={inputCls} value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} aria-label="Range start" />
                <span className="text-muted">–</span>
                <input type="date" className={inputCls} value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} aria-label="Range end" />
              </div>
              <a
                className={`mt-3 inline-block rounded-lg px-3.5 py-1.5 text-sm font-medium ${range.start && range.end ? "bg-primary text-white hover:bg-primary/90" : "pointer-events-none bg-hairline text-muted"}`}
                href={`/api/export/timelogs.csv?start=${range.start}&end=${range.end}`}
              >
                Export CSV
              </a>
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}

function UserRows({ uid, u, byProject, days, zebra, expanded, onToggle, minutesFor }: any) {
  return (
    <>
      <tr className={`border-b border-hairline ${zebra ? "bg-rowalt" : ""}`}>
        <td className={`sticky left-0 z-10 px-3 py-2 ${zebra ? "bg-rowalt" : "bg-surface"}`}>
          <button onClick={onToggle} className="mr-1.5 text-muted hover:text-ink" aria-label={expanded ? "Collapse" : "Expand"}>{expanded ? "▾" : "▸"}</button>
          <span className="font-medium">{u.name}</span>
        </td>
        {days.map((d: string) => {
          const m = minutesFor(u.logs, d);
          return <td key={d} className={`px-2 py-2 text-right font-mono text-[13px] ${m ? "" : "text-muted/40"}`}>{m ? fmtHours(m) : "·"}</td>;
        })}
        <td className="px-3 py-2 text-right font-medium"><Mono>{fmtHours(u.logs.reduce((s: number, l: any) => s + l.total_minutes, 0))}</Mono></td>
      </tr>
      {expanded && [...byProject.entries()].map(([key, ls]: [string, any[]]) => (
        <tr key={key} className="border-b border-hairline bg-canvas/40 text-xs">
          <td className="sticky left-0 z-10 bg-canvas/40 py-1.5 pl-10 pr-3 text-muted">{key}</td>
          {days.map((d: string) => {
            const m = minutesFor(ls, d);
            return <td key={d} className={`px-2 py-1 text-right font-mono ${m ? "text-ink" : "text-muted/40"}`}>{m ? fmtHours(m) : "·"}</td>;
          })}
          <td className="px-3 py-1 text-right text-muted"><Mono>{fmtHours(ls.reduce((s: number, l: any) => s + l.total_minutes, 0))}</Mono></td>
        </tr>
      ))}
    </>
  );
}
