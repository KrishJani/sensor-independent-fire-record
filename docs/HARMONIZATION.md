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

### 3.3 The model (v1.2): VIIRS-only background + activity-scaled MODIS [`fitAlphaModel`, `model.ts`]

For each MODIS configuration c, the unit is one (year, calendar month) of overlap days:
n days, M = Σ M_c(d), V = Σ V(d), r = M/n (MODIS cells per day).

```
E[V] = n · b_m  +  n · exp(a_m) · r^β
       └ background ┘  └ MODIS-visible fires, activity-scaled ┘
```

- **b_m, the background,** is VIIRS cells per day from small and cool fires that MODIS does not
  detect. That activity does not grow with large-fire activity. One value per calendar month.
- **exp(a_m) · r^β** is the part MODIS can see, scaled up with an exponent that lets busy and
  quiet months differ.
- **Nesting.** b = 0 gives the v1.1 model, and b = 0 with β = 1 gives the constant ratio
  ΣV/ΣM. The data decide. A quasi-likelihood F-test of the constant ratio against the fitted
  model (13 df) is in `alpha_model.json`.
- **Fitting.** EM provides a starting point. Each month's V is split into background and scaled
  parts by their expected shares, then b, a and β are refitted. Newton's method on all 25
  parameters then finishes the fit (quadratic convergence, with step-halving so the likelihood
  never decreases). A boundary check also evaluates b = 0 exactly, because EM approaches that
  edge slowly. Months where MODIS saw nothing also inform b. The tests recover b, a and β
  exactly from synthetic data.
- **California 2013–2021:**
  - The background is **11% of VIIRS cell-days**.
  - **β = 0.96 (90% CI 0.88–1.06).** Once the background is modelled, the remaining activity
    dependence is weak: most of what v1.1 read as "saturation" was the background.
  - The constant ratio is rejected: F(13) = 9.6, p < 0.0001.

**How we got here.** Each model was tested on the real overlap data with leave-one-year-out
validation, and the better one was kept (`scripts/backfill/experiments/`):

| Version | Model | Evidence |
|---|---|---|
| v1.0 | Constant ratio | Biased: busiest months +7%, quietest −9% |
| v1.1 | Exponent only | Bias left in 6 of 9 US regions |
| v1.2 | Background + exponent | Passes the noise-aware bias check in all 8 modelled US regions; Hawaii keeps the constant ratio (§8) |

Explanations that were tested and **rejected**:

- Counting noise. The regions have 280–2,700 cells/month, so noise alone gives about 2–7% error.
- Gas flares. The static-source mask already removes them.
- MODIS-visible fire size (FRP and isolation). It did not explain the year-to-year swings.

### 3.4 Applying it: α_eff per month, additive by construction [`effectiveAlphas`]

```
r(y, m)      = the region's MODIS cells per day in that month (days where config c flew)
α_eff(y, m)  = b_m / r  +  exp(a_m) · r^(β − 1)        (expected VIIRS per MODIS cell)
H(d)         = α_eff(y, m) · M(d)                      for every day d of that month
```

- **Additive.** Every day of a month uses the same α_eff, which comes from the region's own
  activity. Days therefore add up to the month, and an AOI inside the region is exactly the sum
  of its parts. The month total equals the model mean n·b + n·e^a·r^β.
- **No imputation without MODIS.** In a month where MODIS saw nothing in the whole region,
  H = 0. Small fires are not invented where no sensor saw fire.
- **No extrapolation.** The rate is clamped to the range seen for that month in calibration,
  and α_eff to [0.5, 10].
- **Quiet months borrow strength.** a_m and b_m are shrunk toward their ΣM-weighted means with
  weight w = ΣM/(ΣM + k), k = 50.
- **Too little data.** With fewer than 3 calibration years, the model falls back to the
  constant ratio and is flagged `kind: "ratio"`.
- **One model per MODIS configuration** (Terra ∪ Aqua, Terra only, Aqua only). Using the TA
  factor on Terra-only days (2000-11 → 2002-07) would bias them low by about 13%.
