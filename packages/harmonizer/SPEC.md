# `@repo/harmonizer` — Spec

This is a pure TypeScript package with **zero runtime dependencies** and no I/O. It runs unchanged in Workers (ingest, api), Node (backfill) and the browser (web).

Its job is to turn raw FIRMS MODIS and VIIRS detections into a sensor-independent time series of **harmonized active cell-days**, and to compute calendars and anomalies from that series.

---

## 1. Why harmonization is needed

| | MODIS (Terra/Aqua) | VIIRS I-band (S-NPP/NOAA-20/21) |
|---|---|---|
| Pixel at nadir | ~1 km | ~375 m |
| Sensitivity | Misses small/cool fires | Detects ~3–10× more hotspots |
| Record | 2000-11 → end of life | 2012-01 → |
| Confidence field | 0–100 | `l` / `n` / `h` |

In the sample fixture (California, 2020-08-15 → 19), there are **14,977 VIIRS S-NPP** detections against **2,292 MODIS** detections for the same fires. Raw counts would create a false 6× jump in 2012.

The strategy has three steps:

1. Put both sensors on a **common 0.05° grid**.
2. Collapse all detections per cell per satellite per day into **one active cell-day**. This removes the pixel-size effect.
3. Calibrate the remaining sensitivity gap with a **monthly ratio α** learned in the overlap years.

The harmonized series is expressed in **VIIRS-equivalent cell-days**. VIIRS is the sensor that continues after MODIS retires, so present data stays native and only the historical MODIS-only years are scaled.

> Note: this flips the direction of the ratio given in `README.md` (MODIS/VIIRS). The README must be updated to match.

---

## 2. Types (`src/types.ts`)

```ts
export type Satellite = 'TERRA' | 'AQUA' | 'SNPP' | 'NOAA20' | 'NOAA21';
export type SensorFamily = 'MODIS' | 'VIIRS';
export type Tier = 'SP' | 'NRT';

export interface Detection {
  lat: number; lon: number;
  acqDate: string;          // 'YYYY-MM-DD' UTC
  acqTime: number;          // HHMM UTC as integer (FIRMS format, e.g. 535 = 05:35)
  satellite: Satellite;
  sensor: SensorFamily;
  confidence: number;       // normalized 0–100 (VIIRS l=20, n=60, h=90)
  frpMw: number;
  dayNight: 'D' | 'N';
  type: 0 | 1 | 2 | 3 | null; // null for NRT (no type column)
  tier: Tier;
  version: string;
}

export interface CellDay {
  acqDate: string;
  cellId: number;           // row * 7200 + col
  gridLat: number;          // cell center
  gridLon: number;
  satellite: Satellite;
  sensor: SensorFamily;
  tier: Tier;
  nDetections: number;
  nPasses: number;
  peakFrpMw: number;        // MAX over passes of SUM(frp) within the pass
  sumFrpMw: number;
  firstTime: number;        // HHMM
  lastTime: number;
}

export interface HarmonizedDay {
  acqDate: string;
  harmonizedCellDays: number;   // VIIRS-equivalent
  modisCellDays: number;
  viirsCellDays: number;
  basis: 'VIIRS' | 'MODIS_SCALED' | 'NONE';
  alpha: number | null;
}

export interface CalendarCell {
  year: number; month: number;  // 1–12
  harmonizedCellDays: number;
  modisCellDays: number;
  viirsCellDays: number;
  sourceMix: number;            // fraction of days with basis = VIIRS
  peakFrpMw: number | null;
  peakFrpSensor: SensorFamily | null;
  complete: boolean;            // false for the current/partial month
}
```

---

## 3. Parsing (`src/parse.ts`)

`parseFirmsCsv(text | AsyncIterable<string>, { tier }) → Iterable<Detection>`

- It accepts MODIS columns (`brightness`, `bright_t31`) and VIIRS columns (`bright_ti4`, `bright_ti5`). Sensor is detected from the header or from the `instrument` column.
- `type` is optional because NRT has no `type` column. When it is missing, the value is `null`.
- Satellite codes are normalized: `Terra → TERRA`, `Aqua → AQUA`, `N → SNPP`, `1 → NOAA20`, `2 → NOAA21`. The `satellite` column is ambiguous across sensors, so the `instrument` column disambiguates.
- VIIRS confidence is mapped to 0–100: `l=20`, `n=60`, `h=90`.
- `acqTime` is kept as an integer HHMM. Note that FIRMS emits `535` for 05:35.
- The parser streams, so 10⁷-row backfill files never need to fit in memory.

---

## 4. Filtering (`src/filter.ts`)

