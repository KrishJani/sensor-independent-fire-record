// Test a "persistent VIIRS-only heat" mask (gas flares and other industrial sources), scored like validateModel.
// Rule: mask a cell if in ANY year (2012–2025) the VIIRS reference flags it on ≥ MIN_V days while MODIS
// (Terra or Aqua) flags it on ≤ FRAC × that many days. Masked cells are dropped for both sensors, all years.
// Usage: node scripts/backfill/experiments/flare-mask.ts <region>... [--minv 30 --frac 0.1]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { alphaAt, fitModelConfig, quantileSorted, type MonthPair } from '../../../packages/harmonizer/src/index.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const MIN_V = opt('--minv', 30), FRAC = opt('--frac', 0.1);
const regions = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

function run(region: string) {
  const D = join('data/harmonized', region);
  const L = readFileSync(join(D, 'daily_harmonized.csv'), 'utf8').trim().split('\n');
  const h = L[0].split(','), ix = (n: string) => h.indexOf(n);
  const ref = new Map<string, string>(), calib = new Set<string>();
  for (const l of L.slice(1)) { const f = l.split(','); if (f[ix('basis')] === 'VIIRS') ref.set(f[0], f[ix('viirs_reference')]); const y = +f[0].slice(0, 4); if (y >= 2013 && y <= 2021 && f[ix('basis')] === 'VIIRS' && f[ix('modis_config')] === 'TA') calib.add(f[0]); }
  // per-year day counts per cell
  const vd = new Map<string, number>(), md = new Map<string, Set<string>>();
  const days = new Map<string, { M: Set<number>; V: Set<number> }>();
  let totV = 0;
  for (const fn of readdirSync(join(D, 'cell_days')).sort()) {
    const y = +fn.slice(0, 4); if (y < 2012) continue;
    for (const l of readFileSync(join(D, 'cell_days', fn), 'utf8').split('\n').slice(1)) {
      if (!l) continue; const f = l.split(','); const c = +f[1]; const r = ref.get(f[0]);
      const isM = f[4] === 'TERRA' || f[4] === 'AQUA';
      if (isM) { const k = `${c}|${y}`; (md.get(k) ?? md.set(k, new Set()).get(k)!).add(f[0]); }
      else if (r && f[4] === r) { const k = `${c}|${y}`; vd.set(k, (vd.get(k) ?? 0) + 1); }
      if (calib.has(f[0]) && (isM || f[4] === r)) { const e = days.get(f[0]) ?? days.set(f[0], { M: new Set(), V: new Set() }).get(f[0])!; (isM ? e.M : e.V).add(c); if (!isM) totV++; }
    }
  }
  const mask = new Set<number>();
  for (const [k, n] of vd) if (n >= MIN_V && (md.get(k)?.size ?? 0) <= FRAC * n) mask.add(+k.split('|')[0]);
  const pairsOf = (useMask: boolean) => {
    const mp = new Map<string, MonthPair>();
    for (const d of calib) {
      const y = +d.slice(0, 4), m = +d.slice(5, 7), k = `${y}-${m}`;
      const e = mp.get(k) ?? mp.set(k, { year: y, month: m, n: 0, m: 0, v: 0 }).get(k)!;
      e.n++; const dd = days.get(d); if (!dd) continue;
      for (const c of dd.M) if (!useMask || !mask.has(c)) e.m++;
      for (const c of dd.V) if (!useMask || !mask.has(c)) e.v++;
    }
    return [...mp.values()];
  };
  const score = (ps: MonthPair[]) => {
    const rows: { y: number; m: number; obs: number; pred: number }[] = [];
    for (const y of [...new Set(ps.map((p) => p.year))]) { const mc = fitModelConfig(ps.filter((p) => p.year !== y), 'TA', { years: [2013, 2021] }); for (const p of ps.filter((q) => q.year === y)) rows.push({ y, m: p.month, obs: p.v, pred: p.m > 0 ? alphaAt(mc, p.month, p.m / p.n) * p.m : 0 }); }
    const sc = rows.filter((r) => r.obs >= 20); const ap = sc.map((r) => Math.abs(r.pred - r.obs) / r.obs).sort((a, b) => a - b);
    const full = fitModelConfig(ps, 'TA', { years: [2013, 2021] });
    const yr = new Map<number, [number, number]>(); for (const p of ps) { const e = yr.get(p.year) ?? [0, 0]; e[0] += p.m > 0 ? alphaAt(full, p.month, p.m / p.n) * p.m : 0; e[1] += p.v; yr.set(p.year, e); }
    const logs = [...yr.values()].filter(([a, b]) => a > 0 && b > 0).map(([a, b]) => Math.log(a / b)).sort((a, b) => a - b);
    const ratios = [...yr.entries()].sort((a, b) => a[0] - b[0]).map(([, [, v]]) => v);
    const byObs = [...sc].sort((a, b) => b.obs - a.obs); const bias = (s: typeof sc) => s.reduce((x, r) => x + r.pred, 0) / s.reduce((x, r) => x + r.obs, 0) - 1;
    return `error ${(quantileSorted(ap, 0.5) * 100).toFixed(1).padStart(5)}%  step ${((Math.exp(quantileSorted(logs, 0.5)) - 1) * 100).toFixed(1).padStart(5)}%  quietest ${(bias(byObs.slice(-Math.round(sc.length / 4))) * 100).toFixed(1).padStart(6)}%  busiest ${(bias(byObs.slice(0, Math.round(sc.length / 10))) * 100).toFixed(1).padStart(5)}%`;
  };
  let mv = 0; for (const dd of days.values()) for (const c of dd.V) if (mask.has(c)) mv++;
  console.log(`${region.padEnd(18)} masked cells ${String(mask.size).padStart(3)}  (${((mv / totV) * 100).toFixed(1)}% of 2013–21 VIIRS cell-days)`);
  console.log(`   now:        ${score(pairsOf(false))}`);
  console.log(`   with mask:  ${score(pairsOf(true))}`);
}
console.log(`rule: VIIRS ≥ ${MIN_V} days in a year and MODIS ≤ ${FRAC * 100}% of those days\n`);
for (const r of regions) run(r);