- **Calibration window:** 2013–2021. 2012 is partial, and Terra and Aqua drift off their
  nominal overpass times after 2021.
- **Uncertainty of the parameters:** a year-block bootstrap (1000 reps).
- **Uncertainty of the values:** §5.2.
- **Outputs:**
  - `alpha_model.json`: the full model
  - `alpha_effective.csv`: the α applied
  - `alpha_monthly.csv`: α at typical activity, for display
- **User-drawn AOIs (api-worker):** use the regional α_eff, times an optional local factor
  ρ_m = ΣV_AOI / Σ(α_eff · M_AOI) over overlap days, shrunk toward 1.
- **Groups of regions** (for example the US): the total is the sum of non-overlapping regions,
  each with its own model (§8).

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

All scores are on monthly totals over overlap days, per MODIS configuration. Every score is also
computed for the constant ratio (`loyoConstantRatio`), so the gain stays visible.

| Score | What it measures | Acceptance |
|---|---|---|
| **LOYO MdAPE** | Refit without year y, predict year y: the honest out-of-sample error | ≤ 15% (SPEC §11) |
| **Busiest 10% / quietest 25% bias** | Σpred/Σobs − 1 over the busiest and the quietest months | reported |
| **Residual β** | Within-month slope of log observed on log predicted; 1 = unbiased across activity | noise-aware (§5.1) |
| **Transition step** | Median over overlap years of Σ(α_eff·M)/ΣV; ≈ 0 means switching sensors creates no step | ≤ 5% |

### 5.1 Noise-aware bias check (parametric bootstrap)

Noise in the MODIS counts pulls the residual β below 1 even for a correct model (regression
dilution), and by a different amount in every region. A fixed threshold therefore misjudges
regions. Instead, each region's fitted model simulates its own overlap data 200 times:

- VIIRS is drawn quasi-Poisson, with the overdispersion measured in that region.
- MODIS is drawn Poisson.
- Each simulation is refit and scored exactly like the real data.

The region **fails only if its real residual β is below the 5th percentile** of these
correct-model simulations. `validation.json → configs.TA.noise` records the simulated ranges
and the real score's percentile. The overdispersion includes year-to-year variation that MODIS
cannot explain. The check therefore asks whether there is bias beyond what MODIS-only
information can resolve.

### 5.2 Uncertainty bands

The held-out errors give multiplicative 90% ranges (`configs.TA.uncertainty`), one for a month
and one for a calendar year.

- **They apply only to the MODIS-scaled part** of a month or year. VIIRS days are observed.
  Calendar columns: `scaled_cell_days`, `harmonized_lo`, `harmonized_hi`.
- **Group bands** (US) add the region bands. This is conservative, because it assumes the
  regions' errors move together.

### 5.3 Data sufficiency

A region is flagged `confidence: low` when fewer than 60 of its 108 overlap months have ≥ 20
VIIRS cell-days, or when the median month has fewer than 50. Its scores are indicative, and its
bands come from few months. On the US run this flags Hawaii and Alaska.

**California, 2013–2021 overlap (Terra ∪ Aqua), held out year by year:**

| | Constant ratio | v1.1 | **v1.2** |
|---|---|---|---|
| LOYO MdAPE | 9.8% | 8.0% | 8.2% |
| Busiest 10% / quietest 25% | +6.8% / −9.0% | +0.7% / −2.1% | +1.8% / +3.1% |
| Residual β | 0.80 | 0.91 | 0.94 (76th percentile of correct-model noise ✓) |
| A correct model would score | | | 7.6–11.1% error (overdispersion 6.6) |
| 90% band, MODIS-only month / year | | | ×0.80–1.23 / ×0.94–1.07 |

v1.2 is not better than v1.1 on raw error in California (8.2% vs 8.0%). Its gain is the
physical decomposition, and the removal of activity bias across the US regions (§8).

**Model selection.** If the overlap data do not reject the constant ratio (test p > 0.05), the
constant ratio is used and flagged in `reason`. More parameters are not used without evidence.
On the US run this applies only to Hawaii (p = 0.51).

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

