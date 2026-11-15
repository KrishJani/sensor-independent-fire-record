// Experiment: which MODIS→VIIRS calibration model is right for the data?
// Uses the California backfill outputs (cell_days + daily_harmonized) for 2013–2021 overlap days
// (Terra+Aqua and a VIIRS reference both available). Leave-one-year-out at the monthly level.
//
//   M0  monthly α (current):           Ĥ = α_m · M
//   M1  density-stratified α:           Ĥ = Σ_bins α_{m,k(M_b)} · M_b   (k = class of the bin's MODIS cell count that day)
//        + VIIRS-only bins (M_b = 0) folded in proportionally (variant a) or as a per-bin-day background rate (variant b)
//   M2  regional power law (reference): Ĥ = A_m · M^β   (not area-additive; shown for comparison only)
//
// Scores: LOYO MdAPE of monthly totals; residual within-month log-log slope of observed V on prediction (1 = unbiased
// across activity levels); worst-decile bias (the biggest months).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const D = process.argv[2] ?? 'data/harmonized/california';
const BIN = +(process.argv[3] ?? 10); // cells per bin side: 10 → 0.5°, 5 → 0.25°
const K = 50;

// --- overlap days and their VIIRS reference ---
const ref = new Map<string, string>();
for (const l of readFileSync(join(D, 'daily_harmonized.csv'), 'utf8').trim().split('\n').slice(1)) {
  const f = l.split(',');
  const y = +f[0].slice(0, 4);
  if (y >= 2013 && y <= 2021 && f[4] === 'VIIRS' && f[6] === 'TA') ref.set(f[0], f[7]);
}
// --- per-day per-bin MODIS (T∪A) and VIIRS-ref cell sets ---
type Day = { date: string; y: number; m: number; bins: Map<number, { M: Set<number>; V: Set<number> }> };
const days = new Map<string, Day>();
for (const fn of readdirSync(join(D, 'cell_days')).sort()) {
  const y = +fn.slice(0, 4);
  if (y < 2013 || y > 2021) continue;
  for (const l of readFileSync(join(D, 'cell_days', fn), 'utf8').split('\n').slice(1)) {
    if (!l) continue;
    const f = l.split(',');
    const r = ref.get(f[0]);
    if (!r) continue;
    const sat = f[4];
    const isM = sat === 'TERRA' || sat === 'AQUA';
    if (!isM && sat !== r) continue;
    const cell = +f[1];
    const bin = Math.floor(Math.floor(cell / 7200) / BIN) * 100000 + Math.floor((cell % 7200) / BIN);
    let d = days.get(f[0]);
    if (!d) days.set(f[0], (d = { date: f[0], y, m: +f[0].slice(5, 7), bins: new Map() }));
    let b = d.bins.get(bin);
    if (!b) d.bins.set(bin, (b = { M: new Set(), V: new Set() }));
    (isM ? b.M : b.V).add(cell);
  }
}
for (const date of ref.keys()) if (!days.has(date)) days.set(date, { date, y: +date.slice(0, 4), m: +date.slice(5, 7), bins: new Map() });

const CLASSES = [1, 2, 4, 8, 16, 32]; // lower bounds: 1, 2–3, 4–7, 8–15, 16–31, 32+
const cls = (n: number) => { let k = 0; for (let i = 0; i < CLASSES.length; i++) if (n >= CLASSES[i]) k = i; return k; };

