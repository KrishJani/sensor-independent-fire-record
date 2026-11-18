// Load checked-in outputs into the archival Postgres over a DIRECT connection
// (DATABASE_URL in .env; Hyperdrive is for Workers). Idempotent: each region/scope is replaced inside one
// transaction (delete, then COPY), so re-running never duplicates and a failure leaves the old data.
//
//   load --region <id>    one region: detections (fire + industrial), cell_days → cell_months, availability,
//                         α model + α applied, daily/monthly/annual calendars, static mask, manifest, validation
//   load --group us       group calendars (daily, monthly, annual)
//   load --global         global 0.5° map layer + global static mask + flare-inventory cells
//   --summary-only        regions only: skip detections, cell_days and cell_months, which are not in git.
//                         Calendars, α, availability, masks and prone tiles load; map hot spots and
//                         calendars for drawn areas need the full load.
//
// Every load ends with row-count checks against the manifests.

import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { REPO_ROOT, type Region, type RegionsConfig } from './config.ts';
import { verifyOutputs } from './pipeline.ts';

type Sql = any; // postgres.js client (typed loosely: it is a runtime dependency of the workers)

export async function connect(): Promise<Sql> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set (add it to .env; run with node --env-file=.env)');
  const u = new URL(raw);
  // Some providers' strings carry sslrootcert=system (a libpq hint); postgres.js would send it to the server.
  u.searchParams.delete('sslrootcert');
  const { default: postgres } = await import('postgres');
  return postgres(u.toString(), { max: 4, ssl: 'require', onnotice: () => {}, connect_timeout: 30, idle_timeout: 60 });
}

export async function migrate(sql: Sql, log: (m: string) => void) {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const dir = join(REPO_ROOT, 'packages/db/postgres');
  const done = new Set((await sql`select version from schema_migrations`).map((r: { version: string }) => r.version));
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort()) {
    if (done.has(f)) continue;
    await sql.begin(async (tx: Sql) => {
      await tx.unsafe(readFileSync(join(dir, f), 'utf8'));
      await tx`insert into schema_migrations (version) values (${f})`;
    });
    log(`migration applied: ${f}`);
  }
}

/** Lines of a .csv or .csv.gz, header first, skipping '#' comment lines. */
async function* lines(path: string): AsyncGenerator<string> {
  const src = path.endsWith('.gz') ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  for await (const l of createInterface({ input: src, crlfDelay: Infinity })) if (l && !l.startsWith('#')) yield l;
}

/**
 * COPY rows into `table (cols)`. `map(fields, header)` returns the output fields (already in `cols` order)
 * or null to skip. Returns the row count.
 */