**Decision (2026-11-15): keep 0.05°.** On the California 2013–2021 overlap the rule's numbers are:

| Grid | LOYO MdAPE | Residual β |
|---|---|---|
| 0.025° | 10.1% | 0.91 |
| 0.05° | 8.0% | 0.91 |
| 0.1° | 7.3% | 0.92 |

All three pass the checks. 0.1° is only 0.7 percentage points better, and it halves the
spatial resolution. Location accuracy is a stated goal, so the production grid stays at 0.05°
for the map, the cells and the calendar counts. The `grid_sensitivity.json` that recorded 0.1° as
the rule's pick is in git history (commit `1a03417`). Re-run with `--grid-sensitivity` to regenerate it.

## 8. Groups of regions (the US)

`config/regions.json` defines 9 US regions in group `us`:

- California (and W. Nevada), Pacific Northwest, Southwest, Interior West, Great Plains,
  Southeast, Midwest/Northeast, Alaska and Hawaii.

Regions are rectangles in priority order. Each one excludes the boxes listed before it, so they
**never overlap**. Of 11.7 M US detections, 0 fall in two regions and 8 fall in none (the far
Aleutians, across the date line).

- Each region is backfilled and validated on its own:
  `backfill run --region <id> --raw-dir data/raw/us`, using FIRMS Country Yearly Summary US
  files for 2000–2025.
- `backfill aggregate --group us` sums them into `data/harmonized/us/`. Harmonized counts are
  additive, so the US total is exactly the sum of the regions.
- **Cross-check:** where both sensors flew, the US-wide MODIS × α matches observed VIIRS within
  ±1.4% every year 2012–2021. After that it drifts low (−4% to −12% by 2025) with Terra/Aqua
  orbit drift. That is why calibration stops in 2021, and the calendar uses VIIRS for those
  years.

**US results, v1.2** (`data/harmonized/us/regions_summary.csv`). Errors are held-out; the
constant ratio is in brackets. "Correct-model range" is what simulations of a correct model
score at that region's own noise (§5.1).

| Region | Error | Correct-model range | Bias check | Background | Year band (90%) | Status |
|---|---|---|---|---|---|---|
| Southeast | 5.2% (6.1%) | 4.5–6.8% | p57 ✓ | 16% | −5% / +5% | ✓ |
| Great Plains | 7.3% (8.6%) | 6.2–8.7% | p69 ✓ | 20% | −4% / +11% | ✓ |
| California | 8.2% (9.8%) | 7.6–11.1% | p76 ✓ | 11% | −6% / +7% | ✓ |
| Pacific Northwest | 8.5% (10.1%) | 8.0–12.2% | p78 ✓ | 5% | −7% / +3% | ✓ |
| Midwest/Northeast | 10.0% (11.2%) | 9.2–13.6% | p24 ✓ | 17% | −8% / +12% | ✓ |
| Interior West | 15.2% (29.8%) | 13.3–18.9% | p7 ✓ | 36% | −20% / +21% | error 0.2 pt over 15%, at the noise floor |
| Southwest | 23.3% (23.4%) | 17.8–25.9% | p15 ✓ | 18% | −32% / +26% | error and step fail, at the noise floor |
| Alaska | 13.7% (14.4%) | — | p85 ✓ | 6% | −7% / +23% | low data |
| Hawaii | 26.8% (constant ratio used) | — | — | — | — | low data; constant ratio not rejected |

- In the Interior West and Southwest the remaining error is **inside what a correct model would
  score**. Their VIIRS/MODIS ratio swings between years for reasons that MODIS cannot observe
  (2.3–4.6 in the Interior West; none of activity, FRP or clustering explains it). No MODIS-based
  formula can remove that, so their bands are wide by design.
- The **US-wide year band is −7% / +9%** in the MODIS-only years (e.g. 2001: 93.5k–109.4k around
  100.7k cell-days). It is the sum of the region bands, so it is conservative.

