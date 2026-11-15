// Run: node --test "packages/harmonizer/test/*.test.ts"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as H from '../src/index.ts';

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../../sample_api');
const read = (f: string) => readFileSync(join(SAMPLES, f), 'utf8');
const parseAll = (f: string, tier: H.Tier = 'SP') => [...H.parseFirmsCsv(read(f), { tier })];

describe('parser', () => {
  it('parses both SP sample formats without rejects', () => {
    const ms = H.newParseStats();
    const vs = H.newParseStats();
    const m = [...H.parseFirmsCsv(read('modis_historical_sample.csv'), { tier: 'SP', stats: ms })];
    const v = [...H.parseFirmsCsv(read('viirs_snpp_historical_sample.csv'), { tier: 'SP', stats: vs })];
    assert.equal(m.length, 2293);
    assert.equal(v.length, 14978);
    assert.deepEqual(ms.rejected, {});
    assert.deepEqual(vs.rejected, {});
    assert.deepEqual(new Set(m.map((d) => d.satellite)), new Set(['TERRA', 'AQUA']));
    assert.deepEqual(new Set(v.map((d) => d.satellite)), new Set(['SNPP']));
    assert.ok(v.every((d) => [20, 60, 90].includes(d.confidence)));
    assert.equal(m[0].acqTime, 535);
  });

  it('NRT file has type = null', () => {
    const r = parseAll('modis_recent_sample.csv', 'NRT');
    assert.equal(r.length, 10);
    assert.ok(r.every((d) => d.type === null && d.tier === 'NRT'));
  });

  it('normalizes satellite codes across sensors', () => {
    assert.equal(H.normalizeSatellite('N', 'VIIRS'), 'SNPP');
    assert.equal(H.normalizeSatellite('1', 'VIIRS'), 'NOAA20');
    assert.equal(H.normalizeSatellite('N20', 'VIIRS'), 'NOAA20');
    assert.equal(H.normalizeSatellite('N21', 'VIIRS'), 'NOAA21');
    assert.equal(H.normalizeSatellite('Terra', 'MODIS'), 'TERRA');
    assert.equal(H.normalizeSatellite('A', 'MODIS'), 'AQUA');
    assert.equal(H.normalizeSatellite('N', 'MODIS'), null);
  });

  it('rejects invalid rows and counts reasons', () => {
    const csv =
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n' +
      '95,10,300,0.4,0.4,2020-01-01,100,N,VIIRS,n,2,290,1,D\n' +
      '10,10,300,0.4,0.4,2020-02-30,100,N,VIIRS,n,2,290,1,D\n' +
      '10,10,300,0.4,0.4,2020-02-01,1275,N,VIIRS,n,2,290,1,D\n' +
      '10,10,300,0.4,0.4,2020-02-01,1200,N,VIIRS,x,2,290,1,D\n' +
      '10,10,300,0.4,0.4,2020-02-01,1200,N,VIIRS,h,2,290,1,D\r\n';
    const st = H.newParseStats();
    const r = [...H.parseFirmsCsv(csv, { tier: 'NRT', stats: st })];
    assert.equal(r.length, 1);
    assert.deepEqual(st.rejected, { bad_lat: 1, bad_date: 1, bad_time: 1, bad_confidence: 1 });
  });

  it('stream parser equals string parser across arbitrary chunk boundaries', async () => {
    const text = read('modis_historical_sample.csv');
    async function* chunks() {
      const enc = new TextEncoder().encode(text);
      for (let i = 0; i < enc.length; i += 777) yield enc.slice(i, i + 777);
    }
    const a: H.Detection[] = [];
    for await (const d of H.parseFirmsCsvStream(chunks(), { tier: 'SP' })) a.push(d);
    assert.deepEqual(a, parseAll('modis_historical_sample.csv'));
  });
});

describe('filter', () => {
  it('drops exactly the type 1/2/3 rows (4+7 MODIS, 98+48 VIIRS)', () => {
    const opts = { modisMinConfidence: 0, viirsMinConfidence: 0 };
    const m = parseAll('modis_historical_sample.csv');
    const v = parseAll('viirs_snpp_historical_sample.csv');
    assert.equal(m.length - [...H.filterDetections(m, opts)].length, 11);
    assert.equal(v.length - [...H.filterDetections(v, opts)].length, 146);
  });

  it('static mask removes NRT detections in masked cells', () => {
    const d = parseAll('modis_recent_sample.csv', 'NRT')[0];
    const mask = new Set([H.toCellId(d.lat, d.lon)]);
    assert.equal(H.keepDetection(d, { staticMask: mask }), false);
    assert.equal(H.keepDetection(d, {}), true);
  });
});

