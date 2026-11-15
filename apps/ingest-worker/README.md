# `ingest-worker` — Two-Tier NASA FIRMS Cron Pipeline

Background Cloudflare Worker triggered by scheduled Cron events. Requires secret `FIRMS_MAP_KEY`.

## Scheduled Jobs
1. **3-Hour Near Real-Time Sync (`0 */3 * * *`)**
   - Fetches `MODIS_NRT`, `VIIRS_NOAA20_NRT`, and `VIIRS_NOAA21_NRT` from NASA FIRMS.
   - Passes raw CSV detections through `@repo/harmonizer` to snap coordinates to the shared `0.05°` grid, sum sub-pixel VIIRS FRP per overpass, and take the daily `MAX` FRP per cell.
   - Upserts daily grid cells into **D1** (`env.NRT_DB`).
2. **24-Hour Standard Processing Sync (`0 2 * * *`)**
   - Fetches newly published science-grade `MODIS_SP` and `VIIRS_SNPP_SP` / `VIIRS_NOAA20_SP` detections.
   - Upserts gridded daily cells into **PlanetScale Postgres** via `env.HYPERDRIVE`.
   - Deletes superseded dates (`acq_date <= latest_sp_date` or older than `D1_RETENTION_DAYS`) from **D1** to prevent double-counting.
