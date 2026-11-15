# MODIS → VIIRS harmonization: method and validation

Implementation: `packages/harmonizer/src/` (pure TypeScript). This document is the
scientific justification. Every formula below maps to one function, named in brackets.

---

## 1. Unit of activity: the active cell-day

Raw hotspot counts cannot be compared across sensors. A VIIRS 375 m pixel is about 1/7 the
area of a MODIS 1 km pixel, so one fire front lights up several VIIRS pixels where MODIS
sees one. In the fixture (California, 2020-08-15 → 19) there are **14,978 VIIRS** and
**2,293 MODIS** rows for the same fires, a 6.5× ratio that would put a false step at 2012.

We therefore count **active cell-days**: a 0.05° grid cell (~5.5 km) with ≥ 1 valid detection
from a given satellite on a given UTC date [`toCellId`, `buildCellDays`].

- A cell is far larger than either pixel, so pixel size and sub-pixel multiplicity drop out.
- Detections from one satellite in one cell on one day collapse to one unit, which removes
  repeat overpasses.
- On the fixture this alone shrinks the VIIRS/MODIS gap from **6.5× to ≈1.4×**. α only has
  to correct the remaining *sensitivity* difference (small or cool fires that MODIS misses).

Spatial accuracy is not lost. The map and exports keep native detections and native cells.
Only the **counts** used in the calendar are harmonized.

## 2. Daily sensor values

For a day *d* inside an AOI [`dailySensorCounts`]:

- **V(d)**: distinct active cells of **one** VIIRS reference satellite, chosen as SNPP, then
  NOAA-20, then NOAA-21, whichever has data on *d* [`pickViirsReference`]. Summing satellites
  would create artificial jumps in 2018 (NOAA-20) and 2023 (NOAA-21).
- **M(d)**: distinct active cells of the MODIS satellites operating on *d*. Which satellites
  those are depends on the date, so M is defined per configuration [`modisConfigFor`]:

| config | M(d) | when |
|---|---|---|
| `TA` | \|Terra ∪ Aqua\| (a cell seen by both counts once) | 2002-07-04 → (normal) |
| `T` | \|Terra\| | 2000-11-01 → 2002-07-03, and Aqua outages |
| `A` | \|Aqua\| | Terra outages |

## 3. The calibration factor α

### 3.1 Why multiplicative

Let N(d) be the number of truly burning cells. Each one is detected by VIIRS with probability
p_V and by MODIS with probability p_M (p_V > p_M because VIIRS is more sensitive). Then

```
E[V(d)] = p_V · N(d),   E[M(d)] = p_M · N(d)   ⇒   E[V(d)] = α · E[M(d)],  α = p_V / p_M
```

α depends only on relative sensitivity, not on how much is burning. So one factor applies to
quiet and active periods alike, and zero MODIS activity maps to zero VIIRS-equivalent
activity. An additive model (V = M + c) would invent fire on fire-free days and would
under-correct big months. We test this assumption rather than assume it (§5.4).

The calendar is expressed in **VIIRS-equivalent cell-days** because VIIRS continues after
MODIS. Present data stays native, and only the MODIS-only years are scaled. So
α = V/M ≥ 1 typically. Older READMEs stated MODIS/VIIRS, which was the wrong direction.

### 3.2 Estimator [`computeAlpha`]

Over the overlap days *d* in calendar month *m*, meaning days on which the MODIS configuration
and a VIIRS reference **both** have data [`calibrationSamples`]:

```
α_local[m] = Σ V(d) / Σ M(d)
```

This is the ratio of sums, not the mean of daily ratios V/M:

- It is the **maximum-likelihood** estimator if V(d) ~ Poisson(α·M(d)). Setting
  ∂/∂α Σ[V log(αM) − αM] = ΣV/α − ΣM = 0 gives α̂ = ΣV/ΣM.
- It is the weighted least-squares slope through the origin when Var[V|M] ∝ M, which is
  count noise.
- It is defined on days with M = 0. A mean of daily ratios is undefined there, and it is
  biased upward by days with small denominators (Jensen).

### 3.3 Seasonal and regional variation, and shrinkage

α varies with the fire regime: small agricultural burns in spring, large wildfires in
summer, cloud and day-length differences. It is therefore estimated **per calendar month**
and **per region** (the backfill writes `alpha_monthly.csv` for each region in
`config/regions.json`).

Quiet months have few overlap cell-days, so their raw ratio is noisy. We shrink toward a
prior:

```
w     = ΣM / (ΣM + k)                       k = 50 MODIS cell-days (config: alphaShrinkageK)
α[m]  = w · α_local[m] + (1 − w) · α_prior[m]       clamp to [0.5, 10]
```

- For the **regional** table, the prior is the region's pooled all-month ratio ΣV/ΣM.
- For a **user-drawn AOI** (api-worker, Stage 3+), the prior is the regional α[m]. A
  small AOI therefore inherits the regional factor, and a large one earns its own.
- k = 50 means a month needs 50 MODIS cell-days of overlap to get half its weight from local
  data.

### 3.4 One α per MODIS configuration [`computeAlphaTable`]

\|Terra ∪ Aqua\| ≥ \|Terra\|. Applying the TA factor to Terra-only days (2000-11 → 2002-07)
would bias those 20 months low by \|T∪A\|/\|T\|. On the fixture that ratio is 289/255 = 1.13,
a 13% artificial drop. Each configuration therefore gets its own α, fitted on the same
overlap years using only its own satellites for M(d). Terra-only and Aqua-only samples
exist on every overlap day, so neither is data-starved.

### 3.5 Calibration window

`calibrationYears: [2013, 2021]` (config). 2012 is excluded because VIIRS SP starts on
2012-01-20. Years after 2021 are excluded because Terra and Aqua drift off their nominal
equator-crossing times, which changes the diurnal sampling and therefore M.

