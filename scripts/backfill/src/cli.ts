// Backfill CLI.
//   node --env-file-if-exists=.env scripts/backfill/src/cli.ts <command> [options]
// Commands: availability | download | run | verify   (see scripts/backfill/README.md)

import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { excludedBboxes, getRegion, loadRegions, REPO_ROOT, SP_SOURCES } from './config.ts';
import { download, fetchAvailability } from './download.ts';
import { FirmsFatalError } from './firms.ts';
import { runBackfill, verifyOutputs } from './pipeline.ts';
import { runGlobal } from './global.ts';
import { aggregateGroup } from './aggregate.ts';
import { buildReport } from './report.ts';
import { buildFlareCells, loadFlareCells } from './flares.ts';
import { buildIndustrialHeat } from './industrial.ts';
import { connect, dbSummary, loadGlobal, loadGroup, loadProne, loadRegion, migrate } from './load.ts';
import { bumpArchivalVersion, newArchivalVersion } from './kv.ts';
import { dbCheck } from './dbcheck.ts';
import { runProne } from './prone.ts';
import { DEFAULT_SENSITIVITY_GRIDS, alphaAt, fmt } from '../../../packages/harmonizer/src/index.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    region: { type: 'string', default: 'california' },
    from: { type: 'string', default: '2000-11-01' },
    to: { type: 'string' },
    'raw-dir': { type: 'string' },
    'out-dir': { type: 'string' },
    sources: { type: 'string', default: SP_SOURCES.join(',') },
    'calibration-years': { type: 'string' },
    'bootstrap-reps': { type: 'string', default: '1000' },
    'noise-sims': { type: 'string', default: '200' },
    'grid-sensitivity': { type: 'boolean', default: false },
    'grid-sizes': { type: 'string', default: DEFAULT_SENSITIVITY_GRIDS.join(',') },
    'min-interval-ms': { type: 'string', default: '400' },
    'max-transactions': { type: 'string' },
    'no-auto-outages': { type: 'boolean', default: false },
    'no-flare-mask': { type: 'boolean', default: false },
    'no-flare-inventory': { type: 'boolean', default: false },
    inventory: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    group: { type: 'string', default: 'us' },
    global: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    prone: { type: 'boolean', default: false },
    'no-kv': { type: 'boolean', default: false },
    'summary-only': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

const cmd = positionals[0] ?? 'run';
const cfg = loadRegions();
const region = getRegion(cfg, values.region!);
const abs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
const rawDir = values['raw-dir'] ? abs(values['raw-dir']) : join(REPO_ROOT, 'data/raw', region.id);
const outDir = values['out-dir'] ? abs(values['out-dir']) : join(REPO_ROOT, 'data/harmonized', region.id);
const availabilityPath = join(REPO_ROOT, 'data/raw/availability.csv');
const today = new Date().toISOString().slice(0, 10);
const to = values.to ?? today;
const log = values.quiet ? () => {} : (m: string) => console.error(`[backfill] ${m}`);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
if (!isDate(values.from!) || !isDate(to) || values.from! > to) throw new Error(`bad --from/--to: ${values.from} ${to}`);

