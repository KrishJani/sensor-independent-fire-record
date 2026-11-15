// Historical backfill pipeline (SPEC.md §6.2). All science lives in @repo/harmonizer;
// this file only does file I/O in three streaming passes so 10⁷-row inputs never sit in memory.
//
//   pass 1  parse + clip            → static mask, per-file coverage, input hashes
//   pass 2  parse + clip + filter   → unsorted per-year temp files
//   pass 3  per year: sort, de-dup  → detections/<y>.csv.gz, cell_days/<y>.csv, daily counts
//   then    availability → outages → α → harmonize → calendar → validation → outputs + manifest

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  ALL_SATELLITES,
  ALPHA_HEADER,
  AVAILABILITY_HEADER,
  CALENDAR_HEADER,
  CELL_DAY_HEADER,
  DAILY_HEADER,
  DETECTION_HEADER,
  HARMONIZER_VERSION,
  STATIC_MASK_HEADER,
  addDays,
  fmt,
  alphaRow,
  buildCalendar,
  applyBands,
  buildCellDays,
  calendarRow,
  cellDayRow,
  compareDetections,
  fitAlphaModel,
  effectiveAlphas,
  resolverFromEffective,
  modelAsTable,
  createFirmsLineParser,
  createStaticMaskAccumulator,
  dailyRow,
  dailySensorCounts,
  dateRange,
  detectOutages,
  detectionKey,
  detectionRow,
  harmonizeDaily,
  inBbox,
  keepDetection,
  maskSet,
  newFilterStats,
  newParseStats,
  sensorOf,
  staticMaskRow,
  validateModel,
  dailyCountsAtResolution,
  gridSensitivity,
  assertValidGridDeg,
  type GridSensitivityReport,
  type ResolutionDaily,
  withoutDates,
  MODIS_CONFIGS,
  type Bbox,
  type DailyCounts,
  type Detection,
  type ParseStats,
  type Satellite,
  type SensorFamily,
} from '../../../packages/harmonizer/src/index.ts';
import { loadSensors, satellitesOfSource, type Region } from './config.ts';
import { contentHashOfFile, createAppenders, forEachLine, gzipDeterministic, listCsvFiles, rel, sha256, writeAtomic } from './files.ts';
import { parseAvailability } from './firms.ts';

export interface RunOptions {
  region: Region;
  /** Bboxes of earlier regions in the same group, cut out of this region (no overlap). */
  excludeBboxes?: Bbox[];
  from: string;
  to: string;
  rawDir: string;
  outDir: string; // data/harmonized/<region>
  tmpDir: string;
  availabilityPath: string | null;
  calibrationYears: [number, number];
  k: number;
  minStaticDetections: number;
  minMonthlyCells: number;
  autoOutages: boolean;
  minOtherCellsForOutage: number;
  bootstrapReps: number;
  /** Parametric-bootstrap simulations for the noise-aware bias check (0 = fixed threshold). */
  noiseSims?: number;
  /** Grid sizes (degrees) for the sensitivity diagnostic; empty = off. */
  gridSensitivity: number[];
  dryRun: boolean;
  log: (m: string) => void;
}

interface InputFile {
  path: string;
  rel: string;
  sourceHint: string | null;
  chunk: { from: string; days: number } | null;
  skip: string | null;
  sha256?: string;
  stats: ParseStats;
  // observed date range per sensor family + satellites seen (for archive-file coverage)
  seen: Partial<Record<SensorFamily, { min: string; max: string; sats: Set<Satellite> }>>;
}

const SOURCE_RE = /^(MODIS|VIIRS)_[A-Z0-9_]+$/;

function describeInput(path: string, rawDir: string): InputFile {
  const r = rel(rawDir, path);
  const parts = r.split('/');
  const name = basename(path);
  let sourceHint = parts.find((p) => SOURCE_RE.test(p)) ?? null;
  let skip: string | null = null;
  // FIRMS Archive Download naming: fire_archive_M-C61_*, fire_archive_SV-C2_*, fire_archive_J1V-C2_*,
  // and fire_nrt_* for the most recent (not yet SP) period, which must not enter the SP archive.
  if (/^fire_nrt_/i.test(name)) skip = 'NRT file (not Standard Processing)';
  else if (/^fire_archive_M-/i.test(name)) sourceHint ??= 'MODIS_SP';
  else if (/^fire_archive_SV-/i.test(name)) sourceHint ??= 'VIIRS_SNPP_SP';
  else if (/^fire_archive_J1V-/i.test(name)) sourceHint ??= 'VIIRS_NOAA20_SP';
  else if (/^fire_archive_J2V-/i.test(name)) sourceHint ??= 'VIIRS_NOAA21_SP';
  if (sourceHint && /_NRT$/.test(sourceHint)) skip = 'NRT source directory';
  const m = /^(\d{4}-\d{2}-\d{2})_(\d+)d\.csv$/.exec(name);
  return {
    path,
    rel: r,
    sourceHint,
    chunk: m && sourceHint ? { from: m[1], days: +m[2] } : null,
    skip,
    stats: newParseStats(),
    seen: {},
  };
}

