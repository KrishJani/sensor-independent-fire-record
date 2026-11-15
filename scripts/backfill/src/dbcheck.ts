// Post-load checks that the archive ANSWERS correctly (not just row counts).
//  1. Spec acceptance (api-worker SPEC §6): California Aug 2020 calendar in the DB == calendar_monthly.csv.
//  2. Rebuild from raw rows: for MODIS-only months, Σ_days α_eff · |Terra ∪ Aqua cells| recomputed in SQL from
//     cell_days + alpha_effective + source_availability == the stored harmonized value (what an AOI query does).
//  3. Speed: a 1°×1° AOI calendar over 2000–2025 from cell_months (spec target < 1.5 s cold).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './config.ts';

export async function dbCheck(sql: any, log: (m: string) => void) {
  let ok = true;
  const fail = (m: string) => { ok = false; log(`✗ ${m}`); };

  // 1
  const cal = readFileSync(join(REPO_ROOT, 'data/harmonized/california/calendar_monthly.csv'), 'utf8').trim().split('\n');
  const h = cal[0].split(',');
  const row = cal.find((l) => l.startsWith('2020,8,'))!.split(',');
  const fileVal = +row[h.indexOf('harmonized_cell_days')];
  const [db] = await sql`select harmonized_cell_days as v from calendar_monthly where scope = 'california' and year = 2020 and month = 8`;
  if (Math.abs(db.v - fileVal) < 0.01) log(`✓ California 2020-08: DB ${db.v} = file ${fileVal}`); else fail(`California 2020-08: DB ${db.v} ≠ file ${fileVal}`);

  // 2  (MODIS-only months of 2005, Terra∪Aqua days, in a few regions)
  for (const region of ['california', 'southeast', 'southwest']) {
    const rebuilt = await sql`
      with days as (
        select d.acq_date, d.modis_config from daily_harmonized d
        where d.scope = ${region} and d.basis = 'MODIS_SCALED' and d.acq_date between '2005-01-01' and '2005-12-31'),
      m as (
        select c.acq_date, count(distinct c.cell_id) as cells from cell_days c join days using (acq_date)
        where c.region_id = ${region} and c.satellite in ('TERRA', 'AQUA') and days.modis_config = 'TA'
        group by c.acq_date)
      select extract(month from days.acq_date)::int as month,
             sum(coalesce(m.cells, 0) * a.alpha_eff) as rebuilt
      from days left join m using (acq_date)
      join alpha_effective a on a.region_id = ${region} and a.config = days.modis_config
        and a.year = extract(year from days.acq_date) and a.month = extract(month from days.acq_date)
      where days.modis_config = 'TA'
      group by 1 order by 1`;
    const stored = await sql`select extract(month from acq_date)::int as month, sum(harmonized_cell_days) as v
      from daily_harmonized where scope = ${region} and basis = 'MODIS_SCALED' and modis_config = 'TA' and acq_date between '2005-01-01' and '2005-12-31' group by 1 order by 1`;
    const sm = new Map<number, number>(stored.map((r: any) => [r.month as number, Number(r.v)]));
    const worst = Math.max(...rebuilt.map((r: any) => Math.abs(Number(r.rebuilt) - (sm.get(r.month) ?? 0)) / Math.max(1, sm.get(r.month) ?? 0)));
    if (worst < 1e-3) log(`✓ ${region} 2005: SQL rebuild from cell_days × α_eff matches the stored calendar (worst ${(worst * 100).toFixed(4)}%)`);
    else fail(`${region} 2005: SQL rebuild differs from stored calendar by up to ${(worst * 100).toFixed(2)}%`);
  }

  // 3  1°×1° AOI near Sacramento (38–39°N, 122–121°W): rows 2560–2579, cols 1160–1179
  const t0 = Date.now();
  const aoi = await sql`select year, month, satellite, sum(cell_days)::int as cell_days from cell_months
    where grid_row between 2560 and 2579 and grid_col between 1160 and 1179 group by year, month, satellite`;
  const ms = Date.now() - t0;
  if (ms < 1500) log(`✓ 1°×1° AOI, 2000–2025 from cell_months: ${aoi.length} rows in ${ms} ms (target < 1500 ms; this includes network to PlanetScale)`);
  else fail(`1°×1° AOI took ${ms} ms (target < 1500 ms)`);
  return ok;
}
