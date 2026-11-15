# `@repo/db`: database schemas

## Storage tiers
- **`postgres/`** (PlanetScale Postgres, reached through Hyperdrive in Workers): the archival tier.
  `0001_archive.sql` defines the tables. The harmonized record covers 2000–2025 for the US regions
  and California. It includes:
  - `detections`, where `heat_class` is `fire` or `industrial` (the industrial-heat layer)
  - `cell_days` and `cell_months`
  - `source_availability`
  - α models and the α applied each month
  - daily, monthly and annual calendars with 90% bands
  - masks, the flare-inventory cells, and the global 0.5° map layer
- **`d1/`** (Cloudflare D1): the realtime tier, the last 92 days of NRT data. `0001_nrt_cells.sql`
  defines `nrt_detections`, `nrt_cell_days` and `nrt_availability`.

## Applying the migrations
- **Postgres:** `node scripts/backfill/src/cli.ts load …` applies them automatically. Applied
  versions are tracked in `schema_migrations`.
- **D1 (local):** `cd apps/ingest-worker && npx wrangler d1 migrations apply firms-nrt-cells --local`
- **D1 (remote):** the same command with `--remote`.

## Connection budget (PlanetScale Postgres)

- The plan allows **25** connections (`max_connections`), 3 of them reserved for superuser.
- Hyperdrive `firms-pg` is capped at **15** origin connections
  (`wrangler hyperdrive update 0ff8af0e49994b6b932f34caf78ece73 --origin-connection-limit 15`).
  At its default of 60, it took every slot and locked out the loader and local dev.
- That leaves room for the backfill loader (1 connection), local `wrangler dev` (direct, up to 5
  per request) and admin sessions.
- To raise the Hyperdrive cap, first make sure the plan's `max_connections` leaves at least 5
  slots for the loader and admin sessions.
