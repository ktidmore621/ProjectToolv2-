import { useState } from "react";
import { addDays, isoOf, weekStart } from "../api";
import { Btn, inputCls } from "./ui";

/**
 * Shared timecard date-range control (My Timecard + Team Timecard).
 * Presets: Week / Month / Quarter / Custom. Defaults to the current week
 * (Monday start — the app's existing convention from weekStart()).
 * Prev/Next step by the selected granularity; "Current" jumps to the
 * period containing today.
 */

export type RangePreset = "week" | "month" | "quarter" | "custom";

export interface RangeState {
  preset: RangePreset;
  start: string; // ISO yyyy-mm-dd, inclusive
  end: string;   // ISO yyyy-mm-dd, inclusive
}

/** One grid column: an inclusive [start, end] slice of the selected range. */
export interface Bucket {
  key: string;
  label: string;
  /** Optional monospace suffix (day-of-month for day columns). */
  sub?: string;
  start: string;
  end: string;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function monthEnd(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
/** Calendar quarters: Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec. */
function quarterStart(d: Date): Date {
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
}
function daySpan(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86400000) + 1;
}

function periodFor(preset: RangePreset, anchor: Date): { start: string; end: string } {
  if (preset === "month") return { start: isoOf(monthStart(anchor)), end: isoOf(monthEnd(anchor)) };
  if (preset === "quarter") {
    const qs = quarterStart(anchor);
    return { start: isoOf(qs), end: isoOf(new Date(qs.getFullYear(), qs.getMonth() + 3, 0)) };
  }
  const ws = weekStart(anchor);
  return { start: isoOf(ws), end: isoOf(addDays(ws, 6)) };
}

export function currentWeekRange(): RangeState {
  return { preset: "week", ...periodFor("week", new Date()) };
}

/** Column granularity: Week→days, Month→weeks, Quarter→months, Custom→by span. */
export function granularityOf(range: RangeState): "day" | "week" | "month" {
  if (range.preset === "week") return "day";
  if (range.preset === "month") return "week";
  if (range.preset === "quarter") return "month";
  const span = daySpan(range.start, range.end);
  return span <= 31 ? "day" : span <= 92 ? "week" : "month";
}

/**
 * Split the range into column buckets. Buckets partition the range exactly
 * (weeks/months are clipped to the range edges), so column totals always sum
 * to the same grand total regardless of granularity.
 */
export function rangeBuckets(range: RangeState): Bucket[] {
  const g = granularityOf(range);
  const endD = parseIso(range.end);
  const out: Bucket[] = [];
  let cur = parseIso(range.start);
  while (cur <= endD) {
    let bEnd: Date;
    let label: string;
    let sub: string | undefined;
    if (g === "day") {
      bEnd = cur;
      label = DOW[cur.getDay()];
      sub = String(cur.getDate()).padStart(2, "0");
    } else if (g === "week") {
      const we = addDays(weekStart(cur), 6);
      bEnd = we < endD ? we : endD;
      label = cur.getMonth() === bEnd.getMonth()
        ? `${MON[cur.getMonth()]} ${cur.getDate()}–${bEnd.getDate()}`
        : `${MON[cur.getMonth()]} ${cur.getDate()}–${MON[bEnd.getMonth()]} ${bEnd.getDate()}`;
    } else {
      const me = monthEnd(cur);
      bEnd = me < endD ? me : endD;
      label = `${MON[cur.getMonth()]} ${cur.getFullYear()}`;
    }
    const s = isoOf(cur);
    out.push({ key: s, label, sub, start: s, end: isoOf(bEnd) });
    cur = addDays(bEnd, 1);
  }
  return out;
}

/** Minutes logged inside a bucket (ISO strings compare lexicographically). */
export function bucketMinutes(logs: { date: string; total_minutes: number }[], b: Bucket): number {
  return logs.filter((l) => l.date >= b.start && l.date <= b.end).reduce((s, l) => s + l.total_minutes, 0);
}

export interface DateRangeControl {
  range: RangeState;
  buckets: Bucket[];
  granularity: "day" | "week" | "month";
  setPreset: (p: RangePreset) => void;
  shift: (dir: -1 | 1) => void;
  goCurrent: () => void;
  setCustom: (start: string, end: string) => void;
}

export function useDateRange(): DateRangeControl {
  const [range, setRange] = useState<RangeState>(currentWeekRange);

  const setPreset = (preset: RangePreset) => {
    // Custom keeps the currently displayed dates as its starting range;
    // other presets re-anchor to the period containing the displayed start.
    if (preset === "custom") setRange((r) => ({ ...r, preset }));
    else setRange((r) => ({ preset, ...periodFor(preset, parseIso(r.start)) }));
  };

  const shift = (dir: -1 | 1) =>
    setRange((r) => {
      const s = parseIso(r.start);
      if (r.preset === "week") return { ...r, ...periodFor("week", addDays(s, dir * 7)) };
      if (r.preset === "month") return { ...r, ...periodFor("month", new Date(s.getFullYear(), s.getMonth() + dir, 1)) };
      if (r.preset === "quarter") return { ...r, ...periodFor("quarter", new Date(s.getFullYear(), s.getMonth() + dir * 3, 1)) };
      // custom: slide the window by its own span
      const span = daySpan(r.start, r.end);
      return { ...r, start: isoOf(addDays(s, dir * span)), end: isoOf(addDays(parseIso(r.end), dir * span)) };
    });

  const goCurrent = () =>
    setRange((r) => {
      if (r.preset !== "custom") return { ...r, ...periodFor(r.preset, new Date()) };
      // custom has no natural "current period": keep the span, end on today
      const span = daySpan(r.start, r.end);
      const today = new Date();
      return { ...r, start: isoOf(addDays(today, -(span - 1))), end: isoOf(today) };
    });

  const setCustom = (start: string, end: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
    if (start > end) [start, end] = [end, start];
    setRange({ preset: "custom", start, end });
  };

  return { range, buckets: rangeBuckets(range), granularity: granularityOf(range), setPreset, shift, goCurrent, setCustom };
}

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "custom", label: "Custom" },
];

