#!/usr/bin/env node
// Pulls FIRMS archive (SP) detections for the Quebec 2023 replay scenario and uploads it.
//   pnpm --filter realtime-worker fetch-replay-fixture [--no-remote] [--no-local] [--refresh]
//     [--upload-only] [--store=r2|kv]
// --upload-only skips FIRMS and uploads the existing data/<scenario>.json.
// --store: default r2 when wrangler.jsonc has an (uncommented) r2_buckets entry, otherwise kv.
// Needs FIRMS_MAP_KEY (env or apps/realtime-worker/.dev.vars).
//
// - Area API: /api/area/csv/{KEY}/{SOURCE}/{w,s,e,n}/{DAY_RANGE}/{START_DATE}
// - Chunked by the largest day range the API accepts (probed: 10, then 5), throttled.
// - Keeps type 0 (vegetation fire) only. VIIRS_SNPP_SP + VIIRS_NOAA20_SP always; MODIS_SP only if
//   the total stays under MAX_ROWS.
// - Raw CSVs are cached in apps/realtime-worker/data/raw/ (gitignored); --refresh refetches.
// - Writes data/<scenario>.json (+ .json.gz) and uploads it to R2 as scenarios/<scenario>.json, or to
//   KV (binding REPLAY_KV) as scenarios/<scenario>.json.gz (gzipped; the worker decompresses with
//   DecompressionStream). Both local dev state (../../.wrangler/shared-state) and remote.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCsv, toCompact } from "../src/detection.ts";

const SCENARIO = "quebec-2023-06";
const BBOX = [-80, 45, -60, 53];
const FROM = "2023-06-01";
const TO = "2023-06-10";
const VIIRS = ["VIIRS_SNPP_SP", "VIIRS_NOAA20_SP"];
const MODIS = "MODIS_SP";
const MAX_ROWS = 60_000;
const BUCKET = "nasa-fire-realtime";
const GAP_MS = 1500; // between FIRMS calls (5000 tx / 10 min per key; area calls can cost several tx)

const args = new Set(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dataDir = join(root, "data");
const rawDir = join(dataDir, "raw", SCENARIO);
mkdirSync(rawDir, { recursive: true });

const KV_LIMIT = 25 * 1024 * 1024;
const r2Configured = () =>
  /"r2_buckets"\s*:/.test(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const storeArg = [...args].find((a) => a.startsWith("--store="))?.slice(8);
const STORE = storeArg ?? (r2Configured() ? "r2" : "kv");
if (!["r2", "kv"].includes(STORE)) {
  console.error(`--store must be r2 or kv, got ${STORE}`);
  process.exit(1);
}
const outFile = join(dataDir, `${SCENARIO}.json`);
const gzFile = `${outFile}.gz`;

function mapKey() {
  if (process.env.FIRMS_MAP_KEY) return process.env.FIRMS_MAP_KEY.trim();
  const f = join(root, ".dev.vars");
  if (existsSync(f)) {
    const m = readFileSync(f, "utf8").match(/^FIRMS_MAP_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  }
  console.error("FIRMS_MAP_KEY is not set (env or apps/realtime-worker/.dev.vars).");
  process.exit(1);
}
const KEY = args.has("--upload-only") ? null : mapKey();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000) + 1;

let lastCall = 0;
async function firms(source, dayRange, date) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/${source}/${BBOX.join(",")}/${dayRange}/${date}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": "skywalkers77-realtime-fixture/1.0" } });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      console.warn(`  ${source} ${date}: HTTP ${res.status}, retrying (${attempt}/3)`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return { status: res.status, text, url: url.replace(KEY, "<KEY>") };
  }
  throw new Error(`FIRMS kept failing for ${source} ${date}`);
}

const isCsv = (t) => t.startsWith("latitude,");

/** Largest DAY_RANGE the area API accepts for archive dates. */
async function probeDayRange() {
  for (const n of [10, 5]) {
    const r = await firms(VIIRS[0], n, FROM);
    if (isCsv(r.text)) return { n, first: r };
    console.log(`  day range ${n} rejected: HTTP ${r.status} ${JSON.stringify(r.text.slice(0, 300))}`);
    if (!/range|day/i.test(r.text)) {
      console.error(`\nFIRMS rejected the request.\n  URL: ${r.url}\n  HTTP ${r.status}\n  Body: ${r.text.slice(0, 1000)}`);
      process.exit(2);
    }
  }
  console.error("FIRMS rejected every day range; see errors above.");
  process.exit(2);
}

async function fetchSource(source, dayRange, prefetched) {
  const total = daysBetween(FROM, TO);
  const csvs = [];
  for (let off = 0; off < total; off += dayRange) {
    const start = addDays(FROM, off);
    const n = Math.min(dayRange, total - off);
    const cache = join(rawDir, `${source}_${start}_${n}.csv`);
    let text;
    if (existsSync(cache) && !args.has("--refresh")) {
      text = readFileSync(cache, "utf8");
    } else if (prefetched && off === 0 && n === dayRange) {
      text = prefetched.text;
      writeFileSync(cache, text);
    } else {
      const r = await firms(source, n, start);
      if (!isCsv(r.text)) {
        console.error(`\nFIRMS rejected the request.\n  URL: ${r.url}\n  HTTP ${r.status}\n  Body: ${r.text.slice(0, 1000)}`);
        process.exit(2);
      }
      text = r.text;
      writeFileSync(cache, text);
    }
    csvs.push(text);
  }
  const rows = [];
  let nonVeg = 0;
  let bad = 0;
  for (const text of csvs) {
    const r = normalizeCsv(text, source);
    rows.push(...r.detections);
    nonVeg += r.nonVegetation;
    bad += r.dropped;
  }
  return { source, rows, nonVeg, bad };
}

