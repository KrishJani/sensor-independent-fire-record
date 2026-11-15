// Prone-areas analysis for a region group (docs/HARMONIZATION.md §9).
// Tile series are built with the SAME per-day rule as the region calendars, from each region's outputs:
//   VIIRS day     → cells of the day's VIIRS reference satellite
//   MODIS_SCALED  → α_eff(day) × |cells of the day's MODIS configuration| (TA = Terra ∪ Aqua)
// so Σ tiles = the region's harmonized calendar (checked). Statistics: @repo/harmonizer analyseProne.
//
//   data/harmonized/<group>/prone/prone_tiles.csv   one row per 0.25° study-area tile
//   data/harmonized/<group>/prone/summary.json      class counts, checks, method

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRID_COLS,
  HARMONIZER_VERSION,
  TILE_CELLS,
  analyseProne,
  cellInRegion,
  fmt,
  tileOfCell,
  type Bbox,
  type TileInput,
} from '../../../packages/harmonizer/src/index.ts';
import { excludedBboxes, REPO_ROOT, type RegionsConfig } from './config.ts';
import { contentHashOfFile, writeAtomic } from './files.ts';

export async function runProne(cfg: RegionsConfig, group: string, years: [number, number], log: (m: string) => void) {
  const regions = cfg.regions.filter((r) => r.group === group);
  const Y = Array.from({ length: years[1] - years[0] + 1 }, (_, i) => years[0] + i);
  const tiles = new Map<number, TileInput & { regionCells: Map<string, number> }>();
  const tile = (id: number) => {
    let t = tiles.get(id);
    if (!t) tiles.set(id, (t = { tileId: id, nCells: 0, annual: Array(Y.length).fill(0), monthly: Array(12).fill(0), modisFrp: [], regionCells: new Map() }));
    return t;
  };
  const checks: Record<string, number> = {};

  for (const r of regions) {
    const ex: Bbox[] = excludedBboxes(cfg, r);
    // Study area: every grid cell whose center is in the region (cell-center rule).
    const [w, s, e, n] = r.bbox;
    const r0 = Math.floor((s + 90) * 20), r1 = Math.ceil((n + 90) * 20), c0 = Math.floor((w + 180) * 20), c1 = Math.ceil((e + 180) * 20);
    for (let row = r0; row < Math.min(3600, r1); row++)
      for (let col = c0; col < Math.min(GRID_COLS, c1); col++) {
        const id = row * GRID_COLS + col;
        if (!cellInRegion(id, r.bbox, ex)) continue;
        const t = tile(tileOfCell(id));
        t.nCells++;
        t.regionCells.set(r.id, (t.regionCells.get(r.id) ?? 0) + 1);
      }
    // Day rules from the region's own daily series.
    const D = join(REPO_ROOT, 'data/harmonized', r.id);
    const dl = readFileSync(join(D, 'daily_harmonized.csv'), 'utf8').trim().split('\n');
    const h = dl[0].split(',');
    const ix = (k: string) => h.indexOf(k);
    const day = new Map<string, { basis: string; alpha: number; cfg: string; ref: string }>();
    let regionTotal = 0;
    // Exact rounding bound for the comparison: daily values are stored to 0.01 (±0.005/day) and α to
    // 4 decimals (±0.00005 per MODIS cell-day scaled with it).
    let tolerance = 1e-6;
    for (const l of dl.slice(1)) {
      const f = l.split(',');
      const y = +f[0].slice(0, 4);
      if (y < years[0] || y > years[1]) continue;
      day.set(f[0], { basis: f[ix('basis')], alpha: +f[ix('alpha')] || 0, cfg: f[ix('modis_config')], ref: f[ix('viirs_reference')] });
      regionTotal += +f[ix('harmonized_cell_days')];
      tolerance += 0.005 + (f[ix('basis')] === 'MODIS_SCALED' ? 0.00005 * (+f[ix('modis_cell_days')] || 0) : 0);
    }
    let tileTotal = 0;
    for (const y of Y) {
      let rows: string[];
      try { rows = readFileSync(join(D, 'cell_days', `${y}.csv`), 'utf8').trim().split('\n').slice(1); } catch { continue; }
      // Group by date: MODIS union per config needs all satellites of a day together.
      let cur = '';
      let modis = new Map<number, Set<string>>(); // cell → satellites (TERRA/AQUA)
      const flush = () => {
        if (!cur) return;
        const d = day.get(cur);
        if (d && d.basis === 'MODIS_SCALED') {
          for (const [cell, sats] of modis) {
            const hit = d.cfg === 'TA' ? sats.size > 0 : d.cfg === 'T' ? sats.has('TERRA') : sats.has('AQUA');
            if (!hit) continue;
            const t = tile(tileOfCell(cell));
            t.annual[y - years[0]] += d.alpha;
            t.monthly[+cur.slice(5, 7) - 1] += d.alpha;
            tileTotal += d.alpha;
          }
        }
        modis = new Map();
      };
      for (const l of rows) {
        const f = l.split(',');
        if (f[0] !== cur) { flush(); cur = f[0]; }
        const d = day.get(f[0]);
        if (!d) continue;
        const cell = +f[1], sat = f[4];
        if (sat === 'TERRA' || sat === 'AQUA') {
          (modis.get(cell) ?? modis.set(cell, new Set()).get(cell)!).add(sat);
          tile(tileOfCell(cell)).modisFrp.push(+f[9]); // MODIS only: one sensor across the whole record
        } else if (d.basis === 'VIIRS' && sat === d.ref) {
          const t = tile(tileOfCell(cell));
          t.annual[y - years[0]] += 1;
          t.monthly[+f[0].slice(5, 7) - 1] += 1;
          tileTotal += 1;
        }
      }
      flush();
    }
    checks[r.id] = Math.abs(tileTotal - regionTotal) / Math.max(1, regionTotal);
    log(`${r.id}: tiles sum to ${tileTotal.toFixed(1)} vs region calendar ${regionTotal.toFixed(1)} (diff ${(checks[r.id] * 100).toFixed(5)}%)`);
    if (Math.abs(tileTotal - regionTotal) > tolerance) throw new Error(`${r.id}: tile series do not add up to the region calendar (|diff| ${Math.abs(tileTotal - regionTotal).toFixed(2)} > rounding bound ${tolerance.toFixed(2)})`);
  }

  const study = [...tiles.values()].filter((t) => t.nCells > 0);
  const res = analyseProne(study, Y);
  const regionOf = (t: { regionCells: Map<string, number> }) => [...t.regionCells.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  let csv = 'tile_id,lat,lon,region_id,n_cells,mean_annual_cell_days,density,density_pct,years_with_fire,recurrence,peak_month,season_months,frp_p90_modis_mw,trend_pct_per_decade,trend_p,gi_z,gi_q,hotspot,prone_class,why\n';
  const byId = new Map(study.map((t) => [t.tileId, t]));
  for (const t of res.sort((a, b) => a.tileId - b.tileId))
    csv += [
      t.tileId, fmt(t.lat, 3), fmt(t.lon, 3), regionOf(byId.get(t.tileId)!), t.nCells, fmt(t.meanAnnual, 3), fmt(t.density, 5), fmt(t.densityPct, 2),
      t.yearsWithFire, fmt(t.recurrence, 3), t.peakMonth ?? '', t.seasonMonths.join('|'), fmt(t.frpP90Modis, 1), fmt(t.trendPerDecadePct, 1), fmt(t.trendP, 4),
      fmt(t.giZ, 3), fmt(t.giQ, 5), t.hotspot, t.proneClass, `"${t.why.replace(/"/g, "'")}"`,
    ].join(',') + '\n';
  const counts: Record<string, number> = {};
  for (const t of res) counts[t.proneClass] = (counts[t.proneClass] ?? 0) + 1;
  const outDir = join(REPO_ROOT, 'data/harmonized', group, 'prone');
  writeAtomic(join(outDir, 'prone_tiles.csv'), csv);
  const summary = {
    harmonizer_version: HARMONIZER_VERSION,
    group,
    years,
    tile_deg: TILE_CELLS * 0.05,
    method: 'Getis-Ord Gi* (tile + 8 neighbours, binary weights) on mean annual harmonized cell-days per grid cell; two-sided p; Benjamini–Hochberg FDR. very_high = hot spot q<0.01 and burns in ≥60% of years; high = q<0.05; elevated = q<0.10 or top-10% density; low otherwise.',
    tiles: res.length,
    classes: counts,
    tile_sum_checks: checks,
    outputs: { 'prone_tiles.csv': { sha256: contentHashOfFile('prone_tiles.csv', Buffer.from(csv)), rows: res.length } },
  };
  writeAtomic(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log(`${group}: ${res.length} tiles → ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return { summary, results: res };
}
