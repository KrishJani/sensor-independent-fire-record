// Activity-dependent calibration: Poisson GLM with log link (docs/HARMONIZATION.md §3).
//
// Unit = one (year, calendar month) of overlap days for a MODIS configuration c:
//     n = overlap days,  M = Σ M_c(d),  V = Σ V(d)
//     E[V] = n · exp(a_m + β · log(M / n))
//
// β = 1 gives exactly the constant ratio α_m = ΣV/ΣM (the earlier model). β < 1 means VIIRS adds
// relatively fewer cells in busy months: inside large fire complexes both sensors already flag
// nearly every 0.05° cell, while VIIRS-only small fires do not scale with large-fire activity.
//
// Applied per month as α_eff(y, m) = exp(a_m) · r^(β − 1), with r = the region's MODIS cell-days
// per day in that month. Each day in the month gets the same α_eff, so days add up to the month
// and any AOI inside the region is the sum of its parts (additive).

import { calibrationSamples, mulberry32, quantileSorted, ALPHA_CLAMP, type CalibrationSample } from './calibrate.ts';
import { dateRange, monthOf, yearOf } from './dates.ts';
import { isAvailable, modisConfigFor, modisCount, pickViirsReference } from './harmonize.ts';
import { MODIS_CONFIGS, type Alpha, type AlphaTable, type DailyCounts, type ModisConfig, type SourceAvailability } from './types.ts';

export interface MonthPair {
  year: number;
  month: number;
  n: number; // overlap days
  m: number; // Σ MODIS cells
  v: number; // Σ VIIRS cells
}

export function monthPairs(samples: CalibrationSample[]): MonthPair[] {
  const map = new Map<string, MonthPair>();
  for (const s of samples) {
    const k = `${s.year}-${s.month}`;
    let p = map.get(k);
    if (!p) map.set(k, (p = { year: s.year, month: s.month, n: 0, m: 0, v: 0 }));
    p.n++;
    p.m += s.m;
    p.v += s.v;
  }
  return [...map.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

export interface GlmFit {
  a: number[]; // index 0..11, log scale; NaN where the month has no usable pairs
  beta: number;
  deviance: number;
  pearson: number;
  nUsed: number;
}

/** Poisson deviance contribution, safe at y = 0. */
const devTerm = (y: number, mu: number) => 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));

/**
 * Maximum-likelihood fit. Block coordinate ascent: the a_m have a closed form given β, then a
 * Newton step on β. Pairs with M = 0 carry no information about β and are skipped.
 */
export function fitAlphaGLM(pairs: MonthPair[], opts: { fixBeta?: number | null } = {}): GlmFit {
  const use = pairs.filter((p) => p.m > 0 && p.n > 0);
  const byMonth: MonthPair[][] = Array.from({ length: 12 }, () => []);
  for (const p of use) byMonth[p.month - 1].push(p);
  let beta = opts.fixBeta ?? 1;
  const a = Array(12).fill(NaN);
  for (let it = 0; it < 200; it++) {
    for (let i = 0; i < 12; i++) {
      const s = byMonth[i];
      if (!s.length) continue;
      const sv = s.reduce((x, p) => x + p.v, 0);
      const den = s.reduce((x, p) => x + p.n * Math.exp(beta * Math.log(p.m / p.n)), 0);
      a[i] = Math.log(Math.max(sv, 1e-9) / den);
    }
    if (opts.fixBeta != null) break;
    // Newton step on the PROFILE likelihood (a_m optimised out): centre x on its μ-weighted mean
    // within each month. This converges quadratically, unlike alternating a_m / β updates.
    const sw = Array(12).fill(0);
    const swx = Array(12).fill(0);
    const mus = use.map((p) => {
      const x = Math.log(p.m / p.n);
      const mu = p.n * Math.exp(a[p.month - 1] + beta * x);
      sw[p.month - 1] += mu;
      swx[p.month - 1] += mu * x;
      return { p, x, mu };
    });
    let g = 0;
    let h = 0;
    for (const { p, x, mu } of mus) {
      const xc = x - swx[p.month - 1] / sw[p.month - 1];
      g += (p.v - mu) * xc;
      h += mu * xc * xc;
    }
    if (h <= 0) break;
    const step = g / h;
    beta += step;
    if (Math.abs(step) < 1e-12) break;
  }
  let deviance = 0;
  let pearson = 0;
  for (const p of use) {
    const mu = p.n * Math.exp(a[p.month - 1] + beta * Math.log(p.m / p.n));
    deviance += devTerm(p.v, mu);
    pearson += (p.v - mu) ** 2 / mu;
  }
  return { a, beta, deviance, pearson, nUsed: use.length };
}

