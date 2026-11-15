// Validation of the calibration (docs/HARMONIZATION.md §5). Pure functions over overlap samples.

import { calibrationSamples, computeAlpha, mulberry32, quantileSorted, type CalibrationSample } from './calibrate.ts';
import { alphaAt, fitModelConfig, monthPairs as modelMonthPairs, type AlphaModel, type AlphaModelConfig, type AlphaModelOptions, type MonthPair } from './model.ts';
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
 * Is the MODIS→VIIRS relation proportional (V = α_m · M) WITHIN each calendar month?
 *
 * Fit log V = a_m + β · log M on monthly totals with a separate intercept per calendar month
 * (month fixed effects = demean both sides by month). The intercepts absorb the seasonal α
 * we already model, so β tests only what a per-month constant α assumes: that within a month,
 * a year with k× more MODIS activity has k× more VIIRS activity. β ≈ 1 supports it; β < 1
 * means α overstates the biggest months (both sensors saturate the 0.05° cells in large fires).
 *
 * `pooledBeta` (one intercept for all months) is reported for reference only: it is biased
 * below 1 whenever quiet months have a higher α than busy months, even if every month is
 * perfectly proportional.
 */
export function linearityDiagnostics(samples: CalibrationSample[], minMonthlyCells = 20) {
  const pts = monthlyPairs(samples).filter((p) => p.m >= minMonthlyCells && p.v >= minMonthlyCells);
  const groups = new Map<number, MonthlyPair[]>();
  for (const p of pts) {
    let g = groups.get(p.month);
    if (!g) groups.set(p.month, (g = []));
    g.push(p);
  }
  // Within-month deviations; months with a single year carry no within-month information.
  const dx: number[] = [];
  const dy: number[] = [];
  let usedMonths = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    usedMonths++;
    const lx = g.map((p) => Math.log(p.m));
    const ly = g.map((p) => Math.log(p.v));
    const mx = lx.reduce((a, b) => a + b, 0) / g.length;
    const my = ly.reduce((a, b) => a + b, 0) / g.length;
    for (let i = 0; i < g.length; i++) {
      dx.push(lx[i] - mx);
      dy.push(ly[i] - my);
    }
  }
  const pooled = olsSlope(pts.map((p) => Math.log(p.m)), pts.map((p) => Math.log(p.v)), true, 2);
  const within = olsSlope(dx, dy, false, usedMonths + 1);
  return {
    n: dx.length,
    monthsUsed: usedMonths,
    beta: within.beta,
    betaSe: within.se,
    r2Within: within.r2,
    pooledBeta: pooled.beta,
    pooledBetaSe: pooled.se,
  };
}

