# `@repo/db` — Database Schemas & Migrations

Contains DDL schemas and typed query builders for both storage tiers.

## Storage Tiers
- **`d1/` (Cloudflare D1 / SQLite)**: Holds a rolling window of exactly the last 92 days (`D1_RETENTION_DAYS`) of `_NRT` detections and cell-days; older dates are handed over to Postgres (see `apps/ingest-worker/SPEC.md` §3.3). Primary key: `(acq_date, grid_lat, grid_lon, sensor)`.
- **`postgres/` (PlanetScale Postgres)**: Holds the authoritative `2000–2026` `_SP` archive, plus provisional `tier = 'NRT'` rows for dates older than 92 days that SP has not published yet (replaced when SP arrives). Indexed on `(grid_lat, grid_lon, acq_date)` for fast bounding-box and polygon filtering via Hyperdrive.
