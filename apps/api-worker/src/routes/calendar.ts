// POST /api/calendar (archival) and GET /api/export/calendar.csv.
//
// scope ('us' | a region id) → the precomputed calendar (same numbers as the backfill).
// bbox / geometry (any AOI)  → rebuilt from cell_days with EACH REGION'S OWN daily rule, then summed:
//   VIIRS day     → cells of that region's VIIRS reference that day
//   MODIS_SCALED  → α_eff(region, day) × cells of that day's MODIS configuration (TA = Terra ∪ Aqua)
// Bands: each region's held-out factors on its MODIS-scaled part. Anomalies: @repo/harmonizer.

import { computeAnomalies, daysInMonth, pointInPolygon, cellCenter, type CalendarCell, type Bbox } from '@repo/harmonizer';
import { db, type Sql, type Ctx } from '../lib/db.ts';
import { ApiError, clampRange, parseDate, polygonBbox } from '../lib/http.ts';
import { CONFIG, REGIONS } from './meta.ts';
import { coverage, MIN_COVERAGE } from '../lib/coverage.ts';
import { requireDetail } from '../lib/detail.ts';

export interface CalendarRequest {
  scope?: string;
  bbox?: [number, number, number, number] | null;
  geometry?: unknown;
  from?: string;
  to?: string;
  months?: number[] | null;
}

const MAX_BBOX_DEG2 = 400; // aggregate SQL; a few US states
const MAX_POLYGON_DEG2 = 25; // polygon → explicit cell list
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Cell = CalendarCell & { lo: number; hi: number };