describe('grid', () => {
  it('round-trips cell ids and centers', () => {
    for (const [lat, lon] of [[34.6395, -118.5775], [0, 0], [-89.99, -179.99], [89.99, 179.99]]) {
      const id = H.toCellId(lat, lon);
      const c = H.cellCenter(id);
      assert.ok(Math.abs(c.lat - lat) <= 0.025 + 1e-9 && Math.abs(c.lon - lon) <= 0.025 + 1e-9);
      assert.equal(H.toCellId(c.lat, c.lon), id);
    }
  });
  it('handles ±90/±180 edges and exact grid lines', () => {
    assert.equal(H.toCellId(90, 180), 3599 * 7200 + 7199);
    assert.equal(H.toCellId(-90, -180), 0);
    assert.equal(H.latToRow(34.65), Math.round((34.65 + 90) * 20)); // float trap: 124.65*20 = 2492.9999…
    assert.equal(H.lonToCol(-118.55), Math.round((-118.55 + 180) * 20));
  });
  it('point in polygon with hole', () => {
    const g: H.PolygonGeometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    };
    assert.equal(H.pointInPolygon(1, 1, g), true);
    assert.equal(H.pointInPolygon(5, 5, g), false);
    assert.equal(H.pointInPolygon(11, 5, g), false);
  });
});

describe('cell-days', () => {
  const det = (acqTime: number, frpMw: number): H.Detection => ({
    lat: 34.6, lon: -118.6, acqDate: '2020-08-15', acqTime, satellite: 'SNPP', sensor: 'VIIRS',
    confidence: 60, frpMw, dayNight: 'D', type: 0, tier: 'SP', version: '2',
  });
  it('05:35 / 05:36 / 07:20 → 2 passes; peak = max per-pass sum', () => {
    const [c] = H.buildCellDays([det(720, 50), det(535, 10), det(536, 15)]);
    assert.equal(c.nPasses, 2);
    assert.equal(c.nDetections, 3);
    assert.equal(c.peakFrpMw, 50);
    assert.equal(c.sumFrpMw, 75);
    assert.equal(c.firstTime, 535);
    assert.equal(c.lastTime, 720);
  });
  it('passes across the hour boundary use minutes, not HHMM arithmetic (0559 → 0601 = 2 min)', () => {
    const [c] = H.buildCellDays([det(559, 1), det(601, 1)]);
    assert.equal(c.nPasses, 1);
  });

  it('golden: per-satellite active cells per day, 2020-08-15 → 19', () => {
    const all = [...parseAll('modis_historical_sample.csv'), ...parseAll('viirs_snpp_historical_sample.csv')];
    const mask = H.maskSet(H.buildStaticMask(all));
    const cds = H.buildCellDays(H.filterDetections(all, { staticMask: mask }));
    assert.equal(cds.length, 1058);
    const got = H.dailySensorCounts(cds).map((d) => [d.acqDate, d.cells.TERRA, d.cells.AQUA, d.cells.SNPP, d.modisUnion]);
    assert.deepEqual(got, [
      ['2020-08-15', 13, 14, 31, 17],
      ['2020-08-16', 24, 0, 56, 24],
      ['2020-08-17', 52, 16, 79, 57],
      ['2020-08-18', 73, 0, 120, 73],
      ['2020-08-19', 190, 101, 289, 215],
    ]);
  });
});

// ---------- synthetic helpers for calibration / harmonization ----------
function counts(acqDate: string, c: Partial<Record<H.Satellite, number>>, union?: number): H.DailyCounts {
  const cells = { TERRA: 0, AQUA: 0, SNPP: 0, NOAA20: 0, NOAA21: 0, ...c };
  return { acqDate, cells, modisUnion: union ?? Math.max(cells.TERRA, cells.AQUA), peakFrpMw: { TERRA: 0, AQUA: 0, SNPP: 0, NOAA20: 0, NOAA21: 0 } };
}
function avail(spec: Partial<Record<H.Satellite, [string, string]>>): Map<H.Satellite, Set<string>> {
  const m = new Map<H.Satellite, Set<string>>();
  for (const [s, [a, b]] of Object.entries(spec) as [H.Satellite, [string, string]][]) m.set(s, new Set(H.dateRange(a, b)));
  return m;
}

