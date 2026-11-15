import { addDays, todayUTC, type ISODate } from './dates';

export type Tab = 'archival' | 'realtime';

export interface DateWindow {
  min: ISODate;
  max: ISODate;
}

export const MODIS_RECORD_START: ISODate = '2000-11-01';

/** Days of NRT data kept in D1 before Standard Processing (SP) supersedes it. */
export const REALTIME_WINDOW_DAYS = 60;

export function dateWindow(tab: Tab, today: ISODate = todayUTC()): DateWindow {
  const realtimeStart = addDays(today, -REALTIME_WINDOW_DAYS);
  return tab === 'archival'
    ? { min: MODIS_RECORD_START, max: addDays(realtimeStart, -1) }
    : { min: realtimeStart, max: today };
}