async function copyFiles(tx: Sql, table: string, cols: string[], files: string[], map: (f: string[], h: string[]) => (string | number | null)[] | null): Promise<number> {
  let n = 0;
  const esc = (v: string | number | null) => (v === null || v === '' ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  async function* rows() {
    for (const file of files) {
      let header: string[] | null = null;
      for await (const l of lines(file)) {
        const f = l.split(',');
        if (!header) { header = f; continue; }
        const out = map(f, header);
        if (!out) continue;
        n++;
        yield out.map(esc).join(',') + '\n';
      }
    }
  }
  const w = await tx.unsafe(`copy ${table} (${cols.join(', ')}) from stdin with (format csv)`).writable();
  await pipeline(Readable.from(rows()), w);
  return n;
}

const ix = (h: string[], name: string) => {
  const i = h.indexOf(name);
  if (i < 0) throw new Error(`column ${name} missing (have: ${h.join(',')})`);
  return i;
};

const BULK = /^missing (cell_days|detections)\//;

export async function loadRegion(sql: Sql, cfg: RegionsConfig, region: Region, log: (m: string) => void, summaryOnly = false) {
  const D = join(REPO_ROOT, 'data/harmonized', region.id);
  const v = verifyOutputs(D);
  const problems = summaryOnly ? v.problems.filter((p) => !BULK.test(p)) : v.problems;
  if (problems.length) throw new Error(`${region.id}: outputs fail verify — not loading:\n  ${problems.join('\n  ')}`);
  const manifest = JSON.parse(readFileSync(join(D, 'manifest.json'), 'utf8'));
  const validation = JSON.parse(readFileSync(join(D, 'validation.json'), 'utf8'));
  const model = JSON.parse(readFileSync(join(D, 'alpha_model.json'), 'utf8')).model;
  const ihDir = join(D, 'industrial_heat');
  const ihManifest = existsSync(join(ihDir, 'manifest.json')) ? JSON.parse(readFileSync(join(ihDir, 'manifest.json'), 'utf8')) : null;
  if (!ihManifest && !summaryOnly) log(`${region.id}: no industrial_heat/ (run \`backfill industrial-heat --region ${region.id}\`); loading fire only`);
  const files = (sub: string, re: RegExp) => (existsSync(join(D, sub)) ? readdirSync(join(D, sub)).filter((n) => re.test(n)).sort().map((n) => join(D, sub, n)) : []);
  const t0 = Date.now();
  const counts: Record<string, number> = {};

  await sql.begin(async (tx: Sql) => {
    await tx`delete from regions where region_id = ${region.id}`; // cascades to all region tables
    for (const t of ['daily_harmonized', 'calendar_monthly', 'annual_harmonized']) await tx.unsafe(`delete from ${t} where scope = $1`, [region.id]);
    await tx`insert into regions ${tx({
      region_id: region.id,
      name: region.name,
      group_id: region.group ?? null,
      bbox: region.bbox,
      exclude: region.exclude ?? [],
      harmonizer_version: manifest.harmonizer_version,
      range_from: manifest.range.from,
      range_to: manifest.range.to,
      manifest: tx.json(manifest),
      validation: tx.json(validation),
    })}`;

    if (!summaryOnly) {
      // detections: fire, then industrial heat (with reason)
      const detCols = ['lat', 'lon', 'acq_date', 'acq_time', 'satellite', 'sensor', 'tier', 'confidence', 'frp_mw', 'day_night', 'fire_type', 'version', 'cell_id', 'hv'];
      counts.fire = await copyFiles(tx, 'detections', [...detCols, 'region_id', 'heat_class'], files('detections', /^\d{4}\.csv\.gz$/), (f) => [...f.slice(0, 14), region.id, 'fire']);
      counts.industrial = await copyFiles(tx, 'detections', [...detCols, 'heat_reason', 'region_id', 'heat_class'], files('industrial_heat', /^\d{4}\.csv\.gz$/), (f) => [...f.slice(0, 15), region.id, 'industrial']);

      // cell_days (drop grid_lat/grid_lon: row/col are generated from cell_id)
      counts.cell_days = await copyFiles(
        tx, 'cell_days',
        ['acq_date', 'cell_id', 'satellite', 'sensor', 'tier', 'n_detections', 'n_passes', 'peak_frp_mw', 'sum_frp_mw', 'first_time', 'last_time', 'hv', 'region_id'],
        files('cell_days', /^\d{4}\.csv$/),
        (f) => [f[0], f[1], f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11], f[12], f[13], region.id],
      );
      await tx`
        insert into cell_months (region_id, year, month, cell_id, satellite, sensor, cell_days, n_detections, peak_frp_mw, last_date)
        select region_id, extract(year from acq_date)::smallint, extract(month from acq_date)::smallint, cell_id, satellite, min(sensor),
               count(*)::smallint, sum(n_detections)::int, max(peak_frp_mw), max(acq_date)
        from cell_days where region_id = ${region.id}
        group by region_id, 2, 3, cell_id, satellite`;
      counts.cell_months = (await tx`select count(*)::int as n from cell_months where region_id = ${region.id}`)[0].n;
    }

    counts.availability = await copyFiles(tx, 'source_availability', ['satellite', 'acq_date', 'region_id'], [join(D, 'source_availability.csv')], (f) => [f[0], f[1], region.id]);

    for (const config of Object.keys(model)) await tx`insert into alpha_models ${tx({ region_id: region.id, config, kind: model[config].kind, model: tx.json(model[config]) })}`;
    counts.alpha_effective = await copyFiles(tx, 'alpha_effective', ['year', 'month', 'config', 'modis_cells_per_day', 'alpha_eff', 'region_id'], [join(D, 'alpha_effective.csv')], (f) => [f[0], f[1], f[2], f[3], f[4], region.id]);

    counts.daily = await copyFiles(
      tx, 'daily_harmonized',
      ['acq_date', 'harmonized_cell_days', 'raw_detections', 'unscaled_cell_days', 'modis_scaled_cell_days', 'viirs_cell_days', 'modis_cell_days', 'basis', 'alpha', 'modis_config', 'viirs_reference', 'peak_frp_mw', 'peak_frp_sensor', 'scope'],
      [join(D, 'daily_harmonized.csv')],
      (f, h) => [f[ix(h, 'acq_date')], f[ix(h, 'harmonized_cell_days')], f[ix(h, 'raw_detections')], f[ix(h, 'unscaled_cell_days')], f[ix(h, 'modis_scaled_cell_days')], f[ix(h, 'viirs_cell_days')], f[ix(h, 'modis_cell_days')], f[ix(h, 'basis')], f[ix(h, 'alpha')], f[ix(h, 'modis_config')], f[ix(h, 'viirs_reference')], f[ix(h, 'peak_frp_mw')], f[ix(h, 'peak_frp_sensor')], region.id],
    );
    counts.calendar = await copyFiles(
      tx, 'calendar_monthly',
      ['year', 'month', 'harmonized_cell_days', 'harmonized_lo', 'harmonized_hi', 'raw_detections', 'unscaled_cell_days', 'modis_scaled_cell_days', 'viirs_cell_days', 'modis_cell_days', 'source_mix', 'n_days', 'complete', 'peak_frp_mw', 'peak_frp_sensor', 'scope'],
      [join(D, 'calendar_monthly.csv')],
      (f, h) => [f[ix(h, 'year')], f[ix(h, 'month')], f[ix(h, 'harmonized_cell_days')], f[ix(h, 'harmonized_lo')], f[ix(h, 'harmonized_hi')], f[ix(h, 'raw_detections')], f[ix(h, 'unscaled_cell_days')], f[ix(h, 'modis_scaled_cell_days')], f[ix(h, 'viirs_cell_days')], f[ix(h, 'modis_cell_days')], f[ix(h, 'source_mix')], f[ix(h, 'n_days')], f[ix(h, 'complete')] === '1' ? 'true' : 'false', f[ix(h, 'peak_frp_mw')], f[ix(h, 'peak_frp_sensor')], region.id],
    );
    // Annual totals and bands: the annual held-out factors applied to each year's MODIS-scaled part (as the report).
    const band: [number, number] | null = validation.configs?.TA?.uncertainty?.annual ?? null;
    const cal = readFileSync(join(D, 'calendar_monthly.csv'), 'utf8').trim().split('\n');
    const ch = cal[0].split(',');
    const byYear = new Map<number, { h: number; s: number }>();
    for (const l of cal.slice(1)) {
      const f = l.split(',');
      const e = byYear.get(+f[ix(ch, 'year')]) ?? { h: 0, s: 0 };
      e.h += +f[ix(ch, 'harmonized_cell_days')];
      e.s += +(f[ix(ch, 'scaled_cell_days')] || 0);
      byYear.set(+f[ix(ch, 'year')], e);
    }
    const annual = [...byYear.entries()].map(([year, e]) => ({
      scope: region.id,
      year,
      harmonized_cell_days: e.h,
      harmonized_lo: band ? e.h - e.s * (1 - band[0]) : e.h,
      harmonized_hi: band ? e.h + e.s * (band[1] - 1) : e.h,
    }));
    if (annual.length) await tx`insert into annual_harmonized ${tx(annual)}`;
    counts.annual = annual.length;

    counts.static_mask = await copyFiles(tx, 'static_mask', ['cell_id', 'grid_lat', 'grid_lon', 'n_static', 'reason', 'region_id'], [join(D, 'static_mask.csv')], (f) => [f[0], f[1], f[2], f[3], f[4] || 'static_type', region.id]);
  });

  if (summaryOnly) {
    log(`${region.id}: summary loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s — ${Object.entries(counts).map(([k, n]) => `${k} ${n.toLocaleString()}`).join(', ')} (no detections or cell_days)`);
    return counts;
  }
  // Checks against the manifests (outside the transaction: what is now committed).
  const loadProblems: string[] = [];
  const want = (name: string, got: number, exp: number | undefined) => { if (exp !== undefined && got !== exp) loadProblems.push(`${name}: loaded ${got}, manifest says ${exp}`); };
  want('fire detections', counts.fire, manifest.counts.detections);
  want('cell_days', counts.cell_days, manifest.counts.cell_days);
  if (ihManifest) want('industrial detections', counts.industrial, Object.values<number>(ihManifest.counts).reduce((a, b) => a + b, 0));
  const db = (await sql`select (select count(*) from detections where region_id = ${region.id} and heat_class = 'fire')::int as fire,
                               (select count(*) from detections where region_id = ${region.id} and heat_class = 'industrial')::int as ind,
                               (select count(*) from cell_days where region_id = ${region.id})::int as cd`)[0];
  want('fire detections in db', db.fire, counts.fire);
  want('industrial detections in db', db.ind, counts.industrial);
  want('cell_days in db', db.cd, counts.cell_days);
  if (loadProblems.length) throw new Error(`${region.id}: load check FAILED\n  ${loadProblems.join('\n  ')}`);
  log(`${region.id}: loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s — ${Object.entries(counts).map(([k, n]) => `${k} ${n.toLocaleString()}`).join(', ')} ✓ matches manifest`);
  return counts;
}