describe('calibration', () => {
  it('recovers a known ratio of 3 exactly when data are plentiful', () => {
    const daily: H.DailyCounts[] = [];
    let i = 0;
    for (const d of H.dateRange('2013-01-01', '2014-12-31')) {
      const m = 5 + (i++ % 17);
      daily.push(counts(d, { TERRA: m, AQUA: m, SNPP: 3 * m }, m));
    }
    const av = avail({ TERRA: ['2013-01-01', '2014-12-31'], AQUA: ['2013-01-01', '2014-12-31'], SNPP: ['2013-01-01', '2014-12-31'] });
    const t = H.computeAlphaTable(daily, av, { years: [2013, 2014] });
    for (const a of t.TA) assert.ok(Math.abs(a.alpha - 3) < 1e-12, `month ${a.month}: ${a.alpha}`);
  });

  it('shrinks toward the prior as ΣM → 0, and equals the prior at ΣM = 0', () => {
    const prior = Array(12).fill(2);
    const mk = (m: number, v: number): H.CalibrationSample[] => [{ acqDate: '2015-08-01', year: 2015, month: 8, m, v }];
    const big = H.computeAlpha(mk(10000, 40000), { prior, k: 50 })[7];
    const small = H.computeAlpha(mk(5, 20), { prior, k: 50 })[7];
    const none = H.computeAlpha(mk(0, 0), { prior, k: 50 })[7];
    assert.ok(Math.abs(big.alpha - 4) < 0.03);
    assert.ok(small.alpha > 2 && small.alpha < 2.3);
    assert.equal(none.alpha, 2);
    assert.equal(none.w, 0);
  });

  it('clamps to [0.5, 10]', () => {
    const a = H.computeAlpha([{ acqDate: '2015-08-01', year: 2015, month: 8, m: 1e6, v: 1e8 }], { k: 0 })[7];
    assert.equal(a.alpha, 10);
  });

  it('bootstrap interval brackets the estimate and is reproducible', () => {
    const s: H.CalibrationSample[] = [];
    for (let y = 2013; y <= 2021; y++) s.push({ acqDate: `${y}-08-01`, year: y, month: 8, m: 100, v: 250 + 10 * (y - 2017) });
    const a = H.computeAlpha(s, { bootstrap: { reps: 500, seed: 7 } })[7];
    const b = H.computeAlpha(s, { bootstrap: { reps: 500, seed: 7 } })[7];
    assert.ok(a.ciLow! <= a.alpha && a.alpha <= a.ciHigh!);
    assert.deepEqual(a, b);
  });
});

