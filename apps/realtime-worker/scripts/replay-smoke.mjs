#!/usr/bin/env node
// End-to-end replay smoke test against a running realtime-worker (pnpm dev).
//   pnpm --filter realtime-worker replay-smoke
// Env: HOST (default localhost:8789), SCENARIO (default quebec-2023-06; falls back to the bundled
// sample if not in R2), SPEED (stream s per real s; default = worker's REPLAY_DEFAULT_SPEED),
// TIMEOUT_S (default 180), QUIET=1 (only the summary).
// Checks: incidents get created, detection counts grow, the clock advances, the replay finishes.

const HOST = process.env.HOST ?? "localhost:8789";
const SCENARIO = process.env.SCENARIO ?? "quebec-2023-06";
const SPEED = process.env.SPEED ? Number(process.env.SPEED) : undefined;
const TIMEOUT_S = Number(process.env.TIMEOUT_S ?? 180);
const QUIET = process.env.QUIET === "1";
const http = HOST.startsWith("localhost") || HOST.startsWith("127.") ? "http" : "https";
const base = `${http}://${HOST}`;

const fmt = (t) => (t ? new Date(t).toISOString().replace(":00.000Z", "Z").replace("T", " ") : "-");
const log = (...a) => !QUIET && console.log(...a);

const started = Date.now();
const res = await fetch(`${base}/realtime/replay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: SCENARIO, ...(SPEED ? { speed: SPEED } : {}) })
});
if (!res.ok) {
  console.error("POST /realtime/replay failed:", res.status, await res.text());
  process.exit(1);
}
const replay = await res.json();
console.log(
  `replay ${replay.id} scenario=${replay.scenario} (${replay.origin}) rows=${replay.total} speed=${replay.speed}x ` +
    `stream ${fmt(replay.startT)} → ${fmt(replay.endT)}, expected ~${replay.expectedDurationS}s`
);
if (replay.note) console.log("note:", replay.note);

const incidents = new Map(); // id -> latest summary
const firstCounts = new Map(); // id -> detections when first seen
let grew = 0;
let clocks = [];
let points = 0;
let briefs = 0;
let messages = 0;
let maxMsgsPerSec = 0;
let secBucket = 0;
let secCount = 0;
let replayDone = false;

const ws = new WebSocket(`ws${http === "https" ? "s" : ""}://${HOST}/realtime/ws?stream=replay:${replay.id}`);
ws.addEventListener("open", () => log("ws connected"));
ws.addEventListener("error", (e) => console.error("ws error", e.message ?? e));
ws.addEventListener("message", (ev) => {
  messages++;
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== secBucket) {
    secBucket = sec;
    secCount = 0;
  }
  maxMsgsPerSec = Math.max(maxMsgsPerSec, ++secCount);
  const frame = JSON.parse(ev.data);
  for (const msg of frame.type === "batch" ? frame.messages : [frame]) handle(msg);
});
function handle(msg) {
  switch (msg.type) {
    case "incident.upsert": {
      const s = msg.incident;
      const prev = incidents.get(s.id);
      if (!prev) {
        firstCounts.set(s.id, s.detections);
        log(
          `+ ${s.id.padEnd(22)} ${fmt(s.lastSeen)}  ${String(s.detections).padStart(5)} det  ${String(s.areaKm2).padStart(7)} km²  ` +
            `centroid ${s.centroid[1].toFixed(2)},${s.centroid[0].toFixed(2)}`
        );
      } else if (s.detections > prev.detections && prev.detections === firstCounts.get(s.id)) {
        grew++;
      }
      if (prev && prev.status !== s.status) log(`~ ${s.id} ${prev.status} → ${s.status}${s.mergedInto ? ` (into ${s.mergedInto})` : ""}`);
      incidents.set(s.id, s);
      break;
    }
    case "clock":
      clocks.push(msg.t);
      break;
    case "detections":
      points += msg.points.length;
      break;
    case "incident.brief":
      briefs++;
      log(`* brief ${msg.id}: ${msg.brief.text}`);
      break;
    case "replay.status":
      if (msg.status === "done" || msg.status === "stopped") replayDone = true;
      break;
  }
}

let status = replay;
let lastPrint = 0;
while (Date.now() - started < TIMEOUT_S * 1000) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await (await fetch(`${base}/realtime/replay/${replay.id}`)).json();
  if (Date.now() - lastPrint > 10_000) {
    lastPrint = Date.now();
    log(`… ${(status.progress * 100).toFixed(0)}%  clock ${fmt(status.streamT)}  emitted ${status.emitted}/${status.total}  incidents ${incidents.size}`);
  }
  if (status.status === "done" || status.status === "stopped" || status.status === "error") break;
}
await new Promise((r) => setTimeout(r, 1500)); // let the last flush arrive
ws.close();

const list = await (await fetch(`${base}/realtime/incidents?stream=replay:${replay.id}&status=all`)).json();
const elapsed = (Date.now() - started) / 1000;
const largest = [...list.incidents].sort((a, b) => b.areaKm2 - a.areaKm2)[0];
const growing = [...incidents.values()].filter((s) => s.detections > (firstCounts.get(s.id) ?? s.detections)).length;
const clockAdvanced = clocks.length >= 2 && clocks.at(-1) > clocks[0];

const checks = [
  ["incidents created", incidents.size > 0, `${incidents.size} significant incidents over WebSocket, ${list.count} via REST`],
  ["counts grow", growing > 0, `${growing} incidents grew after first upsert`],
  ["clock advances", clockAdvanced, `${clocks.length} clock msgs, ${fmt(clocks[0])} → ${fmt(clocks.at(-1))}`],
  ["replay finished", status.status === "done", `status=${status.status} progress=${(status.progress * 100).toFixed(0)}%`],
  ["detections streamed", points > 0, `${points} map points`],
  ["frame rate", maxMsgsPerSec <= 4, `max ${maxMsgsPerSec} frames/s (limit 4)`]
];

console.log("\nsummary");
console.log(`  wall time        ${elapsed.toFixed(1)} s (replay ${status.finishedAt ? ((status.finishedAt - status.createdAt) / 1000).toFixed(1) : "?"} s)`);
console.log(`  detections       ${status.clusterer?.counters?.detections ?? "?"} accepted, ${status.clusterer?.counters?.low_confidence ?? 0} low confidence`);
console.log(`  incidents        ${status.clusterer?.incidents?.total ?? "?"} total, ${status.clusterer?.incidents?.significant ?? "?"} significant, ${status.clusterer?.merges ?? 0} merges`);
if (largest)
  console.log(`  largest          ${largest.id}: ${largest.areaKm2} km², ${largest.detections} detections, max FRP ${largest.frpMaxMw} MW, ${largest.status}`);
console.log(`  frames           ${messages} total, max ${maxMsgsPerSec}/s, ${briefs} briefs`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name.padEnd(20)} ${detail}`);
}
if (process.env.SMOKE_JSON === "1")
  console.log(JSON.stringify({ id: replay.id, elapsed, incidents: list.count, largest, status: status.status, failed }));
process.exit(failed ? 1 : 0);