// ---- compact temp-row codec (pass 2 → pass 3) ----
function toTsv(d: Detection): string {
  return [d.lat, d.lon, d.acqDate, d.acqTime, d.satellite, d.confidence, d.frpMw, d.dayNight, d.type ?? '', d.version].join('\t') + '\n';
}
function fromTsv(l: string): Detection {
  const f = l.split('\t');
  const satellite = f[4] as Satellite;
  return {
    lat: +f[0],
    lon: +f[1],
    acqDate: f[2],
    acqTime: +f[3],
    satellite,
    sensor: sensorOf(satellite),
    confidence: +f[5],
    frpMw: +f[6],
    dayNight: f[7] as 'D' | 'N',
    type: f[8] === '' ? null : (+f[8] as 0 | 1 | 2 | 3),
    tier: 'SP',
    version: f[9],
  };
}

const r6 = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v);

export async function runBackfill(o: RunOptions) {
  const t0 = Date.now();
  const { log } = o;
  const sensors = loadSensors();
  const excluded = o.excludeBboxes ?? [];
  const inside = (d: Detection) =>
    d.acqDate >= o.from && d.acqDate <= o.to && inBbox(d.lat, d.lon, o.region.bbox) && !excluded.some((b) => inBbox(d.lat, d.lon, b));
  const isNrtRow = (d: Detection) => /NRT/i.test(d.version);

  const inputs = listCsvFiles(o.rawDir).map((p) => describeInput(p, o.rawDir));
  if (!inputs.length) throw new Error(`no CSV inputs under ${o.rawDir}`);
  for (const f of inputs) if (f.skip) log(`skip ${f.rel}: ${f.skip}`);
  const used = inputs.filter((f) => !f.skip);
  log(`${used.length} input files (${inputs.length - used.length} skipped)`);

  // ---------------- pass 1 ----------------
  const maskAcc = createStaticMaskAccumulator();
  let nrtRowsSkipped = 0;
  let outsideRows = 0;
  for (const f of used) {
    const p = createFirmsLineParser({ tier: 'SP', sourceHint: f.sourceHint ?? undefined, stats: f.stats });
    const res = await forEachLine(f.path, (line) => {
      const d = p.line(line);
      if (!d) return;
      if (isNrtRow(d)) return void nrtRowsSkipped++;
      // Coverage is a property of the FILE, not of the region: a country- or world-wide file
      // with fires on a day proves the granules for that day were processed, even if the
      // region itself was quiet. So track the span over every in-range row, before clipping.
      if (d.acqDate >= o.from && d.acqDate <= o.to) {
        const s = (f.seen[d.sensor] ??= { min: d.acqDate, max: d.acqDate, sats: new Set() });
        if (d.acqDate < s.min) s.min = d.acqDate;
        if (d.acqDate > s.max) s.max = d.acqDate;
        s.sats.add(d.satellite);
      }
      if (!inside(d)) return void outsideRows++;
      maskAcc.add(d);
    });
    f.sha256 = res.sha256;
  }
  const mask = maskAcc.entries(o.minStaticDetections);
  const maskCells = maskSet(mask);
  log(`pass 1: static mask ${mask.length} cells; ${nrtRowsSkipped} NRT rows skipped; ${outsideRows} rows outside region/range`);

  // ---------------- pass 2 ----------------
  const filterStats = newFilterStats();
  const app = createAppenders();
  rmSync(o.tmpDir, { recursive: true, force: true });
  for (const f of used) {
    const p = createFirmsLineParser({ tier: 'SP', sourceHint: f.sourceHint ?? undefined });
    await forEachLine(f.path, (line) => {
      const d = p.line(line);
      if (!d || isNrtRow(d) || !inside(d)) return;
      if (keepDetection(d, { staticMask: maskCells, stats: filterStats })) app.write(join(o.tmpDir, `det_${d.acqDate.slice(0, 4)}.tsv`), toTsv(d));
    });
  }
  await app.closeAll();
  log(`pass 2: kept ${filterStats.kept}/${filterStats.seen} (type ${filterStats.droppedType}, mask ${filterStats.droppedMask}, confidence ${filterStats.droppedConfidence})`);

  // ---------------- pass 3 ----------------
  const outputs = new Map<string, string | Buffer>(); // relative path → content
  const daily: DailyCounts[] = [];
  for (const g of o.gridSensitivity) assertValidGridDeg(g);
  const perGrid = new Map<number, ResolutionDaily[]>(o.gridSensitivity.map((g) => [g, []]));
  let duplicates = 0;
  let nDetections = 0;
  let nCellDays = 0;
  const yearFiles = existsSync(o.tmpDir) ? readdirSync(o.tmpDir).filter((n) => /^det_\d{4}\.tsv$/.test(n)).sort() : [];
  for (const yf of yearFiles) {
    const year = yf.slice(4, 8);
    const rows = readFileSync(join(o.tmpDir, yf), 'utf8').split('\n').filter(Boolean).map(fromTsv);
    rows.sort((a, b) => compareDetections(a, b) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
    const uniq: Detection[] = [];
    let prev = '';
    for (const d of rows) {
      const k = detectionKey(d);
      if (k === prev) {
        duplicates++;
        continue;
      }
      prev = k;
      uniq.push(d);
    }
    nDetections += uniq.length;
    let det = DETECTION_HEADER + '\n';
    for (const d of uniq) det += detectionRow(d, HARMONIZER_VERSION);
    outputs.set(`detections/${year}.csv.gz`, gzipDeterministic(det));

    const cds = buildCellDays(uniq);
    nCellDays += cds.length;
    let cdCsv = CELL_DAY_HEADER + '\n';
    for (const c of cds) cdCsv += cellDayRow(c, HARMONIZER_VERSION);
    outputs.set(`cell_days/${year}.csv`, cdCsv);
    daily.push(...dailySensorCounts(cds));
    // Same de-duplicated, filtered detections, re-gridded at each test size.
    for (const [g, acc] of perGrid) acc.push(...dailyCountsAtResolution(uniq, g));
    log(`pass 3: ${year}: ${uniq.length} detections, ${cds.length} cell-days`);
  }
  rmSync(o.tmpDir, { recursive: true, force: true });
  log(`pass 3: ${duplicates} duplicate detections removed`);

  // ---------------- source availability (OR-based, per satellite, per day) ----------------
  const apiAvail = o.availabilityPath && existsSync(o.availabilityPath) ? parseAvailability(readFileSync(o.availabilityPath, 'utf8')) : null;
  const av = new Map<Satellite, Set<string>>();
  const addRange = (sat: Satellite, a: string, b: string) => {
    const cfg = sensors.satellites[sat];
    let lo = a < o.from ? o.from : a;
    let hi = b > o.to ? o.to : b;
    if (cfg.start && lo < cfg.start) lo = cfg.start;
    const pub = cfg.source && apiAvail?.get(cfg.source);
    if (pub) {
      if (lo < pub.min) lo = pub.min;
      if (hi > pub.max) hi = pub.max;
    }
    if (lo > hi) return;
    let set = av.get(sat);
    if (!set) av.set(sat, (set = new Set()));
    for (const d of dateRange(lo, hi)) set.add(d);
  };
  for (const f of used) {
    if (f.chunk && f.sourceHint) {
      // API chunk: coverage is exactly the requested window, fires or not.
      for (const sat of satellitesOfSource(f.sourceHint)) addRange(sat, f.chunk.from, addDays(f.chunk.from, f.chunk.days - 1));
    } else {
      // Archive file: coverage is the date span observed in the whole file (all rows, not just
      // the region). For a region-clipped download quiet edge days stay NONE (conservative);
      // for a country/yearly file this is the full year. A MODIS_SP file covers Terra and Aqua.
      for (const fam of ['MODIS', 'VIIRS'] as SensorFamily[]) {
        const s = f.seen[fam];
        if (!s) continue;
        const sats: Satellite[] = fam === 'MODIS' ? ['TERRA', 'AQUA'] : [...s.sats];
        for (const sat of sats) addRange(sat, s.min, s.max);
      }
    }
  }
  const manualOutages = sensors.outages.flatMap((x) => [...dateRange(x.from, x.to)].map((acqDate) => ({ satellite: x.satellite, acqDate })));
  let availability = withoutDates(av, manualOutages);
  const detected = o.autoOutages ? detectOutages(daily, availability, { minOtherCells: o.minOtherCellsForOutage }) : [];
  availability = withoutDates(availability, detected);
  log(`availability: ${ALL_SATELLITES.map((s) => `${s}=${availability.get(s)?.size ?? 0}d`).join(' ')}; ${detected.length} auto-detected outage days`);

  // ---------------- calibration, harmonization, calendar, validation ----------------
  // Activity-dependent α (Poisson GLM, docs/HARMONIZATION.md §3): α_eff(year, month) from the region's
  // own MODIS activity that month. MODIS is scaled to VIIRS units on every day it flew; the calendar
  // uses VIIRS when available and MODIS × α_eff otherwise.
  const model = fitAlphaModel(daily, availability, {
    years: o.calibrationYears,
    k: o.k,
    bootstrap: o.bootstrapReps > 0 ? { reps: o.bootstrapReps, seed: 20260101 } : null,
  });
  const effective = effectiveAlphas(model, daily, availability, { from: o.from, to: o.to });
  const harmonized = harmonizeDaily(daily, availability, resolverFromEffective(effective, model), { from: o.from, to: o.to });
  const calendar = buildCalendar(harmonized);
  const validation = validateModel(daily, availability, model, {
    years: o.calibrationYears,
    k: o.k,
    minMonthlyCells: o.minMonthlyCells,
    noiseSims: o.noiseSims ?? 0,
    seed: 20260101,
  });
  // 90% bands on the MODIS-scaled part of each month, from the held-out (LOYO) errors.
  applyBands(calendar, validation.configs.TA.uncertainty?.monthly ?? null);
  const alpha = modelAsTable(model);
  // Same availability for every grid size, so cell size is the only variable.
  const sensitivity: GridSensitivityReport | null = perGrid.size
    ? gridSensitivity(perGrid, availability, { years: o.calibrationYears, k: o.k, minMonthlyCells: o.minMonthlyCells })
    : null;

  // ---------------- outputs ----------------
  // alpha_monthly.csv: α at each month's typical activity (for display; the CI is the bootstrap of that value).
  outputs.set('alpha_monthly.csv', ALPHA_HEADER + '\n' + MODIS_CONFIGS.flatMap((c) => alpha[c].map(alphaRow)).join(''));
  // alpha_model.json: the full model (what the api-worker needs for AOIs and the realtime baseline).
  outputs.set('alpha_model.json', JSON.stringify({ harmonizer_version: HARMONIZER_VERSION, calibration_years: o.calibrationYears, model }, r6, 2) + '\n');
  // alpha_effective.csv: the α actually applied, per (year, month, MODIS configuration).
  outputs.set(
    'alpha_effective.csv',
    'year,month,modis_config,modis_cells_per_day,alpha_eff\n' + effective.map((e) => `${e.year},${e.month},${e.config},${fmt(e.rate, 3)},${fmt(e.alpha, 4)}\n`).join(''),
  );
  outputs.set('static_mask.csv', STATIC_MASK_HEADER + '\n' + mask.map(staticMaskRow).join(''));
  let avCsv = AVAILABILITY_HEADER + '\n';
  for (const sat of ALL_SATELLITES) for (const d of [...(availability.get(sat) ?? [])].sort()) avCsv += `${sat},${d}\n`;
  outputs.set('source_availability.csv', avCsv);
  outputs.set('calendar_monthly.csv', CALENDAR_HEADER + '\n' + calendar.map(calendarRow).join(''));
  outputs.set('daily_harmonized.csv', DAILY_HEADER + '\n' + harmonized.map(dailyRow).join(''));
  outputs.set(
    'outages_detected.csv',
    'satellite,acq_date,other_satellite,other_cells\n' + detected.map((x) => `${x.satellite},${x.acqDate},${x.otherSatellite},${x.otherCells}\n`).join(''),
  );
  outputs.set('validation.json', JSON.stringify(validation, r6, 2) + '\n');
  if (sensitivity) outputs.set('grid_sensitivity.json', JSON.stringify({ productionGridDeg: 0.05, ...sensitivity }, r6, 2) + '\n');

  const byteSize = (c: string | Buffer) => (typeof c === 'string' ? Buffer.byteLength(c) : c.length);
  for (const [p, c] of outputs) if (byteSize(c) > 50 * 1024 * 1024) log(`WARNING: ${p} is over 50 MB — split by half-year or use Git LFS`);

  const inputsList = used.map((f) => ({ path: f.rel, sha256: f.sha256!, rows: f.stats.rows, parsed: f.stats.parsed, rejected: f.stats.rejected }));
  const satRanges: Record<string, { from: string; to: string; days: number } | null> = {};
  for (const sat of ALL_SATELLITES) {
    const ds = [...(availability.get(sat) ?? [])].sort();
    satRanges[sat] = ds.length ? { from: ds[0], to: ds[ds.length - 1], days: ds.length } : null;
  }
  const outputMeta: Record<string, { sha256: string; rows: number }> = {};
  for (const [p, c] of [...outputs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const text = p.endsWith('.gz') ? null : c.toString();
    outputMeta[p] = {
      sha256: contentHashOfFile(p, typeof c === 'string' ? Buffer.from(c) : c),
      rows: text === null ? -1 : Math.max(0, text.split('\n').filter(Boolean).length - 1),
    };
  }
  const manifest = {
    harmonizer_version: HARMONIZER_VERSION,
    region: o.region,
    range: { from: o.from, to: o.to },
    calibration_years: o.calibrationYears,
    alpha_shrinkage_k: o.k,
    static_mask_min_detections: o.minStaticDetections,
    auto_outages: o.autoOutages,
    grid_sensitivity: o.gridSensitivity.length ? o.gridSensitivity : null,
    inputs: {
      count: inputsList.length,
      digest: sha256(inputsList.map((i) => `${i.path}\t${i.sha256}`).join('\n')),
      skipped: inputs.filter((f) => f.skip).map((f) => ({ path: f.rel, reason: f.skip })),
      files: inputsList.length <= 200 ? inputsList : undefined,
    },
    counts: {
      nrt_rows_skipped: nrtRowsSkipped,
      rows_outside_region_or_range: outsideRows,
      filter: filterStats,
      duplicates_removed: duplicates,
      detections: nDetections,
      cell_days: nCellDays,
      static_mask_cells: mask.length,
      outage_days_detected: detected.length,
    },
    availability: satRanges,
    acceptance: validation.acceptance,
    outputs: outputMeta,
  };
  const manifestText = JSON.stringify(manifest, r6, 2) + '\n';

  if (o.dryRun) {
    log(`dry run: ${outputs.size + 1} files not written`);
  } else {
    // Remove stale generated year files from a previous, wider run (only inside our own subdirs).
    // A grid_sensitivity.json from an earlier run would no longer match this run's inputs.
    if (!sensitivity && existsSync(join(o.outDir, 'grid_sensitivity.json'))) unlinkSync(join(o.outDir, 'grid_sensitivity.json'));
    for (const sub of ['cell_days', 'detections']) {
      const dir = join(o.outDir, sub);
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        const relp = `${sub}/${n}`;
        if (/^\d{4}\.csv(\.gz)?$/.test(n) && !outputs.has(relp) && statSync(join(dir, n)).isFile()) unlinkSync(join(dir, n));
      }
    }
    for (const [p, c] of outputs) writeAtomic(join(o.outDir, p), c);
    writeAtomic(join(o.outDir, 'manifest.json'), manifestText);
    log(`wrote ${outputs.size + 1} files to ${o.outDir}`);
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { manifest, alpha, model, effective, calendar, validation, sensitivity, harmonized, detected, outDir: o.outDir };
}

export function verifyOutputs(outDir: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const mpath = join(outDir, 'manifest.json');
  if (!existsSync(mpath)) return { ok: false, problems: [`missing ${mpath}`] };
  const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
  for (const [p, meta] of Object.entries<{ sha256: string }>(manifest.outputs)) {
    const fp = join(outDir, p);
    if (!existsSync(fp)) {
      problems.push(`missing ${p}`);
      continue;
    }
    const h = contentHashOfFile(p, readFileSync(fp));
    if (h !== meta.sha256) problems.push(`hash mismatch ${p}`);
  }
  for (const sub of ['cell_days', 'detections']) {
    const dir = join(outDir, sub);
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) if (!(`${sub}/${n}` in manifest.outputs)) problems.push(`unexpected file ${sub}/${n}`);
  }
  return { ok: problems.length === 0, problems };
}

