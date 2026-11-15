/** WebSocket message shapes (documented in REALTIME.md). */

import type { Bbox } from "./grid";
import type { IncidentSummary } from "./incidentModel";

/** Compact map point: [lon, lat, frpMw, tEpochMs, confidence 0=low 1=nominal 2=high]. */
export type MapPoint = [number, number, number, number, number];

export interface Brief {
  text: string;
  model: string;
  generatedAt: number; // wall clock, epoch ms
  streamT: number; // stream time the brief describes
}

export type ServerMessage =
  | { type: "hello"; stream: string; streamT: number | null; incidents: number }
  | { type: "incident.upsert"; incident: IncidentSummary }
  | { type: "incident.brief"; id: string; brief: Brief }
  | { type: "detections"; points: MapPoint[]; replace?: boolean }
  | { type: "clock"; t: number }
  | { type: "replay.status"; status: string; progress: number }
  | { type: "error"; message: string }
  /** Every frame the hub sends is either a single message or a batch of them (one per flush). */
  | { type: "batch"; messages: ServerMessage[] };

export type ClientMessage = { type: "viewport"; bbox: Bbox | null } | { type: "ping" };

/** What the Clusterer / Replay / Workflow push into a LiveHub. */
export interface PublishPayload {
  upserts?: IncidentSummary[];
  points?: MapPoint[];
  clock?: number;
  briefs?: { id: string; brief: Brief }[];
  replayStatus?: { status: string; progress: number };
}
