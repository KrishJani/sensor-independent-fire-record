// Validation of the calibration (docs/HARMONIZATION.md §5). Pure functions over overlap samples.

import { calibrationSamples, computeAlpha, quantileSorted, type CalibrationSample } from './calibrate.ts';
import { MODIS_CONFIGS, type Alpha, type AlphaTable, type DailyCounts, type ModisConfig, type SourceAvailability } from './types.ts';

export interface MonthlyPair {
  year: number;
  month: number;
  m: number;
  v: number;
  nDays: number;
}

export function monthlyPairs(samples: CalibrationSample[]): MonthlyPair[] {
  const map = new Map<string, MonthlyPair>();
  for (const s of samples) {
    const k = `${s.year}-${s.month}`;
    let p = map.get(k);
    if (!p) map.set(k, (p = { year: s.year, month: s.month, m: 0, v: 0, nDays: 0 }));
    p.m += s.m;
    p.v += s.v;
    p.nDays++;
  }
  return [...map.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

const median = (xs: number[]) => (xs.length ? quantileSorted([...xs].sort((a, b) => a - b), 0.5) : null);

export interface PredictionRow extends MonthlyPair {
  predicted: number;
  ape: number | null; // |pred − obs| / obs, null when obs < minMonthlyCells
}

function score(rows: PredictionRow[]) {
  const apes = rows.map((r) => r.ape).filter((x): x is number => x !== null);
  const sumP = rows.reduce((a, r) => a + r.predicted, 0);
  const sumO = rows.reduce((a, r) => a + r.v, 0);
  return {
    nMonthsScored: apes.length,
    mdape: median(apes),
    p90ape: apes.length ? quantileSorted([...apes].sort((a, b) => a - b), 0.9) : null,
    totalBias: sumO > 0 ? sumP / sumO - 1 : null,
  };
}

/** In-sample: α·M vs V per (year, month). Spec acceptance: MdAPE ≤ 15%. */
export function inSampleAgreement(samples: CalibrationSample[], alpha: Alpha[], minMonthlyCells = 20) {
  const rows: PredictionRow[] = monthlyPairs(samples).map((p) => {
    const predicted = alpha[p.month - 1].alpha * p.m;
    return { ...p, predicted, ape: p.v >= minMonthlyCells ? Math.abs(predicted - p.v) / p.v : null };
  });
  return { ...score(rows), rows };
}

/** Leave-one-year-out: refit α without year y, predict y. Honest out-of-sample error. */
export function leaveOneYearOut(samples: CalibrationSample[], opts: { k?: number; minMonthlyCells?: number; config?: ModisConfig } = {}) {
  const years = [...new Set(samples.map((s) => s.year))].sort((a, b) => a - b);
  const rows: PredictionRow[] = [];
  const minCells = opts.minMonthlyCells ?? 20;
  for (const y of years) {
    const train = samples.filter((s) => s.year !== y);
    if (!train.some((s) => s.m > 0)) continue;
    const alpha = computeAlpha(train, { k: opts.k, config: opts.config });
    for (const p of monthlyPairs(samples.filter((s) => s.year === y))) {
      const predicted = alpha[p.month - 1].alpha * p.m;
      rows.push({ ...p, predicted, ape: p.v >= minCells ? Math.abs(predicted - p.v) / p.v : null });
    }
  }
  return { ...score(rows), rows };
}

/**
 * Continuity across the sensor transition. For every overlap year, r(y) = Σ α·M / Σ V.
 * If the MODIS-scaled and native-VIIRS series are interchangeable, r ≈ 1 with no trend,
 * so switching from one to the other (at 2012, or at any VIIRS outage) creates no step.
 */
export function annualContinuity(samples: CalibrationSample[], alpha: Alpha[]) {
  const byYear = new Map<number, { pred: number; obs: number }>();
  for (const s of samples) {
    let y = byYear.get(s.year);
    if (!y) byYear.set(s.year, (y = { pred: 0, obs: 0 }));
    y.pred += alpha[s.month - 1].alpha * s.m;
    y.obs += s.v;
  }
  const rows = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, { pred, obs }]) => ({ year, modisScaled: pred, viirs: obs, ratio: obs > 0 ? pred / obs : null }));
  const logs = rows.filter((r) => r.ratio && r.ratio > 0).map((r) => ({ year: r.year, l: Math.log(r.ratio!) }));
  const medLog = median(logs.map((x) => x.l));
  let trendPerYear: number | null = null;
  if (logs.length >= 3) {
    const mx = logs.reduce((a, x) => a + x.year, 0) / logs.length;
    const my = logs.reduce((a, x) => a + x.l, 0) / logs.length;
    let sxy = 0;
    let sxx = 0;
    for (const x of logs) {
      sxy += (x.year - mx) * (x.l - my);
      sxx += (x.year - mx) ** 2;
    }
    trendPerYear = sxx > 0 ? Math.exp(sxy / sxx) - 1 : null;
  }
  const maxAbs = logs.length ? Math.max(...logs.map((x) => Math.abs(x.l))) : null;
  return {
    rows,
    medianStepPct: medLog === null ? null : Math.exp(medLog) - 1,
    worstYearPct: maxAbs === null ? null : Math.exp(maxAbs) - 1,
    trendPctPerYear: trendPerYear,
  };
}

