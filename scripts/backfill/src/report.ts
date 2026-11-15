// Before/after report page (docs/viz/<id>-before-after.html) for one region or a region group.
// Reads only the checked-in outputs in data/harmonized/, so the page is reproducible from git.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegionsConfig } from './config.ts';

function csv(path: string): Record<string, string>[] {
  const [h, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const cols = h.split(',');
  return rows.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
const num = (v: string | undefined) => (v === undefined || v === '' ? null : +v);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildReport(cfg: RegionsConfig, opts: { region?: string; group?: string }, repoRoot: string): string {
  const H = join(repoRoot, 'data/harmonized');
  const id = opts.group ?? opts.region!;
  const dir = join(H, id);
  if (!existsSync(join(dir, 'calendar_monthly.csv'))) throw new Error(`no outputs in ${dir}`);
  const cal = csv(join(dir, 'calendar_monthly.csv'));
  const range = `${cal[0].year}-${cal[0].month.padStart(2, '0')} → ${cal.at(-1)!.year}-${cal.at(-1)!.month.padStart(2, '0')}`;
  // [y, m, raw, unscaled, harmonized, mix, complete, modisScaled, nModisDays, viirs, nDays, lo, hi]
  const rows = cal.map((r) => [+r.year, +r.month, +r.raw_detections, +r.unscaled_cell_days, +(+r.harmonized_cell_days).toFixed(1), +(+r.source_mix).toFixed(3), +r.complete, +(+r.modis_scaled_cell_days).toFixed(1), num(r.n_modis_days) ?? +r.n_days, +r.viirs_cell_days, +r.n_days, num(r.harmonized_lo) === null ? null : +(+r.harmonized_lo).toFixed(1), num(r.harmonized_hi) === null ? null : +(+r.harmonized_hi).toFixed(1)]);

  const data: Record<string, unknown> = { rows };
  let title: string;
  let eyebrow: string;
  let intro: string;
  if (opts.group) {
    const regions = cfg.regions.filter((r) => r.group === opts.group);
    const summary = csv(join(dir, 'regions_summary.csv'));
    data.overlap = csv(join(dir, 'overlap_check.csv')).map((o) => ({ y: +o.year, vi: +o.viirs_cell_days, mod: +o.modis_scaled_cell_days }));
    data.annualBand = csv(join(dir, 'annual.csv')).map((a) => ({ y: +a.year, h: +a.harmonized_cell_days, lo: +a.harmonized_lo, hi: +a.harmonized_hi }));
    const dets = Object.fromEntries(regions.map((r) => [r.id, JSON.parse(readFileSync(join(H, r.id, 'manifest.json'), 'utf8')).counts.detections as number]));
    const tot = Object.values(dets).reduce((a, b) => a + b, 0);
    data.regions = summary.map((s) => ({
      id: s.region,
      name: s.name.replace(/^"|"$/g, ''),
      share: dets[s.region] / tot,
      kind: s.kind,
      beta: num(s.beta),
      ci: s.beta_ci_low ? [+s.beta_ci_low, +s.beta_ci_high] : null,
      loyo: num(s.loyo_mdape),
      loyo1: num(s.loyo_mdape_constant_ratio),
      top: num(s.top10_bias),
      top1: num(s.top10_bias_constant_ratio),
      bot: num(s.bottom25_bias),
      bot1: num(s.bottom25_bias_constant_ratio),
      step: num(s.transition_step),
      acc: [s.acc_loyo, s.acc_no_step, s.acc_unbiased].map((x) => (x === '' ? null : x === '1')),
      bg: num(s.background_share),
      noisePct: num(s.noise_residual_beta_pct),
      biasCheck: s.bias_check,
      band: s.band_year_lo ? [+s.band_year_lo, +s.band_year_hi] : null,
      confidence: s.confidence,
      confidenceReason: s.confidence_reason,
    }));
    data.caveat = `<b>How the total is built.</b> Each region's α has two parts: a background of small, cool fires that only VIIRS detects, and the MODIS-visible fires scaled by an exponent that lets busy months differ from quiet ones. Bands show the 90% range from held-out years; they apply only to MODIS-only days (VIIRS days are observed), and the US band adds the region bands, which is conservative.`;
    data.caveat += ` `;
    data.caveat += `<b>Regions.</b> The ${regions.length} regions do not overlap: each is a box minus the boxes listed before it, and 99.9999% of US detections fall in exactly one region (the rest are 8 detections on the far Aleutians, across the date line). Each region gets its own activity-dependent α, because fire regimes differ: the Southeast's many small prescribed and agricultural burns are mostly seen only by VIIRS, while large Western wildfires saturate both sensors. Harmonized counts are additive, so the total is exactly the sum of the regions. Data: ${tot.toLocaleString('en-US')} filtered detections.`;
    title = `${opts.group.toUpperCase()} Fire Calendar`;
    eyebrow = `NASA FIRMS · MODIS + VIIRS · ${regions.length} regions · ${range}`;
    intro = `The same ${opts.group.toUpperCase()} fire record, three ways, as the sum of ${regions.length} separately calibrated regions. Each day and region uses one sensor family: MODIS before VIIRS existed, VIIRS from 20 January 2012. The panels differ only in what we do to those numbers. Hover any month for the values.`;
  } else {
    const region = cfg.regions.find((r) => r.id === opts.region)!;
    const M = JSON.parse(readFileSync(join(dir, 'alpha_model.json'), 'utf8')).model.TA;
    const v = JSON.parse(readFileSync(join(dir, 'validation.json'), 'utf8')).configs.TA;
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const alphaAt = (i: number, r: number) => {
      r = Math.min(Math.max(r, M.rateMin[i]), M.rateMax[i]);
      return Math.min(10, Math.max(0.5, Math.exp(M.a[i] + (M.beta - 1) * Math.log(r))));
    };
    data.alpha = M.alphaTypical.map((a: number, i: number) => [a, M.alphaTypicalCi[i]?.[0] ?? null, M.alphaTypicalCi[i]?.[1] ?? null, alphaAt(i, M.rateMin[i]), alphaAt(i, M.rateMax[i])]);
    data.model = { beta: M.beta, betaCi: M.betaCi ?? [M.beta, M.beta], f: M.test?.f ?? 0, p: M.test?.p ?? 1, bg: M.backgroundShare ?? 0, df: M.test?.df ?? 1 };
    data.val = {
      loyo: v.loyo.mdape, loyo1: v.loyoConstantRatio.mdape,
      top: v.loyo.topDecileBias, top1: v.loyoConstantRatio.topDecileBias,
      bot: v.loyo.bottomQuartileBias, bot1: v.loyoConstantRatio.bottomQuartileBias,
      rb: v.loyo.residualBeta, rb1: v.loyoConstantRatio.residualBeta, step: v.continuity.medianStepPct,
    };
    data.n = { det: m.counts.detections, cd: m.counts.cell_days };
    data.noise = v.noise ? { pct: v.noise.realResidualBetaPct, rb: v.noise.residualBeta, md: v.noise.mdape } : null;
    data.confidence = JSON.parse(readFileSync(join(dir, 'validation.json'), 'utf8')).confidence ?? null;
    // Annual 90% band: annual factors applied to each year's MODIS-scaled part.
    const ab = v.uncertainty?.annual ?? null;
    const byY = new Map<number, { h: number; s: number }>();
    for (const r of cal) { const e = byY.get(+r.year) ?? { h: 0, s: 0 }; e.h += +r.harmonized_cell_days; e.s += num(r.scaled_cell_days) ?? 0; byY.set(+r.year, e); }
    data.annualBand = [...byY.entries()].map(([y, e]) => ({ y, h: e.h, lo: ab ? e.h - e.s * (1 - ab[0]) : e.h, hi: ab ? e.h + e.s * (ab[1] - 1) : e.h }));
    data.bandYear = ab;
    const short = region.name.replace(/\s*\(.*\)$/, '');
    title = `${short} Fire Calendar`;
    eyebrow = `NASA FIRMS · MODIS + VIIRS · ${short} · ${range}`;
    intro = `The same ${short} fire record, three ways. Each day uses one sensor family: MODIS before VIIRS existed, VIIRS from 20 January 2012. The panels differ only in what we do to those numbers. Hover any month for the values.`;
  }
  const tpl = readFileSync(join(repoRoot, 'docs/viz/before-after.template.html'), 'utf8');
  const out = join(repoRoot, 'docs/viz', `${id.replace(/_/g, '-')}-before-after.html`);
  writeFileSync(
    out,
    tpl
      .replace('__TITLE__', esc(title))
      .replace('__EYEBROW__', esc(eyebrow))
      .replace('__INTRO__', esc(intro))
      .replace('__DATA__', JSON.stringify(data)),
  );
  return out;
}
