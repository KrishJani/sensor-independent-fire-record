-- Realtime tier (Cloudflare D1 / SQLite): the last 92 days of FIRMS NRT (D1_RETENTION_DAYS).
-- Written by apps/ingest-worker every 3 h; read by apps/api-worker. Older dates are handed over to
-- Postgres by the daily job (apps/ingest-worker/SPEC.md §3.3). Same grid and filters as the archive.

CREATE TABLE IF NOT EXISTS nrt_detections (
  satellite   TEXT    NOT NULL,
  acq_date    TEXT    NOT NULL,              -- 'YYYY-MM-DD' UTC
  acq_time    INTEGER NOT NULL,              -- HHMM UTC
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  sensor      TEXT    NOT NULL,
  confidence  INTEGER NOT NULL,
  frp_mw      REAL    NOT NULL,
  day_night   TEXT    NOT NULL,
  version     TEXT,
  cell_id     INTEGER NOT NULL,
  heat_class  TEXT    NOT NULL DEFAULT 'fire' CHECK (heat_class IN ('fire', 'industrial')),
  heat_reason TEXT,                          -- masked cell reason (NRT has no FIRMS `type`)
  ingested_at TEXT    NOT NULL,
  PRIMARY KEY (satellite, acq_date, acq_time, lat, lon)
);
CREATE INDEX IF NOT EXISTS nrt_detections_date ON nrt_detections (acq_date);
CREATE INDEX IF NOT EXISTS nrt_detections_cell ON nrt_detections (cell_id, acq_date);

-- Fire-only cell-days, recomputed from nrt_detections for every (date, satellite) touched (idempotent).
CREATE TABLE IF NOT EXISTS nrt_cell_days (
  acq_date     TEXT    NOT NULL,
  cell_id      INTEGER NOT NULL,
  satellite    TEXT    NOT NULL,
  sensor       TEXT    NOT NULL,
  grid_lat     REAL    NOT NULL,
  grid_lon     REAL    NOT NULL,
  n_detections INTEGER NOT NULL,
  n_passes     INTEGER NOT NULL,
  peak_frp_mw  REAL    NOT NULL,
  sum_frp_mw   REAL    NOT NULL,
  first_time   INTEGER NOT NULL,
  last_time    INTEGER NOT NULL,
  hv           TEXT    NOT NULL,
  PRIMARY KEY (acq_date, cell_id, satellite)
);
CREATE INDEX IF NOT EXISTS nrt_cell_days_cell ON nrt_cell_days (cell_id, acq_date);

-- Which satellite delivered NRT data on which date (for the OR-based availability rule).
CREATE TABLE IF NOT EXISTS nrt_availability (
  satellite TEXT NOT NULL,
  acq_date  TEXT NOT NULL,
  PRIMARY KEY (satellite, acq_date)
);