describe('harmonization (OR-based availability)', () => {
  const alpha = (v: number): H.AlphaTable => {
    const row = (config: H.ModisConfig) =>
      Array.from({ length: 12 }, (_, i) => ({ month: i + 1, config, alpha: v, alphaLocal: v, alphaPrior: v, w: 1, sumModis: 0, sumViirs: 0, nDays: 0, nYears: 0, ciLow: null, ciHigh: null }));
    return { TA: row('TA'), T: row('T'), A: row('A') };
  };

  it('a month straddling 2012-01-20 uses MODIS_SCALED before and VIIRS from that day', () => {
    const daily = [...H.dateRange('2012-01-01', '2012-01-31')].map((d) => counts(d, { TERRA: 10, AQUA: 10, SNPP: 25 }, 12));
    const av = avail({ TERRA: ['2012-01-01', '2012-01-31'], AQUA: ['2012-01-01', '2012-01-31'], SNPP: ['2012-01-20', '2012-01-31'] });
    const h = H.harmonizeDaily(daily, av, alpha(2), { from: '2012-01-01', to: '2012-01-31' });
    assert.equal(h[18].basis, 'MODIS_SCALED');
    assert.equal(h[18].harmonizedCellDays, 24); // α · |T ∪ A| = 2 · 12
    assert.equal(h[19].basis, 'VIIRS');
    assert.equal(h[19].harmonizedCellDays, 25);
    const [cal] = H.buildCalendar(h);
    assert.equal(cal.harmonizedCellDays, 19 * 24 + 12 * 25); // never both sensors on one day
    assert.equal(cal.complete, true);
    assert.ok(Math.abs(cal.sourceMix - 12 / 31) < 1e-12);
  });

  it('uses the Terra-only α before Aqua and on Aqua outages', () => {
    const t = alpha(2);
    for (const a of t.T) a.alpha = 3;
    const daily = [counts('2001-08-01', { TERRA: 10 }), counts('2005-08-01', { TERRA: 10, AQUA: 8 }, 14)];
    const av = avail({ TERRA: ['2001-08-01', '2005-08-01'], AQUA: ['2005-08-01', '2005-08-01'] });
    const h = H.harmonizeDaily(daily, av, t, { from: '2001-08-01', to: '2001-08-01' });
    assert.equal(h[0].modisConfig, 'T');
    assert.equal(h[0].harmonizedCellDays, 30);
    const h2 = H.harmonizeDaily(daily, av, t, { from: '2005-08-01', to: '2005-08-01' });
    assert.equal(h2[0].modisConfig, 'TA');
    assert.equal(h2[0].harmonizedCellDays, 28);
  });

  it('one VIIRS reference per day: adding NOAA-20 does not add counts', () => {
    const daily = [counts('2019-08-01', { SNPP: 40, NOAA20: 45 })];
    const av = avail({ SNPP: ['2019-08-01', '2019-08-01'], NOAA20: ['2019-08-01', '2019-08-01'] });
    const [h] = H.harmonizeDaily(daily, av, alpha(2), { from: '2019-08-01', to: '2019-08-01' });
    assert.equal(h.viirsReference, 'SNPP');
    assert.equal(h.harmonizedCellDays, 40);
  });

  it('falls back to NOAA-20 when S-NPP is out; NONE when nothing is available', () => {
    const daily = [counts('2022-07-30', { NOAA20: 45, TERRA: 20 })];
    const av = avail({ NOAA20: ['2022-07-30', '2022-07-30'] });
    const h = H.harmonizeDaily(daily, av, alpha(2), { from: '2022-07-30', to: '2022-07-31' });
    assert.equal(h[0].viirsReference, 'NOAA20');
    assert.equal(h[1].basis, 'NONE');
    assert.equal(H.buildCalendar(h)[0].complete, false);
  });

  it('zero-fire available days are explicit zeros (dense series)', () => {
    const av = avail({ SNPP: ['2019-08-01', '2019-08-03'] });
    const h = H.harmonizeDaily([], av, alpha(2), { from: '2019-08-01', to: '2019-08-03' });
    assert.deepEqual(h.map((d) => [d.basis, d.harmonizedCellDays]), [['VIIRS', 0], ['VIIRS', 0], ['VIIRS', 0]]);
  });

  it('auto-detects a satellite outage and falls through to the other sensor', () => {
    const daily = [counts('2016-08-01', { SNPP: 0, TERRA: 30, AQUA: 25 }, 40)];
    const av = avail({ SNPP: ['2016-08-01', '2016-08-01'], TERRA: ['2016-08-01', '2016-08-01'], AQUA: ['2016-08-01', '2016-08-01'] });
    const out = H.detectOutages(daily, av);
    assert.deepEqual(out.map((o) => o.satellite), ['SNPP']);
    const [h] = H.harmonizeDaily(daily, H.withoutDates(av, out), alpha(2), { from: '2016-08-01', to: '2016-08-01' });
    assert.equal(h.basis, 'MODIS_SCALED');
    assert.equal(h.harmonizedCellDays, 80);
  });
});

