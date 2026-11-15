// Global archival MAP layer (not harmonized), built incrementally from the FIRMS
// "Country Yearly Summary" downloads — extracted folders OR the original *_all_countries.zip
// (read in place with `unzip -p`, no extraction needed).
//
// Work unit = one (year, product), e.g. 2018 viirs-snpp. Each unit is written once and skipped
// on later runs, so raw data can be deleted as soon as its units are done:
//
//   data/global/coarse_0.5/<year>_<product>.csv     year,month,bin_lat,bin_lon,satellite,sensor,cell_days,detections,peak_frp_mw,sum_frp_mw
//   data/global/static_counts/<year>_<product>.csv  cell_id,n   (type 1/2 detections, to build the NRT mask)
//   data/global/static_mask.csv                     cells with ≥ N static detections over all units
//   data/global/manifest.json                       rebuilt from everything on disk
//
// The harmonized calendar is NOT produced here (α is only valid inside calibrated regions).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ALL_SATELLITES,
  HARMONIZER_VERSION,
  cellCenter,
  createFirmsLineParser,
  fmt,
  keepDetection,
  newFilterStats,
  newParseStats,
  toCellId,
  type Satellite,
} from '../../../packages/harmonizer/src/index.ts';
import { contentHashOfFile, forEachLine, writeAtomic } from './files.ts';

export const GLOBAL_BIN_DEG = 0.5;
const BIN_INV = 1 / GLOBAL_BIN_DEG;
const BIN_COLS = 360 * BIN_INV;
const N_CELLS = 3600 * 7200;
const SAT_IDX: Record<Satellite, number> = { TERRA: 0, AQUA: 1, SNPP: 2, NOAA20: 3, NOAA21: 4 };
/** <product>_<YYYY>_<Country>.csv — product e.g. modis, viirs-snpp, viirs-jpss1, viirs-jpss2 */
const COUNTRY_FILE = /^([a-z0-9-]+)_(\d{4})_.+\.csv$/i;

export const GLOBAL_HEADER = 'year,month,bin_lat,bin_lon,satellite,sensor,cell_days,detections,peak_frp_mw,sum_frp_mw';

/** One country CSV, either a plain file or an entry inside a zip. */
interface Entry {
  name: string; // basename, e.g. viirs-snpp_2018_Chile.csv
  source: string; // folder or zip it came from (for the "safe to delete" report)
  file?: string;
  zip?: string;
  zipEntry?: string;
}

interface Unit {
  year: number;
  product: string;
  entries: Map<string, Entry>; // by basename: the same country file in a folder and a zip counts once
  busy: string | null; // reason to skip (still being written)
}

export interface GlobalOptions {
  rawDir: string;
  outDir: string;
  fromYear: number;
  toYear: number;
  minStaticDetections: number;
  force: boolean;
  /** Inputs modified more recently than this are treated as still downloading/extracting. */
  stillWritingMs?: number;
  log: (m: string) => void;
}

const unitName = (u: { year: number; product: string }) => `${u.year}_${u.product.toLowerCase()}`;

function hasUnzip(): boolean {
  return spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
}

/** Walk rawDir (following symlinks); collect country CSVs from folders and zips. */
function discover(rawDir: string, stillWritingMs: number, log: (m: string) => void): Map<string, Unit> {
  const units = new Map<string, Unit>();
  const now = Date.now();
  const add = (e: Entry, busy: string | null) => {
    const m = COUNTRY_FILE.exec(e.name);
    if (!m) return;
    const key = unitName({ year: +m[2], product: m[1] });
    let u = units.get(key);
    if (!u) units.set(key, (u = { year: +m[2], product: m[1].toLowerCase(), entries: new Map(), busy: null }));
    if (!u.entries.has(e.name)) u.entries.set(e.name, e);
    if (busy && !u.busy) u.busy = busy;
  };
  const walk = (dir: string, top: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      log(`skip ${dir}: ${(err as NodeJS.ErrnoException).code ?? err} (still being extracted?)`);
      return;
    }
    for (const n of names) {
      if (n.startsWith('.') || n.endsWith('.download')) continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, top || p);
      else if (/\.zip$/i.test(n)) {
        if (now - st.mtimeMs < stillWritingMs) {
          log(`skip ${n}: modified moments ago (still downloading?)`);
          continue;
        }
        const list = spawnSync('unzip', ['-Z1', p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (list.status !== 0) {
          log(`skip ${n}: not a readable zip (${list.stderr.trim().slice(0, 80)})`);
          continue;
        }
        for (const entry of list.stdout.split('\n').filter((x) => x.endsWith('.csv')))
          add({ name: basename(entry), source: p, zip: p, zipEntry: entry }, null);
      } else if (COUNTRY_FILE.test(n)) {
        add({ name: n, source: top || dir, file: p }, now - st.mtimeMs < stillWritingMs ? `${p} modified moments ago (still extracting?)` : null);
      }
    }
  };
  walk(rawDir, '');
  return units;
}

