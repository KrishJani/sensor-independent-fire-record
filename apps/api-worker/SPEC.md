# `api-worker` — Spec

This is the public Cloudflare Worker, built with Hono. It serves the web app:

- **Archival** data comes from **PlanetScale Postgres** through the **shared Hyperdrive** (`env.HYPERDRIVE`).
- **Realtime** data comes from **D1** (`env.NRT_DB`).
- **Chat** goes through **AI Gateway** (`env.AI`). Conversation memory lives in a Durable Object agent (`env.FIRE_COPILOT`).

Harmonization math such as α, calendars and anomalies comes from `@repo/harmonizer`. SQL only aggregates.

---

## 1. Bindings

| Binding | Type | Use |
|---|---|---|
| `HYPERDRIVE` | Hyperdrive (same config ID as ingest-worker) | Archival reads |
| `NRT_DB` | D1 `firms-nrt-cells` (same `database_id` as ingest-worker) | Realtime reads |
| `INGEST_STATE` | KV (same namespace as ingest-worker) | Data versions and the SP high-water marks. **Read-only.** |
| `AI` | Workers AI binding, with calls routed through AI Gateway `AI_GATEWAY_ID` | Chat LLM |
| `FIRE_COPILOT` | Durable Object `FireCopilotAgent` (SQLite-backed) | Agent memory |

Vars:

- `AI_GATEWAY_ID`
- `CHAT_MODEL`, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `CALIBRATION_START_YEAR`, `CALIBRATION_END_YEAR`, `BASELINE_START_YEAR`, `BASELINE_END_YEAR`
- `ALLOWED_ORIGINS`

**Postgres rule:** a new `postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })` client is created **per request** and is never global. Hyperdrive does the pooling. The client is closed with `ctx.waitUntil(sql.end())`.

---

## 2. Common request rules

- `bbox=w,s,e,n` is in WGS84 degrees. It is validated, snapped outward to the 0.05° grid and clamped to the configured regions. The maximum area per level:
  - `points`: 4 deg²
  - `cells`: 100 deg²
  - `coarse`: unlimited
- Dates are `YYYY-MM-DD` UTC.
  - Archival: clamped to `[2000-11-01, today − 93 days]` (Postgres: SP, plus provisional NRT where SP is not yet published).
  - Realtime: clamped to `[today − 92 days, today]`, which is the D1 window (`D1_RETENTION_DAYS = 92`).
- `geometry` (POST bodies) is a GeoJSON `Polygon` or `MultiPolygon` with at most 500 vertices. It is reduced to a bbox for SQL, and then the harmonizer runs `pointInPolygon` on cell centers.
- Errors are returned as `{ error: { code, message } }` with status 400, 422 or 500.
- CORS is restricted to `ALLOWED_ORIGINS`.

### Caching

GET responses and the calendar are cached with the Cloudflare **Cache API**. The key is the normalized URL, or a hash of the POST body, plus a version:

- Archival endpoints use `data:version:archival` and have TTL 24 h.
- Realtime endpoints use `data:version:realtime` and have TTL 15 min.

The versions are read from KV and memoized per isolate for 60 s. A new ingest therefore invalidates the cache without an explicit purge.

---

## 3. Endpoints

### `GET /api/meta`

The web app calls this once on load, and the Realtime tab polls it every 5 minutes.

```json
{
  "regions": [{ "id": "california", "name": "California, USA", "bbox": [-124.5, 32.5, -114.0, 42.1] }],
  "archival": { "minDate": "2000-11-01", "maxDate": "2026-08-31", "dataVersion": 42,
                "latestBySatellite": { "TERRA": "2026-08-31", "AQUA": "2026-08-31", "SNPP": "2026-09-10", "NOAA20": "2026-09-10" } },
  "realtime": { "minDate": "2026-09-01", "maxDate": "2026-11-14", "updatedAt": "2026-11-15T03:00:41Z", "dataVersion": 913 },
  "harmonizerVersion": "1.0.0"
}
```

`realtime.minDate` is `today − 92 days`, and `archival.maxDate` is the day before it. The boundary is a fixed date (ingest-worker spec, §3.3), not the SP high-water mark. `latestBySatellite` is still reported so the UI can show which archival months are provisional (NRT not yet replaced by SP).

### `GET /api/archival/spots?bbox=&from=&to=&level=coarse|cells|points`

This serves map features from **Postgres**.

| level | SQL source | Feature |
|---|---|---|
| `coarse` | `cell_months`, grouped into 0.5° bins (`(row/10, col/10)`) | Polygon per bin: `cell_days`, `peak_frp_mw` |
| `cells` | `cell_days` (≤ 31 days) or `cell_months` (longer ranges) | Polygon per 0.05° cell: `cell_days`, `peak_frp_mw`, `last_seen` |
| `points` | `detections` | Point: `satellite`, `acq_date`, `acq_time`, `frp_mw`, `confidence`, `day_night` |

