import type { Bbox } from "../copilot/context";
import { MockFireData } from "./mockFireData";

/**
 * Data access used by the chat copilot tools. Result shapes follow
 * apps/api-worker/SPEC.md §3 (POST /api/calendar, /api/*\/spots), trimmed to what
 * the model needs so tool results stay small.
 */

export type Mode = "archival" | "realtime";
export type DataSourceKind = "mock" | "live";
export type AnomalyClass = "record_low" | "below" | "normal" | "above" | "record_high";

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

export interface CalendarResult {
  dataSource: DataSourceKind;
  note: string;
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
  getCalendar(q: CalendarQuery): Promise<CalendarResult>;
  getSpotsSummary(q: SpotsQuery): Promise<SpotsSummary>;
  getMonthToDate(q: { bbox: Bbox; today?: string }): Promise<MonthToDateResult>;
}

export function createFireData(env: Env): FireData {
  if (env.FIRE_DATA_SOURCE && env.FIRE_DATA_SOURCE !== "mock") {
    // TODO(data team): implement LiveFireData and return it here when
    // FIRE_DATA_SOURCE === "live":
    //   - getCalendar: same code path as POST /api/calendar (archival) —
    //     Postgres via env.HYPERDRIVE (fresh postgres() client per call, closed
    //     with ctx.waitUntil(sql.end())) + @repo/harmonizer computeAlpha →
    //     harmonizeDaily → buildCalendar → computeAnomalies; then trim to
    //     CalendarResult (summary, climatology, annual, top ~8 notableMonths).
    //   - getSpotsSummary: cell_days/detections (archival, Postgres) or
    //     nrt_cell_days/nrt_detections (realtime, D1 env.NRT_DB).
    //   - getMonthToDate: POST /api/calendar mode=realtime (D1 + Postgres baseline).
    // Call the shared internal functions directly, no HTTP hop (SPEC §4.5).
    console.warn(
      `[copilot] FIRE_DATA_SOURCE=${env.FIRE_DATA_SOURCE} is not implemented yet; using mock data`
    );
  }
  return new MockFireData();
}