function streamLines(e: Entry, fn: (line: string) => void): Promise<void> {
  if (e.file) return forEachLine(e.file, fn).then(() => undefined);
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-p', e.zip!, e.zipEntry!], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b) => (err += b));
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', fn);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip -p ${e.zip} ${e.zipEntry} exited ${code}: ${err.trim()}`))));
  });
}

interface Agg {
  month: number;
  binRow: number;
  binCol: number;
  sat: Satellite;
  cellDays: number;
  detections: number;
  peak: number;
  sum: number;
}

async function processUnit(u: Unit, outDir: string, log: (m: string) => void) {
  const t0 = Date.now();
  const yearStart = Date.UTC(u.year, 0, 1);
  const seen = new Set<number>();
  const aggs = new Map<string, Agg>();
  const statics = new Map<number, number>();
  const sats = new Set<Satellite>();
  const parse = newParseStats();
  const filter = newFilterStats();
  let wrongYear = 0;
  for (const e of [...u.entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = createFirmsLineParser({ tier: 'SP', stats: parse });
    await streamLines(e, (line) => {
      const d = p.line(line);
      if (!d) return;
      if (+d.acqDate.slice(0, 4) !== u.year) return void wrongYear++;
      if (d.type === 1 || d.type === 2) {
        const c = toCellId(d.lat, d.lon);
        statics.set(c, (statics.get(c) ?? 0) + 1);
      }
      if (!keepDetection(d, { stats: filter })) return; // type 1/2/3 + confidence; SP has `type`
      sats.add(d.satellite);
      const binRow = Math.min(180 * BIN_INV - 1, Math.floor((d.lat + 90) * BIN_INV));
      const binCol = Math.min(BIN_COLS - 1, Math.floor((d.lon + 180) * BIN_INV));
      const month = +d.acqDate.slice(5, 7);
      const k = `${month}|${binRow * BIN_COLS + binCol}|${d.satellite}`;
      let a = aggs.get(k);
      if (!a) aggs.set(k, (a = { month, binRow, binCol, sat: d.satellite, cellDays: 0, detections: 0, peak: 0, sum: 0 }));
      a.detections++;
      a.sum += d.frpMw;
      if (d.frpMw > a.peak) a.peak = d.frpMw;
      const doy = Math.round((Date.parse(d.acqDate) - yearStart) / 86400000);
      const cdKey = (doy * 5 + SAT_IDX[d.satellite]) * N_CELLS + toCellId(d.lat, d.lon);
      if (!seen.has(cdKey)) {
        seen.add(cdKey);
        a.cellDays++;
      }
    });
  }
  const list = [...aggs.values()].sort((x, y) => x.month - y.month || x.binRow - y.binRow || x.binCol - y.binCol || SAT_IDX[x.sat] - SAT_IDX[y.sat]);
  let csv = GLOBAL_HEADER + '\n';
  for (const a of list) {
    const lat = -90 + (a.binRow + 0.5) * GLOBAL_BIN_DEG;
    const lon = -180 + (a.binCol + 0.5) * GLOBAL_BIN_DEG;
    csv += `${u.year},${a.month},${fmt(lat, 2)},${fmt(lon, 2)},${a.sat},${a.sat === 'TERRA' || a.sat === 'AQUA' ? 'MODIS' : 'VIIRS'},${a.cellDays},${a.detections},${fmt(a.peak, 1)},${fmt(a.sum, 1)}\n`;
  }
  let st = 'cell_id,n\n';
  for (const [c, n] of [...statics.entries()].sort((a, b) => a[0] - b[0])) st += `${c},${n}\n`;
  // Static counts first, coarse last: the coarse file's existence marks the unit as done.
  writeAtomic(join(outDir, 'static_counts', `${unitName(u)}.csv`), st);
  writeAtomic(join(outDir, `coarse_${GLOBAL_BIN_DEG}`, `${unitName(u)}.csv`), csv);
  const satList = ALL_SATELLITES.filter((s) => sats.has(s));
  writeAtomic(
    join(outDir, 'units', `${unitName(u)}.json`),
    JSON.stringify({ year: u.year, product: u.product, files: u.entries.size, sources: [...new Set([...u.entries.values()].map((e) => e.source))].sort(), satellites: satList, parse, filter, wrong_year_rows: wrongYear, bin_months: list.length }, null, 2) + '\n',
  );
  log(`${unitName(u)}: ${u.entries.size} files, ${parse.parsed.toLocaleString()} rows → ${list.length.toLocaleString()} bin-months [${satList.join(', ')}] (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

/** Rebuild static_mask.csv and manifest.json from every unit on disk. */
function finalize(outDir: string, minStatic: number) {
  const coarseDir = join(outDir, `coarse_${GLOBAL_BIN_DEG}`);
  const units = existsSync(coarseDir) ? readdirSync(coarseDir).filter((n) => n.endsWith('.csv')).sort() : [];
  const counts = new Map<number, number>();
  for (const u of units) {
    const p = join(outDir, 'static_counts', u);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf8').split('\n').slice(1)) {
      if (!l) continue;
      const [c, n] = l.split(',');
      counts.set(+c, (counts.get(+c) ?? 0) + +n);
    }
  }
  let mask = 'cell_id,grid_lat,grid_lon,n_static_detections\n';
  let nMask = 0;
  for (const [c, n] of [...counts.entries()].filter(([, n]) => n >= minStatic).sort((a, b) => a[0] - b[0])) {
    const { lat, lon } = cellCenter(c);
    mask += `${c},${fmt(lat, 4)},${fmt(lon, 4)},${n}\n`;
    nMask++;
  }
  writeAtomic(join(outDir, 'static_mask.csv'), mask);
  const outputs: Record<string, { sha256: string; rows: number }> = {};
  for (const u of units) {
    const buf = readFileSync(join(coarseDir, u));
    outputs[`coarse_${GLOBAL_BIN_DEG}/${u}`] = { sha256: contentHashOfFile(u, buf), rows: buf.toString().split('\n').filter(Boolean).length - 1 };
  }
  outputs['static_mask.csv'] = { sha256: contentHashOfFile('static_mask.csv', Buffer.from(mask)), rows: nMask };
  const manifest = {
    harmonizer_version: HARMONIZER_VERSION,
    kind: 'global_coarse_map (not harmonized)',
    bin_deg: GLOBAL_BIN_DEG,
    units: units.map((u) => u.replace(/\.csv$/, '')),
    static_mask_cells: nMask,
    outputs,
  };
  writeAtomic(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function runGlobal(o: GlobalOptions) {
  const t0 = Date.now();
  if (!hasUnzip()) o.log('warning: `unzip` not found — zip inputs will be skipped');
  const units = [...discover(o.rawDir, o.stillWritingMs ?? 10 * 60_000, o.log).values()]
    .filter((u) => u.year >= o.fromYear && u.year <= o.toYear)
    .sort((a, b) => a.year - b.year || (a.product < b.product ? -1 : 1));
  const done = (u: Unit) => existsSync(join(o.outDir, `coarse_${GLOBAL_BIN_DEG}`, `${unitName(u)}.csv`));
  let processed = 0;
  for (const u of units) {
    if (done(u) && !o.force) continue;
    if (u.busy) {
      o.log(`skip ${unitName(u)}: ${u.busy}`);
      continue;
    }
    await processUnit(u, o.outDir, o.log);
    processed++;
  }
  const manifest = finalize(o.outDir, o.minStaticDetections);

  // Which raw sources are fully represented in finished units → safe to delete.
  const bySource = new Map<string, Set<string>>();
  for (const u of units) for (const e of u.entries.values()) {
    let s = bySource.get(e.source);
    if (!s) bySource.set(e.source, (s = new Set()));
    s.add(unitName(u));
  }
  const safe: string[] = [];
  const pending: string[] = [];
  for (const [src, us] of [...bySource.entries()].sort()) {
    const unfinished = [...us].filter((n) => !existsSync(join(o.outDir, `coarse_${GLOBAL_BIN_DEG}`, `${n}.csv`)));
    (unfinished.length ? pending : safe).push(src);
  }
  o.log(`processed ${processed} unit(s) this run; ${manifest.units.length} total on disk; static mask ${manifest.static_mask_cells} cells; ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  return { manifest, processed, safeToDelete: safe, pending };
}