- In the `coarse` and `cells` levels, `cell_days` counts distinct `(cell, date)` pairs across the VIIRS reference and MODIS. It is meant for map density only; harmonized counts come from `/api/calendar`.
- **Global coverage.** The parts of the bbox inside configured regions are served as above. Everything else is served at the `coarse` level only, from `global_coarse_months` (0.5° bins, per satellite, *not harmonized*). Those features carry `harmonized: false`, and the UI labels them by satellite. `cells` and `points` outside regions fall back to `coarse`, with `meta.globalFallback: true`.
- `points` is limited to 5000 rows `ORDER BY frp_mw DESC`. When the limit is hit, the response sets `truncated: true`.
- `heat=fire` (the default) returns only `detections.heat_class = 'fire'`. `heat=industrial` returns the industrial-heat layer: flares, static sources, offshore and volcanic heat, each with its `heat_reason`. The UI offers it as an optional overlay. Calendars never include industrial heat.
- The response is a GeoJSON `FeatureCollection` plus `meta: { level, bbox, from, to, truncated, dataVersion }`.

### `GET /api/realtime/spots?bbox=&from=&to=&level=`

This has the same contract as the archival endpoint, but the source is **D1**:

- `nrt_cell_days` serves `coarse` and `cells`, with the coarse bins grouped in SQL.
- `nrt_detections` serves `points`.

`last_seen` is an ISO datetime built from `acq_date` and `acq_time`, so the UI can fade older detections.

### `POST /api/calendar`

```json
{ "mode": "archival" | "realtime", "geometry": { ...GeoJSON } | null, "bbox": [w,s,e,n] | null,
  "from": "2000-11-01", "to": "2025-12-31", "months": [1..12] | null }
```

**Archival mode** (Postgres only):

1. Run a query that returns the daily distinct-cell counts for MODIS (TERRA ∪ AQUA) and for each VIIRS satellite inside the AOI:

   ```sql
   SELECT acq_date, satellite, cell_id FROM cell_days
   WHERE grid_lat BETWEEN $s AND $n AND grid_lon BETWEEN $w AND $e AND acq_date BETWEEN $from AND $to
   ```

   - For polygons, cell IDs are filtered in JS with `pointInPolygon`.
   - For AOIs over about 25 deg², the query uses `cell_months` with a polygon cell-ID list instead.
2. Load `source_availability` for the range. Load `alpha_region` for the region(s) the AOI touches.
3. Run the harmonizer: `computeAlpha` (local, shrunk toward the regional factor) → `harmonizeDaily` → `buildCalendar` → `computeAnomalies`.
4. Return:

   ```json
   { "mode": "archival",
     "calendar": [{ "year": 2020, "month": 8, "harmonizedCellDays": 1834, "rawDetections": 41250, "unscaledCellDays": 1834,
                    "modisCellDays": 611, "viirsCellDays": 1834,
                    "sourceMix": 1.0, "peakFrpMw": 9120.4, "peakFrpSensor": "VIIRS", "complete": true,
                    "anomaly": { "median": 212, "ratioToMedian": 8.65, "robustZ": 6.1, "percentile": 100, "class": "record_high" } }],
     "alpha": [{ "month": 1, "alpha": 2.71, "w": 0.84, "sumModis": 263, "sumViirs": 712 }],
     "climatology": [{ "month": 8, "median": 212, "p10": 40, "p25": 98, "p75": 380, "p90": 760 }],
     "annual": [{ "year": 2020, "harmonizedCellDays": 5120 }],
     "summary": { "peakMonth": "2020-08", "peakYear": 2020, "criticalMonths": [7, 8, 9] } }
   ```

   `criticalMonths` are the calendar months whose median is above the 75th percentile of all monthly medians.

**Realtime mode** reads both stores, because it compares current data against history:

1. Daily cell-days for `[from, to]` come from **D1**, run through `harmonizeDaily`. VIIRS is almost always available for NRT, so the basis is `VIIRS`.
2. The historical baseline for the same calendar months and the same day-of-month span comes from **Postgres** through `cumulativeToDay`. It covers the baseline years.
3. Return `daily[]`, `monthToDate: { value, median, ratioToMedian, class }` and the same `climatology`.

### `GET /api/export/hotspots.csv?mode=&bbox=|geometry_id=&from=&to=`

