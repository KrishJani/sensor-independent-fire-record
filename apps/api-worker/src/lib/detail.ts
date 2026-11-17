// Whether the detailed archive (cell_days, detections) is loaded. A summary-only load
// (`backfill load --summary-only`) has calendars and prone tiles but no per-cell rows, so the map
// hot spots and calendars for drawn areas cannot be built. Checked once a minute per isolate.
import { db, type Ctx } from './db.ts';
import { ApiError } from './http.ts';

export const DETAIL_NOT_LOADED = 'Detailed hot spots are not loaded in this deployment.';

let memo: { v: boolean; at: number } | null = null;

export async function detailLoaded(env: Env, ctx: Ctx): Promise<boolean> {
  if (memo && Date.now() - memo.at < 60_000) return memo.v;
  const sql = db(env, ctx);
  const [r] = await sql`select exists (select 1 from cell_days) as v`;
  memo = { v: Boolean(r?.v), at: Date.now() };
  return memo.v;
}

/** 404 detail_not_loaded when only the summary archive is loaded. */
export async function requireDetail(env: Env, ctx: Ctx): Promise<void> {
  if (!(await detailLoaded(env, ctx))) throw new ApiError(404, 'detail_not_loaded', DETAIL_NOT_LOADED);
}
