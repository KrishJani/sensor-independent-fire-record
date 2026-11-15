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

### 3.1 Starting point: a ratio of detection probabilities

Let N(d) be the number of truly burning cells. Each one is detected by VIIRS with probability
p_V and by MODIS with probability p_M (p_V > p_M because VIIRS is more sensitive). Then

```
E[V(d)] = p_V · N(d),   E[M(d)] = p_M · N(d)   ⇒   E[V(d)] = α · E[M(d)],  α = p_V / p_M
```

This argues for a **multiplicative** factor: zero MODIS activity maps to zero, and an
additive offset would invent fire on fire-free days. The calendar is in **VIIRS-equivalent
cell-days**, because VIIRS continues after MODIS: present data stays native and the MODIS
record is scaled up (α ≥ 1).

The simplest version takes one α per calendar month: α_m = Σ V / Σ M over the overlap days.
This ratio of sums is the maximum-likelihood estimate under V(d) ~ Poisson(α·M(d)), because
∂/∂α Σ[V log(αM) − αM] = 0 ⇒ α̂ = ΣV/ΣM. It is defined on zero-fire days, unlike a mean of
daily ratios.

### 3.2 Why a constant ratio is not enough (evidence)

The constant ratio assumes that p_V/p_M is the same in quiet and busy months. On the
California 2013–2021 overlap it is not:

- **37–42% of VIIRS cell-days fall in 0.5° areas where MODIS saw nothing that day.** These
  are small and cool fires that only VIIRS detects, and their number does not rise in step
  with large-fire activity.
- **Inside large fire complexes, both sensors flag nearly every 5.5 km cell.** VIIRS
  therefore has little to add in a big month.
- **The result:** within a calendar month, the log-log slope of V on M is 0.82 ± 0.02, not 1.
  A constant α overstated the busiest 10% of months by 6.8% and understated the quietest
  25% by 9.0% (out of sample).

Alternatives were tested on the real overlap data with leave-one-year-out
(`scripts/backfill/experiments/alpha-models.ts`). α stratified by local fire density did not
remove the bias (residual slope 0.80). Adding a fixed per-area background over-corrected
(1.34). What worked was letting α depend on **how active the region is that month**.

### 3.3 The model: Poisson GLM with log link [`fitAlphaModel`, `model.ts`]

For each MODIS configuration c, the unit is one (year, calendar month) of overlap days:
n days, M = Σ M_c(d), V = Σ V(d).

```
E[V] = n · exp(a_m + β · log(M / n))           a_m: one intercept per calendar month; β: shared
```

- **β = 1 is exactly the constant ratio** (a_m = log ΣV/ΣM). The new model nests the old one,
  so the data decide between them. A quasi-likelihood F-test of β = 1 against free β is
  reported in `alpha_model.json`.
- **California, 2013–2021:** **β = 0.862** (90% CI 0.785–0.894). The test gives F = 71.7,
  p < 0.0001, so the constant ratio is rejected.
- **Fitting:** maximum likelihood on the count scale, so there is no log-transform
  retransformation bias. The a_m have a closed form given β, and β takes Newton steps on the
  profile likelihood. Convergence is quadratic, and the parameters are recovered exactly on
  synthetic data (tests).

### 3.4 Applying it: α_eff per month, additive by construction [`effectiveAlphas`]

```
rate(y, m)   = region's MODIS cells per day in that month (days where config c flew)
α_eff(y, m)  = exp(a_m) · rate^(β − 1)          (β < 1 ⇒ busier month, smaller α)
H(d)         = α_eff(y, m) · M(d)               for every day d of that month
```

- **Additive.** Every day of a month uses the same α_eff, so the days add up to the month.
  α_eff comes from the **region's** activity, so a user-drawn AOI inside the region is
  exactly the sum of its parts. (A power law applied to each AOI's own totals would not be
  additive.)
- **No extrapolation.** The rate is clamped to the range seen for that month in calibration,
  and α_eff to [0.5, 10].
