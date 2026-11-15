# `@repo/db` — Database Schemas & Migrations

Contains DDL schemas and typed query builders for both storage tiers.

## Storage Tiers
- **`d1/` (Cloudflare D1 / SQLite)**: Holds rolling ~150 days of provisional `_NRT` daily grid cells. Primary key: `(acq_date, grid_lat, grid_lon, sensor)`.
- **`postgres/` (PlanetScale Postgres)**: Holds the authoritative `2000–2026` `_SP` daily grid cell archive. Indexed on `(grid_lat, grid_lon, acq_date)` for fast bounding-box and polygon filtering via Hyperdrive.
