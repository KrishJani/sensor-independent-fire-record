import type { Bbox } from "../copilot/context";
import { LiveFireData } from "./liveFireData";
import { MockFireData } from "./mockFireData";

/**
 * Data access used by the chat copilot tools. Result shapes follow
 * apps/api-worker/SPEC.md §3 (POST /api/calendar, /api/*\/spots), trimmed to what
 * the model needs so tool results stay small.
 */

export type Mode = "archival" | "realtime";
export type DataSourceKind = "mock" | "live";
export type AnomalyClass = "record_low" | "much_below" | "below" | "normal" | "above" | "much_above" | "record_high";

export interface CalendarQuery {
  bbox: Bbox;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  months?: number[] | null; // 1..12
}

export interface CalendarMonth {
  year: number;
  month: number;
  harmonizedCellDays: number;
  modisCellDays: number;
  viirsCellDays: number;
  sourceMix: number; // share of days with a VIIRS reference (1 = full)
  peakFrpMw: number;
  peakFrpSensor: "MODIS" | "VIIRS";
  complete: boolean;
  /** true for pre-2012 months: MODIS × α calibrated estimate */
  calibratedEstimate: boolean;
  anomaly: {
    median: number;
    ratioToMedian: number;
    robustZ: number;
    percentile: number;
    class: AnomalyClass;
  };
}

/** What a live tool returns when the data it needs is not loaded or the area is outside coverage. */
export interface Unavailable {
  dataSource: DataSourceKind;
  available: false;
  /** One short, honest sentence the model can repeat. */
  message: string;
  /** "outside_coverage": the area is outside the US harmonized archive (no calendar exists for it). */
  reason?: "outside_coverage";
}

/** The harmonized region a result is computed for (calendars are region-level, never the AOI itself). */
export interface RegionRef {
  id: string;
  name: string;
  /** Short name to use in answers, e.g. "Southeast region". */
  label: string;
}

export interface CalendarResult {
  dataSource: DataSourceKind;
  note: string;
  /** Live data: the whole region the numbers describe. */
  region?: RegionRef;
  mode: "archival";
  bbox: Bbox;
  from: string;
  to: string;
  unit: "active cell-days (0.05° ≈ 5.5 km cell with ≥1 detection on a UTC day)";
  summary: {
    peakMonth: string | null; // YYYY-MM
    peakYear: number | null;
    criticalMonths: number[];
    totalHarmonizedCellDays: number;
    monthsInRange: number;
    incompleteMonths: number;
  };
  climatology: { month: number; median: number; p10: number; p25: number; p75: number; p90: number }[];
  annual: { year: number; harmonizedCellDays: number; calibratedEstimate: boolean }[];
  /** Top ~8 months by anomaly / size, not the full matrix (token budget). */
  notableMonths: CalendarMonth[];
}

export interface SpotsQuery {
  mode: Mode;
  bbox: Bbox;
  from: string;
  to: string;
}

export interface SpotsSummary {
  dataSource: DataSourceKind;
  note: string;
  mode: Mode;
  bbox: Bbox;
  from: string;
  to: string;
  counts: {
    detections: number;
    activeCellDays: number;
    distinctCells: number;
    bySatellite: Record<string, { detections: number; cellDays: number }>;
  };
  daily: { date: string; activeCells: number; peakFrpMw: number }[];
  /** Set when the result comes from an Archival showcase period file (routes/showcase.ts). */
  showcase?: { id: string; label: string; from: string; to: string; harmonized: boolean };
  /** Showcase periods that are harmonized: VIIRS-equivalent cell-days, comparable with the calendar. */
  harmonizedCellDays?: number;
  lastSeen: string | null; // ISO datetime
  topDetections: {
    lat: number;
    lon: number;
    date: string;
    timeUtc: string;
    satellite: string;
    sensor: "MODIS" | "VIIRS";
    frpMw: number;
    confidence: number;
  }[];
}

export interface MonthToDateResult {
  dataSource: DataSourceKind;
  note: string;
  region?: RegionRef;
  bbox: Bbox;
  month: string; // YYYY-MM
  throughDay: number;
  monthToDate: {
    value: number;
    median: number;
    ratioToMedian: number;
    class: AnomalyClass;
  };
  daily: { date: string; harmonizedCellDays: number }[];
  basis: "VIIRS";
}

export interface FireData {
  readonly source: DataSourceKind;
  getCalendar(q: CalendarQuery): Promise<CalendarResult | Unavailable>;
  getSpotsSummary(q: SpotsQuery): Promise<SpotsSummary | Unavailable>;
  getMonthToDate(q: { bbox: Bbox; today?: string }): Promise<MonthToDateResult | Unavailable>;
}

/**
 * "live" = the real archive (Postgres via Hyperdrive) and the NRT tier (D1); anything else = the demo
 * fixtures (local dev and tests). Live results that are not available say so, never fall back to mock.
 */
export function createFireData(env: Env): FireData {
  return env.FIRE_DATA_SOURCE === "live" ? new LiveFireData(env) : new MockFireData();
}
