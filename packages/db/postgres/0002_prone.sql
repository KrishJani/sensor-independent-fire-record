-- Fire-prone areas (docs/HARMONIZATION.md §9): one row per 0.25° study-area tile, per group.
create table if not exists prone_tiles (
  scope                 text not null,             -- region group, e.g. 'us'
  tile_id               integer not null,          -- row * 1440 + col on the 0.25° grid
  lat                   real not null,             -- tile center
  lon                   real not null,
  region_id             text not null,             -- region holding most of the tile's cells
  n_cells               smallint not null,         -- 0.05° cells of the tile inside the study area
  mean_annual_cell_days real not null,             -- harmonized (VIIRS-equivalent), 2001–2025
  density               real not null,             -- per grid cell per year
  density_pct           real not null,
  years_with_fire       smallint not null,
  recurrence            real not null,
  peak_month            smallint,
  season_months         smallint[] not null default '{}',
  frp_p90_modis_mw      real,
  trend_pct_per_decade  real,
  trend_p               real,
  gi_z                  real not null,
  gi_q                  real not null,
  hotspot               text not null,
  prone_class           text not null check (prone_class in ('very_high', 'high', 'elevated', 'low')),
  why                   text not null,
  primary key (scope, tile_id)
);
create index if not exists prone_tiles_class on prone_tiles (scope, prone_class);
create index if not exists prone_tiles_latlon on prone_tiles (scope, lat, lon);
