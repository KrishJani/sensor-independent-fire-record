/**
 * Incident aggregate (pure). The Incident DO persists IncidentState as JSON and calls these
 * functions; all time logic uses stream time (detection time), never the wall clock.
 */

import type { Detection, Sensor } from "./detection";
import { cellAreaKm2, cellKey, cellOf, parseCellKey, type Bbox } from "./grid";

export const INACTIVE_AFTER_MS = 48 * 3600_000;
export const GROWTH_WINDOW_MS = 24 * 3600_000;
export const SIGNIFICANT_MIN_DETECTIONS = 5;
export const SIGNIFICANT_MIN_CELLS = 2;
export const ENRICH_MIN_INTERVAL_MS = 6 * 3600_000;
const HOUR = 3600_000;

export type IncidentStatus = "active" | "inactive" | "merged";

export interface CellStat {
  n: number;
  frp: number;
  firstT: number;
  lastT: number;
}

export interface TimelinePoint {
  /** Start of the UTC hour, epoch ms. */
  hour: number;
  detections: number;
  newCells: number;
  frp: number;
  /** Cumulative affected area (km² of 0.05° cells with detections) at the end of this hour. */
  affectedAreaKm2: number;
}

export interface EnrichmentMark {
  t: number; // stream time when enrichment was requested
  affectedAreaKm2: number;
  reason: "significant" | "area_doubled";
}

export interface IncidentState {
  id: string;
  stream: string;
  detections: number;
  sumLat: number;
  sumLon: number;
  frpTotal: number;
  frpMax: number;
  /** Sensor of the peak-FRP detection (FRP is not harmonized across sensors). */
  frpMaxSensor?: Sensor | null;
  firstT: number;
  lastT: number;
  bbox: Bbox;
  sensors: Record<Sensor, number>;
  cells: Record<string, CellStat>;
  timeline: Record<string, { detections: number; newCells: number; frp: number; newAreaKm2: number }>;
  mergedInto: string | null;
  significantAt: number | null;
  enrichments: EnrichmentMark[];
  /** Latest stream time this incident has been told about. */
  streamT: number;
}

export interface IncidentSummary {
  id: string;
  stream: string;
  status: IncidentStatus;
  significant: boolean;
  mergedInto: string | null;
  detections: number;
  cells: number;
  /**
   * Summed area of the 0.05° grid cells (~5.5 km) that contain at least one detection. Not a burned
   * area: a single hotspot marks a whole cell, so this overstates the area actually burned.
   */
  affectedAreaKm2: number;
  frpTotalMw: number;
  frpMaxMw: number;
  frpMaxSensor: Sensor | null;
  firstSeen: number;
  lastSeen: number;
  centroid: [lon: number, lat: number];
  bbox: Bbox;
  growthKm2PerDay: number;
  sensors: Record<Sensor, number>;
  /** Stream time this summary was computed at. */
  asOf: number;
}

export function emptyState(id: string, stream: string): IncidentState {
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

export function applyDetections(s: IncidentState, ds: Detection[], streamT: number): void {
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
    const tl = (s.timeline[hour] ??= { detections: 0, newCells: 0, frp: 0, newAreaKm2: 0 });
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

export function isSignificant(s: IncidentState): boolean {
  return s.detections >= SIGNIFICANT_MIN_DETECTIONS && Object.keys(s.cells).length >= SIGNIFICANT_MIN_CELLS;
}

/** km² of the 0.05° cells with detections (overstates burned area; see IncidentSummary). */
export function affectedAreaKm2(s: IncidentState): number {
  let a = 0;
  for (const key of Object.keys(s.cells)) a += cellAreaKm2(parseCellKey(key));
  return a;
}

/** km² of cells first seen in the 24 h of stream time ending at streamT, per day. */
export function growthKm2PerDay(s: IncidentState, streamT: number): number {
  let a = 0;
  for (const [key, c] of Object.entries(s.cells)) {
    if (c.firstT > streamT - GROWTH_WINDOW_MS && c.firstT <= streamT) a += cellAreaKm2(parseCellKey(key));
  }
  return a; // the window is exactly one day
}

export function statusAt(s: IncidentState, streamT: number): IncidentStatus {
  if (s.mergedInto) return "merged";
  return streamT - s.lastT > INACTIVE_AFTER_MS ? "inactive" : "active";
}

export function summarize(s: IncidentState, streamT = s.streamT): IncidentSummary {
  const n = Math.max(1, s.detections);
  return {
    id: s.id,
    stream: s.stream,
    status: statusAt(s, streamT),
    significant: s.significantAt !== null,
    mergedInto: s.mergedInto,
    detections: s.detections,
    cells: Object.keys(s.cells).length,
    affectedAreaKm2: round1(affectedAreaKm2(s)),
    frpTotalMw: round1(s.frpTotal),
    frpMaxMw: round1(s.frpMax),
    frpMaxSensor: s.frpMaxSensor ?? null,
    firstSeen: s.firstT,
    lastSeen: s.lastT,
    centroid: [round4(s.sumLon / n), round4(s.sumLat / n)],
    bbox: s.bbox.map(round4) as Bbox,
    growthKm2PerDay: round1(growthKm2PerDay(s, streamT)),
    sensors: { ...s.sensors },
    asOf: streamT
  };
}

export function timeline(s: IncidentState): TimelinePoint[] {
  let area = 0;
  return Object.entries(s.timeline)
    .map(([hour, v]) => ({ hour: Number(hour), ...v }))
    .sort((a, b) => a.hour - b.hour)
    .map((p) => {
      area += p.newAreaKm2;
      return { hour: p.hour, detections: p.detections, newCells: p.newCells, frp: round1(p.frp), affectedAreaKm2: round1(area) };
    });
}

/**
 * Enrichment is due when the incident is significant and its affected area has reached
 * `minAreaKm2` (0 = on significance), and again when that area has doubled since the last
 * enrichment, but at most once per 6 h of stream time.
 */
export function enrichmentDue(s: IncidentState, streamT: number, minAreaKm2 = 0): EnrichmentMark | null {
  if (s.significantAt === null || s.mergedInto) return null;
  const area = affectedAreaKm2(s);
  const last = s.enrichments.at(-1);
  if (!last) return area >= minAreaKm2 ? { t: streamT, affectedAreaKm2: area, reason: "significant" } : null;
  if (area >= 2 * last.affectedAreaKm2 && streamT - last.t >= ENRICH_MIN_INTERVAL_MS) {
    return { t: streamT, affectedAreaKm2: area, reason: "area_doubled" };
  }
  return null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
