// GET /api/realtime/spots?bbox=&from=&to=&level=coarse|cells|points&heat=fire|industrial&measure=harmonized|raw&sensor=
// Realtime tier = D1, dates clamped to [today − 92, today]. Same response shape as /api/archival/spots so the
// web map draws both tiers with the same layers.
//
// measure=harmonized (default, sensor-independent): each day counts the active cells of that day's VIIRS
//   reference satellite — S-NPP if it delivered data, else NOAA-20, else NOAA-21 (harmonizer SPEC §7.1, the
//   archive's own rule). One active cell-day = 1, so values are VIIRS-equivalent cell-days like the archive.
//   An S-NPP outage just moves the reference; days with no VIIRS at all are skipped and reported in meta.
// measure=raw: the satellites' own activity (sensor=all|viirs|modis), distinct cell-days per area.
//  coarse 0.5° bins (whole globe allowed, ≤ 25k strongest) · cells 0.05° (≤ 20k) · points detections (≤ 5k by FRP).
import { ApiError, clampRange, parseBbox, parseDate } from '../lib/http.ts';
import { square } from './spots.ts';

const LIMITS = { coarse: 64800, cells: 2500, points: 2500 } as const;
const CAP = { coarse: 25000, cells: 20000, points: 5000 } as const;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

// Per-day VIIRS reference from nrt_availability (S-NPP → NOAA-20 → NOAA-21).
const REF_CTE = `ref AS (
  SELECT acq_date, CASE WHEN max(satellite = 'SNPP') THEN 'SNPP' WHEN max(satellite = 'NOAA20') THEN 'NOAA20' WHEN max(satellite = 'NOAA21') THEN 'NOAA21' END AS sat
  FROM nrt_availability WHERE acq_date BETWEEN ?1 AND ?2 GROUP BY acq_date)`;

