# Skywalkers77 — Harmonized Burning Activity Calendar (Main Spec)

NASA Space Apps 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots".

This is the top-level spec. Component specs:

- [`packages/harmonizer/SPEC.md`](packages/harmonizer/SPEC.md): cross-sensor harmonization engine (pure TypeScript).
- [`apps/ingest-worker/SPEC.md`](apps/ingest-worker/SPEC.md): cron worker for NRT and SP ingestion.
- [`apps/api-worker/SPEC.md`](apps/api-worker/SPEC.md): public API and the chat agent.

The web app (`apps/web`) and the backfill script (`scripts/backfill`) are specified in this document.

---

## 1. Goals

1. **Harmonize** MODIS (2000→) and VIIRS (2012→) active-fire hotspots from NASA FIRMS into one consistent daily and monthly time series. Once harmonized, the sensor a value came from does not matter.
2. **Serve** a burning activity calendar (Year × Month) for any area of interest (AOI), with anomalies against the multi-year median.
3. **Show** fire spots on an interactive map. The map fetches the spots for the visible area as the user pans and zooms.
4. **Separate** two data tiers:
   - **Archival** = FIRMS Standard Processing (`_SP`), stored in **PlanetScale Postgres**.
   - **Realtime** = FIRMS Near Real-Time (`_NRT`), stored in **Cloudflare D1**.
5. **Export** hotspots and the calendar as CSV.
6. **Assist** emergency managers with a chat copilot (AI Gateway + agent memory), grounded in the AOI the user is currently viewing.

### Non-goals (v1)

- Burned-area products (MCD64, VNP64). Only active-fire hotspots are in scope.
- Global coverage on day 1. Coverage is driven by a region config (see §4). It can grow to `world` later.
- Harmonizing FRP across sensors. FRP is shown with its native sensor label (see the harmonizer spec, §8).

---

## 2. Architecture

```
                         ┌───────────────────────────────┐
  FIRMS Archive download │  scripts/backfill (Node, once) │──► data/harmonized/**.csv  (checked in)
  (MODIS_SP, VIIRS_SP)──►│  uses @repo/harmonizer         │──► PlanetScale Postgres (--load)
                         └───────────────────────────────┘

  FIRMS Area API          ┌───────────────────────────────┐
  (_NRT every 3h,     ───►│  apps/ingest-worker (Cron)     │──► D1  (NRT: raw + cell-days)
   _SP gated to 24h)      │  uses @repo/harmonizer         │──► Postgres via Hyperdrive (SP)
                          │  KV: INGEST_STATE (flags)      │
                          └───────────────────────────────┘

                          ┌───────────────────────────────┐
  apps/web (Pages) ──────►│  apps/api-worker (Hono)        │──► Postgres via Hyperdrive (archival)
   Map / Calendar / Chat  │  /api/archival/* /api/realtime/*│──► D1 (realtime)
                          │  /api/calendar /api/chat        │──► AI Gateway + FireCopilotAgent (DO memory)
                          └───────────────────────────────┘
```

### Shared bindings

| Resource | Binding | ingest-worker | api-worker |
|---|---|---|---|
| PlanetScale Postgres (via **one shared Hyperdrive config**) | `HYPERDRIVE` | read/write | read-only |
| D1 `firms-nrt-cells` | `NRT_DB` | read/write | read-only |
| KV `INGEST_STATE` | `INGEST_STATE` | read/write (flags, locks) | read-only (data version, SP boundary) |
| Workers AI / AI Gateway | `AI` | — | yes |
| Durable Object `FireCopilotAgent` | `FIRE_COPILOT` | — | yes |
| Secret `FIRMS_MAP_KEY` | secret | yes | — |

Both workers reference the **same Hyperdrive config ID** and the **same D1 `database_id`** and **KV namespace ID**.

---

## 3. Data sources (NASA FIRMS)

| Source ID | Sensor | Tier | Satellite code |
|---|---|---|---|
| `MODIS_SP` | MODIS C6.1 | archival | `TERRA`, `AQUA` |
| `VIIRS_SNPP_SP` | VIIRS 375 m | archival | `SNPP` |
| `VIIRS_NOAA20_SP` | VIIRS 375 m | archival | `NOAA20` |
| `VIIRS_NOAA21_SP` | VIIRS 375 m | archival | `NOAA21` (from 2023-03-01) |
| `MODIS_NRT` | MODIS C6.1 | realtime | `TERRA`, `AQUA` |
| `VIIRS_SNPP_NRT` | VIIRS 375 m | realtime | `SNPP` |
| `VIIRS_NOAA20_NRT` | VIIRS 375 m | realtime | `NOAA20` |
| `VIIRS_NOAA21_NRT` | VIIRS 375 m | realtime | `NOAA21` |

