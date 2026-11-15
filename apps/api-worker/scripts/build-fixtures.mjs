#!/usr/bin/env node
// Builds src/data/sample-fixture.json from the golden FIRMS samples in sample_api/.
//
// The chat copilot's mock data source uses this for get_spots_summary, so the
// demo answers questions about the real California Aug 15–19 2020 detections
// (August Complex / LNU Lightning Complex) without Postgres or D1.
//
// Rules follow packages/harmonizer/SPEC.md:
//   §4 filter: drop type != 0 (volcano / static / offshore), MODIS confidence < 30,
//      VIIRS confidence "l". NRT rows have no `type` column and are kept.
//   §5 grid:   0.05° cells, row = floor((lat+90)/0.05), col = floor((lon+180)/0.05).
//   §6 cells:  one cell-day per (satellite, date, cell). Passes are split on a
//              >30 min gap; peak FRP = max over passes of the summed pass FRP.
//
// Usage: pnpm --filter api-worker fixtures

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = resolve(here, "../../../sample_api");
const OUT = resolve(here, "../src/data/sample-fixture.json");
const GRID = 0.05;
const TOP_N = 200;

const SATELLITE = { Terra: "TERRA", Aqua: "AQUA", N: "SNPP", 1: "NOAA20", 2: "NOAA21" };
const VIIRS_CONF = { l: 20, n: 60, h: 90 };

const round = (x, dp) => Number(x.toFixed(dp));
const minutes = (hhmm) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.filter(Boolean).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, values[i]]));
  });
}

function normalize(row, file) {
  const sensor = row.instrument === "VIIRS" ? "VIIRS" : "MODIS";
  const satellite = SATELLITE[row.satellite];
  if (!satellite) throw new Error(`${file}: unknown satellite ${row.satellite}`);
  const confidence =
    sensor === "VIIRS" ? VIIRS_CONF[row.confidence] ?? 0 : Number(row.confidence);
  return {
    lat: Number(row.latitude),
    lon: Number(row.longitude),
    date: row.acq_date,
    time: Number(row.acq_time),
    satellite,
    sensor,
    confidence,
    frp: Number(row.frp),
    dayNight: row.daynight,
    type: row.type === undefined || row.type === "" ? 0 : Number(row.type),
    tier: /NRT/i.test(row.version) ? "realtime" : "archival"
  };
}

const keep = (d) =>
  d.type === 0 && (d.sensor === "MODIS" ? d.confidence >= 30 : d.confidence >= 60);

const files = readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".csv")).sort();
const detections = [];
const stats = {};
for (const file of files) {
  const rows = parseCsv(readFileSync(join(SAMPLE_DIR, file), "utf8"));
  const norm = rows.map((r) => normalize(r, file));
  const kept = norm.filter(keep);
  stats[file] = { rows: rows.length, kept: kept.length };
  detections.push(...kept);
}

// Group into (satellite, date, cell) cell-days.
const groups = new Map();
for (const d of detections) {
  const row = Math.min(3599, Math.floor((d.lat + 90) / GRID));
  const col = Math.min(7199, Math.floor((d.lon + 180) / GRID));
  const key = `${d.satellite}|${d.date}|${row}|${col}`;
  let g = groups.get(key);
  if (!g) groups.set(key, (g = { row, col, date: d.date, satellite: d.satellite, dets: [] }));
  g.dets.push(d);
}

const cellDays = [...groups.values()]
  .map((g) => {
    g.dets.sort((a, b) => a.time - b.time);
    let passFrp = 0;
    let peak = 0;
    let last = null;
    for (const d of g.dets) {
      if (last !== null && minutes(d.time) - minutes(last) > 30) {
        peak = Math.max(peak, passFrp);
        passFrp = 0;
      }
      passFrp += d.frp;
      last = d.time;
    }
    peak = Math.max(peak, passFrp);
    return {
      lat: round(-90 + (g.row + 0.5) * GRID, 3),
      lon: round(-180 + (g.col + 0.5) * GRID, 3),
      date: g.date,
      satellite: g.satellite,
      n: g.dets.length,
      maxFrp: round(peak, 1),
      lastTime: String(last).padStart(4, "0")
    };
  })
  .sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.lat - b.lat ||
      a.lon - b.lon ||
      a.satellite.localeCompare(b.satellite)
  );

const top = [...detections]
  .sort((a, b) => b.frp - a.frp || a.date.localeCompare(b.date) || a.lat - b.lat)
  .slice(0, TOP_N)
  .map((d) => ({
    lat: round(d.lat, 4),
    lon: round(d.lon, 4),
    date: d.date,
    time: String(d.time).padStart(4, "0"),
    satellite: d.satellite,
    sensor: d.sensor,
    tier: d.tier,
    frp: round(d.frp, 1),
    confidence: d.confidence,
    dayNight: d.dayNight
  }));

const dates = detections.map((d) => d.date).sort();
const fixture = {
  generatedFrom: files,
  rules: "type==0; MODIS conf>=30; VIIRS conf n|h; 0.05° cells; peak FRP = max pass sum",
  dateRange: [dates[0], dates[dates.length - 1]],
  stats,
  cellDays,
  topDetections: top
};

writeFileSync(OUT, JSON.stringify(fixture));
const kb = (JSON.stringify(fixture).length / 1024).toFixed(0);
console.log(
  `wrote ${OUT}\n  ${detections.length} detections -> ${cellDays.length} cell-days, top ${top.length}, ${kb} KB`
);
for (const [f, s] of Object.entries(stats)) console.log(`  ${f}: ${s.kept}/${s.rows} kept`);
