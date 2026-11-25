#!/usr/bin/env node
// Builds the Archival map "showcase" files (docs/issues/archival-showcase-data.md, Option A):
//   california-2020-08.json.gz  harmonized (cells weighted with the calendar's per-day rule), from backfill outputs
//   quebec-2023-06.json.gz      raw VIIRS detections, from the realtime replay scenario (outside the US archive)
// Usage: node scripts/showcase/build.mjs --ca-out <backfill out dir> --quebec <scenario json> --out <dir>
// California inputs: `node scripts/backfill/src/cli.ts run --region california --from 2020-08-01 --to 2020-09-30 ...`
// on the FIRMS country files (modis_2020_United_States.csv, viirs-snpp_2020_United_States.csv), and the production
// static mask data/harmonized/california/static_mask.csv (its cells are dropped, like the archive's heat_class filter).
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k) => process.argv[process.argv.indexOf(`--${k}`) + 1];
const out = arg("out");
mkdirSync(out, { recursive: true });
const SAT = ["TERRA", "AQUA", "SNPP", "NOAA20", "NOAA21"];
const sensorOf = (s) => (s === "TERRA" || s === "AQUA" ? "MODIS" : "VIIRS");
const csv = (text) => {
  const [h, ...lines] = text.trim().split("\n");
  const cols = h.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
};
const PER_DAY_POINTS = 3000;
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

function finish(meta, dates, cells, points) {
  const body = { ...meta, dates, cells, points };
  const gz = gzipSync(JSON.stringify(body), { level: 9 });
  writeFileSync(join(out, `${meta.id}.json.gz`), gz);
  console.log(meta.id, "cells", cells.c.length, "points", points.lat.length, "gz bytes", gz.length);
  return { id: meta.id, bytes: gz.length };
}

// ---------- California (harmonized) ----------
{
  const dir = arg("ca-out");
  const mask = new Set(csv(readFileSync("data/harmonized/california/static_mask.csv", "utf8")).map((r) => Number(r.cell_id)));
  const daily = new Map(csv(readFileSync(join(dir, "daily_harmonized.csv"), "utf8")).map((r) => [r.acq_date, r]));
  const rows = csv(readFileSync(join(dir, "cell_days/2020.csv"), "utf8")).filter((r) => !mask.has(Number(r.cell_id)));
  const dates = [...new Set(rows.map((r) => r.acq_date))].sort();
  const di = new Map(dates.map((d, i) => [d, i]));
  const cells = { d: [], c: [], s: [], p: [], n: [], w: [] };
  // weight: the calendar's rule. VIIRS day -> the reference satellite's cells weigh 1; MODIS-scaled day -> alpha once per cell.
  const modisDone = new Set();
  for (const r of rows.sort((a, b) => a.acq_date.localeCompare(b.acq_date) || Number(a.cell_id) - Number(b.cell_id))) {
    const day = daily.get(r.acq_date);
    let w = 0;
    if (day?.basis === "VIIRS" && r.satellite === day.viirs_reference) w = 1;
    else if (day?.basis === "MODIS_SCALED") {
      const cfg = day.modis_config;
      const ok = (cfg === "TA" && (r.satellite === "TERRA" || r.satellite === "AQUA")) || (cfg === "T" && r.satellite === "TERRA") || (cfg === "A" && r.satellite === "AQUA");
      const key = `${r.acq_date}|${r.cell_id}`;
      if (ok && !modisDone.has(key)) { modisDone.add(key); w = Number(day.alpha); }
    }
    cells.d.push(di.get(r.acq_date)); cells.c.push(Number(r.cell_id)); cells.s.push(SAT.indexOf(r.satellite));
    cells.p.push(round(Number(r.peak_frp_mw), 1)); cells.n.push(Number(r.n_detections)); cells.w.push(round(w, 4));
  }
  const det = csv(gunzipSync(readFileSync(join(dir, "detections/2020.csv.gz"))).toString()).filter((r) => !mask.has(Number(r.cell_id)));
  const byDay = new Map();
  for (const r of det) (byDay.get(r.acq_date) ?? byDay.set(r.acq_date, []).get(r.acq_date)).push(r);
  const points = { lat: [], lon: [], d: [], t: [], f: [], s: [], q: [], n: [] };
  for (const date of dates) {
    const top = (byDay.get(date) ?? []).sort((a, b) => Number(b.frp_mw) - Number(a.frp_mw)).slice(0, PER_DAY_POINTS);
    for (const r of top) {
      points.lat.push(Number(r.latitude)); points.lon.push(Number(r.longitude)); points.d.push(di.get(date)); points.t.push(Number(r.acq_time));
      points.f.push(Number(r.frp_mw)); points.s.push(SAT.indexOf(r.satellite)); points.q.push(Number(r.confidence)); points.n.push(r.day_night === "N" ? 0 : 1);
    }
  }
  var caInfo = finish(
    { id: "california-2020-08", label: "California, Aug–Sep 2020", from: "2020-08-01", to: "2020-09-30", bbox: [-124.5, 32.5, -114, 42.1], harmonized: true,
      note: "Harmonized VIIRS-equivalent cell-days (NASA FIRMS S-NPP VIIRS + MODIS) built from the FIRMS country files; cells on the archive's static mask are dropped. Within 1% of the calendar.",
      source: "NASA FIRMS (country files modis_2020 / viirs-snpp_2020, United States)" },
    dates, cells, points);
}