type Fit = (train: Day[]) => (d: Day) => number;
// M0: monthly α
const M0: Fit = (train) => {
  const sm = Array(13).fill(0), sv = Array(13).fill(0);
  for (const d of train) for (const b of d.bins.values()) { sm[d.m] += b.M.size; sv[d.m] += b.V.size; }
  const pooled = sv.reduce((a, b) => a + b) / sm.reduce((a, b) => a + b);
  const a = sm.map((m, i) => { const w = m / (m + K); return m ? w * (sv[i] / m) + (1 - w) * pooled : pooled; });
  return (d) => { let M = 0; for (const b of d.bins.values()) M += b.M.size; return a[d.m] * M; };
};
// M1: density-stratified α per (month, class), shrunk toward the class's all-month α, then toward the month α.
function M1(variant: 'a' | 'b'): Fit {
  return (train) => {
    const sm = Array.from({ length: 13 }, () => Array(CLASSES.length).fill(0));
    const sv = Array.from({ length: 13 }, () => Array(CLASSES.length).fill(0));
    const bgV = Array(13).fill(0), bgN = Array(13).fill(0), mTot = Array(13).fill(0);
    const nBinsSeen = new Set<number>();
    for (const d of train) for (const [bid, b] of d.bins) { nBinsSeen.add(bid); if (b.M.size) { const k = cls(b.M.size); sm[d.m][k] += b.M.size; sv[d.m][k] += b.V.size; mTot[d.m] += b.M.size; } else bgV[d.m] += b.V.size; }
    for (const d of train) bgN[d.m]++;
    const nBins = nBinsSeen.size;
    const cm = CLASSES.map((_, k) => sm.reduce((a, r) => a + r[k], 0)), cv = CLASSES.map((_, k) => sv.reduce((a, r) => a + r[k], 0));
    const classPooled = cm.map((m, k) => (m ? cv[k] / m : 1));
    const alpha = sm.map((row, mo) => row.map((m, k) => { const w = m / (m + K); return m ? w * (sv[mo][k] / m) + (1 - w) * classPooled[k] : classPooled[k]; }));
    const gamma = mTot.map((m, mo) => (m ? bgV[mo] / m : 0)); // variant a: background ∝ MODIS activity
    const bgRate = bgV.map((v, mo) => (bgN[mo] ? v / bgN[mo] : 0)); // variant b: background per region-day (∝ area)
    return (d) => {
      let h = 0, M = 0;
      for (const b of d.bins.values()) if (b.M.size) { h += alpha[d.m][cls(b.M.size)] * b.M.size; M += b.M.size; }
      return variant === 'a' ? h + gamma[d.m] * M : h + bgRate[d.m];
    };
  };
}
// M2: regional power law per month (log V = a_m + β log M) on monthly totals — reference only
const M2: Fit = (train) => {
  const mon = new Map<string, { m: number; M: number; V: number }>();
  for (const d of train) { const k = `${d.y}-${d.m}`; const e = mon.get(k) ?? { m: d.m, M: 0, V: 0 }; for (const b of d.bins.values()) { e.M += b.M.size; e.V += b.V.size; } mon.set(k, e); }
  const pts = [...mon.values()].filter((p) => p.M >= 20 && p.V >= 20);
  const g = new Map<number, typeof pts>(); for (const p of pts) (g.get(p.m) ?? g.set(p.m, []).get(p.m)!).push(p);
  let sxx = 0, sxy = 0; const mx: Record<number, number> = {}, my: Record<number, number> = {};
  for (const [m, a] of g) { mx[m] = a.reduce((s, p) => s + Math.log(p.M), 0) / a.length; my[m] = a.reduce((s, p) => s + Math.log(p.V), 0) / a.length; for (const p of a) { sxx += (Math.log(p.M) - mx[m]) ** 2; sxy += (Math.log(p.M) - mx[m]) * (Math.log(p.V) - my[m]); } }
  const beta = sxy / sxx;
  // applied to the MONTH total, then spread over its days pro rata (so daily sums stay consistent)
  const monthM = new Map<string, number>();
  return (d) => { let M = 0; for (const b of d.bins.values()) M += b.M.size; if (!(d.m in mx) || M === 0) return 0; return { M, beta, a: my[d.m] - beta * mx[d.m] } as unknown as number; };
};

