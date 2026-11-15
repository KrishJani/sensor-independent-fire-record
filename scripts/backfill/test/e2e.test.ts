// End-to-end backfill on sample_api/: outputs, determinism, de-duplication, verify.
// Run: node --test "scripts/backfill/test/*.test.ts"
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPO_ROOT, getRegion, loadRegions } from '../src/config.ts';
import { runBackfill, verifyOutputs, type RunOptions } from '../src/pipeline.ts';

const work = mkdtempSync(join(tmpdir(), 'backfill-e2e-'));
after(() => rmSync(work, { recursive: true, force: true }));

function opts(name: string, rawDir: string): RunOptions {
  return {
    region: getRegion(loadRegions(), 'california'),
    from: '2020-08-15',
    to: '2020-08-19',
    rawDir,
    outDir: join(work, name),
    tmpDir: join(work, `tmp-${name}`),
    availabilityPath: null,
    calibrationYears: [2020, 2020],
    k: 50,
    minStaticDetections: 3,
    minMonthlyCells: 20,
    autoOutages: true,
    minOtherCellsForOutage: 20,
    bootstrapReps: 0,
    gridSensitivity: [],
    dryRun: false,
    log: () => {},
  };
}

describe('backfill e2e (sample_api)', () => {
  const sample = join(REPO_ROOT, 'sample_api');

  it('produces the expected calendar and α, and verifies', async () => {
    const r = await runBackfill(opts('a', sample));
    assert.equal(r.manifest.counts.nrt_rows_skipped, 10);
    assert.equal(r.manifest.counts.detections, 16042);
    assert.equal(r.manifest.counts.cell_days, 1058);
    assert.ok(Math.abs(r.alpha.TA[7].alpha - 399 / 289) < 1e-12);
    assert.deepEqual(r.detected.map((d) => `${d.satellite}:${d.acqDate}`), ['AQUA:2020-08-16', 'AQUA:2020-08-18']);
    const [cal] = r.calendar;
    assert.equal(cal.harmonizedCellDays, 31 + 56 + 79 + 120 + 289);
    // All 5 days are VIIRS days, so the raw count is every kept S-NPP detection.
    const snppDets = readFileSync(join(work, 'a', 'cell_days/2020.csv'), 'utf8')
      .split('\n').slice(1).filter((l) => l.includes(',SNPP,')).reduce((a, l) => a + +l.split(',')[7], 0);
    assert.equal(cal.rawDetections, snppDets);
    assert.equal(cal.unscaledCellDays, cal.harmonizedCellDays); // VIIRS days: no α applied
    assert.equal(cal.complete, false); // 5 of 31 days
    assert.equal(verifyOutputs(join(work, 'a')).ok, true);
  });

  it('is byte-identical on re-run', async () => {
    await runBackfill(opts('b', sample));
    for (const f of ['calendar_monthly.csv', 'alpha_monthly.csv', 'cell_days/2020.csv', 'manifest.json', 'validation.json']) {
      assert.equal(readFileSync(join(work, 'b', f), 'utf8'), readFileSync(join(work, 'a', f), 'utf8'), f);
    }
    assert.deepEqual(readFileSync(join(work, 'b', 'detections/2020.csv.gz')), readFileSync(join(work, 'a', 'detections/2020.csv.gz')));
  });

  it('removes duplicates when the same data is supplied twice', async () => {
    const raw = join(work, 'raw-dup');
    mkdirSync(join(raw, 'copy'), { recursive: true });
    for (const f of ['modis_historical_sample.csv', 'viirs_snpp_historical_sample.csv']) {
      copyFileSync(join(sample, f), join(raw, f));
      copyFileSync(join(sample, f), join(raw, 'copy', f));
    }
    const r = await runBackfill(opts('dup', raw));
    assert.equal(r.manifest.counts.duplicates_removed, 16042);
    assert.equal(r.manifest.counts.detections, 16042);
    assert.equal(readFileSync(join(work, 'dup', 'calendar_monthly.csv'), 'utf8'), readFileSync(join(work, 'a', 'calendar_monthly.csv'), 'utf8'));
  });

  it('--grid-sensitivity: 0.05° row reproduces production α; file is tracked, then removed when off', async () => {
    const o = { ...opts('sens', sample), gridSensitivity: [0.025, 0.05, 0.1] };
    const r = await runBackfill(o);
    assert.deepEqual(r.sensitivity!.rows.map((x) => x.gridDeg), [0.025, 0.05, 0.1]);
    const g05 = r.sensitivity!.rows.find((x) => x.gridDeg === 0.05)!;
    assert.deepEqual(g05.alphaTA, r.alpha.TA.map((a) => a.alpha));
    assert.ok(Math.abs(g05.pooledAlphaTA! - 399 / 289) < 1e-12);
    assert.equal(r.sensitivity!.recommended, null); // one calibration year → no LOYO
    assert.ok('grid_sensitivity.json' in r.manifest.outputs);
    assert.equal(verifyOutputs(join(work, 'sens')).ok, true);
    // Calendar and α are unaffected by the diagnostic.
    assert.equal(readFileSync(join(work, 'sens', 'calendar_monthly.csv'), 'utf8'), readFileSync(join(work, 'a', 'calendar_monthly.csv'), 'utf8'));
    await runBackfill(opts('sens', sample));
    assert.equal(existsSync(join(work, 'sens', 'grid_sensitivity.json')), false);
    assert.equal(verifyOutputs(join(work, 'sens')).ok, true);
  });

  it('verify detects tampering', () => {
    appendFileSync(join(work, 'b', 'calendar_monthly.csv'), '1999,1,0\n');
    const v = verifyOutputs(join(work, 'b'));
    assert.equal(v.ok, false);
    assert.match(v.problems.join(), /calendar_monthly/);
  });
});
