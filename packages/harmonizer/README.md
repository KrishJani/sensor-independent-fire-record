# `@repo/harmonizer` — Cross-Sensor Harmonization Engine

Pure TypeScript, zero runtime dependencies, no I/O. Shared by `api-worker`, `ingest-worker`, `web` and `scripts/backfill`.
Spec: [`SPEC.md`](SPEC.md). Method and validation: [`docs/HARMONIZATION.md`](../../docs/HARMONIZATION.md).

## Pipeline
1. **Parse** FIRMS CSV (MODIS/VIIRS, SP/NRT, API or archive) → normalized `Detection` (`parse.ts`).
2. **Filter**: drop `type` 1/2/3, static-source mask, MODIS confidence ≥ 30, VIIRS `n`/`h` (`filter.ts`). No FRP floor by default.
3. **Grid** onto the global `0.05°` grid, integer `cellId = row·7200 + col` (`grid.ts`).
4. **Cell-days**: one unit per (satellite, date, cell); passes split at 30-min gaps; `peak_frp = MAX(pass SUM(frp))` (`celldays.ts`).
5. **Calibrate** α per calendar month and MODIS configuration (Terra∪Aqua / Terra / Aqua):
   `α_m = ΣV / ΣM` over overlap days (VIIRS ÷ MODIS → *VIIRS-equivalent* cell-days), shrunk toward a prior (`calibrate.ts`).
6. **Harmonize** per day with OR-based availability: VIIRS if available, else α·MODIS, else NONE (`harmonize.ts`).
7. **Calendar / anomalies / validation** (`calendar.ts`, `anomalies.ts`, `validate.ts`).

```bash
node --test "packages/harmonizer/test/*.test.ts"
```
