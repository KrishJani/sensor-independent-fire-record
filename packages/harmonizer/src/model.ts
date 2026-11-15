// Activity-dependent, two-component calibration (docs/HARMONIZATION.md §3).
//
// v1.2: E[V] = n·b_m + n·exp(a_m)·r^β,  r = M/n.  b_m is a VIIRS-only "background" of small/cool
// fires (cells per day) that MODIS cannot see and that does not scale with large-fire activity;
// the second term is the MODIS-visible part, scaled with an activity exponent β. b = 0 gives the
// v1.1 model; b = 0 and β = 1 gives the constant ratio ΣV/ΣM.
//
// (v1.1 notes follow.)
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
  b: number[]; // index 0..11, background VIIRS cells per day (0 for the one-component model)
  beta: number;
  deviance: number;
  pearson: number;
  nUsed: number;
}

/** Poisson deviance contribution, safe at y = 0. */
const devTerm = (y: number, mu: number) => 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));

/** One-component fit: log μ = log n + a_m + β log r (closed-form a_m, profile-Newton β). Weights w ≤ v allowed. */
function fitPowerPart(use: { p: MonthPair; w: number }[], fixBeta: number | null, start: { a: number[]; beta: number }) {
  const byMonth: { p: MonthPair; w: number }[][] = Array.from({ length: 12 }, () => []);
  for (const e of use) byMonth[e.p.month - 1].push(e);
  let beta = fixBeta ?? start.beta;
  const a = [...start.a];
  for (let it = 0; it < 200; it++) {
    for (let i = 0; i < 12; i++) {
      const s = byMonth[i];
      if (!s.length) continue;
      const sw = s.reduce((x, e) => x + e.w, 0);
      const den = s.reduce((x, e) => x + e.p.n * Math.exp(beta * Math.log(e.p.m / e.p.n)), 0);
      a[i] = Math.log(Math.max(sw, 1e-9) / den);
    }
    if (fixBeta != null) break;
    // Newton step on the PROFILE likelihood (a_m optimised out): centre x on its μ-weighted mean
    // within each month. Converges quadratically, unlike alternating a_m / β updates.
    const swm = Array(12).fill(0);
    const swx = Array(12).fill(0);
    const mus = use.map((e) => {
      const x = Math.log(e.p.m / e.p.n);
      const mu = e.p.n * Math.exp(a[e.p.month - 1] + beta * x);
      swm[e.p.month - 1] += mu;
      swx[e.p.month - 1] += mu * x;
      return { e, x, mu };
    });
    let g = 0;
    let h = 0;
    for (const { e, x, mu } of mus) {
      const xc = x - swx[e.p.month - 1] / swm[e.p.month - 1];
      g += (e.w - mu) * xc;
      h += mu * xc * xc;
    }
    if (h <= 0) break;
    const step = g / h;
    beta += step;
    if (Math.abs(step) < 1e-12) break;
  }
  return { a, beta };
}

/** Expected VIIRS for a pair under (a, b, β). */
export function pairMean(p: MonthPair, a: number[], b: number[], beta: number): number {
  const i = p.month - 1;
  return p.n * (b[i] ?? 0) + (p.m > 0 ? p.n * Math.exp(a[i] + beta * Math.log(p.m / p.n)) : 0);
}

/**
 * Maximum-likelihood fit. Without background: closed-form a_m + profile-Newton β (exact, fast).
 * With background: EM — split each month's V into background and MODIS-scaled parts by their
 * expected shares (E-step), then b_m = Σ background / Σ n and refit (a, β) on the scaled parts
 * (M-step). EM increases the Poisson likelihood monotonically.
 */
