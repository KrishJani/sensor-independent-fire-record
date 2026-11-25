// Region-level context shared by the copilot (LiveFireData) and GET /api/context (realtime-worker briefs).
//
// The detailed archive (cell_days) is not loaded, so calendars can only be served per harmonized REGION
// (precomputed scope). Everything here therefore describes the whole region, never an incident's own area,
// and every sentence names the region explicitly.

import { inBbox, type Bbox } from '@repo/harmonizer';
import type { Ctx } from '../lib/db.ts';
import { coverage, inUS, MIN_COVERAGE } from '../lib/coverage.ts';
import { calendar } from '../routes/calendar.ts';
import { CONFIG, REGIONS } from '../routes/meta.ts';
import type { AnomalyClass } from './fireData.ts';

export type Region = (typeof REGIONS)[number];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const round = (x: number, dp = 1) => Math.round(x * 10 ** dp) / 10 ** dp;
const BBOX_OF = new Map(REGIONS.map((r) => [r.id, r.bbox]));

/** "Southeast (…)" → "Southeast region". */
export function regionLabel(r: Region): string {
  return `${r.name.replace(/\s*\(.*\)\s*$/, '')} region`;
}
export const regionRef = (r: Region) => ({ id: r.id, name: r.name, label: regionLabel(r) });

const excluded = (r: Region): Bbox[] => (r.exclude ?? []).map((id) => BBOX_OF.get(id)!).filter(Boolean) as Bbox[];

/** Region holding a point: first region (list order) whose bbox contains it minus its exclusions, on US territory. */
export function regionOfPoint(lon: number, lat: number): Region | null {
  if (!inUS(lon, lat)) return null;
  for (const r of REGIONS) {
    if (inBbox(lat, lon, r.bbox) && !excluded(r).some((b) => inBbox(lat, lon, b))) return r;
  }
  return null;
}

/** Region with the largest overlap with the AOI, when most of the AOI is inside harmonized coverage. */
export function regionOfBbox(b: Bbox): Region | null {
  if (coverage(b) < MIN_COVERAGE) return null;
  let best: { r: Region; area: number } | null = null;
  for (const r of REGIONS) {
    const w = Math.max(0, Math.min(b[2], r.bbox[2]) - Math.max(b[0], r.bbox[0]));
    const h = Math.max(0, Math.min(b[3], r.bbox[3]) - Math.max(b[1], r.bbox[1]));
    const area = w * h; // minus exclusions is ignored: regions tile, so the dominant bbox is the right pick
    if (area > 0 && (!best || area > best.area)) best = { r, area };
  }
  return best?.r ?? null;
}

/** Class of a value against prorated climatology percentiles. */
export function classifyAgainst(value: number, c: { median: number; p10: number; p25: number; p75: number; p90: number }, f: number): AnomalyClass {
  if (value < c.p10 * f) return 'much_below';
  if (value < c.p25 * f) return 'below';
  if (value <= c.p75 * f) return 'normal';
  if (value <= c.p90 * f) return 'above';
  return 'much_above';
}

const CLASS_WORDS: Record<string, string> = {
  record_low: 'a record low for the month', much_below: 'well below normal', below: 'below normal', normal: 'about normal',
  above: 'above normal', much_above: 'well above normal', record_high: 'a record high for the month',
};

export interface MonthToDate {
  month: string; // YYYY-MM
  throughDay: number;
  value: number;
  daysWithoutViirs: string[];
  daily: { date: string; harmonizedCellDays: number }[];
}

/**
 * This month's VIIRS-equivalent active cell-days in a region, from D1 (nrt_cell_days joined to the day's VIIRS
 * reference satellite, like /api/realtime/spots). Complete UTC days only: through yesterday, or the whole previous
 * month on the 1st. Cells are counted in 0.5° bins whose centre is on US territory (the NRT tier is global; the
 * archive is US-only), so the national border is approximate.
 */
export async function regionMonthToDate(env: Env, region: Region, now = new Date()): Promise<MonthToDate | null> {
  const today = now.toISOString().slice(0, 10);
  const to = addDays(today, -1);
  const from = `${to.slice(0, 7)}-01`;
  const [w, s, e, n] = region.bbox;
  const params: unknown[] = [from, to, s, n, w, e];
  let notIn = '';
  for (const b of excluded(region)) {
    const k = params.length;
    notIn += ` AND NOT (c.grid_lat >= ?${k + 1} AND c.grid_lat < ?${k + 2} AND c.grid_lon >= ?${k + 3} AND c.grid_lon < ?${k + 4})`;
    params.push(b[1], b[3], b[0], b[2]);
  }
  const sql = `WITH ref AS (
      SELECT acq_date, CASE WHEN max(satellite = 'SNPP') THEN 'SNPP' WHEN max(satellite = 'NOAA20') THEN 'NOAA20' WHEN max(satellite = 'NOAA21') THEN 'NOAA21' END AS sat
      FROM nrt_availability WHERE acq_date BETWEEN ?1 AND ?2 GROUP BY acq_date)
    SELECT (c.cell_id / 7200) / 10 AS br, (c.cell_id % 7200) / 10 AS bc, c.acq_date AS d, count(*) AS n
    FROM nrt_cell_days c JOIN ref ON ref.acq_date = c.acq_date AND ref.sat = c.satellite
    WHERE c.acq_date BETWEEN ?1 AND ?2 AND c.grid_lat >= ?3 AND c.grid_lat < ?4 AND c.grid_lon >= ?5 AND c.grid_lon < ?6${notIn}
    GROUP BY br, bc, d`;
  const rows = (await env.NRT_DB.prepare(sql).bind(...params).all<{ br: number; bc: number; d: string; n: number }>()).results;
  const refs = (await env.NRT_DB.prepare(
    `SELECT acq_date, max(satellite IN ('SNPP','NOAA20','NOAA21')) AS v FROM nrt_availability WHERE acq_date BETWEEN ?1 AND ?2 GROUP BY acq_date`,
  ).bind(from, to).all<{ acq_date: string; v: number }>()).results;
  const withViirs = new Set(refs.filter((r) => r.v).map((r) => r.acq_date));
  if (!withViirs.size) return null;
  const perDay = new Map<string, number>();
  for (const r of rows) {
    if (!inUS(-180 + (r.bc + 0.5) * 0.5, -90 + (r.br + 0.5) * 0.5)) continue;
    perDay.set(r.d, (perDay.get(r.d) ?? 0) + r.n);
  }
  const daily = [...withViirs].sort().map((date) => ({ date, harmonizedCellDays: perDay.get(date) ?? 0 }));
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return {
    month: from.slice(0, 7),
    throughDay: Number(to.slice(8)),
    value: daily.reduce((a, x) => a + x.harmonizedCellDays, 0),
    daysWithoutViirs: days.filter((d) => !withViirs.has(d)),
    daily,
  };
}

