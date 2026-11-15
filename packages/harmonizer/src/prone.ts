// Fire-prone areas from the harmonized archival record (docs/HARMONIZATION.md §9).
// Pure statistics; the backfill `prone` command feeds it tile series built from the regions' outputs.
//
//  - Unit: 0.25° tiles (5 × 5 cells of the 0.05° grid).
//  - Density: mean annual harmonized cell-days per grid cell of the tile (VIIRS-equivalent).
//  - Prone = statistically significant hot spot: Getis-Ord Gi* over the study area (tile + 8 neighbours,
//    binary weights, self included), two-sided p, Benjamini–Hochberg FDR across all tiles.
//  - Attributes: recurrence, season, MODIS-only FRP p90, Theil–Sen trend with Mann–Kendall test.

import { quantileSorted } from './calibrate.ts';
import { GRID_COLS, cellRowCol } from './grid.ts';

export const TILE_CELLS = 5; // 5 × 0.05° = 0.25°
const TILE_COLS = Math.ceil(GRID_COLS / TILE_CELLS); // 1440

export function tileOfCell(cellId: number): number {
  const { row, col } = cellRowCol(cellId);
  return Math.floor(row / TILE_CELLS) * TILE_COLS + Math.floor(col / TILE_CELLS);
}
export function tileRowCol(tileId: number): { row: number; col: number } {
  return { row: Math.floor(tileId / TILE_COLS), col: tileId % TILE_COLS };
}
export function tileCenter(tileId: number): { lat: number; lon: number } {
  const { row, col } = tileRowCol(tileId);
  return { lat: -90 + (row + 0.5) * 0.25, lon: -180 + (col + 0.5) * 0.25 };
}
/** The 8 neighbours (no wrap at the antimeridian; edges simply have fewer). */
export function tileNeighbours(tileId: number): number[] {
  const { row, col } = tileRowCol(tileId);
  const out: number[] = [];
  for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
    if (!dr && !dc) continue;
    const r = row + dr, c = col + dc;
    if (r >= 0 && r < 720 && c >= 0 && c < TILE_COLS) out.push(r * TILE_COLS + c);
  }
  return out;
}

/** Standard normal two-sided p from z (Numerical Recipes erfc, |rel err| < 1.2e-7). */
export function twoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return Math.min(1, r);
}

/** Benjamini–Hochberg adjusted p-values (q-values), same order as input. */
export function benjaminiHochberg(p: number[]): number[] {
  const n = p.length;
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const q = Array(n).fill(1);
  let min = 1;
  for (let k = n - 1; k >= 0; k--) {
    const [v, i] = order[k];
    min = Math.min(min, (v * n) / (k + 1));
    q[i] = Math.min(1, min);
  }
  return q;
}

/**
 * Getis-Ord Gi* with binary weights over {self ∪ neighbours present in the study area}.
 * Gi* = (Σ_j w_ij x_j − x̄ Σ_j w_ij) / (S · √[(n Σ_j w_ij² − (Σ_j w_ij)²)/(n − 1)])
 */
export function getisOrdGiStar(values: Map<number, number>, neighbours: (id: number) => number[] = tileNeighbours): Map<number, number> {
  const ids = [...values.keys()];
  const n = ids.length;
  const xs = ids.map((i) => values.get(i)!);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const S = Math.sqrt(Math.max(0, xs.reduce((a, b) => a + b * b, 0) / n - mean * mean));
  const out = new Map<number, number>();
  for (const i of ids) {
    const js = [i, ...neighbours(i).filter((j) => values.has(j))];
    const w = js.length; // Σ w_ij = Σ w_ij² (binary)
    const sum = js.reduce((a, j) => a + values.get(j)!, 0);
    const den = S * Math.sqrt((n * w - w * w) / (n - 1));
    out.set(i, den > 0 ? (sum - mean * w) / den : 0);
  }
  return out;
}

/** Theil–Sen slope (median of pairwise slopes) and Mann–Kendall test with tie correction. */
export function trendTest(ys: number[]): { slope: number; z: number; p: number } {
  const n = ys.length;
  const slopes: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      slopes.push((ys[j] - ys[i]) / (j - i));
      s += Math.sign(ys[j] - ys[i]);
    }
  slopes.sort((a, b) => a - b);
  const ties = new Map<number, number>();
  for (const y of ys) ties.set(y, (ties.get(y) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of ties.values()) tieTerm += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  const z = varS > 0 ? (s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0) : 0;
  return { slope: slopes.length ? quantileSorted(slopes, 0.5) : 0, z, p: twoSidedP(z) };
}

/** Peak month and the smallest set of months holding ≥ 80% of activity (season). */
export function seasonOf(monthly: number[]): { peakMonth: number | null; months: number[] } {
  const tot = monthly.reduce((a, b) => a + b, 0);
  if (tot <= 0) return { peakMonth: null, months: [] };
  const order = monthly.map((v, i) => [v, i + 1] as const).sort((a, b) => b[0] - a[0]);
  const months: number[] = [];
  let acc = 0;
  for (const [v, m] of order) {
    if (acc >= 0.8 * tot) break;
    months.push(m);
    acc += v;
  }
  return { peakMonth: order[0][1], months: months.sort((a, b) => a - b) };
}

