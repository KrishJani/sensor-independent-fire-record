// GET /api/prone?bbox=&class=very_high,high&scope=us → 0.25° tiles (GeoJSON) with the prone analysis.
// GET /api/prone/summary?scope=us                     → class counts per region + the most significant tiles.
import { db, type Ctx } from '../lib/db.ts';
import { ApiError, parseBbox } from '../lib/http.ts';

const CLASSES = ['very_high', 'high', 'elevated', 'low'];

export async function prone(env: Env, ctx: Ctx, q: URLSearchParams) {
  const scope = q.get('scope') ?? 'us';
  const bbox = parseBbox(q.get('bbox') ?? '-180,-90,180,90', 64800);
  const cls = (q.get('class') ?? 'very_high,high,elevated').split(',').filter((c) => CLASSES.includes(c));
  if (!cls.length) throw new ApiError(400, 'class_invalid', `class must be one or more of ${CLASSES.join(', ')}`);
  const sql = db(env, ctx);
  const rows = (await sql`select * from prone_tiles where scope = ${scope} and prone_class in ${sql(cls)}
    and lat between ${bbox[1] - 0.125} and ${bbox[3] + 0.125} and lon between ${bbox[0] - 0.125} and ${bbox[2] + 0.125}`) as any[];
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[r.lon - 0.125, r.lat - 0.125], [r.lon + 0.125, r.lat - 0.125], [r.lon + 0.125, r.lat + 0.125], [r.lon - 0.125, r.lat + 0.125], [r.lon - 0.125, r.lat - 0.125]]] },
      properties: {
        tile_id: r.tile_id, region: r.region_id, prone_class: r.prone_class, hotspot: r.hotspot, gi_z: r.gi_z, gi_q: r.gi_q,
        mean_annual_cell_days: r.mean_annual_cell_days, density_pct: r.density_pct, recurrence: r.recurrence, years_with_fire: r.years_with_fire,
        peak_month: r.peak_month, season_months: r.season_months, frp_p90_modis_mw: r.frp_p90_modis_mw,
        trend_pct_per_decade: r.trend_pct_per_decade, trend_p: r.trend_p, why: r.why,
      },
    })),
    meta: { scope, bbox, classes: cls, years: [2001, 2025], tileDeg: 0.25, method: 'Getis-Ord Gi* hot spots on harmonized cell-days, Benjamini–Hochberg FDR (docs/HARMONIZATION.md §9)' },
  };
}

export async function proneSummary(env: Env, ctx: Ctx, q: URLSearchParams) {
  const scope = q.get('scope') ?? 'us';
  const n = Math.min(50, Math.max(1, Number(q.get('top') ?? 15)));
  const sql = db(env, ctx);
  const [byRegion, top] = await Promise.all([
    sql`select region_id, prone_class, count(*)::int as n from prone_tiles where scope = ${scope} group by 1, 2 order by 1, 2`,
    sql`select tile_id, lat, lon, region_id, gi_z, why, peak_month, recurrence, trend_pct_per_decade, trend_p from prone_tiles
        where scope = ${scope} and prone_class = 'very_high' order by gi_z desc limit ${n}`,
  ]);
  const regions: Record<string, Record<string, number>> = {};
  for (const r of byRegion as any[]) (regions[r.region_id] ??= {})[r.prone_class] = r.n;
  return { scope, regions, mostSignificant: top };
}
