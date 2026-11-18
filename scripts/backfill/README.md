# `scripts/backfill` — Stage 1: historical archive → harmonized CSVs

This script runs on Node ≥ 22.18 or Node 26. It strips TypeScript types natively, so there
is no build step and nothing to install. The method is described in
[`docs/HARMONIZATION.md`](../../docs/HARMONIZATION.md).

```
node scripts/backfill/src/cli.ts <availability|download|run|verify> [options]
  --region california          id from config/regions.json
  --from 2000-11-01 --to YYYY-MM-DD
  --raw-dir data/raw/<region>  --out-dir data/harmonized/<region>
  --calibration-years 2013-2021   (default from config/regions.json)
  --bootstrap-reps 1000   --no-auto-outages   --dry-run   --quiet
  --grid-sensitivity [--grid-sizes 0.025,0.05,0.1]   compare cell sizes (docs/HARMONIZATION.md §7)
  download only: --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP --min-interval-ms 400 --max-transactions N
```

## 0. Smoke test on the fixtures (no key needed)

```bash
node --test "packages/harmonizer/test/*.test.ts" "scripts/backfill/test/*.test.ts"   # expect: pass 38, fail 0
node scripts/backfill/src/cli.ts run --raw-dir sample_api --out-dir /tmp/hb-sample \
     --from 2020-08-15 --to 2020-08-19 --calibration-years 2020-2020
```

Expected output:

```
[backfill] pass 1: static mask 14 cells; 10 NRT rows skipped; 0 rows outside region/range
[backfill] pass 2: kept 16042/17271 (type 157, mask 3, confidence 1069)
[backfill] pass 3: 2020: 16042 detections, 1058 cell-days
[backfill] availability: TERRA=5d AQUA=3d SNPP=5d NOAA20=0d NOAA21=0d; 2 auto-detected outage days
    8  1.381  1.381  0.85     289     399  —           ← α_Aug = 399/289
2020-08       575.0    386    575  1.00  false        ← 5 of 31 days → incomplete
```

## 1. MAP_KEY

Get a key at <https://firms.modaps.eosdis.nasa.gov/api/map_key/>, then:

```bash
cp .env.example .env     # set FIRMS_MAP_KEY=...
```

## 2. Published date ranges

```bash
node --env-file=.env scripts/backfill/src/cli.ts availability
```

This writes `data/raw/availability.csv` and prints `MODIS_SP 2000-11-01 → <max>`, and so on.
The download and run steps cap every satellite to these ranges.

## 3. Raw data. Choose A or B.

**A. Archive Download (preferred: fewer transactions, emailed zip)**

1. Go to <https://firms.modaps.eosdis.nasa.gov/download/> and choose **Create New Request**.
2. Set the area to a custom rectangle `-124.5, 32.5, -114.0, 42.1` (`config/regions.json`).
3. Set the dates to 2000-11-01 → today, and the format to **CSV**.
4. Submit one request each for **MODIS C6.1**, **VIIRS S-NPP 375 m** and
   **VIIRS NOAA-20 375 m**.
5. Unzip all of them into `data/raw/california/archive/`.

`fire_archive_*.csv` files are used. `fire_nrt_*.csv` files (the recent, not-yet-SP tail) and
rows whose version contains `NRT` are **skipped automatically**, because NRT belongs to D1
(Stage 4), not the archive.

**B. Area API (automatic, resumable)**

```bash
node --env-file=.env scripts/backfill/src/cli.ts download --from 2000-11-01 --to 2026-10-31
```

- It writes `data/raw/california/api/<SOURCE>/<date>_<n>d.csv` in 5-day chunks: about
  3,600 requests at 0.4 s spacing.
- Re-running skips chunks that already exist, so after a failure, run it again.
- It aborts on `Invalid MAP_KEY` or `Exceeding allowed transaction limit`. Wait 10 minutes,
  then re-run.

## 4. Run

```bash
node scripts/backfill/src/cli.ts run --from 2000-11-01 --to 2026-10-31
```

Expected: one `pass 3` line per year, the TA α table (the fixture gives 1.38 for August), and an acceptance line:

