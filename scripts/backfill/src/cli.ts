// Backfill CLI.
//   node --env-file-if-exists=.env scripts/backfill/src/cli.ts <command> [options]
// Commands: availability | download | run | verify   (see scripts/backfill/README.md)

import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getRegion, loadRegions, REPO_ROOT, SP_SOURCES } from './config.ts';
import { download, fetchAvailability } from './download.ts';
import { FirmsFatalError } from './firms.ts';
import { runBackfill, verifyOutputs } from './pipeline.ts';
import { DEFAULT_SENSITIVITY_GRIDS, fmt } from '../../../packages/harmonizer/src/index.ts';

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
    'grid-sensitivity': { type: 'boolean', default: false },
    'grid-sizes': { type: 'string', default: DEFAULT_SENSITIVITY_GRIDS.join(',') },
    'min-interval-ms': { type: 'string', default: '400' },
    'max-transactions': { type: 'string' },
    'no-auto-outages': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
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
        gridSensitivity: values['grid-sensitivity'] ? values['grid-sizes']!.split(',').map(Number) : [],
        dryRun: values['dry-run']!,
        log,
      });
      console.log('\nα (TA = Terra∪Aqua), VIIRS-equivalent cell-days per MODIS cell-day');
      console.log('month  alpha   local    w      ΣM      ΣV    90% CI');
      for (const a of res.alpha.TA)
        console.log(
          `${String(a.month).padStart(5)}  ${fmt(a.alpha, 3)}  ${(fmt(a.alphaLocal, 3) || '  —  ').padStart(5)}  ${fmt(a.w, 2)}  ${String(a.sumModis).padStart(6)}  ${String(a.sumViirs).padStart(6)}  ${a.ciLow === null ? '—' : `${fmt(a.ciLow, 2)}–${fmt(a.ciHigh, 2)}`}`,
        );
      const v = res.validation.configs.TA;
      console.log(`\nvalidation (TA): LOYO MdAPE ${fmt(v.loyo.mdape === null ? null : v.loyo.mdape * 100, 1) || 'n/a'}%  ` +
        `in-sample MdAPE ${fmt(v.inSample.mdape === null ? null : v.inSample.mdape * 100, 1) || 'n/a'}%  ` +
        `transition step ${fmt(v.continuity.medianStepPct === null ? null : v.continuity.medianStepPct * 100, 1) || 'n/a'}%  ` +
        `log-log β ${fmt(v.linearity.beta, 3) || 'n/a'}`);
      console.log('acceptance:', JSON.stringify(res.validation.acceptance));
      if (res.sensitivity) {
        const pct = (x: number | null) => (x === null ? 'n/a' : `${fmt(x * 100, 1)}%`);
        const yn = (x: boolean | null) => (x === null ? 'n/a' : x ? 'pass' : 'FAIL');
        console.log(`\ngrid-size sensitivity (TA, calibration ${res.sensitivity.calibrationYears.join('–')}; production grid 0.05°)`);
        console.log('grid     ~km   pooled α  LOYO MdAPE  in-sample  step    β (±SE)        proportional  no-step  coincidence');
        for (const r of res.sensitivity.rows)
          console.log(
            `${fmt(r.gridDeg, 3)}  ${fmt(r.approxKm, 1).padStart(5)}  ${(fmt(r.pooledAlphaTA, 3) || 'n/a').padStart(8)}  ${pct(r.loyoMdape).padStart(10)}  ${pct(r.inSampleMdape).padStart(9)}  ${pct(r.stepPct).padStart(6)}  ${(r.beta === null ? 'n/a' : `${fmt(r.beta, 2)} ±${fmt(r.betaSe, 2)}`).padEnd(13)}  ${yn(r.proportional).padEnd(12)}  ${yn(r.noStepAtTransition).padEnd(7)}  ${pct(r.coincidence)}`,
          );
        console.log(`recommended: ${res.sensitivity.recommended === null ? 'none' : `${res.sensitivity.recommended}°`} (${res.sensitivity.reason})`);
      }
      console.log('\ncalendar (last 12 months):');
      console.log('year-mo  harmonized  modis  viirs  mix   complete');
      for (const c of res.calendar.slice(-12))
        console.log(`${c.year}-${String(c.month).padStart(2, '0')}  ${fmt(c.harmonizedCellDays, 1).padStart(10)}  ${String(c.modisCellDays).padStart(5)}  ${String(c.viirsCellDays).padStart(5)}  ${fmt(c.sourceMix, 2)}  ${c.complete}`);
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
      throw new Error(`unknown command "${cmd}" (availability | download | run | verify)`);
  }
}

main().catch((e) => {
  console.error(e instanceof FirmsFatalError ? `FATAL: ${e.message}` : e);
  process.exitCode = 1;
});
