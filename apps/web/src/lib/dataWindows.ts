import { addDays, todayUTC, type ISODate } from './dates';

export type Tab = 'archival' | 'realtime';

export interface DateWindow {
  min: ISODate;
  max: ISODate;
}

export const MODIS_RECORD_START: ISODate = '2000-11-01';

/**
 * Rolling realtime window: D1 keeps exactly the last 92 days of NRT data; older dates are
 * archival (Postgres). Must match D1_RETENTION_DAYS in apps/ingest-worker/wrangler.jsonc.
 * TODO(stage 3): read the bounds from GET /api/meta instead of hardcoding.
 */
export const REALTIME_WINDOW_DAYS = 92;

export function dateWindow(tab: Tab, today: ISODate = todayUTC()): DateWindow {
  const realtimeStart = addDays(today, -REALTIME_WINDOW_DAYS);
  return tab === 'archival'
    ? { min: MODIS_RECORD_START, max: addDays(realtimeStart, -1) }
    : { min: realtimeStart, max: today };
}