function overlaps(a: Bbox, b: number[]) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export async function calendar(env: Env, ctx: Ctx, req: CalendarRequest) {
  const sql = db(env, ctx);
  const regionsDb = (await sql`select region_id, range_from::text as f, range_to::text as t, validation from regions`) as unknown as { region_id: string; f: string; t: string; validation: any }[];
  const loaded = new Map(regionsDb.map((r) => [r.region_id, r]));
  const baseline = CONFIG.baselineYears as [number, number];

  // ---------- precomputed scope ----------
  if (req.scope) {
    const isGroup = REGIONS.some((r) => r.group === req.scope);
    const members = isGroup ? REGIONS.filter((r) => r.group === req.scope).map((r) => r.id) : [req.scope];
    if (!members.every((m) => loaded.has(m))) throw new ApiError(404, 'scope_unknown', `unknown or unloaded scope "${req.scope}"`);
    const max = members.map((m) => loaded.get(m)!.t).sort()[0];
    const { from, to } = clampRange(parseDate(req.from, '2000-11-01', 'from'), parseDate(req.to, max, 'to'), '2000-11-01', max);
    const rows = (await sql`select * from calendar_monthly where scope = ${req.scope} order by year, month`) as any[];
    const cells: Cell[] = rows.map((r) => ({
      year: r.year, month: r.month, harmonizedCellDays: r.harmonized_cell_days, rawDetections: r.raw_detections, unscaledCellDays: r.unscaled_cell_days,
      modisScaledCellDays: r.modis_scaled_cell_days ?? 0, nModisDays: 0, scaledCellDays: 0, harmonizedLo: r.harmonized_lo, harmonizedHi: r.harmonized_hi,
      modisCellDays: r.modis_cell_days, viirsCellDays: r.viirs_cell_days, sourceMix: r.source_mix, nDays: r.n_days, nViirsDays: 0, nModisScaledDays: 0, nNoneDays: 0,
      peakFrpMw: r.peak_frp_mw, peakFrpSensor: r.peak_frp_sensor, complete: r.complete, lo: r.harmonized_lo ?? r.harmonized_cell_days, hi: r.harmonized_hi ?? r.harmonized_cell_days,
    }));
    const annual = (await sql`select year, harmonized_cell_days as h, harmonized_lo as lo, harmonized_hi as hi from annual_harmonized where scope = ${req.scope} order by year`) as any[];
    return calendarBody(cells, annual.map((a) => ({ year: a.year, harmonizedCellDays: a.h, lo: a.lo, hi: a.hi })), { from, to, months: req.months ?? null, baseline, aoi: { scope: req.scope, regions: members }, alpha: alphaSummary(members, regionsDb), coverage: 1 });
  }

  // ---------- AOI ----------
  let bbox: Bbox;
  let cells: number[] | null = null;
  if (req.geometry) {
    const { geom, bbox: b } = polygonBbox(req.geometry);
    bbox = b;
    if ((b[2] - b[0]) * (b[3] - b[1]) > MAX_POLYGON_DEG2) throw new ApiError(413, 'aoi_too_large', `polygon bbox exceeds ${MAX_POLYGON_DEG2} deg²; draw a smaller area or use a region scope`);
    cells = [];
    for (let row = Math.floor((b[1] + 90) * 20); row < Math.ceil((b[3] + 90) * 20); row++)
      for (let col = Math.floor((b[0] + 180) * 20); col < Math.ceil((b[2] + 180) * 20); col++) {
        const id = row * 7200 + col;
        const c = cellCenter(id);
        if (pointInPolygon(c.lon, c.lat, geom)) cells.push(id);
      }
    if (!cells.length) throw new ApiError(422, 'aoi_empty', 'the polygon contains no 0.05° grid cell centers');
  } else if (req.bbox) {
    const [w, s, e, n] = req.bbox;
    bbox = [w, s, e, n];
    if (!(w < e && s < n)) throw new ApiError(400, 'bbox_invalid', 'bbox must be [west, south, east, north]');
    if ((e - w) * (n - s) > MAX_BBOX_DEG2) throw new ApiError(413, 'aoi_too_large', `bbox exceeds ${MAX_BBOX_DEG2} deg²; use a region scope (e.g. "us")`);
  } else throw new ApiError(400, 'aoi_required', 'give scope, bbox or geometry');

  // Coverage: share of the AOI's cells inside a harmonized region on US territory (lib/coverage.ts). Mostly
  // outside → 422 instead of a calendar built from a few grazing US cells (or zeros for Canada/Mexico).
  const cov = round(coverage(bbox, cells), 3);
  const OUTSIDE = 'outside harmonized coverage (US regions only); the map shows raw detections here';
  if (cov < MIN_COVERAGE) throw new ApiError(422, 'outside_regions', OUTSIDE, { coverage: cov });
  const regs = REGIONS.filter((r) => loaded.has(r.id) && overlaps(bbox, r.bbox)).map((r) => r.id);
  if (!regs.length) throw new ApiError(422, 'outside_regions', OUTSIDE, { coverage: 0 });
  await requireDetail(env, ctx);
  const max = regs.map((m) => loaded.get(m)!.t).sort()[0];
  const { from, to } = clampRange(parseDate(req.from, '2000-11-01', 'from'), parseDate(req.to, max, 'to'), '2000-11-01', max);
  const r0 = Math.floor((bbox[1] + 90) * 20), r1 = Math.ceil((bbox[3] + 90) * 20) - 1, c0 = Math.floor((bbox[0] + 180) * 20), c1 = Math.ceil((bbox[2] + 180) * 20) - 1;

  const agg = (await aoiDays(sql, regs, r0, r1, c0, c1, from, to, cells)) as any[];
  const rules = (await sql`select scope, acq_date::text as d, basis, alpha, modis_config as cfg, viirs_reference as ref from daily_harmonized
    where scope in ${sql(regs)} and acq_date between ${from} and ${to}`) as any[];
  const aggKey = new Map(agg.map((a) => [`${a.region_id}|${a.d}`, a]));
  const bandOf = new Map(regs.map((r) => [r, loaded.get(r)!.validation?.configs?.TA?.uncertainty ?? null]));

  // Per month accumulation (per region for the scaled part → bands).
  type M = { h: number; raw: number; un: number; ms: number; v: number; m: number; days: Set<string>; allV: Set<string>; none: boolean; scaled: Map<string, number>; pk: number; pkS: string | null };
  const mon = new Map<string, M>();
  const annualScaled = new Map<string, Map<string, number>>(); // year → region → scaled
  for (const r of rules) {
    const a = aggKey.get(`${r.scope}|${r.d}`);
    const key = r.d.slice(0, 7);
    const e = mon.get(key) ?? mon.set(key, { h: 0, raw: 0, un: 0, ms: 0, v: 0, m: 0, days: new Set(), allV: new Set(), none: false, scaled: new Map(), pk: 0, pkS: null }).get(key)!;
    e.days.add(r.d);
    const M = !a ? 0 : r.cfg === 'TA' ? a.m_ta : r.cfg === 'T' ? a.m_t : r.cfg === 'A' ? a.m_a : 0;
    const Mdet = !a ? 0 : r.cfg === 'TA' ? a.d_terra + a.d_aqua : r.cfg === 'T' ? a.d_terra : r.cfg === 'A' ? a.d_aqua : 0;
    if (r.basis === 'VIIRS') {
      const ref = String(r.ref).toLowerCase();
      const V = a ? a[`v_${ref}`] ?? 0 : 0;
      e.h += V; e.un += V; e.v += V; e.raw += a ? a[`d_${ref}`] ?? 0 : 0;
      if (a && a.pk_v > e.pk) { e.pk = a.pk_v; e.pkS = 'VIIRS'; }
    } else if (r.basis === 'MODIS_SCALED') {
      const val = (r.alpha ?? 0) * M;
      e.h += val; e.un += M; e.raw += Mdet;
      e.scaled.set(r.scope, (e.scaled.get(r.scope) ?? 0) + val);
      const ys = r.d.slice(0, 4);
      const ym = annualScaled.get(ys) ?? annualScaled.set(ys, new Map()).get(ys)!;
      ym.set(r.scope, (ym.get(r.scope) ?? 0) + val);
      if (a && a.pk_m > e.pk) { e.pk = a.pk_m; e.pkS = 'MODIS'; }
    } else e.none = true;
    e.m += M;
    if (r.alpha != null) e.ms += r.alpha * M;
  }
  // a day counts as "VIIRS" for source_mix only if every involved region used VIIRS that day
  const vDays = new Map<string, number>();
  for (const r of rules) if (r.basis === 'VIIRS') vDays.set(r.d, (vDays.get(r.d) ?? 0) + 1);
  for (const [d, n] of vDays) if (n === regs.length) mon.get(d.slice(0, 7))?.allV.add(d);

  const out: Cell[] = [...mon.entries()].sort().map(([k, e]) => {
    const year = +k.slice(0, 4), month = +k.slice(5, 7);
    let lo = e.h, hi = e.h;
    for (const [reg, s] of e.scaled) { const b = bandOf.get(reg)?.monthly; if (b) { lo -= s * (1 - b[0]); hi += s * (b[1] - 1); } }
    return {
      year, month, harmonizedCellDays: e.h, rawDetections: e.raw, unscaledCellDays: e.un, modisScaledCellDays: e.ms, nModisDays: 0, scaledCellDays: [...e.scaled.values()].reduce((a, b) => a + b, 0),
      harmonizedLo: lo, harmonizedHi: hi, modisCellDays: e.m, viirsCellDays: e.v, sourceMix: e.allV.size / e.days.size, nDays: e.days.size, nViirsDays: e.allV.size, nModisScaledDays: 0, nNoneDays: 0,
      peakFrpMw: e.pk || null, peakFrpSensor: e.pkS as any, complete: e.days.size === daysInMonth(year, month) && !e.none, lo, hi,
    };
  });
  const annualMap = new Map<number, { h: number; lo: number; hi: number }>();
  for (const c of out) { const a = annualMap.get(c.year) ?? annualMap.set(c.year, { h: 0, lo: 0, hi: 0 }).get(c.year)!; a.h += c.harmonizedCellDays; }
  for (const [y, a] of annualMap) {
    a.lo = a.h; a.hi = a.h;
    for (const [reg, s] of annualScaled.get(String(y)) ?? []) { const b = bandOf.get(reg)?.annual; if (b) { a.lo -= s * (1 - b[0]); a.hi += s * (b[1] - 1); } }
  }
  const annual = [...annualMap.entries()].sort((a, b) => a[0] - b[0]).map(([year, a]) => ({ year, harmonizedCellDays: a.h, lo: a.lo, hi: a.hi }));
  return calendarBody(out, annual, { from, to, months: req.months ?? null, baseline, aoi: { bbox, cells: cells?.length ?? null, regions: regs }, alpha: alphaSummary(regs, regionsDb), coverage: cov });
}

