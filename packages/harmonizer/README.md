# `@repo/harmonizer` — Cross-Sensor Spatial & Radiometric Engine

Pure TypeScript package with zero runtime dependencies (shared across `api-worker`, `ingest-worker`, `web`, and `scripts/`).

## Harmonization Pipeline
1. **Quality & Floor Filtering**: Drops low-confidence noise (`confidence < 30` for MODIS; `confidence === 'l'` or `frp < 5.0` MW for VIIRS to match MODIS's minimum thermal sensitivity).
2. **Shared Spatial Grid (`0.05°` / ~5.5 km)**: Snaps both sensors onto a common grid to absorb MODIS off-nadir pixel stretching and eliminate VIIRS sub-pixel over-counting.
3. **Two-Stage Overpass Deduplication**:
   - Sums `frp` across multiple VIIRS sub-pixels within the same cell and single satellite overpass (`pass_frp`).
   - Collapses multiple same-day satellite passes (Terra, Aqua, Suomi-NPP, NOAA-20, NOAA-21) into **1 active cell-day** taking `MAX(pass_frp)` as `peak_frp_mw`.
4. **Dynamic Polygon Calibration ($\alpha_m$)**: Computes monthly sensor ratios ($\alpha_m = \sum \text{MODIS}_m / \sum \text{VIIRS}_m$) over the 2012–2025 overlap window inside the user's selected polygon.
