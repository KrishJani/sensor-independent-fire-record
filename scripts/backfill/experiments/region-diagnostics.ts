// Is a region's validation failure model error or counting noise?
//  (1) Parametric bootstrap: simulate overlap data FROM the fitted model with Poisson noise on both
//      MODIS (M) and VIIRS (V), score each simulation exactly like the real data → the range a
//      CORRECT model would show. Real scores outside that range = genuine misfit.
//  (2) Alternative: two-component model E[V] = n·b_m + c_m·n·(M/n)^β (VIIRS-only background + scaled
//      large-fire part), fitted by EM; compared out of sample (leave-one-year-out).
// Usage: node scripts/backfill/experiments/region-diagnostics.ts <region> [sims]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitModelConfig, alphaAt, mulberry32, quantileSorted, type MonthPair, type AlphaModelConfig } from '../../../packages/harmonizer/src/index.ts';

const region = process.argv[2] ?? 'interior_west';
const SIMS = +(process.argv[3] ?? 200);
const D = join('data/harmonized', region);
const lines = readFileSync(join(D, 'daily_harmonized.csv'), 'utf8').trim().split('\n');
const h = lines[0].split(',');
const ix = (n: string) => h.indexOf(n);
const pm = new Map<string, MonthPair>();
for (const l of lines.slice(1)) {
  const f = l.split(',');
  const y = +f[0].slice(0, 4);
  if (y < 2013 || y > 2021 || f[ix('basis')] !== 'VIIRS' || f[ix('modis_config')] !== 'TA') continue;
  const k = `${y}-${+f[0].slice(5, 7)}`;
  const e = pm.get(k) ?? { year: y, month: +f[0].slice(5, 7), n: 0, m: 0, v: 0 };
  e.n++; e.m += +f[ix('modis_cell_days')]; e.v += +f[ix('viirs_cell_days')];
  pm.set(k, e);
}
const pairs = [...pm.values()];
const MIN = 20;
const opts = { years: [2013, 2021] as [number, number] };

// ---------- scoring identical to validateModel ----------
type Row = { y: number; m: number; obs: number; pred: number };
function score(rows: Row[]) {
  const sc = rows.filter((r) => r.obs >= MIN);
  const apes = sc.map((r) => Math.abs(r.pred - r.obs) / r.obs).sort((a, b) => a - b);
  const g = new Map<number, Row[]>(); for (const r of sc.filter((r) => r.pred > 0)) (g.get(r.m) ?? g.set(r.m, []).get(r.m)!).push(r);
  let sxx = 0, sxy = 0;
  for (const a of g.values()) { if (a.length < 2) continue; const mx = a.reduce((s, r) => s + Math.log(r.pred), 0) / a.length, my = a.reduce((s, r) => s + Math.log(r.obs), 0) / a.length; for (const r of a) { sxx += (Math.log(r.pred) - mx) ** 2; sxy += (Math.log(r.pred) - mx) * (Math.log(r.obs) - my); } }
  const byObs = [...sc].sort((a, b) => b.obs - a.obs);
  const bias = (s: Row[]) => s.reduce((x, r) => x + r.pred, 0) / s.reduce((x, r) => x + r.obs, 0) - 1;
  return { mdape: apes.length ? quantileSorted(apes, 0.5) : NaN, rb: sxx ? sxy / sxx : NaN, top: bias(byObs.slice(0, Math.max(1, Math.round(sc.length / 10)))), bot: bias(byObs.slice(-Math.max(1, Math.round(sc.length / 4)))), n: sc.length };
}
const predGLM = (mc: AlphaModelConfig, p: MonthPair) => (p.m > 0 ? alphaAt(mc, p.month, p.m / p.n) * p.m : 0);
function loyoGLM(ps: MonthPair[]): Row[] {
  const rows: Row[] = [];
  for (const y of [...new Set(ps.map((p) => p.year))]) {
    const mc = fitModelConfig(ps.filter((p) => p.year !== y), 'TA', opts);
    for (const p of ps.filter((q) => q.year === y)) rows.push({ y, m: p.month, obs: p.v, pred: predGLM(mc, p) });
  }
  return rows;
}

