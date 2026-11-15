-- Realtime tier, v2 (apps/ingest-worker/SPEC.md §3.1).
--
-- 1. Indexes follow the actual queries. Map reads filter by date range + latitude band
--    (api-worker /api/realtime/spots); the ingest diff reads one (satellite, date), which the primary
--    key already serves. The (cell_id, acq_date) indexes served no query and cost a write per row.
-- 2. nrt_files: one row per (satellite, acq_date) file processed. Its fingerprint lets a run skip a
--    day that FIRMS has not changed (no D1 writes at all), and it tells the catch-up which days of the
--    92-day window are already loaded.

DROP INDEX IF EXISTS nrt_detections_date;
DROP INDEX IF EXISTS nrt_detections_cell;
DROP INDEX IF EXISTS nrt_cell_days_cell;
CREATE INDEX IF NOT EXISTS nrt_detections_date_lat ON nrt_detections (acq_date, lat);
CREATE INDEX IF NOT EXISTS nrt_cell_days_date_lat ON nrt_cell_days (acq_date, grid_lat);

CREATE TABLE IF NOT EXISTS nrt_files (
  satellite    TEXT    NOT NULL,
  acq_date     TEXT    NOT NULL,
  fingerprint  TEXT    NOT NULL,              -- row count + FNV-1a of the file's sorted rows
  n_rows       INTEGER NOT NULL,              -- rows FIRMS returned (before filtering)
  n_fire       INTEGER NOT NULL,
  n_industrial INTEGER NOT NULL,
  fetched_at   TEXT    NOT NULL,
  PRIMARY KEY (satellite, acq_date)
);