/** Complementary error function (Numerical Recipes erfcc, |rel err| < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export interface AlphaModelConfig {
  config: ModisConfig;
  /** 'glm' = β estimated; 'ratio' = β fixed at 1 because there was too little data (≡ ΣV/ΣM). */
  kind: 'glm' | 'ratio';
  reason: string | null;
  beta: number;
  betaCi: [number, number] | null;
  a: number[]; // 12, log scale, after shrinkage / fill-in
  rateMin: number[]; // 12, calibration range of MODIS cells/day (no extrapolation beyond it)
  rateMax: number[];
  typicalRate: number[]; // 12, median calibration rate
  alphaTypical: number[]; // 12, α at the typical rate
  alphaTypicalCi: ([number, number] | null)[];
  sumModis: number[];
  sumViirs: number[];
  nPairs: number[];
  nYears: number[];
  /** Quasi-likelihood test of β = 1 (constant ratio) against free β. */
  test: { deltaDeviance: number; dispersion: number; f: number; p: number } | null;
}

export type AlphaModel = Record<ModisConfig, AlphaModelConfig>;

export interface AlphaModelOptions {
  years: [number, number];
  k?: number; // shrinkage of a_m toward the all-month mean, in MODIS cell-days (default 50)
  clamp?: [number, number];
  minYearsForBeta?: number; // default 3
  bootstrap?: { reps: number; seed: number } | null;
  /** Fix β = 1 (the constant-ratio model), e.g. as the comparison baseline. */
  forceRatio?: boolean;
}

/** α at activity rate r (MODIS cells/day) for a calendar month, with no extrapolation. */
export function alphaAt(mc: AlphaModelConfig, month: number, rate: number, clamp: [number, number] = ALPHA_CLAMP): number {
  const i = month - 1;
  const r = Math.min(Math.max(rate > 0 ? rate : mc.typicalRate[i], mc.rateMin[i]), mc.rateMax[i]);
  const al = Math.exp(mc.a[i] + (mc.beta - 1) * Math.log(r));
  return al < clamp[0] ? clamp[0] : al > clamp[1] ? clamp[1] : al;
}

