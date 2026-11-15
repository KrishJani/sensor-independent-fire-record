// Detection filtering (harmonizer SPEC §4). Identical rules for SP and NRT so the tiers agree.

import { cellCenter, toCellId } from './grid.ts';
import type { Detection } from './types.ts';
import { detectionKey } from './serialize.ts';

export interface FilterStats {
  seen: number;
  kept: number;
  droppedType: number;
  droppedMask: number;
  droppedConfidence: number;
  droppedFrpFloor: number;
}

export function newFilterStats(): FilterStats {
  return { seen: 0, kept: 0, droppedType: 0, droppedMask: 0, droppedConfidence: 0, droppedFrpFloor: 0 };
}

export interface FilterOptions {
  /** Cells with persistent non-vegetation heat sources. Applied to BOTH tiers (NRT has no `type`). */
  staticMask?: ReadonlySet<number>;
  modisMinConfidence?: number; // default 30
  viirsMinConfidence?: number; // default 60 (n, h)
  viirsFrpFloorMw?: number; // default 0 (off)
  stats?: FilterStats;
}

export function keepDetection(d: Detection, opts: FilterOptions = {}): boolean {
  const s = opts.stats;
  if (s) s.seen++;
  // 1. Non-vegetation sources: 1 volcano, 2 static land source, 3 offshore.
  if (d.type === 1 || d.type === 2 || d.type === 3) {
    if (s) s.droppedType++;
    return false;
  }
  // 2. Static mask.
  if (opts.staticMask && opts.staticMask.size && opts.staticMask.has(toCellId(d.lat, d.lon))) {
    if (s) s.droppedMask++;
    return false;
  }
  // 3. Confidence.
  const min = d.sensor === 'MODIS' ? opts.modisMinConfidence ?? 30 : opts.viirsMinConfidence ?? 60;
  if (d.confidence < min) {
    if (s) s.droppedConfidence++;
    return false;
  }
  // 4. Optional VIIRS FRP floor.
  const floor = opts.viirsFrpFloorMw ?? 0;
  if (d.sensor === 'VIIRS' && floor > 0 && d.frpMw < floor) {
    if (s) s.droppedFrpFloor++;
    return false;
  }
  if (s) s.kept++;
  return true;
}

export function* filterDetections(dets: Iterable<Detection>, opts: FilterOptions = {}): Generator<Detection> {
  for (const d of dets) if (keepDetection(d, opts)) yield d;
}

export interface StaticMaskEntry {
  cellId: number;
  gridLat: number;
  gridLon: number;
  /** type 1/2 detections, or (reason = persistent_viirs_only) VIIRS days in the worst year. */
  nStaticDetections: number;
  /** Why the cell is masked. Absent = 'static_type'. */
  reason?: 'static_type' | 'persistent_viirs_only';
}

/**
 * Incremental counter of DISTINCT type=1 (volcano) and type=2 (static land source) detections
 * per cell. Distinct, so overlapping downloads cannot inflate counts and grow the mask.
 */
export function createStaticMaskAccumulator() {
  const counts = new Map<number, number>();
  const seen = new Set<string>();
  return {
    add(d: Detection) {
      if (d.type === 1 || d.type === 2) {
        const k = detectionKey(d);
        if (seen.has(k)) return;
        seen.add(k);
        const c = toCellId(d.lat, d.lon);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    },
    entries(minStaticDetections = 3): StaticMaskEntry[] {
      const out: StaticMaskEntry[] = [];
      for (const [cellId, n] of counts) {
        if (n < minStaticDetections) continue;
        const { lat, lon } = cellCenter(cellId);
        out.push({ cellId, gridLat: lat, gridLon: lon, nStaticDetections: n });
      }
      return out.sort((a, b) => a.cellId - b.cellId);
    },
  };
}

export function buildStaticMask(
  spDetections: Iterable<Detection>,
  opts: { minStaticDetections?: number } = {},
): StaticMaskEntry[] {
  const acc = createStaticMaskAccumulator();
  for (const d of spDetections) acc.add(d);
  return acc.entries(opts.minStaticDetections ?? 3);
}

export function maskSet(entries: Iterable<StaticMaskEntry>): Set<number> {
  const s = new Set<number>();
  for (const e of entries) s.add(e.cellId);
  return s;
}

/**
 * Persistent VIIRS-only heat (gas flares and other industrial sources). FIRMS `type = 2` misses
 * many of them. A flare is small, hot and continuous: VIIRS flags its cell on many days a year,
 * MODIS almost never. A long-burning wildfire is flagged by both. Rule: mask a cell if in ANY
 * year VIIRS flags it on ≥ minViirsDays days while MODIS flags it on ≤ maxModisFraction of
 * them. Feed it the detections that survived the other filters. Masked cells are removed for
 * both sensors and all years, like the static mask, so SP and NRT stay consistent.
 */
export function createPersistenceAccumulator() {
  const acc = new Map<string, { v: Set<string>; m: Set<string> }>();
  return {
    add(d: Detection) {
      const k = `${toCellId(d.lat, d.lon)}|${d.acqDate.slice(0, 4)}`;
      let e = acc.get(k);
      if (!e) acc.set(k, (e = { v: new Set(), m: new Set() }));
      (d.sensor === 'VIIRS' ? e.v : e.m).add(d.acqDate);
    },
    flagged(opts: { minViirsDays?: number; maxModisFraction?: number } = {}): StaticMaskEntry[] {
      const minV = opts.minViirsDays ?? 30;
      const frac = opts.maxModisFraction ?? 0.1;
      const worst = new Map<number, number>();
      for (const [k, e] of acc) {
        if (e.v.size < minV || e.m.size > frac * e.v.size) continue;
        const c = +k.split('|')[0];
        worst.set(c, Math.max(worst.get(c) ?? 0, e.v.size));
      }
      return [...worst.entries()].sort((a, b) => a[0] - b[0]).map(([cellId, n]) => {
        const { lat, lon } = cellCenter(cellId);
        return { cellId, gridLat: lat, gridLon: lon, nStaticDetections: n, reason: 'persistent_viirs_only' as const };
      });
    },
  };
}