describe('validation', () => {
  it('a perfectly proportional synthetic record passes LOYO, continuity and linearity', () => {
    const daily: H.DailyCounts[] = [];
    let i = 0;
    for (const d of H.dateRange('2013-01-01', '2021-12-31')) {
      const month = +d.slice(5, 7);
      const m = Math.round((1 + Math.sin(i++ / 9) ** 2) * (month >= 6 && month <= 10 ? 40 : 4));
      const ratio = month >= 6 && month <= 10 ? 1.5 : 2.5; // seasonal α
      daily.push(counts(d, { TERRA: m, AQUA: m, SNPP: Math.round(ratio * m) }, m));
    }
    const av = avail({ TERRA: ['2013-01-01', '2021-12-31'], AQUA: ['2013-01-01', '2021-12-31'], SNPP: ['2013-01-01', '2021-12-31'] });
    const alpha = H.computeAlphaTable(daily, av, { years: [2013, 2021] });
    assert.ok(Math.abs(alpha.TA[7].alpha - 1.5) < 0.01);
    assert.ok(Math.abs(alpha.TA[0].alpha - 2.5) < 0.05);
    const r = H.validateCalibration(daily, av, alpha, { years: [2013, 2021] });
    assert.ok(r.configs.TA.loyo.mdape! < 0.02, `mdape ${r.configs.TA.loyo.mdape}`);
    assert.equal(r.acceptance.loyoMdapeWithin15pct, true);
    assert.equal(r.acceptance.noStepAtTransition, true);
  });

  it('flags a non-proportional (saturating) relation via the log-log slope', () => {
    const s: H.CalibrationSample[] = [];
    for (let y = 2013; y <= 2021; y++)
      for (let m = 1; m <= 12; m++) {
        const M = 20 * (m + y - 2012);
        s.push({ acqDate: `${y}-${String(m).padStart(2, '0')}-01`, year: y, month: m, m: M, v: Math.round(10 * Math.sqrt(M) * 3) });
      }
    const lin = H.linearityDiagnostics(s);
    assert.ok(Math.abs(lin.beta! - 0.5) < 0.02);
  });
});

describe('anomalies', () => {
  const cal = (vals: [number, number][]): H.CalendarCell[] =>
    vals.map(([year, v]) => ({
      year, month: 8, harmonizedCellDays: v, modisCellDays: 0, viirsCellDays: 0, sourceMix: 1, nDays: 31,
      nViirsDays: 31, nModisScaledDays: 0, nNoneDays: 0, peakFrpMw: null, peakFrpSensor: null, complete: true,
    }));
  it('median, robust z and class against a known baseline (target year excluded)', () => {
    const { cells } = H.computeAnomalies(cal([[2001, 10], [2002, 20], [2003, 30], [2004, 40], [2005, 50], [2020, 200]]), { baselineYears: [2001, 2025] });
    const a = cells.at(-1)!.anomaly!;
    assert.equal(a.median, 30);
    assert.equal(a.ratioToMedian, 200 / 30);
    assert.ok(Math.abs(a.robustZ! - 170 / (1.4826 * 10)) < 1e-9);
    assert.equal(a.class, 'record_high');
  });
  it('zero-MAD baseline gives robustZ = null', () => {
    const { cells } = H.computeAnomalies(cal([[2001, 5], [2002, 5], [2003, 5], [2004, 9]]), { baselineYears: [2001, 2025] });
    assert.equal(cells.at(-1)!.anomaly!.robustZ, null);
  });
});

describe('determinism', () => {
  it('same input → byte-identical CSV, regardless of input order', () => {
    const all = [...parseAll('modis_historical_sample.csv'), ...parseAll('viirs_snpp_historical_sample.csv')];
    const ser = (ds: H.Detection[]) => H.buildCellDays(H.filterDetections(ds)).map((c) => H.cellDayRow(c, H.HARMONIZER_VERSION)).join('');
    const reversed = [...all].reverse();
    assert.equal(ser(all), ser(reversed));
  });
});

