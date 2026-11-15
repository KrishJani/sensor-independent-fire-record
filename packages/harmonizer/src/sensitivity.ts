// Grid-size sensitivity analysis (docs/HARMONIZATION.md §7).
//
// Re-grids the SAME filtered detections at several cell sizes and re-runs calibration and
// validation with the SAME per-day source availability, so the only thing that varies is the
// cell size. Production always uses the fixed GRID_DEG grid; this is a diagnostic only.

import { calibrationSamples, computeAlphaTable } from './calibrate.ts';
import { pickViirsReference } from './harmonize.ts';
import { validateCalibration } from './validate.ts';
import { ALL_SATELLITES, type DailyCounts, type Detection, type Satellite, type SourceAvailability } from './types.ts';

export const DEFAULT_SENSITIVITY_GRIDS = [0.025, 0.05, 0.1];

/** Throws unless `deg` tiles the globe exactly (180/deg and 360/deg are integers). */
export function assertValidGridDeg(deg: number): void {
  const rows = 180 / deg;
  if (!(deg > 0) || Math.abs(rows - Math.round(rows)) > 1e-9) throw new Error(`grid size ${deg}° does not divide 180° evenly`);
}

/** Cell id on an arbitrary regular grid. At deg = GRID_DEG this equals toCellId(). */
export function gridCellIdAt(lat: number, lon: number, deg: number): number {
  const inv = 1 / deg; // 1/0.025 = 40, 1/0.05 = 20, 1/0.1 = 10: exact in binary, like grid.ts
  const rows = Math.round(180 / deg);
  const cols = Math.round(360 / deg);
  let r = Math.floor((lat + 90) * inv + 1e-9);
  let c = Math.floor((lon + 180) * inv + 1e-9);
  r = r < 0 ? 0 : r > rows - 1 ? rows - 1 : r;
  c = c < 0 ? 0 : c > cols - 1 ? cols - 1 : c;
  return r * cols + c;
}

export interface ResolutionDaily extends DailyCounts {
  /** MODIS (Terra ∪ Aqua) cells that the given VIIRS satellite also flagged the same day. */
  modisAlsoViirs: Record<Satellite, number>;
}

const zeros = (): Record<Satellite, number> => ({ TERRA: 0, AQUA: 0, SNPP: 0, NOAA20: 0, NOAA21: 0 });

/** Distinct active cells per day per satellite at grid size `deg` (FRP not computed). */
export function dailyCountsAtResolution(dets: Iterable<Detection>, deg: number): ResolutionDaily[] {
  assertValidGridDeg(deg);
  const byDate = new Map<string, Map<Satellite, Set<number>>>();
  for (const d of dets) {
    let sats = byDate.get(d.acqDate);
    if (!sats) byDate.set(d.acqDate, (sats = new Map()));
    let s = sats.get(d.satellite);
    if (!s) sats.set(d.satellite, (s = new Set()));
    s.add(gridCellIdAt(d.lat, d.lon, deg));
  }
  const out: ResolutionDaily[] = [];
  for (const [acqDate, sats] of byDate) {
    const cells = zeros();
    for (const sat of ALL_SATELLITES) cells[sat] = sats.get(sat)?.size ?? 0;
    const modis = new Set<number>([...(sats.get('TERRA') ?? []), ...(sats.get('AQUA') ?? [])]);
    const also = zeros();
    for (const v of ['SNPP', 'NOAA20', 'NOAA21'] as Satellite[]) {
      const vs = sats.get(v);
      if (vs) for (const c of modis) if (vs.has(c)) also[v]++;
    }
    out.push({ acqDate, cells, modisUnion: modis.size, peakFrpMw: zeros(), modisAlsoViirs: also });
  }
  return out.sort((a, b) => (a.acqDate < b.acqDate ? -1 : a.acqDate > b.acqDate ? 1 : 0));
}

