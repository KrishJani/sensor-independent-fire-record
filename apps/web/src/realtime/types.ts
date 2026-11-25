/** Wire types from apps/realtime-worker (see REALTIME.md). */

export type Bbox = [number, number, number, number];
export type Sensor = 'VIIRS' | 'MODIS';
export type StreamId = 'live' | `replay:${string}`;

export interface IncidentSummary {
  id: string;
  stream: string;
  status: 'active' | 'inactive' | 'merged';
  /** Active < 12 h since the last detection, cooling 12-36 h, inactive after (stream clock). Older servers omit it. */
  activity?: 'active' | 'cooling' | 'inactive';
  /** At an active volcano (config/volcanoes.json): heat that is not a wildfire. Older servers omit it. */
  volcano?: { name: string; distanceKm: number } | null;
  significant: boolean;
  mergedInto: string | null;
  detections: number;
  cells: number;
  /** km² of 0.05° cells with at least one detection. Overstates burned area. */
  affectedAreaKm2: number;
  frpTotalMw: number;
  frpMaxMw: number;
  frpMaxSensor: Sensor | null;
  firstSeen: number;
  lastSeen: number;
  centroid: [number, number];
  bbox: Bbox;
  growthKm2PerDay: number;
  sensors: { VIIRS: number; MODIS: number };
  asOf: number;
}

export interface Brief {
  text: string;
  model: string;
  generatedAt: number;
  /** Stream time the brief describes (epoch ms). */
  streamT: number;
  /** Same moment as ISO 8601. Older servers omit it. */
  asOf?: string;
  /** Grid coverage (km²) when the brief was written. Older briefs lack it; the detail endpoint recovers it. */
  affectedAreaKm2?: number;
}

/** [lon, lat, frpMw, tMs, conf] where conf is 0 low, 1 nominal, 2 high. */
export type DetectionPoint = [number, number, number, number, number];

export type ReplayStatus = 'running' | 'paused' | 'stopped' | 'done' | 'error';

export interface ReplayInfo {
  id: string;
  stream: `replay:${string}`;
  scenario: string;
  origin: 'r2' | 'bundled';
  note: string | null;
  speed: number;
  status: ReplayStatus;
  startT: number;
  endT: number;
  streamT: number | null;
  total: number;
  emitted: number;
  progress: number;
  expectedDurationS?: number;
  reused?: boolean;
  error?: string | null;
}

type Ok<T> = { status: 'ok'; data: T };
type NotOk = { status: 'failed'; error: string } | { status: 'skipped'; reason: string };

export interface Weather {
  source: string;
  time: string;
  windSpeedKmh: number;
  windDirectionDeg: number;
  windFrom: string;
  relativeHumidityPct: number;
  temperatureC: number;
}

export interface Place {
  name: string;
  place: 'town' | 'city' | string;
  distanceKm: number;
  direction: string;
  population: number | null;
}

export interface Enrichment {
  incidentId: string;
  reason: 'significant' | 'area_doubled';
  streamT: number;
  completedAt: number;
  weather?: Ok<Weather> | NotOk;
  places?: Ok<Place[]> | NotOk;
  history?: Ok<{ dataSource: string; summary: string }> | NotOk;
  brief?: Ok<Brief> | NotOk;
}

export interface IncidentDetail {
  summary: IncidentSummary;
  enrichment: Enrichment | null;
  brief: Brief | null;
  stream: string;
  streamT: number | null;
  dataSource: 'live' | 'replay';
}

export type ServerMessage =
  | { type: 'batch'; messages: ServerMessage[] }
  | { type: 'hello'; stream: string; streamT: number | null; incidents: number }
  | { type: 'incident.upsert'; incident: IncidentSummary }
  | { type: 'incident.brief'; id: string; brief: Brief }
  | { type: 'detections'; points: DetectionPoint[]; replace?: boolean }
  | { type: 'clock'; t: number }
  | { type: 'replay.status'; status: ReplayStatus; progress: number; speed?: number }
  | { type: 'error'; message: string }
  | { type: 'pong' };

/**
 * Accept both the current field (`affectedAreaKm2`) and the older `areaKm2`,
 * so the UI works against either version of the worker.
 */
export function normalizeIncident(raw: IncidentSummary & { areaKm2?: number }): IncidentSummary {
  if (typeof raw.affectedAreaKm2 === 'number') return raw;
  return { ...raw, affectedAreaKm2: raw.areaKm2 ?? 0 };
}

/** Brief time as epoch ms, preferring `asOf` when present. */
export function briefTime(b: Brief): number {
  const parsed = b.asOf ? Date.parse(b.asOf) : NaN;
  return Number.isFinite(parsed) ? parsed : b.streamT;
}

/** OSM `place` values, most significant first; hamlet and locality rank the same. */
const PLACE_RANK: Record<string, number> = { city: 0, town: 1, village: 2, hamlet: 3, locality: 3 };

/**
 * The place to name an incident after: the highest-ranked place the worker returned (they are
 * all within its search radius), nearest first among equals. "Near Senneterre" reads better
 * than "Near Signai" when Signai is a railway hamlet a few km closer.
 */
export function titlePlace(places: Place[] | null | undefined): Place | null {
  if (!places?.length) return null;
  const rank = (p: Place) => PLACE_RANK[p.place] ?? 4;
  return places.reduce((best, p) =>
    rank(p) < rank(best) || (rank(p) === rank(best) && p.distanceKm < best.distanceKm) ? p : best,
  );
}

import { activityAt, briefStaleness, type Activity } from '../../../realtime-worker/src/status';
export { briefStaleness };
import { isPersistentHeat } from '../../../realtime-worker/src/status';
export { isPersistentHeat };
export const PERSISTENT_HELP =
  'Many detections on few cells at low power (at least 30 per cell, under 20 MW on average), unlike a spreading fire front; the cause is not determined.';

/** Activity at the stream clock (falls back to the server's value, then to active). Merged incidents keep their last activity. */
export function activityOf(i: Pick<IncidentSummary, 'lastSeen' | 'activity' | 'asOf'>, clock: number | null): Activity {
  return activityAt(i.lastSeen, Math.max(clock ?? 0, i.asOf ?? 0)) ;
}

export const ACTIVITY_LABEL: Record<Activity, string> = { active: 'Active', cooling: 'Cooling', inactive: 'Inactive' };
export const ACTIVITY_HELP: Record<Activity, string> = {
  active: 'Detected within the last 12 hours',
  cooling: 'Last detected 12 to 36 hours ago',
  inactive: 'Not detected for over 36 hours',
};