/** Simple OLS slope with SE; `center` subtracts means first; `dfUsed` = parameters estimated. */
function olsSlope(xs: number[], ys: number[], center: boolean, dfUsed: number) {
  const n = xs.length;
  if (n - dfUsed < 1) return { beta: null, se: null, r2: null };
  const mx = center ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const my = center ? ys.reduce((a, b) => a + b, 0) / n : 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return { beta: null, se: null, r2: null };
  const beta = sxy / sxx;
  const sse = Math.max(0, syy - beta * sxy);
  return { beta, se: Math.sqrt(sse / (n - dfUsed) / sxx), r2: syy > 0 ? 1 - sse / syy : null };
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


// ---------------------------------------------------------------------------------------------
// Validation of the activity-dependent model (model.ts), with the constant-ratio model alongside.
// ---------------------------------------------------------------------------------------------

export interface ModelScore {
  nMonthsScored: number;
  mdape: number | null; // median |pred − obs| / obs over months with obs ≥ minMonthlyCells
  p90ape: number | null;
  totalBias: number | null; // Σpred/Σobs − 1
  topDecileBias: number | null; // the busiest 10 % of months
  bottomQuartileBias: number | null; // the quietest 25 % of months
  residualBeta: number | null; // within-month slope of log obs on log pred (1 = unbiased across activity)
  residualBetaSe: number | null;
}

interface PredRow { year: number; month: number; obs: number; pred: number }

function predict(mc: AlphaModelConfig, p: MonthPair): number {
  return p.m > 0 ? alphaAt(mc, p.month, p.m / p.n) * p.m : 0;
}

function scoreRows(rows: PredRow[], minCells: number): ModelScore {
  const sc = rows.filter((r) => r.obs >= minCells);
  const apes = sc.map((r) => Math.abs(r.pred - r.obs) / r.obs).sort((a, b) => a - b);
  const bias = (s: PredRow[]) => {
    const o = s.reduce((x, r) => x + r.obs, 0);
    return o > 0 ? s.reduce((x, r) => x + r.pred, 0) / o - 1 : null;
  };
  const byObs = [...sc].sort((a, b) => b.obs - a.obs);
  const top = byObs.slice(0, Math.max(1, Math.round(sc.length / 10)));
  const bottom = byObs.slice(-Math.max(1, Math.round(sc.length / 4)));
  const groups = new Map<number, PredRow[]>();
  for (const r of sc.filter((r) => r.pred > 0)) (groups.get(r.month) ?? groups.set(r.month, []).get(r.month)!).push(r);
  const dx: number[] = [];
  const dy: number[] = [];
  let used = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    used++;
    const mx = g.reduce((s, r) => s + Math.log(r.pred), 0) / g.length;
    const my = g.reduce((s, r) => s + Math.log(r.obs), 0) / g.length;
    for (const r of g) { dx.push(Math.log(r.pred) - mx); dy.push(Math.log(r.obs) - my); }
  }
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < dx.length; i++) { sxx += dx[i] ** 2; sxy += dx[i] * dy[i]; syy += dy[i] ** 2; }
  const rb = sxx > 0 ? sxy / sxx : null;
  const df = dx.length - used - 1;
  const se = rb !== null && df > 0 ? Math.sqrt(Math.max(0, syy - rb * sxy) / df / sxx) : null;
  return {
    nMonthsScored: sc.length,
    mdape: apes.length ? quantileSorted(apes, 0.5) : null,
    p90ape: apes.length ? quantileSorted(apes, 0.9) : null,
    totalBias: bias(rows),
    topDecileBias: sc.length ? bias(top) : null,
    bottomQuartileBias: sc.length ? bias(bottom) : null,
    residualBeta: rb,
    residualBetaSe: se,
  };
}

function loyoRows(pairs: MonthPair[], config: AlphaModelConfig['config'], o: AlphaModelOptions): PredRow[] {
  const years = [...new Set(pairs.map((p) => p.year))].sort((a, b) => a - b);
  const rows: PredRow[] = [];
  for (const y of years) {
    const train = pairs.filter((p) => p.year !== y);
    if (!train.some((p) => p.m > 0)) continue;
    const mc = fitModelConfig(train, config, { ...o, bootstrap: null });
    for (const p of pairs.filter((q) => q.year === y)) rows.push({ year: y, month: p.month, obs: p.v, pred: predict(mc, p) });
  }
  return rows;
}

function continuity(rows: PredRow[]) {
  const byYear = new Map<number, { pred: number; obs: number }>();
  for (const r of rows) { const e = byYear.get(r.year) ?? { pred: 0, obs: 0 }; e.pred += r.pred; e.obs += r.obs; byYear.set(r.year, e); }
  const yr = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, e]) => ({ year, modisScaled: e.pred, viirs: e.obs, ratio: e.obs > 0 ? e.pred / e.obs : null }));
  const logs = yr.filter((r) => r.ratio && r.ratio > 0).map((r) => Math.log(r.ratio!)).sort((a, b) => a - b);
  return {
    rows: yr,
    medianStepPct: logs.length ? Math.exp(quantileSorted(logs, 0.5)) - 1 : null,
    worstYearPct: logs.length ? Math.exp(Math.max(...logs.map(Math.abs))) - 1 : null,
  };
}

/** Multiplicative 90% ranges for MODIS-scaled values, from held-out (LOYO) errors. */
export interface Uncertainty {
  /** A month's true VIIRS-equivalent value lies within [lo, hi] × the harmonized value (90%). */
  monthly: [number, number];
  /** The same for a calendar year's total. */
  annual: [number, number];
  nMonths: number;
  nYears: number;
}