- **Quiet months borrow strength.** a_m is shrunk toward the ΣM-weighted mean of all months,
  with weight w = ΣM/(ΣM + k), k = 50 MODIS cell-days.
- **Too little data.** With fewer than 3 calibration years, β is fixed at 1 and the model is
  the constant ratio. It is flagged `kind: "ratio"`. This applies to the 5-day test fixture.
- **One model per MODIS configuration** (Terra ∪ Aqua, Terra only, Aqua only). \|T ∪ A\| ≥ \|T\|,
  so using the TA factor on Terra-only days (2000-11 → 2002-07) would bias them low. On the
  fixture that bias is 13%.
- **Calibration window:** `calibrationYears: [2013, 2021]`. 2012 is partial (VIIRS SP starts
  on 2012-01-20). After 2021, Terra and Aqua drift off their nominal overpass times.
- **Uncertainty:** a year-block bootstrap (1000 reps, fixed seed) gives the CIs for β and
  for α at each month's typical activity. Whole years are resampled because days within a
  fire season are autocorrelated.
- **Outputs:**
  - `alpha_model.json`: the full model
  - `alpha_effective.csv`: the α applied, per (year, month, config)
  - `alpha_monthly.csv`: α at each month's typical activity, for display
- **User-drawn AOIs (api-worker):** use the regional α_eff, times an optional local factor
  ρ_m = ΣV_AOI / Σ(α_eff · M_AOI) over the AOI's overlap days, shrunk toward 1 with the same w.

## 4. Harmonized daily series: OR-based availability [`harmonizeDaily`]

For each day *d* in month *m*. The series is dense: every date in range gets a row, and
zero-fire days are explicit zeros.

| condition | harmonized | basis |
|---|---|---|
| a VIIRS reference has data on d | V(d) | `VIIRS` |
| else, a MODIS configuration c has data | α_eff,c(y, m) · M_c(d) | `MODIS_SCALED` |
| else | 0, month flagged `complete = false` | `NONE` |

Exactly one sensor family contributes per day, so nothing is double-counted.

**MODIS is also harmonized on every day it flew** (`modis_scaled_cell_days`), VIIRS days
included. The calendar ignores that series on VIIRS days. It is the cross-check: for
2012–2026 it can be plotted against the observed VIIRS series to show that the scaling
reproduces VIIRS. It also gives a MODIS-only record in VIIRS units from 2000 to the end of
MODIS. The 2012
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

## 5. Validation [`validateModel` → `validation.json`]

All of these are computed per MODIS configuration, on monthly totals over overlap days.
Every score is also computed for the constant-ratio model (β = 1), so the two can be
compared directly (`loyoConstantRatio`).

| Score | What it measures |
|---|---|
| **LOYO MdAPE** | Refit without year y, predict year y: the honest out-of-sample error. **Acceptance ≤ 15%** (SPEC §11) |
| **Top-10% / bottom-25% bias** | Σpred/Σobs − 1 over the busiest and the quietest months |
| **Residual β** | Within-month slope of log observed on log predicted (month fixed effects). 1 means unbiased across activity levels. **Acceptance \|β_res − 1\| ≤ max(0.1, 2·SE)** |
| **Transition step** | Median over overlap years of Σ(α_eff·M) / ΣV. ≈ 0 means switching sensors (at 2012 or at any outage) creates no step. **Acceptance ≤ 5%** |

**California, 2013–2021 overlap (Terra ∪ Aqua):**

| | Constant ratio (β = 1) | Activity-dependent α (β = 0.862) |
|---|---|---|
| LOYO MdAPE | 9.8% | **8.0%** |
| Busiest 10% of months | +6.8% | **+0.7%** |
| Quietest 25% of months | −9.0% | **−2.1%** |
| Total bias | +1.0% | +0.9% |
| Residual β | 0.80 ± 0.02 ✗ | **0.91 ± 0.03** ✓ |
| Transition step (in-sample) | −1.0% | +3.2% (worst year 7%) |

All three acceptance checks pass. The fixture spans only 5 days, so its validation fields
are `null` and its model is the flagged constant ratio.

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