async function build() {
console.log(`FIRMS archive → ${SCENARIO}: bbox ${BBOX.join(",")}, ${FROM} → ${TO}`);
const { n: dayRange, first } = await probeDayRange();
console.log(`  using DAY_RANGE=${dayRange}`);

const results = [];
for (const s of VIIRS) results.push(await fetchSource(s, dayRange, s === VIIRS[0] ? first : null));
let total = results.reduce((a, r) => a + r.rows.length, 0);
const modis = await fetchSource(MODIS, dayRange, null);
if (total + modis.rows.length <= MAX_ROWS) {
  results.push(modis);
  total += modis.rows.length;
  console.log(`  MODIS_SP included (${modis.rows.length} rows, total ${total} ≤ ${MAX_ROWS})`);
} else {
  console.log(`  MODIS_SP skipped (${modis.rows.length} rows would bring the total to ${total + modis.rows.length} > ${MAX_ROWS})`);
}

// Per day × source table.
const days = Array.from({ length: daysBetween(FROM, TO) }, (_, i) => addDays(FROM, i));
console.log(`\n${"date".padEnd(12)}${results.map((r) => r.source.padStart(17)).join("")}${"total".padStart(9)}`);
for (const d of days) {
  const counts = results.map((r) => r.rows.filter((x) => new Date(x.t).toISOString().startsWith(d)).length);
  console.log(`${d.padEnd(12)}${counts.map((c) => String(c).padStart(17)).join("")}${String(counts.reduce((a, b) => a + b, 0)).padStart(9)}`);
}
console.log(
  `${"total".padEnd(12)}${results.map((r) => String(r.rows.length).padStart(17)).join("")}${String(total).padStart(9)}`
);
for (const r of results) console.log(`  ${r.source}: dropped ${r.nonVeg} non-vegetation (type≠0), ${r.bad} malformed`);

const all = results.flatMap((r) => r.rows).sort((a, b) => a.t - b.t);
const scenario = {
  scenario: SCENARIO,
  label: "Quebec, 2023-06-01 to 2023-06-10 (FIRMS archive, vegetation fires)",
  bbox: BBOX,
  from: FROM,
  to: TO,
  sources: results.map((r) => r.source),
  generatedAt: new Date().toISOString(),
  rows: all.map(toCompact)
};
writeFileSync(outFile, JSON.stringify(scenario));
console.log(`\nwrote ${all.length} rows (${(JSON.stringify(scenario).length / 1e6).toFixed(2)} MB) → ${outFile}`);
}

if (args.has("--upload-only")) {
  if (!existsSync(outFile)) {
    console.error(`--upload-only: ${outFile} does not exist; run without --upload-only first.`);
    process.exit(1);
  }
} else {
  await build();
}
writeFileSync(gzFile, gzipSync(readFileSync(outFile), { level: 9 }));
const gzBytes = statSync(gzFile).size;
console.log(`gzipped → ${gzFile} (${(gzBytes / 1e6).toFixed(2)} MB, ${((gzBytes / KV_LIMIT) * 100).toFixed(1)}% of the KV value limit)`);
if (STORE === "kv" && gzBytes >= KV_LIMIT) {
  console.error("gzipped scenario exceeds KV's 25 MiB value limit");
  process.exit(4);
}

function upload(where) {
  const target = where === "local" ? ["--local", "--persist-to", "../../.wrangler/shared-state"] : ["--remote"];
  const argv =
    STORE === "r2"
      ? ["exec", "wrangler", "r2", "object", "put", `${BUCKET}/scenarios/${SCENARIO}.json`, "--file", outFile, "--content-type", "application/json", ...target]
      : ["exec", "wrangler", "kv", "key", "put", `scenarios/${SCENARIO}.json.gz`, "--binding", "REPLAY_KV", "--path", gzFile, ...target];
  const label = STORE === "r2" ? `R2 ${BUCKET}/scenarios/${SCENARIO}.json` : `KV REPLAY_KV scenarios/${SCENARIO}.json.gz`;
  try {
    execFileSync("pnpm", argv, { cwd: root, stdio: "pipe" });
    console.log(`uploaded (${where}): ${label}`);
    return true;
  } catch (e) {
    console.error(`upload to ${label} (${where}) failed:\n${String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-6).join("\n")}`);
    return false;
  }
}
let ok = true;
if (!args.has("--no-local")) ok = upload("local") && ok;
if (!args.has("--no-remote")) ok = upload("remote") && ok;
process.exit(ok ? 0 : 3);
