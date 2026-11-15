# `ingest-worker` — Two-Tier NASA FIRMS Cron Pipeline

A background Cloudflare Worker with **one** cron, `0 */3 * * *`. It needs the secret `FIRMS_MAP_KEY`. Full spec: [`SPEC.md`](SPEC.md).

## Every 3 hours (always)
- **NRT → D1:** fetches `MODIS_NRT`, `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT` for the last `NRT_DAY_RANGE` (2) days. It runs them through `@repo/harmonizer` (the same filters and static mask as SP), upserts `nrt_detections`, and recomputes `nrt_cell_days`.

## Every 24 hours (same cron, gated by KV `ingest:sp:last_success_at`)
- **SP → Postgres** (via Hyperdrive): fetches newly published `MODIS_SP`, `VIIRS_SNPP_SP` and `VIIRS_NOAA20_SP` days, and replaces any provisional NRT rows for those days.
- **Handover:** D1 dates older than `D1_RETENTION_DAYS` (**92**) move to Postgres. They are dropped if SP already covers them, and otherwise stored as provisional `tier = 'NRT'`. They are then deleted from D1.

The single cron means the jobs can never overlap (there is also a KV lock), and a missed daily run catches up on the next 3-hour tick.
