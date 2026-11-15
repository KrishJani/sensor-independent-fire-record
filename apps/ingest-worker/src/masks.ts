// Industrial-heat classification for NRT (SPEC §3.1 step 2). NRT has no FIRMS `type`, so masked cells are
// the only way to separate fire from persistent non-fire heat. The rule matches the archive exactly:
//   - inside a harmonized region → ONLY that region's static_mask (static_type | persistent_viirs_only |
//     eog_flare_site), so realtime equals the regional SP record;
//   - elsewhere → EOG flare-inventory cells, then the global static mask (FIRMS type 2 cells).
// Masks come from Postgres (Hyperdrive) and are cached in KV for 24 h.
import postgres from 'postgres';
import { cellInRegion, type Bbox } from '@repo/harmonizer';
import regionsConfig from '../../../config/regions.json';

export type HeatReason = 'static_source_cell' | 'persistent_viirs_only' | 'eog_flare_site';
const CODE: Record<HeatReason, string> = { static_source_cell: 's', persistent_viirs_only: 'p', eog_flare_site: 'f' };
const REASON: Record<string, HeatReason> = { s: 'static_source_cell', p: 'persistent_viirs_only', f: 'eog_flare_site' };
const CACHE_KEY = 'cache:static_mask:v1';

interface RegionDef { id: string; bbox: Bbox; exclude?: string[] }
const REGIONS = (regionsConfig as unknown as { regions: RegionDef[] }).regions;
const BBOX = new Map(REGIONS.map((r) => [r.id, r.bbox]));
const EXCLUDED = new Map(REGIONS.map((r) => [r.id, (r.exclude ?? []).map((id) => BBOX.get(id)!)]));

/** The harmonized region a cell belongs to (cell-centre rule, same as the backfill), or null. */
export function regionOfCell(cellId: number): string | null {
  for (const r of REGIONS) if (cellInRegion(cellId, r.bbox, EXCLUDED.get(r.id))) return r.id;
  return null;
}

export interface Masks {
  /** Reason a detection in this cell is industrial heat, or null when it counts as fire. */
  reasonFor(cellId: number): HeatReason | null;
  size: number;
}

function build(regional: Map<number, HeatReason>, outside: Map<number, HeatReason>): Masks {
  return {
    reasonFor(cellId) {
      const r = regional.get(cellId);
      if (r) return r; // a regional entry is in its region by construction
      const o = outside.get(cellId);
      return o && regionOfCell(cellId) === null ? o : null; // inside a region only the regional mask applies
    },
    size: regional.size + outside.size,
  };
}

const encode = (m: Map<number, HeatReason>) => [...m].map(([c, r]) => `${c}${CODE[r]}`).join(',');
function decode(s: string): Map<number, HeatReason> {
  const m = new Map<number, HeatReason>();
  if (s) for (const t of s.split(',')) m.set(+t.slice(0, -1), REASON[t.slice(-1)]);
  return m;
}

export async function loadMasks(env: Env, log: (o: object) => void): Promise<Masks> {
  const cached = await env.INGEST_STATE.get(CACHE_KEY);
  if (cached) {
    const { regional, outside } = JSON.parse(cached) as { regional: string; outside: string };
    return build(decode(regional), decode(outside));
  }
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false, prepare: false });
  try {
    const regional = new Map<number, HeatReason>();
    for (const r of (await sql`select cell_id, reason from static_mask`) as unknown as { cell_id: number; reason: string }[])
      regional.set(r.cell_id, r.reason === 'static_type' ? 'static_source_cell' : (r.reason as HeatReason));
    const outside = new Map<number, HeatReason>();
    for (const r of (await sql`select cell_id from global_static_mask`) as unknown as { cell_id: number }[]) outside.set(r.cell_id, 'static_source_cell');
    for (const r of (await sql`select cell_id from flare_inventory_cells`) as unknown as { cell_id: number }[]) outside.set(r.cell_id, 'eog_flare_site'); // inventory wins
    await env.INGEST_STATE.put(CACHE_KEY, JSON.stringify({ regional: encode(regional), outside: encode(outside) }), { expirationTtl: 86_400 });
    log({ job: 'masks', regional: regional.size, outside: outside.size });
    return build(regional, outside);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