export function fitModelConfig(pairs: MonthPair[], config: ModisConfig, o: AlphaModelOptions, fallbackA: number[] | null = null): AlphaModelConfig {
  const k = o.k ?? 50;
  const years = new Set(pairs.filter((p) => p.m > 0).map((p) => p.year));
  const enough = !o.forceRatio && years.size >= (o.minYearsForBeta ?? 3);
  const reason = o.forceRatio
    ? 'β fixed at 1 (constant-ratio baseline)'
    : enough ? null : `only ${years.size} calibration year(s) with MODIS activity; β fixed at 1 (constant ratio)`;
  const fit = fitAlphaGLM(pairs, { fixBeta: enough ? null : 1 });
  const fit1 = enough ? fitAlphaGLM(pairs, { fixBeta: 1 }) : null;

  const byMonth: MonthPair[][] = Array.from({ length: 12 }, () => []);
  for (const p of pairs) byMonth[p.month - 1].push(p);
  const sumModis = byMonth.map((s) => s.reduce((x, p) => x + p.m, 0));
  const sumViirs = byMonth.map((s) => s.reduce((x, p) => x + p.v, 0));
  const rates = byMonth.map((s) => s.filter((p) => p.m > 0).map((p) => p.m / p.n).sort((x, y) => x - y));
  const allRates = rates.flat().sort((x, y) => x - y);
  const gMin = allRates[0] ?? 1;
  const gMax = allRates[allRates.length - 1] ?? 1;
  const rateMin = rates.map((r) => r[0] ?? gMin);
  const rateMax = rates.map((r) => r[r.length - 1] ?? gMax);
  const typicalRate = rates.map((r) => (r.length ? quantileSorted(r, 0.5) : quantileSorted(allRates.length ? allRates : [1], 0.5)));

  // Shrink a_m toward the ΣM-weighted mean of the months (quiet months borrow strength); fill empty months.
  const finite = fit.a.map((x, i) => ({ x, w: sumModis[i] })).filter((e) => Number.isFinite(e.x) && e.w > 0);
  const totW = finite.reduce((s, e) => s + e.w, 0);
  const aBar = totW > 0 ? finite.reduce((s, e) => s + e.w * e.x, 0) / totW : fallbackA ? fallbackA.reduce((s, x) => s + x, 0) / 12 : 0;
  const a = fit.a.map((x, i) => {
    if (!Number.isFinite(x)) return fallbackA ? fallbackA[i] : aBar;
    const w = sumModis[i] / (sumModis[i] + k);
    return w * x + (1 - w) * aBar;
  });

  let test: AlphaModelConfig['test'] = null;
  if (fit1) {
    const p = 13; // 12 a_m + β
    const dispersion = Math.max(1, fit.pearson / Math.max(1, fit.nUsed - p));
    const deltaDeviance = fit1.deviance - fit.deviance;
    const f = deltaDeviance / dispersion;
    test = { deltaDeviance, dispersion, f, p: erfc(Math.sqrt(Math.max(0, f) / 2)) }; // χ²₁ tail
  }

  const mc: AlphaModelConfig = {
    config,
    kind: enough ? 'glm' : 'ratio',
    reason,
    beta: fit.beta,
    betaCi: null,
    a,
    rateMin,
    rateMax,
    typicalRate,
    alphaTypical: [],
    alphaTypicalCi: Array(12).fill(null),
    sumModis,
    sumViirs,
    nPairs: byMonth.map((s) => s.filter((p) => p.m > 0).length),
    nYears: byMonth.map((s) => new Set(s.filter((p) => p.m > 0).map((p) => p.year)).size),
    test,
  };
  mc.alphaTypical = typicalRate.map((r, i) => alphaAt(mc, i + 1, r, o.clamp));

  // Year-block bootstrap for β and α at the typical rate.
  if (o.bootstrap && o.bootstrap.reps > 0 && enough) {
    const ys = [...years].sort((x, y) => x - y);
    const byYear = new Map<number, MonthPair[]>();
    for (const p of pairs) (byYear.get(p.year) ?? byYear.set(p.year, []).get(p.year)!).push(p);
    const rnd = mulberry32(o.bootstrap.seed);
    const betas: number[] = [];
    const al: number[][] = Array.from({ length: 12 }, () => []);
    for (let r = 0; r < o.bootstrap.reps; r++) {
      const sample: MonthPair[] = [];
      for (let j = 0; j < ys.length; j++) sample.push(...(byYear.get(ys[Math.floor(rnd() * ys.length)]) ?? []));
      const f = fitAlphaGLM(sample);
      betas.push(f.beta);
      for (let i = 0; i < 12; i++) if (Number.isFinite(f.a[i])) al[i].push(Math.exp(f.a[i] + (f.beta - 1) * Math.log(typicalRate[i])));
    }
    betas.sort((x, y) => x - y);
    mc.betaCi = [quantileSorted(betas, 0.05), quantileSorted(betas, 0.95)];
    mc.alphaTypicalCi = al.map((xs) => (xs.length >= 20 ? (xs.sort((x, y) => x - y), [quantileSorted(xs, 0.05), quantileSorted(xs, 0.95)] as [number, number]) : null));
  }
  return mc;
}

/** Fit the model for every MODIS configuration on the overlap years. */
export function fitAlphaModel(daily: DailyCounts[], av: SourceAvailability, o: AlphaModelOptions): AlphaModel {
  const model = {} as AlphaModel;
  for (const config of MODIS_CONFIGS) {
    const pairs = monthPairs(calibrationSamples(daily, av, { years: o.years, config }));
    const has = pairs.some((p) => p.m > 0);
    model[config] = fitModelConfig(pairs, config, o, !has && model.TA ? model.TA.a : null);
    if (!has && model.TA) {
      // No overlap data for this configuration at all: reuse the TA model, flagged.
      model[config] = { ...model.TA, config, kind: model.TA.kind, reason: `no overlap data for ${config}; using the TA model` };
    }
  }
  return model;
}