`filterDetections(dets, opts) → Iterable<Detection>`. The rules are applied in this order:

1. **Non-vegetation sources:** drop `type ∈ {1 (volcano), 2 (static land source), 3 (offshore)}`.
2. **Static mask (needed for NRT, which has no `type`):** drop any detection whose cell is in `staticMask: Set<cellId>`.
   - `buildStaticMask(spDetections, { minStaticDetections: 3 })` puts a cell in the mask when it has at least N detections with `type = 2`. The backfill builds the mask and checks it in as `static_mask.csv`.
3. **Confidence:**
   - MODIS: keep `confidence ≥ 30`.
   - VIIRS: keep `n` and `h` (normalized ≥ 60).
4. **Optional FRP floor:** `viirsFrpFloorMw`, default **0** (off). Calibration with α already absorbs the sensitivity gap. A floor would discard small agricultural burns, which the challenge explicitly cares about. The option exists for experiments.

---

## 5. Grid (`src/grid.ts`)

The grid is fixed and global: `GRID_DEG = 0.05`, giving 3600 rows × 7200 cols.

```ts
row    = floor((lat + 90)  / 0.05)    // clamp to [0, 3599]
col    = floor((lon + 180) / 0.05)    // clamp to [0, 7199]
cellId = row * 7200 + col
center = (-90 + (row + 0.5) * 0.05, -180 + (col + 0.5) * 0.05)
```

- Integer cell IDs avoid float equality bugs in SQL and in JS maps.
- Helpers:
  - `cellsInBbox(bbox) → { rowMin, rowMax, colMin, colMax }`
  - `snapBboxOutward(bbox)`, used by the web cache key
  - `coarseBin(cellId, 0.5)`, used for the `coarse` map level
  - `pointInPolygon` for polygon AOIs. The test is done on cell centers.

---

## 6. Cell-days (`src/celldays.ts`)

`buildCellDays(dets) → CellDay[]`. Grouping is done **per satellite**, so Terra and Aqua remain separate.

1. **Pass clustering:** within `(satellite, acqDate, cellId)`, sort detections by `acqTime` and start a new pass when the gap from the previous detection is over **30 minutes**. One polar-orbiting satellite cannot revisit the same cell within about 90 minutes, so 30 minutes safely separates passes.
2. **Per pass:** `passFrp = SUM(frp)`. Summing the sub-pixels makes a VIIRS fire comparable to the single MODIS pixel that covers it.
3. **Per cell-day:**
   - `nPasses`
   - `nDetections`
   - `peakFrpMw = MAX(passFrp)`
   - `sumFrpMw = SUM(frp)`
   - `firstTime` and `lastTime`
4. **Idempotency:** the output is deterministic and sorted by `(acqDate, cellId, satellite)`.

---

## 7. Harmonization (`src/calibrate.ts`, `src/harmonize.ts`)

### 7.1 Per-day sensor values inside an AOI

- `M(d)` = the number of distinct cells active in **TERRA ∪ AQUA** on day `d`. A cell counts once even if both satellites saw it.
- `V(d)` = the number of distinct cells active in the **VIIRS reference satellite** on day `d`. Reference selection:
  - Use `SNPP` when it has data for `d` according to `source_availability`.
  - Otherwise use `NOAA20`, then `NOAA21`.
  - Using a single reference satellite per day avoids artificial increases in 2018 and 2023, when extra VIIRS satellites were added. All VIIRS units are the same instrument in the same orbit plane, so substituting one for another is near-neutral.

### 7.2 Monthly calibration factor α

`computeAlpha(dailyM, dailyV, { years: [2013, 2021], k: 50, regional }) → Alpha[12]`

- **Window:** 2013–2021 by default.
  - 2012 is skipped because it is partial (VIIRS SP starts 2012-01-20).
  - Years after 2021 are excluded because Terra and Aqua orbit drift (constellation exit) changes their overpass times.
  - The window is configurable through `config/regions.json`.
- **Sampling:** only days where **both** a MODIS satellite and the VIIRS reference have data are used.
- **Local ratio:** `α_local[m] = Σ V(d) / Σ M(d)` over the qualifying days in calendar month `m`.
- **Shrinkage** toward the regional factor (from `alpha_monthly.csv`), so that small or quiet AOIs are not noisy:

  ```
  w        = ΣM / (ΣM + k)            // k = 50 cell-days
  α[m]     = w · α_local[m] + (1 − w) · α_region[m]
  ```