async function aoiDays(sql: Sql, regs: string[], r0: number, r1: number, c0: number, c1: number, from: string, to: string, cells: number[] | null) {
  // Sent as a Postgres array literal: with fetch_types off, postgres.js would serialize a JS array as "1,2,3".
  const cellFilter = cells ? sql`and cell_id = any(${`{${cells.join(',')}}`}::int[])` : sql``;
  return sql`
    select region_id, acq_date::text as d,
      count(distinct cell_id) filter (where satellite in ('TERRA', 'AQUA'))::int as m_ta,
      count(*) filter (where satellite = 'TERRA')::int as m_t,
      count(*) filter (where satellite = 'AQUA')::int as m_a,
      count(*) filter (where satellite = 'SNPP')::int as v_snpp,
      count(*) filter (where satellite = 'NOAA20')::int as v_noaa20,
      count(*) filter (where satellite = 'NOAA21')::int as v_noaa21,
      coalesce(sum(n_detections) filter (where satellite = 'TERRA'), 0)::int as d_terra,
      coalesce(sum(n_detections) filter (where satellite = 'AQUA'), 0)::int as d_aqua,
      coalesce(sum(n_detections) filter (where satellite = 'SNPP'), 0)::int as d_snpp,
      coalesce(sum(n_detections) filter (where satellite = 'NOAA20'), 0)::int as d_noaa20,
      coalesce(sum(n_detections) filter (where satellite = 'NOAA21'), 0)::int as d_noaa21,
      coalesce(max(peak_frp_mw) filter (where sensor = 'MODIS'), 0) as pk_m,
      coalesce(max(peak_frp_mw) filter (where sensor = 'VIIRS'), 0) as pk_v
    from cell_days
    where region_id in ${sql(regs)} and grid_row between ${r0} and ${r1} and grid_col between ${c0} and ${c1}
      and acq_date between ${from} and ${to} ${cellFilter}
    group by region_id, acq_date`;
}

