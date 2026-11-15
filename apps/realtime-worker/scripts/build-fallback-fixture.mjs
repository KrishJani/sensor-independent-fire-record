#!/usr/bin/env node
// Builds src/replay/fallback-fixture.json from the golden FIRMS samples in sample_api/
// (California, 2020-08-15 → 08-19, MODIS + VIIRS S-NPP). Bundled so replay works without R2.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCsv, toCompact } from "../src/detection.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sample = join(here, "../../../sample_api");
const out = join(here, "../src/replay/fallback-fixture.json");

// Clipped to the LNU Lightning Complex area to keep the bundle small (~5k rows).
const BBOX = [-123.6, 38.2, -121.8, 39.6];
const inBbox = (d) => d.lon >= BBOX[0] && d.lon <= BBOX[2] && d.lat >= BBOX[1] && d.lat <= BBOX[3];
const rows = [];
for (const [file, hint] of [
  ["viirs_snpp_historical_sample.csv", "VIIRS_SNPP_SP"],
  ["modis_historical_sample.csv", "MODIS_SP"]
]) {
  const { detections, dropped, nonVegetation } = normalizeCsv(readFileSync(join(sample, file), "utf8"), hint);
  console.log(`${file}: kept ${detections.length}, non-vegetation ${nonVegetation}, bad ${dropped}`);
  rows.push(...detections.filter(inBbox).map(toCompact));
}
rows.sort((a, b) => a[0] - b[0]);
const scenario = {
  scenario: "california-2020-08-sample",
  label: "Northern California (LNU Complex area), 2020-08-15 to 2020-08-19 (FIRMS sample, MODIS + VIIRS S-NPP)",
  bbox: BBOX,
  from: "2020-08-15",
  to: "2020-08-19",
  sources: ["VIIRS_SNPP_SP", "MODIS_SP"],
  rows
};
writeFileSync(out, JSON.stringify(scenario));
console.log(`wrote ${rows.length} rows → ${out}`);
