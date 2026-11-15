# `ingest-worker` — Spec

This is a Cloudflare Worker with a **Cron Trigger** and no public routes. It keeps both storage tiers up to date:

- **Realtime (NRT) → D1**, every **3 hours**.
- **Archival (SP) → PlanetScale Postgres** through the **shared Hyperdrive**, at most once every **24 hours**. The gate is a KV flag.

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
    "D1_RETENTION_DAYS": "150",
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
    if (await spIsDue(env)) await runSp(env);         // gated to 24 h
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

Steps run for each region in `regions.json` and each source in `MODIS_NRT`, `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT`:

1. **Fetch** `GET /api/area/csv/{KEY}/{SOURCE}/{bbox}/{NRT_DAY_RANGE}`. The default day range is 2 days, so the overlap with the previous run catches late-arriving granules.
2. **Harmonize:**
   - `parseFirmsCsv(tier: 'NRT')`
   - `filterDetections` with the **static mask**. NRT has no `type` column, so the mask is required. It is loaded from the Postgres `static_mask` table and cached in KV under `cache:static_mask:<region>` with a 24 h TTL.
3. **Upsert raw detections** into `nrt_detections`.
   - Key: `(satellite, acq_date, acq_time, lat, lon)`.
   - `INSERT … ON CONFLICT DO UPDATE` makes it idempotent.
4. **Recompute cell-days:** for every `(acq_date, satellite)` touched in step 3, re-read *all* `nrt_detections` rows for that date and satellite in the region, then run `buildCellDays`. The result replaces those rows in `nrt_cell_days`: delete then insert, in one `db.batch()`. Recomputing from raw rows rather than patching increments keeps D1 correct when FIRMS revises a granule.
5. **Batch** D1 writes in chunks of at most 500 statements per `batch()`.
6. **Flags:** on success, set `ingest:nrt:last_success_at` and bump `data:version:realtime`.

### 3.2 SP job (every 24 h) → Postgres via Hyperdrive

1. **Detect new archival data.**
   - Call `GET /api/data_availability/csv/{KEY}/ALL` and read `max_date` for `MODIS_SP`, `VIIRS_SNPP_SP` and `VIIRS_NOAA20_SP`.
   - For each satellite, the new range is `(ingest:sp:latest_date:<satellite>, max_date]`. The KV value is written by the backfill (`--load`) or by the previous SP run.
   - If nothing is new, set `ingest:sp:last_success_at` and stop.
2. **Fetch** the new range in 5-day chunks: `/api/area/csv/{KEY}/{SOURCE}/{bbox}/5/{date}`. The total is bounded by `FIRMS_MAX_TX_PER_RUN`. Whatever does not fit carries over: KV `latest_date` only advances for chunks that were committed.
3. **Harmonize:** `parseFirmsCsv(tier: 'SP')` → `filterDetections` (uses `type`) → `buildCellDays`.
4. **Write to Postgres.** A fresh `postgres(env.HYPERDRIVE.connectionString)` client is created per run and is never global. Each chunk is one transaction that:
   - upserts `detections`
   - upserts `cell_days`, keyed on `(acq_date, cell_id, satellite)`
   - upserts `source_availability` for every date that FIRMS reports as available, including days with no fires
   - recomputes `cell_months` for the affected `(year, month, satellite)` within the region bbox
   - updates `static_mask` counters when new `type = 2` detections arrive
5. **Advance the flags** after each committed chunk: `ingest:sp:latest_date:<satellite>`. When the job finishes, also:
   - bump `data:version:archival`
   - set `ingest:sp:last_success_at`
6. **Prune D1** so NRT and SP are never double-counted:

   ```sql
   DELETE FROM nrt_detections WHERE satellite = ? AND acq_date <= ?;   -- ? = new SP latest_date for that satellite
   DELETE FROM nrt_cell_days  WHERE satellite = ? AND acq_date <= ?;
   DELETE FROM nrt_detections WHERE acq_date < date('now', '-' || D1_RETENTION_DAYS || ' days');
   DELETE FROM nrt_cell_days  WHERE acq_date < date('now', '-' || D1_RETENTION_DAYS || ' days');
   ```

   NOAA-21 has no SP product yet, so its rows are pruned only by retention. The API excludes NOAA-21 from harmonized counts whenever S-NPP or NOAA-20 is available (harmonizer spec, §7.1).
   Pruning happens **after** the Postgres commit, so there is never a window where a date is missing from both tiers.

---

## 4. KV keys (`INGEST_STATE`)

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `ingest:lock` | `{ runId, startedAt }` | 3 h (`expirationTtl`) | Prevents overlapping runs. The TTL self-heals after a crash. |
| `ingest:nrt:last_success_at` | ISO datetime | — | Health check, and `realtime.updatedAt` in `/api/meta` |
| `ingest:sp:last_success_at` | ISO datetime | — | **The 24-hour gate** |
| `ingest:sp:latest_date:TERRA` / `AQUA` / `SNPP` / `NOAA20` | `YYYY-MM-DD` | — | SP high-water mark per satellite, and the boundary between the two tiers |
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
- Every date is in exactly one place: Postgres if it is `≤` the SP high-water mark for its satellite, D1 otherwise.
- A failed or partial SP run resumes from the last committed chunk on the next tick.
