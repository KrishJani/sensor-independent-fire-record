// Core types for @repo/harmonizer. Pure data, no I/O.

export type Satellite = 'TERRA' | 'AQUA' | 'SNPP' | 'NOAA20' | 'NOAA21';
export type SensorFamily = 'MODIS' | 'VIIRS';
export type Tier = 'SP' | 'NRT';

export const MODIS_SATELLITES: readonly Satellite[] = ['TERRA', 'AQUA'];
/** VIIRS satellites in reference-preference order (harmonizer SPEC §7.1). */
export const VIIRS_SATELLITES: readonly Satellite[] = ['SNPP', 'NOAA20', 'NOAA21'];
export const ALL_SATELLITES: readonly Satellite[] = ['TERRA', 'AQUA', 'SNPP', 'NOAA20', 'NOAA21'];

export function sensorOf(s: Satellite): SensorFamily {
  return s === 'TERRA' || s === 'AQUA' ? 'MODIS' : 'VIIRS';
}

export interface Detection {
  lat: number;
  lon: number;
  acqDate: string; // 'YYYY-MM-DD' UTC
  acqTime: number; // HHMM UTC as integer (FIRMS format, e.g. 535 = 05:35)
  satellite: Satellite;
  sensor: SensorFamily;
  confidence: number; // normalized 0–100 (VIIRS l=20, n=60, h=90)
  frpMw: number;
  dayNight: 'D' | 'N';
  type: 0 | 1 | 2 | 3 | null; // null for NRT (no type column)
  tier: Tier;
  version: string;
}

export interface CellDay {
  acqDate: string;
  cellId: number; // row * 7200 + col
  gridLat: number; // cell center
  gridLon: number;
  satellite: Satellite;
  sensor: SensorFamily;
  tier: Tier;
  nDetections: number;
  nPasses: number;
  peakFrpMw: number; // MAX over passes of SUM(frp) within the pass
  sumFrpMw: number;
  firstTime: number; // HHMM
  lastTime: number;
}

/**
 * Which MODIS satellites were operating on a day.
 *  TA = Terra ∪ Aqua (2002-07-04 →), T = Terra only (2000-11 → 2002-07, Aqua outages),
 *  A = Aqua only (Terra outages).
 * The union of two satellites sees more cells than one, so each configuration
 * gets its own α (see docs/HARMONIZATION.md §3.4).
 */
export type ModisConfig = 'TA' | 'T' | 'A';
export const MODIS_CONFIGS: readonly ModisConfig[] = ['TA', 'T', 'A'];

/** Per-day distinct active cells inside an AOI, per satellite, plus the MODIS union. */
export interface DailyCounts {
  acqDate: string;
  cells: Record<Satellite, number>;
  modisUnion: number; // |TERRA ∪ AQUA|
  peakFrpMw: Record<Satellite, number>; // max cell-day peakFrpMw per satellite (0 if none)
}

/** satellite → set of 'YYYY-MM-DD' dates on which that satellite has data for the tier. */
export type SourceAvailability = ReadonlyMap<Satellite, ReadonlySet<string>>;

export interface Alpha {
  month: number; // 1–12
  config: ModisConfig;
  alpha: number; // final (shrunk, clamped)
  alphaLocal: number | null; // ΣV/ΣM in this month, null if ΣM = 0
  alphaPrior: number; // the value we shrink toward
  w: number; // ΣM / (ΣM + k)
  sumModis: number;
  sumViirs: number;
  nDays: number; // qualifying overlap days
  nYears: number; // distinct years contributing
  ciLow: number | null; // year-block bootstrap 90% interval
  ciHigh: number | null;
}

/** α indexed by MODIS configuration, then month-1. */
export type AlphaTable = Record<ModisConfig, Alpha[]>;

export type HarmonizedBasis = 'VIIRS' | 'MODIS_SCALED' | 'NONE';

export interface HarmonizedDay {
  acqDate: string;
  harmonizedCellDays: number; // VIIRS-equivalent
  modisCellDays: number; // M(d) for the MODIS configuration of the day (0 if none)
  viirsCellDays: number; // V(d) of the reference satellite (0 if none)
  basis: HarmonizedBasis;
  alpha: number | null; // α used (only for MODIS_SCALED)
  modisConfig: ModisConfig | null;
  viirsReference: Satellite | null;
  peakFrpMw: number | null; // from the basis sensor
  peakFrpSensor: SensorFamily | null;
}

export interface CalendarCell {
  year: number;
  month: number; // 1–12
  harmonizedCellDays: number;
  modisCellDays: number;
  viirsCellDays: number;
  sourceMix: number; // fraction of days with basis = VIIRS
  nDays: number; // days present in the series for this month
  nViirsDays: number;
  nModisScaledDays: number;
  nNoneDays: number;
  peakFrpMw: number | null;
  peakFrpSensor: SensorFamily | null;
  complete: boolean; // false for partial months or months containing NONE days
}
