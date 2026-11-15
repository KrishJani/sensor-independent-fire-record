// Does MODIS-observed fire-size structure explain the year-to-year swings in the VIIRS/MODIS ratio?
// Per (year, month) of Terra∪Aqua overlap days, from the region's own cell_days:
//   r      = MODIS cells/day                      (activity, as in the production model)
//   small  = share of MODIS cell-days with peak FRP < 15 MW   (small / cool fires)
//   iso    = share of MODIS cell-days with no MODIS-active neighbour (8 cells) that day (scattered fires)
// Models (Poisson, log link, month intercepts), scored leave-one-year-out like validateModel:
//   A: log r                (production)      B: log r + small + iso
// Usage: node scripts/backfill/experiments/fire-size-covariates.ts <region>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { quantileSorted } from '../../../packages/harmonizer/src/index.ts';

type P = { y: number; m: number; n: number; M: number; V: number; x: number[] };
function load(region: string): P[] {
  const D = join('data/harmonized', region);
  const L = readFileSync(join(D, 'daily_harmonized.csv'), 'utf8').trim().split('\n');
  const h = L[0].split(','), ix = (n: string) => h.indexOf(n);
  const dayRef = new Map<string, string>();
  for (const l of L.slice(1)) { const f = l.split(','); const y = +f[0].slice(0, 4); if (y >= 2013 && y <= 2021 && f[ix('basis')] === 'VIIRS' && f[ix('modis_config')] === 'TA') dayRef.set(f[0], f[ix('viirs_reference')]); }
  const per = new Map<string, { M: Set<number>; V: Set<number>; frp: Map<number, number> }>();
  for (let y = 2013; y <= 2021; y++) for (const l of readFileSync(join(D, 'cell_days', `${y}.csv`), 'utf8').split('\n').slice(1)) {
    if (!l) continue; const f = l.split(','); const ref = dayRef.get(f[0]); if (!ref) continue;
    const e = per.get(f[0]) ?? per.set(f[0], { M: new Set(), V: new Set(), frp: new Map() }).get(f[0])!;
    const c = +f[1];
    if (f[4] === 'TERRA' || f[4] === 'AQUA') { e.M.add(c); e.frp.set(c, Math.max(e.frp.get(c) ?? 0, +f[9])); } else if (f[4] === ref) e.V.add(c);
  }
  const mon = new Map<string, { y: number; m: number; n: number; M: number; V: number; small: number; iso: number }>();
  for (const d of dayRef.keys()) {
    const y = +d.slice(0, 4), m = +d.slice(5, 7), k = `${y}-${m}`;
    const e = mon.get(k) ?? mon.set(k, { y, m, n: 0, M: 0, V: 0, small: 0, iso: 0 }).get(k)!;
    e.n++;
    const day = per.get(d); if (!day) continue;
    e.M += day.M.size; e.V += day.V.size;
    for (const c of day.M) {
      if ((day.frp.get(c) ?? 0) < 15) e.small++;
      let nb = false; for (const dr of [-7200, 0, 7200]) for (const dc of [-1, 0, 1]) if ((dr || dc) && day.M.has(c + dr + dc)) nb = true;
      if (!nb) e.iso++;
    }
  }
  return [...mon.values()].filter((e) => e.M > 0).map((e) => ({ y: e.y, m: e.m, n: e.n, M: e.M, V: e.V, x: [Math.log(e.M / e.n), e.small / e.M, e.iso / e.M] }));
}