export type ProneClass = 'very_high' | 'high' | 'elevated' | 'low';

export interface TileInput {
  tileId: number;
  nCells: number; // grid cells of the tile inside the study area
  annual: number[]; // harmonized cell-days per year, aligned with `years`
  monthly: number[]; // 12, summed over all years
  modisFrp: number[]; // MODIS cell-day peak FRP values (single sensor across the record)
}

export interface TileResult {
  tileId: number;
  lat: number;
  lon: number;
  nCells: number;
  meanAnnual: number;
  density: number; // mean annual cell-days per grid cell
  densityPct: number; // percentile among study-area tiles
  yearsWithFire: number;
  recurrence: number;
  peakMonth: number | null;
  seasonMonths: number[];
  frpP90Modis: number | null;
  trendPerDecadePct: number | null; // Theil–Sen slope ×10 / median annual (when active ≥ 10 years)
  trendP: number | null;
  giZ: number;
  giQ: number;
  hotspot: 'hot99' | 'hot95' | 'hot90' | 'cold99' | 'cold95' | 'cold90' | 'none';
  proneClass: ProneClass;
  why: string;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function analyseProne(tiles: TileInput[], years: number[]): TileResult[] {
  const nY = years.length;
  const density = new Map<number, number>();
  for (const t of tiles) density.set(t.tileId, t.nCells > 0 ? t.annual.reduce((a, b) => a + b, 0) / nY / t.nCells : 0);
  const gi = getisOrdGiStar(density);
  const ids = tiles.map((t) => t.tileId);
  const q = benjaminiHochberg(ids.map((i) => twoSidedP(gi.get(i)!)));
  const qOf = new Map(ids.map((i, k) => [i, q[k]]));
  const sortedD = [...density.values()].sort((a, b) => a - b);
  // Percentile rank; tied values take the LOWEST rank, so "top 10%" never swells with ties.
  const pctOf = (d: number) => {
    let lo = 0, hi = sortedD.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sortedD[m] < d) lo = m + 1; else hi = m; }
    return (100 * lo) / Math.max(1, sortedD.length - 1);
  };

  return tiles.map((t) => {
    const { lat, lon } = tileCenter(t.tileId);
    const z = gi.get(t.tileId)!;
    const qv = qOf.get(t.tileId)!;
    const hot = z > 0;
    const hotspot: TileResult['hotspot'] = qv < 0.01 ? (hot ? 'hot99' : 'cold99') : qv < 0.05 ? (hot ? 'hot95' : 'cold95') : qv < 0.1 ? (hot ? 'hot90' : 'cold90') : 'none';
    const years = t.annual.filter((v) => v > 0).length;
    const recurrence = years / nY;
    const d = density.get(t.tileId)!;
    // Pre-specified classes (docs §9): significance first, then recurrence/density.
    const proneClass: ProneClass =
      hotspot === 'hot99' && recurrence >= 0.6 ? 'very_high' : hotspot === 'hot99' || hotspot === 'hot95' ? 'high' : hotspot === 'hot90' || (pctOf(d) >= 90 && d > 0) ? 'elevated' : 'low';
    const season = seasonOf(t.monthly);
    const frp = [...t.modisFrp].sort((a, b) => a - b);
    let trendPerDecadePct: number | null = null;
    let trendP: number | null = null;
    if (years >= 10) {
      const tr = trendTest(t.annual);
      const med = quantileSorted([...t.annual].sort((a, b) => a - b), 0.5);
      const base = med > 0 ? med : t.annual.reduce((a, b) => a + b, 0) / nY;
      trendPerDecadePct = base > 0 ? (tr.slope * 10 * 100) / base : null;
      trendP = tr.p;
    }
    const meanAnnual = t.annual.reduce((a, b) => a + b, 0) / nY;
    const parts: string[] = [];
    if (years > 0) parts.push(`burns in ${years} of ${nY} years`);
    if (season.peakMonth) parts.push(`peak ${MONTH[season.peakMonth - 1]}${season.months.length ? `, 80% of burning in ${season.months.length} month${season.months.length > 1 ? 's' : ''}` : ''}`);
    if (frp.length >= 20) parts.push(`MODIS FRP p90 ${Math.round(quantileSorted(frp, 0.9))} MW`);
    if (trendP !== null && trendP < 0.05 && trendPerDecadePct !== null) parts.push(`${trendPerDecadePct > 0 ? 'increasing' : 'decreasing'} ${Math.abs(Math.round(trendPerDecadePct))}%/decade (p ${trendP < 0.01 ? '< 0.01' : '< 0.05'})`);
    if (hotspot.startsWith('hot')) parts.push(`significant hot spot (${hotspot.slice(3)}% confidence, FDR-adjusted)`);
    return {
      tileId: t.tileId, lat, lon, nCells: t.nCells, meanAnnual, density: d, densityPct: pctOf(d),
      yearsWithFire: years, recurrence, peakMonth: season.peakMonth, seasonMonths: season.months,
      frpP90Modis: frp.length >= 20 ? quantileSorted(frp, 0.9) : null, trendPerDecadePct, trendP,
      giZ: z, giQ: qv, hotspot, proneClass, why: parts.length ? parts.join('; ') : `no burning detected in any of ${nY} years`,
    };
  });
}