/**
 * Is the MODIS→VIIRS relation proportional (V = αM)? Fit log V = a + β log M on monthly
 * totals. β ≈ 1 supports a multiplicative α; β < 1 means α overstates the biggest months
 * (both sensors saturate the 0.05° cells inside large fires).
 */
export function linearityDiagnostics(samples: CalibrationSample[], minMonthlyCells = 20) {
  const pts = monthlyPairs(samples).filter((p) => p.m >= minMonthlyCells && p.v >= minMonthlyCells);
  if (pts.length < 3) return { n: pts.length, beta: null, betaSe: null, intercept: null, r2: null };
  const xs = pts.map((p) => Math.log(p.m));
  const ys = pts.map((p) => Math.log(p.v));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  const beta = sxy / sxx;
  const intercept = my - beta * mx;
  const sse = syy - beta * sxy;
  const betaSe = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : null;
  return { n, beta, betaSe, intercept, r2: syy > 0 ? 1 - sse / syy : null };
}

export interface ValidationReport {
  calibrationYears: [number, number];
  configs: Record<
    ModisConfig,
    {
      nSampleDays: number;
      inSample: ReturnType<typeof score>;
      loyo: ReturnType<typeof score>;
      continuity: ReturnType<typeof annualContinuity>;
      linearity: ReturnType<typeof linearityDiagnostics>;
    }
  >;
  acceptance: {
    loyoMdapeWithin15pct: boolean | null;
    noStepAtTransition: boolean | null;
    proportional: boolean | null;
  };
}

export function validateCalibration(
  daily: DailyCounts[],
  av: SourceAvailability,
  alpha: AlphaTable,
  opts: { years: [number, number]; k?: number; minMonthlyCells?: number },
): ValidationReport {
  const configs = {} as ValidationReport['configs'];
  for (const config of MODIS_CONFIGS) {
    const samples = calibrationSamples(daily, av, { years: opts.years, config });
    const inS = inSampleAgreement(samples, alpha[config], opts.minMonthlyCells);
    const loyo = leaveOneYearOut(samples, { k: opts.k, minMonthlyCells: opts.minMonthlyCells, config });
    configs[config] = {
      nSampleDays: samples.length,
      inSample: { nMonthsScored: inS.nMonthsScored, mdape: inS.mdape, p90ape: inS.p90ape, totalBias: inS.totalBias },
      loyo: { nMonthsScored: loyo.nMonthsScored, mdape: loyo.mdape, p90ape: loyo.p90ape, totalBias: loyo.totalBias },
      continuity: annualContinuity(samples, alpha[config]),
      linearity: linearityDiagnostics(samples, opts.minMonthlyCells),
    };
  }
  const ta = configs.TA;
  const lin = ta.linearity;
  return {
    calibrationYears: opts.years,
    configs,
    acceptance: {
      loyoMdapeWithin15pct: ta.loyo.mdape === null ? null : ta.loyo.mdape <= 0.15,
      noStepAtTransition: ta.continuity.medianStepPct === null ? null : Math.abs(ta.continuity.medianStepPct) <= 0.05,
      proportional: lin.beta === null || lin.betaSe === null ? null : Math.abs(lin.beta - 1) <= Math.max(0.1, 2 * lin.betaSe),
    },
  };
}