function evaluate(name: string, fit: Fit, monthLevelPow = false) {
  const all = [...days.values()];
  const years = [...new Set(all.map((d) => d.y))].sort();
  const rows: { y: number; m: number; obs: number; pred: number }[] = [];
  for (const y of years) {
    const train = all.filter((d) => d.y !== y);
    const f = fit(train);
    const mon = new Map<number, { obs: number; pred: number; M: number; p?: { beta: number; a: number } }>();
    for (const d of all.filter((x) => x.y === y)) {
      let V = 0; for (const b of d.bins.values()) V += b.V.size;
      const e = mon.get(d.m) ?? { obs: 0, pred: 0, M: 0 };
      e.obs += V;
      const p = f(d) as unknown;
      if (monthLevelPow) { if (typeof p === 'object' && p) { e.M += (p as { M: number }).M; e.p = p as { beta: number; a: number }; } }
      else e.pred += p as number;
      mon.set(d.m, e);
    }
    for (const [m, e] of mon) rows.push({ y, m, obs: e.obs, pred: monthLevelPow ? (e.p && e.M ? Math.exp(e.p.a + e.p.beta * Math.log(e.M)) : 0) : e.pred });
  }
  const scored = rows.filter((r) => r.obs >= 20);
  const apes = scored.map((r) => Math.abs(r.pred - r.obs) / r.obs).sort((a, b) => a - b);
  const mdape = apes[Math.floor(apes.length / 2)];
  // residual within-month slope: log obs on log pred with month fixed effects
  const g = new Map<number, typeof scored>(); for (const r of scored.filter((r) => r.pred > 0)) (g.get(r.m) ?? g.set(r.m, []).get(r.m)!).push(r);
  let sxx = 0, sxy = 0;
  for (const a of g.values()) { if (a.length < 2) continue; const mx = a.reduce((s, r) => s + Math.log(r.pred), 0) / a.length, my = a.reduce((s, r) => s + Math.log(r.obs), 0) / a.length; for (const r of a) { sxx += (Math.log(r.pred) - mx) ** 2; sxy += (Math.log(r.pred) - mx) * (Math.log(r.obs) - my); } }
  const top = [...scored].sort((a, b) => b.obs - a.obs).slice(0, Math.max(1, Math.round(scored.length / 10)));
  const topBias = top.reduce((s, r) => s + r.pred, 0) / top.reduce((s, r) => s + r.obs, 0) - 1;
  const bottom = [...scored].sort((a, b) => a.obs - b.obs).slice(0, Math.max(1, Math.round(scored.length / 4)));
  const lowBias = bottom.reduce((s, r) => s + r.pred, 0) / bottom.reduce((s, r) => s + r.obs, 0) - 1;
  const tot = rows.reduce((s, r) => s + r.pred, 0) / rows.reduce((s, r) => s + r.obs, 0) - 1;
  console.log(`${name.padEnd(34)} LOYO MdAPE ${(mdape * 100).toFixed(1).padStart(5)}%   residual β ${(sxy / sxx).toFixed(3)}   top-10% months ${(topBias * 100).toFixed(1).padStart(6)}%   bottom-25% ${(lowBias * 100).toFixed(1).padStart(6)}%   total ${(tot * 100).toFixed(1).padStart(5)}%`);
}

let nb = 0, mOnlyV = 0, vAll = 0;
for (const d of days.values()) for (const b of d.bins.values()) { vAll += b.V.size; if (!b.M.size) mOnlyV += b.V.size; nb++; }
console.log(`${days.size} overlap days, bin = ${BIN * 0.05}°; VIIRS cell-days in bins with no MODIS that day: ${((mOnlyV / vAll) * 100).toFixed(1)}%\n`);
evaluate('M0  monthly α (current)', M0);
evaluate('M1a density α, bg ∝ MODIS', M1('a'));
evaluate('M1b density α, bg per area-day', M1('b'));
evaluate('M2  regional power law (ref.)', M2, true);

