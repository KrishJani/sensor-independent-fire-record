# `ingest-worker` — Spec

This is a Cloudflare Worker with a **Cron Trigger** and no public routes. It keeps both storage tiers up to date:

- **Realtime (NRT) → D1**, every **3 hours**. D1 holds a rolling window of exactly the last **92 days** (`D1_RETENTION_DAYS`).
- **Archival (SP) → PlanetScale Postgres** through the **shared Hyperdrive**, at most once every **24 hours**. The gate is a KV flag.
- **Handover (D1 → Postgres)**, on the same 24-hour gate. Dates that leave the 92-day window move to Postgres: they are dropped if SP already covers them, and otherwise copied as provisional `tier = 'NRT'` rows that SP replaces later.

**Tier boundary (decided 2026-11-15):** the boundary is a fixed date, `today − 92 days`. **Realtime** reads D1 for the last 92 days. **Archival** reads Postgres for everything older. Each endpoint reads one store, so no date is counted twice. FIRMS SP lags NRT by roughly 2–3 months, so if SP publication ever falls more than 92 days behind, the handover keeps those dates in Postgres as provisional NRT instead of dropping them.

All parsing, filtering, gridding and cell-day logic comes from `@repo/harmonizer`. This worker only does fetching, scheduling and storage.

---

## 1. Bindings (`wrangler.jsonc`)

```jsonc
{
  "name": "nasa-fire-ingest",
  "main": "src/index.ts",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["0 */3 * * *"] },
  "d1_databases": [{ "binding": "NRT_DB", "database_name": "firms-nrt-cells", "database_id": "<same as api-worker>" }],
  "hyperdrive":   [{ "binding": "HYPERDRIVE", "id": "<shared Hyperdrive config id>" }],
  "kv_namespaces":[{ "binding": "INGEST_STATE", "id": "<shared KV id>" }],
  "vars": {
    "SP_INTERVAL_HOURS": "24",
    "NRT_DAY_RANGE": "2",
    "D1_RETENTION_DAYS": "92",
    "FIRMS_MAX_TX_PER_RUN": "1500"
  }
}
// secret: FIRMS_MAP_KEY
```

There is a **single cron**, `0 */3 * * *`. The 24-hour archival cadence comes from a KV flag rather than a second cron. This prevents NRT and SP runs from overlapping, and a missed SP run catches up automatically on the next 3-hour tick.

Regions come from `config/regions.json`, imported at build time.

---

## 2. Scheduled handler

```ts
async scheduled(event, env, ctx) {
  if (!(await acquireLock(env)))  return;            // ingest:lock exists → another run is active
  try {
    await runNrt(env);                                // always
    if (await spIsDue(env)) {                         // gated to 24 h
      await runSp(env);                               // SP → Postgres (replaces provisional NRT rows)
      await runHandover(env);                         // D1 dates older than 92 days → Postgres, then delete from D1
    }
  } finally {
    await releaseLock(env);
  }
}
```

- `spIsDue` is `now − ingest:sp:last_success_at ≥ SP_INTERVAL_HOURS − 15 min`. The 15-minute tolerance absorbs cron jitter. A missing key counts as due.
- Each job is wrapped separately, so an NRT failure does not block SP, and an SP failure does not block NRT.
- Structured logs are written with `console.log(JSON.stringify({...}))`: job, region, source, rows fetched, rows kept, cells upserted, duration and errors. Workers Logs captures them.

---

## 3. Jobs

### 3.1 NRT job (every 3 h) → D1

Steps run for each source in `MODIS_NRT`, `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT`, **globally** (decided 2026-11-15: the realtime map is global):

1. **Fetch** `GET /api/area/csv/{KEY}/{SOURCE}/world/{NRT_DAY_RANGE}`. The default day range is 2 days, so the overlap with the previous run catches late-arriving granules.
   - **Budget:** a California 5-day request costs about 10 FIRMS transactions, and a world request will cost more. Before enabling `world`, measure the cost with `mapkey_status` (Stage 4). If the world requests exceed `FIRMS_MAX_TX_PER_RUN`, fetch by continent tiles and spread them across ticks.
   - Pace by the key's live usage (`/mapserver/mapkey_status`), as `scripts/backfill/src/firms.ts` does. FIRMS answers `Invalid MAP_KEY` when a valid key is over its limit.
