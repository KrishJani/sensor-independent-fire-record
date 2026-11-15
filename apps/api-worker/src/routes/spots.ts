// GET /api/archival/spots?bbox=&from=&to=&level=coarse|cells|points&heat=fire|industrial&measure=harmonized|raw
// measure=harmonized (default, sensor-independent): VIIRS-equivalent cell-days with the calendar's per-day rule —
//   a VIIRS day counts the reference satellite's cells (weight 1), a MODIS-only day counts the configuration's
//   distinct cells with weight α_eff. Summed over an area this equals /api/calendar. Inside harmonized regions only.
// measure=raw: native sensor activity (and the only option outside regions / for points).
//  coarse  0.5° bins: harmonized regions from cell_months; elsewhere the global layer (raw, per satellite).
//          Native sensor per month: VIIRS S-NPP from 2012-02, MODIS (Terra + Aqua) before.
//  cells   0.05° cells (regions only): distinct active days, peak FRP, last seen.
//  points  detections, ≤ 5000 by FRP (truncated: true when capped).
import { cellInRegion, type Bbox } from '@repo/harmonizer';
import { db, type Ctx } from '../lib/db.ts';
import { ApiError, parseBbox, parseDate } from '../lib/http.ts';
import { REGIONS } from './meta.ts';

// deg² per level. coarse covers the whole globe (world zoom); every level caps its feature count
// (strongest first, meta.truncated) so the payload stays bounded whatever the area.
const LIMITS = { coarse: 64800, cells: 2500, points: 2500 } as const;
const COARSE_CAP = 25000; // 0.5° bins
const CELL_CAP = 20000;
const POINT_CAP = 5000;

export const square = (lat0: number, lon0: number, d: number) => ({ type: 'Polygon' as const, coordinates: [[[lon0, lat0], [lon0 + d, lat0], [lon0 + d, lat0 + d], [lon0, lat0 + d], [lon0, lat0]]] });
const inAnyRegion = (lat: number, lon: number) => REGIONS.some((r) => {
  const ex = (r.exclude ?? []).map((id) => REGIONS.find((x) => x.id === id)!.bbox) as Bbox[];
  const row = Math.floor((lat + 90) * 20), col = Math.floor((lon + 180) * 20);
  return cellInRegion(row * 7200 + col, r.bbox as Bbox, ex);
});

/** Harmonized cell weights (VIIRS-equivalent cell-days) inside regions, for cells (by cell) or coarse (0.5° bins). */
function harmonizedRows(sql: any, regions: string[], r0: number, r1: number, c0: number, c1: number, from: string, to: string, by: 'cell' | 'bin') {
  const group = by === 'cell' ? sql`cell_id` : sql`(cell_id / 7200) / 10, (cell_id % 7200) / 10`;
  const sel = by === 'cell' ? sql`cell_id, sum(w)::real as hcd, count(*)::int as days, max(acq_date)::text as last` : sql`(cell_id / 7200) / 10 as br, (cell_id % 7200) / 10 as bc, sum(w)::real as hcd`;
  return sql`
    with d as (
      select scope as region_id, acq_date, basis, coalesce(alpha, 0) as alpha, modis_config as cfg, viirs_reference as ref
      from daily_harmonized where scope in ${sql(regions)} and acq_date between ${from} and ${to} and basis <> 'NONE'),
    c as (
      select region_id, acq_date, cell_id, satellite from cell_days
      where region_id in ${sql(regions)} and grid_row between ${r0} and ${r1} and grid_col between ${c0} and ${c1} and acq_date between ${from} and ${to}),
    w as (
      select c.cell_id, c.acq_date, 1.0::real as w from c join d using (region_id, acq_date)
        where d.basis = 'VIIRS' and c.satellite = d.ref
      union all
      select c.cell_id, c.acq_date, max(d.alpha)::real as w from c join d using (region_id, acq_date)
        where d.basis = 'MODIS_SCALED' and ((d.cfg = 'TA' and c.satellite in ('TERRA', 'AQUA')) or (d.cfg = 'T' and c.satellite = 'TERRA') or (d.cfg = 'A' and c.satellite = 'AQUA'))
        group by c.cell_id, c.acq_date)
    select ${sel} from w group by ${group}`;
}

