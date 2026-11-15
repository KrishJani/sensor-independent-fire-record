// Historical-context helpers for the enrich Workflow: api-worker POST /api/calendar → one line for the brief.

/** History step reason (and UI text) when the area is outside the archive. */
export const OUTSIDE_COVERAGE = "outside harmonized coverage (US regions only)";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Subset of api-worker's POST /api/calendar response (apps/api-worker/src/routes/calendar.ts). */
export interface CalendarResponse {
  range: { from: string; to: string };
  units: string;
  annual: { year: number; harmonizedCellDays: number }[];
  climatology: { month: number; median: number; p75: number; p90: number; n: number }[];
  summary: { peakMonth: string | null; peakYear: number | null; criticalMonthNames: string[] };
}

/** Pad the incident bbox so the calendar covers the fire's surroundings (min 0.5° per side). */
export function historyBbox(b: [number, number, number, number]): [number, number, number, number] {
  const r = (x: number) => Math.round(x * 100) / 100;
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const hw = Math.max((b[2] - b[0]) / 2 + 0.1, 0.25), hh = Math.max((b[3] - b[1]) / 2 + 0.1, 0.25);
  return [r(cx - hw), r(Math.max(-90, cy - hh)), r(cx + hw), r(Math.min(90, cy + hh))];
}

/** One line of history for the brief and the UI, or null when the archive has no activity there. */
export function summarizeCalendar(j: CalendarResponse, month: number): string | null {
  const total = j.annual.reduce((a, y) => a + y.harmonizedCellDays, 0);
  if (!total) return null;
  const c = j.climatology.find((x) => x.month === month);
  const parts = [`${j.range.from.slice(0, 4)}-${j.range.to.slice(0, 4)} harmonized archive`];
  if (c) parts.push(`typical ${MONTHS[month - 1]} ${c.median} active cell-days (p90 ${c.p90}, ${c.n} years)`);
  if (j.summary.criticalMonthNames.length) parts.push(`fire season ${j.summary.criticalMonthNames.join("/")}`);
  if (j.summary.peakYear) parts.push(`busiest year ${j.summary.peakYear}`);
  return parts.join("; ");
}
