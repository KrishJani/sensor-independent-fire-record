// Typed client for apps/api-worker. Base URL from VITE_API_BASE (e.g. http://localhost:8787 in dev).
import type { FeatureCollection } from 'geojson';

const BASE = (import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_API_URL ?? '').replace(/\/$/, ''); // archive API; falls back to the copilot API URL

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** The calendar's 422 when under half of the area is harmonized (api-worker lib/coverage.ts). */
export const isOutsideCoverage = (e: unknown) => e instanceof ApiError && e.code === 'outside_regions';
export const OUTSIDE_COVERAGE_TEXT = 'Outside harmonized coverage (US regions only). The map shows raw detections here.';

/** The API's 404 when only the summary archive is loaded (api-worker lib/detail.ts). */
export const isDetailMissing = (e: unknown) => e instanceof ApiError && e.code === 'detail_not_loaded';
export const DETAIL_MISSING_TEXT = 'Detailed hot spots are not loaded in this deployment.';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type Bbox = [number, number, number, number];
export type Level = 'coarse' | 'cells' | 'points';

/** A precomputed Archival map period served while the detailed archive is not loaded (api-worker /api/meta). */
export interface ShowcasePeriod {
  id: string;
  label: string;
  from: string;
  to: string;
  bbox: Bbox;
  harmonized: boolean;
  note: string;
}

export interface Meta {
  regions: { id: string; name: string; group: string | null; bbox: Bbox; archival: { minDate: string; maxDate: string } | null }[];
  groups: { id: string; regions: string[]; archival: { minDate: string; maxDate: string | null } }[];
  /** detail: false when only the summary archive is loaded (no map hot spots, drawn-area calendars or world layer). */
  archival: { minDate: string; maxDate: string | null; dataVersion: number; detail?: boolean; showcase?: ShowcasePeriod[] };
  realtime: { minDate: string; maxDate: string; updatedAt: string | null; dataVersion: number };
  harmonizerVersion: string;
}

export interface SpotsResponse extends FeatureCollection {
  meta: { level: Level; heat: 'fire' | 'industrial'; bbox: Bbox; from: string; to: string; truncated: boolean; globalFallback?: boolean;
    /** realtime only: the VIIRS reference satellite per day, and days with no VIIRS at all */
    reference?: Record<string, string | null>; noViirsDays?: string[] };
}

export interface CalendarMonth {
  year: number;
  month: number;
  harmonizedCellDays: number;
  lo: number;
  hi: number;
  rawDetections: number;
  unscaledCellDays: number;
  modisCellDays: number;
  viirsCellDays: number;
  sourceMix: number;
  peakFrpMw: number | null;
  peakFrpSensor: 'MODIS' | 'VIIRS' | null;
  complete: boolean;
  anomaly: { median: number; ratioToMedian: number | null; robustZ: number | null; percentile: number; class: string } | null;
}
export interface CalendarResponse {
  /** Share (0..1) of the area's 0.05° cells inside harmonized coverage; always ≥ 0.5 (else 422 outside_regions). */
  meta?: { coverage: number };
  aoi: unknown;
  range: { from: string; to: string };
  units: string;
  calendar: CalendarMonth[];
  annual: { year: number; harmonizedCellDays: number; lo: number | null; hi: number | null }[];
  climatology: { month: number; median: number; p10: number; p25: number; p75: number; p90: number; n: number }[];
  alpha: { region: string; model: string | null; beta: number | null; loyoError: number | null; confidence: string | null }[];
  summary: { peakMonth: string | null; peakYear: number | null; criticalMonths: number[]; criticalMonthNames: string[] };
}
export type CalendarRequest = { scope: string } | { bbox: Bbox } | { geometry: GeoJSON.Polygon };

let metaPromise: Promise<Meta> | null = null;
/** /api/meta, fetched once and shared by every caller (retried after a failure). */
export function getMeta(): Promise<Meta> {
  metaPromise ??= api.meta().catch((e) => { metaPromise = null; throw e; });
  return metaPromise;
}

export const api = {
  meta: () => call<Meta>('/api/meta'),
  spots: (bbox: Bbox, level: Level, from: string, to: string, heat: 'fire' | 'industrial', signal?: AbortSignal, sensor: 'all' | 'viirs' | 'modis' = 'all', measure: 'harmonized' | 'raw' = 'harmonized', tier: 'archival' | 'realtime' = 'archival') =>
    call<SpotsResponse>(`/api/${tier}/spots?bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&level=${level}&from=${from}&to=${to}&heat=${heat}&sensor=${sensor}&measure=${measure}`, { signal }),
  proneSummary: () => call<{ regions: Record<string, Record<string, number>>; mostSignificant: { tile_id: number; lat: number; lon: number; region_id: string; gi_z: number; why: string }[] }>('/api/prone/summary?scope=us&top=8'),
  calendar: (req: CalendarRequest & { from?: string; to?: string }, signal?: AbortSignal) =>
    call<CalendarResponse>('/api/calendar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'archival', ...req }), signal }),
  prone: (bbox: Bbox, signal?: AbortSignal) => call<FeatureCollection>(`/api/prone?scope=us&bbox=${bbox.map((v) => v.toFixed(2)).join(',')}`, { signal }),
  calendarCsvUrl: (req: { scope?: string; bbox?: Bbox }) =>
    `${BASE}/api/export/calendar.csv?${req.scope ? `scope=${req.scope}` : `bbox=${req.bbox!.map((v) => v.toFixed(2)).join(',')}`}`,
};
