// NRT job (SPEC §3.1): FIRMS NRT, whole world → D1, written so that D1 row-writes track real change only.
//
// Per (satellite, acq_date) file:
//   1. Fingerprint the rows; if nrt_files already holds that fingerprint, skip (no writes at all).
//   2. Classify with the archive's rules: confidence (MODIS ≥ 30, VIIRS n/h), then masked cell →
//      heat_class 'industrial' + reason (kept, never counted), else 'fire'.
//   3. Diff against D1 and upsert only new or revised detections (never delete raw rows).
//   4. Recompute that file's cell-days from ALL its D1 detections (buildCellDays, the archive's code) and
//      write only cell-days that changed; delete cell-days that no longer exist (e.g. reclassified).
//   5. Mark availability and the file fingerprint. All of this is one D1 batch (one transaction).
// Rows go in through json_each(?) — one bound parameter per few thousand rows (D1 allows 100 parameters).
import { buildCellDays, HARMONIZER_VERSION, parseFirmsCsv, toCellId, type Detection } from '@repo/harmonizer';
import { FirmsBudgetExhausted, type createFirms } from './firms.ts';
import type { Masks } from './masks.ts';

export const NRT_SOURCES = ['MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'] as const;
const SOURCE_SATS: Record<string, string[]> = { MODIS_NRT: ['TERRA', 'AQUA'], VIIRS_SNPP_NRT: ['SNPP'], VIIRS_NOAA20_NRT: ['NOAA20'], VIIRS_NOAA21_NRT: ['NOAA21'] };
const RESERVE_TX: Record<string, number> = { MODIS_NRT: 20, VIIRS_SNPP_NRT: 60, VIIRS_NOAA20_NRT: 60, VIIRS_NOAA21_NRT: 60 };
const CHUNK = 3000; // rows per json_each statement (~250 KB parameter)

type Firms = ReturnType<typeof createFirms>;
export interface NrtStats { files: number; skipped: number; detectionsWritten: number; cellDaysWritten: number; cellDaysDeleted: number; catchUp: number; stoppedBy?: string }

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