// Generic Poisson IRLS: log μ = log n + a_m + Σ b_j x_j   (Newton on all params; ridge 1e-6 for safety)
function fit(ps: P[], cov: number[]) {
  const p = 12 + cov.length; const th = Array(p).fill(0);
  for (let m = 1; m <= 12; m++) { const s = ps.filter((q) => q.m === m); th[m - 1] = s.length ? Math.log(s.reduce((a, q) => a + q.V, 0) / s.reduce((a, q) => a + q.M, 0)) : 0; }
  if (cov.includes(0)) th[12 + cov.indexOf(0)] = 1;
  const feats = (q: P) => { const f = Array(p).fill(0); f[q.m - 1] = 1; cov.forEach((j, i) => (f[12 + i] = q.x[j])); return f; };
  for (let it = 0; it < 50; it++) {
    const g = Array(p).fill(0), H = Array.from({ length: p }, () => Array(p).fill(0));
    for (const q of ps) { const f = feats(q); const eta = Math.log(q.n) + f.reduce((a, v, i) => a + v * th[i], 0) - (cov.includes(0) ? 0 : 0); const mu = Math.exp(eta + (cov.includes(0) ? 0 : Math.log(q.M / q.n)));
      for (let i = 0; i < p; i++) { g[i] += (q.V - mu) * f[i]; for (let j = 0; j < p; j++) H[i][j] += mu * f[i] * f[j]; } }
    for (let i = 0; i < p; i++) H[i][i] += 1e-6;
    // solve H d = g (Gaussian elimination)
    const A = H.map((r, i) => [...r, g[i]]);
    for (let c = 0; c < p; c++) { let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r; [A[c], A[piv]] = [A[piv], A[c]]; for (let r = 0; r < p; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let k2 = c; k2 <= p; k2++) A[r][k2] -= k * A[c][k2]; } }
    const d = A.map((r, i) => r[p] / r[i]); let mx = 0; d.forEach((v, i) => { th[i] += v; mx = Math.max(mx, Math.abs(v)); }); if (mx < 1e-10) break;
  }
  return (q: P) => { const f = feats(q); return q.n * Math.exp(f.reduce((a, v, i) => a + v * th[i], 0) + (cov.includes(0) ? 0 : Math.log(q.M / q.n))); };
}
function loyo(ps: P[], cov: number[]) {
  const rows: { m: number; obs: number; pred: number; y: number }[] = [];
  for (const y of [...new Set(ps.map((q) => q.y))]) { const f = fit(ps.filter((q) => q.y !== y), cov); for (const q of ps.filter((q) => q.y === y)) rows.push({ y, m: q.m, obs: q.V, pred: f(q) }); }
  const sc = rows.filter((r) => r.obs >= 20); const apes = sc.map((r) => Math.abs(r.pred - r.obs) / r.obs).sort((a, b) => a - b);
  const g = new Map<number, typeof sc>(); for (const r of sc) (g.get(r.m) ?? g.set(r.m, []).get(r.m)!).push(r);
  let sxx = 0, sxy = 0; for (const a of g.values()) { if (a.length < 2) continue; const mx = a.reduce((s, r) => s + Math.log(r.pred), 0) / a.length, my = a.reduce((s, r) => s + Math.log(r.obs), 0) / a.length; for (const r of a) { sxx += (Math.log(r.pred) - mx) ** 2; sxy += (Math.log(r.pred) - mx) * (Math.log(r.obs) - my); } }
  const byObs = [...sc].sort((a, b) => b.obs - a.obs); const bias = (s: typeof sc) => s.reduce((x, r) => x + r.pred, 0) / s.reduce((x, r) => x + r.obs, 0) - 1;
  // annual ratio spread (how well year-to-year swings are captured)
  const yr = new Map<number, [number, number]>(); for (const r of rows) { const e = yr.get(r.y) ?? [0, 0]; e[0] += r.pred; e[1] += r.obs; yr.set(r.y, e); }
  const worst = Math.max(...[...yr.values()].map(([p, o]) => Math.abs(p / o - 1)));
  return `MdAPE ${(quantileSorted(apes, 0.5) * 100).toFixed(1).padStart(5)}%  resid β ${(sxy / sxx).toFixed(2)}  busiest ${(bias(byObs.slice(0, Math.round(sc.length / 10))) * 100).toFixed(1).padStart(5)}%  quietest ${(bias(byObs.slice(-Math.round(sc.length / 4))) * 100).toFixed(1).padStart(5)}%  worst year ${(worst * 100).toFixed(1)}%`;
}
for (const region of process.argv.slice(2)) {
  const ps = load(region);
  console.log(`\n${region}`);
  console.log(`  A  activity only (production)        ${loyo(ps, [0])}`);
  console.log(`  B  activity + fire size (FRP, iso)    ${loyo(ps, [0, 1, 2])}`);
}
