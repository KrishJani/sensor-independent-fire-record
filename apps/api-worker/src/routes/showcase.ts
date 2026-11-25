// GET /api/archival/spots from the showcase files (R2) while cell_days/detections are not loaded.
// Same response shape as routes/spots.ts. Only California Aug-Sep 2020 (harmonized) and Quebec 1-10 June 2023 (raw VIIRS).
import { ApiError, parseBbox, parseDate } from '../lib/http.ts';
import { detailLoaded } from '../lib/detail.ts';
import type { Ctx } from '../lib/db.ts';
import { overlapsPeriod, SHOWCASE_PERIODS, type ShowcasePeriod } from '../data/showcase.ts';
import { spots, square } from './spots.ts';

const SAT = ['TERRA', 'AQUA', 'SNPP', 'NOAA20', 'NOAA21'];
const sensorOfSat = (i: number) => (i <= 1 ? 'MODIS' : 'VIIRS');
const LIMITS = { coarse: 64800, cells: 2500, points: 2500 } as const;
const COARSE_CAP = 25000, CELL_CAP = 20000, POINT_CAP = 5000;
const round = (x: number, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

type Cols<K extends string> = { [P in K]: number[] };
export interface PeriodData extends ShowcasePeriod {
  dates: string[];
  cells: Cols<'d' | 'c' | 's' | 'p' | 'n' | 'w'>;
  points: Cols<'lat' | 'lon' | 'd' | 't' | 'f' | 's' | 'q' | 'n'>;
}

const memo = new Map<string, Promise<PeriodData>>();
export async function loadShowcase(env: Env, id: string): Promise<PeriodData> {
  let p = memo.get(id);
  if (!p) {
    p = (async () => {
      const bucket = (env as Env & { SHOWCASE?: R2Bucket }).SHOWCASE;
      const obj = await bucket?.get(`${id}.json.gz`);
      if (!obj) throw new ApiError(503, 'showcase_unavailable', 'The showcase data file is not available.');
      const text = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text();
      return JSON.parse(text) as PeriodData;
    })();
    p.catch(() => memo.delete(id));
    memo.set(id, p);
  }
  return p;
}

type Sensor = 'ALL' | 'VIIRS' | 'MODIS';

/** Pure: builds the response from a loaded period (unit-tested). */
export function buildShowcaseResponse(
  P: PeriodData,
  o: { level: keyof typeof LIMITS; heat: string; sensor: Sensor; measure: string; bbox: [number, number, number, number]; from: string; to: string }
) {
  const from = o.from < P.from ? P.from : o.from, to = o.to > P.to ? P.to : o.to;
  const harmonized = o.measure === 'harmonized' && o.heat === 'fire' && o.level !== 'points' && P.harmonized;
  const d0 = P.dates.findIndex((d) => d >= from);
  let d1 = -1;
  P.dates.forEach((d, i) => { if (d <= to) d1 = i; });
  const r0 = Math.floor((o.bbox[1] + 90) * 20), r1 = Math.ceil((o.bbox[3] + 90) * 20) - 1, c0 = Math.floor((o.bbox[0] + 180) * 20), c1 = Math.ceil((o.bbox[2] + 180) * 20) - 1;
  const wantSensor = (s: number) => o.sensor === 'ALL' || sensorOfSat(s) === o.sensor;
  let features: unknown[] = [];
  let truncated = false;

  if (o.heat === 'industrial') {
    features = []; // the showcase files hold fire-class detections only
  } else if (d0 >= 0 && d1 >= d0 && o.level === 'points') {
    const q = P.points, idx: number[] = [];
    for (let i = 0; i < q.lat.length; i++) {
      if (q.d[i] < d0 || q.d[i] > d1 || !wantSensor(q.s[i])) continue;
      if (q.lat[i] < o.bbox[1] || q.lat[i] > o.bbox[3] || q.lon[i] < o.bbox[0] || q.lon[i] > o.bbox[2]) continue;
      idx.push(i);
    }
    idx.sort((a, b) => q.f[b] - q.f[a]);
    truncated = idx.length > POINT_CAP;
    features = idx.slice(0, POINT_CAP).map((i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon[i], q.lat[i]] },
      properties: { satellite: SAT[q.s[i]], sensor: sensorOfSat(q.s[i]), acq_date: P.dates[q.d[i]], acq_time: q.t[i], frp_mw: q.f[i], confidence: q.q[i], day_night: q.n[i] ? 'D' : 'N' } }));
  } else if (d0 >= 0 && d1 >= d0) {
    const c = P.cells;
    // aggregate key: cell (level cells) or 0.5° bin (coarse)
    const acc = new Map<number, { v: number; days: Set<number>; pk: number; last: number }>();
    // coarse raw "all": the period's native sensor (VIIRS for both showcase periods), like the API's native-sensor rule
    const native = (s: number) => (o.sensor === 'ALL' ? sensorOfSat(s) === 'VIIRS' : wantSensor(s));
    for (let i = 0; i < c.c.length; i++) {
      if (c.d[i] < d0 || c.d[i] > d1) continue;
      const row = Math.floor(c.c[i] / 7200), col = c.c[i] % 7200;
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      if (harmonized) { if (!(c.w[i] > 0)) continue; }
      else if (!(o.level === 'cells' ? wantSensor(c.s[i]) : native(c.s[i]))) continue;
      const key = o.level === 'coarse' ? Math.floor(row / 10) * 100000 + Math.floor(col / 10) : c.c[i];
      const a = acc.get(key) ?? acc.set(key, { v: 0, days: new Set(), pk: 0, last: -1 }).get(key)!;
      if (harmonized) a.v += c.w[i];
      a.days.add(o.level === 'coarse' ? c.d[i] * 30_000_000 + c.c[i] : c.d[i]);
      a.pk = Math.max(a.pk, c.p[i]);
      a.last = Math.max(a.last, c.d[i]);
    }
    const rows = [...acc.entries()].map(([key, a]) => ({ key, v: harmonized ? a.v : a.days.size, days: a.days.size, pk: a.pk, last: P.dates[a.last] }));
    rows.sort((a, b) => b.v - a.v);
    if (o.level === 'cells') {
      truncated = rows.length > CELL_CAP;
      features = rows.slice(0, CELL_CAP).map((r) => ({ type: 'Feature', geometry: square(-90 + Math.floor(r.key / 7200) * 0.05, -180 + (r.key % 7200) * 0.05, 0.05),
        properties: harmonized ? { cell_id: r.key, harmonized_cell_days: round(r.v), active_days: r.days, last_seen: r.last } : { cell_id: r.key, cell_days: r.days, peak_frp_mw: r.pk, last_seen: r.last } }));
    } else {
      truncated = rows.length > COARSE_CAP;
      features = rows.slice(0, COARSE_CAP).map((r) => ({ type: 'Feature', geometry: square(-90 + Math.floor(r.key / 100000) * 0.5, -180 + (r.key % 100000) * 0.5, 0.5),
        properties: { [harmonized ? 'harmonized_cell_days' : 'cell_days']: round(r.v), ...(harmonized ? {} : { peak_frp_mw: r.pk }), source: 'showcase', harmonized } }));
    }
  }
  return {
    type: 'FeatureCollection', features,
    meta: { level: o.level, heat: o.heat, sensor: o.sensor.toLowerCase(), measure: harmonized ? 'harmonized' : 'raw', bbox: o.bbox, from, to, truncated, globalFallback: false, harmonized,
      showcase: { id: P.id, label: P.label, from: P.from, to: P.to, note: P.note },
      note: P.note }
  };
}

/** The Archival map's data: the detailed archive when it is loaded, else a showcase period, else detail_not_loaded. */
export async function archivalSpots(env: Env, ctx: Ctx, q: URLSearchParams) {
  if (!(await detailLoaded(env, ctx))) {
    const level = (q.get('level') ?? 'coarse') as keyof typeof LIMITS;
    if (level in LIMITS) {
      const bbox = parseBbox(q.get('bbox'), LIMITS[level]);
      const from = parseDate(q.get('from'), '2000-11-01', 'from');
      const to = parseDate(q.get('to'), new Date().toISOString().slice(0, 10), 'to');
      const period = SHOWCASE_PERIODS.find((p) => overlapsPeriod(p, from, to, bbox));
      if (period) {
        const sensor = (q.get('sensor') ?? 'all').toUpperCase() as Sensor;
        const P = await loadShowcase(env, period.id);
        return buildShowcaseResponse(P, { level, heat: q.get('heat') ?? 'fire', sensor: ['ALL', 'VIIRS', 'MODIS'].includes(sensor) ? sensor : 'ALL', measure: q.get('measure') ?? 'harmonized', bbox, from, to });
      }
    }
  }
  return spots(env, ctx, q);
}