// ---------- two-component model, EM ----------
// E[V] = n·b_m + c_m·n·r^β, r = M/n. EM: split V into background / fire parts by expected shares;
// b_m = Σ bg / Σ n; (c_m, β) = Poisson GLM (log link) on the fire part with offset log n.
function fit2(ps: MonthPair[]) {
  const use = ps.filter((p) => p.n > 0);
  const b = Array(13).fill(0.1), c = Array(13).fill(1);
  let beta = 1;
  for (let it = 0; it < 300; it++) {
    const bgSum = Array(13).fill(0), nSum = Array(13).fill(0);
    const fire: { p: MonthPair; f: number; x: number }[] = [];
    for (const p of use) {
      const r = p.m / p.n;
      const lb = p.n * b[p.month], lf = r > 0 ? c[p.month] * p.n * r ** beta : 0;
      const tot = lb + lf || 1e-12;
      bgSum[p.month] += (p.v * lb) / tot; nSum[p.month] += p.n;
      if (r > 0) fire.push({ p, f: (p.v * lf) / tot, x: Math.log(r) });
    }
    for (let m = 1; m <= 12; m++) b[m] = nSum[m] ? Math.max(bgSum[m] / nSum[m], 1e-9) : 0;
    // M-step for fire part: closed-form c_m given β, then profile Newton step on β
    for (let k = 0; k < 5; k++) {
      for (let m = 1; m <= 12; m++) { const s = fire.filter((e) => e.p.month === m); const sf = s.reduce((a, e) => a + e.f, 0), den = s.reduce((a, e) => a + e.p.n * Math.exp(beta * e.x), 0); c[m] = den > 0 ? Math.max(sf, 1e-9) / den : 0; }
      const sw = Array(13).fill(0), swx = Array(13).fill(0);
      const mus = fire.map((e) => { const mu = c[e.p.month] * e.p.n * Math.exp(beta * e.x); sw[e.p.month] += mu; swx[e.p.month] += mu * e.x; return { e, mu }; });
      let g = 0, hh = 0; for (const { e, mu } of mus) { const xc = e.x - swx[e.p.month] / sw[e.p.month]; g += (e.f - mu) * xc; hh += mu * xc * xc; }
      if (hh > 0) beta = Math.min(1.5, Math.max(0.2, beta + g / hh));
    }
  }
  return { b, c, beta, pred: (p: MonthPair) => p.n * b[p.month] + (p.m > 0 ? c[p.month] * p.n * (p.m / p.n) ** beta : 0) };
}
function loyo2(ps: MonthPair[]): Row[] {
  const rows: Row[] = [];
  for (const y of [...new Set(ps.map((p) => p.year))]) {
    const f = fit2(ps.filter((p) => p.year !== y));
    for (const p of ps.filter((q) => q.year === y)) rows.push({ y, m: p.month, obs: p.v, pred: f.pred(p) });
  }
  return rows;
}

// ---------- Poisson sampler ----------
const rnd = mulberry32(7);
function pois(l: number): number { if (l < 30) { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= rnd(); } while (p > L); return k - 1; } const u = rnd() || 1e-12, v = rnd(); return Math.max(0, Math.round(l + Math.sqrt(l) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))); }

const full = fitModelConfig(pairs, 'TA', opts);
const real = score(loyoGLM(pairs));
const sims = { mdape: [] as number[], rb: [] as number[], top: [] as number[], bot: [] as number[], beta: [] as number[] };
for (let s = 0; s < SIMS; s++) {
  // true M = observed M; observed M* ~ Poisson(M); V ~ Poisson(model(M)); refit + score exactly as real
  const sp = pairs.map((p) => ({ ...p, m: pois(p.m), v: pois(predGLM(full, p)) }));
  const sc = score(loyoGLM(sp));
  sims.mdape.push(sc.mdape); sims.rb.push(sc.rb); sims.top.push(sc.top); sims.bot.push(sc.bot);
  sims.beta.push(fitModelConfig(sp, 'TA', opts).beta);
}
const rng = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return `${quantileSorted(s, 0.05).toFixed(3)}–${quantileSorted(s, 0.95).toFixed(3)} (median ${quantileSorted(s, 0.5).toFixed(3)})`; };
const pctOf = (a: number[], x: number) => (a.filter((v) => v <= x).length / a.length) * 100;
const medV = quantileSorted(pairs.map((p) => p.v).sort((a, b) => a - b), 0.5);
console.log(`${region}: ${pairs.length} overlap months, median VIIRS ${medV} cell-days/month, ${real.n} months scored (≥ ${MIN})`);
console.log(`fitted β = ${full.beta.toFixed(3)}; refits on data simulated with β = ${full.beta.toFixed(3)} give β ${rng(sims.beta)}`);
console.log(`\n                     real      what a CORRECT model scores here (90% range)        real is at percentile`);
console.log(`LOYO MdAPE        ${(real.mdape * 100).toFixed(1).padStart(6)}%     ${rng(sims.mdape.map((x) => x * 100))} %       ${pctOf(sims.mdape, real.mdape).toFixed(0)}`);
console.log(`residual β        ${real.rb.toFixed(3).padStart(7)}     ${rng(sims.rb)}             ${pctOf(sims.rb, real.rb).toFixed(0)}`);
console.log(`busiest 10% bias  ${(real.top * 100).toFixed(1).padStart(6)}%     ${rng(sims.top.map((x) => x * 100))} %       ${pctOf(sims.top, real.top).toFixed(0)}`);
console.log(`quietest 25% bias ${(real.bot * 100).toFixed(1).padStart(6)}%     ${rng(sims.bot.map((x) => x * 100))} %       ${pctOf(sims.bot, real.bot).toFixed(0)}`);
const two = score(loyo2(pairs));
const f2 = fit2(pairs);
console.log(`\ntwo-component (background + c·M^β), LOYO: MdAPE ${(two.mdape * 100).toFixed(1)}%  residual β ${two.rb.toFixed(3)}  busiest ${(two.top * 100).toFixed(1)}%  quietest ${(two.bot * 100).toFixed(1)}%   (fitted β ${f2.beta.toFixed(3)})`);