/** The visible control: preset pills, custom date inputs, Prev / Current / Next. */
export function DateRangeBar({ ctrl }: { ctrl: DateRangeControl }) {
  const { range } = ctrl;
  return (
    <>
      <div className="flex items-center gap-1 rounded-lg border border-hairline bg-surface p-0.5">
        {PRESETS.map((p) => (
          <Btn key={p.key} small kind={range.preset === p.key ? "primary" : "ghost"} onClick={() => ctrl.setPreset(p.key)}>
            {p.label}
          </Btn>
        ))}
      </div>
      {range.preset === "custom" && (
        <div className="flex items-center gap-2">
          <input type="date" className={inputCls} value={range.start} aria-label="Range start"
            onChange={(e) => ctrl.setCustom(e.target.value, range.end)} />
          <span className="text-muted">–</span>
          <input type="date" className={inputCls} value={range.end} aria-label="Range end"
            onChange={(e) => ctrl.setCustom(range.start, e.target.value)} />
        </div>
      )}
      <div className="flex items-center gap-1 rounded-lg border border-hairline bg-surface p-0.5">
        <Btn small kind="ghost" onClick={() => ctrl.shift(-1)}>← Prev</Btn>
        <Btn small kind="ghost" onClick={ctrl.goCurrent}>Current</Btn>
        <Btn small kind="ghost" onClick={() => ctrl.shift(1)}>Next →</Btn>
      </div>
    </>
  );
}

/** Export URL + self-describing filename for the currently displayed range. */
export function timecardExportUrl(range: RangeState, userId?: number): string {
  const user = userId ? `user_id=${userId}&` : "";
  return `/api/export/timelogs.csv?${user}start=${range.start}&end=${range.end}`;
}