export type RegionContext =
  | { available: false; reason: string }
  | {
      available: true;
      region: ReturnType<typeof regionRef>;
      basis: 'archive_month' | 'month_to_date' | 'climatology';
      month: string;
      throughDay: number | null;
      value: number;
      median: number;
      ratioToMedian: number | null;
      class: AnomalyClass | null;
      baseline: string;
      /** One sentence for briefs and the copilot; always names the region. */
      text: string;
    };

/**
 * How a region's activity in the month of `date` compares with its 2001–2025 median for that month: the archive's
 * own month when it is loaded (replays of past scenarios), else this month so far from D1 against the median
 * prorated by day. Region-level, never the incident's own area.
 */
export async function regionContext(env: Env, ctx: Ctx, lon: number, lat: number, date: string): Promise<RegionContext> {
  const region = regionOfPoint(lon, lat);
  if (!region) return { available: false, reason: 'outside harmonized coverage (US regions only)' };
  const cal = await calendar(env, ctx, { scope: region.id });
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const baseline = `${(CONFIG.baselineYears as number[])[0]}-${(CONFIG.baselineYears as number[])[1]}`;
  const label = regionLabel(region);
  const entry = cal.calendar.find((c) => c.year === y && c.month === m);
  if (entry?.complete && entry.anomaly) {
    const a = entry.anomaly;
    const text = `${label} in ${MONTHS[m - 1]} ${y}: ${Math.round(entry.harmonizedCellDays)} active cell-days against a ${baseline} median of ${Math.round(a.median)} for that month (${a.ratioToMedian ?? '?'}x, ${CLASS_WORDS[a.class] ?? a.class})`;
    return { available: true, region: regionRef(region), basis: 'archive_month', month: `${y}-${String(m).padStart(2, '0')}`, throughDay: null, value: entry.harmonizedCellDays, median: a.median, ratioToMedian: a.ratioToMedian, class: a.class as AnomalyClass, baseline, text };
  }
  const clim = cal.climatology.find((c) => c.month === m);
  const mtd = await regionMonthToDate(env, region, new Date()).catch(() => null);
  if (mtd && clim && mtd.month === `${y}-${String(m).padStart(2, '0')}`) {
    const f = mtd.throughDay / daysIn(y, m);
    const median = round(clim.median * f);
    const ratio = median > 0 ? round(mtd.value / median, 2) : null;
    const cls = classifyAgainst(mtd.value, clim, f);
    const text = `${label} so far in ${MONTHS[m - 1]} (through the ${mtd.throughDay}${ordinal(mtd.throughDay)}): ${Math.round(mtd.value)} active cell-days against a ${baseline} median of ${median} for the same days (${ratio === null ? 'no baseline' : `${ratio}x`}, ${CLASS_WORDS[cls]})`;
    return { available: true, region: regionRef(region), basis: 'month_to_date', month: mtd.month, throughDay: mtd.throughDay, value: mtd.value, median, ratioToMedian: ratio, class: cls, baseline, text };
  }
  // No near-real-time totals for this month (the D1 tier is empty or not ingesting): say where the month sits in the
  // region's own seasonal cycle instead. Still region-level, still from the archive.
  if (!clim) return { available: false, reason: 'no baseline for that month' };
  const ranked = [...cal.climatology].sort((a, b) => b.median - a.median);
  const rank = ranked.findIndex((c) => c.month === m) + 1;
  const busiest = ranked[0]!;
  const where = rank === 1 ? `the busiest month of the year (${baseline} median ${Math.round(clim.median)} active cell-days)` : `the ${rank}${ordinal(rank)} most active month of the year (${baseline} median ${Math.round(clim.median)} active cell-days; the busiest, ${MONTHS[busiest.month - 1]}, has ${Math.round(busiest.median)})`;
  const text = `In the ${label}, ${MONTHS[m - 1]} is typically ${where}`;
  return { available: true, region: regionRef(region), basis: 'climatology', month: `${y}-${String(m).padStart(2, '0')}`, throughDay: null, value: 0, median: clim.median, ratioToMedian: null, class: null, baseline, text };
}

function ordinal(n: number): string {
  const v = n % 100;
  return v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
}
