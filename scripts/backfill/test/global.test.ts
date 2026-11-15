// Global coarse map layer: counts agree with the production cell-day builder; folder and zip
// inputs give identical output; finished units are skipped on re-run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as H from '../../../packages/harmonizer/src/index.ts';
import { REPO_ROOT } from '../src/config.ts';
import { runGlobal } from '../src/global.ts';

const work = mkdtempSync(join(tmpdir(), 'global-'));
after(() => rmSync(work, { recursive: true, force: true }));

function makeRaw(dir: string) {
  // Lay the fixtures out like the Country Yearly Summary downloads.
  mkdirSync(join(dir, 'modis', '2020'), { recursive: true });
  mkdirSync(join(dir, 'viirs-snpp', '2020'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'sample_api/modis_historical_sample.csv'), join(dir, 'modis', '2020', 'modis_2020_United_States.csv'));
  copyFileSync(join(REPO_ROOT, 'sample_api/viirs_snpp_historical_sample.csv'), join(dir, 'viirs-snpp', '2020', 'viirs-snpp_2020_United_States.csv'));
}
const opts = (rawDir: string, outDir: string) => ({ rawDir, outDir, fromYear: 2000, toYear: 2030, minStaticDetections: 3, force: false, stillWritingMs: 0, log: () => {} });
const read = (p: string) => readFileSync(p, 'utf8');

describe('global coarse map', () => {
  const raw = join(work, 'raw');
  makeRaw(raw);

  it('per-satellite cell-days and detections match buildCellDays on the same rows', async () => {
    const r = await runGlobal(opts(raw, join(work, 'out')));
    assert.deepEqual(r.manifest.units, ['2020_modis', '2020_viirs-snpp']);
    const rows = ['2020_modis', '2020_viirs-snpp'].flatMap((u) => read(join(work, 'out', `coarse_0.5/${u}.csv`)).trim().split('\n').slice(1).map((l) => l.split(',')));
    const got: Record<string, { cd: number; det: number }> = {};
    for (const x of rows) {
      const g = (got[x[4]] ??= { cd: 0, det: 0 });
      g.cd += +x[6];
      g.det += +x[7];
    }
    const all = ['modis_historical_sample.csv', 'viirs_snpp_historical_sample.csv'].flatMap((f) => [
      ...H.parseFirmsCsv(read(join(REPO_ROOT, 'sample_api', f)), { tier: 'SP' }),
    ]);
    const kept = [...H.filterDetections(all)];
    const cds = H.buildCellDays(kept);
    for (const sat of ['TERRA', 'AQUA', 'SNPP'] as H.Satellite[]) {
      assert.equal(got[sat].cd, cds.filter((c) => c.satellite === sat).length, `${sat} cell-days`);
      assert.equal(got[sat].det, kept.filter((d) => d.satellite === sat).length, `${sat} detections`);
    }
    assert.ok(rows.every((x) => Math.abs((+x[2] * 4) % 2) === 1 && Math.abs((+x[3] * 4) % 2) === 1)); // 0.5° centres
    assert.equal(r.safeToDelete.length, 2);
  });

  it('skips finished units on re-run', async () => {
    const r = await runGlobal(opts(raw, join(work, 'out')));
    assert.equal(r.processed, 0);
  });

  it('reads *_all_countries.zip in place, with identical output', { skip: spawnSync('zip', ['-v']).status !== 0 && 'zip not installed' }, async () => {
    const zdir = join(work, 'zips');
    mkdirSync(zdir, { recursive: true });
    for (const prod of ['modis', 'viirs-snpp']) spawnSync('zip', ['-qr', join(zdir, `${prod}_2020_all_countries.zip`), prod], { cwd: raw });
    const r = await runGlobal(opts(zdir, join(work, 'out-zip')));
    assert.equal(r.processed, 2);
    for (const u of ['2020_modis', '2020_viirs-snpp'])
      assert.equal(read(join(work, 'out-zip', `coarse_0.5/${u}.csv`)), read(join(work, 'out', `coarse_0.5/${u}.csv`)), u);
    assert.equal(read(join(work, 'out-zip', 'static_mask.csv')), read(join(work, 'out', 'static_mask.csv')));
  });
});
