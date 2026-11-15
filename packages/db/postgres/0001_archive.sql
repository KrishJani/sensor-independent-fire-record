-- Archival tier (PlanetScale Postgres, via Hyperdrive in Workers; direct connection for `backfill load`).
-- Written by: scripts/backfill (load), apps/ingest-worker (24 h SP job + D1 handover).
-- Read by:    apps/api-worker.  Harmonization math lives in @repo/harmonizer; SQL only stores/aggregates.
-- Grid: 0.05°, cell_id = row * 7200 + col (row = cell_id / 7200, col = cell_id % 7200).

create table if not exists regions (
  region_id          text primary key,
  name               text not null,
  group_id           text,                         -- e.g. 'us'; group totals are sums of non-overlapping regions
  bbox               double precision[] not null,  -- [west, south, east, north]
  exclude            text[] not null default '{}', -- earlier regions whose bboxes are cut out
  harmonizer_version text not null,
  range_from         date not null,
  range_to           date not null,
  manifest           jsonb not null,
  validation         jsonb not null,
  loaded_at          timestamptz not null default now()
);

-- Raw filtered hotspots. heat_class = 'fire' → the burning record; 'industrial' → excluded from every
-- calendar but kept for the map's industrial-heat layer, with the reason (docs/HARMONIZATION.md §4.5).
create table if not exists detections (
  region_id   text not null references regions on delete cascade,
  satellite   text not null,
  acq_date    date not null,
  acq_time    smallint not null,                   -- HHMM UTC
  lat         double precision not null,
  lon         double precision not null,
  sensor      text not null,
  tier        text not null default 'SP',          -- 'SP' | 'NRT' (provisional, replaced when SP arrives)
  confidence  smallint not null,
  frp_mw      real not null,
  day_night   char(1) not null,
  fire_type   smallint,                            -- FIRMS `type` (null for NRT)
  version     text,
  cell_id     integer not null,
  grid_row    smallint generated always as ((cell_id / 7200)::smallint) stored,
  grid_col    smallint generated always as ((cell_id % 7200)::smallint) stored,
  heat_class  text not null default 'fire' check (heat_class in ('fire', 'industrial')),
  heat_reason text check (heat_reason in ('volcano', 'static_source_type', 'offshore', 'static_source_cell', 'persistent_viirs_only', 'eog_flare_site')),
  hv          text not null,
  primary key (satellite, acq_date, acq_time, lat, lon)
);
create index if not exists detections_rowcol_date on detections (grid_row, grid_col, acq_date);
create index if not exists detections_region_date on detections (region_id, acq_date);

-- Active cell-days per satellite (fire only). The unit of the harmonized calendar.
create table if not exists cell_days (
  region_id    text not null references regions on delete cascade,
  acq_date     date not null,
  cell_id      integer not null,
  satellite    text not null,
  sensor       text not null,
  tier         text not null default 'SP',
  grid_row     smallint generated always as ((cell_id / 7200)::smallint) stored,
  grid_col     smallint generated always as ((cell_id % 7200)::smallint) stored,
  n_detections integer not null,
  n_passes     smallint not null,
  peak_frp_mw  real not null,
  sum_frp_mw   real not null,
  first_time   smallint not null,
  last_time    smallint not null,
  hv           text not null,
  primary key (acq_date, cell_id, satellite)
);
create index if not exists cell_days_rowcol_date on cell_days (grid_row, grid_col, acq_date);
create index if not exists cell_days_region_date on cell_days (region_id, acq_date);

