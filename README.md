# Skywalkers77
# NASA Space Apps 2026 — Harmonized Wildfire Activity Platform

Edge-native wildfire analytics platform harmonizing 26+ years of historical **MODIS (1 km)** and **VIIRS (375 m)** thermal anomalies into a consistent burning activity calendar and Fire Radiative Power (FRP) intensity record.

## Architecture Overview
- **`apps/web`**: React + Mapbox GL JS frontend deployed on Cloudflare Pages.
- **`apps/api-worker`**: Public Hono API serving `/api/calendar` (merging PlanetScale Postgres + D1) and `/api/chat` (AI Gateway + Agent Memory).
- **`apps/ingest-worker`**: Scheduled Cron Worker ingesting 3-hour `_NRT` detections into D1 and 24-hour finalized `_SP` detections into PlanetScale.
- **`packages/harmonizer`**: Shared pure-TypeScript spatial gridding (`0.05°`), overpass deduplication, and dynamic $\alpha_m$ calibration math.
- **`packages/db`**: SQL migrations and query helpers for Cloudflare D1 (SQLite) and PlanetScale (Postgres).

## First-Time Deployment Order
1. Provision Hyperdrive pointing to PlanetScale: `npx wrangler hyperdrive create firms-pg --connection-string="<POSTGRES_URL>"`
2. Paste the Hyperdrive ID into `apps/api-worker/wrangler.jsonc` and `apps/ingest-worker/wrangler.jsonc`.
3. Deploy `api-worker` first so Wrangler auto-provisions D1 and writes `database_id` into `apps/api-worker/wrangler.jsonc`.
4. Copy that generated `database_id` into `apps/ingest-worker/wrangler.jsonc` and deploy `ingest-worker`.
5. Set secrets on both Workers: `npx wrangler secret put FIRMS_MAP_KEY`