// ---------------- M3: Poisson GLM (log link), the principled generalization ----------------
// Unit = (year, month) over overlap days. E[V] = n · exp(a_m + β · log(M/n)).  β = 1 ⇒ α_m = ΣV/ΣM (M0 without shrinkage).
type MP = { y: number; m: number; n: number; M: number; V: number };
function monthPairs(ds: Day[]): MP[] {
  const mp = new Map<string, MP>();
  for (const d of ds) { const k = `${d.y}-${d.m}`; const e = mp.get(k) ?? { y: d.y, m: d.m, n: 0, M: 0, V: 0 }; e.n++; for (const b of d.bins.values()) { e.M += b.M.size; e.V += b.V.size; } mp.set(k, e); }
  return [...mp.values()];
}
export function fitPoissonGLM(pts: MP[], fixBeta: number | null = null) {
  const use = pts.filter((p) => p.M > 0);
  const a = Array(13).fill(0);
  let beta = fixBeta ?? 1;
  // init a_m at the β=1 solution
  for (let m = 1; m <= 12; m++) { const s = use.filter((p) => p.m === m); const sv = s.reduce((x, p) => x + p.V, 0), sm = s.reduce((x, p) => x + p.M, 0); a[m] = sm > 0 && sv > 0 ? Math.log(sv / sm) : 0; }
  for (let it = 0; it < 100; it++) {
    // block coordinate Newton: a_m closed form given β; then 1-D Newton on β
    for (let m = 1; m <= 12; m++) { const s = use.filter((p) => p.m === m); if (!s.length) continue; const sv = s.reduce((x, p) => x + p.V, 0); const den = s.reduce((x, p) => x + p.n * Math.exp(beta * Math.log(p.M / p.n)), 0); a[m] = sv > 0 ? Math.log(sv / den) : Math.log(1e-6); }
    if (fixBeta !== null) break;
    let g = 0, h = 0;
    for (const p of use) { const x = Math.log(p.M / p.n); const mu = p.n * Math.exp(a[p.m] + beta * x); g += (p.V - mu) * x; h += mu * x * x; }
    const step = g / h; beta += step;
    if (Math.abs(step) < 1e-10) break;
  }
  return { a, beta };
}
function evalGLM(name: string, fixBeta: number | null) {
  const all = [...days.values()];
  const years = [...new Set(all.map((d) => d.y))].sort();
  const rows: { y: number; m: number; obs: number; pred: number }[] = [];
  let betas: number[] = [];
  for (const y of years) {
    const fit = fitPoissonGLM(monthPairs(all.filter((d) => d.y !== y)), fixBeta);
    betas.push(fit.beta);
    for (const p of monthPairs(all.filter((d) => d.y === y))) rows.push({ y, m: p.m, obs: p.V, pred: p.M > 0 ? p.n * Math.exp(fit.a[p.m] + fit.beta * Math.log(p.M / p.n)) : 0 });
  }
  const scored = rows.filter((r) => r.obs >= 20);
  const apes = scored.map((r) => Math.abs(r.pred - r.obs) / r.obs).sort((a, b) => a - b);
  const g = new Map<number, typeof scored>(); for (const r of scored.filter((r) => r.pred > 0)) (g.get(r.m) ?? g.set(r.m, []).get(r.m)!).push(r);
  let sxx = 0, sxy = 0;
  for (const a of g.values()) { if (a.length < 2) continue; const mx = a.reduce((s, r) => s + Math.log(r.pred), 0) / a.length, my = a.reduce((s, r) => s + Math.log(r.obs), 0) / a.length; for (const r of a) { sxx += (Math.log(r.pred) - mx) ** 2; sxy += (Math.log(r.pred) - mx) * (Math.log(r.obs) - my); } }
  const top = [...scored].sort((a, b) => b.obs - a.obs).slice(0, Math.round(scored.length / 10));
  const bottom = [...scored].sort((a, b) => a.obs - b.obs).slice(0, Math.round(scored.length / 4));
  const bias = (s: typeof rows) => s.reduce((x, r) => x + r.pred, 0) / s.reduce((x, r) => x + r.obs, 0) - 1;
  console.log(`${name.padEnd(34)} LOYO MdAPE ${(apes[Math.floor(apes.length / 2)] * 100).toFixed(1).padStart(5)}%   residual β ${(sxy / sxx).toFixed(3)}   top-10% months ${(bias(top) * 100).toFixed(1).padStart(6)}%   bottom-25% ${(bias(bottom) * 100).toFixed(1).padStart(6)}%   total ${(bias(rows) * 100).toFixed(1).padStart(5)}%   β range ${Math.min(...betas).toFixed(3)}–${Math.max(...betas).toFixed(3)}`);
}
evalGLM('M3  Poisson GLM, β = 1 (≡ M0)', 1);
evalGLM('M3  Poisson GLM, β free', null);
const full = fitPoissonGLM(monthPairs([...days.values()]), null);
console.log(`\nfull-data GLM: β = ${full.beta.toFixed(3)}; α_eff at typical vs 4× typical activity in August: ` +
  (() => { const p = monthPairs([...days.values()]).filter((x) => x.m === 8 && x.M > 0); const r = p.map((x) => x.M / x.n).sort((a, b) => a - b); const med = r[Math.floor(r.length / 2)]; const al = (x: number) => Math.exp(full.a[8] + (full.beta - 1) * Math.log(x)); return `${al(med).toFixed(2)} vs ${al(4 * med).toFixed(2)} (median ${med.toFixed(1)} MODIS cells/day)`; })());
