# Archival map showcase data (proposal, nothing loaded)

**Problem:** the Archival map is empty because `cell_days` and `detections` are not loaded in the deployed Postgres (`detail_not_loaded`).
Only calendars and prone tiles are. Loading the full detail is several GB, too much for a demo.

**Goal:** the map shows real data for two showcase periods: California, Aug–Sep 2020, and Quebec, June 2023.

## Facts that shape the choice

- **Quebec is not in the archive.** The archive was loaded from FIRMS USA country files and the harmonized regions are US-only (`outside_regions` for Quebec). A Quebec period can only be raw detections (no harmonization, no calendar). The realtime Quebec replay scenario (`quebec-2023-06`, 2.7 MB JSON / 0.53 MB gzip, already in KV) already holds those detections.
- **A Postgres subset is unsafe as-is.** `requireDetail` is one global check (`exists (select 1 from cell_days)`). Loading two months would flip it to "detail loaded" for the whole archive, and every AOI/bbox calendar (which rebuilds from `cell_days`) would silently return zeros outside those two months. It would need a per-region/per-period flag first.
- Real numbers for California from the loaded calendar (`POST /api/calendar`, scope `california`): Aug 2020 3,009 and Sep 2020 5,851 harmonized cell-days; raw detections counted by the harmonization rule 55,363 and 126,352 (181,715 total).

## Option A (recommended): precomputed files in R2, read only for showcase periods

- Offline job (our `backfill` code, FIRMS SP files for the period) writes, per period, one gzip file for cells (cell id, date, satellites, peak FRP, detections: the `cells` level) and one for the strongest points (`points` level, capped like the API's 5,000 per request).
- Size, estimated: California about 20–30k cell-day rows (about 8,860 harmonized cell-days across 2–3 satellites) ≈ 0.5–1 MB gzip; points 180–500k detections packed ≈ 2–6 MB gzip. Quebec from the existing scenario ≈ 0.5 MB. Total ≈ 5–10 MB.
- Cost: R2 storage under 10 MB and a few requests (free tier is 10 GB and 1M reads/month): $0. One-off job: a FIRMS map key we already use and a few minutes of compute.
- How the map reads it: `/api/meta` gets `archival.showcase: [{ id, from, to, bbox, label, harmonized }]`. When `cell_days` is not loaded and the requested range lies inside a showcase period, `/api/archival/spots` answers from the R2 files (same GeoJSON shape and `meta`, `meta.source: "showcase"`), cached with the Cache API. Outside the periods it keeps saying detail is not loaded. The date picker is limited to the showcase periods with a notice; Quebec is labelled raw-only.
- Risk: low. No Postgres change, nothing else in the API changes behaviour.

## Option B: small Postgres subset

- California Aug–Sep 2020 only (Quebec cannot go in). ≈ 30k `cell_days` rows and 180–500k `detections` rows ≈ 30–80 MB with indexes. Same host as today, negligible cost.
- Needs the per-period detail flag above (code change in `lib/detail.ts` and every caller) to avoid wrong AOI calendars. More change for less coverage.

## Decision needed

Approve Option A, and say whether Quebec should be raw-only (recommended) or left out.

Default date: the Archival tab now opens on 2020-08-20 (California, first showcase period).