- This streams filtered raw detections from Postgres (`archival`) or D1 (`realtime`).
- Columns: `latitude, longitude, acq_date, acq_time_utc, satellite, sensor, tier, confidence, frp_mw, day_night, cell_id, grid_lat, grid_lon`.
- The response is streamed with `TransformStream`. Its header is `Content-Disposition: attachment; filename="hotspots_<mode>_<from>_<to>.csv"`.
- The maximum is 1,000,000 rows. If the range would exceed it, the endpoint returns 413 and suggests narrowing the range.

### `GET /api/export/calendar.csv?…`

The same parameters as `/api/calendar`, flattened into columns: `year, month, harmonized_cell_days, modis_cell_days, viirs_cell_days, source_mix, median, ratio_to_median, robust_z, percentile, class, alpha`.

### `POST /api/chat` (and `GET /api/chat/ws` for WebSocket streaming)

See §4.

### `GET /api/health`

Returns `{ ok, postgres: ms, d1: ms, kv: { nrtLastSuccess, spLastSuccess } }`.

---

## 4. Chat copilot (`FireCopilotAgent`)

### 4.1 UX contract (web)

- A floating button sits in the **bottom-right corner** and opens a 380 px side panel on the right.
- Every message carries the current context:
  `{ tab, aoi: geometry|bbox, from, to, calendarSummary? }`.
- Responses stream token by token over WebSocket, falling back to SSE from `POST /api/chat`.

### 4.2 Routing

- `POST /api/chat { sessionId, message, context }` → `env.FIRE_COPILOT.idFromName(sessionId)` → `stub.fetch(...)`.
- `sessionId` is a random UUID stored in `localStorage`. There are no user accounts in v1.
- The agent is implemented with the Cloudflare **Agents SDK** (`agents` package, `AIChatAgent`). Each session is one Durable Object instance with its own SQLite.

### 4.3 Agent memory

The agent has three kinds of memory:

- **Short-term:** the full message history is persisted in the DO's SQLite by `AIChatAgent`. The last 20 turns go into the prompt, and older turns are summarized into a rolling `conversation_summary`.
- **Long-term facts** are kept in a `memories` table (`id, kind, content, created_at`). Kinds:
  - `aoi`: saved areas of interest the user named, for example "my district".
  - `preference`: units, language, preferred metrics.
  - `finding`: notable results the agent reported earlier.

  The agent writes these through a `remember` tool. They are injected into the system prompt on every turn.
- **Context memory:** the most recent `context` from the web app is stored as agent state (`this.setState`), so follow-ups like "and last year?" resolve against it.

### 4.4 LLM calls through AI Gateway

```ts
const res = await env.AI.run(env.CHAT_MODEL, { messages, tools, stream: true },
  { gateway: { id: env.AI_GATEWAY_ID, skipCache: false, cacheTtl: 300 } });
```

AI Gateway provides logging, rate limiting (30 requests per minute per IP, configured in the gateway), caching and a fallback model.

### 4.5 Tools (grounding)

The LLM must never invent numbers. It answers from tool results, and the tools call the same internal functions as the REST endpoints, without an HTTP hop:

| Tool | Args | Returns |
|---|---|---|
| `get_calendar` | `mode, aoi?, from, to, months?` | The calendar summary, with peak month/year, critical months and anomalies |
| `get_month_to_date` | `aoi?` | The current month against the historical median, from realtime mode |
| `get_spots_summary` | `mode, bbox, from, to` | Counts, top-FRP detections, last seen |
| `remember` | `kind, content` | Writes to `memories` |
| `recall` | `query` | Matching memories |

If `aoi` is omitted, the tool uses the stored context.

The system prompt sets the agent's behavior:

- Its role is a fire-activity analyst for emergency managers.
- It always cites harmonized cell-days, and states that MODIS-only years (before 2012) are calibrated estimates.
- It labels FRP by sensor.
- It says when data is incomplete (`complete = false` or `sourceMix < 1`).
- It never gives evacuation orders, and points users to official authorities.

---

## 5. Performance targets

- `/api/archival/spots` p95: under 400 ms cold, under 50 ms cached.
- `/api/realtime/spots` p95: under 200 ms.
- `/api/calendar` (1°×1° AOI, 2000–2025): under 1.5 s cold. To meet this, Postgres `cell_months` is used for long ranges, and `cell_days` only for ranges under 1 year or for polygon precision at the edges.
- Placement `smart`, so the worker runs near PlanetScale.

## 6. Tests

- Unit tests: param validation, bbox snapping and clamping, and cache-key versioning.
- Integration tests (Miniflare + local D1 + a test Postgres seeded from `data/harmonized/california`): the calendar for California, August 2020, matches `calendar_monthly.csv` from the backfill.
- Contract tests: the GeoJSON shape, the CSV header and the `truncated` flag.
