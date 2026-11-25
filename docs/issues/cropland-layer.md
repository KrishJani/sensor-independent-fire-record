# Cropland layer for "possible agricultural burn" labels (parked)

**Status:** parked, not built. Nothing in the app claims an agricultural cause today.

## Why

Many top incidents (Louisiana sugarcane, Sinaloa, Chiapas) have the pattern of crop burning: low power, many cells, few detections per cell.
Power and cell statistics cannot support the word "agricultural" on their own (a max FRP under 100 MW matches 183 of 190 live incidents).
Only a land-cover layer can.

## Approach

One offline job bakes a **cropland share per 0.05° cell** (our grid) from two sources, then ships it as a small static file:

1. USA: USDA CDL, which also gives crop codes (e.g. sugarcane) if wanted later.
2. Elsewhere: ESA WorldCover, cropland class.
3. Output: one byte per 0.05° cell (7200 x 3600 = 25.9 M cells, so about 26 MB raw and a few MB compressed). Host it in R2 or as a Worker asset, load once per isolate, look up an incident's cells in memory.
4. Label rule (to be agreed): share of an incident's cells with cropland above a threshold, plus the existing low-power / scattered pattern, worded "possible agricultural burn".

Runtime cost per incident: none beyond an array lookup. The alternative, reading the raw rasters at runtime, needs range requests against tens of GB (not recommended).

## Sources and sizes (checked against the official pages on 2026-11-25)

| Source | Resolution | Size | License |
|---|---|---|---|
| USDA NASS CDL 2025 national, 10 m | 10 m (since 2024) | 9.8 GB zip | not stated on the pages read |
| USDA NASS CDL 2025 national, resampled 30 m | 30 m | 1.9 GB zip | not stated on the pages read |
| ESA WorldCover v200 (2021) map | 10 m, 3x3° COG tiles, 2651 tiles | about 117 GB (data-access page); 124.0 GB on the Zenodo record (18 macrotile zips) | CC BY 4.0 |

- CDL: https://www.nass.usda.gov/Research_and_Science/Cropland/Release/index.php (release of 2025 announced 2026-02-27). The pages say "zipped file"; the GeoTIFF format was not confirmed. License terms were not stated: check before publishing derived data.
- WorldCover: https://esa-worldcover.org/en/data-access and https://zenodo.org/records/7254221. Hosted in the public S3 bucket `esa-worldcover` (`--no-sign-request`). The cropland class code (40, "Cropland") is not stated on the pages read: confirm it from the product legend.
- The baking job only needs the 30 m CDL and could stream WorldCover tiles, so it never has to store the full 117-124 GB.

## Open questions

- Share threshold and how to weigh it against the power pattern; validate on wildfire scenarios (Quebec 2023, California 2020), which have not been measured.
- CDL license for a derived cropland-share grid.
- Year of the layers (crop areas change; bake yearly).