export async function spots(env: Env, ctx: Ctx, q: URLSearchParams) {
  const level = (q.get('level') ?? 'coarse') as keyof typeof LIMITS;
  if (!(level in LIMITS)) throw new ApiError(400, 'level_invalid', 'level must be coarse, cells or points');
  const heat = q.get('heat') ?? 'fire';
  if (heat !== 'fire' && heat !== 'industrial') throw new ApiError(400, 'heat_invalid', 'heat must be fire or industrial');
  const bbox = parseBbox(q.get('bbox'), LIMITS[level]);
  const sensor = (q.get('sensor') ?? 'all').toUpperCase();
  const measure = q.get('measure') ?? 'harmonized';
  if (measure !== 'harmonized' && measure !== 'raw') throw new ApiError(400, 'measure_invalid', 'measure must be harmonized or raw');
  const harmonized = measure === 'harmonized' && heat === 'fire' && level !== 'points';
  if (!['ALL', 'VIIRS', 'MODIS'].includes(sensor)) throw new ApiError(400, 'sensor_invalid', 'sensor must be all, viirs or modis');
  const from = parseDate(q.get('from'), '2000-11-01', 'from');
  const to = parseDate(q.get('to'), new Date().toISOString().slice(0, 10), 'to');
  const sql = db(env, ctx);
  const r0 = Math.floor((bbox[1] + 90) * 20), r1 = Math.ceil((bbox[3] + 90) * 20) - 1, c0 = Math.floor((bbox[0] + 180) * 20), c1 = Math.ceil((bbox[2] + 180) * 20) - 1;
  const ym0 = +from.slice(0, 4) * 100 + +from.slice(5, 7), ym1 = +to.slice(0, 4) * 100 + +to.slice(5, 7);
  let features: unknown[] = [];
  let truncated = false;
  let globalFallback = false;

  if (level === 'points') {
    const rows = (await sql`select lat, lon, satellite, sensor, acq_date::text as d, acq_time as t, frp_mw, confidence, day_night, heat_reason
      from detections where grid_row between ${r0} and ${r1} and grid_col between ${c0} and ${c1}
        and acq_date between ${from} and ${to} and heat_class = ${heat} ${sensor === 'ALL' ? sql`` : sql`and sensor = ${sensor}`}
      order by frp_mw desc limit ${POINT_CAP + 1}`) as any[];
    truncated = rows.length > POINT_CAP;
    features = rows.slice(0, POINT_CAP).map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { satellite: r.satellite, sensor: r.sensor, acq_date: r.d, acq_time: r.t, frp_mw: r.frp_mw, confidence: r.confidence, day_night: r.day_night, ...(heat === 'industrial' ? { heat_reason: r.heat_reason } : {}) } }));
  } else if (level === 'cells' && harmonized) {
    const regs = REGIONS.filter((r) => r.bbox[0] < bbox[2] && r.bbox[2] > bbox[0] && r.bbox[1] < bbox[3] && r.bbox[3] > bbox[1]).map((r) => r.id);
    const rows = regs.length ? ((await harmonizedRows(sql, regs, r0, r1, c0, c1, from, to, 'cell')) as any[]) : [];
    rows.sort((a, b) => b.hcd - a.hcd);
    truncated = rows.length > CELL_CAP;
    features = rows.slice(0, CELL_CAP).map((r) => { const row = Math.floor(r.cell_id / 7200), col = r.cell_id % 7200;
      return { type: 'Feature', geometry: square(-90 + row * 0.05, -180 + col * 0.05, 0.05), properties: { cell_id: r.cell_id, harmonized_cell_days: Math.round(r.hcd * 100) / 100, active_days: r.days, last_seen: r.last } }; });
    globalFallback = !regs.length;
  } else if (level === 'cells') {
    const rows = heat === 'industrial'
      ? ((await sql`select cell_id, count(distinct acq_date)::int as days, max(frp_mw) as pk, max(acq_date)::text as last, mode() within group (order by heat_reason) as reason
          from detections where grid_row between ${r0} and ${r1} and grid_col between ${c0} and ${c1} and acq_date between ${from} and ${to} and heat_class = 'industrial'
          group by cell_id`) as any[])
      : ((await sql`select cell_id, count(distinct acq_date)::int as days, max(peak_frp_mw) as pk, max(acq_date)::text as last, null as reason
          from cell_days where grid_row between ${r0} and ${r1} and grid_col between ${c0} and ${c1} and acq_date between ${from} and ${to}
            ${sensor === 'ALL' ? sql`` : sql`and sensor = ${sensor}`}
          group by cell_id`) as any[]);
    features = rows.map((r) => { const row = Math.floor(r.cell_id / 7200), col = r.cell_id % 7200;
      return { type: 'Feature', geometry: square(-90 + row * 0.05, -180 + col * 0.05, 0.05), properties: { cell_id: r.cell_id, cell_days: r.days, peak_frp_mw: r.pk, last_seen: r.last, ...(r.reason ? { heat_reason: r.reason } : {}) } }; });
    globalFallback = !REGIONS.some((r) => r.bbox[0] < bbox[2] && r.bbox[2] > bbox[0] && r.bbox[1] < bbox[3] && r.bbox[3] > bbox[1]);
  } else {
    if (heat === 'industrial') throw new ApiError(400, 'level_invalid', 'heat=industrial is available at the cells and points levels');
    // coarse: regions from cell_months (native sensor per month), elsewhere the global layer.
    // all = VIIRS S-NPP from 2012-02, MODIS before; viirs / modis = that sensor only.
    const pick = sensor === 'VIIRS' ? sql`sum(cell_days) filter (where satellite = 'SNPP')::int as cd,`
      : sensor === 'MODIS' ? sql`sum(cell_days) filter (where satellite in ('TERRA', 'AQUA'))::int as cd,`
      : sql`sum(cell_days) filter (where (year * 100 + month >= 201202 and satellite = 'SNPP') or (year * 100 + month < 201202 and satellite in ('TERRA', 'AQUA')))::int as cd,`;
    const regIds = REGIONS.filter((r) => r.bbox[0] < bbox[2] && r.bbox[2] > bbox[0] && r.bbox[1] < bbox[3] && r.bbox[3] > bbox[1]).map((r) => r.id);
    const reg = harmonized
      ? (regIds.length ? ((await harmonizedRows(sql, regIds, r0, r1, c0, c1, from, to, 'bin')) as any[]).map((r) => ({ br: r.br, bc: r.bc, cd: r.hcd, pk: null })) : [])
      : ((await sql`select (grid_row / 10) as br, (grid_col / 10) as bc,
        ${pick}
        max(peak_frp_mw) as pk
      from cell_months where grid_row between ${r0} and ${r1} and grid_col between ${c0} and ${c1} and (year * 100 + month) between ${ym0} and ${ym1}
      group by 1, 2`) as any[]);
    const glob = (await sql`select bin_lat, bin_lon,
        ${pick}
        max(peak_frp_mw) as pk
      from global_coarse_months where bin_lat between ${bbox[1]} and ${bbox[3]} and bin_lon between ${bbox[0]} and ${bbox[2]} and (year * 100 + month) between ${ym0} and ${ym1}
      group by 1, 2`) as any[];
    for (const r of reg) if (r.cd > 0) features.push({ type: 'Feature', geometry: square(-90 + r.br * 0.5, -180 + r.bc * 0.5, 0.5), properties: { [harmonized ? 'harmonized_cell_days' : 'cell_days']: Math.round(r.cd * 100) / 100, ...(r.pk != null ? { peak_frp_mw: r.pk } : {}), source: 'region', harmonized } });
    for (const g of glob) {
      if (!(g.cd > 0) || inAnyRegion(g.bin_lat, g.bin_lon)) continue; // regions already counted above
      globalFallback = true;
      features.push({ type: 'Feature', geometry: square(g.bin_lat - 0.25, g.bin_lon - 0.25, 0.5), properties: { [harmonized ? 'harmonized_cell_days' : 'cell_days']: g.cd, peak_frp_mw: g.pk, source: 'global', harmonized: false } });
    }
  }
  if (level === 'coarse' && features.length > COARSE_CAP) {
    const v = (f: any) => f.properties.harmonized_cell_days ?? f.properties.cell_days ?? 0;
    features.sort((a, b) => v(b) - v(a));
    features.length = COARSE_CAP;
    truncated = true;
  }
  return { type: 'FeatureCollection', features, meta: { level, heat, sensor: sensor.toLowerCase(), measure: harmonized ? 'harmonized' : 'raw', bbox, from, to, truncated, globalFallback, harmonized,
    note: harmonized ? 'VIIRS-equivalent cell-days (sensor-independent) inside harmonized regions; outside them the global layer is raw sensor activity' : 'raw sensor activity' } };
}