2. **Harmonize:**
   - `parseFirmsCsv(tier: 'NRT')`
   - `filterDetections` with the **static mask**. NRT has no `type` column, so the mask is required. Inside regions, the regional `static_mask` is used, which keeps NRT identical to the regional SP. Elsewhere, `global_static_mask` is used. Both are cached in KV (`cache:static_mask:<region|global>`, 24 h TTL).
3. **Upsert raw detections** into `nrt_detections`.
   - Key: `(satellite, acq_date, acq_time, lat, lon)`.
   - `INSERT … ON CONFLICT DO UPDATE` makes it idempotent.
4. **Recompute cell-days:** for every `(acq_date, satellite)` touched in step 3, re-read *all* `nrt_detections` rows for that date and satellite in the region, then run `buildCellDays`. The result replaces those rows in `nrt_cell_days`: delete then insert, in one `db.batch()`. Recomputing from raw rows rather than patching increments keeps D1 correct when FIRMS revises a granule.
5. **Batch** D1 writes in chunks of at most 500 statements per `batch()`.
6. **Flags:** on success, set `ingest:nrt:last_success_at` and bump `data:version:realtime`.

### 3.2 SP job (every 24 h) → Postgres via Hyperdrive

1. **Detect new archival data.**
   - Call `GET /api/data_availability/csv/{KEY}/ALL` and read `max_date` for `MODIS_SP`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_SP` and `VIIRS_NOAA21_SP`.
   - For each satellite, the new range is `(ingest:sp:latest_date:<satellite>, max_date]`. The KV value is written by the backfill (`--load`) or by the previous SP run.
   - If nothing is new, set `ingest:sp:last_success_at` and stop.
2. **Fetch** the new range in 5-day chunks: `/api/area/csv/{KEY}/{SOURCE}/{bbox}/5/{date}`. The total is bounded by `FIRMS_MAX_TX_PER_RUN`. Whatever does not fit carries over: KV `latest_date` only advances for chunks that were committed.
3. **Harmonize:** `parseFirmsCsv(tier: 'SP')` → `filterDetections` (uses `type`) → `buildCellDays`.
4. **Write to Postgres.** A fresh `postgres(env.HYPERDRIVE.connectionString)` client is created per run and is never global. Each chunk is one transaction that:
   - first deletes provisional `tier = 'NRT'` rows (in `detections`, `cell_days` and `source_availability`) for that satellite and the chunk's dates, because SP supersedes them
   - upserts `detections`
   - upserts `cell_days`, keyed on `(acq_date, cell_id, satellite)`
   - upserts `source_availability` for every date that FIRMS reports as available, including days with no fires
   - recomputes `cell_months` for the affected `(year, month, satellite)` within the region bbox
   - updates `static_mask` counters when new `type = 2` detections arrive
5. **Advance the flags** after each committed chunk: `ingest:sp:latest_date:<satellite>`. When the job finishes, also:
   - bump `data:version:archival`
   - set `ingest:sp:last_success_at`
6. D1 is **not** pruned here. SP rows for dates inside the 92-day window coexist with the NRT rows in D1. They are read by different endpoints (archival vs realtime), so they are never summed together. D1 rows leave only through the handover (§3.3).

### 3.3 Handover job (same 24 h gate) → Postgres, then D1 delete

`cutoff = today − D1_RETENTION_DAYS` (UTC). This is the first realtime day: D1 keeps `[cutoff, today]`, matching `realtime.minDate` in the api-worker and `REALTIME_WINDOW_DAYS` in `apps/web`. For every `(satellite, acq_date)` in D1 with `acq_date < cutoff`:

1. If `acq_date <= ingest:sp:latest_date:<satellite>`, SP already has this date in Postgres. Nothing is copied.
2. Otherwise, copy the D1 rows into Postgres with `tier = 'NRT'`: `nrt_detections` → `detections`, `nrt_cell_days` → `cell_days`, plus `source_availability (satellite, acq_date, tier = 'NRT')`. Then recompute `cell_months`. This happens in one transaction, with upserts, so it is idempotent. NOAA-21 is handled like the other VIIRS satellites. FIRMS publishes `VIIRS_NOAA21_SP` (from 2023-03-01), so its provisional rows are replaced once SP covers them. The harmonizer only uses NOAA-21 when S-NPP and NOAA-20 are both unavailable (harmonizer spec, §7.1).
3. **After** the Postgres commit, delete these dates from D1:

   ```sql
   DELETE FROM nrt_detections WHERE acq_date < ?;    -- ? = cutoff
   DELETE FROM nrt_cell_days  WHERE acq_date < ?;
   ```

   A failure between steps 2 and 3 leaves the date in both stores. That is harmless, because the endpoints split by date (realtime = on or after the cutoff), and the next tick retries.
4. Bump `data:version:archival` (if anything was copied) and `data:version:realtime`.

Calendar months that contain provisional days are returned with `provisional: true` and labelled in the UI. Calibration (α) uses `tier = 'SP'` rows only.

---

## 4. KV keys (`INGEST_STATE`)

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `ingest:lock` | `{ runId, startedAt }` | 3 h (`expirationTtl`) | Prevents overlapping runs. The TTL self-heals after a crash. |
| `ingest:nrt:last_success_at` | ISO datetime | — | Health check, and `realtime.updatedAt` in `/api/meta` |
| `ingest:sp:last_success_at` | ISO datetime | — | **The 24-hour gate** |
| `ingest:sp:latest_date:TERRA` / `AQUA` / `SNPP` / `NOAA20` / `NOAA21` | `YYYY-MM-DD` | — | SP high-water mark per satellite, and the boundary between the two tiers |
| `data:version:archival` | integer | — | Cache key component for the api-worker |
| `data:version:realtime` | integer | — | Cache key component for the api-worker and web polling |
| `cache:static_mask:<region>` | JSON array of cellIds | 24 h | Avoids a Postgres read on every NRT run |

KV is eventually consistent, with up to about 60 s of propagation. That is acceptable, because the lock TTL (3 h) and the gate (24 h) are far larger.

The lock uses get-then-put. The race window is tiny because only one cron fires per tick.

---

## 5. Rate limiting and retries

- A token bucket shared within a run is set to `FIRMS_MAX_TX_PER_RUN`. Calls are spaced at least 150 ms apart.
- Requests are retried on HTTP 429 and 5xx with exponential backoff (1 s, 2 s, 4 s; at most 3 tries).
- When the response body is `Invalid MAP_KEY` or `Exceeding allowed transaction limit`, the job aborts and logs at error level.
- CPU limits: the Workers Paid plan is required, with `limits.cpu_ms` raised as needed. If one run exceeds the limit, the SP job naturally splits across ticks via the KV high-water mark.

---

## 6. Local development

```
pnpm dev:ingest                          # wrangler dev --test-scheduled, shared .wrangler state with api-worker
curl "http://localhost:8788/__scheduled?cron=0+*/3+*+*+*"
```

To force the SP job locally: `wrangler kv key delete ingest:sp:last_success_at --binding INGEST_STATE --local`.

---

## 7. Acceptance

- Two consecutive NRT runs over the same window leave D1 row counts unchanged (idempotent).
- The SP run executes at most once per 24 h, even though the cron fires every 3 h.
- D1 never holds a date older than `today − 92 days` after a successful handover, and holds every NRT date newer than that.
- Every date older than the cutoff is in Postgres, either as SP or as provisional NRT. No date is ever missing from both stores, and no endpoint reads both stores for the same date.
- Once SP covers a date, no `tier = 'NRT'` rows remain in Postgres for that satellite and date.
- A failed or partial SP run resumes from the last committed chunk on the next tick.