export function fitAlphaGLM(pairs: MonthPair[], opts: { fixBeta?: number | null; background?: boolean } = {}): GlmFit {
  const all = pairs.filter((p) => p.n > 0);
  const use = all.filter((p) => p.m > 0);
  const fixBeta = opts.fixBeta ?? null;
  let { a, beta } = fitPowerPart(use.map((p) => ({ p, w: p.v })), fixBeta, { a: Array(12).fill(0), beta: fixBeta ?? 1 });
  let b = Array(12).fill(0);
  if (opts.background) {
    // Start the background at a quarter of the quietest observed rate per month.
    b = Array.from({ length: 12 }, (_, i) => {
      const s = all.filter((p) => p.month === i + 1);
      return s.length ? (0.25 * Math.min(...s.map((p) => p.v / p.n))) + 1e-6 : 0;
    });
    let prevLL = -Infinity;
    for (let it = 0; it < 300; it++) {
      const bgSum = Array(12).fill(0);
      const nSum = Array(12).fill(0);
      const fire: { p: MonthPair; w: number }[] = [];
      let ll = 0;
      for (const p of all) {
        const i = p.month - 1;
        const lb = p.n * b[i];
        const lf = p.m > 0 ? p.n * Math.exp(a[i] + beta * Math.log(p.m / p.n)) : 0;
        const tot = lb + lf;
        if (tot > 0) ll += p.v * Math.log(tot) - tot;
        bgSum[i] += tot > 0 ? (p.v * lb) / tot : p.v;
        nSum[i] += p.n;
        if (p.m > 0) fire.push({ p, w: tot > 0 ? (p.v * lf) / tot : 0 });
      }
      for (let i = 0; i < 12; i++) b[i] = nSum[i] > 0 ? bgSum[i] / nSum[i] : 0;
      ({ a, beta } = fitPowerPart(fire, fixBeta, { a, beta }));
      if (Math.abs(ll - prevLL) < 1e-9 * Math.max(1, Math.abs(ll))) break;
      prevLL = ll;
    }
  }
  if (opts.background) ({ a, b, beta } = newtonRefine(all, a, b, beta, fixBeta));
  if (opts.background) {
    // Boundary check: EM approaches b = 0 only slowly, so also evaluate the exact b = 0 fit and
    // keep whichever has the higher Poisson log-likelihood (over all pairs, incl. M = 0 months).
    const one = fitPowerPart(use.map((p) => ({ p, w: p.v })), fixBeta, { a: Array(12).fill(0), beta: fixBeta ?? 1 });
    const zero = Array(12).fill(0);
    const loglik = (aa: number[], bb: number[], be: number) =>
      all.reduce((s, p) => {
        const mu = pairMean(p, aa, bb, be);
        return s + (mu > 0 ? p.v * Math.log(mu) - mu : p.v > 0 ? -1e12 : 0);
      }, 0);
    if (loglik(one.a, zero, one.beta) >= loglik(a, b, beta)) {
      a = one.a;
      beta = one.beta;
      b = zero;
    }
  }
  for (let i = 0; i < 12; i++) if (!use.some((p) => p.month === i + 1)) a[i] = NaN;
  let deviance = 0;
  let pearson = 0;
  for (const p of use) {
    const mu = pairMean(p, a, b, beta);
    deviance += devTerm(p.v, mu);
    pearson += (p.v - mu) ** 2 / mu;
  }
  return { a, b, beta, deviance, pearson, nUsed: use.length };
}

