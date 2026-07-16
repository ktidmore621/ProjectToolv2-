import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtHours } from "../api";
import { Bucket, bucketMinutes, DateRangeBar, timecardExportUrl, useDateRange } from "../components/DateRange";
import { Page } from "../components/Layout";
import { Card, CsvLink, Mono, Skeleton } from "../components/ui";

/** Team Timecard (§7.2): user-level range grid with project drill-down + activity-type rollup + export. */
export function TeamTimecard() {
  const dateRange = useDateRange();
  const { range, buckets } = dateRange;
  const [logs, setLogs] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    api.get(`/api/timelogs?start=${range.start}&end=${range.end}`).then(setLogs);
  }, [range.start, range.end]);
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

  const grand = (logs ?? []).reduce((s, l) => s + l.total_minutes, 0);
  const maxAct = Math.max(1, ...byActivity.map(([, m]) => m));

  return (
    <Page
      title="Team Timecard"
      actions={
        <>
          <DateRangeBar ctrl={dateRange} />
          <CsvLink href={timecardExportUrl(range)}>Export</CsvLink>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        <Mono>{range.start}</Mono> – <Mono>{range.end}</Mono> · all users · expand a row for per-project detail.
      </p>
      {!logs ? <Skeleton className="h-72" /> : (
        <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="sticky left-0 z-10 bg-surface px-3 py-2.5 text-xs font-semibold text-muted">User / Project</th>
                  {buckets.map((b) => (
                    <th key={b.key} className="px-2 py-2.5 text-right text-xs font-semibold text-muted">
                      {b.label}{b.sub && <> <Mono className="font-normal">{b.sub}</Mono></>}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted">Total</th>
                </tr>
              </thead>
              <tbody>
                {byUser.length === 0 && <tr><td colSpan={buckets.length + 2} className="px-3 py-10 text-center text-sm text-muted">No time logged in this range.</td></tr>}
                {byUser.map(([uid, u], i) => {
                  const byProject = new Map<string, any[]>();
                  for (const l of u.logs) {
                    const k = `${l.project_code} ${l.mcp_name}`;
                    if (!byProject.has(k)) byProject.set(k, []);
                    byProject.get(k)!.push(l);
                  }
                  return (
                    <UserRows key={uid} u={u} byProject={byProject} buckets={buckets} zebra={i % 2 === 1}
                      expanded={expanded.has(uid)}
                      onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; })} />
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-hairline font-semibold">
                  <td className="sticky left-0 bg-surface px-3 py-2.5">Team total</td>
                  {buckets.map((b) => <td key={b.key} className="px-2 py-2.5 text-right"><Mono>{fmtHours(bucketMinutes(logs, b)) || "—"}</Mono></td>)}
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
                {byActivity.length === 0 && <li className="text-sm text-muted">No data in this range.</li>}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}

function UserRows({ u, byProject, buckets, zebra, expanded, onToggle }: any) {
  return (
    <>
      <tr className={`border-b border-hairline ${zebra ? "bg-rowalt" : ""}`}>
        <td className={`sticky left-0 z-10 px-3 py-2 ${zebra ? "bg-rowalt" : "bg-surface"}`}>
          <button onClick={onToggle} className="mr-1.5 text-muted hover:text-ink" aria-label={expanded ? "Collapse" : "Expand"}>{expanded ? "▾" : "▸"}</button>
          <span className="font-medium">{u.name}</span>
        </td>
        {buckets.map((b: Bucket) => {
          const m = bucketMinutes(u.logs, b);
          return <td key={b.key} className={`px-2 py-2 text-right font-mono text-[13px] ${m ? "" : "text-muted/40"}`}>{m ? fmtHours(m) : "·"}</td>;
        })}
        <td className="px-3 py-2 text-right font-medium"><Mono>{fmtHours(u.logs.reduce((s: number, l: any) => s + l.total_minutes, 0))}</Mono></td>
      </tr>
      {expanded && [...byProject.entries()].map(([key, ls]: [string, any[]]) => (
        <tr key={key} className="border-b border-hairline bg-canvas/40 text-xs">
          <td className="sticky left-0 z-10 bg-canvas/40 py-1.5 pl-10 pr-3 text-muted">{key}</td>
          {buckets.map((b: Bucket) => {
            const m = bucketMinutes(ls, b);
            return <td key={b.key} className={`px-2 py-1 text-right font-mono ${m ? "text-ink" : "text-muted/40"}`}>{m ? fmtHours(m) : "·"}</td>;
          })}
          <td className="px-3 py-1 text-right text-muted"><Mono>{fmtHours(ls.reduce((s: number, l: any) => s + l.total_minutes, 0))}</Mono></td>
        </tr>
      ))}
    </>
  );
}
