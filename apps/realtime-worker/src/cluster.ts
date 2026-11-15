/**
 * Clustering engine (pure). The Clusterer DO plugs in a SQLite-backed store; tests use MemoryClusterStore.
 *
 * Rules:
 * - Dedupe by detection id.
 * - Low-confidence detections are counted but never create or grow an incident.
 * - A detection links to an incident if any of the 9 cells around it belongs to an incident
 *   seen within LINK_WINDOW_MS of the detection's own time (stream time, never wall clock).
 * - Otherwise it creates a new incident.
 * - If it touches several incidents, the oldest (first seen, then id) wins and the others are
 *   recorded as merged into it. No physical merge: the absorbed incident keeps its history.
 */

import type { Detection } from "./detection";
import { cellKey, cellOf, neighborCells } from "./grid";

export const LINK_WINDOW_MS = 48 * 3600_000;

export interface IncidentRef {
  id: string;
  firstT: number;
  lastT: number;
  mergedInto: string | null;
}

export interface ClusterStore {
  /** Insert the detection id; false when it was already seen. */
  insertDetection(d: Detection): boolean;
  getCellIncident(cell: string): string | null;
  setCell(cell: string, incidentId: string, t: number): void;
  getIncident(id: string): IncidentRef | null;
  createIncident(t: number): string;
  touchIncident(id: string, t: number): void;
  recordMerge(from: string, into: string, t: number): void;
}

export interface Merge {
  from: string;
  into: string;
  t: number;
}

export interface AssignResult {
  /** Detections linked to each incident in this batch, in time order. */
  byIncident: Map<string, Detection[]>;
  created: string[];
  merges: Merge[];
  duplicates: number;
  lowConfidence: number;
  /** All new (non-duplicate) detections, including low confidence, for the map layer. */
  fresh: Detection[];
  /** Max detection time seen in this batch, or null for an empty batch. */
  maxT: number | null;
}

/** Follow mergedInto links to the surviving incident. */
function resolve(store: ClusterStore, id: string): IncidentRef | null {
  let inc = store.getIncident(id);
  for (let hops = 0; inc?.mergedInto && hops < 32; hops++) inc = store.getIncident(inc.mergedInto);
  return inc;
}

function older(a: IncidentRef, b: IncidentRef): number {
  return a.firstT - b.firstT || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function assignDetections(store: ClusterStore, batch: Detection[]): AssignResult {
  const sorted = [...batch].sort((a, b) => a.t - b.t);
  const res: AssignResult = {
    byIncident: new Map(),
    created: [],
    merges: [],
    duplicates: 0,
    lowConfidence: 0,
    fresh: [],
    maxT: null
  };

  for (const d of sorted) {
    if (!store.insertDetection(d)) {
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
    const candidates = new Map<string, IncidentRef>();
    for (const c of neighborCells(home)) {
      const owner = store.getCellIncident(cellKey(c));
      if (!owner) continue;
      const inc = resolve(store, owner);
      if (!inc) continue;
      // Within the window on either side, so late-arriving (older) detections still link.
      if (d.t > inc.lastT + LINK_WINDOW_MS || d.t < inc.firstT - LINK_WINDOW_MS) continue;
      candidates.set(inc.id, inc);
    }

    let target: string;
    if (candidates.size === 0) {
      target = store.createIncident(d.t);
      res.created.push(target);
    } else {
      const ranked = [...candidates.values()].sort(older);
      target = ranked[0].id;
      for (const other of ranked.slice(1)) {
        store.recordMerge(other.id, target, d.t);
        res.merges.push({ from: other.id, into: target, t: d.t });
      }
    }

    store.setCell(cellKey(home), target, d.t);
    store.touchIncident(target, d.t);
    let list = res.byIncident.get(target);
    if (!list) res.byIncident.set(target, (list = []));
    list.push(d);
  }
  return res;
}

/** In-memory store for tests and scripts. */
export class MemoryClusterStore implements ClusterStore {
  seen = new Set<string>();
  cells = new Map<string, { incidentId: string; lastT: number }>();
  incidents = new Map<string, IncidentRef>();
  merges: Merge[] = [];
  private seq = 0;

  constructor(private prefix = "inc") {}

  insertDetection(d: Detection): boolean {
    if (this.seen.has(d.id)) return false;
    this.seen.add(d.id);
    return true;
  }
  getCellIncident(cell: string) {
    return this.cells.get(cell)?.incidentId ?? null;
  }
  setCell(cell: string, incidentId: string, t: number) {
    const prev = this.cells.get(cell);
    this.cells.set(cell, { incidentId, lastT: Math.max(t, prev?.incidentId === incidentId ? prev.lastT : t) });
  }
  getIncident(id: string) {
    return this.incidents.get(id) ?? null;
  }
  createIncident(t: number) {
    const id = `${this.prefix}.${++this.seq}`;
    this.incidents.set(id, { id, firstT: t, lastT: t, mergedInto: null });
    return id;
  }
  touchIncident(id: string, t: number) {
    const inc = this.incidents.get(id);
    if (!inc) return;
    inc.lastT = Math.max(inc.lastT, t);
    inc.firstT = Math.min(inc.firstT, t);
  }
  recordMerge(from: string, into: string, t: number) {
    const inc = this.incidents.get(from);
    if (inc) inc.mergedInto = into;
    this.merges.push({ from, into, t });
  }
}
