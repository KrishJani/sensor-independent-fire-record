// Reproduces scripts/quebec-timeline.md. Self-contained bundle of the realtime-worker clustering
// modules (apps/realtime-worker/src: grid, cluster, detection, incidentModel) as of this commit.
// Usage: node scripts/quebec-timeline.mjs apps/realtime-worker/data/quebec-2023-06.json
// analyze.ts
import { readFileSync } from "node:fs";

// apps/realtime-worker/src/grid.ts
var CELL_DEG = 0.05;
var CELLS_PER_DEG = 20;
var KM_PER_DEG = 111.32;
function cellOf(lat, lon) {
  return {
    row: Math.floor((lat + 90) * CELLS_PER_DEG + 1e-9),
    col: Math.floor((lon + 180) * CELLS_PER_DEG + 1e-9)
  };
}
function cellKey(c) {
  return `${c.row}:${c.col}`;
}
function parseCellKey(key) {
  const [row, col] = key.split(":").map(Number);
  return { row, col };
}
function neighborCells(c) {
  const out2 = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) out2.push({ row: c.row + dr, col: c.col + dc });
  return out2;
}
function cellCenter(c) {
  return {
    lat: c.row / CELLS_PER_DEG - 90 + CELL_DEG / 2,
    lon: c.col / CELLS_PER_DEG - 180 + CELL_DEG / 2
  };
}
function cellAreaKm2(c) {
  const { lat } = cellCenter(c);
  const side = CELL_DEG * KM_PER_DEG;
  return side * side * Math.cos(lat * Math.PI / 180);
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// apps/realtime-worker/src/cluster.ts
var LINK_WINDOW_MS = 48 * 36e5;
function resolve(store2, id) {
  let inc = store2.getIncident(id);
  for (let hops = 0; inc?.mergedInto && hops < 32; hops++) inc = store2.getIncident(inc.mergedInto);
  return inc;
}
function older(a, b) {
  return a.firstT - b.firstT || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function assignDetections(store2, batch) {
  const sorted = [...batch].sort((a, b) => a.t - b.t);
  const res = {
    byIncident: /* @__PURE__ */ new Map(),
    created: [],
    merges: [],
    duplicates: 0,
    lowConfidence: 0,
    fresh: [],
    maxT: null
  };
  for (const d of sorted) {
    if (!store2.insertDetection(d)) {
      res.duplicates++;
      continue;
    }
    res.fresh.push(d);
    res.maxT = res.maxT === null ? d.t : Math.max(res.maxT, d.t);
    if (d.confidence === "low") {
      res.lowConfidence++;
      continue;
    }
    const home = cellOf(d.lat, d.lon);
    const candidates = /* @__PURE__ */ new Map();
    for (const c of neighborCells(home)) {
      const owner = store2.getCellIncident(cellKey(c));
      if (!owner) continue;
      const inc = resolve(store2, owner);
      if (!inc) continue;
      if (d.t > inc.lastT + LINK_WINDOW_MS || d.t < inc.firstT - LINK_WINDOW_MS) continue;
      candidates.set(inc.id, inc);
    }
    let target2;
    if (candidates.size === 0) {
      target2 = store2.createIncident(d.t);
      res.created.push(target2);
    } else {
      const ranked = [...candidates.values()].sort(older);
      target2 = ranked[0].id;
      for (const other of ranked.slice(1)) {
        store2.recordMerge(other.id, target2, d.t);
        res.merges.push({ from: other.id, into: target2, t: d.t });
      }
    }
    store2.setCell(cellKey(home), target2, d.t);
    store2.touchIncident(target2, d.t);
    let list = res.byIncident.get(target2);
    if (!list) res.byIncident.set(target2, list = []);
    list.push(d);
  }
  return res;
}
var MemoryClusterStore = class {
  constructor(prefix = "inc") {
    this.prefix = prefix;
  }
  seen = /* @__PURE__ */ new Set();
  cells = /* @__PURE__ */ new Map();
  incidents = /* @__PURE__ */ new Map();
  merges = [];
  seq = 0;
  insertDetection(d) {
    if (this.seen.has(d.id)) return false;
    this.seen.add(d.id);
    return true;
  }
  getCellIncident(cell) {
    return this.cells.get(cell)?.incidentId ?? null;
  }
  setCell(cell, incidentId, t) {
    const prev = this.cells.get(cell);
    this.cells.set(cell, { incidentId, lastT: Math.max(t, prev?.incidentId === incidentId ? prev.lastT : t) });
  }
  getIncident(id) {
    return this.incidents.get(id) ?? null;
  }
  createIncident(t) {
    const id = `${this.prefix}.${++this.seq}`;
    this.incidents.set(id, { id, firstT: t, lastT: t, mergedInto: null });
    return id;
  }
  touchIncident(id, t) {
    const inc = this.incidents.get(id);
    if (!inc) return;
    inc.lastT = Math.max(inc.lastT, t);
    inc.firstT = Math.min(inc.firstT, t);
  }
  recordMerge(from, into, t) {
    const inc = this.incidents.get(from);
    if (inc) inc.mergedInto = into;
    this.merges.push({ from, into, t });
  }
};

// apps/realtime-worker/src/detection.ts
function hash64(s) {
  let h1 = 2166136261;
  let h2 = 16777619 ^ 1540483477;
  for (let i2 = 0; i2 < s.length; i2++) {
    const c = s.charCodeAt(i2);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 1540483477) ^ h2 >>> 15;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
function detectionId(d) {
  return hash64(`${d.satellite}|${d.lat.toFixed(5)}|${d.lon.toFixed(5)}|${d.t}`);
}
function withStream(d, stream) {
  return { ...d, id: detectionId(d), stream };
}
var SAT_CODES = ["TERRA", "AQUA", "SNPP", "NOAA20", "NOAA21"];
var CONF_CODES = ["low", "nominal", "high"];
function fromCompact(r) {
  const satellite = SAT_CODES[r[3]];
  return {
    t: r[0],
    lat: r[1],
    lon: r[2],
    satellite,
    sensor: satellite === "TERRA" || satellite === "AQUA" ? "MODIS" : "VIIRS",
    frp: r[4],
    confidence: CONF_CODES[r[5]],
    daynight: r[6] === 1 ? "D" : "N"
  };
}

// apps/realtime-worker/src/incidentModel.ts
var INACTIVE_AFTER_MS = 48 * 36e5;
var GROWTH_WINDOW_MS = 24 * 36e5;
var SIGNIFICANT_MIN_DETECTIONS = 5;
var SIGNIFICANT_MIN_CELLS = 2;
var ENRICH_MIN_INTERVAL_MS = 6 * 36e5;
var HOUR = 36e5;
function emptyState(id, stream) {
  return {
    id,
    stream,
    detections: 0,
    sumLat: 0,
    sumLon: 0,
    frpTotal: 0,
    frpMax: 0,
    frpMaxSensor: null,
    firstT: Number.POSITIVE_INFINITY,
    lastT: Number.NEGATIVE_INFINITY,
    bbox: [180, 90, -180, -90],
    sensors: { VIIRS: 0, MODIS: 0 },
    cells: {},
    timeline: {},
    mergedInto: null,
    significantAt: null,
    enrichments: [],
    streamT: 0
  };
}
function applyDetections(s, ds, streamT) {
  if (!s.firstDetectionId && ds.length) s.firstDetectionId = ds[0].id;
  for (const d of ds) {
    s.detections++;
    s.sumLat += d.lat;
    s.sumLon += d.lon;
    s.frpTotal += d.frp;
    if (d.frp > s.frpMax || !s.frpMaxSensor) {
      s.frpMax = Math.max(s.frpMax, d.frp);
      s.frpMaxSensor = d.sensor;
    }
    s.firstT = Math.min(s.firstT, d.t);
    s.lastT = Math.max(s.lastT, d.t);
    s.bbox = [Math.min(s.bbox[0], d.lon), Math.min(s.bbox[1], d.lat), Math.max(s.bbox[2], d.lon), Math.max(s.bbox[3], d.lat)];
    s.sensors[d.sensor]++;
    const key = cellKey(cellOf(d.lat, d.lon));
    const hour = String(Math.floor(d.t / HOUR) * HOUR);
    const tl = s.timeline[hour] ??= { detections: 0, newCells: 0, frp: 0, newAreaKm2: 0 };
    tl.detections++;
    tl.frp += d.frp;
    const cell = s.cells[key];
    if (!cell) {
      s.cells[key] = { n: 1, frp: d.frp, firstT: d.t, lastT: d.t };
      tl.newCells++;
      tl.newAreaKm2 += cellAreaKm2(parseCellKey(key));
    } else {
      cell.n++;
      cell.frp += d.frp;
      cell.firstT = Math.min(cell.firstT, d.t);
      cell.lastT = Math.max(cell.lastT, d.t);
    }
  }
  s.streamT = Math.max(s.streamT, streamT, s.lastT);
  if (s.significantAt === null && isSignificant(s)) s.significantAt = s.lastT;
}
function isSignificant(s) {
  return s.detections >= SIGNIFICANT_MIN_DETECTIONS && Object.keys(s.cells).length >= SIGNIFICANT_MIN_CELLS;
}
function affectedAreaKm2(s) {
  let a = 0;
  for (const key of Object.keys(s.cells)) a += cellAreaKm2(parseCellKey(key));
  return a;
}

// analyze.ts
var FIXTURE = process.argv[2];
var TOWN = { lat: 49.053381, lon: -76.9805438 };
var STREAM = "replay:analysis";
var scenario = JSON.parse(readFileSync(FIXTURE, "utf8"));
var rows = [...scenario.rows].sort((a, b) => a[0] - b[0]);
var detections = rows.map((r) => withStream(fromCompact(r), STREAM));
var store = new MemoryClusterStore("replay");
var states = /* @__PURE__ */ new Map();
var area = /* @__PURE__ */ new Map();
var own = /* @__PURE__ */ new Map();
var perT = [];
var leaderHistory = [];
var allSeen = [];
var i = 0;
while (i < detections.length) {
  const t = detections[i].t;
  let j = i;
  while (j < detections.length && detections[j].t === t) j++;
  const batch = detections.slice(i, j);
  i = j;
  allSeen.push(...batch);
  const res = assignDetections(store, batch);
  const touched = /* @__PURE__ */ new Set();
  for (const [id, ds] of res.byIncident) {
    const s = states.get(id) ?? emptyState(id, STREAM);
    states.set(id, s);
    applyDetections(s, ds, t);
    area.set(id, affectedAreaKm2(s));
    (own.get(id) ?? own.set(id, []).get(id)).push(...ds);
    touched.add(id);
  }
  for (const m of res.merges) {
    const s = states.get(m.from);
    if (s && !s.mergedInto) s.mergedInto = m.into;
  }
  perT.push({ t, touched });
  let leaderId = null;
  let leaderArea = -1;
  for (const [id, s] of states) {
    if (s.mergedInto || !isSignificant(s)) continue;
    const a = area.get(id);
    if (a > leaderArea) [leaderId, leaderArea] = [id, a];
  }
  const prev = leaderHistory.at(-1);
  if (!prev || prev.leaderId !== leaderId) leaderHistory.push({ t, leaderId, leaderArea });
}
var target = [...states.values()].filter((s) => !s.mergedInto && isSignificant(s)).sort((a, b) => area.get(b.id) - area.get(a.id))[0];
var T = target.id;
var tDets = own.get(T);
var iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
var edt = (t) => new Date(t - 4 * 36e5).toISOString().slice(0, 16).replace("T", " ");
var dist = (d) => haversineKm(d.lat, d.lon, TOWN.lat, TOWN.lon);
function at(tCut) {
  const ds = tDets.filter((d) => d.t <= tCut);
  const s = emptyState(T, STREAM);
  if (ds.length) applyDetections(s, ds, tCut);
  let closest = null;
  for (const d of ds) if (!closest || dist(d) < dist(closest)) closest = d;
  return {
    detections: ds.length,
    cells: Object.keys(s.cells).length,
    areaKm2: ds.length ? affectedAreaKm2(s) : 0,
    closestKm: closest ? dist(closest) : null,
    closest,
    centroidKm: ds.length ? haversineKm(s.sumLat / ds.length, s.sumLon / ds.length, TOWN.lat, TOWN.lon) : null
  };
}
function firstAreaAt(km2) {
  const s = emptyState(T, STREAM);
  let k = 0;
  const byT = [...new Set(tDets.map((d) => d.t))].sort((a, b) => a - b);
  for (const t of byT) {
    const ds = [];
    while (k < tDets.length && tDets[k].t <= t) ds.push(tDets[k++]);
    applyDetections(s, ds, t);
    if (affectedAreaKm2(s) >= km2) return t;
  }
  return null;
}
var out = {};
out.target = {
  id: T,
  finalAreaKm2: area.get(T),
  detections: tDets.length,
  centroid: [target.sumLat / target.detections, target.sumLon / target.detections],
  firstT: iso(target.firstT),
  significantAt: target.significantAt && iso(target.significantAt),
  mergedIntoTarget: store.merges.filter((m) => m.into === T).map((m) => ({ from: m.from, t: iso(m.t), fromArea: area.get(m.from) }))
};
var milestones = [
  ["first detection", target.firstT],
  ["significant", target.significantAt],
  ["area \u2265 50 km\xB2", firstAreaAt(50)],
  ["area \u2265 200 km\xB2", firstAreaAt(200)],
  ["area \u2265 1000 km\xB2", firstAreaAt(1e3)],
  ["largest in replay (first time)", leaderHistory.find((h) => h.leaderId === T)?.t ?? null]
];
out.milestones = milestones.map(([name, t]) => {
  if (t === null) return { name, t: null };
  const s = at(t);
  return {
    name,
    utc: iso(t),
    edt: edt(t),
    utcPlus3: iso(t + 3 * 36e5),
    edtPlus3: edt(t + 3 * 36e5),
    areaKm2: Math.round(s.areaKm2 * 10) / 10,
    detections: s.detections,
    closestKm: s.closestKm && Math.round(s.closestKm * 10) / 10,
    closestAt: s.closest && [s.closest.lat, s.closest.lon],
    centroidKm: s.centroidKm && Math.round(s.centroidKm * 10) / 10
  };
});
out.leaderChanges = leaderHistory.map((h) => ({ utc: iso(h.t), leader: h.leaderId, area: Math.round(h.leaderArea) }));
var granules = [...new Set(tDets.map((d) => d.t))].sort((a, b) => a - b).filter((t) => t <= Date.UTC(2023, 5, 3, 12));
out.granules = granules.map((t) => {
  const s = at(t);
  const nowDs = tDets.filter((d) => d.t === t);
  return {
    utc: iso(t),
    edt: edt(t),
    sat: nowDs[0]?.satellite,
    newDetections: nowDs.length,
    areaKm2: Math.round(s.areaKm2 * 10) / 10,
    closestKm: s.closestKm && Math.round(s.closestKm * 10) / 10,
    closestThisPassKm: Math.round(Math.min(...nowDs.map(dist)) * 10) / 10
  };
});
var cutoff = Date.UTC(2023, 5, 3, 4);
for (const [label, tCut] of [["observed by", cutoff], ["delivered by (t+3h \u2264 cutoff)", cutoff - 3 * 36e5]]) {
  const s = at(tCut);
  const anyClosest = allSeen.filter((d) => d.t <= tCut).reduce((b, d) => !b || dist(d) < dist(b) ? d : b, null);
  const anyId = anyClosest && [...own.entries()].find(([, ds]) => ds.includes(anyClosest))?.[0];
  out[`cutoff ${label} Jun 3 00:00 EDT`] = {
    targetAreaKm2: Math.round(s.areaKm2 * 10) / 10,
    targetDetections: s.detections,
    targetClosestKm: s.closestKm && Math.round(s.closestKm * 10) / 10,
    targetClosestDetection: s.closest && { utc: iso(s.closest.t), lat: s.closest.lat, lon: s.closest.lon },
    anyDetectionClosestKm: anyClosest && Math.round(dist(anyClosest) * 10) / 10,
    anyDetectionClosest: anyClosest && { utc: iso(anyClosest.t), lat: anyClosest.lat, lon: anyClosest.lon, confidence: anyClosest.confidence, incident: anyId ?? "(low confidence, no incident)" }
  };
}
out.evening = [18, 21].flatMap((h) => {
  const local = Date.UTC(2023, 5, 2, h + 4);
  return [
    { at: `Jun 2 ${h}:00 EDT, observed`, ...pick(at(local)) },
    { at: `Jun 2 ${h}:00 EDT, delivered (+3 h)`, ...pick(at(local - 3 * 36e5)) }
  ];
});
function pick(s) {
  return { areaKm2: Math.round(s.areaKm2 * 10) / 10, detections: s.detections, closestKm: s.closestKm && Math.round(s.closestKm * 10) / 10, closestUtc: s.closest && iso(s.closest.t) };
}
out.nearbyIncidentsByCutoff = [...own.entries()].map(([id, ds]) => {
  const before = ds.filter((d) => d.t <= cutoff);
  if (!before.length) return null;
  const minD = Math.min(...before.map(dist));
  return minD <= 40 ? { id, detectionsByCutoff: before.length, closestKm: Math.round(minD * 10) / 10, first: iso(before[0].t), mergedInto: states.get(id)?.mergedInto ?? null, finalArea: Math.round(area.get(id)) } : null;
}).filter(Boolean).sort((a, b) => a.closestKm - b.closestKm);
console.log(JSON.stringify(out, null, 1));
var nearIds = ["replay.57", "replay.45", "replay.46", "replay.69"];
var detail = {};
for (const id of nearIds) {
  const ds = own.get(id) ?? [];
  const s = emptyState(id, STREAM);
  const rowsOut = [];
  const times = [...new Set(ds.map((d) => d.t))].sort((a, b) => a - b).filter((t) => t <= Date.UTC(2023, 5, 3, 12));
  let k = 0;
  for (const t of times) {
    const batch = [];
    while (k < ds.length && ds[k].t <= t) batch.push(ds[k++]);
    applyDetections(s, batch, t);
    const upto = ds.filter((d) => d.t <= t);
    rowsOut.push({
      utc: iso(t),
      edt: edt(t),
      deliveredEdt: edt(t + 3 * 36e5),
      detections: s.detections,
      cells: Object.keys(s.cells).length,
      areaKm2: Math.round(affectedAreaKm2(s) * 10) / 10,
      significant: isSignificant(s),
      closestKm: Math.round(Math.min(...upto.map(dist)) * 10) / 10
    });
  }
  detail[id] = rowsOut;
}
console.error(JSON.stringify(detail));
console.error("MERGES " + JSON.stringify(store.merges.filter((m) => nearIds.includes(m.from) || nearIds.includes(m.into)).map((m) => ({ ...m, t: iso(m.t) }))));