-- Monthly rollup of cell_days (fast long-range calendars and the map's coarse level). Rebuilt per region on load.
create table if not exists cell_months (
  region_id   text not null references regions on delete cascade,
  year        smallint not null,
  month       smallint not null,
  cell_id     integer not null,
  satellite   text not null,
  sensor      text not null,
  grid_row    smallint generated always as ((cell_id / 7200)::smallint) stored,
  grid_col    smallint generated always as ((cell_id % 7200)::smallint) stored,
  cell_days   smallint not null,
  n_detections integer not null,
  peak_frp_mw real not null,
  last_date   date not null,
  primary key (year, month, cell_id, satellite)
);
create index if not exists cell_months_rowcol on cell_months (grid_row, grid_col, year, month);
create index if not exists cell_months_region on cell_months (region_id, year, month);

-- Which satellite has data on which date, per region (outages are detected per region).
create table if not exists source_availability (
  region_id text not null references regions on delete cascade,
  satellite text not null,
  acq_date  date not null,
  tier      text not null default 'SP',
  primary key (region_id, satellite, acq_date)
);

-- Calibration: the full model (per MODIS configuration) and the α actually applied per month.
create table if not exists alpha_models (
  region_id text not null references regions on delete cascade,
  config    text not null check (config in ('TA', 'T', 'A')),
  kind      text not null,                         -- 'glm' | 'ratio'
  model     jsonb not null,                        -- a[12], background[12], beta, rate ranges, CIs, test
  primary key (region_id, config)
);
create table if not exists alpha_effective (
  region_id            text not null references regions on delete cascade,
  year                 smallint not null,
  month                smallint not null,
  config               text not null,
  modis_cells_per_day  real not null,
  alpha_eff            real not null,
  primary key (region_id, year, month, config)
);

-- Harmonized series. scope = a region id or a group id ('us').
create table if not exists daily_harmonized (
  scope               text not null,
  acq_date            date not null,
  harmonized_cell_days real not null,
  raw_detections      integer not null,
  unscaled_cell_days  integer not null,
  modis_scaled_cell_days real,
  viirs_cell_days     integer not null,
  modis_cell_days     integer not null,
  basis               text,                         -- regions: VIIRS | MODIS_SCALED | NONE
  alpha               real,
  modis_config        text,
  viirs_reference     text,
  peak_frp_mw         real,
  peak_frp_sensor     text,
  primary key (scope, acq_date)
);
create table if not exists calendar_monthly (
  scope               text not null,
  year                smallint not null,
  month               smallint not null,
  harmonized_cell_days real not null,
  harmonized_lo       real,                         -- 90% band (MODIS-scaled part only)
  harmonized_hi       real,
  raw_detections      integer not null,
  unscaled_cell_days  integer not null,
  modis_scaled_cell_days real,
  viirs_cell_days     integer not null,
  modis_cell_days     integer not null,
  source_mix          real not null,
  n_days              smallint not null,
  complete            boolean not null,
  peak_frp_mw         real,
  peak_frp_sensor     text,
  primary key (scope, year, month)
);
create table if not exists annual_harmonized (
  scope               text not null,
  year                smallint not null,
  harmonized_cell_days real not null,
  harmonized_lo       real,
  harmonized_hi       real,
  primary key (scope, year)
);

-- Masks. Per-region masked cells (static sources, persistent VIIRS-only heat, inventory flares) — also the
-- NRT filter inside regions (cached in KV) — and the independent flare inventory cells (global).
create table if not exists static_mask (
  region_id text not null references regions on delete cascade,
  cell_id   integer not null,
  grid_lat  real not null,
  grid_lon  real not null,
  n_static  integer not null,
  reason    text not null,
  primary key (region_id, cell_id)
);
create table if not exists flare_inventory_cells (
  cell_id           integer primary key,
  grid_lat          real not null,
  grid_lon          real not null,
  n_sites           integer not null,
  countries         text not null,
  first_active_year smallint not null,
  last_active_year  smallint not null,
  total_bcm         double precision not null,
  source            text not null default 'EOG MYC25Q4 doi:10.5281/zenodo.23091822 (CC BY-NC 4.0)'
);

-- Global map layer (NOT harmonized): 0.5° bins per month and satellite, from FIRMS Country Yearly Summaries.
create table if not exists global_coarse_months (
  year        smallint not null,
  month       smallint not null,
  bin_lat     real not null,
  bin_lon     real not null,
  satellite   text not null,
  sensor      text not null,
  cell_days   integer not null,
  detections  integer not null,
  peak_frp_mw real not null,
  sum_frp_mw  real not null,
  primary key (year, month, bin_lat, bin_lon, satellite)
);
create index if not exists global_coarse_bins on global_coarse_months (bin_lat, bin_lon);
create table if not exists global_static_mask (
  cell_id  integer primary key,
  grid_lat real not null,
  grid_lon real not null,
  n_static integer not null
);