export async function loadGroup(sql: Sql, group: string, log: (m: string) => void) {
  const D = join(REPO_ROOT, 'data/harmonized', group);
  const v = verifyOutputs(D);
  if (!v.ok) throw new Error(`${group}: outputs fail verify — not loading`);
  const counts: Record<string, number> = {};
  await sql.begin(async (tx: Sql) => {
    for (const t of ['daily_harmonized', 'calendar_monthly', 'annual_harmonized']) await tx.unsafe(`delete from ${t} where scope = $1`, [group]);
    counts.daily = await copyFiles(
      tx, 'daily_harmonized',
      ['acq_date', 'harmonized_cell_days', 'raw_detections', 'unscaled_cell_days', 'modis_scaled_cell_days', 'viirs_cell_days', 'modis_cell_days', 'scope'],
      [join(D, 'daily_harmonized.csv')],
      (f, h) => [f[ix(h, 'acq_date')], f[ix(h, 'harmonized_cell_days')], f[ix(h, 'raw_detections')], f[ix(h, 'unscaled_cell_days')], f[ix(h, 'modis_scaled_cell_days')], f[ix(h, 'viirs_cell_days')], f[ix(h, 'modis_cell_days')], group],
    );
    counts.calendar = await copyFiles(
      tx, 'calendar_monthly',
      ['year', 'month', 'harmonized_cell_days', 'harmonized_lo', 'harmonized_hi', 'raw_detections', 'unscaled_cell_days', 'modis_scaled_cell_days', 'viirs_cell_days', 'modis_cell_days', 'source_mix', 'n_days', 'complete', 'scope'],
      [join(D, 'calendar_monthly.csv')],
      (f, h) => [f[ix(h, 'year')], f[ix(h, 'month')], f[ix(h, 'harmonized_cell_days')], f[ix(h, 'harmonized_lo')], f[ix(h, 'harmonized_hi')], f[ix(h, 'raw_detections')], f[ix(h, 'unscaled_cell_days')], f[ix(h, 'modis_scaled_cell_days')], f[ix(h, 'viirs_cell_days')], f[ix(h, 'modis_cell_days')], f[ix(h, 'source_mix')], f[ix(h, 'n_days')], f[ix(h, 'complete')] === '1' ? 'true' : 'false', group],
    );
    counts.annual = await copyFiles(tx, 'annual_harmonized', ['year', 'harmonized_cell_days', 'harmonized_lo', 'harmonized_hi', 'scope'], [join(D, 'annual.csv')], (f) => [f[0], f[1], f[2], f[3], group]);
  });
  log(`${group}: loaded — ${Object.entries(counts).map(([k, n]) => `${k} ${n.toLocaleString()}`).join(', ')}`);
  return counts;
}

