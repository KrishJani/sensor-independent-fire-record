// Group aggregation (e.g. the whole US): the sum of separately calibrated, non-overlapping regions.
// Harmonized cell-days are additive (α_eff is per region-month and applied linearly), so a group
// total is exactly the sum of its regions. Inputs are each region's daily_harmonized.csv.
//
//   data/harmonized/<group>/daily_harmonized.csv   summed daily series over the common date range
//   data/harmonized/<group>/calendar_monthly.csv   Year × Month (complete only if complete in every region)
//   data/harmonized/<group>/regions_summary.csv    per-region model + out-of-sample validation
//   data/harmonized/<group>/overlap_check.csv      Σ MODIS×α vs Σ VIIRS per year where both flew
//   data/harmonized/<group>/annual.csv             yearly totals with 90% bands (sum of region bands: conservative)
//   data/harmonized/<group>/manifest.json

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARMONIZER_VERSION, daysInMonth, fmt } from '../../../packages/harmonizer/src/index.ts';
import type { RegionsConfig } from './config.ts';
import { contentHashOfFile, writeAtomic } from './files.ts';

interface Day {
  harm: number;
  raw: number;
  unscaled: number;
  mscaled: number;
  mscaledRegions: number;
  viirs: number;
  modis: number;
  basisViirs: number;
  basisModis: number;
  basisNone: number;
  regions: number;
}

