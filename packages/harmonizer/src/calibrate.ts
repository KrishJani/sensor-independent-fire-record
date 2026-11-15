// Monthly multiplicative calibration factor α (harmonizer SPEC §7.2, docs/HARMONIZATION.md §3).
//
//   α_local[m] = Σ_d V(d) / Σ_d M(d)     over overlap days d in calendar month m
//   w          = ΣM / (ΣM + k)
//   α[m]       = w · α_local[m] + (1 − w) · α_prior[m],   clamped to [0.5, 10]
//
// ΣV/ΣM is the maximum-likelihood estimate of α under V(d) ~ Poisson(α·M(d)) and the
// weighted-least-squares slope through the origin with Var[V|M] ∝ M. Unlike a mean of
// daily ratios it is defined on zero-fire days and is not inflated by small denominators.

import { dateRange, yearOf, monthOf } from './dates.ts';
import { isAvailable, modisConfigFor, modisCount, pickViirsReference } from './harmonize.ts';
import {
  MODIS_CONFIGS,
  type Alpha,
  type AlphaTable,
  type DailyCounts,
  type ModisConfig,
  type SourceAvailability,
} from './types.ts';

export interface CalibrationSample {
  acqDate: string;
  year: number;
  month: number;
  m: number; // M(d) for the configuration
  v: number; // V(d) of the VIIRS reference
}

export const ALPHA_CLAMP: [number, number] = [0.5, 10];

function configSatellitesAvailable(config: ModisConfig, date: string, av: SourceAvailability): boolean {
  if (config === 'TA') return modisConfigFor(date, av) === 'TA';
  return isAvailable(av, config === 'T' ? 'TERRA' : 'AQUA', date);
}

/**
 * Overlap days usable for calibrating a MODIS configuration: the configuration's satellites
 * AND a VIIRS reference both have data. Zero-fire days are included (they carry no weight in
 * ΣV/ΣM but count towards nDays, and they matter for the cross-validation).
 */
export function calibrationSamples(
  daily: Iterable<DailyCounts>,
  av: SourceAvailability,
  opts: { years: [number, number]; config: ModisConfig },
): CalibrationSample[] {
  const byDate = new Map<string, DailyCounts>();
  for (const dc of daily) byDate.set(dc.acqDate, dc);
  const out: CalibrationSample[] = [];
  for (const d of dateRange(`${opts.years[0]}-01-01`, `${opts.years[1]}-12-31`)) {
    const ref = pickViirsReference(d, av);
    if (!ref || !configSatellitesAvailable(opts.config, d, av)) continue;
    const dc = byDate.get(d);
    out.push({
      acqDate: d,
      year: yearOf(d),
      month: monthOf(d),
      m: modisCount(dc, opts.config),
      v: dc ? dc.cells[ref] : 0,
    });
  }
  return out;
}

export interface ComputeAlphaOptions {
  config?: ModisConfig;
  /** Shrinkage strength in MODIS cell-days. Default 50. */
  k?: number;
  /** Per-month prior (e.g. regional α for an AOI). Default: this sample's pooled all-month ratio. */
  prior?: (number | null)[] | null;
  /** Used when there is no prior and no data at all. */
  fallback?: number | null;
  clamp?: [number, number];
  /** Year-block bootstrap for 90% intervals. */
  bootstrap?: { reps: number; seed: number } | null;
}

interface MonthSums {
  m: number[];
  v: number[];
  n: number[];
  years: Set<number>[];
}

function sumByMonth(samples: CalibrationSample[]): MonthSums {
  const s: MonthSums = { m: Array(12).fill(0), v: Array(12).fill(0), n: Array(12).fill(0), years: [] };
  for (let i = 0; i < 12; i++) s.years.push(new Set());
  for (const x of samples) {
    const i = x.month - 1;
    s.m[i] += x.m;
    s.v[i] += x.v;
    s.n[i]++;
    s.years[i].add(x.year);
  }
  return s;
}

const clampTo = (x: number, [lo, hi]: [number, number]) => (x < lo ? lo : x > hi ? hi : x);

function shrunkAlphas(sums: { m: number[]; v: number[] }, opts: ComputeAlphaOptions): { alpha: number[]; local: (number | null)[]; prior: number[]; w: number[] } {
  const k = opts.k ?? 50;
  const clamp = opts.clamp ?? ALPHA_CLAMP;
  const totM = sums.m.reduce((a, b) => a + b, 0);
  const totV = sums.v.reduce((a, b) => a + b, 0);
  const pooled = totM > 0 ? totV / totM : null;
  const alpha: number[] = [];
  const local: (number | null)[] = [];
  const prior: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < 12; i++) {
    const p = opts.prior?.[i] ?? pooled ?? opts.fallback ?? null;
    if (p === null) throw new Error(`computeAlpha: no data, no prior and no fallback for month ${i + 1}`);
    const M = sums.m[i];
    const loc = M > 0 ? sums.v[i] / M : null;
    const wi = M / (M + k);
    alpha.push(clampTo(loc === null ? p : wi * loc + (1 - wi) * p, clamp));
    local.push(loc);
    prior.push(p);
    w.push(wi);
  }
  return { alpha, local, prior, w };
}