- Area API: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE 1..5}/{YYYY-MM-DD}`.
- Availability API: `https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{MAP_KEY}/ALL`. It gives the min and max date per source and is used to detect newly published SP days.
- Rate limit: 5000 transactions per 10 minutes per MAP_KEY. Every caller must throttle.
- The FIRMS raw satellite codes (`Terra`, `Aqua`, `N`, `1`, `2`) are normalized to the codes in the table above by the harmonizer.

Sample fixtures in `sample_api/` cover California, 2020-08-15 → 2020-08-19 (August Complex / LNU fires). They are the golden test inputs.

---

## 4. Shared config: `config/regions.json`

This file lists the AOIs that are backfilled and ingested. The backfill script, the ingest worker (bundled at build time) and the web app (default view) all read it.

```json
{
  "regions": [
    { "id": "california", "name": "California, USA", "bbox": [-124.5, 32.5, -114.0, 42.1] }
  ],
  "gridDeg": 0.05,
  "calibrationYears": [2013, 2021],
  "baselineYears": [2001, 2025]
}
```

Users can draw any AOI. Data, however, only exists inside configured regions. The UI shows region outlines and clips queries to them.

---

## 5. Data model (summary)

The unit of harmonized activity is the **active cell-day**: one 0.05° grid cell (about 5.5 km) with at least one valid detection from a given satellite on a given UTC date. Full definitions are in the harmonizer spec.

| Table | Store | Contents |
|---|---|---|
| `detections` | Postgres | Raw filtered SP hotspots (for map points and CSV export) |
| `cell_days` | Postgres | SP cell-days per satellite |
| `cell_months` | Postgres | Monthly rollup of `cell_days` per cell per satellite (fast calendar) |
| `source_availability` | Postgres | Which satellite has SP data for which date |
| `static_mask` | Postgres + checked-in CSV | Cells with persistent non-vegetation heat sources |
| `alpha_region` | Postgres + checked-in CSV | Regional monthly calibration factors (fallback) |
| `nrt_detections` | D1 | Raw filtered NRT hotspots (rolling window) |
| `nrt_cell_days` | D1 | NRT cell-days per satellite |

Migrations are in `packages/db/postgres/` and `packages/db/d1/`.

---

## 6. Backfill script: `scripts/backfill`

This is a one-time, re-runnable Node script (`pnpm --filter backfill start`). It produces the historical harmonized dataset, **checks it into git**, and optionally loads it into PlanetScale.

### 6.1 Inputs

- **Preferred:** FIRMS Archive Download CSVs (requested at firms.modaps.eosdis.nasa.gov/download) for `MODIS_SP` (2000-11 →) and `VIIRS_SNPP_SP` / `VIIRS_NOAA20_SP` (2012 → / 2018 →), clipped to each region. These go in `data/raw/<region>/` and are **gitignored** because they are too large.
- **Fallback:** `--source=api` pulls the same data through the Area API in 5-day chunks, throttled to the rate limit. This is slow but needs no manual download.

### 6.2 Pipeline (all logic is in `@repo/harmonizer`)

1. Stream-parse the raw CSVs with `parseFirmsCsv`.
2. Build the static source mask from `type = 2` (and `type = 1`, volcano) detections, then `filterDetections`.
3. `buildCellDays` per satellite.
4. Build `source_availability` from the dates present in each source, combined with the FIRMS availability API.
5. `computeAlpha` per calendar month over `calibrationYears` for the whole region. The result is `alpha_region`.
6. `harmonizeDaily` → `buildCalendar` gives the regional Year × Month harmonized calendar.
7. Write the outputs (below) and a manifest.
8. With `--load`, upsert everything into Postgres through a direct connection string (`DATABASE_URL`; Hyperdrive is not needed outside Workers). Then refresh `cell_months` and set the KV flags `ingest:sp:latest_date:<satellite>` with `wrangler kv key put`. This lets the ingest worker continue exactly where the backfill stopped.

### 6.3 Checked-in outputs

```
data/harmonized/<region>/
  cell_days/<year>.csv           # per-satellite cell-days, one file per year
  detections/<year>.csv.gz       # filtered raw hotspots (gzip), for reloading Postgres / CSV export
  alpha_monthly.csv              # month, alpha, modis_cell_days, viirs_cell_days, n_years
  static_mask.csv                # cell_id, grid_lat, grid_lon, n_static_detections
  source_availability.csv        # satellite, acq_date
  calendar_monthly.csv           # year, month, harmonized_cell_days, modis_cell_days, viirs_cell_days, source_mix
  manifest.json                  # harmonizer version, input file SHA-256s, row counts, date ranges, generated_at