/** Solve A x = y (Gaussian elimination with partial pivoting); A is n×n. */
function solve(A: number[][], y: number[]): number[] | null {
  const n = y.length;
  const M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Newton refinement of the two-component likelihood on θ = (a_m, log b_m, β), with step-halving
 * so the log-likelihood never decreases. Started from EM, it converges quadratically to the MLE.
 * Months with a negligible background (b < 1e-8·mean) keep b fixed (that edge is the boundary check's job).
 */
function newtonRefine(all: MonthPair[], a0: number[], b0: number[], beta0: number, fixBeta: number | null) {
  const months = [...new Set(all.map((p) => p.month))].sort((x, y) => x - y);
  const hasM = new Set(all.filter((p) => p.m > 0).map((p) => p.month));
  const bMean = b0.reduce((x, y) => x + y, 0) / 12;
  const idx: { kind: 'a' | 'b' | 'beta'; i: number }[] = [];
  for (const m of months) if (hasM.has(m)) idx.push({ kind: 'a', i: m - 1 });
  for (const m of months) if (b0[m - 1] > 1e-8 * Math.max(bMean, 1e-12)) idx.push({ kind: 'b', i: m - 1 });
  if (fixBeta == null) idx.push({ kind: 'beta', i: -1 });
  const P = idx.length;
  let a = [...a0], lb = b0.map((x) => (x > 0 ? Math.log(x) : -Infinity)), beta = beta0;
  const pos = new Map(idx.map((e, k) => [`${e.kind}${e.i}`, k]));
  const ll = (aa: number[], lbb: number[], be: number) => {
    let s = 0;
    for (const p of all) {
      const B = Number.isFinite(lbb[p.month - 1]) ? p.n * Math.exp(lbb[p.month - 1]) : 0;
      const F = p.m > 0 ? p.n * Math.exp(aa[p.month - 1] + be * Math.log(p.m / p.n)) : 0;
      const mu = B + F;
      if (mu > 0) s += p.v * Math.log(mu) - mu;
      else if (p.v > 0) return -Infinity;
    }
    return s;
  };
  let cur = ll(a, lb, beta);
  for (let it = 0; it < 100; it++) {
    const g = Array(P).fill(0);
    const Hm = Array.from({ length: P }, () => Array(P).fill(0));
    for (const p of all) {
      const i = p.month - 1;
      const x = p.m > 0 ? Math.log(p.m / p.n) : 0;
      const B = Number.isFinite(lb[i]) ? p.n * Math.exp(lb[i]) : 0;
      const F = p.m > 0 ? p.n * Math.exp(a[i] + beta * x) : 0;
      const mu = B + F;
      if (mu <= 0) continue;
      const r = p.v / mu - 1;
      const w = p.v / (mu * mu);
      // first derivatives of μ, and second derivatives (diagonal blocks)
      const d: [number, number][] = [];
      const ka = pos.get(`a${i}`), kb = pos.get(`b${i}`), kbe = pos.get('beta-1');
      if (ka !== undefined) d.push([ka, F]);
      if (kb !== undefined) d.push([kb, B]);
      if (kbe !== undefined) d.push([kbe, F * x]);
      for (const [k, dk] of d) g[k] += r * dk;
      for (const [k1, d1] of d) for (const [k2, d2] of d) Hm[k1][k2] -= w * d1 * d2;
      if (ka !== undefined) Hm[ka][ka] += r * F;
      if (kb !== undefined) Hm[kb][kb] += r * B;
      if (kbe !== undefined) Hm[kbe][kbe] += r * F * x * x;
      if (ka !== undefined && kbe !== undefined) { Hm[ka][kbe] += r * F * x; Hm[kbe][ka] += r * F * x; }
    }
    // Newton direction on −H (positive definite near the optimum); damp if needed.
    let step: number[] | null = null;
    for (let lam = 0; lam < 1e6 && !step; lam = lam ? lam * 10 : 1e-8) {
      const A = Hm.map((row, k) => row.map((v, j) => -v + (k === j ? lam * Math.max(1, Math.abs(Hm[k][k])) : 0)));
      step = solve(A, g);
    }
    if (!step) break;
    let t = 1, improved = false;
    for (let h = 0; h < 40; h++, t /= 2) {
      const na = [...a], nlb = [...lb];
      let nb = beta;
      idx.forEach((e, k) => { if (e.kind === 'a') na[e.i] += t * step![k]; else if (e.kind === 'b') nlb[e.i] += t * step![k]; else nb += t * step![k]; });
      const v = ll(na, nlb, nb);
      if (v >= cur) { a = na; lb = nlb; beta = nb; improved = v - cur > 1e-12 * Math.max(1, Math.abs(cur)); cur = v; break; }
    }
    if (!improved) break;
  }
  return { a, b: lb.map((x) => (Number.isFinite(x) ? Math.exp(x) : 0)), beta };
}

/** Regularised upper incomplete gamma Q(s, x) (Numerical Recipes gammq), for χ² tail probabilities. */
function gammaQ(s: number, x: number): number {
  if (x <= 0) return 1;
  const lg = (z: number) => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = z, t = z + 5.5;
    t -= (z + 0.5) * Math.log(t);
    let ser = 1.000000000190015;
    for (const k of c) ser += k / ++y;
    return -t + Math.log((2.5066282746310005 * ser) / z);
  };
  if (x < s + 1) {
    let sum = 1 / s, del = sum, ap = s;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-x + s * Math.log(x) - lg(s));
  }
  let bb = x + 1 - s, c = 1 / 1e-300, d = 1 / bb, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    bb += 2;
    d = an * d + bb; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = bb + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + s * Math.log(x) - lg(s)) * h;
}
/** P(χ²_df > x). */
export const chi2Sf = (x: number, df: number) => gammaQ(df / 2, x / 2);

export interface AlphaModelConfig {
  config: ModisConfig;
  /** 'glm' = estimated model (background + activity exponent); 'ratio' = constant ratio (too little data, or baseline). */
  kind: 'glm' | 'ratio';
  /** VIIRS-only background, cells per day, per calendar month (all 0 for the constant ratio). */
  background: number[];
  /** Share of calibration-period VIIRS cell-days attributed to the background. */
  backgroundShare: number;
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
  /** Quasi-likelihood test of the constant ratio (b = 0, β = 1) against the fitted model. */
  test: { deltaDeviance: number; df: number; dispersion: number; f: number; p: number } | null;
}