/** Seeded PRNG (mulberry32) so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Type-7 (linear interpolation) quantile of a sorted array. */
export function quantileSorted(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const h = (xs.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}

export function computeAlpha(samples: CalibrationSample[], opts: ComputeAlphaOptions = {}): Alpha[] {
  const sums = sumByMonth(samples);
  const est = shrunkAlphas(sums, opts);

  let ciLow: (number | null)[] = Array(12).fill(null);
  let ciHigh: (number | null)[] = Array(12).fill(null);
  if (opts.bootstrap && opts.bootstrap.reps > 0) {
    // Resample whole years: days within a fire season are strongly autocorrelated, so
    // resampling days would understate uncertainty.
    const byYear = new Map<number, { m: number[]; v: number[] }>();
    for (const x of samples) {
      let y = byYear.get(x.year);
      if (!y) byYear.set(x.year, (y = { m: Array(12).fill(0), v: Array(12).fill(0) }));
      y.m[x.month - 1] += x.m;
      y.v[x.month - 1] += x.v;
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    if (years.length >= 2) {
      const rnd = mulberry32(opts.bootstrap.seed);
      const draws: number[][] = Array.from({ length: 12 }, () => []);
      for (let r = 0; r < opts.bootstrap.reps; r++) {
        const m = Array(12).fill(0);
        const v = Array(12).fill(0);
        for (let j = 0; j < years.length; j++) {
          const y = byYear.get(years[Math.floor(rnd() * years.length)])!;
          for (let i = 0; i < 12; i++) {
            m[i] += y.m[i];
            v[i] += y.v[i];
          }
        }
        // Keep the caller's prior fixed; re-derive the pooled prior only when there is none.
        const rep = shrunkAlphas({ m, v }, { ...opts, prior: opts.prior ?? est.prior });
        for (let i = 0; i < 12; i++) draws[i].push(rep.alpha[i]);
      }
      ciLow = draws.map((d) => quantileSorted(d.sort((a, b) => a - b), 0.05));
      ciHigh = draws.map((d) => quantileSorted(d, 0.95));
    }
  }

  const config = opts.config ?? 'TA';
  return est.alpha.map((alpha, i) => ({
    month: i + 1,
    config,
    alpha,
    alphaLocal: est.local[i],
    alphaPrior: est.prior[i],
    w: est.w[i],
    sumModis: sums.m[i],
    sumViirs: sums.v[i],
    nDays: sums.n[i],
    nYears: sums.years[i].size,
    ciLow: ciLow[i],
    ciHigh: ciHigh[i],
  }));
}

export interface AlphaTableOptions {
  years: [number, number];
  k?: number;
  clamp?: [number, number];
  bootstrap?: { reps: number; seed: number } | null;
  /** Per-config per-month prior (e.g. the regional table when calibrating an AOI). */
  priorTable?: AlphaTable | null;
}

/**
 * α for every MODIS configuration. TA is the main one; T and A cover Terra-only years
 * (2000-11 → 2002-07) and single-satellite outages. All three are fit on the same overlap
 * years, each using only that configuration's satellites for M(d).
 */
export function computeAlphaTable(daily: DailyCounts[], av: SourceAvailability, opts: AlphaTableOptions): AlphaTable {
  const table = {} as AlphaTable;
  for (const config of MODIS_CONFIGS) {
    const samples = calibrationSamples(daily, av, { years: opts.years, config });
    const prior = opts.priorTable ? opts.priorTable[config].map((a) => a.alpha) : null;
    // A configuration with no overlap data at all falls back to the TA factors.
    const fallbackPrior = !prior && !samples.some((s) => s.m > 0) && table.TA ? table.TA.map((a) => a.alpha) : null;
    table[config] = computeAlpha(samples, {
      config,
      k: opts.k,
      clamp: opts.clamp,
      prior: prior ?? fallbackPrior,
      bootstrap: opts.bootstrap,
    });
  }
  return table;
}

/** Wrap a single 12-month α array (e.g. loaded from alpha_monthly.csv) as a table. */
export function alphaTableFromRows(rows: Alpha[]): AlphaTable {
  const t = { TA: [], T: [], A: [] } as unknown as AlphaTable;
  for (const r of rows) t[r.config][r.month - 1] = r;
  for (const c of MODIS_CONFIGS) {
    for (let i = 0; i < 12; i++) if (!t[c][i]) throw new Error(`alpha table missing ${c} month ${i + 1}`);
  }
  return t;
}
