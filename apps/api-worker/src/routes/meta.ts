import { HARMONIZER_VERSION } from '@repo/harmonizer';
import regionsConfig from '../../../../config/regions.json';
import { db, type Ctx } from '../lib/db.ts';
import { dataVersion } from '../lib/cache.ts';
import { detailLoaded } from '../lib/detail.ts';

export const REGIONS = regionsConfig.regions as { id: string; name: string; group?: string; bbox: [number, number, number, number]; exclude?: string[] }[];
export const CONFIG = regionsConfig;

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

/** Archive bounds per region from Postgres (what was actually loaded). */
export async function archiveBounds(env: Env, ctx: Ctx) {
  const sql = db(env, ctx);
  const rows = await sql`select region_id, group_id, range_from::text as from, range_to::text as to, harmonizer_version from regions order by region_id`;
  return rows as unknown as { region_id: string; group_id: string | null; from: string; to: string; harmonizer_version: string }[];
}

export async function meta(env: Env, ctx: Ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const retention = Number(env.D1_RETENTION_DAYS ?? 92);
  const [bounds, va, vr, nrtAt, latest, detail] = await Promise.all([
    archiveBounds(env, ctx),
    dataVersion(env, 'archival'),
    dataVersion(env, 'realtime'),
    env.INGEST_STATE!.get('ingest:nrt:last_success_at'),
    Promise.all(['TERRA', 'AQUA', 'SNPP', 'NOAA20', 'NOAA21'].map(async (s) => [s, await env.INGEST_STATE!.get(`ingest:sp:latest_date:${s}`)] as const)),
    detailLoaded(env, ctx),
  ]);
  const byId = new Map(bounds.map((b) => [b.region_id, b]));
  const groups = [...new Set(REGIONS.map((r) => r.group).filter(Boolean))] as string[];
  const groupTo = (g: string) => bounds.filter((b) => b.group_id === g).map((b) => b.to).sort()[0] ?? null;
  return {
    regions: REGIONS.map((r) => ({ id: r.id, name: r.name, group: r.group ?? null, bbox: r.bbox, archival: byId.get(r.id) ? { minDate: byId.get(r.id)!.from, maxDate: byId.get(r.id)!.to } : null })),
    groups: groups.map((g) => ({ id: g, regions: REGIONS.filter((r) => r.group === g).map((r) => r.id), archival: { minDate: '2000-11-01', maxDate: groupTo(g) } })),
    archival: {
      minDate: '2000-11-01',
      maxDate: bounds.map((b) => b.to).sort().at(-1) ?? null,
      dataVersion: Number(va),
      latestBySatellite: Object.fromEntries(latest),
      // false after a summary-only load: no map hot spots, drawn-area calendars or world layer.
      detail,
    },
    realtime: { minDate: addDays(today, -retention), maxDate: today, updatedAt: nrtAt, dataVersion: Number(vr) },
    harmonizerVersion: HARMONIZER_VERSION,
    loadedHarmonizerVersions: [...new Set(bounds.map((b) => b.harmonizer_version))],
  };
}

export async function health(env: Env, ctx: Ctx) {
  const time = async (f: () => Promise<unknown>) => { const t = Date.now(); try { await f(); return Date.now() - t; } catch (e) { return `error: ${(e as Error).message}`; } };
  const sql = db(env, ctx);
  const [postgres, d1, nrt, sp] = await Promise.all([
    time(() => sql`select 1`),
    time(() => env.NRT_DB.prepare('select 1').first()),
    env.INGEST_STATE!.get('ingest:nrt:last_success_at'),
    env.INGEST_STATE!.get('ingest:sp:last_success_at'),
  ]);
  return { ok: typeof postgres === 'number' && typeof d1 === 'number', postgres, d1, kv: { nrtLastSuccess: nrt, spLastSuccess: sp } };
}
