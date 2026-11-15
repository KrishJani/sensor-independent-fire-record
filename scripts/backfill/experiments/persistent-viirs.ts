// Do persistent VIIRS-only heat sources (e.g. gas flares, which VIIRS sees and MODIS mostly does not)
// drive the year-to-year swings in the VIIRS/MODIS ratio?  A cell is "persistent" in a year if the VIIRS
// reference flags it on ≥ N days that year. Real wildfires rarely burn one 5.5 km cell on 30+ days a year.
// Usage: node scripts/backfill/experiments/persistent-viirs.ts <region> [minDays=30]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const region = process.argv[2] ?? 'southwest';
const N = +(process.argv[3] ?? 30);
const D = join('data/harmonized', region);
const L = readFileSync(join(D, 'daily_harmonized.csv'), 'utf8').trim().split('\n');
const h = L[0].split(','), ix = (n: string) => h.indexOf(n);
const ref = new Map<string, string>();
for (const l of L.slice(1)) { const f = l.split(','); const y = +f[0].slice(0, 4); if (y >= 2013 && y <= 2021 && f[ix('basis')] === 'VIIRS' && f[ix('modis_config')] === 'TA') ref.set(f[0], f[ix('viirs_reference')]); }
console.log(`${region}: cells flagged by VIIRS on ≥ ${N} days in a year ("persistent")`);
console.log('year   V/M all   V/M w/o persistent   persistent cells   share of VIIRS cell-days   share of MODIS cell-days');
const pcells = new Map<number, { lat: number; lon: number; years: number; vdays: number }>();
for (let y = 2013; y <= 2021; y++) {
  const vDays = new Map<number, number>(), mDays = new Map<number, number>();
  for (const l of readFileSync(join(D, 'cell_days', `${y}.csv`), 'utf8').split('\n').slice(1)) {
    if (!l) continue; const f = l.split(','); const r = ref.get(f[0]); if (!r) continue;
    const c = +f[1];
    if (f[4] === 'TERRA' || f[4] === 'AQUA') mDays.set(c, (mDays.get(c) ?? 0) + 1); // T and A counted separately; ratio uses union below
    else if (f[4] === r) vDays.set(c, (vDays.get(c) ?? 0) + 1);
  }
  // MODIS union per day is not needed for shares; recompute V and M totals on the union basis from the daily file
  let V = 0, M = 0;
  for (const l of L.slice(1)) { const f = l.split(','); if (ref.has(f[0]) && +f[0].slice(0, 4) === y) { V += +f[ix('viirs_cell_days')]; M += +f[ix('modis_cell_days')]; } }
  const pers = [...vDays].filter(([, d]) => d >= N).map(([c]) => c);
  const pv = pers.reduce((s, c) => s + vDays.get(c)!, 0);
  const pm = pers.reduce((s, c) => s + (mDays.get(c) ?? 0), 0) / 2; // T+A double-count → approx union
  const mAll = [...mDays.values()].reduce((a, b) => a + b, 0) / 2;
  for (const c of pers) { const e = pcells.get(c) ?? { lat: -90 + (Math.floor(c / 7200) + 0.5) * 0.05, lon: -180 + ((c % 7200) + 0.5) * 0.05, years: 0, vdays: 0 }; e.years++; e.vdays += vDays.get(c)!; pcells.set(c, e); }
  console.log(`${y}   ${(V / M).toFixed(2).padStart(6)}   ${((V - pv) / (M - Math.min(pm, M - 1))).toFixed(2).padStart(10)}           ${String(pers.length).padStart(5)}            ${((pv / V) * 100).toFixed(1).padStart(5)}%                    ${((pm / mAll) * 100).toFixed(1).padStart(5)}%`);
}
const top = [...pcells.values()].sort((a, b) => b.vdays - a.vdays).slice(0, 8);
console.log('top persistent cells (lat, lon, years persistent, VIIRS days 2013–21):');
for (const t of top) console.log(`  ${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}   ${t.years}   ${t.vdays}`);