export async function aggregateGroup(cfg: RegionsConfig, group: string, harmonizedDir: string, log: (m: string) => void) {
  const regions = cfg.regions.filter((r) => r.group === group);
  if (!regions.length) throw new Error(`no regions in group "${group}"`);
  const per = new Map<string, Map<string, string[]>>();
  const summaries: Record<string, unknown>[] = [];
  const regionAnnual = new Map<string, { ann: Map<number, { h: number; s: number }>; band: [number, number] | null }>();
  const regionMonthBands = new Map<string, Map<string, { lo: number; hi: number }>>();
  let from = '0000-00-00';
  let to = '9999-99-99';
  for (const r of regions) {
    const dir = join(harmonizedDir, r.id);
    const p = join(dir, 'daily_harmonized.csv');
    if (!existsSync(p)) throw new Error(`region ${r.id} has no backfill yet (${p}) — run: backfill run --region ${r.id}`);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const h = lines[0].split(',');
    const m = new Map<string, string[]>();
    for (const l of lines.slice(1)) {
      const f = l.split(',');
      m.set(f[0], f);
    }
    const dates = [...m.keys()].sort();
    if (dates[0] > from) from = dates[0];
    if (dates[dates.length - 1] < to) to = dates[dates.length - 1];
    per.set(r.id, new Map([...m].map(([k, f]) => [k, f])));
    (per.get(r.id) as unknown as { header: string[] }).header = h;

    const v = JSON.parse(readFileSync(join(dir, 'validation.json'), 'utf8'));
    const model = JSON.parse(readFileSync(join(dir, 'alpha_model.json'), 'utf8')).model.TA;
    const ta = v.configs.TA;
    summaries.push({
      region: r.id,
      name: r.name,
      kind: model.kind,
      beta: model.beta,
      beta_ci_low: model.betaCi?.[0] ?? null,
      beta_ci_high: model.betaCi?.[1] ?? null,
      test_f: model.test?.f ?? null,
      test_p: model.test?.p ?? null,
      loyo_mdape: ta.loyo.mdape,
      loyo_mdape_constant_ratio: ta.loyoConstantRatio.mdape,
      top10_bias: ta.loyo.topDecileBias,
      top10_bias_constant_ratio: ta.loyoConstantRatio.topDecileBias,
      bottom25_bias: ta.loyo.bottomQuartileBias,
      bottom25_bias_constant_ratio: ta.loyoConstantRatio.bottomQuartileBias,
      residual_beta: ta.loyo.residualBeta,
      transition_step: ta.continuity.medianStepPct,
      months_scored: ta.loyo.nMonthsScored,
      acc_loyo: v.acceptance.loyoMdapeWithin15pct,
      acc_no_step: v.acceptance.noStepAtTransition,
      acc_unbiased: v.acceptance.unbiasedAcrossActivity,
      background_share: model.backgroundShare ?? 0,
      bias_check: v.biasCheck ?? 'fixed-threshold',
      noise_residual_beta_p05: ta.noise?.residualBeta?.[0] ?? null,
      noise_residual_beta_pct: ta.noise?.realResidualBetaPct ?? null,
      band_month_lo: ta.uncertainty?.monthly?.[0] ?? null,
      band_month_hi: ta.uncertainty?.monthly?.[1] ?? null,
      band_year_lo: ta.uncertainty?.annual?.[0] ?? null,
      band_year_hi: ta.uncertainty?.annual?.[1] ?? null,
      confidence: v.confidence?.level ?? 'ok',
      confidence_reason: v.confidence?.reason ?? '',
    });
    // Region annual bands: only the MODIS-scaled part of each year is uncertain.
    const rcal = readFileSync(join(dir, 'calendar_monthly.csv'), 'utf8').trim().split('\n');
    const rh = rcal[0].split(',');
    const iy = rh.indexOf('year'), iH = rh.indexOf('harmonized_cell_days'), iS = rh.indexOf('scaled_cell_days'), iLo = rh.indexOf('harmonized_lo'), iHi = rh.indexOf('harmonized_hi');
    if (iS < 0) throw new Error(`${r.id}: calendar_monthly.csv lacks scaled_cell_days (re-run its backfill with harmonizer ${HARMONIZER_VERSION})`);
    const ann = new Map<number, { h: number; s: number }>();
    const mon = new Map<string, { lo: number; hi: number }>();
    for (const l of rcal.slice(1)) {
      const f = l.split(',');
      const e = ann.get(+f[iy]) ?? { h: 0, s: 0 };
      e.h += +f[iH];
      e.s += +f[iS];
      ann.set(+f[iy], e);
      mon.set(`${f[iy]}-${+f[rh.indexOf('month')]}`, { lo: f[iLo] === '' ? +f[iH] : +f[iLo], hi: f[iHi] === '' ? +f[iH] : +f[iHi] });
    }
    regionAnnual.set(r.id, { ann, band: ta.uncertainty?.annual ?? null });
    regionMonthBands.set(r.id, mon);
  }

  // Sum day by day over the common range.
  const days = new Map<string, Day>();
  for (const r of regions) {
    const m = per.get(r.id)!;
    const h = (m as unknown as { header: string[] }).header;
    const ix = (n: string) => {
      const i = h.indexOf(n);
      if (i < 0) throw new Error(`${r.id}: daily_harmonized.csv lacks ${n} (re-run its backfill with harmonizer ${HARMONIZER_VERSION})`);
      return i;
    };
    const [iH, iR, iU, iMs, iV, iM, iB] = ['harmonized_cell_days', 'raw_detections', 'unscaled_cell_days', 'modis_scaled_cell_days', 'viirs_cell_days', 'modis_cell_days', 'basis'].map(ix);
    for (const [date, f] of m) {
      if (date < from || date > to) continue;
      const d = days.get(date) ?? { harm: 0, raw: 0, unscaled: 0, mscaled: 0, mscaledRegions: 0, viirs: 0, modis: 0, basisViirs: 0, basisModis: 0, basisNone: 0, regions: 0 };
      d.harm += +f[iH];
      d.raw += +f[iR];
      d.unscaled += +f[iU];
      if (f[iMs] !== '') {
        d.mscaled += +f[iMs];
        d.mscaledRegions++;
      }
      d.viirs += +f[iV];
      d.modis += +f[iM];
      if (f[iB] === 'VIIRS') d.basisViirs++;
      else if (f[iB] === 'MODIS_SCALED') d.basisModis++;
      else d.basisNone++;
      d.regions++;
      days.set(date, d);
    }
  }
  const n = regions.length;
  const sorted = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [date, d] of sorted) if (d.regions !== n) throw new Error(`${date}: only ${d.regions}/${n} regions have this date`);

  let daily = 'acq_date,harmonized_cell_days,raw_detections,unscaled_cell_days,modis_scaled_cell_days,viirs_cell_days,modis_cell_days,regions_viirs,regions_modis_scaled,regions_none\n';
  const months = new Map<string, { y: number; m: number; harm: number; raw: number; unscaled: number; ms: number; viirs: number; modis: number; days: number; allViirs: number; anyNone: boolean }>();
  const overlap = new Map<number, { vi: number; ms: number; days: number }>();
  for (const [date, d] of sorted) {
    daily += `${date},${fmt(d.harm, 2)},${d.raw},${d.unscaled},${fmt(d.mscaled, 2)},${d.viirs},${d.modis},${d.basisViirs},${d.basisModis},${d.basisNone}\n`;
    const y = +date.slice(0, 4);
    const mo = +date.slice(5, 7);
    const k = `${y}-${mo}`;
    const e = months.get(k) ?? { y, m: mo, harm: 0, raw: 0, unscaled: 0, ms: 0, viirs: 0, modis: 0, days: 0, allViirs: 0, anyNone: false };
    e.harm += d.harm;
    e.raw += d.raw;
    e.unscaled += d.unscaled;
    e.ms += d.mscaled;
    e.viirs += d.viirs;
    e.modis += d.modis;
    e.days++;
    if (d.basisViirs === n) e.allViirs++;
    if (d.basisNone > 0) e.anyNone = true;
    months.set(k, e);
    // Cross-check only on days where every region had VIIRS AND MODIS.
    if (d.basisViirs === n && d.mscaledRegions === n) {
      const o = overlap.get(y) ?? { vi: 0, ms: 0, days: 0 };
      o.vi += d.viirs;
      o.ms += d.mscaled;
      o.days++;
      overlap.set(y, o);
    }
  }
  let calendar = 'year,month,harmonized_cell_days,raw_detections,unscaled_cell_days,modis_scaled_cell_days,viirs_cell_days,modis_cell_days,source_mix,n_days,complete,harmonized_lo,harmonized_hi\n';
  for (const e of [...months.values()].sort((a, b) => a.y - b.y || a.m - b.m)) {
    let lo = 0, hi = 0;
    for (const r of regions) { const b = regionMonthBands.get(r.id)!.get(`${e.y}-${e.m}`); lo += b?.lo ?? 0; hi += b?.hi ?? 0; }
    calendar += `${e.y},${e.m},${fmt(e.harm, 2)},${e.raw},${e.unscaled},${fmt(e.ms, 2)},${e.viirs},${e.modis},${fmt(e.allViirs / e.days, 4)},${e.days},${e.days === daysInMonth(e.y, e.m) && !e.anyNone ? 1 : 0},${fmt(lo, 2)},${fmt(hi, 2)}\n`;
  }
  // Yearly totals and bands (complete years in the common range only).
  const years = [...new Set([...months.values()].map((e) => e.y))].sort((a, b) => a - b);
  let annual = 'year,harmonized_cell_days,harmonized_lo,harmonized_hi,scaled_cell_days\n';
  const annualRows: { y: number; h: number; lo: number; hi: number }[] = [];
  for (const y of years) {
    if (`${y}-01-01` < from || `${y}-12-31` > to) continue;
    let h = 0, lo = 0, hi = 0, sc = 0;
    for (const r of regions) {
      const ra = regionAnnual.get(r.id)!;
      const e = ra.ann.get(y) ?? { h: 0, s: 0 };
      h += e.h;
      sc += e.s;
      lo += ra.band ? e.h - e.s * (1 - ra.band[0]) : e.h;
      hi += ra.band ? e.h + e.s * (ra.band[1] - 1) : e.h;
    }
    annual += `${y},${fmt(h, 2)},${fmt(lo, 2)},${fmt(hi, 2)},${fmt(sc, 2)}\n`;
    annualRows.push({ y, h, lo, hi });
  }
  let ov = 'year,overlap_days,viirs_cell_days,modis_scaled_cell_days,ratio\n';
  for (const [y, o] of [...overlap.entries()].sort((a, b) => a[0] - b[0])) ov += `${y},${o.days},${o.vi},${fmt(o.ms, 2)},${fmt(o.vi ? o.ms / o.vi : null, 4)}\n`;
  const cols = Object.keys(summaries[0]);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'number' ? fmt(v, Number.isInteger(v) ? 0 : 4) : typeof v === 'boolean' ? (v ? 1 : 0) : String(v).includes(',') ? `"${v}"` : String(v));
  const summary = cols.join(',') + '\n' + summaries.map((s) => cols.map((c) => cell(s[c])).join(',')).join('\n') + '\n';

  const outDir = join(harmonizedDir, group);
  const outputs: Record<string, string> = {
    'daily_harmonized.csv': daily,
    'calendar_monthly.csv': calendar,
    'overlap_check.csv': ov,
    'regions_summary.csv': summary,
    'annual.csv': annual,
  };
  const meta: Record<string, { sha256: string; rows: number }> = {};
  for (const [p, c] of Object.entries(outputs)) {
    writeAtomic(join(outDir, p), c);
    meta[p] = { sha256: contentHashOfFile(p, Buffer.from(c)), rows: c.trim().split('\n').length - 1 };
  }
  const regionManifests = Object.fromEntries(
    regions.map((r) => [r.id, JSON.parse(readFileSync(join(harmonizedDir, r.id, 'manifest.json'), 'utf8')).outputs['daily_harmonized.csv']?.sha256 ?? null]),
  );
  writeAtomic(
    join(outDir, 'manifest.json'),
    JSON.stringify({ harmonizer_version: HARMONIZER_VERSION, group, regions: regions.map((r) => r.id), range: { from, to }, region_daily_sha256: regionManifests, outputs: meta }, null, 2) + '\n',
  );
  log(`${group}: ${regions.length} regions, ${from} → ${to}, ${sorted.length} days → ${outDir}`);
  return { from, to, summaries, annual: annualRows, overlap: [...overlap.entries()].sort((a, b) => a[0] - b[0]), months: [...months.values()] };
}