function alphaSummary(regs: string[], regionsDb: { region_id: string; validation: any }[]) {
  return regs.map((r) => {
    const v = regionsDb.find((x) => x.region_id === r)?.validation;
    const ta = v?.configs?.TA;
    return { region: r, model: ta?.model?.kind ?? null, beta: ta?.model?.beta ?? null, loyoError: ta?.loyo?.mdape ?? null, confidence: v?.confidence?.level ?? null, acceptance: v?.acceptance ?? null };
  });
}

/**
 * The calendar response body (exported for tests). "Normal" for a calendar month is ONE value: the median of that
 * month's harmonized cell-days over every complete baseline year (climatology[m].median, the 2001-2025 median).
 * anomaly.median is that normal and anomaly.ratioToMedian = value / normal, so the drawer, the Explorer's notable
 * events, the briefs and the copilot all quote the same number. class, percentile and robustZ still rank the month
 * against the OTHER baseline years (leave-one-out), which is what lets a month be a record.
 */
export function calendarBody(cells: Cell[], annual: { year: number; harmonizedCellDays: number; lo: number | null; hi: number | null }[], o: { from: string; to: string; months: number[] | null; baseline: [number, number]; aoi: unknown; alpha: unknown; coverage: number }) {
  const { cells: scored, climatology } = computeAnomalies(cells, { baselineYears: o.baseline });
  const normalOf = new Map(climatology.map((c) => [c.month, c.median]));
  const inRange = (c: { year: number; month: number }) => {
    const k = `${c.year}-${String(c.month).padStart(2, '0')}`;
    return k >= o.from.slice(0, 7) && k <= o.to.slice(0, 7) && (!o.months || o.months.includes(c.month));
  };
  const cal = scored.filter(inRange).map((c) => ({
    year: c.year, month: c.month,
    harmonizedCellDays: round(c.harmonizedCellDays), lo: round(c.harmonizedLo ?? c.harmonizedCellDays), hi: round(c.harmonizedHi ?? c.harmonizedCellDays),
    rawDetections: c.rawDetections, unscaledCellDays: c.unscaledCellDays, modisCellDays: c.modisCellDays, viirsCellDays: c.viirsCellDays,
    sourceMix: round(c.sourceMix, 3), peakFrpMw: c.peakFrpMw === null ? null : round(c.peakFrpMw, 1), peakFrpSensor: c.peakFrpSensor, complete: c.complete,
    anomaly: c.anomaly ? { median: round(normalOf.get(c.month) ?? c.anomaly.median), ratioToMedian: (normalOf.get(c.month) ?? 0) > 0 ? round(c.harmonizedCellDays / normalOf.get(c.month)!, 2) : null, robustZ: c.anomaly.robustZ === null ? null : round(c.anomaly.robustZ, 2), percentile: round(c.anomaly.percentile, 1), class: c.anomaly.class } : null,
  }));
  const complete = cal.filter((c) => c.complete);
  const peak = complete.reduce<(typeof cal)[number] | null>((a, c) => (!a || c.harmonizedCellDays > a.harmonizedCellDays ? c : a), null);
  const yearTot = annual.filter((a) => a.year >= +o.from.slice(0, 4) && a.year <= +o.to.slice(0, 4));
  const peakYear = yearTot.reduce<(typeof annual)[number] | null>((a, c) => (!a || c.harmonizedCellDays > a.harmonizedCellDays ? c : a), null);
  const medians = climatology.map((c) => c.median).sort((a, b) => a - b);
  const p75 = medians.length ? medians[Math.floor(0.75 * (medians.length - 1))] : Infinity;
  return {
    mode: 'archival',
    aoi: o.aoi,
    // Share (0..1) of the AOI's cells inside harmonized coverage (US regions). < 0.5 never gets here (422).
    meta: { coverage: o.coverage },
    range: { from: o.from, to: o.to },
    units: 'VIIRS-equivalent active 0.05° cell-days (MODIS-only days scaled with α_eff); lo/hi = 90% band',
    calendar: cal,
    annual: yearTot.map((a) => ({ year: a.year, harmonizedCellDays: round(a.harmonizedCellDays), lo: a.lo === null ? null : round(a.lo), hi: a.hi === null ? null : round(a.hi) })),
    climatology: climatology.map((c) => ({ month: c.month, median: round(c.median), p10: round(c.p10), p25: round(c.p25), p75: round(c.p75), p90: round(c.p90), n: c.n })),
    alpha: o.alpha,
    summary: {
      peakMonth: peak ? `${peak.year}-${String(peak.month).padStart(2, '0')}` : null,
      peakYear: peakYear?.year ?? null,
      criticalMonths: climatology.filter((c) => c.median > p75).map((c) => c.month),
      criticalMonthNames: climatology.filter((c) => c.median > p75).map((c) => MONTH[c.month - 1]),
    },
  };
}
const round = (x: number, dp = 1) => Math.round(x * 10 ** dp) / 10 ** dp;

export function calendarCsv(body: ReturnType<typeof calendarBody>): string {
  const head = 'year,month,harmonized_cell_days,harmonized_lo,harmonized_hi,raw_detections,unscaled_cell_days,modis_cell_days,viirs_cell_days,source_mix,complete,median,ratio_to_median,robust_z,percentile,class';
  const rows = body.calendar.map((c) => [c.year, c.month, c.harmonizedCellDays, c.lo, c.hi, c.rawDetections, c.unscaledCellDays, c.modisCellDays, c.viirsCellDays, c.sourceMix, c.complete ? 1 : 0, c.anomaly?.median ?? '', c.anomaly?.ratioToMedian ?? '', c.anomaly?.robustZ ?? '', c.anomaly?.percentile ?? '', c.anomaly?.class ?? ''].join(','));
  return `# Harmonized burning activity calendar (NASA FIRMS MODIS + VIIRS). Units: ${body.units}. Range ${body.range.from} → ${body.range.to}.\n${head}\n${rows.join('\n')}\n`;
}