/** Region MODIS rate (cells/day) per (year, month, config), over days where the config's satellites flew. */
export function monthlyRates(daily: DailyCounts[], av: SourceAvailability, range: { from: string; to: string }) {
  const byDate = new Map(daily.map((d) => [d.acqDate, d]));
  const acc = new Map<string, { m: number; n: number }>();
  for (const d of dateRange(range.from, range.to)) {
    const t = isAvailable(av, 'TERRA', d);
    const q = isAvailable(av, 'AQUA', d);
    for (const config of MODIS_CONFIGS) {
      const ok = config === 'TA' ? t && q : config === 'T' ? t : q;
      if (!ok) continue;
      const k = `${yearOf(d)}-${monthOf(d)}-${config}`;
      const e = acc.get(k) ?? { m: 0, n: 0 };
      e.m += modisCount(byDate.get(d), config);
      e.n++;
      acc.set(k, e);
    }
  }
  return acc;
}

export type AlphaResolver = (date: string, config: ModisConfig) => number;

export interface EffectiveAlpha {
  year: number;
  month: number;
  config: ModisConfig;
  rate: number;
  alpha: number;
}

/** α_eff for every (year, month, config) in range, from the region's own MODIS activity. */
export function effectiveAlphas(model: AlphaModel, daily: DailyCounts[], av: SourceAvailability, range: { from: string; to: string }, clamp?: [number, number]): EffectiveAlpha[] {
  const out: EffectiveAlpha[] = [];
  for (const [k, e] of monthlyRates(daily, av, range)) {
    const [y, m, config] = k.split('-') as [string, string, ModisConfig];
    const rate = e.n ? e.m / e.n : 0;
    out.push({ year: +y, month: +m, config, rate, alpha: alphaAt(model[config], +m, rate, clamp) });
  }
  const order: Record<ModisConfig, number> = { TA: 0, T: 1, A: 2 };
  return out.sort((a, b) => a.year - b.year || a.month - b.month || order[a.config] - order[b.config]);
}

export function resolverFromEffective(eff: EffectiveAlpha[], model: AlphaModel): AlphaResolver {
  const m = new Map(eff.map((e) => [`${e.year}-${e.month}-${e.config}`, e.alpha]));
  return (date, config) => m.get(`${yearOf(date)}-${monthOf(date)}-${config}`) ?? alphaAt(model[config], monthOf(date), 0);
}

/** A fixed per-month table (β = 1 model) as a resolver. */
export function resolverFromTable(t: AlphaTable): AlphaResolver {
  return (date, config) => t[config][monthOf(date) - 1].alpha;
}

/** The model's α at the typical rate, in the legacy per-month Alpha shape (CSV, CLI, display). */
export function modelAsTable(model: AlphaModel): AlphaTable {
  const t = {} as AlphaTable;
  for (const c of MODIS_CONFIGS) {
    const mc = model[c];
    t[c] = mc.alphaTypical.map(
      (alpha, i): Alpha => ({
        month: i + 1,
        config: c,
        alpha,
        alphaLocal: mc.sumModis[i] > 0 ? mc.sumViirs[i] / mc.sumModis[i] : null,
        alphaPrior: Math.exp(mc.a.reduce((s, x) => s + x, 0) / 12),
        w: mc.sumModis[i] / (mc.sumModis[i] + 50),
        sumModis: mc.sumModis[i],
        sumViirs: mc.sumViirs[i],
        nDays: 0,
        nYears: mc.nYears[i],
        ciLow: mc.alphaTypicalCi[i]?.[0] ?? null,
        ciHigh: mc.alphaTypicalCi[i]?.[1] ?? null,
      }),
    );
  }
  return t;
}

/** Check that the VIIRS reference is defined on every calibration day (sanity helper for tests). */
export function referenceCoverage(av: SourceAvailability, years: [number, number]): number {
  let n = 0;
  let ok = 0;
  for (const d of dateRange(`${years[0]}-01-01`, `${years[1]}-12-31`)) {
    if (!modisConfigFor(d, av)) continue;
    n++;
    if (pickViirsReference(d, av)) ok++;
  }
  return n ? ok / n : 0;
}