export async function loadGlobal(sql: Sql, cfg: RegionsConfig, log: (m: string) => void) {
  const G = join(REPO_ROOT, 'data/global');
  const counts: Record<string, number> = {};
  await sql.begin(async (tx: Sql) => {
    await tx`truncate global_coarse_months, global_static_mask, flare_inventory_cells`;
    const coarse = readdirSync(join(G, 'coarse_0.5')).filter((n) => n.endsWith('.csv')).sort().map((n) => join(G, 'coarse_0.5', n));
    counts.global_coarse_months = await copyFiles(
      tx, 'global_coarse_months',
      ['year', 'month', 'bin_lat', 'bin_lon', 'satellite', 'sensor', 'cell_days', 'detections', 'peak_frp_mw', 'sum_frp_mw'],
      coarse, (f) => f.slice(0, 10),
    );
    counts.global_static_mask = await copyFiles(tx, 'global_static_mask', ['cell_id', 'grid_lat', 'grid_lon', 'n_static'], [join(G, 'static_mask.csv')], (f) => f.slice(0, 4));
    if (cfg.flareInventory)
      counts.flare_inventory_cells = await copyFiles(
        tx, 'flare_inventory_cells',
        ['cell_id', 'grid_lat', 'grid_lon', 'n_sites', 'countries', 'first_active_year', 'last_active_year', 'total_bcm'],
        [join(REPO_ROOT, cfg.flareInventory.cells)], (f) => f.slice(0, 8),
      );
  });
  const gm = JSON.parse(readFileSync(join(G, 'manifest.json'), 'utf8')).outputs as Record<string, { rows: number }>;
  const expCoarse = Object.entries(gm).filter(([k]) => k.startsWith('coarse_')).reduce((s, [, o]) => s + o.rows, 0);
  if (counts.global_coarse_months !== expCoarse) throw new Error(`global: loaded ${counts.global_coarse_months} coarse rows, manifest says ${expCoarse}`);
  if (counts.global_static_mask !== gm['static_mask.csv'].rows) throw new Error(`global: static mask ${counts.global_static_mask} rows, manifest says ${gm['static_mask.csv'].rows}`);
  log(`global: loaded — ${Object.entries(counts).map(([k, n]) => `${k} ${n.toLocaleString()}`).join(', ')}`);
  return counts;
}