- **Fallbacks:** if `ΣM = 0`, then `α = α_region[m]`. If no regional value exists, use the global constant computed by the backfill.
- **Clamp:** `α` is clamped to `[0.5, 10]`.
- **Output:** α for each month, with `w`, `ΣM` and `ΣV` included for transparency.

### 7.3 Harmonized daily series

`harmonizeDaily(dailyM, dailyV, availability, alpha) → HarmonizedDay[]`, applied per day `d` in month `m`:

| Condition | `harmonizedCellDays` | `basis` |
|---|---|---|
| A VIIRS reference satellite has data for `d` | `V(d)` | `VIIRS` |
| Else, MODIS has data for `d` | `α[m] · M(d)` | `MODIS_SCALED` |
| Else | `0` (flagged) | `NONE` |

The VIIRS start (2012), VIIRS outages and the MODIS retirement are therefore handled per day, and partial months are never biased.

---

## 8. Calendars and anomalies (`src/calendar.ts`, `src/anomalies.ts`)

### 8.1 Calendar

`buildCalendar(days: HarmonizedDay[], peakFrp?) → CalendarCell[]`

- It sums the harmonized days into Year × Month cells.
- A month is `complete = false` when any day in it is in the future or has `basis = NONE`.
- **FRP is not harmonized in v1.** `peakFrpMw` is the maximum per-cell-day `peakFrpMw` in the month. It carries `peakFrpSensor`, and the UI labels it accordingly.

### 8.2 Anomalies

`computeAnomalies(calendar, { baselineYears: [2001, 2025], excludeTargetYear: true })`. For each calendar month `m`, the baseline is the `complete` values for `m` across the baseline years, excluding the year being scored. The outputs are:

- `median`, `p10`, `p25`, `p75`, `p90`, `mean`, `n`
- `ratioToMedian = x / median`. This is `null` if the median is 0.
- `robustZ = (x − median) / (1.4826 · MAD)`. This is `null` if MAD is 0.
- `percentile`: the rank of `x` within the baseline.
- `class`:
  - `record_low` / `much_below` (< p10) / `below` (< p25)
  - `normal` (p25–p75)
  - `above` (> p75) / `much_above` (> p90) / `record_high`

The same function also scores the **current, partial month**: `x` is compared with the baseline for the *same day-of-month span*. That baseline is computed by `cumulativeToDay(m, dayOfMonth)` from the daily series. This powers the realtime question "this month so far compared with the historical median".

### 8.3 Color helpers (`src/colors.ts`)

- `countClasses(values, 7)` returns quantile breaks for a sequential ramp (viridis-like, colorblind-safe).
- `anomalyColor(class)` maps to a diverging `PuOr` ramp centered on `normal`.
- These are exported so that the web app and the CSV/report outputs use identical classes.

---

## 9. Public API (`src/index.ts`)

```ts
export * from './types';
export { parseFirmsCsv } from './parse';
export { filterDetections, buildStaticMask } from './filter';
export { GRID_DEG, toCellId, cellCenter, cellsInBbox, snapBboxOutward, coarseBin, pointInPolygon } from './grid';
export { buildCellDays } from './celldays';
export { dailySensorCounts, pickViirsReference } from './harmonize';
export { computeAlpha } from './calibrate';
export { harmonizeDaily } from './harmonize';
export { buildCalendar } from './calendar';
export { computeAnomalies, cumulativeToDay } from './anomalies';
export { countClasses, anomalyColor } from './colors';
export const HARMONIZER_VERSION = '1.0.0';
```

`HARMONIZER_VERSION` is written into `manifest.json` and stored on every DB row as `hv`. When the version changes, a re-backfill is required, so the version makes stale data detectable.

---

## 10. Tests (vitest)

- **Parser:** both sample formats parse, `type` is `null` for `modis_recent_sample.csv`, and satellite codes are normalized.
- **Filter:** the type 2 and type 3 rows in the samples (4 + 7 MODIS, 98 + 48 VIIRS) are removed.
- **Grid:** round-trip, edge cases at ±180 and ±90, and cell IDs are stable.
- **Pass clustering:** synthetic detections at 05:35 / 05:36 / 07:20 give 2 passes.
- **Golden test:** the cell-day counts per satellite per day for 2020-08-15 → 19 are snapshotted.
- **Calibration:** synthetic data with a known ratio of 3 recovers α = 3. Shrinkage moves toward `α_region` as `ΣM → 0`.
- **Harmonization:** a month that straddles 2012-01-20 uses `MODIS_SCALED` before that date and `VIIRS` after it.
- **Anomalies:** a known baseline gives the expected median, robust z and class. A zero-MAD baseline gives `robustZ = null`.
- **Determinism:** the same input produces byte-identical CSV output.