describe('grid-size sensitivity', () => {
  const all = () => [...parseAll('modis_historical_sample.csv'), ...parseAll('viirs_snpp_historical_sample.csv')];

  it('gridCellIdAt(0.05) is the production toCellId', () => {
    for (const d of all()) assert.equal(H.gridCellIdAt(d.lat, d.lon, 0.05), H.toCellId(d.lat, d.lon));
  });

  it('dailyCountsAtResolution(0.05) reproduces the production daily counts', () => {
    const ds = all();
    const kept = [...H.filterDetections(ds, { staticMask: H.maskSet(H.buildStaticMask(ds)) })];
    const prod = H.dailySensorCounts(H.buildCellDays(kept));
    const res = H.dailyCountsAtResolution(kept, 0.05);
    assert.deepEqual(res.map((d) => [d.acqDate, d.cells, d.modisUnion]), prod.map((d) => [d.acqDate, d.cells, d.modisUnion]));
    // coarser grid → never more cells
    const coarse = H.dailyCountsAtResolution(kept, 0.1);
    for (let i = 0; i < res.length; i++) assert.ok(coarse[i].cells.SNPP <= res[i].cells.SNPP);
  });

  it('rejects grid sizes that do not tile the globe', () => {
    assert.throws(() => H.assertValidGridDeg(0.07));
    assert.doesNotThrow(() => H.assertValidGridDeg(0.025));
  });

  const row = (gridDeg: number, loyoMdape: number | null, proportional: boolean | null = true, noStep: boolean | null = true): H.GridSensitivityRow => ({
    gridDeg, approxKm: 0, alphaTA: [], pooledAlphaTA: null, inSampleMdape: null, loyoMdape, stepPct: null, beta: null, betaSe: null,
    proportional, noStepAtTransition: noStep, coincidence: null, nCalibrationDays: 0,
  });

  it('pick rule: lowest LOYO among sizes whose checks do not fail', () => {
    assert.equal(H.pickGridSize([row(0.025, 0.08, false), row(0.05, 0.10), row(0.1, 0.12)]).recommended, 0.05);
    assert.equal(H.pickGridSize([row(0.025, 0.08), row(0.05, 0.10), row(0.1, 0.07, true, false)]).recommended, 0.025);
    assert.equal(H.pickGridSize([row(0.025, 0.10), row(0.05, 0.10)]).recommended, 0.05); // tie → stay on production grid
    const none = H.pickGridSize([row(0.025, null), row(0.05, null)]);
    assert.equal(none.recommended, null);
    assert.match(none.reason, /not enough overlap years/);
    assert.match(H.pickGridSize([row(0.05, 0.1, false)]).reason, /no grid size passes/);
  });

  it('synthetic multi-year: 0.05° recovers α = 1 (VIIRS points share the MODIS cell); 0.025° splits them (α = 3)', () => {
    // Fires on a 0.05° lattice. VIIRS sees 3 points per MODIS point, all inside the same 0.05° cell.
    // At 0.025° the VIIRS points spread into neighbouring cells, so V/M changes with activity.
    const dets: H.Detection[] = [];
    const mk = (lat: number, lon: number, acqDate: string, satellite: H.Satellite): H.Detection => ({
      lat, lon, acqDate, acqTime: 1330, satellite, sensor: H.sensorOf(satellite), confidence: 90, frpMw: 10, dayNight: 'D', type: 0, tier: 'SP', version: 'x',
    });
    let i = 0;
    for (const d of H.dateRange('2013-01-01', '2016-12-31')) {
      const n = 2 + ((i++ * 7) % 13);
      for (let f = 0; f < n; f++) {
        const lat = 35.01 + 0.05 * f;
        const lon = -119.99 + 0.05 * ((i + f) % 20); // cell [-120.00, -119.95): +0.03 stays inside
        dets.push(mk(lat, lon, d, 'TERRA'), mk(lat, lon, d, 'AQUA'));
        dets.push(mk(lat, lon, d, 'SNPP'), mk(lat + 0.03, lon, d, 'SNPP'), mk(lat, lon + 0.03, d, 'SNPP'));
      }
    }
    const av = avail({ TERRA: ['2013-01-01', '2016-12-31'], AQUA: ['2013-01-01', '2016-12-31'], SNPP: ['2013-01-01', '2016-12-31'] });
    const per = new Map([0.025, 0.05].map((g) => [g, H.dailyCountsAtResolution(dets, g)]));
    const rep = H.gridSensitivity(per, av, { years: [2013, 2016] });
    const r05 = rep.rows.find((r) => r.gridDeg === 0.05)!;
    assert.ok(Math.abs(r05.pooledAlphaTA! - 1) < 1e-12); // all 3 VIIRS points share the MODIS cell
    assert.equal(r05.coincidence, 1);
    const r025 = rep.rows.find((r) => r.gridDeg === 0.025)!;
    assert.ok(Math.abs(r025.pooledAlphaTA! - 3) < 1e-12);
    assert.equal(r025.coincidence, 1); // one VIIRS point always sits on the MODIS point
    // Both are perfectly proportional (LOYO 0) → tie → stay on the production grid.
    assert.equal(rep.recommended, 0.05);
  });
});