// ---------- Quebec (raw VIIRS) ----------
{
  const sc = JSON.parse(readFileSync(arg("quebec"), "utf8"));
  const rows = sc.rows; // [t, lat, lon, satIdx, frp, confIdx, day]
  const dateOf = (t) => new Date(t).toISOString().slice(0, 10);
  const dates = [...new Set(rows.map((r) => dateOf(r[0])))].sort();
  const di = new Map(dates.map((d, i) => [d, i]));
  const cellOf = (lat, lon) => Math.floor((lat + 90) * 20 + 1e-9) * 7200 + Math.floor((lon + 180) * 20 + 1e-9);
  const agg = new Map();
  for (const r of rows) {
    const k = `${dateOf(r[0])}|${cellOf(r[1], r[2])}|${r[3]}`;
    const a = agg.get(k) ?? { d: di.get(dateOf(r[0])), c: cellOf(r[1], r[2]), s: r[3], p: 0, n: 0 };
    a.p = Math.max(a.p, r[4]); a.n++; agg.set(k, a);
  }
  const cells = { d: [], c: [], s: [], p: [], n: [], w: [] };
  for (const a of [...agg.values()].sort((x, y) => x.d - y.d || x.c - y.c)) { cells.d.push(a.d); cells.c.push(a.c); cells.s.push(a.s); cells.p.push(round(a.p, 1)); cells.n.push(a.n); cells.w.push(0); }
  const points = { lat: [], lon: [], d: [], t: [], f: [], s: [], q: [], n: [] };
  const byDay = new Map();
  for (const r of rows) (byDay.get(dateOf(r[0])) ?? byDay.set(dateOf(r[0]), []).get(dateOf(r[0]))).push(r);
  for (const date of dates) {
    for (const r of byDay.get(date).sort((a, b) => b[4] - a[4]).slice(0, PER_DAY_POINTS)) {
      const d = new Date(r[0]);
      points.lat.push(r[1]); points.lon.push(r[2]); points.d.push(di.get(date)); points.t.push(d.getUTCHours() * 100 + d.getUTCMinutes());
      points.f.push(r[4]); points.s.push(r[3]); points.q.push([15, 50, 85][r[5]] ?? 50); points.n.push(r[6]);
    }
  }
  var qInfo = finish(
    { id: "quebec-2023-06", label: "Quebec, 1–10 June 2023", from: sc.from, to: sc.to, bbox: sc.bbox, harmonized: false,
      note: "Raw VIIRS detections (outside the US harmonized archive)", source: "NASA FIRMS VIIRS S-NPP and NOAA-20 SP, from the realtime replay scenario quebec-2023-06" },
    dates, cells, points);
}
writeFileSync(join(out, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), files: [caInfo, qInfo] }, null, 1));
