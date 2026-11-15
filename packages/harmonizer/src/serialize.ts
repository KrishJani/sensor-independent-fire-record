// Deterministic CSV serialization shared by the backfill, ingest and export paths.
// Fixed precision: 5 dp raw coordinates (FIRMS source precision), 4 dp grid centers,
// 1 dp FRP, 4 dp α, 2 dp harmonized counts.

import type { Alpha, CalendarCell, CellDay, Detection, HarmonizedDay, Satellite } from './types.ts';
import type { StaticMaskEntry } from './filter.ts';
import { toCellId } from './grid.ts';

export function fmt(x: number | null | undefined, dp: number): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '';
  const s = x.toFixed(dp);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

const line = (xs: (string | number)[]) => xs.join(',') + '\n';

export const DETECTION_HEADER =
  'latitude,longitude,acq_date,acq_time,satellite,sensor,tier,confidence,frp_mw,day_night,type,version,cell_id,hv';

export function detectionRow(d: Detection, hv: string): string {
  return line([
    fmt(d.lat, 5),
    fmt(d.lon, 5),
    d.acqDate,
    d.acqTime,
    d.satellite,
    d.sensor,
    d.tier,
    d.confidence,
    fmt(d.frpMw, 1),
    d.dayNight,
    d.type ?? '',
    d.version,
    toCellId(d.lat, d.lon),
    hv,
  ]);
}

/** Natural key used for de-duplication across overlapping downloads / re-fetches. */
export function detectionKey(d: Detection): string {
  return `${d.satellite}|${d.acqDate}|${d.acqTime}|${fmt(d.lat, 5)}|${fmt(d.lon, 5)}`;
}

const SAT_ORDER: Record<Satellite, number> = { TERRA: 0, AQUA: 1, SNPP: 2, NOAA20: 3, NOAA21: 4 };

export function compareDetections(a: Detection, b: Detection): number {
  if (a.acqDate !== b.acqDate) return a.acqDate < b.acqDate ? -1 : 1;
  if (a.satellite !== b.satellite) return SAT_ORDER[a.satellite] - SAT_ORDER[b.satellite];
  return a.acqTime - b.acqTime || a.lat - b.lat || a.lon - b.lon || a.frpMw - b.frpMw || a.confidence - b.confidence;
}

export const CELL_DAY_HEADER =
  'acq_date,cell_id,grid_lat,grid_lon,satellite,sensor,tier,n_detections,n_passes,peak_frp_mw,sum_frp_mw,first_time,last_time,hv';

export function cellDayRow(c: CellDay, hv: string): string {
  return line([
    c.acqDate,
    c.cellId,
    fmt(c.gridLat, 4),
    fmt(c.gridLon, 4),
    c.satellite,
    c.sensor,
    c.tier,
    c.nDetections,
    c.nPasses,
    fmt(c.peakFrpMw, 1),
    fmt(c.sumFrpMw, 1),
    c.firstTime,
    c.lastTime,
    hv,
  ]);
}

export const ALPHA_HEADER =
  'month,alpha,modis_cell_days,viirs_cell_days,n_years,modis_config,alpha_local,alpha_prior,w,n_days,ci90_low,ci90_high';

export function alphaRow(a: Alpha): string {
  return line([
    a.month,
    fmt(a.alpha, 4),
    a.sumModis,
    a.sumViirs,
    a.nYears,
    a.config,
    fmt(a.alphaLocal, 4),
    fmt(a.alphaPrior, 4),
    fmt(a.w, 4),
    a.nDays,
    fmt(a.ciLow, 4),
    fmt(a.ciHigh, 4),
  ]);
}

export const CALENDAR_HEADER =
  'year,month,harmonized_cell_days,modis_cell_days,viirs_cell_days,source_mix,n_days,n_viirs_days,n_modis_scaled_days,n_none_days,peak_frp_mw,peak_frp_sensor,complete';

export function calendarRow(c: CalendarCell): string {
  return line([
    c.year,
    c.month,
    fmt(c.harmonizedCellDays, 2),
    c.modisCellDays,
    c.viirsCellDays,
    fmt(c.sourceMix, 4),
    c.nDays,
    c.nViirsDays,
    c.nModisScaledDays,
    c.nNoneDays,
    fmt(c.peakFrpMw, 1),
    c.peakFrpSensor ?? '',
    c.complete ? 1 : 0,
  ]);
}

export const DAILY_HEADER =
  'acq_date,harmonized_cell_days,modis_cell_days,viirs_cell_days,basis,alpha,modis_config,viirs_reference,peak_frp_mw,peak_frp_sensor';

export function dailyRow(d: HarmonizedDay): string {
  return line([
    d.acqDate,
    fmt(d.harmonizedCellDays, 2),
    d.modisCellDays,
    d.viirsCellDays,
    d.basis,
    fmt(d.alpha, 4),
    d.modisConfig ?? '',
    d.viirsReference ?? '',
    fmt(d.peakFrpMw, 1),
    d.peakFrpSensor ?? '',
  ]);
}

export const STATIC_MASK_HEADER = 'cell_id,grid_lat,grid_lon,n_static_detections';

export function staticMaskRow(e: StaticMaskEntry): string {
  return line([e.cellId, fmt(e.gridLat, 4), fmt(e.gridLon, 4), e.nStaticDetections]);
}

export const AVAILABILITY_HEADER = 'satellite,acq_date';