export async function realtimeSpots(env: Env, q: URLSearchParams) {
  const level = (q.get('level') ?? 'coarse') as keyof typeof LIMITS;
  if (!(level in LIMITS)) throw new ApiError(400, 'level_invalid', 'level must be coarse, cells or points');
  const heat = q.get('heat') ?? 'fire';
  if (heat !== 'fire' && heat !== 'industrial') throw new ApiError(400, 'heat_invalid', 'heat must be fire or industrial');
  const measure = q.get('measure') ?? 'harmonized';
  if (measure !== 'harmonized' && measure !== 'raw') throw new ApiError(400, 'measure_invalid', 'measure must be harmonized or raw');
  const sensor = (q.get('sensor') ?? 'all').toUpperCase();
  if (!['ALL', 'VIIRS', 'MODIS'].includes(sensor)) throw new ApiError(400, 'sensor_invalid', 'sensor must be all, viirs or modis');
  const bbox = parseBbox(q.get('bbox'), LIMITS[level]);
  const today = new Date().toISOString().slice(0, 10);
  const min = addDays(today, -Number(env.D1_RETENTION_DAYS ?? 92));
  const { from, to } = clampRange(parseDate(q.get('from'), addDays(today, -1), 'from'), parseDate(q.get('to'), today, 'to'), min, today);
  const harmonized = measure === 'harmonized' && heat === 'fire' && level !== 'points';
  const [w, s, e, n] = bbox;
  const db = env.NRT_DB;
  const sensorSql = sensor === 'ALL' ? '' : `AND sensor = '${sensor}'`; // validated above
  let features: unknown[] = [];
  let truncated = false;

  if (level === 'points') {
    const rows = (await db.prepare(
      `SELECT lat, lon, satellite, sensor, acq_date, acq_time, frp_mw, confidence, day_night, heat_reason FROM nrt_detections
       WHERE acq_date BETWEEN ?1 AND ?2 AND lat BETWEEN ?3 AND ?4 AND lon BETWEEN ?5 AND ?6 AND heat_class = ?7 ${sensorSql}
       ORDER BY frp_mw DESC LIMIT ?8`,
    ).bind(from, to, s, n, w, e, heat, CAP.points + 1).all<any>()).results;
    truncated = rows.length > CAP.points;
    features = rows.slice(0, CAP.points).map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { satellite: r.satellite, sensor: r.sensor, acq_date: r.acq_date, acq_time: r.acq_time, frp_mw: r.frp_mw, confidence: r.confidence, day_night: r.day_night, ...(heat === 'industrial' ? { heat_reason: r.heat_reason } : {}) } }));
  } else {
    const coarse = level === 'coarse';
    const groupBy = coarse ? '(cell_id / 7200) / 10, (cell_id % 7200) / 10' : 'cell_id';
    const sel = coarse ? '(cell_id / 7200) / 10 AS br, (cell_id % 7200) / 10 AS bc' : 'cell_id';
    let sql: string;
    if (heat === 'industrial') {
      sql = `SELECT ${sel}, count(DISTINCT acq_date) AS v, max(acq_date) AS last, max(frp_mw) AS pk, min(heat_reason) AS reason FROM nrt_detections
             WHERE acq_date BETWEEN ?1 AND ?2 AND lat BETWEEN ?3 AND ?4 AND lon BETWEEN ?5 AND ?6 AND heat_class = 'industrial' ${sensorSql}
             GROUP BY ${groupBy} ORDER BY v DESC LIMIT ?7`;
    } else if (harmonized) {
      sql = `WITH ${REF_CTE}
             SELECT ${sel}, count(*) AS v, max(c.acq_date) AS last, max(peak_frp_mw) AS pk, NULL AS reason FROM nrt_cell_days c JOIN ref ON ref.acq_date = c.acq_date AND ref.sat = c.satellite
             WHERE c.acq_date BETWEEN ?1 AND ?2 AND grid_lat BETWEEN ?3 AND ?4 AND grid_lon BETWEEN ?5 AND ?6
             GROUP BY ${groupBy} ORDER BY v DESC LIMIT ?7`;
    } else {
      // raw: distinct (cell, day) active in the chosen sensor family; 'all' = any satellite
      sql = `SELECT ${sel}, count(DISTINCT acq_date || '|' || cell_id) AS v, max(acq_date) AS last, max(peak_frp_mw) AS pk, NULL AS reason FROM nrt_cell_days
             WHERE acq_date BETWEEN ?1 AND ?2 AND grid_lat BETWEEN ?3 AND ?4 AND grid_lon BETWEEN ?5 AND ?6 ${sensorSql}
             GROUP BY ${groupBy} ORDER BY v DESC LIMIT ?7`;
    }
    const cap = coarse ? CAP.coarse : CAP.cells;
    const rows = (await db.prepare(sql).bind(from, to, s, n, w, e, cap + 1).all<any>()).results;
    truncated = rows.length > cap;
    const valueKey = harmonized ? 'harmonized_cell_days' : 'cell_days';
    features = rows.slice(0, cap).map((r) => {
      const geometry = coarse ? square(-90 + r.br * 0.5, -180 + r.bc * 0.5, 0.5) : square(-90 + Math.floor(r.cell_id / 7200) * 0.05, -180 + (r.cell_id % 7200) * 0.05, 0.05);
      return { type: 'Feature', geometry, properties: { ...(coarse ? {} : { cell_id: r.cell_id, active_days: r.v }), [valueKey]: r.v, last_seen: r.last, peak_frp_mw: r.pk, source: 'realtime', harmonized, ...(r.reason ? { heat_reason: r.reason } : {}) } };
    });
  }

  // Which satellite was the reference each day (and days with no VIIRS) — shown in the UI as provenance.
  const refs = (await db.prepare(`WITH ${REF_CTE} SELECT acq_date, sat FROM ref ORDER BY acq_date`).bind(from, to).all<{ acq_date: string; sat: string | null }>()).results;
  return {
    type: 'FeatureCollection',
    features,
    meta: { tier: 'realtime', level, heat, sensor: sensor.toLowerCase(), measure: harmonized ? 'harmonized' : 'raw', bbox, from, to, truncated, harmonized,
      reference: Object.fromEntries(refs.map((r) => [r.acq_date, r.sat])), noViirsDays: refs.filter((r) => !r.sat).map((r) => r.acq_date) },
  };
}
