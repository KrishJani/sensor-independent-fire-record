export * from './types.ts';
export {
  parseFirmsCsv,
  parseFirmsCsvStream,
  createFirmsLineParser,
  normalizeSatellite,
  splitCsvLine,
  newParseStats,
  type ParseOptions,
  type ParseStats,
  type RejectReason,
} from './parse.ts';
export {
  filterDetections,
  keepDetection,
  buildStaticMask,
  createStaticMaskAccumulator,
  createPersistenceAccumulator,
  maskSet,
  newFilterStats,
  type FilterOptions,
  type FilterStats,
  type StaticMaskEntry,
} from './filter.ts';
export {
  GRID_DEG,
  GRID_ROWS,
  GRID_COLS,
  toCellId,
  latToRow,
  lonToCol,
  cellRowCol,
  cellCenter,
  cellsInBbox,
  snapBboxOutward,
  inBbox,
  cellInRegion,
  coarseBin,
  pointInPolygon,
  type Bbox,
  type PolygonGeometry,
} from './grid.ts';
export { buildCellDays, createCellDayAccumulator, compareCellDays, PASS_GAP_MINUTES } from './celldays.ts';
export {
  dailySensorCounts,
  pickViirsReference,
  modisConfigFor,
  modisCount,
  isAvailable,
  harmonizeDaily,
  availabilityFromRows,
} from './harmonize.ts';
export {
  computeAlpha,
  computeAlphaTable,
  calibrationSamples,
  alphaTableFromRows,
  quantileSorted,
  mulberry32,
  ALPHA_CLAMP,
  type CalibrationSample,
  type ComputeAlphaOptions,
} from './calibrate.ts';
export { buildCalendar, applyBands } from './calendar.ts';
export { computeAnomalies, cumulativeToDay, scoreAgainst, baselineStats, type Anomaly, type AnomalyClass } from './anomalies.ts';
export { countClasses, anomalyColor } from './colors.ts';
export {
  validateCalibration,
  validateModel,
  type ModelValidationReport,
  type Uncertainty,
  type NoiseTest,
  type ModelScore,
  inSampleAgreement,
  leaveOneYearOut,
  annualContinuity,
  linearityDiagnostics,
  monthlyPairs,
  type ValidationReport,
} from './validate.ts';
export { detectOutages, withoutDates, type DetectedOutage } from './outages.ts';
export {
  fitAlphaModel,
  fitAlphaGLM,
  chi2Sf,
  pairMean,
  fitModelConfig,
  alphaAt,
  effectiveAlphas,
  resolverFromEffective,
  resolverFromTable,
  modelAsTable,
  monthlyRates,
  monthPairs as modelMonthPairs,
  type AlphaModel,
  type AlphaModelConfig,
  type AlphaModelOptions,
  type AlphaResolver,
  type EffectiveAlpha,
  type MonthPair,
} from './model.ts';
export {
  gridSensitivity,
  pickGridSize,
  dailyCountsAtResolution,
  gridCellIdAt,
  assertValidGridDeg,
  DEFAULT_SENSITIVITY_GRIDS,
  GRID_PICK_RULE,
  type GridSensitivityReport,
  type GridSensitivityRow,
  type ResolutionDaily,
} from './sensitivity.ts';
export {
  analyseProne,
  getisOrdGiStar,
  benjaminiHochberg,
  trendTest,
  seasonOf,
  twoSidedP,
  tileOfCell,
  tileCenter,
  tileRowCol,
  tileNeighbours,
  TILE_CELLS,
  type TileInput,
  type TileResult,
  type ProneClass,
} from './prone.ts';
export * from './serialize.ts';
export { addDays, dateRange, daysInMonth } from './dates.ts';

// 1.1.0: activity-dependent α (Poisson GLM, model.ts) replaces the constant monthly ratio.
// 1.2.0: two-component α (VIIRS-only background + scaled MODIS), noise-aware acceptance, uncertainty bands.
export const HARMONIZER_VERSION = '1.2.0';
export { createCoverage, inUS, MIN_COVERAGE, type CoverageRegion } from './coverage.ts';