function fnv1a(lines: string[]): string {
  let h = 0x811c9dc5;
  for (const l of lines) for (let i = 0; i < l.length; i++) { h ^= l.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

interface Row { t: number; lat: number; lon: number; conf: number; frp: number; dn: string; ver: string; cell: number; heat: 'fire' | 'industrial'; reason: string | null; sensor: string }
const key = (t: number, lat: number, lon: number) => `${t}|${lat}|${lon}`;

/** Write one (satellite, date) file. Returns null when the fingerprint is unchanged. */
async function processFile(env: Env, sat: string, date: string, dets: Detection[], masks: Masks, now: string) {
  const canon = dets.map((d) => `${d.acqTime},${d.lat},${d.lon},${d.confidence},${d.frpMw},${d.version},${d.dayNight}`).sort();
  const fingerprint = `${canon.length}:${fnv1a(canon)}`;
  const prev = await env.NRT_DB.prepare('SELECT fingerprint FROM nrt_files WHERE satellite = ? AND acq_date = ?').bind(sat, date).first<{ fingerprint: string }>();
  if (prev?.fingerprint === fingerprint) return null;

  // 2. classify (same thresholds as filter.ts / the archive's industrial layer)
  const rows = new Map<string, Row>();
  for (const d of dets) {
    if (d.confidence < (d.sensor === 'MODIS' ? 30 : 60)) continue;
    const cell = toCellId(d.lat, d.lon);
    const reason = masks.reasonFor(cell);
    rows.set(key(d.acqTime, d.lat, d.lon), { t: d.acqTime, lat: d.lat, lon: d.lon, conf: d.confidence, frp: d.frpMw, dn: d.dayNight, ver: d.version, cell, heat: reason ? 'industrial' : 'fire', reason, sensor: d.sensor });
  }

  // 3. diff against D1
  const existing = await env.NRT_DB.prepare('SELECT acq_time AS t, lat, lon, confidence AS conf, frp_mw AS frp, heat_class AS heat, heat_reason AS reason, version AS ver, sensor FROM nrt_detections WHERE satellite = ? AND acq_date = ?')
    .bind(sat, date).all<{ t: number; lat: number; lon: number; conf: number; frp: number; heat: 'fire' | 'industrial'; reason: string | null; ver: string; sensor: string }>();
  const have = new Map(existing.results.map((r) => [key(r.t, r.lat, r.lon), r]));
  const upserts: Row[] = [];
  for (const [k, r] of rows) {
    const e = have.get(k);
    if (!e || e.conf !== r.conf || e.frp !== r.frp || e.heat !== r.heat || e.reason !== r.reason || e.ver !== r.ver) upserts.push(r);
  }

  // 4. cell-days from the union of D1 rows after this write (fire only)
  const all = new Map<string, { t: number; lat: number; lon: number; frp: number; heat: string; sensor: string }>(have);
  for (const r of upserts) all.set(key(r.t, r.lat, r.lon), r);
  const fire: Detection[] = [];
  for (const r of all.values())
    if (r.heat === 'fire')
      fire.push({ lat: r.lat, lon: r.lon, acqDate: date, acqTime: r.t, satellite: sat as Detection['satellite'], sensor: r.sensor as Detection['sensor'], confidence: 0, frpMw: r.frp, dayNight: 'D', type: null, tier: 'NRT', version: '' });
  const cds = buildCellDays(fire);
  const oldCd = await env.NRT_DB.prepare('SELECT cell_id AS c, n_detections AS n, n_passes AS p, peak_frp_mw AS pk, sum_frp_mw AS s, first_time AS f, last_time AS l FROM nrt_cell_days WHERE acq_date = ? AND satellite = ?')
    .bind(date, sat).all<{ c: number; n: number; p: number; pk: number; s: number; f: number; l: number }>();
  const oldBy = new Map(oldCd.results.map((r) => [r.c, r]));
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
  const cdWrites = cds.filter((c) => {
    const o = oldBy.get(c.cellId);
    return !o || o.n !== c.nDetections || o.p !== c.nPasses || !near(o.pk, c.peakFrpMw) || !near(o.s, c.sumFrpMw) || o.f !== c.firstTime || o.l !== c.lastTime;
  });
  const live = new Set(cds.map((c) => c.cellId));
  const cdDeletes = [...oldBy.keys()].filter((c) => !live.has(c));

  // 5. one batch = one transaction
  const st: D1PreparedStatement[] = [];
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const json = JSON.stringify(upserts.slice(i, i + CHUNK).map((r) => [r.t, r.lat, r.lon, r.sensor, r.conf, r.frp, r.dn, r.ver, r.cell, r.heat, r.reason]));
    st.push(env.NRT_DB.prepare(
      `INSERT INTO nrt_detections (satellite, acq_date, acq_time, lat, lon, sensor, confidence, frp_mw, day_night, version, cell_id, heat_class, heat_reason, ingested_at)
       SELECT ?1, ?2, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
              json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]'), json_extract(value, '$[10]'), ?3
       FROM json_each(?4) WHERE true
       ON CONFLICT (satellite, acq_date, acq_time, lat, lon) DO UPDATE SET confidence = excluded.confidence, frp_mw = excluded.frp_mw, day_night = excluded.day_night,
         version = excluded.version, heat_class = excluded.heat_class, heat_reason = excluded.heat_reason, ingested_at = excluded.ingested_at`,
    ).bind(sat, date, now, json));
  }
  for (let i = 0; i < cdWrites.length; i += CHUNK) {
    const json = JSON.stringify(cdWrites.slice(i, i + CHUNK).map((c) => [c.cellId, c.sensor, c.gridLat, c.gridLon, c.nDetections, c.nPasses, c.peakFrpMw, c.sumFrpMw, c.firstTime, c.lastTime]));
    st.push(env.NRT_DB.prepare(
      `INSERT INTO nrt_cell_days (acq_date, cell_id, satellite, sensor, grid_lat, grid_lon, n_detections, n_passes, peak_frp_mw, sum_frp_mw, first_time, last_time, hv)
       SELECT ?1, json_extract(value, '$[0]'), ?2, json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
              json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]'), ?3
       FROM json_each(?4) WHERE true
       ON CONFLICT (acq_date, cell_id, satellite) DO UPDATE SET n_detections = excluded.n_detections, n_passes = excluded.n_passes, peak_frp_mw = excluded.peak_frp_mw,
         sum_frp_mw = excluded.sum_frp_mw, first_time = excluded.first_time, last_time = excluded.last_time, hv = excluded.hv`,
    ).bind(date, sat, HARMONIZER_VERSION, json));
  }
  for (let i = 0; i < cdDeletes.length; i += CHUNK)
    st.push(env.NRT_DB.prepare('DELETE FROM nrt_cell_days WHERE acq_date = ? AND satellite = ? AND cell_id IN (SELECT value FROM json_each(?))').bind(date, sat, JSON.stringify(cdDeletes.slice(i, i + CHUNK))));
  if (dets.length) st.push(env.NRT_DB.prepare('INSERT INTO nrt_availability (satellite, acq_date) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(sat, date));
  let nFire = 0;
  for (const r of rows.values()) if (r.heat === 'fire') nFire++;
  st.push(env.NRT_DB.prepare(
    `INSERT INTO nrt_files (satellite, acq_date, fingerprint, n_rows, n_fire, n_industrial, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (satellite, acq_date) DO UPDATE SET fingerprint = excluded.fingerprint, n_rows = excluded.n_rows, n_fire = excluded.n_fire,
       n_industrial = excluded.n_industrial, fetched_at = excluded.fetched_at`,
  ).bind(sat, date, fingerprint, dets.length, nFire, rows.size - nFire, now));
  await env.NRT_DB.batch(st);
  return { detections: upserts.length, cellDays: cdWrites.length, cellDaysDeleted: cdDeletes.length };
}

/** Parse one FIRMS response and write every (satellite, date) file it contains. `expect` lists files to record even when empty. */
async function ingest(env: Env, source: string, csv: string, masks: Masks, stats: NrtStats, log: (o: object) => void, expect: { date: string }[] = []) {
  const groups = new Map<string, Detection[]>();
  for (const d of parseFirmsCsv(csv, { tier: 'NRT', sourceHint: source })) {
    const k = `${d.satellite}|${d.acqDate}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(d);
  }
  for (const { date } of expect) for (const sat of SOURCE_SATS[source]) if (!groups.has(`${sat}|${date}`)) groups.set(`${sat}|${date}`, []);
  const now = new Date().toISOString();
  for (const [k, dets] of groups) {
    const [sat, date] = k.split('|');
    const t0 = Date.now();
    const r = await processFile(env, sat, date, dets, masks, now);
    stats.files++;
    if (!r) { stats.skipped++; continue; }
    stats.detectionsWritten += r.detections;
    stats.cellDaysWritten += r.cellDays;
    stats.cellDaysDeleted += r.cellDaysDeleted;
    log({ job: 'nrt', source, satellite: sat, date, rows: dets.length, written: r.detections, cellDays: r.cellDays, cellDaysDeleted: r.cellDaysDeleted, ms: Date.now() - t0 });
  }
}

export async function runNrt(env: Env, firms: Firms, masks: Masks, log: (o: object) => void, deadline: number): Promise<NrtStats> {
  const stats: NrtStats = { files: 0, skipped: 0, detectionsWritten: 0, cellDaysWritten: 0, cellDaysDeleted: 0, catchUp: 0 };
  const recentDays = Math.max(1, Math.min(10, Number(env.NRT_DAY_RANGE) || 2));
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = addDays(today, -Number(env.D1_RETENTION_DAYS || 92));
  const avail = await firms.availability();

  // A. recent days, every source, always (the overlap catches late granules)
  for (const source of NRT_SOURCES) {
    try {
      await firms.ensureBudget(RESERVE_TX[source] * recentDays);
      await ingest(env, source, await firms.areaWorld(source, recentDays), masks, stats, log);
    } catch (e) {
      if (e instanceof FirmsBudgetExhausted) { stats.stoppedBy = e.message; return stats; }
      throw e;
    }
  }

  // B. catch-up: window days not yet loaded, newest first, within each source's FIRMS availability,
  //    until the FIRMS budget or the run's time budget is used. Fills the 92-day window after a deploy
  //    or an outage, then costs nothing.
  const done = new Set((await env.NRT_DB.prepare('SELECT satellite, acq_date FROM nrt_files WHERE acq_date >= ?').bind(cutoff).all<{ satellite: string; acq_date: string }>())
    .results.map((r) => `${r.satellite}|${r.acq_date}`));
  const todo: { source: string; date: string }[] = [];
  for (let d = addDays(today, -recentDays); d >= cutoff; d = addDays(d, -1))
    for (const source of NRT_SOURCES) {
      const a = avail.get(source);
      if (!a || d < a.min || d > a.max) continue;
      if (SOURCE_SATS[source].every((s) => done.has(`${s}|${d}`))) continue;
      todo.push({ source, date: d });
    }
  for (const t of todo) {
    if (Date.now() > deadline) { stats.stoppedBy = 'time budget'; break; }
    try {
      await firms.ensureBudget(RESERVE_TX[t.source]);
      await ingest(env, t.source, await firms.areaWorld(t.source, 1, t.date), masks, stats, log, [{ date: t.date }]);
      stats.catchUp++;
    } catch (e) {
      if (e instanceof FirmsBudgetExhausted) { stats.stoppedBy = e.message; break; }
      throw e;
    }
  }
  log({ job: 'nrt', msg: 'catch-up', remaining: Math.max(0, todo.length - stats.catchUp), done: stats.catchUp });
  return stats;
}