export async function dbSummary(sql: Sql) {
  const [s] = await sql`select pg_size_pretty(pg_database_size(current_database())) as size, pg_database_size(current_database())::bigint as bytes`;
  const t = await sql`select relname as table, n_live_tup::bigint as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
                      from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 12`;
  return { size: s.size as string, bytes: Number(s.bytes), tables: t };
}

export async function loadProne(sql: Sql, group: string, log: (m: string) => void) {
  const P = join(REPO_ROOT, 'data/harmonized', group, 'prone');
  const summary = JSON.parse(readFileSync(join(P, 'summary.json'), 'utf8'));
  const csvLine = /("([^"]|"")*"|[^,]*)(,|$)/g;
  const split = (l: string) => { const out: string[] = []; for (const m of l.matchAll(csvLine)) { if (m.index === l.length) break; out.push(m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]); } return out; };
  let n = 0;
  await sql.begin(async (tx: Sql) => {
    await tx`delete from prone_tiles where scope = ${group}`;
    const w = await tx.unsafe(`copy prone_tiles (tile_id, lat, lon, region_id, n_cells, mean_annual_cell_days, density, density_pct, years_with_fire, recurrence, peak_month, season_months, frp_p90_modis_mw, trend_pct_per_decade, trend_p, gi_z, gi_q, hotspot, prone_class, why, scope) from stdin with (format csv)`).writable();
    async function* rows() {
      let first = true;
      for await (const l of lines(join(P, 'prone_tiles.csv'))) {
        if (first) { first = false; continue; }
        const f = split(l);
        f[11] = `{${f[11].split('|').filter(Boolean).join(',')}}`;
        n++;
        yield f.map((v) => (v === '' ? '' : /[",\n{]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',') + `,${group}\n`;
      }
    }
    await pipeline(Readable.from(rows()), w);
  });
  if (n !== summary.tiles) throw new Error(`prone: loaded ${n} tiles, summary says ${summary.tiles}`);
  log(`${group}: prone tiles loaded — ${n.toLocaleString()} ✓`);
  return n;
}