export type AlphaModel = Record<ModisConfig, AlphaModelConfig>;

export interface AlphaModelOptions {
  years: [number, number];
  k?: number; // shrinkage of a_m toward the all-month mean, in MODIS cell-days (default 50)
  clamp?: [number, number];
  minYearsForBeta?: number; // default 3
  bootstrap?: { reps: number; seed: number } | null;
  /** Fix β = 1 and b = 0 (the constant-ratio model), e.g. as the comparison baseline. */
  forceRatio?: boolean;
  /** Fit the VIIRS-only background term (default true; false = the v1.1 one-component model). */
  background?: boolean;
  /** Use the constant ratio when its test against the fitted model has p above this (default 0.05). */
  selectionP?: number;
}

/** α at activity rate r (MODIS cells/day) for a calendar month, with no extrapolation. */
export function alphaAt(mc: AlphaModelConfig, month: number, rate: number, clamp: [number, number] = ALPHA_CLAMP): number {
  const i = month - 1;
  const r = Math.min(Math.max(rate > 0 ? rate : mc.typicalRate[i], mc.rateMin[i]), mc.rateMax[i]);
  // Expected VIIRS per MODIS cell at activity r: background spread over MODIS cells + scaled part.
  const al = (mc.background?.[i] ?? 0) / r + Math.exp(mc.a[i] + (mc.beta - 1) * Math.log(r));
  return al < clamp[0] ? clamp[0] : al > clamp[1] ? clamp[1] : al;
}

export function fitModelConfig(pairs: MonthPair[], config: ModisConfig, o: AlphaModelOptions, fallbackA: number[] | null = null): AlphaModelConfig {
  const k = o.k ?? 50;
  const years = new Set(pairs.filter((p) => p.m > 0).map((p) => p.year));
  const enough = !o.forceRatio && years.size >= (o.minYearsForBeta ?? 3);
  const reason = o.forceRatio
    ? 'β fixed at 1 (constant-ratio baseline)'
    : enough ? null : `only ${years.size} calibration year(s) with MODIS activity; β fixed at 1 (constant ratio)`;
  const withBg = enough && (o.background ?? true);
  const fit = fitAlphaGLM(pairs, { fixBeta: enough ? null : 1, background: withBg });
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
  // Background: same shrinkage toward the ΣM-weighted mean background.
  const bBar = totW > 0 ? fit.b.reduce((s, x, i) => s + x * sumModis[i], 0) / totW : 0;
  const background = fit.b.map((x, i) => {
    const w = sumModis[i] / (sumModis[i] + k);
    return w * x + (1 - w) * bBar;
  });
  const nDays = byMonth.map((s) => s.reduce((x, p) => x + p.n, 0));
  const totV = sumViirs.reduce((x, y) => x + y, 0);
  const backgroundShare = totV > 0 ? background.reduce((x, b, i) => x + b * nDays[i], 0) / totV : 0;

  let test: AlphaModelConfig['test'] = null;
  if (fit1) {
    const df = withBg ? 13 : 1; // 12 background terms + β, or β alone
    const p = 12 + df;
    const dispersion = Math.max(1, fit.pearson / Math.max(1, fit.nUsed - p));
    const deltaDeviance = Math.max(0, fit1.deviance - fit.deviance);
    const f = deltaDeviance / dispersion / df;
    test = { deltaDeviance, df, dispersion, f, p: chi2Sf(deltaDeviance / dispersion, df) };
  }

  // Parsimony: if the overlap data do not reject the constant ratio (p > 0.05), use it.
  if (test && test.p > (o.selectionP ?? 0.05)) {
    const ratio = fitModelConfig(pairs, config, { ...o, forceRatio: true }, fallbackA);
    return { ...ratio, reason: `data do not reject the constant ratio (F(${test.df}) = ${test.f.toFixed(1)}, p = ${test.p.toFixed(3)}); using it`, test };
  }

  const mc: AlphaModelConfig = {
    config,
    kind: enough ? 'glm' : 'ratio',
    reason,
    background,
    backgroundShare,
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
      const f = fitAlphaGLM(sample, { background: withBg });
      betas.push(f.beta);
      for (let i = 0; i < 12; i++) if (Number.isFinite(f.a[i])) al[i].push(f.b[i] / typicalRate[i] + Math.exp(f.a[i] + (f.beta - 1) * Math.log(typicalRate[i])));
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