```

- Every CSV is deterministic: sorted rows, fixed float precision (4 dp for coordinates, 1 dp for FRP). Re-running with the same inputs produces a byte-identical diff.
- Size budget: no single file over 50 MB. If one exceeds that, split it by half-year, or track `detections/` with Git LFS.
- CI check: `pnpm backfill verify` re-hashes the files against `manifest.json`.

### 6.4 CLI

```
pnpm --filter backfill start -- \
  --region california \
  --from 2000-11-01 --to 2026-10-31 \
  --source archive|api \
  [--load] [--dry-run]
```

---

## 7. Web app: `apps/web`

This is React + Vite + Mapbox GL JS (with Mapbox Draw), deployed on Cloudflare Pages. It needs `VITE_MAPBOX_TOKEN` and `VITE_API_BASE`.

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ [ Archival | Realtime ]  tabs (top-left)       ┌───────────────┐ │
│                                                │ Calendar box  │ │  ← top-right
│                                                │ (date range)  │ │
│                 MAP (full-bleed)               └───────────────┘ │
│                                                                  │
│                                                         ┌──────┐ │
│ ┌──────────────────────────────────────────────┐        │ Chat │ │  ← bottom-right
│ │ Burning activity calendar / charts drawer    │        └──────┘ │
│ └──────────────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
```

- **Tabs: Archival and Realtime.** Switching tabs changes the data source of the map, the calendar, the export and the chat context. The map camera and the drawn AOI are kept across the switch.
- **Calendar box (top-right, on both tabs).** A compact date-range selector that drives every query.
  - *Archival:* year range (2000 → latest SP year) plus optional month filter (for example, "Aug only"), or an explicit from/to date. Bounds come from `GET /api/meta` (`archival.minDate`, `archival.maxDate`).
  - *Realtime:* presets `24h`, `48h`, `7d` (default), `30d`, and custom. Custom is bounded to the D1 window (`realtime.minDate` → now) from `/api/meta`.
- **Chat (bottom-right).** A floating button that opens a side panel. It sits bottom-right so it never overlaps the calendar box. See the api-worker spec, §6.
- **Calendar drawer (bottom).**
  - *Archival:* the Year × Month heatmap of harmonized cell-days for the AOI, with a toggle between counts and anomaly. Below it, a monthly climatology chart (median and P10–P90 band) and the annual totals.
  - *Realtime:* a daily strip for the selected range, plus "this month so far compared with the historical median for this month" from `/api/calendar?mode=realtime`.
- **AOI.** Draw a polygon or rectangle, type lat/lon plus a radius, or use the current viewport if nothing is drawn.
- **Export.** Two buttons: "Hotspots CSV" and "Calendar CSV". Each calls `/api/export/*` with the current tab, AOI and range.
- **Colors.**
  - Counts use a sequential, colorblind-safe ramp (viridis/inferno family) on quantile classes.
  - Anomalies use a diverging, colorblind-safe ramp (ColorBrewer `PuOr`) centered on the median.
  - Every color cell also shows its number on hover or focus. Color is never the only channel.

### 7.2 Fetching fire spots as the map moves

The map always shows the fire spots for the **current viewport**, current tab and current calendar range.

1. **Trigger:** the Mapbox `moveend` event (it fires after pan, zoom, rotate and fly-to), plus any change of tab, calendar range or data version. Events are debounced by **250 ms**.
2. **Viewport key:**
   - Take `map.getBounds()`, pad it by **25%** on each side, and snap it outward to the 0.05° grid. Clamp it to configured regions.
   - Bucket the zoom: `z ≤ 6` → `coarse`, `7–9` → `cells`, `≥ 10` → `points`.
   - Cache key: `tab | snappedBbox | zoomBucket | from | to | dataVersion`.