```
acceptance: {"loyoMdapeWithin15pct":true,"noStepAtTransition":true,"proportional":true}
```

If any of these is `false`, read `validation.json` before you commit (see
HARMONIZATION.md §5).

## 4b. Check the grid size (do this once, before the first Postgres load)

```bash
node scripts/backfill/src/cli.ts run --from 2000-11-01 --to 2026-10-31 --grid-sensitivity
```

This prints one row per grid size, for example:

```
grid     ~km   pooled α  LOYO MdAPE  in-sample  step    β (±SE)        proportional  no-step  coincidence
0.025    2.8   …
0.050    5.6   …
0.100   11.1   …
recommended: 0.05° (lowest LOYO MdAPE …% among 3 eligible size(s))
```

The full report is in `grid_sensitivity.json`, which is tracked in the manifest. A later run
without the flag deletes it, so it never describes stale inputs. If the recommendation is not
0.05°, stop and discuss: switching grids means a version bump and a full re-backfill. On the
5-day fixture there is only one calibration year, so it reports `recommended: none`.

## 5. Verify and commit

```bash
node scripts/backfill/src/cli.ts verify          # re-hashes outputs against manifest.json
git add data/harmonized/california && git commit -m "data: california harmonized backfill"
```

Outputs in `data/harmonized/<region>/`:

| file | contents |
|---|---|
| `cell_days/<year>.csv` | per-satellite cell-days (→ Postgres `cell_days`) |
| `detections/<year>.csv.gz` | filtered, de-duplicated raw hotspots, 5 dp, with `cell_id` (→ `detections`) |
| `alpha_monthly.csv` | α per month × MODIS config (TA/T/A), with ΣM, ΣV, w, 90% CI (→ `alpha_region`) |
| `static_mask.csv` | static-source cells (→ `static_mask`, NRT filter) |
| `source_availability.csv` | (satellite, date) with data (→ `source_availability`) |
| `calendar_monthly.csv` | regional Year × Month harmonized calendar |
| `daily_harmonized.csv` | dense daily series with basis / α / config / reference |
| `outages_detected.csv` | auto-detected outage days |
| `validation.json` | in-sample, LOYO, continuity, linearity, acceptance |
| `grid_sensitivity.json` | only with `--grid-sensitivity`: per-grid-size α, errors, checks, coincidence, recommendation |
| `manifest.json` | version, input digest, counts, availability ranges, output hashes |

Re-running with the same inputs gives byte-identical outputs. Hashes cover the
*uncompressed* content of `.gz` files, so a different zlib build can never fail `verify`.
## Loading into Postgres (Stage 3)

```bash
node --env-file=.env scripts/backfill/src/cli.ts load --all            # every region, group and global layer
node --env-file=.env scripts/backfill/src/cli.ts load --group us --prone
```

### Summary-only load (from a fresh clone)

The per-year `detections/` and `cell_days/` files are not in git, so a fresh clone cannot run the full
load. `--summary-only` loads what is in git: regions, α, availability, static masks, the daily,
monthly and annual calendars, and (with `--prone`) the fire-prone tiles. It skips the global layer.
It needs well under 100 MB of Postgres.

```bash
node --env-file=.env scripts/backfill/src/cli.ts load --all --summary-only --prone
```

Region and US calendars, FRP, prone areas and CSV export then work. The API reports
`archival.detail: false` in `/api/meta`, and the web app shows "Detailed hot spots are not loaded in
this deployment" in place of map hot spots, calendars for drawn areas and the world layer.

### Full load

Each region loads in one transaction and is checked against its `manifest.json`. After a successful
load the loader sets `data:version:archival` in the `FIRMS_INGEST_STATE` KV namespace (account and
namespace read from `apps/api-worker/wrangler.jsonc`, written with `wrangler kv key put --remote`).
The API puts that value in every cache key, so cached archival responses are dropped immediately.
Needs `wrangler login` on the right account. If the write fails, the data stays loaded and the exact
command to run by hand is printed. `--no-kv` skips it, for example when loading a scratch database.