async function main() {
  const mapKey = process.env.FIRMS_MAP_KEY ?? '';
  switch (cmd) {
    case 'availability': {
      const a = await fetchAvailability(mapKey, availabilityPath, log);
      for (const s of [...SP_SOURCES, 'MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']) {
        const r = a.get(s);
        console.log(`${s.padEnd(18)} ${r ? `${r.min} → ${r.max}` : '(not listed)'}`);
      }
      return;
    }
    case 'download':
      await download({
        region,
        from: values.from!,
        to,
        sources: values.sources!.split(','),
        rawDir,
        availabilityPath,
        mapKey,
        minIntervalMs: +values['min-interval-ms']!,
        maxTransactions: values['max-transactions'] ? +values['max-transactions'] : undefined,
        log,
      });
      return;
    case 'run': {
      const cy = values['calibration-years']?.split('-').map(Number) as [number, number] | undefined;
      const res = await runBackfill({
        region,
        excludeBboxes: excludedBboxes(cfg, region),
        from: values.from!,
        to,
        rawDir,
        outDir,
        tmpDir: join(REPO_ROOT, 'data/tmp', region.id),
        availabilityPath,
        calibrationYears: cy ?? cfg.calibrationYears,
        k: cfg.alphaShrinkageK,
        minStaticDetections: cfg.staticMaskMinDetections,
        minMonthlyCells: cfg.minMonthlyCellsForValidation,
        autoOutages: !values['no-auto-outages'],
        minOtherCellsForOutage: 20,
        bootstrapReps: +values['bootstrap-reps']!,
        noiseSims: +values['noise-sims']!,
        flareMask: values['no-flare-mask'] ? null : cfg.flareMask ?? null,
        inventoryFlareCells: values['no-flare-inventory'] || !cfg.flareInventory ? null : await loadFlareCells(join(REPO_ROOT, cfg.flareInventory.cells)),
        gridSensitivity: values['grid-sensitivity'] ? values['grid-sizes']!.split(',').map(Number) : [],
        dryRun: values['dry-run']!,
        log,
      });
      const mt = res.model.TA;
      const pc = (x: number | null) => (x === null ? 'n/a' : `${fmt(x * 100, 1)}%`.padStart(6));
      console.log(`\nα model (TA = Terra∪Aqua): ${mt.kind === 'glm' ? 'two-component (VIIRS-only background + activity-scaled MODIS)' : 'constant ratio'}` +
        `  β = ${fmt(mt.beta, 3)}${mt.betaCi ? ` (90% CI ${fmt(mt.betaCi[0], 3)}–${fmt(mt.betaCi[1], 3)})` : ''}` +
        `  background = ${fmt(mt.backgroundShare * 100, 1)}% of VIIRS` +
        (mt.test ? `\n  test vs constant ratio: F(${mt.test.df}) = ${fmt(mt.test.f, 1)}, p = ${mt.test.p < 1e-4 ? '<0.0001' : fmt(mt.test.p, 4)}` : '') +
        (mt.reason ? `\n  note: ${mt.reason}` : ''));
      console.log('month  α typical  (90% CI)     α quiet  α busy   cells/day (min–typ–max)');
      for (let i = 0; i < 12; i++) {
        const ci = mt.alphaTypicalCi[i];
        console.log(`${String(i + 1).padStart(5)}  ${fmt(mt.alphaTypical[i], 3).padStart(9)}  ${(ci ? `${fmt(ci[0], 2)}–${fmt(ci[1], 2)}` : '—').padEnd(11)}  ${fmt(alphaAt(mt, i + 1, mt.rateMin[i]), 2).padStart(7)}  ${fmt(alphaAt(mt, i + 1, mt.rateMax[i]), 2).padStart(6)}   ${fmt(mt.rateMin[i], 1)}–${fmt(mt.typicalRate[i], 1)}–${fmt(mt.rateMax[i], 1)}`);
      }
      const v = res.validation.configs.TA;
      console.log('\nvalidation (TA, monthly totals)        MdAPE   top-10%  bottom-25%  total   residual β');
      for (const [name, sc] of [['in-sample', v.inSample], ['leave-one-year-out', v.loyo], ['  constant ratio (β = 1), LOYO', v.loyoConstantRatio]] as const)
        console.log(`  ${name.padEnd(34)} ${pc(sc.mdape)}  ${pc(sc.topDecileBias)}  ${pc(sc.bottomQuartileBias).padStart(9)}  ${pc(sc.totalBias)}  ${sc.residualBeta === null ? 'n/a' : `${fmt(sc.residualBeta, 3)} ±${fmt(sc.residualBetaSe, 3)}`}`);
      console.log(`  transition step ${pc(v.continuity.medianStepPct)}  (worst year ${pc(v.continuity.worstYearPct)})`);
      if (v.noise) console.log(`  noise check (${v.noise.sims} sims, dispersion ${fmt(v.noise.dispersion, 1)}): a correct model scores residual β ${fmt(v.noise.residualBeta[0], 2)}–${fmt(v.noise.residualBeta[2], 2)}, error ${pc(v.noise.mdape[0]).trim()}–${pc(v.noise.mdape[2]).trim()}; real residual β at percentile ${fmt(v.noise.realResidualBetaPct, 0)}`);
      if (v.uncertainty) console.log(`  90% band on MODIS-scaled values: month ×${fmt(v.uncertainty.monthly[0], 2)}–${fmt(v.uncertainty.monthly[1], 2)}, year ×${fmt(v.uncertainty.annual[0], 2)}–${fmt(v.uncertainty.annual[1], 2)}`);
      console.log(`  confidence: ${res.validation.confidence.level}${res.validation.confidence.reason ? ` (${res.validation.confidence.reason})` : ''};  bias check: ${res.validation.biasCheck}`);
      console.log('acceptance:', JSON.stringify(res.validation.acceptance));
      if (res.sensitivity) {
        const pct = (x: number | null) => (x === null ? 'n/a' : `${fmt(x * 100, 1)}%`);
        const yn = (x: boolean | null) => (x === null ? 'n/a' : x ? 'pass' : 'FAIL');
        console.log(`\ngrid-size sensitivity (TA, calibration ${res.sensitivity.calibrationYears.join('–')}; production grid 0.05°)`);
        console.log('grid     ~km   pooled α  LOYO MdAPE  in-sample  step    β · resid β    unbiased      no-step  coincidence');
        for (const r of res.sensitivity.rows)
          console.log(
            `${fmt(r.gridDeg, 3)}  ${fmt(r.approxKm, 1).padStart(5)}  ${(fmt(r.pooledAlphaTA, 3) || 'n/a').padStart(8)}  ${pct(r.loyoMdape).padStart(10)}  ${pct(r.inSampleMdape).padStart(9)}  ${pct(r.stepPct).padStart(6)}  ${(r.beta === null ? 'n/a' : `${fmt(r.beta, 2)} · ${fmt(r.betaSe, 2)}`).padEnd(13)}  ${yn(r.proportional).padEnd(12)}  ${yn(r.noStepAtTransition).padEnd(7)}  ${pct(r.coincidence)}`,
          );
        console.log(`recommended: ${res.sensitivity.recommended === null ? 'none' : `${res.sensitivity.recommended}°`} (${res.sensitivity.reason})`);
      }
      console.log('\ncalendar (last 12 months):');
      console.log('year-mo  harmonized  modis  viirs  mix   complete');
      for (const c of res.calendar.slice(-12))
        console.log(`${c.year}-${String(c.month).padStart(2, '0')}  ${fmt(c.harmonizedCellDays, 1).padStart(10)}  ${String(c.modisCellDays).padStart(5)}  ${String(c.viirsCellDays).padStart(5)}  ${fmt(c.sourceMix, 2)}  ${c.complete}`);
      return;
    }
    case 'global': {
      // Global, NOT harmonized, map layer from FIRMS Country Yearly Summary files.
      const g = await runGlobal({
        rawDir: values['raw-dir'] ? abs(values['raw-dir']) : join(REPO_ROOT, 'data/raw/global'),
        outDir: values['out-dir'] ? abs(values['out-dir']) : join(REPO_ROOT, 'data/global'),
        fromYear: +values.from!.slice(0, 4),
        toYear: +to.slice(0, 4),
        minStaticDetections: cfg.staticMaskMinDetections,
        force: values.force!,
        log,
      });
      console.log(`\nunits on disk (${g.manifest.units.length}): ${g.manifest.units.join(' ')}`);
      console.log(`\nfully processed — safe to delete (${g.safeToDelete.length}):\n  ${g.safeToDelete.join('\n  ') || '(none)'}`);
      if (g.pending.length) console.log(`\nnot finished — keep (${g.pending.length}):\n  ${g.pending.join('\n  ')}`);
      return;
    }
    case 'aggregate': {
      const g = await aggregateGroup(cfg, values.group!, join(REPO_ROOT, 'data/harmonized'), log);
      const pc = (x: unknown) => (typeof x === 'number' ? `${fmt(x * 100, 1)}%` : 'n/a').padStart(7);
      console.log(`\n${values.group} = sum of ${g.summaries.length} regions, ${g.from} → ${g.to}\n`);
      console.log('region               model   β      LOYO   (β=1)   busiest (β=1)    quietest (β=1)    step   accept');
      for (const s of g.summaries as Record<string, number | string | boolean | null>[])
        console.log(`${String(s.region).padEnd(19)}  ${String(s.kind).padEnd(5)}  ${fmt(s.beta as number, 3)}  ${pc(s.loyo_mdape)} ${pc(s.loyo_mdape_constant_ratio)}  ${pc(s.top10_bias)} ${pc(s.top10_bias_constant_ratio)}  ${pc(s.bottom25_bias)} ${pc(s.bottom25_bias_constant_ratio)}  ${pc(s.transition_step)}   ${[s.acc_loyo, s.acc_no_step, s.acc_unbiased].map((x) => (x === null ? '–' : x ? '✓' : '✗')).join('')}`);
      console.log('\nMODIS × α vs observed VIIRS, whole group, days where every region had both:');
      for (const [y, o] of g.overlap) console.log(`  ${y}  VIIRS ${String(o.vi).padStart(7)}  MODIS×α ${fmt(o.ms, 0).padStart(7)}  ${o.vi ? ((o.ms / o.vi - 1) * 100 >= 0 ? '+' : '') + fmt((o.ms / o.vi - 1) * 100, 1) + '%' : ''}`);
      return;
    }
    case 'load': {
      // node --env-file=.env scripts/backfill/src/cli.ts load --region <id> | --group us | --global | --all [--prone] [--no-kv] [--summary-only]
      // After a successful load, data:version:archival is bumped in KV so the API's caches miss (skip with --no-kv).
      // --summary-only: from the files in git alone (no detections or cell_days); with --all it skips the global layer.
      const summaryOnly = values['summary-only']!;
      const sql = await connect();
      try {
        await migrate(sql, log);
        const explicitRegion = process.argv.includes('--region');
        if (values.all) {
          for (const r of cfg.regions) await loadRegion(sql, cfg, r, log, summaryOnly);
          for (const g of [...new Set(cfg.regions.map((r) => r.group).filter(Boolean))] as string[]) await loadGroup(sql, g, log);
          if (summaryOnly) log('summary-only: global layer skipped');
          else await loadGlobal(sql, cfg, log);
          if (values.prone) await loadProne(sql, values.group!, log);
        } else {
          if (explicitRegion) await loadRegion(sql, cfg, region, log, summaryOnly);
          if (process.argv.includes('--group')) await loadGroup(sql, values.group!, log);
          if (values.global) await loadGlobal(sql, cfg, log);
          if (process.argv.includes('--prone')) await loadProne(sql, values.group!, log);
        }
        if (!values['no-kv']) {
          const what = values.all ? 'all' : [explicitRegion && `region=${region.id}`, process.argv.includes('--group') && `group=${values.group}`, values.global && 'global', values.prone && 'prone'].filter(Boolean).join(',');
          bumpArchivalVersion(newArchivalVersion(what), log);
        }
        const s = await dbSummary(sql);
        console.log(`\ndatabase size ${s.size}`);
        for (const t of s.tables) console.log(`  ${String(t.table).padEnd(24)} ${Number(t.rows).toLocaleString().padStart(12)} rows  ${t.size}`);
      } finally {
        await sql.end();
      }
      return;
    }
    case 'prone': {
      // node scripts/backfill/src/cli.ts prone --group us   (years 2001–2025: complete years of every region)
      const res = await runProne(cfg, values.group!, [2001, 2025], log);
      const top = res.results.filter((t) => t.proneClass === 'very_high').sort((a, b) => b.giZ - a.giZ).slice(0, 10);
      console.log('\nmost significant very-high tiles:');
      for (const t of top) console.log(`  ${t.lat.toFixed(2)}, ${t.lon.toFixed(2)}  z ${t.giZ.toFixed(1)}  ${t.why}`);
      return;
    }
    case 'db-check': {
      const sql = await connect();
      try { if (!(await dbCheck(sql, log))) process.exitCode = 1; } finally { await sql.end(); }
      return;
    }
    case 'industrial-heat': {
      await buildIndustrialHeat({ region, excludeBboxes: excludedBboxes(cfg, region), rawDir, outDir, log });
      return;
    }
    case 'flare-cells': {
      // node scripts/backfill/src/cli.ts flare-cells --inventory data/raw/flares/eog-myc25q4/annual_flare_site_records.csv
      const inv = values.inventory ? abs(values.inventory) : join(REPO_ROOT, 'data/raw/flares/eog-myc25q4/annual_flare_site_records.csv');
      await buildFlareCells({ inventory: inv, out: join(REPO_ROOT, cfg.flareInventory!.cells), bufferDeg: cfg.flareInventory!.bufferDeg, log });
      return;
    }
    case 'report': {
      // --group us  or  --region california  → docs/viz/<id>-before-after.html
      const asGroup = process.argv.includes('--group');
      console.log(buildReport(cfg, asGroup ? { group: values.group! } : { region: region.id }, REPO_ROOT));
      return;
    }
    case 'verify': {
      const r = verifyOutputs(outDir);
      if (r.ok) console.log(`verify OK: ${outDir}`);
      else {
        console.error(`verify FAILED:\n  ${r.problems.join('\n  ')}`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}" (availability | download | run | global | aggregate | report | flare-cells | industrial-heat | load | db-check | prone | verify)`);
  }
}

main().catch((e) => {
  console.error(e instanceof FirmsFatalError ? `FATAL: ${e.message}` : e);
  process.exitCode = 1;
});
