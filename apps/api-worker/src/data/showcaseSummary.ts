// get_spots_summary for a showcase period: the same R2 files as /api/archival/spots (routes/showcase.ts), so the
// copilot reports what the Archival map is drawing. Pure (unit-tested); loading is in routes/showcase.ts.

import type { Bbox } from "../copilot/context";
import type { PeriodData } from "../routes/showcase";
import type { SpotsSummary } from "./fireData";

const SAT = ["TERRA", "AQUA", "SNPP", "NOAA20", "NOAA21"];
const sensorOf = (s: number): "MODIS" | "VIIRS" => (s <= 1 ? "MODIS" : "VIIRS");
const round1 = (x: number) => Math.round(x * 10) / 10;
const hhmm = (t: number) => `${String(Math.floor(t / 100)).padStart(2, "0")}:${String(t % 100).padStart(2, "0")}`;

export function summarizeShowcase(P: PeriodData, q: { bbox: Bbox; from: string; to: string }): SpotsSummary {
  const from = q.from < P.from ? P.from : q.from;
  const to = q.to > P.to ? P.to : q.to;
  const [w, s, e, n] = q.bbox;
  const r0 = Math.floor((s + 90) * 20), r1 = Math.ceil((n + 90) * 20) - 1, c0 = Math.floor((w + 180) * 20), c1 = Math.ceil((e + 180) * 20) - 1;
  const dayOk = P.dates.map((d) => d >= from && d <= to);

  let detections = 0, harmonized = 0;
  const cellDays = new Set<number>(), cells = new Set<number>();
  const bySat = new Map<string, { detections: number; cellDays: Set<number> }>();
  const daily = new Map<number, { cells: Set<number>; pk: number }>();
  const C = P.cells;
  for (let i = 0; i < C.c.length; i++) {
    if (!dayOk[C.d[i]]) continue;
    const row = Math.floor(C.c[i] / 7200), col = C.c[i] % 7200;
    if (row < r0 || row > r1 || col < c0 || col > c1) continue;
    const key = C.d[i] * 30_000_000 + C.c[i];
    detections += C.n[i];
    harmonized += C.w[i] ?? 0;
    cellDays.add(key);
    cells.add(C.c[i]);
    const sat = SAT[C.s[i]] ?? "UNKNOWN";
    const b = bySat.get(sat) ?? bySat.set(sat, { detections: 0, cellDays: new Set() }).get(sat)!;
    b.detections += C.n[i];
    b.cellDays.add(key);
    const d = daily.get(C.d[i]) ?? daily.set(C.d[i], { cells: new Set(), pk: 0 }).get(C.d[i])!;
    d.cells.add(C.c[i]);
    d.pk = Math.max(d.pk, C.p[i]);
  }

  const Q = P.points;
  const top: number[] = [];
  let lastDay = -1, lastTime = -1;
  for (let i = 0; i < Q.lat.length; i++) {
    if (!dayOk[Q.d[i]] || Q.lat[i] < s || Q.lat[i] > n || Q.lon[i] < w || Q.lon[i] > e) continue;
    top.push(i);
    if (Q.d[i] > lastDay || (Q.d[i] === lastDay && Q.t[i] > lastTime)) { lastDay = Q.d[i]; lastTime = Q.t[i]; }
  }
  top.sort((a, b) => Q.f[b] - Q.f[a]);

  const clipped = from !== q.from || to !== q.to;
  const base = `Showcase period "${P.label}" (${P.from} to ${P.to}): the same NASA FIRMS data the Archival map draws for it.`;
  const kind = P.harmonized
    ? ` HARMONIZED: harmonizedCellDays is the VIIRS-equivalent activity, comparable with the calendar and across years (within 1% of the calendar). Per-satellite detections and cell-days are raw and not harmonized.`
    : ` RAW VIIRS detections, NOT harmonized: the area is outside the US harmonized archive, so these counts are not comparable with the calendar, other years or MODIS. Say "raw VIIRS detections" when you cite them.`;
  return {
    dataSource: "live",
    note: base + kind + " FRP is not comparable across sensors." + (clipped ? ` The requested range ${q.from} to ${q.to} was clipped to the period's ${from} to ${to}.` : ""),
    mode: "archival",
    bbox: q.bbox,
    from,
    to,
    showcase: { id: P.id, label: P.label, from: P.from, to: P.to, harmonized: P.harmonized },
    ...(P.harmonized ? { harmonizedCellDays: Math.round(harmonized) } : {}),
    counts: {
      detections,
      activeCellDays: cellDays.size,
      distinctCells: cells.size,
      bySatellite: Object.fromEntries([...bySat].map(([k, v]) => [k, { detections: v.detections, cellDays: v.cellDays.size }]))
    },
    daily: [...daily].sort((a, b) => a[0] - b[0]).map(([d, v]) => ({ date: P.dates[d], activeCells: v.cells.size, peakFrpMw: round1(v.pk) })),
    lastSeen: lastDay >= 0 ? `${P.dates[lastDay]}T${hhmm(lastTime)}:00Z` : null,
    topDetections: top.slice(0, 10).map((i) => ({
      lat: Q.lat[i],
      lon: Q.lon[i],
      date: P.dates[Q.d[i]],
      timeUtc: hhmm(Q.t[i]),
      satellite: SAT[Q.s[i]] ?? "UNKNOWN",
      sensor: sensorOf(Q.s[i]),
      frpMw: round1(Q.f[i]),
      confidence: Q.q[i]
    }))
  };
}