3. **Skip if covered:** if the new raw viewport is fully inside the padded bbox of the last successful fetch with the same zoom bucket, tab, range and version, nothing is fetched. Small pans therefore cost nothing.
4. **Cancel stale requests:** each fetch gets an `AbortController`, and starting a new fetch aborts the previous one.
5. **Request:**
   - Archival: `GET /api/archival/spots?bbox=w,s,e,n&from=&to=&level=coarse|cells|points`
   - Realtime: `GET /api/realtime/spots?bbox=w,s,e,n&from=&to=&level=coarse|cells|points`
6. **What each level returns** (GeoJSON `FeatureCollection`):
   - `coarse`: 0.5° bins with `cell_days` and `peak_frp_mw`, drawn as a heatmap or graduated squares.
   - `cells`: 0.05° harmonized cells with `cell_days`, `peak_frp_mw` and `last_seen`, drawn as filled squares.
   - `points`: raw detections (lat, lon, satellite, time, FRP, confidence), drawn as circles. The response is capped at 5000 features; when the cap is hit, `truncated: true` is set and the UI says "zoom in to see all".
7. **Client cache:** an in-memory LRU of 50 entries keyed by the cache key. Switching tabs back and forth or returning to a previous view renders instantly from it.
8. **Freshness:** on the Realtime tab, the app polls `GET /api/meta` every 5 minutes. When `realtime.dataVersion` changes, which happens after each 3-hour ingest, the current viewport is refetched and the cache is cleared for the Realtime tab.
9. **AOI calendar:** the AOI calendar is fetched separately via `POST /api/calendar`, only when the AOI or range changes, not on every pan. When no AOI is drawn, panning updates the viewport-AOI calendar, debounced by **1 s**.
10. **Loading and errors:** a thin progress bar sits at the top of the map. On error the previous data stays on screen and a toast appears. The map never goes blank.

---

## 8. KV flags: `INGEST_STATE` (summary)

| Key | Writer | Meaning |
|---|---|---|
| `ingest:nrt:last_success_at` | ingest | ISO time of the last successful NRT run |
| `ingest:sp:last_success_at` | ingest | ISO time of the last successful SP run (**the 24-hour gate**) |
| `ingest:sp:latest_date:<satellite>` | ingest, backfill | Latest SP `acq_date` loaded into Postgres per satellite |
| `ingest:lock` | ingest | Run lock (`expirationTtl` 3 h) that prevents overlapping runs |
| `data:version:archival` | ingest, backfill | Bumped after every Postgres write (cache-busting) |
| `data:version:realtime` | ingest | Bumped after every D1 write (cache-busting) |

Details are in the ingest-worker spec, §4.

---

## 9. Repo layout

```
apps/web/                 React app (this spec, §7)
apps/api-worker/          Hono API + FireCopilotAgent (SPEC.md)
apps/ingest-worker/       Cron worker (SPEC.md)
packages/harmonizer/      Pure TS harmonization (SPEC.md)
packages/db/              Migrations + typed queries
scripts/backfill/         Historical backfill (this spec, §6)
config/regions.json       Shared regions + harmonization constants
data/harmonized/          Checked-in harmonized outputs
data/raw/                 Gitignored raw FIRMS downloads
sample_api/               Golden test fixtures
```

---

## 10. Milestones

1. **Harmonizer and tests** against `sample_api/`.
2. **Backfill** for `california`. Commit `data/harmonized/california/**`. Load into PlanetScale.
3. **api-worker:** `/api/meta`, `/api/archival/spots`, `/api/calendar` (archival).
4. **web:** map with fetch-on-move, Archival tab, calendar box, calendar drawer, CSV export.
5. **ingest-worker:** NRT every 3 h into D1, SP gated to 24 h into Postgres, KV flags.
6. **Realtime tab:** `/api/realtime/spots`, realtime calendar comparison.
7. **Chat copilot:** AI Gateway, agent memory, tools grounded in the current AOI.

## 11. Acceptance criteria

- In the overlap years (2013–2021), the regional monthly MODIS×α and VIIRS harmonized series agree within ±15% median absolute percentage error.
- No visible step in the annual harmonized series at 2012 (the VIIRS start) beyond the natural interannual variability.
- Panning the map triggers at most 1 request per settled viewport. Small pans inside the padded area trigger 0 requests.
- The archival calendar for a 1°×1° AOI over 2000–2025 returns in under 1.5 s (cold) and under 200 ms (cached).
- Realtime data on the map is at most 3 h plus the FIRMS latency old.
- The CSV export opens cleanly in Excel and pandas, and its columns are documented in its header row.