function uncertaintyFrom(rows: PredRow[], minCells: number): Uncertainty | null {
  const m = rows.filter((r) => r.obs >= minCells && r.pred > 0).map((r) => Math.log(r.obs / r.pred)).sort((a, b) => a - b);
  const byYear = new Map<number, [number, number]>();
  for (const r of rows) { const e = byYear.get(r.year) ?? [0, 0]; e[0] += r.obs; e[1] += r.pred; byYear.set(r.year, e); }
  const y = [...byYear.values()].filter(([o, p]) => o > 0 && p > 0).map(([o, p]) => Math.log(o / p)).sort((a, b) => a - b);
  if (m.length < 5 || y.length < 3) return null;
  const q = (xs: number[], p: number) => Math.exp(quantileSorted(xs, p));
  return { monthly: [q(m, 0.05), q(m, 0.95)], annual: [q(y, 0.05), q(y, 0.95)], nMonths: m.length, nYears: y.length };
}

// ---- samplers for the parametric bootstrap ----
function gammaSample(shape: number, rnd: () => number): number {
  if (shape < 1) return gammaSample(shape + 1, rnd) * Math.pow(rnd() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = rnd() || 1e-12, u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
function poissonSample(l: number, rnd: () => number): number {
  if (l <= 0) return 0;
  if (l < 30) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }
  const u = rnd() || 1e-12, v = rnd();
  return Math.max(0, Math.round(l + Math.sqrt(l) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}
/** Quasi-Poisson draw: mean μ, variance φμ (negative binomial as a gamma-Poisson mixture). */
function quasiPoisson(mu: number, phi: number, rnd: () => number): number {
  if (phi <= 1.0001) return poissonSample(mu, rnd);
  const k = mu / (phi - 1);
  return poissonSample((gammaSample(k, rnd) / k) * mu, rnd);
}

export interface NoiseTest {
  sims: number;
  dispersion: number;
  /** What a CORRECT model scores in this region, given its counts and overdispersion (5th / 50th / 95th percentile). */
  residualBeta: [number, number, number];
  mdape: [number, number, number];
  /** Percentile of the real score among the simulations. */
  realResidualBetaPct: number;
  realMdapePct: number;
}

/**
 * Parametric bootstrap: simulate overlap data FROM the fitted model (V quasi-Poisson with the
 * region's own overdispersion, M Poisson), refit and score each exactly like the real data.
 */
function noiseTest(pairs: MonthPair[], mc: AlphaModelConfig, config: AlphaModelConfig['config'], o: AlphaModelOptions, minCells: number, sims: number, seed: number, real: ModelScore): NoiseTest {
  const rnd = mulberry32(seed);
  const mus = pairs.map((p) => predict(mc, p));
  const used = pairs.map((p, i) => ({ p, mu: mus[i] })).filter((e) => e.mu > 0);
  const params = 25;
  const phi = Math.max(1, used.reduce((s, e) => s + (e.p.v - e.mu) ** 2 / e.mu, 0) / Math.max(1, used.length - params));
  const rbs: number[] = [];
  const mds: number[] = [];
  for (let k = 0; k < sims; k++) {
    const sp = pairs.map((p, i) => ({ ...p, m: poissonSample(p.m, rnd), v: quasiPoisson(mus[i], phi, rnd) }));
    const sc = scoreRows(loyoRows(sp, config, o), minCells);
    if (sc.residualBeta !== null) rbs.push(sc.residualBeta);
    if (sc.mdape !== null) mds.push(sc.mdape);
  }
  rbs.sort((a, b) => a - b);
  mds.sort((a, b) => a - b);
  const q3 = (xs: number[]): [number, number, number] => [quantileSorted(xs, 0.05), quantileSorted(xs, 0.5), quantileSorted(xs, 0.95)];
  const pct = (xs: number[], x: number | null) => (x === null || !xs.length ? NaN : (100 * xs.filter((v) => v <= x).length) / xs.length);
  return { sims, dispersion: phi, residualBeta: q3(rbs), mdape: q3(mds), realResidualBetaPct: pct(rbs, real.residualBeta), realMdapePct: pct(mds, real.mdape) };
}

export interface ModelValidationReport {
  calibrationYears: [number, number];
  configs: Record<string, {
    nPairs: number;
    model: { kind: string; beta: number; betaCi: [number, number] | null; test: AlphaModelConfig['test'] };
    inSample: ModelScore;
    loyo: ModelScore;
    /** The constant-ratio (β = 1) model scored the same way, for comparison. */
    loyoConstantRatio: ModelScore;
    continuity: ReturnType<typeof continuity>;
    uncertainty: Uncertainty | null;
    noise: NoiseTest | null;
  }>;
  acceptance: { loyoMdapeWithin15pct: boolean | null; noStepAtTransition: boolean | null; unbiasedAcrossActivity: boolean | null };
  /** How the bias check was judged: against simulated correct-model noise, or a fixed threshold. */
  biasCheck: 'noise-aware' | 'fixed-threshold';
  /** 'low' when too few months have enough fire to validate (scores are then indicative only). */
  confidence: { level: 'ok' | 'low'; reason: string | null; monthsScored: number; medianMonthlyViirs: number };
}

export function validateModel(
  daily: DailyCounts[],
  av: SourceAvailability,
  model: AlphaModel,
  opts: AlphaModelOptions & { minMonthlyCells?: number; noiseSims?: number; seed?: number },
): ModelValidationReport {
  const minCells = opts.minMonthlyCells ?? 20;
  const configs: ModelValidationReport['configs'] = {};
  let taPairs: MonthPair[] = [];
  for (const config of MODIS_CONFIGS) {
    const pairs = modelMonthPairs(calibrationSamples(daily, av, { years: opts.years, config }));
    if (config === 'TA') taPairs = pairs;
    const mc = model[config];
    const inRows = pairs.map((p) => ({ year: p.year, month: p.month, obs: p.v, pred: predict(mc, p) }));
    const lo = loyoRows(pairs, config, opts);
    const loyo = scoreRows(lo, minCells);
    // Noise-aware check for whichever model was selected (fitted or constant ratio).
    const sims = config === 'TA' ? opts.noiseSims ?? 0 : 0;
    configs[config] = {
      nPairs: pairs.length,
      model: { kind: mc.kind, beta: mc.beta, betaCi: mc.betaCi, test: mc.test },
      inSample: scoreRows(inRows, minCells),
      loyo,
      loyoConstantRatio: scoreRows(loyoRows(pairs, config, { ...opts, forceRatio: true }), minCells),
      continuity: continuity(inRows),
      uncertainty: uncertaintyFrom(lo, minCells),
      noise: sims > 0 ? noiseTest(pairs, mc, config, { ...opts, bootstrap: null }, minCells, sims, opts.seed ?? 20260101, loyo) : null,
    };
  }
  const ta = configs.TA;
  const rb = ta.loyo.residualBeta;
  const vs = taPairs.map((p) => p.v).sort((a, b) => a - b);
  const medV = vs.length ? quantileSorted(vs, 0.5) : 0;
  const scored = ta.loyo.nMonthsScored;
  const low = scored < 60 || medV < 50;
  const noise = ta.noise;
  return {
    calibrationYears: opts.years,
    configs,
    acceptance: {
      loyoMdapeWithin15pct: ta.loyo.mdape === null ? null : ta.loyo.mdape <= 0.15,
      noStepAtTransition: ta.continuity.medianStepPct === null ? null : Math.abs(ta.continuity.medianStepPct) <= 0.05,
      // Noise-aware: biased only if the real residual β is below what 95% of correct-model simulations give.
      unbiasedAcrossActivity: rb === null ? null : noise ? rb >= noise.residualBeta[0] : Math.abs(rb - 1) <= Math.max(0.1, 2 * (ta.loyo.residualBetaSe ?? 0)),
    },
    biasCheck: noise ? 'noise-aware' : 'fixed-threshold',
    confidence: {
      level: low ? 'low' : 'ok',
      reason: low ? `only ${scored} of ${ta.nPairs} overlap months have ≥ ${minCells} VIIRS cell-days (median ${medV} per month); scores are indicative` : null,
      monthsScored: scored,
      medianMonthlyViirs: medV,
    },
  };
}