export interface GridSensitivityRow {
  gridDeg: number;
  approxKm: number;
  alphaTA: number[]; // 12 months
  pooledAlphaTA: number | null; // ΣV/ΣM over all calibration days
  inSampleMdape: number | null;
  loyoMdape: number | null;
  stepPct: number | null;
  beta: number | null;
  betaSe: number | null;
  proportional: boolean | null;
  noStepAtTransition: boolean | null;
  /** Share of MODIS cells that the day's VIIRS reference also flagged (calibration days, TA). */
  coincidence: number | null;
  nCalibrationDays: number;
}

export interface GridSensitivityReport {
  calibrationYears: [number, number];
  rule: string;
  rows: GridSensitivityRow[];
  recommended: number | null;
  reason: string;
}

export const GRID_PICK_RULE =
  'lowest leave-one-year-out MdAPE (TA) among grid sizes whose proportionality and no-step checks do not fail';

/** Apply GRID_PICK_RULE. Pure, so it is unit-testable on its own. */
export function pickGridSize(rows: GridSensitivityRow[]): { recommended: number | null; reason: string } {
  const eligible = rows.filter((r) => r.proportional !== false && r.noStepAtTransition !== false && r.loyoMdape !== null);
  if (!eligible.length) {
    const anyLoyo = rows.some((r) => r.loyoMdape !== null);
    return {
      recommended: null,
      reason: anyLoyo
        ? 'no grid size passes the proportionality and no-step checks'
        : 'not enough overlap years for leave-one-year-out (need ≥ 2 calibration years)',
    };
  }
  const best = [...eligible].sort((a, b) => a.loyoMdape! - b.loyoMdape! || Math.abs(a.gridDeg - 0.05) - Math.abs(b.gridDeg - 0.05))[0];
  return { recommended: best.gridDeg, reason: `lowest LOYO MdAPE ${(best.loyoMdape! * 100).toFixed(1)}% among ${eligible.length} eligible size(s)` };
}

export function gridSensitivity(
  perGrid: Map<number, ResolutionDaily[]>,
  av: SourceAvailability,
  opts: { years: [number, number]; k?: number; minMonthlyCells?: number },
): GridSensitivityReport {
  const rows: GridSensitivityRow[] = [];
  for (const gridDeg of [...perGrid.keys()].sort((a, b) => a - b)) {
    const daily = perGrid.get(gridDeg)!;
    const alpha = computeAlphaTable(daily, av, { years: opts.years, k: opts.k, bootstrap: null });
    const v = validateCalibration(daily, av, alpha, { years: opts.years, k: opts.k, minMonthlyCells: opts.minMonthlyCells });
    const samples = calibrationSamples(daily, av, { years: opts.years, config: 'TA' });
    const byDate = new Map(daily.map((d) => [d.acqDate, d]));
    let sm = 0;
    let sv = 0;
    let both = 0;
    for (const s of samples) {
      sm += s.m;
      sv += s.v;
      const ref = pickViirsReference(s.acqDate, av);
      const dc = byDate.get(s.acqDate);
      if (ref && dc) both += dc.modisAlsoViirs[ref];
    }
    const ta = v.configs.TA;
    rows.push({
      gridDeg,
      approxKm: Math.round(gridDeg * 111.32 * 10) / 10,
      alphaTA: alpha.TA.map((a) => a.alpha),
      pooledAlphaTA: sm > 0 ? sv / sm : null,
      inSampleMdape: ta.inSample.mdape,
      loyoMdape: ta.loyo.mdape,
      stepPct: ta.continuity.medianStepPct,
      beta: ta.linearity.beta,
      betaSe: ta.linearity.betaSe,
      proportional: v.acceptance.proportional,
      noStepAtTransition: v.acceptance.noStepAtTransition,
      coincidence: sm > 0 ? both / sm : null,
      nCalibrationDays: samples.length,
    });
  }
  return { calibrationYears: opts.years, rule: GRID_PICK_RULE, rows, ...pickGridSize(rows) };
}