### 3.6 Uncertainty

A **year-block bootstrap** (1000 reps, fixed seed) gives a 90% interval per month
(`ci90_low`, `ci90_high` in `alpha_monthly.csv`). It resamples whole years because days
within a fire season are strongly autocorrelated.

## 4. Harmonized daily series: OR-based availability [`harmonizeDaily`]

For each day *d* in month *m*. The series is dense: every date in range gets a row, and
zero-fire days are explicit zeros.

| condition | harmonized | basis |
|---|---|---|
| a VIIRS reference has data on d | V(d) | `VIIRS` |
| else, a MODIS configuration c has data | α_c[m] · M_c(d) | `MODIS_SCALED` |
| else | 0, month flagged `complete = false` | `NONE` |

Exactly one sensor family contributes per day, so nothing is double-counted. The 2012
transition, VIIRS outages and the eventual MODIS retirement are all handled day by day. A
partial-month transition (January 2012) is a weighted mix of correctly scaled days.

### 4.1 What "has data" means [`source_availability`]

A missing row is ambiguous: it could mean no fire or no data. Availability is therefore
recorded explicitly per satellite and per date:

- **API downloads:** each 5-day chunk file proves coverage of its dates, even when it is
  empty.
- **Archive downloads:** the observed date span of each file, conservatively. Quiet edge
  days become `NONE` instead of false zeros.
- Both are capped by the FIRMS availability API (`data/raw/availability.csv`) and by the
  start date of each satellite (`config/sensors.json`).
- `config/sensors.json → outages` lists confirmed outages manually.

### 4.2 Automatic outage detection [`detectOutages`]

Sometimes a satellite is nominally available but has zero cells while another available
satellite has ≥ 20 cells. This is treated as missing granules, and the day is removed from
that satellite's availability, so the OR-rule falls through to the other sensor.

Physically, VIIRS cannot see nothing while MODIS sees 20 cells. Example: the fixture has
Terra and VIIRS data but no Aqua rows on 08-16 and 08-18. Both days are detected, and they
fall back to config `T`. Detected days are listed in `outages_detected.csv`. Disable with
`--no-auto-outages`.

## 5. Validation [`validateCalibration` → `validation.json`]

All of these are computed per MODIS configuration on overlap days.

1. **In-sample agreement:** the monthly α·M against V. This reports the median absolute
   percentage error (MdAPE) over months with V ≥ 20.
2. **Leave-one-year-out (LOYO):** α is refitted without year y, then predicts year y. This
   is the honest out-of-sample error. **Acceptance: LOYO MdAPE ≤ 15%** (SPEC §11).
3. **Continuity across the transition:** for each overlap year,
   r(y) = Σ α·M / Σ V. If the MODIS-scaled and native-VIIRS series are interchangeable,
   r ≈ 1 with no trend, so switching between them (at 2012, or at any outage) cannot create
   a step. **Acceptance: |median r − 1| ≤ 5%.** The report also includes the worst year and
   the trend per year.
4. **Proportionality:** fit log V = a + β log M on monthly totals. β ≈ 1 supports a
   multiplicative α. β < 1 means the relation saturates (inside very large fires both sensors
   light up every 0.05° cell), so a single α would *overstate* record months before 2012.
   **Acceptance: |β − 1| ≤ max(0.1, 2·SE).** If this fails on the real data, report it, and
   consider stratifying α by activity level. Do not ignore it.

The sample fixture spans only 5 days, so LOYO, β and the bootstrap report `null` there.
They become meaningful with the full 2000–2026 backfill.

## 6. Out of scope (v1)

- **FRP is not harmonized.** `peak_frp_mw` comes from the basis sensor of the day and is
  labelled with that sensor.
- **NOAA-21** has an SP product (`VIIRS_NOAA21_SP`, from 2023-03-01) and an NRT product. It is
  the third-choice VIIRS reference, used only on days when neither SNPP nor NOAA-20 has data.
- **The same filters run on both tiers.** The confidence thresholds (MODIS ≥ 30, VIIRS
  n/h) and the static-source mask are applied identically to SP and NRT. Without this, the
  realtime and archival numbers for the same day would disagree. NRT has no `type` column,
  so the mask derived from SP `type = 1/2` stands in for it.

## 7. Grid-size sensitivity [`gridSensitivity` → `grid_sensitivity.json`]

0.05° is a trade-off between two failure modes:

- **Too fine:** the pixel-size effect returns. A MODIS footprint grows to about 2 × 5 km at
  the edge of its scan, and fires move between the 10:30 (Terra) and 13:30 (Aqua, VIIRS)
  overpasses. Fewer MODIS cells then coincide with VIIRS cells, and α grows and starts to
  depend on how much is burning.
- **Too coarse:** large fires fill whole cells for both sensors, so the ratio saturates.

`--grid-sensitivity` tests this choice on the real data instead of assuming it. It
re-grids the same filtered, de-duplicated detections at each size in `--grid-sizes`
(default `0.025,0.05,0.1`). It then reruns calibration and validation with the same
per-day availability, so cell size is the only variable. For each size it reports:

- pooled and monthly α
- in-sample and leave-one-year-out error (MdAPE)
- the transition step
- log-log β ± SE
- **coincidence**: the share of MODIS cells that the VIIRS reference also flagged that day

**Selection rule:** the lowest LOYO MdAPE among sizes whose proportionality and no-step
checks do not fail. Ties go to the production grid. The report only *recommends*. Production
stays on 0.05°. Adopting another size changes `GRID_DEG`, every `cell_id` and the DB size
(about 4× the cells at 0.025°), so it requires a `HARMONIZER_VERSION` bump and a full
re-backfill. Decide before the first Postgres load.
