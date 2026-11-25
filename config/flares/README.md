# Known gas-flare cells

`eog_myc25q4_cells.csv` lists the 0.05° cells within ±0.01° of an upstream gas-flare site that was
active (flared volume > 0) in any year 2012–2025.

**Source:** Zhizhin, M.; Ghosh, T.; Gleason, G.; Elvidge, C. D.; Bazilian, M. (2026).
*VIIRS Nightfire upstream gas-flaring volumes, 2012–2025 (MYC25Q4)*, version 1.0. Zenodo.
doi:[10.5281/zenodo.23091822](https://doi.org/10.5281/zenodo.23091822).
Earth Observation Group, Payne Institute for Public Policy, Colorado School of Mines.

**License:** CC BY-NC 4.0. This derived list carries the same license, for non-commercial use with
attribution. For commercial use, contact eog@mines.edu.

To rebuild it:

1. Download `annual_flare_site_records.csv` from the Zenodo record into
   `data/raw/flares/eog-myc25q4/`.
2. Run `node scripts/backfill/src/cli.ts flare-cells`.

The realtime worker bundles the same ids as `apps/realtime-worker/src/flare-cells.json` (sorted cell ids; a test checks it against this CSV) to label incidents "Gas flare (EOG inventory)".

How the cells are used is described in `docs/HARMONIZATION.md` §4.4.
